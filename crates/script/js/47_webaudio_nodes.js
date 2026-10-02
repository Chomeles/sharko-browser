// 47_webaudio_nodes.js — AudioNode and the node types (destination, gain, oscillator with PeriodicWave, constant
// source, buffer source, delay, stereo panner, channel splitter/merger, wave shaper, analyser, script processor),
// the listener, and the contexts AudioContext / OfflineAudioContext with the factory methods of BaseAudioContext.
// The compressor and the filters are in 48_webaudio_dsp.js.
(function (L) {
  'use strict';
  const INTERNAL = L.INTERNAL;
  const DOMException = L.DOMException;
  const WA = L.webaudio;
  const { QUANTUM, argc, cx, nd, NODE, CTX, newNodeRec, newParam, ensureBus, bufOf, makeBuffer, BaseAudioContext, prm } = WA;
  const fr = Math.fround;
  const FLT_MAX = 3.4028234663852886e+38;

  const MODES = ['max', 'clamped-max', 'explicit'];
  const INTERPS = ['speakers', 'discrete'];
  const enumErr = (v, type) => new TypeError(`The provided value '${v}' is not a valid enum value of type ${type}.`);

  // ---------------------------------------------------------------------------------------
  // AudioNode
  // ---------------------------------------------------------------------------------------
  class AudioNode extends L.EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    get context() { return nd(this).eng.wrapper; }
    get numberOfInputs() { return nd(this).inputs.length; }
    get numberOfOutputs() { return nd(this).outputs.length; }
    get channelCount() { return nd(this).channelCount; }
    set channelCount(v) {
      const r = nd(this);
      const n = v >>> 0;
      if (r.fixedChannels) throw new DOMException(`Failed to set the 'channelCount' property on 'AudioNode': ${r.fixedChannels}`, 'InvalidStateError');
      if (r.maxChannelCount && n > r.maxChannelCount) throw new DOMException(`Failed to set the 'channelCount' property on 'AudioNode': The channelCount provided (${n}) is outside the range [1, ${r.maxChannelCount}].`, 'NotSupportedError');
      if (n < 1 || n > 32) throw new DOMException(`Failed to set the 'channelCount' property on 'AudioNode': The channel count provided (${n}) is outside the range [1, 32].`, 'NotSupportedError');
      r.channelCount = n;
    }
    get channelCountMode() { return nd(this).mode; }
    set channelCountMode(v) {
      const r = nd(this);
      v = `${v}`;
      if (!MODES.includes(v)) return;
      if (r.forbidMode === v) throw new DOMException(`Failed to set the 'channelCountMode' property on 'AudioNode': The provided value '${v}' is not an allowed value for ChannelCountMode`, 'NotSupportedError');
      if (r.fixedMode && v !== r.fixedMode) throw new DOMException(`Failed to set the 'channelCountMode' property on 'AudioNode': ${r.fixedModeMessage || 'The channel count mode cannot be changed.'}`, 'InvalidStateError');
      r.mode = v;
    }
    get channelInterpretation() { return nd(this).interp; }
    set channelInterpretation(v) {
      const r = nd(this);
      v = `${v}`;
      if (!INTERPS.includes(v)) return;
      if (r.fixedInterp && v !== r.fixedInterp) throw new DOMException("Failed to set the 'channelInterpretation' property on 'AudioNode': The channel interpretation cannot be changed.", 'InvalidStateError');
      r.interp = v;
    }
    connect(destination, output, input) {
      argc(1, arguments.length, 'AudioNode', 'connect');
      const src = nd(this);
      const o = output === undefined ? 0 : output >>> 0;
      if (destination instanceof AudioNode) {
        const dst = nd(destination);
        const i = input === undefined ? 0 : input >>> 0;
        if (src.eng !== dst.eng) throw new DOMException("Failed to execute 'connect' on 'AudioNode': cannot connect to an AudioNode belonging to a different audio context.", 'InvalidAccessError');
        if (o >= src.outputs.length) throw new DOMException(`Failed to execute 'connect' on 'AudioNode': output index (${o}) exceeds number of outputs (${src.outputs.length}).`, 'IndexSizeError');
        if (i >= dst.inputs.length) throw new DOMException(`Failed to execute 'connect' on 'AudioNode': input index (${i}) exceeds number of inputs (${dst.inputs.length}).`, 'IndexSizeError');
        const out = src.outputs[o];
        if (!dst.inputs[i].conns.includes(out)) { dst.inputs[i].conns.push(out); out.conns.push({ node: dst, input: i }); }
        if (dst.kind === 'analyser' || dst.kind === 'scriptprocessor') src.eng.autoPull.add(dst);
        return destination;
      }
      if (destination !== null && typeof destination === 'object' && WA.prm && isParam(destination)) {
        const p = prm(destination);
        if (src.eng !== p.ctx) throw new DOMException("Failed to execute 'connect' on 'AudioNode': cannot connect to a destination belonging to a different audio context.", 'InvalidAccessError');
        if (o >= src.outputs.length) throw new DOMException(`Failed to execute 'connect' on 'AudioNode': output index (${o}) exceeds number of outputs (${src.outputs.length}).`, 'IndexSizeError');
        const out = src.outputs[o];
        if (!p.inputs.includes(out)) { p.inputs.push(out); out.conns.push({ param: p }); }
        return undefined;
      }
      throw new TypeError("Failed to execute 'connect' on 'AudioNode': Overload resolution failed.");
    }
    disconnect(a, b, c) {
      const src = nd(this);
      const dropAll = (out, pred) => {
        let removed = false;
        for (const conn of out.conns.slice()) {
          if (!pred(conn)) continue;
          removed = true;
          out.conns.splice(out.conns.indexOf(conn), 1);
          if (conn.node) { const inp = conn.node.inputs[conn.input]; inp.conns.splice(inp.conns.indexOf(out), 1); } else conn.param.inputs.splice(conn.param.inputs.indexOf(out), 1);
        }
        return removed;
      };
      if (arguments.length === 0) { for (const out of src.outputs) dropAll(out, () => true); return; }
      if (typeof a === 'number' || (a !== null && typeof a !== 'object' && a !== undefined)) {
        const o = a >>> 0;
        if (o >= src.outputs.length) throw new DOMException(`Failed to execute 'disconnect' on 'AudioNode': The output index provided (${o}) is outside the range [0, ${src.outputs.length - 1}].`, 'IndexSizeError');
        dropAll(src.outputs[o], () => true);
        return;
      }
      if (a instanceof AudioNode) {
        const dst = nd(a);
        const o = b === undefined ? -1 : b >>> 0, i = c === undefined ? -1 : c >>> 0;
        if (o >= src.outputs.length && o !== -1 >>> 0) throw new DOMException(`Failed to execute 'disconnect' on 'AudioNode': The output index provided (${o}) is outside the range [0, ${src.outputs.length - 1}].`, 'IndexSizeError');
        let any = false;
        src.outputs.forEach((out, idx) => { if (b === undefined || idx === o) any = dropAll(out, (conn) => conn.node === dst && (c === undefined || conn.input === i)) || any; });
        if (!any) throw new DOMException("Failed to execute 'disconnect' on 'AudioNode': the given destination is not connected.", 'InvalidAccessError');
        return;
      }
      if (a !== null && typeof a === 'object' && isParam(a)) {
        const p = prm(a);
        const o = b === undefined ? -1 : b >>> 0;
        let any = false;
        src.outputs.forEach((out, idx) => { if (b === undefined || idx === o) any = dropAll(out, (conn) => conn.param === p) || any; });
        if (!any) throw new DOMException("Failed to execute 'disconnect' on 'AudioNode': the given AudioParam is not connected.", 'InvalidAccessError');
        return;
      }
      throw new TypeError("Failed to execute 'disconnect' on 'AudioNode': Overload resolution failed.");
    }
  }
  const isParam = (o) => { try { prm(o); return true; } catch (_) { return false; } };
  L.expose('AudioNode', AudioNode);
  WA.AudioNode = AudioNode;

  function applyOptions(rec, options, iface) {
    if (options === undefined || options === null) return;
    if (typeof options !== 'object') throw new TypeError(`Failed to construct '${iface}': The provided value is not of type '${iface}Options'.`);
    const w = rec.wrapper;
    if (options.channelCount !== undefined) w.channelCount = options.channelCount;
    if (options.channelCountMode !== undefined) { const v = `${options.channelCountMode}`; if (!MODES.includes(v)) throw enumErr(v, 'ChannelCountMode'); w.channelCountMode = v; }
    if (options.channelInterpretation !== undefined) { const v = `${options.channelInterpretation}`; if (!INTERPS.includes(v)) throw enumErr(v, 'ChannelInterpretation'); w.channelInterpretation = v; }
  }
  function ctxArg(context, iface) {
    if (!(context instanceof BaseAudioContext)) throw new TypeError(`Failed to construct '${iface}': parameter 1 is not of type 'BaseAudioContext'.`);
    return cx(context);
  }
  // paramOptions: {name: [def, min, max, opts]}
  function addParams(rec, specs) {
    const out = {};
    for (const [name, spec] of Object.entries(specs)) {
      const p = newParam(rec.eng, rec, name, spec[0], spec[1], spec[2], spec[3]);
      rec.params.push(p);
      out[name] = p;
    }
    return out;
  }
  function setParamOptions(params, options) {
    if (!options) return;
    for (const k of Object.keys(params)) if (options[k] !== undefined) params[k].wrapper.value = options[k];
  }
  const paramGetter = (name) => function () { return nd(this).pm[name].wrapper; };

  // ---------------------------------------------------------------------------------------
  // AudioDestinationNode
  // ---------------------------------------------------------------------------------------
  class AudioDestinationNode extends AudioNode {
    constructor(token) { super(token); }
    get maxChannelCount() { return nd(this).maxChannels; }
  }
  const DestHandler = { process() { /* the context's driver reads the input */ } };
  function makeDestination(eng, channels, maxChannels, fixed) {
    const w = Object.create(AudioDestinationNode.prototype);
    const rec = newNodeRec(eng, w, { handler: DestHandler, kind: 'destination', inputs: 1, outputs: 0, channelCount: channels, mode: 'explicit', interp: 'speakers' });
    rec.maxChannels = maxChannels;
    if (fixed) { rec.fixedChannels = 'The channel count cannot be changed.'; rec.fixedMode = 'explicit'; }
    NODE.set(w, rec);
    return rec;
  }
  L.expose('AudioDestinationNode', AudioDestinationNode);

  // ---------------------------------------------------------------------------------------
  // GainNode
  // ---------------------------------------------------------------------------------------
  const GainHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      ensureBus(out.bus, inp.length, frames);
      const g = rec.pm.gain.buffer;
      for (let c = 0; c < inp.length; c++) { const s = inp[c], d = out.bus[c]; for (let i = 0; i < frames; i++) d[i] = s[i] * g[i]; }
    },
  };
  class GainNode extends AudioNode {
    constructor(context, options) {
      const eng = (arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'GainNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'GainNode'));
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: GainHandler, kind: 'gain', inputs: 1, outputs: 1, channelCount: 2, mode: 'max', interp: 'speakers' });
      NODE.set(this, rec);
      rec.pm = addParams(rec, { gain: [1, -FLT_MAX, FLT_MAX] });
      applyOptions(rec, options, 'GainNode'); setParamOptions(rec.pm, options);
    }
    get gain() { return nd(this).pm.gain.wrapper; }
  }
  L.expose('GainNode', GainNode);

  // ---------------------------------------------------------------------------------------
  // AudioScheduledSourceNode
  // ---------------------------------------------------------------------------------------
  class AudioScheduledSourceNode extends AudioNode {
    constructor(token) { super(token); }
    start(when) {
      const r = nd(this);
      const t = when === undefined ? 0 : Number(when);
      if (!Number.isFinite(t)) throw new TypeError("Failed to execute 'start' on 'AudioScheduledSourceNode': The provided double value is non-finite.");
      if (t < 0) throw new RangeError(`Failed to execute 'start' on 'AudioScheduledSourceNode': The start time provided (${t}) is less than the minimum bound (0).`);
      if (r.state.started) throw new DOMException("Failed to execute 'start' on 'AudioScheduledSourceNode': cannot call start more than once.", 'InvalidStateError');
      r.state.started = true; r.state.startTime = t;
    }
    stop(when) {
      const r = nd(this);
      const t = when === undefined ? 0 : Number(when);
      if (!Number.isFinite(t)) throw new TypeError("Failed to execute 'stop' on 'AudioScheduledSourceNode': The provided double value is non-finite.");
      if (t < 0) throw new RangeError(`Failed to execute 'stop' on 'AudioScheduledSourceNode': The stop time provided (${t}) is less than the minimum bound (0).`);
      if (!r.state.started) throw new DOMException("Failed to execute 'stop' on 'AudioScheduledSourceNode': cannot call stop without calling start first.", 'InvalidStateError');
      r.state.stopTime = t;
    }
  }
  L.defineEventHandlers(AudioScheduledSourceNode.prototype, ['onended']);
  L.expose('AudioScheduledSourceNode', AudioScheduledSourceNode);
  // Scheduling for one quantum: returns [offset, count, startFrameFraction] of the audible part, updating the play state
  function schedule(rec, frames) {
    const st = rec.state;
    const eng = rec.eng, sr = eng.sampleRate;
    if (!st.started || st.ended) return [0, 0, 0];
    const q0 = eng.frame, q1 = q0 + frames;
    const startFrame = st.startTime * sr;
    if (!st.playing) {
      if (startFrame >= q1) return [0, 0, 0];
      st.playing = true;
    }
    let offset = 0, frac = 0;
    if (!st.began) { st.began = true; if (startFrame > q0) { offset = Math.ceil(startFrame) - q0; frac = Math.ceil(startFrame) - startFrame; } }
    let count = frames - offset;
    if (st.stopTime !== undefined) {
      const stopFrame = Math.ceil(st.stopTime * sr);
      if (stopFrame <= q0) { count = 0; } else if (stopFrame < q1) { count = Math.max(0, Math.min(count, stopFrame - q0 - offset)); }
      if (stopFrame <= q1) { finish(rec); }
    }
    return [offset, count, frac];
  }
  function finish(rec) {
    if (rec.state.ended) return;
    rec.state.ended = true;
    L.postTask(() => { const ev = new L.Event('ended'); rec.wrapper.dispatchEvent(ev); });
  }
  WA.finish = finish;

  // ---------------------------------------------------------------------------------------
  // PeriodicWave and the oscillator
  // ---------------------------------------------------------------------------------------
  const PW = new WeakMap();
  const pwOf = (o) => { const r = PW.get(o); if (r === undefined) throw new TypeError('Illegal invocation'); return r; };
  class PeriodicWaveData {
    constructor(sampleRate, real, imag, disableNormalization) {
      this.sampleRate = sampleRate;
      this.size = sampleRate <= 24000 ? 2048 : sampleRate <= 88200 ? 4096 : 16384;
      this.numRanges = Math.round(3 * Math.log2(this.size));
      this.centsPerRange = 1200 / 3;
      this.real = real; this.imag = imag; this.disableNormalization = disableNormalization;
      this.tables = new Array(this.numRanges).fill(null);
      this.rateScale = this.size / sampleRate;
      this.lowest = 0.5 * sampleRate / (this.size / 2);
      this.norm = 1;
      this.normComputed = false;
    }
    partialsForRange(r) {
      const cull = r * this.centsPerRange;
      const scale = Math.pow(2, -cull / 1200);
      return Math.floor(scale * (this.size / 2));
    }
    build(range) {
      const N = this.size, half = N / 2;
      const nc = Math.min(this.real.length, half);
      const re = new Float64Array(N), im = new Float64Array(N);
      const partials = this.partialsForRange(range);
      const keep = Math.min(nc, partials + 1);
      for (let k = 0; k < keep; k++) {
        const a = this.real[k], b = this.imag[k];
        if (k === 0) { re[0] = a; continue; }
        re[k] = a / 2; im[k] = -b / 2;
        re[N - k] = a / 2; im[N - k] = b / 2;
      }
      // the inverse transform of a conjugate-symmetric spectrum: x[n] = sum a cos + b sin
      WA.fft(re, im, true);
      const out = new Float32Array(N);
      if (!this.disableNormalization && !this.normComputed) {
        let mx = 0;
        if (range === 0) { for (let i = 0; i < N; i++) mx = Math.max(mx, Math.abs(fr(re[i]))); } else { const t0 = this.table(0); for (let i = 0; i < N; i++) mx = Math.max(mx, Math.abs(t0.raw[i])); }
        if (range === 0) { this.norm = mx ? fr(1 / mx) : 1; this.normComputed = true; }
      }
      const raw = new Float32Array(N);
      for (let i = 0; i < N; i++) raw[i] = re[i];
      if (range === 0 && !this.normComputed && !this.disableNormalization) { /* set above */ }
      const scale = this.disableNormalization ? 1 : this.norm;
      for (let i = 0; i < N; i++) out[i] = fr(raw[i] * scale);
      return { data: out, raw };
    }
    table(range) {
      let t = this.tables[range];
      if (t === null) {
        if (!this.disableNormalization && !this.normComputed && range !== 0) this.table(0);
        t = this.tables[range] = this.build(range);
      }
      return t;
    }
    // lower/higher tables and the interpolation factor for a fundamental frequency
    forFrequency(f) {
      f = Math.abs(f);
      const ratio = f > 0 ? f / this.lowest : 0.5;
      const cents = Math.log2(ratio) * 1200;
      let pitchRange = 1 + cents / this.centsPerRange;
      pitchRange = Math.max(pitchRange, 0);
      pitchRange = Math.min(pitchRange, this.numRanges - 1);
      const r1 = Math.floor(pitchRange);
      const r2 = r1 < this.numRanges - 1 ? r1 + 1 : r1;
      return { lower: this.table(r2).data, higher: this.table(r1).data, factor: fr(pitchRange - r1) };
    }
  }
  const basicCache = new Map();
  function basicWave(type, sampleRate) {
    const key = `${type}/${sampleRate}`;
    let w = basicCache.get(key);
    if (w) return w;
    const size = sampleRate <= 24000 ? 2048 : sampleRate <= 88200 ? 4096 : 16384;
    const half = size / 2;
    const real = new Float32Array(half), imag = new Float32Array(half);
    const PI = fr(Math.PI);
    for (let n = 1; n < half; n++) {
      const piFactor = fr(2 / fr(n * PI));
      let b;
      switch (type) {
        case 'sine': b = n === 1 ? 1 : 0; break;
        case 'square': b = fr(piFactor * fr(1 - fr(Math.cos(fr(n * PI))))); break;
        case 'sawtooth': b = fr(piFactor * ((n & 1) ? 1 : -1)); break;
        default: // triangle
          if (n & 1) { const np = fr(n * PI); b = fr(fr(8 * fr(Math.sin(fr(fr(n * PI) / 2)))) / fr(np * np)); } else b = 0;
      }
      imag[n] = b;
    }
    w = new PeriodicWaveData(sampleRate, real, imag, false);
    basicCache.set(key, w);
    return w;
  }
  class PeriodicWave {
    constructor(context, options) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'PeriodicWave': 1 argument required, but only 0 present.");
      const eng = ctxArg(context, 'PeriodicWave');
      const o = options === undefined || options === null ? {} : options;
      const toArr = (v) => (v === undefined ? null : Float32Array.from(Array.from(v, Number)));
      let real = toArr(o.real), imag = toArr(o.imag);
      if (real === null && imag === null) { real = new Float32Array(2); imag = new Float32Array(2); imag[1] = 1; } else {
        if (real === null) real = new Float32Array(imag.length);
        if (imag === null) imag = new Float32Array(real.length);
      }
      if (real.length !== imag.length) throw new DOMException("Failed to construct 'PeriodicWave': The length of imag array (" + imag.length + ") and real array (" + real.length + ") must match.", 'IndexSizeError');
      if (real.length < 2) throw new DOMException(`Failed to construct 'PeriodicWave': The length of the real array (${real.length}) must be at least 2.`, 'IndexSizeError');
      real[0] = 0; imag[0] = 0; // DC is ignored
      PW.set(this, new PeriodicWaveData(eng.sampleRate, real, imag, !!o.disableNormalization));
    }
  }
  L.expose('PeriodicWave', PeriodicWave);

  const OscHandler = {
    process(rec, frames) {
      const out = rec.outputs[0];
      ensureBus(out.bus, 1, frames);
      const dest = out.bus[0];
      dest.fill(0);
      const st = rec.state;
      const [offset, count] = schedule(rec, frames);
      if (count <= 0) return;
      const wave = st.wave;
      const size = wave.size;
      const mask = size - 1;
      const rateScale = fr(wave.rateScale);
      const invSize = 1 / size;
      const freq = rec.pm.frequency, det = rec.pm.detune;
      let vri = st.vri;
      const sampleAccurate = freq.varies || det.varies;
      let lower = null, higher = null, tif = 0, incr = 0;
      if (!sampleAccurate) {
        let frequency = freq.buffer[0];
        const detune = det.buffer[0];
        frequency = fr(frequency * fr(Math.pow(2, fr(detune / 1200))));
        const d = wave.forFrequency(frequency);
        lower = d.lower; higher = d.higher; tif = d.factor;
        incr = fr(frequency * rateScale);
      }
      for (let n = 0; n < count; n++) {
        if (sampleAccurate) {
          const i = offset + n;
          const frequency = fr(freq.buffer[i] * fr(Math.pow(2, fr(det.buffer[i] / 1200))));
          const d = wave.forFrequency(frequency);
          lower = d.lower; higher = d.higher; tif = d.factor;
          incr = fr(frequency * rateScale);
        }
        const ri = Math.floor(vri);
        const frac = fr(vri - ri);
        const r1 = ri & mask, r2 = (ri + 1) & mask;
        const omf = fr(1 - frac);
        const sampleHigher = fr(fr(omf * higher[r1]) + fr(frac * higher[r2]));
        const sampleLower = fr(fr(omf * lower[r1]) + fr(frac * lower[r2]));
        dest[offset + n] = fr(fr(fr(1 - tif) * sampleHigher) + fr(tif * sampleLower));
        vri += incr;
        vri -= Math.floor(vri * invSize) * size;
      }
      st.vri = vri;
    },
  };
  const OSC_TYPES = ['sine', 'square', 'sawtooth', 'triangle', 'custom'];
  class OscillatorNode extends AudioScheduledSourceNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'OscillatorNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'OscillatorNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: OscHandler, kind: 'oscillator', inputs: 0, outputs: 1, channelCount: 2, mode: 'max', interp: 'speakers' });
      NODE.set(this, rec);
      rec.fixedChannels = false;
      rec.pm = addParams(rec, { frequency: [440, -eng.sampleRate / 2, eng.sampleRate / 2], detune: [0, -153600, 153600] });
      rec.pm.frequency.min = fr(-eng.sampleRate / 2); rec.pm.frequency.max = fr(eng.sampleRate / 2);
      rec.state.type = 'sine'; rec.state.wave = basicWave('sine', eng.sampleRate); rec.state.vri = 0;
      applyOptions(rec, options, 'OscillatorNode'); setParamOptions(rec.pm, options);
      if (options && options.type !== undefined) this.type = options.type;
      if (options && options.periodicWave !== undefined) this.setPeriodicWave(options.periodicWave);
    }
    get type() { return nd(this).state.type; }
    set type(v) {
      const r = nd(this);
      v = `${v}`;
      if (!OSC_TYPES.includes(v)) return;
      if (v === 'custom') throw new DOMException("Failed to set the 'type' property on 'OscillatorNode': 'type' cannot be set directly to 'custom'.  Use setPeriodicWave() to create a custom Oscillator type.", 'InvalidStateError');
      r.state.type = v; r.state.wave = basicWave(v, r.eng.sampleRate);
    }
    get frequency() { return nd(this).pm.frequency.wrapper; }
    get detune() { return nd(this).pm.detune.wrapper; }
    setPeriodicWave(periodicWave) {
      argc(1, arguments.length, 'OscillatorNode', 'setPeriodicWave');
      const r = nd(this);
      if (!(periodicWave instanceof PeriodicWave)) throw new TypeError("Failed to execute 'setPeriodicWave' on 'OscillatorNode': parameter 1 is not of type 'PeriodicWave'.");
      r.state.wave = pwOf(periodicWave); r.state.type = 'custom';
    }
  }
  L.expose('OscillatorNode', OscillatorNode);

  // ---------------------------------------------------------------------------------------
  // ConstantSourceNode
  // ---------------------------------------------------------------------------------------
  const ConstHandler = {
    process(rec, frames) {
      const out = rec.outputs[0];
      ensureBus(out.bus, 1, frames);
      const d = out.bus[0];
      d.fill(0);
      const [offset, count] = schedule(rec, frames);
      const off = rec.pm.offset.buffer;
      for (let i = 0; i < count; i++) d[offset + i] = off[offset + i];
    },
  };
  class ConstantSourceNode extends AudioScheduledSourceNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'ConstantSourceNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'ConstantSourceNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: ConstHandler, kind: 'constant', inputs: 0, outputs: 1, channelCount: 2, mode: 'max', interp: 'speakers' });
      NODE.set(this, rec);
      rec.pm = addParams(rec, { offset: [1, -FLT_MAX, FLT_MAX] });
      applyOptions(rec, options, 'ConstantSourceNode'); setParamOptions(rec.pm, options);
    }
    get offset() { return nd(this).pm.offset.wrapper; }
  }
  L.expose('ConstantSourceNode', ConstantSourceNode);

  // ---------------------------------------------------------------------------------------
  // AudioBufferSourceNode
  // ---------------------------------------------------------------------------------------
  const BufHandler = {
    process(rec, frames) {
      const out = rec.outputs[0];
      const st = rec.state;
      const buf = st.buffer ? bufOf(st.buffer) : null;
      ensureBus(out.bus, buf ? buf.channels.length : 1, frames);
      for (const c of out.bus) c.fill(0);
      if (!buf) { schedule(rec, frames); return; }
      const [offset, count] = schedule(rec, frames);
      if (count <= 0) return;
      const sr = rec.eng.sampleRate;
      const pr = rec.pm.playbackRate.buffer, dt = rec.pm.detune.buffer;
      const len = buf.length;
      let loopStart = 0, loopEnd = len;
      const useLoop = st.loop;
      if (useLoop) {
        const ls = st.loopStart, le = st.loopEnd;
        const dur = len / buf.sampleRate;
        if (le > 0 && ls >= 0 && le > ls) { loopStart = ls * buf.sampleRate; loopEnd = Math.min(le, dur) * buf.sampleRate; } else { loopStart = 0; loopEnd = len; }
      }
      const bufRate = buf.sampleRate / sr;
      if (!st.began2) { st.began2 = true; st.pos = (st.offset || 0) * buf.sampleRate; st.playedFrames = 0; }
      let pos = st.pos;
      const maxPlay = st.duration !== undefined ? st.duration * buf.sampleRate : Infinity;
      for (let n = 0; n < count; n++) {
        if (useLoop) { if (pos >= loopEnd) pos = loopStart + (pos - loopEnd); } else if (pos >= len) { finish(rec); st.done = true; break; }
        if (st.playedFrames >= maxPlay) { finish(rec); break; }
        if (pos < 0) { pos += 0; }
        const i0 = Math.floor(pos), frac = pos - i0;
        for (let c = 0; c < buf.channels.length; c++) {
          const ch = buf.channels[c];
          let i1 = i0 + 1;
          if (useLoop && i1 >= loopEnd) i1 = Math.max(0, Math.ceil(loopStart));
          const a0 = i0 >= 0 && i0 < len ? ch[i0] : 0, a1 = i1 >= 0 && i1 < len ? ch[i1] : (useLoop ? ch[Math.min(len - 1, 0)] : 0);
          out.bus[c][offset + n] = fr(a0 + (a1 - a0) * frac);
        }
        const rate = bufRate * pr[offset + n] * Math.pow(2, dt[offset + n] / 1200);
        pos += rate; st.playedFrames += Math.abs(rate);
      }
      st.pos = pos;
    },
  };
  class AudioBufferSourceNode extends AudioScheduledSourceNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'AudioBufferSourceNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'AudioBufferSourceNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: BufHandler, kind: 'buffersource', inputs: 0, outputs: 1, channelCount: 2, mode: 'max', interp: 'speakers' });
      NODE.set(this, rec);
      rec.pm = addParams(rec, { playbackRate: [1, -FLT_MAX, FLT_MAX], detune: [0, -FLT_MAX, FLT_MAX] });
      rec.state.loop = false; rec.state.loopStart = 0; rec.state.loopEnd = 0; rec.state.buffer = null;
      applyOptions(rec, options, 'AudioBufferSourceNode'); setParamOptions(rec.pm, options);
      if (options) {
        if (options.buffer !== undefined && options.buffer !== null) this.buffer = options.buffer;
        if (options.loop !== undefined) this.loop = options.loop;
        if (options.loopStart !== undefined) this.loopStart = options.loopStart;
        if (options.loopEnd !== undefined) this.loopEnd = options.loopEnd;
      }
    }
    get buffer() { return nd(this).state.buffer; }
    set buffer(v) {
      const r = nd(this);
      if (v !== null && !(v instanceof WA.AudioBuffer)) throw new TypeError("Failed to set the 'buffer' property on 'AudioBufferSourceNode': The provided value is not of type 'AudioBuffer'.");
      if (v !== null && r.state.buffer !== null && r.state.bufferSet) throw new DOMException("Failed to set the 'buffer' property on 'AudioBufferSourceNode': Cannot set buffer to non-null after it has been already been set to a non-null buffer", 'InvalidStateError');
      r.state.buffer = v; if (v !== null) r.state.bufferSet = true;
    }
    get playbackRate() { return nd(this).pm.playbackRate.wrapper; }
    get detune() { return nd(this).pm.detune.wrapper; }
    get loop() { return nd(this).state.loop; }
    set loop(v) { nd(this).state.loop = !!v; }
    get loopStart() { return nd(this).state.loopStart; }
    set loopStart(v) { nd(this).state.loopStart = Number(v) || 0; }
    get loopEnd() { return nd(this).state.loopEnd; }
    set loopEnd(v) { nd(this).state.loopEnd = Number(v) || 0; }
    start(when, offset, duration) {
      const r = nd(this);
      if (offset !== undefined && Number(offset) < 0) throw new RangeError(`Failed to execute 'start' on 'AudioBufferSourceNode': The offset provided (${offset}) is negative.`);
      if (duration !== undefined && Number(duration) < 0) throw new RangeError(`Failed to execute 'start' on 'AudioBufferSourceNode': The duration provided (${duration}) is negative.`);
      AudioScheduledSourceNode.prototype.start.call(this, when);
      r.state.offset = offset === undefined ? 0 : Number(offset);
      if (duration !== undefined) r.state.duration = Number(duration);
    }
  }
  L.expose('AudioBufferSourceNode', AudioBufferSourceNode);

  // ---------------------------------------------------------------------------------------
  // DelayNode
  // ---------------------------------------------------------------------------------------
  const DelayHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      const st = rec.state;
      const ch = inp.length;
      ensureBus(out.bus, ch, frames);
      const size = st.size;
      while (st.rings.length < ch) st.rings.push(new Float32Array(size));
      const dtBuf = rec.pm.delayTime.buffer;
      const sr = rec.eng.sampleRate;
      for (let c = 0; c < ch; c++) {
        const ring = st.rings[c], s = inp[c], d = out.bus[c];
        let w = st.write;
        for (let i = 0; i < frames; i++) {
          ring[w] = s[i];
          let delay = Math.min(dtBuf[i], st.maxDelay) * sr;
          if (delay < 0) delay = 0;
          let rp = w - delay;
          while (rp < 0) rp += size;
          const i0 = Math.floor(rp), f = rp - i0;
          const a = ring[i0 % size], b = ring[(i0 + 1) % size];
          d[i] = fr(a + (b - a) * f);
          w = (w + 1) % size;
        }
        if (c === ch - 1) st.write = w;
      }
    },
  };
  class DelayNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'DelayNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'DelayNode');
      super(INTERNAL);
      const maxDelay = options && options.maxDelayTime !== undefined ? Number(options.maxDelayTime) : 1;
      if (!(maxDelay > 0 && maxDelay < 180)) throw new DOMException(`Failed to construct 'DelayNode': The max delay time provided (${maxDelay}) is outside the range (0, 180).`, 'NotSupportedError');
      const rec = newNodeRec(eng, this, { handler: DelayHandler, kind: 'delay', inputs: 1, outputs: 1, channelCount: 2, mode: 'max', interp: 'speakers' });
      NODE.set(this, rec);
      rec.pm = addParams(rec, { delayTime: [0, 0, maxDelay] });
      rec.state.maxDelay = maxDelay; rec.state.size = Math.ceil(maxDelay * eng.sampleRate) + QUANTUM + 2; rec.state.rings = []; rec.state.write = 0;
      applyOptions(rec, options, 'DelayNode'); setParamOptions(rec.pm, options);
    }
    get delayTime() { return nd(this).pm.delayTime.wrapper; }
  }
  L.expose('DelayNode', DelayNode);

  // ---------------------------------------------------------------------------------------
  // StereoPannerNode
  // ---------------------------------------------------------------------------------------
  const PanHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      ensureBus(out.bus, 2, frames);
      const pan = rec.pm.pan.buffer;
      const L_ = out.bus[0], R_ = out.bus[1];
      const half = Math.PI / 2;
      if (inp.length === 1) {
        const s = inp[0];
        for (let i = 0; i < frames; i++) { const x = (Math.max(-1, Math.min(1, pan[i])) + 1) / 2; L_[i] = fr(s[i] * Math.cos(x * half)); R_[i] = fr(s[i] * Math.sin(x * half)); }
      } else {
        const l = inp[0], r = inp[1] || inp[0];
        for (let i = 0; i < frames; i++) {
          const p = Math.max(-1, Math.min(1, pan[i]));
          if (p <= 0) { const x = p + 1; L_[i] = fr(l[i] + r[i] * Math.cos(x * half)); R_[i] = fr(r[i] * Math.sin(x * half)); } else { const x = p; L_[i] = fr(l[i] * Math.cos(x * half)); R_[i] = fr(r[i] + l[i] * Math.sin(x * half)); }
        }
      }
    },
  };
  class StereoPannerNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'StereoPannerNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'StereoPannerNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: PanHandler, kind: 'panner', inputs: 1, outputs: 1, channelCount: 2, mode: 'clamped-max', interp: 'speakers', outputChannels: 2 });
      rec.forbidMode = 'max'; rec.forbidModeMessage = "StereoPannerNode: channelCountMode cannot be set to 'max'"; rec.maxChannelCount = 2;
      NODE.set(this, rec);
      rec.pm = addParams(rec, { pan: [0, -1, 1] });
      applyOptions(rec, options, 'StereoPannerNode'); setParamOptions(rec.pm, options);
    }
    get pan() { return nd(this).pm.pan.wrapper; }
  }
  L.expose('StereoPannerNode', StereoPannerNode);

  // ---------------------------------------------------------------------------------------
  // ChannelSplitterNode / ChannelMergerNode
  // ---------------------------------------------------------------------------------------
  const SplitHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus;
      rec.outputs.forEach((out, k) => { ensureBus(out.bus, 1, frames); if (k < inp.length) out.bus[0].set(inp[k]); else out.bus[0].fill(0); });
    },
  };
  class ChannelSplitterNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'ChannelSplitterNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'ChannelSplitterNode');
      super(INTERNAL);
      const n = options && options.numberOfOutputs !== undefined ? options.numberOfOutputs >>> 0 : 6;
      if (n < 1 || n > 32) throw new DOMException(`Failed to construct 'ChannelSplitterNode': The number of outputs provided (${n}) is outside the range [1, 32].`, 'IndexSizeError');
      const rec = newNodeRec(eng, this, { handler: SplitHandler, kind: 'splitter', inputs: 1, outputs: n, channelCount: n, mode: 'explicit', interp: 'discrete' });
      rec.fixedMode = 'explicit'; rec.fixedModeMessage = 'ChannelSplitterNode: channelCountMode cannot be changed from explicit'; rec.fixedInterp = 'discrete';
      NODE.set(this, rec);
      applyOptions(rec, options, 'ChannelSplitterNode');
    }
  }
  L.expose('ChannelSplitterNode', ChannelSplitterNode);
  const MergeHandler = {
    process(rec, frames) {
      const out = rec.outputs[0];
      ensureBus(out.bus, rec.inputs.length, frames);
      rec.inputs.forEach((inp, k) => { const b = inp.bus; if (b.length && inp.connected) { const mono = [out.bus[k]]; mono[0].fill(0); WA.mixAdd(mono, b, 'speakers', frames); } else out.bus[k].fill(0); });
    },
  };
  class ChannelMergerNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'ChannelMergerNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'ChannelMergerNode');
      super(INTERNAL);
      const n = options && options.numberOfInputs !== undefined ? options.numberOfInputs >>> 0 : 6;
      if (n < 1 || n > 32) throw new DOMException(`Failed to construct 'ChannelMergerNode': The number of inputs provided (${n}) is outside the range [1, 32].`, 'IndexSizeError');
      const rec = newNodeRec(eng, this, { handler: MergeHandler, kind: 'merger', inputs: n, outputs: 1, channelCount: 1, mode: 'explicit', interp: 'speakers', outputChannels: n });
      rec.fixedMode = 'explicit'; rec.fixedModeMessage = 'ChannelMergerNode: channelCountMode cannot be changed from explicit'; rec.fixedChannels = 'ChannelMergerNode: channelCount cannot be changed from 1';
      NODE.set(this, rec);
      applyOptions(rec, options, 'ChannelMergerNode');
    }
  }
  L.expose('ChannelMergerNode', ChannelMergerNode);

  // ---------------------------------------------------------------------------------------
  // WaveShaperNode (oversampling is not applied: 'none' semantics for every setting)
  // ---------------------------------------------------------------------------------------
  const ShaperHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      ensureBus(out.bus, inp.length, frames);
      const curve = rec.state.curve;
      for (let c = 0; c < inp.length; c++) {
        const s = inp[c], d = out.bus[c];
        if (!curve) { d.set(s); continue; }
        const n = curve.length;
        for (let i = 0; i < frames; i++) {
          const v = (n - 1) / 2 * (s[i] + 1);
          if (v <= 0) d[i] = curve[0]; else if (v >= n - 1) d[i] = curve[n - 1]; else { const k = Math.floor(v), f = v - k; d[i] = fr(curve[k] + (curve[k + 1] - curve[k]) * f); }
        }
      }
    },
  };
  class WaveShaperNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'WaveShaperNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'WaveShaperNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: ShaperHandler, kind: 'shaper', inputs: 1, outputs: 1, channelCount: 2, mode: 'max', interp: 'speakers' });
      NODE.set(this, rec);
      rec.state.curve = null; rec.state.curveArr = null; rec.state.oversample = 'none';
      applyOptions(rec, options, 'WaveShaperNode');
      if (options && options.curve !== undefined) this.curve = options.curve;
      if (options && options.oversample !== undefined) this.oversample = options.oversample;
    }
    get curve() { return nd(this).state.curveArr; }
    set curve(v) {
      const r = nd(this);
      if (v === null || v === undefined) { r.state.curve = null; r.state.curveArr = null; return; }
      if (!(v instanceof Float32Array)) throw new TypeError("Failed to set the 'curve' property on 'WaveShaperNode': The provided value is not of type 'Float32Array'.");
      if (v.length < 2) throw new DOMException("Failed to set the 'curve' property on 'WaveShaperNode': The curve length provided (" + v.length + ") is less than the minimum bound (2).", 'InvalidStateError');
      if (r.state.curveArr !== null) throw new DOMException("Failed to set the 'curve' property on 'WaveShaperNode': The curve has already been set.", 'InvalidStateError');
      r.state.curve = Float32Array.from(v); r.state.curveArr = v;
    }
    get oversample() { return nd(this).state.oversample; }
    set oversample(v) { v = `${v}`; if (['none', '2x', '4x'].includes(v)) nd(this).state.oversample = v; }
  }
  L.expose('WaveShaperNode', WaveShaperNode);

  // ---------------------------------------------------------------------------------------
  // AnalyserNode (Blink's RealtimeAnalyser)
  // ---------------------------------------------------------------------------------------
  const ANALYSER_RING = 32768 * 2;
  const AnalyserHandler = {
    process(rec, frames) {
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      const st = rec.state;
      ensureBus(out.bus, inp.length, frames);
      for (let c = 0; c < inp.length; c++) out.bus[c].set(inp[c]);
      // down-mix to mono and write into the ring
      const mono = st.mono;
      mono.fill(0);
      WA.mixAdd([mono], inp, 'speakers', frames);
      let w = st.write;
      for (let i = 0; i < frames; i++) { st.ring[w] = mono[i]; w = (w + 1) % ANALYSER_RING; }
      st.write = w;
      st.dirty = true;
    },
  };
  const analyse = (rec) => {
    const st = rec.state;
    const N = st.fftSize;
    const re = new Float64Array(N), im = new Float64Array(N);
    const a0 = 0.5 * (1 - 0.16), a1 = 0.5, a2 = 0.5 * 0.16;
    let start = st.write - N; while (start < 0) start += ANALYSER_RING;
    for (let i = 0; i < N; i++) {
      const w = a0 - a1 * Math.cos(2 * Math.PI * i / N) + a2 * Math.cos(4 * Math.PI * i / N);
      re[i] = st.ring[(start + i) % ANALYSER_RING] * w;
    }
    WA.fft(re, im, false);
    const half = N / 2;
    const scale = 1 / N;
    const sm = st.smoothing;
    if (st.mag.length !== half) st.mag = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      const m = Math.hypot(re[k], im[k]) * scale;
      st.mag[k] = fr(sm * st.mag[k] + (1 - sm) * m);
      if (!Number.isFinite(st.mag[k])) st.mag[k] = 0;
    }
  };
  class AnalyserNode extends AudioNode {
    constructor(context, options) {
      const eng = arguments.length < 1 ? (() => { throw new TypeError("Failed to construct 'AnalyserNode': 1 argument required, but only 0 present."); })() : ctxArg(context, 'AnalyserNode');
      super(INTERNAL);
      const rec = newNodeRec(eng, this, { handler: AnalyserHandler, kind: 'analyser', inputs: 1, outputs: 1, channelCount: 2, mode: 'max', interp: 'speakers' });
      NODE.set(this, rec);
      Object.assign(rec.state, { fftSize: 2048, minDb: -100, maxDb: -30, smoothing: 0.8, ring: new Float32Array(ANALYSER_RING), write: 0, mono: new Float32Array(QUANTUM), mag: new Float32Array(1024) });
      applyOptions(rec, options, 'AnalyserNode');
      if (options) {
        if (options.fftSize !== undefined) this.fftSize = options.fftSize;
        if (options.minDecibels !== undefined) this.minDecibels = options.minDecibels;
        if (options.maxDecibels !== undefined) this.maxDecibels = options.maxDecibels;
        if (options.smoothingTimeConstant !== undefined) this.smoothingTimeConstant = options.smoothingTimeConstant;
      }
      eng.autoPull.add(rec);
    }
    get fftSize() { return nd(this).state.fftSize; }
    set fftSize(v) {
      const n = v >>> 0;
      if (n < 32 || n > 32768 || (n & (n - 1)) !== 0) throw new DOMException(`Failed to set the 'fftSize' property on 'AnalyserNode': The value provided (${n}) is not a power of two.`, 'IndexSizeError');
      const st = nd(this).state;
      if (st.fftSize !== n) { st.fftSize = n; st.mag = new Float32Array(n / 2); }
    }
    get frequencyBinCount() { return nd(this).state.fftSize / 2; }
    get minDecibels() { return nd(this).state.minDb; }
    set minDecibels(v) {
      const st = nd(this).state; const n = Number(v);
      if (!(n < st.maxDb)) throw new DOMException(`Failed to set the 'minDecibels' property on 'AnalyserNode': The minDecibels provided (${n}) is greater than the maximum bound (${st.maxDb}).`, 'IndexSizeError');
      st.minDb = n;
    }
    get maxDecibels() { return nd(this).state.maxDb; }
    set maxDecibels(v) {
      const st = nd(this).state; const n = Number(v);
      if (!(n > st.minDb)) throw new DOMException(`Failed to set the 'maxDecibels' property on 'AnalyserNode': The maxDecibels provided (${n}) is less than the minimum bound (${st.minDb}).`, 'IndexSizeError');
      st.maxDb = n;
    }
    get smoothingTimeConstant() { return nd(this).state.smoothing; }
    set smoothingTimeConstant(v) {
      const n = Number(v);
      if (!(n >= 0 && n <= 1)) throw new DOMException(`Failed to set the 'smoothingTimeConstant' property on 'AnalyserNode': The smoothing value provided (${n}) is outside the range [0, 1].`, 'IndexSizeError');
      nd(this).state.smoothing = n;
    }
    getFloatFrequencyData(array) {
      argc(1, arguments.length, 'AnalyserNode', 'getFloatFrequencyData');
      if (!(array instanceof Float32Array)) throw new TypeError("Failed to execute 'getFloatFrequencyData' on 'AnalyserNode': parameter 1 is not of type 'Float32Array'.");
      const r = nd(this); analyse(r);
      const n = Math.min(array.length, r.state.mag.length);
      for (let i = 0; i < n; i++) array[i] = fr(20 * Math.log10(r.state.mag[i]));
    }
    getByteFrequencyData(array) {
      argc(1, arguments.length, 'AnalyserNode', 'getByteFrequencyData');
      if (!(array instanceof Uint8Array || array instanceof Uint8ClampedArray)) throw new TypeError("Failed to execute 'getByteFrequencyData' on 'AnalyserNode': parameter 1 is not of type 'Uint8Array'.");
      const r = nd(this); analyse(r);
      const { minDb, maxDb, mag } = r.state;
      const range = maxDb - minDb;
      const n = Math.min(array.length, mag.length);
      for (let i = 0; i < n; i++) {
        const db = 20 * Math.log10(mag[i]);
        const scaled = (255 / range) * (db - minDb);
        array[i] = Number.isNaN(scaled) ? 0 : Math.max(0, Math.min(255, scaled));
      }
    }
    getFloatTimeDomainData(array) {
      argc(1, arguments.length, 'AnalyserNode', 'getFloatTimeDomainData');
      if (!(array instanceof Float32Array)) throw new TypeError("Failed to execute 'getFloatTimeDomainData' on 'AnalyserNode': parameter 1 is not of type 'Float32Array'.");
      const st = nd(this).state;
      const n = Math.min(array.length, st.fftSize);
      let start = st.write - st.fftSize; while (start < 0) start += ANALYSER_RING;
      for (let i = 0; i < n; i++) array[i] = st.ring[(start + i) % ANALYSER_RING];
    }
    getByteTimeDomainData(array) {
      argc(1, arguments.length, 'AnalyserNode', 'getByteTimeDomainData');
      if (!(array instanceof Uint8Array || array instanceof Uint8ClampedArray)) throw new TypeError("Failed to execute 'getByteTimeDomainData' on 'AnalyserNode': parameter 1 is not of type 'Uint8Array'.");
      const st = nd(this).state;
      const n = Math.min(array.length, st.fftSize);
      let start = st.write - st.fftSize; while (start < 0) start += ANALYSER_RING;
      for (let i = 0; i < n; i++) { const v = 128 * (st.ring[(start + i) % ANALYSER_RING] + 1); array[i] = Math.max(0, Math.min(255, v)); }
    }
  }
  L.expose('AnalyserNode', AnalyserNode);

  // ---------------------------------------------------------------------------------------
  // ScriptProcessorNode
  // ---------------------------------------------------------------------------------------
  class AudioProcessingEvent extends L.Event {
    #pt; #ib; #ob;
    constructor(type, init) {
      if (arguments.length < 2) throw new TypeError("Failed to construct 'AudioProcessingEvent': 2 arguments required, but only " + arguments.length + ' present.');
      super(type);
      this.#pt = Number(init.playbackTime); this.#ib = init.inputBuffer; this.#ob = init.outputBuffer;
    }
    get playbackTime() { return this.#pt; }
    get inputBuffer() { return this.#ib; }
    get outputBuffer() { return this.#ob; }
  }
  L.expose('AudioProcessingEvent', AudioProcessingEvent);
  const SPHandler = {
    process(rec, frames) {
      const st = rec.state;
      const inp = rec.inputs[0].bus, out = rec.outputs[0];
      ensureBus(out.bus, st.outCh, frames);
      for (let c = 0; c < st.outCh; c++) { const src = st.outBuf ? st.outBuf[c] : null; for (let i = 0; i < frames; i++) out.bus[c][i] = src ? src[st.fill + i] : 0; }
      for (let c = 0; c < st.inCh; c++) { const s = inp[Math.min(c, inp.length - 1)]; if (s) st.inBuf[c].set(s, st.fill); }
      st.fill += frames;
      if (st.fill >= st.bufferSize) {
        const inputBuffer = makeBuffer(st.inCh, st.bufferSize, rec.eng.sampleRate);
        st.inBuf.forEach((b, c) => bufOf(inputBuffer).channels[c].set(b));
        const outputBuffer = makeBuffer(st.outCh, st.bufferSize, rec.eng.sampleRate);
        const playbackTime = (rec.eng.frame + frames) / rec.eng.sampleRate + st.bufferSize / rec.eng.sampleRate;
        st.fill = 0;
        // the output of the previous event plays while this one is processed
        const pending = outputBuffer;
        L.postTask(() => {
          const ev = new AudioProcessingEvent('audioprocess', { playbackTime, inputBuffer, outputBuffer: pending });
          rec.wrapper.dispatchEvent(ev);
          st.next = bufOf(pending).channels;
        });
        if (st.next) { st.outBuf = st.next; st.next = null; } else st.outBuf = null;
      }
    },
  };
  class ScriptProcessorNode extends AudioNode {
    constructor(token, eng, bufferSize, inCh, outCh) {
      super(token);
      const rec = newNodeRec(eng, this, { handler: SPHandler, kind: 'scriptprocessor', inputs: 1, outputs: 1, channelCount: inCh, mode: 'explicit', interp: 'speakers', outputChannels: outCh });
      rec.fixedMode = 'explicit'; rec.fixedModeMessage = 'ScriptProcessorNode: channelCountMode cannot be changed from explicit'; rec.fixedChannels = 'ScriptProcessorNode: channelCount cannot be changed from the number of input channels';
      NODE.set(this, rec);
      Object.assign(rec.state, { bufferSize, inCh, outCh, inBuf: Array.from({ length: inCh }, () => new Float32Array(bufferSize)), fill: 0, outBuf: null, next: null });
      eng.autoPull.add(rec);
    }
    get bufferSize() { return nd(this).state.bufferSize; }
  }
  L.defineEventHandlers(ScriptProcessorNode.prototype, ['onaudioprocess']);
  L.expose('ScriptProcessorNode', ScriptProcessorNode);

  // ---------------------------------------------------------------------------------------
  // AudioListener
  // ---------------------------------------------------------------------------------------
  const LISTENER = new WeakMap();
  class AudioListener {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    setPosition(x, y, z) { argc(3, arguments.length, 'AudioListener', 'setPosition'); const p = LISTENER.get(this); p.positionX.wrapper.value = x; p.positionY.wrapper.value = y; p.positionZ.wrapper.value = z; }
    setOrientation(x, y, z, xUp, yUp, zUp) {
      argc(6, arguments.length, 'AudioListener', 'setOrientation');
      const p = LISTENER.get(this);
      p.forwardX.wrapper.value = x; p.forwardY.wrapper.value = y; p.forwardZ.wrapper.value = z; p.upX.wrapper.value = xUp; p.upY.wrapper.value = yUp; p.upZ.wrapper.value = zUp;
    }
  }
  for (const k of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) Object.defineProperty(AudioListener.prototype, k, { get() { return LISTENER.get(this)[k].wrapper; }, enumerable: true, configurable: true });
  L.expose('AudioListener', AudioListener);
  WA.listenerParams = function listenerParams(eng) {
    const params = LISTENER.get(eng.listener);
    for (const p of Object.values(params)) if (p.lastQuantum !== eng.quantumId) { WA.computeParam(p, eng.frame, QUANTUM, eng.sampleRate); p.lastQuantum = eng.quantumId; }
    return params;
  };
  function makeListener(eng) {
    const l = Object.create(AudioListener.prototype);
    const defs = { positionX: 0, positionY: 0, positionZ: 0, forwardX: 0, forwardY: 0, forwardZ: -1, upX: 0, upY: 1, upZ: 0 };
    const params = {};
    for (const [k, v] of Object.entries(defs)) params[k] = newParam(eng, null, k, v, -FLT_MAX, FLT_MAX, {});
    LISTENER.set(l, params);
    return l;
  }

  // ---------------------------------------------------------------------------------------
  // Contexts
  // ---------------------------------------------------------------------------------------
  const BASE_FACTORIES = {
    createGain: () => GainNode, createOscillator: () => OscillatorNode, createConstantSource: () => ConstantSourceNode, createBufferSource: () => AudioBufferSourceNode,
    createDelay: () => DelayNode, createStereoPanner: () => StereoPannerNode, createChannelSplitter: () => ChannelSplitterNode, createChannelMerger: () => ChannelMergerNode,
    createWaveShaper: () => WaveShaperNode, createPanner: () => WA.PannerNode, createConvolver: () => WA.ConvolverNode, createAnalyser: () => AnalyserNode, createDynamicsCompressor: () => WA.DynamicsCompressorNode, createBiquadFilter: () => WA.BiquadFilterNode,
  };
  function defineFactories() {
    for (const [name, ctorOf] of Object.entries(BASE_FACTORIES)) {
      const fn = {
        [name](...args) {
          cx(this);
          const C = ctorOf();
          try {
            if (name === 'createDelay') return new C(this, { maxDelayTime: args[0] === undefined ? 1 : args[0] });
            if (name === 'createChannelSplitter') return new C(this, { numberOfOutputs: args[0] === undefined ? 6 : args[0] });
            if (name === 'createChannelMerger') return new C(this, { numberOfInputs: args[0] === undefined ? 6 : args[0] });
            return new C(this);
          } catch (e) {
            // errors of the factory methods name the factory, not the constructor
            if (e instanceof DOMException && e.message.startsWith("Failed to construct '")) throw new DOMException(e.message.replace(/^Failed to construct '\w+'/, `Failed to execute '${name}' on 'BaseAudioContext'`), e.name);
            throw e;
          }
        },
      }[name];
      Object.defineProperty(BaseAudioContext.prototype, name, { value: fn, writable: true, enumerable: true, configurable: true });
    }
    Object.defineProperty(BaseAudioContext.prototype, 'createPeriodicWave', { value: function createPeriodicWave(real, imag, constraints) {
      argc(2, arguments.length, 'BaseAudioContext', 'createPeriodicWave');
      cx(this);
      return new PeriodicWave(this, { real, imag, disableNormalization: constraints ? !!constraints.disableNormalization : false });
    }, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(BaseAudioContext.prototype, 'createScriptProcessor', { value: function createScriptProcessor(bufferSize, inCh, outCh) {
      const eng = cx(this);
      const bs = bufferSize === undefined ? 0 : bufferSize >>> 0;
      const ic = inCh === undefined ? 2 : inCh >>> 0, oc = outCh === undefined ? 2 : outCh >>> 0;
      if (![0, 256, 512, 1024, 2048, 4096, 8192, 16384].includes(bs)) throw new DOMException(`Failed to execute 'createScriptProcessor' on 'BaseAudioContext': buffer size (${bs}) must be 0 or a power of two between 256 and 16384.`, 'IndexSizeError');
      if (ic === 0 && oc === 0) throw new DOMException("Failed to execute 'createScriptProcessor' on 'BaseAudioContext': number of input channels and output channels cannot both be zero.", 'IndexSizeError');
      if (ic > 32 || oc > 32) throw new DOMException(`Failed to execute 'createScriptProcessor' on 'BaseAudioContext': ${ic > 32 ? 'number of input channels' : 'number of output channels'} (${Math.max(ic, oc)}) exceeds maximum (32).`, 'IndexSizeError');
      return new ScriptProcessorNode(INTERNAL, eng, bs === 0 ? 4096 : bs, ic, oc);
    }, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(BaseAudioContext.prototype, 'createIIRFilter', { value: function createIIRFilter(feedforward, feedback) {
      argc(2, arguments.length, 'BaseAudioContext', 'createIIRFilter');
      cx(this);
      return new WA.IIRFilterNode(this, { feedforward, feedback });
    }, writable: true, enumerable: true, configurable: true });
  }

  function buildEngine(wrapper, sampleRate, offline, destChannels, maxChannels) {
    const eng = WA.newEngine(wrapper, sampleRate, offline);
    CTX.set(wrapper, eng);
    eng.destination = makeDestination(eng, destChannels, maxChannels, !offline);
    eng.listener = makeListener(eng);
    return eng;
  }

  class AudioContext extends BaseAudioContext {
    constructor(contextOptions) {
      super(INTERNAL);
      const o = contextOptions === undefined || contextOptions === null ? {} : contextOptions;
      if (typeof o !== 'object') throw new TypeError("Failed to construct 'AudioContext': The provided value is not of type 'AudioContextOptions'.");
      let sr = 48000;
      if (o.sampleRate !== undefined) {
        sr = Number(o.sampleRate);
        if (!(sr >= 3000 && sr <= 768000)) throw new DOMException(`Failed to construct 'AudioContext': The hardware sample rate provided (${sr}) is outside the range [3000, 768000].`, 'NotSupportedError');
      }
      if (o.latencyHint !== undefined && typeof o.latencyHint !== 'number' && !['interactive', 'balanced', 'playback'].includes(`${o.latencyHint}`)) throw new TypeError(`Failed to construct 'AudioContext': The provided value '${o.latencyHint}' is not a valid enum value of type AudioContextLatencyCategory.`);
      const eng = buildEngine(this, sr, false, 2, 2);
      eng.latency = typeof o.latencyHint === 'number' ? o.latencyHint : 0.01;
      // the autoplay policy: a context created after a user gesture starts running
      if (WA.activated()) L.postTask(() => { if (eng.state === 'suspended' && !eng.closed && !eng.userSuspended) WA.startRealtime(eng); });
    }
    get baseLatency() { return cx(this).latency; }
    get outputLatency() { cx(this); return 0; }
    getOutputTimestamp() { const e = cx(this); return { contextTime: e.frame / e.sampleRate, performanceTime: L.performance.now() }; }
    resume() {
      const e = cx(this);
      if (e.closed) return L.rejectedPromise(new DOMException("Failed to execute 'resume' on 'AudioContext': Cannot resume a closed AudioContext", 'InvalidStateError'));
      e.userSuspended = false;
      if (e.state === 'running') return L.resolvedPromise(undefined);
      return new L.Promise((resolve) => {
        const attempt = () => {
          if (e.closed) { resolve(undefined); return; }
          if (e.userSuspended) { resolve(undefined); return; }
          if (WA.activated()) { WA.startRealtime(e); L.postTask(() => resolve(undefined)); } else L.internalTimeout(attempt, 100);
        };
        attempt();
      });
    }
    suspend() {
      const e = cx(this);
      if (e.closed) return L.rejectedPromise(new DOMException("Failed to execute 'suspend' on 'AudioContext': Cannot suspend a closed AudioContext", 'InvalidStateError'));
      e.userSuspended = true;
      if (e.timer) { L.clearInternalTimeout(e.timer); e.timer = 0; }
      WA.setState(e, 'suspended');
      return L.resolvedPromise(undefined);
    }
    close() {
      const e = cx(this);
      if (e.closed) return L.rejectedPromise(new DOMException("Failed to execute 'close' on 'AudioContext': Cannot close a context that is being closed or has already been closed.", 'InvalidStateError'));
      e.closed = true;
      if (e.timer) { L.clearInternalTimeout(e.timer); e.timer = 0; }
      WA.setState(e, 'closed');
      return L.resolvedPromise(undefined);
    }
  }
  L.defineEventHandlers(AudioContext.prototype, ['onerror']);
  L.expose('AudioContext', AudioContext);

  class OfflineAudioCompletionEvent extends L.Event {
    #buf;
    constructor(type, init) {
      if (arguments.length < 2) throw new TypeError(`Failed to construct 'OfflineAudioCompletionEvent': 2 arguments required, but only ${arguments.length} present.`);
      super(type, init);
      if (init === null || typeof init !== 'object' || init.renderedBuffer === undefined) throw new TypeError("Failed to construct 'OfflineAudioCompletionEvent': Failed to read the 'renderedBuffer' property from 'OfflineAudioCompletionEventInit': Required member is undefined.");
      this.#buf = init.renderedBuffer;
    }
    get renderedBuffer() { return this.#buf; }
  }
  L.expose('OfflineAudioCompletionEvent', OfflineAudioCompletionEvent);

  const OFF = new WeakMap();
  class OfflineAudioContext extends BaseAudioContext {
    constructor(a, b, c) {
      super(INTERNAL);
      let ch, length, sr;
      if (arguments.length === 1 && a !== null && typeof a === 'object') { ch = a.numberOfChannels === undefined ? 1 : a.numberOfChannels >>> 0; length = a.length === undefined ? (() => { throw new TypeError("Failed to construct 'OfflineAudioContext': Failed to read the 'length' property from 'OfflineAudioContextOptions': Required member is undefined."); })() >>> 0 : a.length >>> 0; sr = a.sampleRate === undefined ? (() => { throw new TypeError("Failed to construct 'OfflineAudioContext': Failed to read the 'sampleRate' property from 'OfflineAudioContextOptions': Required member is undefined."); })() : Number(a.sampleRate); } else {
        if (arguments.length < 3) throw new TypeError(`Failed to construct 'OfflineAudioContext': 3 arguments required, but only ${arguments.length} present.`);
        ch = a >>> 0; length = b >>> 0; sr = Number(c);
      }
      const prefix = "Failed to construct 'OfflineAudioContext'";
      if (ch < 1 || ch > 32) throw new DOMException(`${prefix}: The number of channels provided (${ch}) is outside the range [1, 32].`, 'NotSupportedError');
      if (length < 1) throw new DOMException(`${prefix}: The number of frames provided (${length}) is less than the minimum bound (1).`, 'NotSupportedError');
      if (!(sr >= 3000 && sr <= 768000)) throw new DOMException(`${prefix}: The sampleRate provided (${sr}) is outside the range [3000, 768000].`, 'NotSupportedError');
      sr = fr(sr);
      const eng = buildEngine(this, sr, true, ch, ch);
      OFF.set(this, { eng, length, channels: ch, started: false, result: null, resolve: null, suspends: [] });
    }
    get length() { return OFF.get(this).length; }
    startRendering() {
      const o = OFF.get(this);
      if (o === undefined) throw new TypeError('Illegal invocation');
      if (o.started) return L.rejectedPromise(new DOMException("Failed to execute 'startRendering' on 'OfflineAudioContext': cannot call startRendering on an OfflineAudioContext in a stopped state.", 'InvalidStateError'));
      o.started = true;
      const eng = o.eng;
      o.result = makeBuffer(o.channels, o.length, eng.sampleRate);
      WA.setState(eng, 'running');
      return new L.Promise((resolve) => {
        o.resolve = resolve;
        const wrapper = this;
        const total = Math.ceil(o.length / QUANTUM);
        let done = 0;
        const out = bufOf(o.result).channels;
        const step = () => {
          let n = 0;
          while (done < total && n < 2000) {
            // suspensions fire at quantum boundaries
            const susp = o.suspends.find((s) => !s.fired && s.frame <= done * QUANTUM);
            if (susp) { susp.fired = true; o.paused = () => { o.paused = null; L.postTask(step); }; WA.setState(eng, 'suspended'); susp.resolve(undefined); return; }
            WA.renderQuantum(eng);
            // the destination's input holds the mix
            const bus = eng.destination.inputs[0].bus;
            const f0 = done * QUANTUM;
            const cnt = Math.min(QUANTUM, o.length - f0);
            for (let c = 0; c < o.channels; c++) if (bus[c]) out[c].set(bus[c].subarray(0, cnt), f0);
            done++; n++;
          }
          if (done < total) { L.postTask(step); return; }
          WA.setState(eng, 'closed');
          L.postTask(() => {
            resolve(o.result);
            const ev = new OfflineAudioCompletionEvent('complete', { renderedBuffer: o.result });
            wrapper.dispatchEvent(ev);
          });
        };
        L.postTask(step);
      });
    }
    suspend(suspendTime) {
      argc(1, arguments.length, 'OfflineAudioContext', 'suspend');
      const o = OFF.get(this);
      if (o === undefined) throw new TypeError('Illegal invocation');
      const t = Number(suspendTime);
      if (!Number.isFinite(t)) return L.rejectedPromise(new TypeError("Failed to execute 'suspend' on 'OfflineAudioContext': The provided double value is non-finite."));
      if (t < 0) return L.rejectedPromise(new DOMException(`Failed to execute 'suspend' on 'OfflineAudioContext': negative suspend time (${t}) is not allowed`, 'InvalidStateError'));
      const eng = o.eng;
      if (o.started && eng.state === 'closed') return L.rejectedPromise(new DOMException("Failed to execute 'suspend' on 'OfflineAudioContext': the rendering is already finished", 'InvalidStateError'));
      const frame = Math.ceil(t * eng.sampleRate / QUANTUM) * QUANTUM;
      if (t > o.length / eng.sampleRate) return L.rejectedPromise(new DOMException(`Failed to execute 'suspend' on 'OfflineAudioContext': suspend time (${t}) is greater than total rendering duration (${o.length / eng.sampleRate})`, 'InvalidStateError'));
      if (frame < eng.frame || (o.started && frame <= eng.frame && !o.paused)) return L.rejectedPromise(new DOMException(`Failed to execute 'suspend' on 'OfflineAudioContext': suspend(${t}) failed to suspend at frame ${frame} because it is earlier than the current frame of ${eng.frame}`, 'InvalidStateError'));
      if (o.suspends.some((s) => s.frame === frame)) return L.rejectedPromise(new DOMException(`Failed to execute 'suspend' on 'OfflineAudioContext': cannot schedule more than one suspend at frame ${frame}`, 'InvalidStateError'));
      return new L.Promise((resolve) => { o.suspends.push({ frame, resolve, fired: false }); });
    }
    resume() {
      const o = OFF.get(this);
      if (o === undefined) throw new TypeError('Illegal invocation');
      if (!o.started) return L.rejectedPromise(new DOMException("Failed to execute 'resume' on 'OfflineAudioContext': cannot resume a context that has not started", 'InvalidStateError'));
      if (o.eng.state === 'closed') return L.rejectedPromise(new DOMException("Failed to execute 'resume' on 'OfflineAudioContext': cannot resume a closed context", 'InvalidStateError'));
      if (o.eng.state === 'suspended' && o.paused) { WA.setState(o.eng, 'running'); o.paused(); }
      return L.resolvedPromise(undefined);
    }
  }
  L.defineEventHandlers(OfflineAudioContext.prototype, ['oncomplete']);
  L.expose('OfflineAudioContext', OfflineAudioContext);

  WA.AudioContext = AudioContext; WA.OfflineAudioContext = OfflineAudioContext;
  WA.GainNode = GainNode; WA.OscillatorNode = OscillatorNode; WA.applyOptions = applyOptions; WA.ctxArg = ctxArg; WA.addParams = addParams; WA.setParamOptions = setParamOptions; WA.enumErr = enumErr;
  WA.defineFactories = defineFactories;
  void paramGetter; void AudioDestinationNode;
})(globalThis.__layer);
