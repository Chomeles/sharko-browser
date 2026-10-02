// 48_webaudio_dsp.js — DynamicsCompressorNode (Blink's DynamicsCompressorKernel, float arithmetic),
// BiquadFilterNode and IIRFilterNode (spec §1.14 / Blink's Biquad), and the factory methods of BaseAudioContext.
(function (L) {
  'use strict';
  const INTERNAL = L.INTERNAL;
  const DOMException = L.DOMException;
  const WA = L.webaudio;
  const { QUANTUM, argc, nd, NODE, newNodeRec, ensureBus, AudioNode } = WA;
  const { applyOptions, ctxArg, addParams, setParamOptions } = WA;
  const fr = Math.fround;
  const FLT_MAX = 3.4028234663852886e+38;
  const PI = fr(Math.PI);

  const dbToLinear = (db) => fr(Math.pow(10, fr(0.05 * db)));
  const linearToDb = (x) => (x ? fr(20 * fr(Math.log10(x))) : -1000);
  // Blink computes with powf/log10f/expf/sinf/asinf on floats; Math.* in double rounded to float agrees except in rare last-bit cases.
  const pow = (a, b) => fr(Math.pow(a, b));

  // ---------------------------------------------------------------------------------------
  // DynamicsCompressorKernel
  // ---------------------------------------------------------------------------------------
  const MAX_PRE_DELAY = 1024, PRE_DELAY_MASK = MAX_PRE_DELAY - 1, DIVISION_FRAMES = 32;
  function newKernel(sampleRate) {
    return {
      sampleRate, preDelay: null, lastPreDelayFrames: 0, preDelayRead: 0, preDelayWrite: 0, detectorAverage: 0, compressorGain: 1, meteringGain: 1,
      meteringReleaseK: fr(1 - Math.exp(-1 / (0.325 * sampleRate))), maxAttackDiffDb: -1,
      curve: { dbThreshold: NaN, dbKnee: NaN, ratio: NaN, linearThreshold: 0, slope: 0, kneeThreshold: 0, kneeThresholdDb: 0, yKneeThresholdDb: 0, k: 0 },
    };
  }
  function kneeCurve(c, x, k) {
    if (x < c.linearThreshold) return x;
    return fr(c.linearThreshold + fr(fr(1 - fr(Math.exp(fr(-k * fr(x - c.linearThreshold))))) / k));
  }
  function saturate(c, x, k) {
    if (x < c.kneeThreshold) return kneeCurve(c, x, k);
    const xDb = linearToDb(x);
    const yDb = fr(c.yKneeThresholdDb + fr(c.slope * fr(xDb - c.kneeThresholdDb)));
    return dbToLinear(yDb);
  }
  function slopeAt(c, x, k) {
    if (x < c.linearThreshold) return 1;
    const x2 = fr(x * 1.001);
    const xDb = linearToDb(x), x2Db = linearToDb(x2);
    const yDb = linearToDb(kneeCurve(c, x, k)), y2Db = linearToDb(kneeCurve(c, x2, k));
    return fr(fr(y2Db - yDb) / fr(x2Db - xDb));
  }
  function kAtSlope(c, desired) {
    const xDb = fr(c.dbThreshold + c.dbKnee);
    const x = dbToLinear(xDb);
    let minK = 0.1, maxK = 10000, k = 5;
    for (let i = 0; i < 15; i++) {
      const slope = slopeAt(c, x, k);
      if (slope < desired) maxK = k; else minK = k;
      k = fr(Math.sqrt(fr(minK * maxK)));
    }
    return k;
  }
  function updateStaticCurve(c, dbThreshold, dbKnee, ratio) {
    if (dbThreshold !== c.dbThreshold || dbKnee !== c.dbKnee || ratio !== c.ratio) {
      c.dbThreshold = dbThreshold; c.linearThreshold = dbToLinear(dbThreshold); c.dbKnee = dbKnee;
      c.ratio = ratio; c.slope = fr(1 / ratio);
      const k = kAtSlope(c, fr(1 / ratio));
      c.kneeThresholdDb = fr(dbThreshold + dbKnee);
      c.kneeThreshold = dbToLinear(c.kneeThresholdDb);
      c.yKneeThresholdDb = linearToDb(kneeCurve(c, c.kneeThreshold, k));
      c.k = k;
    }
    return c.k;
  }

  function kernelProcess(ker, srcs, dsts, frames, prm) {
    const sr = ker.sampleRate;
    const nCh = srcs.length;
    const c = ker.curve;
    const k = updateStaticCurve(c, prm.threshold, prm.knee, prm.ratio);
    const fullRangeGain = saturate(c, 1, k);
    let fullRangeMakeup = fr(1 / fullRangeGain);
    fullRangeMakeup = pow(fullRangeMakeup, 0.6);
    const masterLinearGain = fr(dbToLinear(prm.postGain) * fullRangeMakeup);
    const attackTime = Math.max(fr(0.001), prm.attack);
    const attackFrames = fr(attackTime * sr);
    const releaseFrames = fr(sr * prm.release);
    const satReleaseFrames = fr(fr(0.0025) * sr);
    const y1 = fr(releaseFrames * prm.zone1), y2 = fr(releaseFrames * prm.zone2), y3 = fr(releaseFrames * prm.zone3), y4 = fr(releaseFrames * prm.zone4);
    const a = fr(fr(fr(fr(0.9999999999999998 * y1) + fr(1.8432219684323923e-16 * y2)) - fr(1.9373394351676423e-16 * y3)) + fr(8.824516011816245e-18 * y4));
    const b = fr(fr(fr(fr(-1.5788320352845888 * y1) + fr(2.3305837032074286 * y2)) - fr(0.9141194204840429 * y3)) + fr(0.1623677525612032 * y4));
    const cc = fr(fr(fr(fr(0.5334142869106424 * y1) - fr(1.272736789213631 * y2)) + fr(0.9258856042207512 * y3)) - fr(0.18656310191776226 * y4));
    const d = fr(fr(fr(fr(0.08783463138207234 * y1) - fr(0.1694162967925622 * y2)) + fr(0.08588057951595272 * y3)) - fr(0.00429891410546283 * y4));
    const e = fr(fr(fr(fr(-0.042416883008123074 * y1) + fr(0.1115693827987602 * y2)) - fr(0.09764676325265872 * y3)) + fr(0.028494263462021576 * y4));

    // pre-delay
    if (ker.preDelay === null || ker.preDelay.length !== nCh) { ker.preDelay = Array.from({ length: nCh }, () => new Float32Array(MAX_PRE_DELAY)); ker.lastPreDelayFrames = -1; }
    let sampleFrames = fr(prm.preDelay * sr);
    if (sampleFrames > MAX_PRE_DELAY - 1) sampleFrames = MAX_PRE_DELAY - 1;
    if (sampleFrames !== ker.lastPreDelayFrames) {
      ker.lastPreDelayFrames = sampleFrames;
      for (const buf of ker.preDelay) buf.fill(0);
      ker.preDelayRead = 0;
      ker.preDelayWrite = Math.trunc(sampleFrames);
    }
    const preDelayFrames = Math.trunc(ker.lastPreDelayFrames);
    // the read index trails the write index by the pre-delay
    ker.preDelayRead = (ker.preDelayWrite - preDelayFrames + MAX_PRE_DELAY) & PRE_DELAY_MASK;

    const nDivisions = frames / DIVISION_FRAMES;
    let frame = 0;
    const dryMix = fr(1 - prm.effectBlend), wetMix = prm.effectBlend;
    for (let i = 0; i < nDivisions; i++) {
      const desiredGain = ker.detectorAverage;
      const scaledDesiredGain = fr(fr(Math.asin(desiredGain)) / fr(0.5 * PI));
      let envelopeRate;
      const isReleasing = scaledDesiredGain > ker.compressorGain;
      let compressionDiffDb = linearToDb(fr(ker.compressorGain / scaledDesiredGain));
      if (isReleasing) {
        ker.maxAttackDiffDb = -1;
        if (Number.isNaN(compressionDiffDb) || !Number.isFinite(compressionDiffDb)) compressionDiffDb = -1;
        let x = compressionDiffDb;
        x = Math.max(-12, x); x = Math.min(0, x);
        x = fr(0.25 * fr(x + 12));
        const x2 = fr(x * x), x3 = fr(x2 * x), x4 = fr(x2 * x2);
        const releaseF = fr(fr(fr(fr(a + fr(b * x)) + fr(cc * x2)) + fr(d * x3)) + fr(e * x4));
        const dbPerFrame = fr(5 / releaseF);
        envelopeRate = dbToLinear(dbPerFrame);
      } else {
        if (Number.isNaN(compressionDiffDb) || !Number.isFinite(compressionDiffDb)) compressionDiffDb = 1;
        if (ker.maxAttackDiffDb === -1 || ker.maxAttackDiffDb < compressionDiffDb) ker.maxAttackDiffDb = compressionDiffDb;
        const effAttenDiffDb = Math.max(0.5, ker.maxAttackDiffDb);
        const x = fr(0.25 / effAttenDiffDb);
        envelopeRate = fr(1 - pow(x, fr(1 / attackFrames)));
      }
      let preRead = ker.preDelayRead, preWrite = ker.preDelayWrite;
      let detectorAverage = ker.detectorAverage, compressorGain = ker.compressorGain;
      let loop = DIVISION_FRAMES;
      while (loop--) {
        let compressorInput = 0;
        for (let ch = 0; ch < nCh; ch++) {
          const undelayed = srcs[ch][frame];
          ker.preDelay[ch][preWrite] = undelayed;
          const absU = undelayed > 0 ? undelayed : -undelayed;
          if (compressorInput < absU) compressorInput = absU;
        }
        const scaledInput = compressorInput;
        const absInput = scaledInput > 0 ? scaledInput : -scaledInput;
        const shapedInput = saturate(c, absInput, k);
        const attenuation = absInput <= 0.0001 ? 1 : fr(shapedInput / absInput);
        let attenuationDb = fr(-linearToDb(attenuation));
        attenuationDb = Math.max(2, attenuationDb);
        const dbPerFrame = fr(attenuationDb / satReleaseFrames);
        const satReleaseRate = fr(dbToLinear(dbPerFrame) - 1);
        const isRelease = attenuation > detectorAverage;
        const rate = isRelease ? satReleaseRate : 1;
        detectorAverage = fr(detectorAverage + fr(fr(attenuation - detectorAverage) * rate));
        detectorAverage = Math.min(1, detectorAverage);
        if (Number.isNaN(detectorAverage) || !Number.isFinite(detectorAverage)) detectorAverage = 1;
        if (envelopeRate < 1) compressorGain = fr(compressorGain + fr(fr(scaledDesiredGain - compressorGain) * envelopeRate));
        else { compressorGain = fr(compressorGain * envelopeRate); compressorGain = Math.min(1, compressorGain); }
        const postWarp = fr(Math.sin(fr(fr(0.5 * PI) * compressorGain)));
        const totalGain = fr(dryMix + fr(fr(wetMix * masterLinearGain) * postWarp));
        const dbRealGain = linearToDb(postWarp);
        if (dbRealGain < ker.meteringGain) ker.meteringGain = dbRealGain;
        else ker.meteringGain = fr(ker.meteringGain + fr(fr(dbRealGain - ker.meteringGain) * ker.meteringReleaseK));
        for (let ch = 0; ch < nCh; ch++) dsts[ch][frame] = fr(ker.preDelay[ch][preRead] * totalGain);
        frame++;
        preWrite = (preWrite + 1) & PRE_DELAY_MASK;
        preRead = (preRead + 1) & PRE_DELAY_MASK;
      }
      ker.preDelayRead = preRead; ker.preDelayWrite = preWrite;
      ker.detectorAverage = detectorAverage; ker.compressorGain = compressorGain;
    }
  }

  const CompHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      const nCh = inp.length;
      ensureBus(out.bus, nCh, frames);
      const st = rec.state;
      if (!st.kernel || st.kernelCh !== nCh) { st.kernel = newKernel(rec.eng.sampleRate); st.kernelCh = nCh; }
      const pm = rec.pm;
      const prm = { threshold: pm.threshold.buffer[0], knee: pm.knee.buffer[0], ratio: pm.ratio.buffer[0], attack: pm.attack.buffer[0], release: pm.release.buffer[0],
        preDelay: fr(0.006), postGain: 0, effectBlend: 1, zone1: fr(0.09), zone2: fr(0.16), zone3: fr(0.42), zone4: fr(0.98) };
      kernelProcess(st.kernel, inp, out.bus, frames, prm);
      st.reduction = st.kernel.meteringGain;
    },
  };
  class DynamicsCompressorNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'DynamicsCompressorNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'DynamicsCompressorNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: CompHandler, kind: 'compressor', inputs: 1, outputs: 1, channelCount: 2, mode: 'clamped-max', interp: 'speakers' });
      rec.forbidMode = 'max'; rec.forbidModeMessage = "The channelCountMode cannot be set to 'max'."; rec.maxChannelCount = 2;
      NODE.set(this, rec);
      const k = { rate: 'k-rate', fixedRate: true };
      rec.pm = addParams(rec, { threshold: [-24, -100, 0, k], knee: [30, 0, 40, k], ratio: [12, 1, 20, k], attack: [fr(0.003), 0, 1, k], release: [0.25, 0, 1, k] });
      rec.state.reduction = 0;
      applyOptions(rec, options, 'DynamicsCompressorNode'); setParamOptions(rec.pm, options);
    }
    get threshold() { return nd(this).pm.threshold.wrapper; }
    get knee() { return nd(this).pm.knee.wrapper; }
    get ratio() { return nd(this).pm.ratio.wrapper; }
    get reduction() { return nd(this).state.reduction; }
    get attack() { return nd(this).pm.attack.wrapper; }
    get release() { return nd(this).pm.release.wrapper; }
  }
  L.expose('DynamicsCompressorNode', DynamicsCompressorNode);
  WA.DynamicsCompressorNode = DynamicsCompressorNode;

  // ---------------------------------------------------------------------------------------
  // Biquad coefficients (Web Audio spec "Filters characteristics", Blink's Biquad)
  // ---------------------------------------------------------------------------------------
  function biquadCoeffs(type, freq, q, gainDb, nyquist, detune) {
    let f = freq * Math.pow(2, detune / 1200);
    const c = Math.min(Math.max(f / nyquist, 0), 1); // normalized cutoff 0..1
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    const set = (B0, B1, B2, A0, A1, A2) => { b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0; };
    switch (type) {
      case 'lowpass': {
        if (c >= 1) { set(1, 0, 0, 1, 0, 0); break; }
        if (c <= 0) { set(0, 0, 0, 1, 0, 0); break; }
        const res = Math.pow(10, q / 20);
        const theta = Math.PI * c, alpha = Math.sin(theta) / (2 * res), cosw = Math.cos(theta), beta = (1 - cosw) / 2;
        set(beta, 2 * beta, beta, 1 + alpha, -2 * cosw, 1 - alpha);
        break;
      }
      case 'highpass': {
        if (c >= 1) { set(0, 0, 0, 1, 0, 0); break; }
        if (c <= 0) { set(1, 0, 0, 1, 0, 0); break; }
        const res = Math.pow(10, q / 20);
        const theta = Math.PI * c, alpha = Math.sin(theta) / (2 * res), cosw = Math.cos(theta), beta = (1 + cosw) / 2;
        set(beta, -2 * beta, beta, 1 + alpha, -2 * cosw, 1 - alpha);
        break;
      }
      case 'bandpass': {
        if (c <= 0 || c >= 1) { set(0, 0, 0, 1, 0, 0); break; }
        if (q <= 0) { set(1, 0, 0, 1, 0, 0); break; }
        const w0 = Math.PI * c, alpha = Math.sin(w0) / (2 * q), k = Math.cos(w0);
        set(alpha, 0, -alpha, 1 + alpha, -2 * k, 1 - alpha);
        break;
      }
      case 'notch': {
        if (c <= 0 || c >= 1) { set(1, 0, 0, 1, 0, 0); break; }
        if (q <= 0) { set(0, 0, 0, 1, 0, 0); break; }
        const w0 = Math.PI * c, alpha = Math.sin(w0) / (2 * q), k = Math.cos(w0);
        set(1, -2 * k, 1, 1 + alpha, -2 * k, 1 - alpha);
        break;
      }
      case 'allpass': {
        if (c <= 0 || c >= 1) { set(1, 0, 0, 1, 0, 0); break; }
        if (q <= 0) { set(-1, 0, 0, 1, 0, 0); break; }
        const w0 = Math.PI * c, alpha = Math.sin(w0) / (2 * q), k = Math.cos(w0);
        set(1 - alpha, -2 * k, 1 + alpha, 1 + alpha, -2 * k, 1 - alpha);
        break;
      }
      case 'peaking': {
        if (c <= 0 || c >= 1) { set(1, 0, 0, 1, 0, 0); break; }
        const A = Math.pow(10, gainDb / 40);
        if (q <= 0) { set(A * A, 0, 0, 1, 0, 0); break; }
        const w0 = Math.PI * c, alpha = Math.sin(w0) / (2 * q), k = Math.cos(w0);
        set(1 + alpha * A, -2 * k, 1 - alpha * A, 1 + alpha / A, -2 * k, 1 - alpha / A);
        break;
      }
      case 'lowshelf': {
        if (c <= 0) { set(1, 0, 0, 1, 0, 0); break; }
        const A = Math.pow(10, gainDb / 40);
        if (c >= 1) { set(A * A, 0, 0, 1, 0, 0); break; }
        const w0 = Math.PI * c, S = 1, alpha = 0.5 * Math.sin(w0) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2), k = Math.cos(w0), k2 = 2 * Math.sqrt(A) * alpha;
        const aPlusOne = A + 1, aMinusOne = A - 1;
        set(A * (aPlusOne - aMinusOne * k + k2), 2 * A * (aMinusOne - aPlusOne * k), A * (aPlusOne - aMinusOne * k - k2), aPlusOne + aMinusOne * k + k2, -2 * (aMinusOne + aPlusOne * k), aPlusOne + aMinusOne * k - k2);
        break;
      }
      default: { // highshelf
        if (c >= 1) { set(1, 0, 0, 1, 0, 0); break; }
        const A = Math.pow(10, gainDb / 40);
        if (c <= 0) { set(A * A, 0, 0, 1, 0, 0); break; }
        const w0 = Math.PI * c, S = 1, alpha = 0.5 * Math.sin(w0) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2), k = Math.cos(w0), k2 = 2 * Math.sqrt(A) * alpha;
        const aPlusOne = A + 1, aMinusOne = A - 1;
        set(A * (aPlusOne + aMinusOne * k + k2), -2 * A * (aMinusOne + aPlusOne * k), A * (aPlusOne + aMinusOne * k - k2), aPlusOne - aMinusOne * k + k2, 2 * (aMinusOne - aPlusOne * k), aPlusOne - aMinusOne * k - k2);
      }
    }
    return [b0, b1, b2, a1, a2];
  }
  const BiquadHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      const ch = inp.length;
      ensureBus(out.bus, ch, frames);
      const st = rec.state, pm = rec.pm;
      const nyq = rec.eng.sampleRate / 2;
      while (st.x1.length < ch) { st.x1.push(0); st.x2.push(0); st.y1.push(0); st.y2.push(0); }
      const varies = pm.frequency.varies || pm.detune.varies || pm.Q.varies || pm.gain.varies;
      let co = biquadCoeffs(st.type, pm.frequency.buffer[0], pm.Q.buffer[0], pm.gain.buffer[0], nyq, pm.detune.buffer[0]);
      for (let c = 0; c < ch; c++) {
        const s = inp[c], d = out.bus[c];
        let x1 = st.x1[c], x2 = st.x2[c], y1 = st.y1[c], y2 = st.y2[c];
        for (let i = 0; i < frames; i++) {
          if (varies && i > 0) co = biquadCoeffs(st.type, pm.frequency.buffer[i], pm.Q.buffer[i], pm.gain.buffer[i], nyq, pm.detune.buffer[i]);
          const x = s[i];
          const y = co[0] * x + co[1] * x1 + co[2] * x2 - co[3] * y1 - co[4] * y2;
          x2 = x1; x1 = x; y2 = y1; y1 = y;
          d[i] = y;
        }
        st.x1[c] = x1; st.x2[c] = x2; st.y1[c] = Number.isFinite(y1) ? y1 : 0; st.y2[c] = Number.isFinite(y2) ? y2 : 0;
      }
    },
  };
  const BIQUAD_TYPES = ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'];
  function responseOf(b, a, freqs, mag, phase, nyq, iface) {
    if (!(freqs instanceof Float32Array)) throw new TypeError(`Failed to execute 'getFrequencyResponse' on '${iface}': parameter 1 is not of type 'Float32Array'.`);
    if (!(mag instanceof Float32Array)) throw new TypeError(`Failed to execute 'getFrequencyResponse' on '${iface}': parameter 2 is not of type 'Float32Array'.`);
    if (!(phase instanceof Float32Array)) throw new TypeError(`Failed to execute 'getFrequencyResponse' on '${iface}': parameter 3 is not of type 'Float32Array'.`);
    if (mag.length < freqs.length) throw new DOMException(`Failed to execute 'getFrequencyResponse' on '${iface}': The magResponse array length (${mag.length}) is less than frequencyHz length (${freqs.length}).`, 'InvalidAccessError');
    if (phase.length < freqs.length) throw new DOMException(`Failed to execute 'getFrequencyResponse' on '${iface}': The phaseResponse array length (${phase.length}) is less than frequencyHz length (${freqs.length}).`, 'InvalidAccessError');
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      if (!(f >= 0 && f <= nyq)) { mag[i] = NaN; phase[i] = NaN; continue; }
      const w = Math.PI * f / nyq;
      const cr = (c, k) => c.reduce((s, v, j) => s + v * Math.cos(-k * j * w), 0), ci = (c, k) => c.reduce((s, v, j) => s + v * Math.sin(-k * j * w), 0);
      const nr = cr(b, 1), ni = ci(b, 1), dr = cr(a, 1), di = ci(a, 1);
      const den = dr * dr + di * di;
      const hr = (nr * dr + ni * di) / den, hi = (ni * dr - nr * di) / den;
      mag[i] = Math.hypot(hr, hi); phase[i] = Math.atan2(hi, hr);
    }
  }
  class BiquadFilterNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'BiquadFilterNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'BiquadFilterNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: BiquadHandler, kind: 'biquad', inputs: 1, outputs: 1, channelCount: 2, mode: 'max', interp: 'speakers' });
      NODE.set(this, rec);
      const nyq = fr(eng.sampleRate / 2);
      rec.pm = addParams(rec, { frequency: [350, 0, nyq], detune: [0, -153600, 153600], Q: [1, -FLT_MAX, FLT_MAX], gain: [0, -FLT_MAX, fr(40 * Math.log10(FLT_MAX))] });
      Object.assign(rec.state, { type: 'lowpass', x1: [], x2: [], y1: [], y2: [] });
      applyOptions(rec, options, 'BiquadFilterNode'); setParamOptions(rec.pm, options);
      if (options && options.type !== undefined) this.type = options.type;
    }
    get type() { return nd(this).state.type; }
    set type(v) { v = `${v}`; if (BIQUAD_TYPES.includes(v)) nd(this).state.type = v; }
    get frequency() { return nd(this).pm.frequency.wrapper; }
    get detune() { return nd(this).pm.detune.wrapper; }
    get Q() { return nd(this).pm.Q.wrapper; }
    get gain() { return nd(this).pm.gain.wrapper; }
    getFrequencyResponse(frequencyHz, magResponse, phaseResponse) {
      argc(3, arguments.length, 'BiquadFilterNode', 'getFrequencyResponse');
      const r = nd(this);
      const nyq = r.eng.sampleRate / 2;
      const [b0, b1, b2, a1, a2] = biquadCoeffs(r.state.type, r.pm.frequency.base, r.pm.Q.base, r.pm.gain.base, nyq, r.pm.detune.base);
      responseOf([b0, b1, b2], [1, a1, a2], frequencyHz, magResponse, phaseResponse, nyq, 'BiquadFilterNode');
    }
  }
  L.expose('BiquadFilterNode', BiquadFilterNode);
  WA.BiquadFilterNode = BiquadFilterNode;

  // ---------------------------------------------------------------------------------------
  // IIRFilterNode
  // ---------------------------------------------------------------------------------------
  const IIRHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      const ch = inp.length;
      ensureBus(out.bus, ch, frames);
      const { b, a } = rec.state;
      const nb = b.length, na = a.length;
      while (rec.state.xs.length < ch) { rec.state.xs.push(new Float64Array(32)); rec.state.ys.push(new Float64Array(32)); }
      for (let c = 0; c < ch; c++) {
        const s = inp[c], d = out.bus[c], xs = rec.state.xs[c], ys = rec.state.ys[c];
        let pos = rec.state.pos;
        for (let i = 0; i < frames; i++) {
          xs[pos & 31] = s[i];
          let y = 0;
          for (let k = 0; k < nb; k++) y += b[k] * xs[(pos - k) & 31];
          for (let k = 1; k < na; k++) y -= a[k] * ys[(pos - k) & 31];
          ys[pos & 31] = y;
          d[i] = y;
          pos++;
        }
        if (c === ch - 1) rec.state.pos = pos;
      }
    },
  };
  class IIRFilterNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 2 ? (() => { throw new TypeError(`Failed to construct 'IIRFilterNode': 2 arguments required, but only ${arguments.length} present.`); })() : ctxArg(context, 'IIRFilterNode');
      super(INTERNAL);
      if (options === null || typeof options !== 'object' || options.feedforward === undefined || options.feedback === undefined) throw new TypeError("Failed to construct 'IIRFilterNode': Failed to read the 'feedforward' property from 'IIRFilterOptions': Required member is undefined.");
      const ff = Array.from(options.feedforward, Number), fb = Array.from(options.feedback, Number);
      if (ff.length === 0 || ff.length > 20) throw new DOMException(`Failed to construct 'IIRFilterNode': The feedforward array length (${ff.length}) is outside the range [1, 20].`, 'NotSupportedError');
      if (fb.length === 0 || fb.length > 20) throw new DOMException(`Failed to construct 'IIRFilterNode': The feedback array length (${fb.length}) is outside the range [1, 20].`, 'NotSupportedError');
      if (ff.every((v) => v === 0)) throw new DOMException("Failed to construct 'IIRFilterNode': feedforward coefficients cannot all be zero.", 'InvalidStateError');
      if (fb[0] === 0) throw new DOMException("Failed to construct 'IIRFilterNode': First feedback coefficient cannot be zero.", 'InvalidStateError');
      const rec = newNodeRec(eng, this, { handler: IIRHandler, kind: 'iir', inputs: 1, outputs: 1, channelCount: 2, mode: 'max', interp: 'speakers' });
      NODE.set(this, rec);
      const a0 = fb[0];
      Object.assign(rec.state, { b: ff.map((v) => v / a0), a: fb.map((v) => v / a0), xs: [], ys: [], pos: 0 });
      applyOptions(rec, options, 'IIRFilterNode');
    }
    getFrequencyResponse(frequencyHz, magResponse, phaseResponse) {
      argc(3, arguments.length, 'IIRFilterNode', 'getFrequencyResponse');
      const r = nd(this);
      responseOf(r.state.b, r.state.a, frequencyHz, magResponse, phaseResponse, r.eng.sampleRate / 2, 'IIRFilterNode');
    }
  }
  L.expose('IIRFilterNode', IIRFilterNode);
  WA.IIRFilterNode = IIRFilterNode;

  WA.defineFactories();
})(globalThis.__layer);
