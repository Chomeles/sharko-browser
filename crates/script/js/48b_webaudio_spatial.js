// 48b_webaudio_spatial.js — PannerNode (equal-power panning with distance and cone attenuation; 'HRTF' is accepted but
// rendered equal-power, there is no HRTF database) and ConvolverNode (uniform partitioned FFT convolution).
(function (L) {
  'use strict';
  const INTERNAL = L.INTERNAL;
  const DOMException = L.DOMException;
  const WA = L.webaudio;
  const { QUANTUM, argc, nd, NODE, newNodeRec, ensureBus, AudioNode, bufOf } = WA;
  const { applyOptions, ctxArg, addParams, setParamOptions } = WA;
  const fr = Math.fround;
  const FLT_MAX = 3.4028234663852886e+38;

  // ---------------------------------------------------------------------------------------
  // PannerNode
  // ---------------------------------------------------------------------------------------
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function distanceGain(model, d, ref, max, rolloff) {
    switch (model) {
      case 'linear': d = Math.max(Math.min(d, max), ref); return 1 - rolloff * (d - ref) / (max - ref);
      case 'exponential': return Math.pow(Math.max(d, ref) / ref, -rolloff);
      default: return ref / (ref + rolloff * (Math.max(d, ref) - ref));
    }
  }
  const PannerHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      ensureBus(out.bus, 2, frames);
      const st = rec.state, pm = rec.pm;
      const eng = rec.eng;
      const lp = WA.listenerParams(eng);
      const pos = [pm.positionX.buffer[0], pm.positionY.buffer[0], pm.positionZ.buffer[0]];
      const lpos = [lp.positionX.buffer[0], lp.positionY.buffer[0], lp.positionZ.buffer[0]];
      const fwd = [lp.forwardX.buffer[0], lp.forwardY.buffer[0], lp.forwardZ.buffer[0]];
      const up = [lp.upX.buffer[0], lp.upY.buffer[0], lp.upZ.buffer[0]];
      const sl = [pos[0] - lpos[0], pos[1] - lpos[1], pos[2] - lpos[2]];
      const dist = Math.hypot(sl[0], sl[1], sl[2]);
      let azimuth = 0;
      if (dist > 0) {
        const s = norm3(sl);
        const right = norm3(cross3(norm3(fwd), norm3(up)));
        const upProj = dot3(s, norm3(up));
        const proj = norm3([s[0] - upProj * norm3(up)[0], s[1] - upProj * norm3(up)[1], s[2] - upProj * norm3(up)[2]]);
        azimuth = (180 / Math.PI) * Math.acos(Math.max(-1, Math.min(1, dot3(proj, right))));
        if (dot3(proj, norm3(fwd)) < 0) azimuth = 360 - azimuth;
        azimuth = (azimuth >= 0 && azimuth <= 270) ? 90 - azimuth : 450 - azimuth;
      }
      // equal-power
      if (azimuth < -180) azimuth = -180; if (azimuth > 180) azimuth = 180;
      if (azimuth < -90) azimuth = -180 - azimuth; else if (azimuth > 90) azimuth = 180 - azimuth;
      const mono = inp.length === 1;
      const panPos = mono ? (azimuth + 90) / 180 : (azimuth <= 0 ? (azimuth + 90) / 90 : azimuth / 90);
      const gl = Math.cos(0.5 * Math.PI * panPos), gr = Math.sin(0.5 * Math.PI * panPos);
      // distance and cone gains
      let gain = distanceGain(st.distanceModel, dist, st.refDistance, st.maxDistance, st.rolloffFactor);
      const ori = [pm.orientationX.buffer[0], pm.orientationY.buffer[0], pm.orientationZ.buffer[0]];
      if (st.coneOuterAngle !== 360 || st.coneInnerAngle !== 360) {
        if (ori[0] !== 0 || ori[1] !== 0 || ori[2] !== 0) {
          const toListener = norm3([lpos[0] - pos[0], lpos[1] - pos[1], lpos[2] - pos[2]]);
          const angle = (180 / Math.PI) * Math.acos(Math.max(-1, Math.min(1, dot3(norm3(ori), toListener))));
          const absAngle = Math.abs(angle);
          const innerHalf = Math.abs(st.coneInnerAngle) / 2, outerHalf = Math.abs(st.coneOuterAngle) / 2;
          let cone;
          if (absAngle <= innerHalf) cone = 1; else if (absAngle >= outerHalf) cone = st.coneOuterGain; else cone = 1 - (1 - st.coneOuterGain) * (absAngle - innerHalf) / (outerHalf - innerHalf);
          gain *= cone;
        }
      }
      const L_ = out.bus[0], R_ = out.bus[1];
      if (mono) { const s = inp[0]; for (let i = 0; i < frames; i++) { L_[i] = fr(s[i] * gl * gain); R_[i] = fr(s[i] * gr * gain); } } else {
        const l = inp[0], r = inp[1];
        for (let i = 0; i < frames; i++) {
          if (azimuth <= 0) { L_[i] = fr((l[i] + r[i] * gl) * gain); R_[i] = fr(r[i] * gr * gain); } else { L_[i] = fr(l[i] * gl * gain); R_[i] = fr((r[i] + l[i] * gr) * gain); }
        }
      }
    },
  };
  const PANNING = ['equalpower', 'HRTF'], DIST = ['linear', 'inverse', 'exponential'];
  class PannerNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'PannerNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'PannerNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: PannerHandler, kind: 'panner3d', inputs: 1, outputs: 1, channelCount: 2, mode: 'clamped-max', interp: 'speakers', outputChannels: 2 });
      rec.forbidMode = 'max'; rec.maxChannelCount = 2;
      NODE.set(this, rec);
      rec.pm = addParams(rec, { positionX: [0, -FLT_MAX, FLT_MAX], positionY: [0, -FLT_MAX, FLT_MAX], positionZ: [0, -FLT_MAX, FLT_MAX], orientationX: [1, -FLT_MAX, FLT_MAX], orientationY: [0, -FLT_MAX, FLT_MAX], orientationZ: [0, -FLT_MAX, FLT_MAX] });
      Object.assign(rec.state, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 });
      applyOptions(rec, options, 'PannerNode'); setParamOptions(rec.pm, options);
      if (options) for (const k of ['panningModel', 'distanceModel', 'refDistance', 'maxDistance', 'rolloffFactor', 'coneInnerAngle', 'coneOuterAngle', 'coneOuterGain']) if (options[k] !== undefined) this[k] = options[k];
    }
    get panningModel() { return nd(this).state.panningModel; }
    set panningModel(v) { v = `${v}`; if (PANNING.includes(v)) nd(this).state.panningModel = v; }
    get distanceModel() { return nd(this).state.distanceModel; }
    set distanceModel(v) { v = `${v}`; if (DIST.includes(v)) nd(this).state.distanceModel = v; }
    get refDistance() { return nd(this).state.refDistance; }
    set refDistance(v) { const n = Number(v); if (n < 0) throw new RangeError(`Failed to set the 'refDistance' property on 'PannerNode': The refDistance provided (${n}) is negative.`); nd(this).state.refDistance = n; }
    get maxDistance() { return nd(this).state.maxDistance; }
    set maxDistance(v) { const n = Number(v); if (!(n > 0)) throw new RangeError(`Failed to set the 'maxDistance' property on 'PannerNode': The maxDistance provided (${n}) is not positive.`); nd(this).state.maxDistance = n; }
    get rolloffFactor() { return nd(this).state.rolloffFactor; }
    set rolloffFactor(v) { const n = Number(v); if (n < 0) throw new RangeError(`Failed to set the 'rolloffFactor' property on 'PannerNode': The rolloffFactor provided (${n}) is negative.`); nd(this).state.rolloffFactor = n; }
    get coneInnerAngle() { return nd(this).state.coneInnerAngle; }
    set coneInnerAngle(v) { nd(this).state.coneInnerAngle = Number(v); }
    get coneOuterAngle() { return nd(this).state.coneOuterAngle; }
    set coneOuterAngle(v) { nd(this).state.coneOuterAngle = Number(v); }
    get coneOuterGain() { return nd(this).state.coneOuterGain; }
    set coneOuterGain(v) { const n = Number(v); if (n < 0 || n > 1) throw new DOMException(`Failed to set the 'coneOuterGain' property on 'PannerNode': The coneOuterGain provided (${n}) is outside the range [0, 1].`, 'InvalidStateError'); nd(this).state.coneOuterGain = n; }
    setPosition(x, y, z) { argc(3, arguments.length, 'PannerNode', 'setPosition'); const p = nd(this).pm; p.positionX.wrapper.value = x; p.positionY.wrapper.value = y; p.positionZ.wrapper.value = z; }
    setOrientation(x, y, z) { argc(3, arguments.length, 'PannerNode', 'setOrientation'); const p = nd(this).pm; p.orientationX.wrapper.value = x; p.orientationY.wrapper.value = y; p.orientationZ.wrapper.value = z; }
  }
  for (const k of ['positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ']) Object.defineProperty(PannerNode.prototype, k, { get() { return nd(this).pm[k].wrapper; }, enumerable: true, configurable: true });
  L.expose('PannerNode', PannerNode);
  WA.PannerNode = PannerNode;

  // ---------------------------------------------------------------------------------------
  // ConvolverNode: partitioned convolution, partition = one render quantum
  // ---------------------------------------------------------------------------------------
  function normalizationScale(buf) {
    const n = buf.channels.length;
    let sum = 0;
    for (const ch of buf.channels) for (let i = 0; i < buf.length; i++) sum += ch[i] * ch[i];
    let power = Math.sqrt(sum / (n * buf.length));
    if (!Number.isFinite(power) || power < 0.000125) power = 0.000125;
    let scale = 1 / power;
    scale *= 0.00125;
    scale *= 44100 / buf.sampleRate;
    if (n === 4) scale *= 0.5;
    return scale;
  }
  function buildIR(buf, scale) {
    // spectra of the partitions of every IR channel
    const P = Math.ceil(buf.length / QUANTUM);
    const size = 2 * QUANTUM;
    return buf.channels.map((ch) => {
      const parts = [];
      for (let p = 0; p < P; p++) {
        const re = new Float64Array(size), im = new Float64Array(size);
        for (let i = 0; i < QUANTUM; i++) { const k = p * QUANTUM + i; re[i] = k < buf.length ? ch[k] * scale : 0; }
        WA.fft(re, im, false);
        parts.push([re, im]);
      }
      return parts;
    });
  }
  const ConvHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      const st = rec.state;
      if (!st.ir) { ensureBus(out.bus, Math.min(Math.max(inp.length, 1), 2), frames); for (const c of out.bus) c.fill(0); return; }
      const irCh = st.ir.length;
      const inCh = Math.min(inp.length, 2);
      const outCh = irCh === 1 ? inCh : 2;
      ensureBus(out.bus, outCh, frames);
      const size = 2 * QUANTUM;
      // per input channel: spectrum history
      while (st.hist.length < inCh) st.hist.push({ prev: new Float64Array(QUANTUM), spectra: [] });
      const P = st.ir[0].length;
      for (let c = 0; c < inCh; c++) {
        const h = st.hist[c];
        const re = new Float64Array(size), im = new Float64Array(size);
        re.set(h.prev, 0);
        for (let i = 0; i < QUANTUM; i++) re[QUANTUM + i] = inp[c][i];
        h.prev = Float64Array.from(inp[c].subarray(0, QUANTUM));
        WA.fft(re, im, false);
        h.spectra.unshift([re, im]);
        if (h.spectra.length > P) h.spectra.pop();
      }
      const conv = (inChan, irChan) => {
        const parts = st.ir[irChan], spectra = st.hist[inChan].spectra;
        const accR = new Float64Array(size), accI = new Float64Array(size);
        const n = Math.min(parts.length, spectra.length);
        for (let p = 0; p < n; p++) {
          const [ar, ai] = parts[p], [br, bi] = spectra[p];
          for (let k = 0; k < size; k++) { accR[k] += ar[k] * br[k] - ai[k] * bi[k]; accI[k] += ar[k] * bi[k] + ai[k] * br[k]; }
        }
        WA.fft(accR, accI, true);
        const o = new Float64Array(QUANTUM);
        for (let i = 0; i < QUANTUM; i++) o[i] = accR[QUANTUM + i] / size;
        return o;
      };
      const put = (c, arr) => { for (let i = 0; i < frames; i++) out.bus[c][i] = fr(arr[i]); };
      if (irCh === 1) { for (let c = 0; c < outCh; c++) put(c, conv(c, 0)); } else if (irCh === 2) {
        if (inCh === 1) { put(0, conv(0, 0)); put(1, conv(0, 1)); } else { put(0, conv(0, 0)); put(1, conv(1, 1)); }
      } else { // 4 channels: true stereo
        const l0 = conv(0, 0), l1 = conv(0, 1);
        const r0 = inCh > 1 ? conv(1, 2) : l0, r1 = inCh > 1 ? conv(1, 3) : l1;
        if (inCh === 1) { const a = conv(0, 2), b = conv(0, 3); put(0, l0.map((v, i) => v + a[i] * 0)); put(1, l1.map((v, i) => v + b[i] * 0)); } else { put(0, l0.map((v, i) => v + r0[i])); put(1, l1.map((v, i) => v + r1[i])); }
      }
    },
  };
  class ConvolverNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'ConvolverNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'ConvolverNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: ConvHandler, kind: 'convolver', inputs: 1, outputs: 1, channelCount: 2, mode: 'clamped-max', interp: 'speakers', outputChannels: 2 });
      rec.forbidMode = 'max'; rec.maxChannelCount = 2;
      NODE.set(this, rec);
      Object.assign(rec.state, { buffer: null, normalize: true, ir: null, hist: [] });
      applyOptions(rec, options, 'ConvolverNode');
      if (options) { if (options.disableNormalization !== undefined) this.normalize = !options.disableNormalization; if (options.buffer !== undefined && options.buffer !== null) this.buffer = options.buffer; }
    }
    get buffer() { return nd(this).state.buffer; }
    set buffer(v) {
      const r = nd(this), st = r.state;
      if (v === null || v === undefined) { st.buffer = null; st.ir = null; return; }
      if (!(v instanceof WA.AudioBuffer)) throw new TypeError("Failed to set the 'buffer' property on 'ConvolverNode': The provided value is not of type 'AudioBuffer'.");
      const b = bufOf(v);
      if (b.sampleRate !== r.eng.sampleRate) throw new DOMException("Failed to set the 'buffer' property on 'ConvolverNode': The buffer sample rate of " + b.sampleRate + " does not match the context rate of " + r.eng.sampleRate + ' Hz.', 'NotSupportedError');
      if (![1, 2, 4].includes(b.channels.length)) throw new DOMException(`Failed to set the 'buffer' property on 'ConvolverNode': The buffer must have 1, 2, or 4 channels, not ${b.channels.length}`, 'NotSupportedError');
      st.buffer = v; st.hist = [];
      st.ir = buildIR(b, st.normalize ? normalizationScale(b) : 1);
    }
    get normalize() { return nd(this).state.normalize; }
    set normalize(v) {
      const st = nd(this).state; st.normalize = !!v;
      if (st.buffer) st.ir = buildIR(bufOf(st.buffer), st.normalize ? normalizationScale(bufOf(st.buffer)) : 1);
    }
  }
  L.expose('ConvolverNode', ConvolverNode);
  WA.ConvolverNode = ConvolverNode;
})(globalThis.__layer);
