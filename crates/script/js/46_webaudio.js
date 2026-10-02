// 46_webaudio.js — Web Audio core: AudioBuffer, AudioParam (automation timeline), AudioNode and the graph engine,
// BaseAudioContext / AudioContext / OfflineAudioContext, AudioDestinationNode, AudioListener, PeriodicWave tables,
// FFT. The node types live in 47_webaudio_nodes.js, the compressor and the filters in 48_webaudio_dsp.js.
//
// Model (Web Audio API 1.1, Blink's structure): the graph is pulled once per render quantum of 128 frames from the
// destination (and from the "automatic pull" nodes: analysers and script processors). Every node has a handler with
// `process(rec, inputs, outputs, frames, params)`; inputs are summed and up/down-mixed according to the node's
// channelCount / channelCountMode / channelInterpretation. Audio data is float32; DSP state follows Blink's float
// arithmetic where the result is observable (oscillator phase, compressor state), see the handlers.
// A realtime context has no output device: its clock follows wall time and its output is discarded.
(function (L) {
  'use strict';
  const INTERNAL = L.INTERNAL;
  const DOMException = L.DOMException;
  const fr = Math.fround;
  const QUANTUM = 128;

  const WA = L.webaudio = { QUANTUM, nodes: new WeakMap(), ctxs: new WeakMap() };
  const argc = (n, got, iface, method) => { if (got < n) throw new TypeError(`Failed to execute '${method}' on '${iface}': ${n} argument${n === 1 ? '' : 's'} required, but only ${got} present.`); };
  WA.argc = argc;
  const finiteOrThrow = (v, what) => { const n = Number(v); if (!Number.isFinite(n)) throw new TypeError(`${what}: The provided float value is non-finite.`); return n; };
  WA.finiteOrThrow = finiteOrThrow;

  // ---------------------------------------------------------------------------------------
  // FFT (radix-2, in place, double precision)
  // ---------------------------------------------------------------------------------------
  const fftCache = new Map();
  function fftPlan(n) {
    let p = fftCache.get(n);
    if (p !== undefined) return p;
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    const rev = new Uint32Array(n);
    let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
    p = { cos, sin, rev };
    fftCache.set(n, p);
    return p;
  }
  // forward (sign -1) or inverse (sign +1, unscaled) complex FFT
  function fft(re, im, inverse) {
    const n = re.length;
    const { cos, sin, rev } = fftPlan(n);
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = cos[k], s = inverse ? sin[k] : -sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  WA.fft = fft;

  // ---------------------------------------------------------------------------------------
  // AudioBuffer
  // ---------------------------------------------------------------------------------------
  const BUF = new WeakMap(); // AudioBuffer -> {sampleRate, length, channels: Float32Array[]}
  const bufOf = (o) => { const r = BUF.get(o); if (r === undefined) throw new TypeError('Illegal invocation'); return r; };
  WA.bufOf = bufOf;
  const MIN_RATE = 3000, MAX_RATE = 768000;
  function makeBuffer(channels, length, sampleRate) {
    const b = Object.create(AudioBuffer.prototype);
    BUF.set(b, { sampleRate, length, channels: Array.from({ length: channels }, () => new Float32Array(length)) });
    return b;
  }
  WA.makeBuffer = makeBuffer;
  class AudioBuffer {
    constructor(options) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'AudioBuffer': 1 argument required, but only 0 present.");
      if (options === null || typeof options !== 'object') throw new TypeError("Failed to construct 'AudioBuffer': The provided value is not of type 'AudioBufferOptions'.");
      const ch = options.numberOfChannels === undefined ? 1 : options.numberOfChannels >>> 0;
      if (options.length === undefined) throw new TypeError("Failed to construct 'AudioBuffer': Failed to read the 'length' property from 'AudioBufferOptions': Required member is undefined.");
      if (options.sampleRate === undefined) throw new TypeError("Failed to construct 'AudioBuffer': Failed to read the 'sampleRate' property from 'AudioBufferOptions': Required member is undefined.");
      const length = options.length >>> 0;
      const sr = fr(Number(options.sampleRate));
      return construct(ch, length, sr, 'Failed to construct \'AudioBuffer\'');
    }
    get length() { return bufOf(this).length; }
    get duration() { const r = bufOf(this); return r.length / r.sampleRate; }
    get sampleRate() { return bufOf(this).sampleRate; }
    get numberOfChannels() { return bufOf(this).channels.length; }
    copyFromChannel(destination, channelNumber, bufferOffset) {
      argc(2, arguments.length, 'AudioBuffer', 'copyFromChannel');
      const r = bufOf(this);
      if (!(destination instanceof Float32Array)) throw new TypeError("Failed to execute 'copyFromChannel' on 'AudioBuffer': parameter 1 is not of type 'Float32Array'.");
      const ch = channelNumber >>> 0, off = bufferOffset === undefined ? 0 : Number(bufferOffset) >>> 0;
      if (ch >= r.channels.length) throw new DOMException(`Failed to execute 'copyFromChannel' on 'AudioBuffer': channelNumber provided (${ch}) is outside the range [0, ${r.channels.length - 1}]`, 'IndexSizeError');
      if (off >= r.length) return;
      destination.set(r.channels[ch].subarray(off, off + destination.length));
    }
    copyToChannel(source, channelNumber, bufferOffset) {
      argc(2, arguments.length, 'AudioBuffer', 'copyToChannel');
      const r = bufOf(this);
      if (!(source instanceof Float32Array)) throw new TypeError("Failed to execute 'copyToChannel' on 'AudioBuffer': parameter 1 is not of type 'Float32Array'.");
      const ch = channelNumber >>> 0, off = bufferOffset === undefined ? 0 : Number(bufferOffset) >>> 0;
      if (ch >= r.channels.length) throw new DOMException(`Failed to execute 'copyToChannel' on 'AudioBuffer': channelNumber provided (${ch}) is outside the range [0, ${r.channels.length - 1}]`, 'IndexSizeError');
      if (off >= r.length) return;
      const n = Math.min(source.length, r.length - off);
      r.channels[ch].set(source.subarray(0, n), off);
    }
    getChannelData(channel) {
      argc(1, arguments.length, 'AudioBuffer', 'getChannelData');
      const r = bufOf(this);
      const ch = channel >>> 0;
      if (ch >= r.channels.length) throw new DOMException(`Failed to execute 'getChannelData' on 'AudioBuffer': channel index (${ch}) exceeds number of channels (${r.channels.length})`, 'IndexSizeError');
      return r.channels[ch];
    }
  }
  function construct(ch, length, sr, prefix) {
    if (ch < 1 || ch > 32) throw new DOMException(`${prefix}: The number of channels provided (${ch}) is outside the range [1, 32].`, 'NotSupportedError');
    if (length < 1) throw new DOMException(`${prefix}: The number of frames provided (${length}) is less than or equal to the minimum bound (0).`, 'NotSupportedError');
    if (!(sr >= MIN_RATE && sr <= MAX_RATE)) throw new DOMException(`${prefix}: The sample rate provided (${sr}) is outside the range [${MIN_RATE}, ${MAX_RATE}].`, 'NotSupportedError');
    let b;
    try { b = makeBuffer(ch, length, sr); } catch (_) { throw new DOMException(`${prefix}: Failed to allocate the buffer`, 'NotSupportedError'); }
    return b;
  }
  WA.AudioBuffer = AudioBuffer;
  // (the constructor above returns a new object: instances created by `new` share the prototype)
  L.expose('AudioBuffer', AudioBuffer);

  // ---------------------------------------------------------------------------------------
  // AudioParam
  // ---------------------------------------------------------------------------------------
  const PARAM = new WeakMap();
  const prm = (o) => { const r = PARAM.get(o); if (r === undefined) throw new TypeError('Illegal invocation'); return r; };
  WA.prm = prm;
  const E_SET = 0, E_LIN = 1, E_EXP = 2, E_TARGET = 3, E_CURVE = 4, E_CANCEL = 5;
  function timeArg(v, what, method) {
    const t = Number(v);
    if (!Number.isFinite(t)) throw new TypeError(`Failed to execute '${method}' on 'AudioParam': The provided double value is non-finite.`);
    if (t < 0) throw new RangeError(`Failed to execute '${method}' on 'AudioParam': Time must be a finite non-negative number: ${t}`);
    return t;
  }
  function insertEvent(p, ev) {
    const evs = p.events;
    if (evs.length === 0) p.initial = p.base;
    // replace an event of the same type at the same time (setValueCurve is checked for overlaps)
    let i = 0;
    while (i < evs.length && evs[i].time <= ev.time) {
      if (evs[i].time === ev.time && evs[i].type === ev.type && ev.type !== E_CURVE) { evs[i] = ev; return; }
      i++;
    }
    evs.splice(i, 0, ev);
  }
  class AudioParam {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get value() { return prm(this).current; }
    set value(v) {
      const p = prm(this);
      const n = fr(Number(v));
      if (!Number.isFinite(n)) throw new TypeError("Failed to set the 'value' property on 'AudioParam': The provided float value is non-finite.");
      // like setValueAtTime(value, currentTime) without the exceptions; the intrinsic value is the value now
      if (p.events.length === 0) { p.base = n; p.current = n; p.initial = n; }
      else { p.current = n; }
      insertEvent(p, { type: E_SET, time: p.ctx.currentTime(), value: n });
    }
    get automationRate() { return prm(this).rate; }
    set automationRate(v) {
      const p = prm(this);
      v = `${v}`;
      if (v !== 'a-rate' && v !== 'k-rate') return;
      if (p.fixedRate) throw new DOMException(`Failed to set the 'automationRate' property on 'AudioParam': ${p.node ? ({ compressor: 'DynamicsCompressor' }[p.node.kind] || p.node.kind) : ''}.${p.name}.automationRate is fixed and cannot be changed to "${v}"`, 'InvalidStateError');
      p.rate = v;
    }
    get defaultValue() { return prm(this).def; }
    get minValue() { return prm(this).min; }
    get maxValue() { return prm(this).max; }
    setValueAtTime(value, startTime) {
      argc(2, arguments.length, 'AudioParam', 'setValueAtTime');
      const p = prm(this);
      const v = fr(finiteOrThrow(value, "Failed to execute 'setValueAtTime' on 'AudioParam'")), t = timeArg(startTime, 'The start time provided', 'setValueAtTime');
      insertEvent(p, { type: E_SET, time: t, value: v });
      return this;
    }
    linearRampToValueAtTime(value, endTime) {
      argc(2, arguments.length, 'AudioParam', 'linearRampToValueAtTime');
      const p = prm(this);
      const v = fr(finiteOrThrow(value, "Failed to execute 'linearRampToValueAtTime' on 'AudioParam'")), t = timeArg(endTime, 'The end time provided', 'linearRampToValueAtTime');
      insertEvent(p, { type: E_LIN, time: t, value: v });
      return this;
    }
    exponentialRampToValueAtTime(value, endTime) {
      argc(2, arguments.length, 'AudioParam', 'exponentialRampToValueAtTime');
      const p = prm(this);
      const v = fr(finiteOrThrow(value, "Failed to execute 'exponentialRampToValueAtTime' on 'AudioParam'")), t = timeArg(endTime, 'The end time provided', 'exponentialRampToValueAtTime');
      if (v === 0) throw new RangeError("Failed to execute 'exponentialRampToValueAtTime' on 'AudioParam': The float target value provided (0) should not be in the range (-1.40130e-45, 1.40130e-45).");
      insertEvent(p, { type: E_EXP, time: t, value: v });
      return this;
    }
    setTargetAtTime(target, startTime, timeConstant) {
      argc(3, arguments.length, 'AudioParam', 'setTargetAtTime');
      const p = prm(this);
      const v = fr(finiteOrThrow(target, "Failed to execute 'setTargetAtTime' on 'AudioParam'")), t = timeArg(startTime, 'The start time provided', 'setTargetAtTime');
      const tc = finiteOrThrow(timeConstant, "Failed to execute 'setTargetAtTime' on 'AudioParam'");
      if (tc < 0) throw new RangeError(`Failed to execute 'setTargetAtTime' on 'AudioParam': The time constant provided (${tc}) is negative.`);
      insertEvent(p, { type: E_TARGET, time: t, value: v, tc });
      return this;
    }
    setValueCurveAtTime(values, startTime, duration) {
      argc(3, arguments.length, 'AudioParam', 'setValueCurveAtTime');
      const p = prm(this);
      let arr;
      if (values instanceof Float32Array) arr = values; else if (values !== null && typeof values === 'object' && typeof values.length === 'number') arr = Float32Array.from(Array.from(values, Number)); else throw new TypeError("Failed to execute 'setValueCurveAtTime' on 'AudioParam': The provided value is not of type 'sequence<float>'.");
      const t = timeArg(startTime, 'The start time provided', 'setValueCurveAtTime');
      const d = finiteOrThrow(duration, "Failed to execute 'setValueCurveAtTime' on 'AudioParam'");
      if (arr.length < 2) throw new DOMException(`Failed to execute 'setValueCurveAtTime' on 'AudioParam': The curve length provided (${arr.length}) is less than the minimum bound (2).`, 'InvalidStateError');
      if (d <= 0) throw new RangeError(`Failed to execute 'setValueCurveAtTime' on 'AudioParam': The duration provided (${d}) has to be greater than 0.`);
      for (const e of p.events) {
        if (e.type === E_CURVE && t < e.time + e.duration && t + d > e.time) throw new DOMException("Failed to execute 'setValueCurveAtTime' on 'AudioParam': setValueCurveAtTime(..., " + t + ", " + d + ") overlaps setValueCurveAtTime(..., " + e.time + ", " + e.duration + ")", 'NotSupportedError');
        if (e.type !== E_CURVE && e.time > t && e.time < t + d) throw new DOMException(`Failed to execute 'setValueCurveAtTime' on 'AudioParam': setValueCurveAtTime(..., ${t}, ${d}) overlaps an event at ${e.time}`, 'NotSupportedError');
      }
      insertEvent(p, { type: E_CURVE, time: t, duration: d, curve: Float32Array.from(arr), value: arr[arr.length - 1] });
      return this;
    }
    cancelScheduledValues(cancelTime) {
      argc(1, arguments.length, 'AudioParam', 'cancelScheduledValues');
      const p = prm(this);
      const t = timeArg(cancelTime, 'The cancel time provided', 'cancelScheduledValues');
      p.events = p.events.filter((e) => e.time < t && !(e.type === E_CURVE && e.time + e.duration > t));
      return this;
    }
    cancelAndHoldAtTime(cancelTime) {
      argc(1, arguments.length, 'AudioParam', 'cancelAndHoldAtTime');
      const p = prm(this);
      const t = timeArg(cancelTime, 'The cancel time provided', 'cancelAndHoldAtTime');
      // value at t from the current timeline, then drop later events and hold it
      const held = valueAtTime(p, t);
      p.events = p.events.filter((e) => e.time <= t);
      insertEvent(p, { type: E_SET, time: t, value: fr(held) });
      return this;
    }
  }
  L.expose('AudioParam', AudioParam);

  function newParam(ctx, node, name, def, min, max, opts) {
    const o = opts || {};
    const a = Object.create(AudioParam.prototype);
    const p = { ctx, node, name, def, min, max, base: def, initial: def, current: def, events: [], rate: o.rate || 'a-rate', fixedRate: !!o.fixedRate, inputs: [], wrapper: a, buffer: new Float32Array(QUANTUM), lastQuantum: -1, kind: o.kind || 'float', clampTo: o.clampTo || null };
    PARAM.set(a, p);
    return p;
  }
  WA.newParam = newParam;

  // Value of the timeline at time t (seconds), evaluated like the spec's algorithm (§1.6.3): the intrinsic value
  // applies before the first event; a ramp starts at the previous event; setTarget approaches its target from the
  // value reached at its start; a value curve interpolates linearly and holds its last value.
  function valueAtTime(p, t) {
    const evs = p.events;
    if (evs.length === 0) return p.base;
    let value = p.initial, prevValue = p.initial, prevTime = 0;
    const ramp = (next, tt) => {
      const span = next.time - prevTime;
      if (next.type === E_LIN) return span <= 0 ? next.value : prevValue + (next.value - prevValue) * ((tt - prevTime) / span);
      if (span <= 0 || prevValue === 0 || (prevValue < 0) !== (next.value < 0)) return prevValue;
      return prevValue * Math.pow(next.value / prevValue, (tt - prevTime) / span);
    };
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      const next = evs[i + 1];
      if (t < e.time) return (e.type === E_LIN || e.type === E_EXP) ? ramp(e, t) : value;
      switch (e.type) {
        case E_SET: case E_LIN: case E_EXP: value = e.value; prevValue = e.value; prevTime = e.time; break;
        case E_TARGET: {
          const start = value;
          const at = (tt) => (e.tc === 0 ? e.value : e.value + (start - e.value) * Math.exp(-(tt - e.time) / e.tc));
          if (!next || t < next.time) return at(t);
          value = at(next.time); prevValue = value; prevTime = next.time;
          continue;
        }
        default: {
          if (t < e.time + e.duration) {
            const n = e.curve.length;
            const pos = (n - 1) * (t - e.time) / e.duration;
            const k = Math.min(n - 2, Math.floor(pos));
            return e.curve[k] + (e.curve[k + 1] - e.curve[k]) * (pos - k);
          }
          value = e.curve[e.curve.length - 1]; prevValue = value; prevTime = e.time + e.duration;
        }
      }
      if (next && t < next.time && (next.type === E_LIN || next.type === E_EXP)) return ramp(next, t);
      if (next && t < next.time) return value;
    }
    return value;
  }
  WA.valueAtTime = valueAtTime;

  // Fill p.buffer with the values of the quantum starting at `startFrame`. Returns true when the values may vary
  // within the quantum (sample-accurate: an automation event or an audio-rate connection is in effect).
  function computeParam(p, startFrame, n, sr) {
    const buf = p.buffer;
    const evs = p.events;
    const t0 = startFrame / sr, t1 = (startFrame + n) / sr;
    let varies = false;
    if (evs.length === 0) { buf.fill(p.base, 0, n); p.current = p.base; } else {
      const last = evs[evs.length - 1];
      const settled = t0 >= last.time && (last.type === E_SET || last.type === E_LIN || last.type === E_EXP);
      if (settled) { const v = last.value; buf.fill(v, 0, n); p.current = v; p.base = v; } else if (p.rate === 'k-rate') {
        const v = fr(valueAtTime(p, t0)); buf.fill(v, 0, n); p.current = v;
        varies = false;
      } else {
        // before the first event nothing varies
        if (t1 <= evs[0].time && evs[0].type !== E_LIN && evs[0].type !== E_EXP) { const v = fr(valueAtTime(p, t0)); buf.fill(v, 0, n); p.current = v; } else {
          for (let i = 0; i < n; i++) buf[i] = valueAtTime(p, (startFrame + i) / sr);
          p.current = buf[0]; varies = true;
        }
      }
    }
    if (p.inputs.length) {
      const sum = WA.pullParamInputs(p, n);
      if (sum !== null) { for (let i = 0; i < n; i++) buf[i] += sum[i]; varies = true; }
    }
    if (p.min !== -Infinity || p.max !== Infinity) {
      const lo = p.min, hi = p.max;
      for (let i = 0; i < n; i++) { const v = buf[i]; buf[i] = v < lo ? lo : v > hi ? hi : v; }
    }
    p.varies = varies;
    return varies;
  }
  WA.computeParam = computeParam;

  // ---------------------------------------------------------------------------------------
  // Channel mixing
  // ---------------------------------------------------------------------------------------
  const SQRT_HALF = Math.SQRT1_2;
  // mix `src` channels into `dst` channels (adding), with the speaker or discrete rules
  function mixAdd(dst, src, interp, n) {
    const sc = src.length, dc = dst.length;
    if (sc === 0 || dc === 0) return;
    if (interp === 'discrete' || !SPEAKER_LAYOUTS.has(sc) || !SPEAKER_LAYOUTS.has(dc)) {
      const m = Math.min(sc, dc);
      for (let c = 0; c < m; c++) { const d = dst[c], s = src[c]; for (let i = 0; i < n; i++) d[i] += s[i]; }
      return;
    }
    const add = (d, s, g) => { if (g === 1) for (let i = 0; i < n; i++) d[i] += s[i]; else for (let i = 0; i < n; i++) d[i] += s[i] * g; };
    if (sc === dc) { for (let c = 0; c < sc; c++) add(dst[c], src[c], 1); return; }
    // layouts: 1 mono (M), 2 stereo (L R), 4 quad (L R SL SR), 6 5.1 (L R C LFE SL SR)
    if (sc === 1) {
      if (dc === 2) { add(dst[0], src[0], 1); add(dst[1], src[0], 1); } else if (dc === 4) { add(dst[0], src[0], 1); add(dst[1], src[0], 1); } else if (dc === 6) add(dst[2], src[0], 1);
      return;
    }
    if (sc === 2) {
      if (dc === 1) { add(dst[0], src[0], 0.5); add(dst[0], src[1], 0.5); } else if (dc === 4 || dc === 6) { add(dst[0], src[0], 1); add(dst[1], src[1], 1); }
      return;
    }
    if (sc === 4) {
      if (dc === 1) { for (let c = 0; c < 4; c++) add(dst[0], src[c], 0.25); } else if (dc === 2) { add(dst[0], src[0], 0.5); add(dst[0], src[2], 0.5); add(dst[1], src[1], 0.5); add(dst[1], src[3], 0.5); } else if (dc === 6) { for (let c = 0; c < 2; c++) add(dst[c], src[c], 1); add(dst[4], src[2], 1); add(dst[5], src[3], 1); }
      return;
    }
    if (sc === 6) {
      if (dc === 1) { add(dst[0], src[0], SQRT_HALF); add(dst[0], src[1], SQRT_HALF); add(dst[0], src[2], 1); add(dst[0], src[4], 0.5); add(dst[0], src[5], 0.5); } else if (dc === 2) {
        add(dst[0], src[0], 1); add(dst[0], src[2], SQRT_HALF); add(dst[0], src[4], SQRT_HALF);
        add(dst[1], src[1], 1); add(dst[1], src[2], SQRT_HALF); add(dst[1], src[5], SQRT_HALF);
      } else if (dc === 4) {
        add(dst[0], src[0], 1); add(dst[0], src[2], SQRT_HALF); add(dst[1], src[1], 1); add(dst[1], src[2], SQRT_HALF); add(dst[2], src[4], 1); add(dst[3], src[5], 1);
      }
    }
  }
  const SPEAKER_LAYOUTS = new Set([1, 2, 4, 6]);
  WA.mixAdd = mixAdd;

  // ---------------------------------------------------------------------------------------
  // Contexts and the graph engine
  // ---------------------------------------------------------------------------------------
  const CTX = new WeakMap(); // BaseAudioContext -> engine record
  const cx = (o) => { const r = CTX.get(o); if (r === undefined) throw new TypeError('Illegal invocation'); return r; };
  WA.cx = cx;
  WA.CTX = CTX;

  function newEngine(wrapper, sampleRate, offline) {
    return {
      wrapper, sampleRate, offline, frame: 0, quantumId: 0, state: offline ? 'suspended' : 'suspended', nodes: new Set(), autoPull: new Set(), destination: null, listener: null,
      timer: 0, lastWall: 0, closed: false, pendingResume: [], suspendList: [], rendering: false,
      currentTime() { return this.frame / this.sampleRate; },
    };
  }
  WA.newEngine = newEngine;

  // ---- node records
  const NODE = new WeakMap();
  const nd = (o) => { const r = NODE.get(o); if (r === undefined) throw new TypeError('Illegal invocation'); return r; };
  WA.nd = nd;
  WA.NODE = NODE;

  // spec defaults per node kind are supplied by the constructors
  function newNodeRec(eng, wrapper, o) {
    const rec = {
      eng, wrapper, handler: o.handler, kind: o.kind,
      inputs: Array.from({ length: o.inputs }, () => ({ conns: [], bus: [] })),
      outputs: Array.from({ length: o.outputs }, (_, i) => ({ node: null, index: i, conns: [], bus: [], channels: o.outputChannels === undefined ? 1 : o.outputChannels })),
      channelCount: o.channelCount, mode: o.mode, interp: o.interp, params: [], lastQuantum: -1, processing: false, state: o.state || {}, tail: 0,
    };
    for (const out of rec.outputs) out.node = rec;
    eng.nodes.add(rec);
    return rec;
  }
  WA.newNodeRec = newNodeRec;

  function ensureBus(bus, channels, frames) {
    while (bus.length > channels) bus.pop();
    while (bus.length < channels) bus.push(new Float32Array(QUANTUM));
    void frames;
    return bus;
  }
  WA.ensureBus = ensureBus;

  // Compute the node's outputs for the current render quantum (once).
  function processNode(rec) {
    const eng = rec.eng;
    if (rec.lastQuantum === eng.quantumId) return;
    if (rec.processing) return; // a cycle without a delay: the loop reads silence
    rec.processing = true;
    try {
      const frames = QUANTUM;
      // inputs
      for (let i = 0; i < rec.inputs.length; i++) {
        const inp = rec.inputs[i];
        // computed channel count
        let maxCh = 0;
        const sources = [];
        for (const out of inp.conns) {
          processNode(out.node);
          if (out.node.lastQuantum !== eng.quantumId && out.node.processing) continue;
          sources.push(out);
          if (out.bus.length > maxCh) maxCh = out.bus.length;
        }
        let ch;
        if (rec.mode === 'explicit') ch = rec.channelCount;
        else if (rec.mode === 'clamped-max') ch = Math.min(Math.max(maxCh, 1), rec.channelCount);
        else ch = Math.max(maxCh, 1);
        if (sources.length === 0 && rec.mode !== 'explicit') ch = rec.mode === 'max' ? 1 : Math.min(1, rec.channelCount);
        ensureBus(inp.bus, ch, frames);
        for (const c of inp.bus) c.fill(0);
        for (const out of sources) mixAdd(inp.bus, out.bus, rec.interp, frames);
        inp.connected = sources.length > 0;
      }
      // parameters
      for (const p of rec.params) { if (p.lastQuantum !== eng.quantumId) { computeParam(p, eng.frame, frames, eng.sampleRate); p.lastQuantum = eng.quantumId; } }
      rec.handler.process(rec, frames);
    } finally {
      rec.processing = false;
      rec.lastQuantum = eng.quantumId;
    }
  }
  WA.processNode = processNode;

  // audio-rate connections into a parameter: sum of the (mono-mixed) outputs
  WA.pullParamInputs = function pullParamInputs(p, n) {
    const eng = p.ctx;
    let sum = null;
    for (const out of p.inputs) {
      processNode(out.node);
      if (out.node.processing) continue;
      if (sum === null) sum = new Float32Array(n);
      const mono = [new Float32Array(n)];
      mixAdd(mono, out.bus, 'speakers', n);
      for (let i = 0; i < n; i++) sum[i] += mono[0][i];
    }
    void eng;
    return sum;
  };

  function renderQuantum(eng) {
    eng.quantumId++;
    const dest = eng.destination;
    processNode(dest);
    for (const rec of eng.autoPull) processNode(rec);
    // sources that finished (ended events) are fired from the handler through eng.pendingEvents
    eng.frame += QUANTUM;
    if (eng.afterQuantum) eng.afterQuantum();
  }
  WA.renderQuantum = renderQuantum;

  // ---- BaseAudioContext
  const PROTO_ORDER = [];
  void PROTO_ORDER;
  const ctxStateEvent = (ctx) => { const ev = new L.Event('statechange'); ctx.dispatchEvent(ev); };
  class BaseAudioContext extends L.EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    get destination() { return cx(this).destination.wrapper; }
    get sampleRate() { return cx(this).sampleRate; }
    get currentTime() { return cx(this).frame / cx(this).sampleRate; }
    get listener() { return cx(this).listener; }
    get state() { return cx(this).state; }
    createBuffer(numberOfChannels, length, sampleRate) {
      argc(3, arguments.length, 'BaseAudioContext', 'createBuffer');
      return construct(numberOfChannels >>> 0, length >>> 0, fr(Number(sampleRate)), "Failed to execute 'createBuffer' on 'BaseAudioContext'");
    }
    decodeAudioData(audioData, successCallback, errorCallback) {
      argc(1, arguments.length, 'BaseAudioContext', 'decodeAudioData');
      const e = cx(this);
      if (!(audioData instanceof ArrayBuffer)) return L.rejectedPromise(new TypeError("Failed to execute 'decodeAudioData' on 'BaseAudioContext': parameter 1 is not of type 'ArrayBuffer'."));
      if (e.closed) return L.rejectedPromise(new DOMException("Failed to execute 'decodeAudioData' on 'BaseAudioContext': Cannot decode audio data: The AudioContext is closed.", 'InvalidStateError'));
      const bytes = new Uint8Array(audioData.slice(0));
      return new L.Promise((resolve, reject) => {
        L.postTask(() => {
          let buf = null, err = null;
          try { buf = WA.decodeWav(bytes, e.sampleRate); } catch (x) { err = x; }
          if (buf === null) {
            const ex = err || new DOMException('Unable to decode audio data', 'EncodingError');
            if (typeof errorCallback === 'function') L.safeCall(errorCallback, undefined, [ex]);
            reject(ex);
          } else {
            if (typeof successCallback === 'function') L.safeCall(successCallback, undefined, [buf]);
            resolve(buf);
          }
        });
      });
    }
  }
  WA.BaseAudioContext = BaseAudioContext;
  L.defineEventHandlers(BaseAudioContext.prototype, ['onstatechange']);
  L.expose('BaseAudioContext', BaseAudioContext);

  // ---- WAV decoding (PCM 8/16/24/32-bit, IEEE float 32/64), resampled linearly to the context's rate
  WA.decodeWav = function decodeWav(u8, targetRate) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (u8.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new DOMException('Unable to decode audio data', 'EncodingError');
    let off = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= u8.length) {
      const id = tag(off), len = dv.getUint32(off + 4, true);
      if (id === 'fmt ') fmt = { format: dv.getUint16(off + 8, true), channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
      else if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len, u8.length - dataOff); break; }
      off += 8 + len + (len & 1);
    }
    if (fmt === null || dataOff < 0 || fmt.channels < 1 || fmt.channels > 32) throw new DOMException('Unable to decode audio data', 'EncodingError');
    let format = fmt.format;
    if (format === 0xfffe) format = dv.getUint16(off + 8 + 24, true);
    const bytes = fmt.bits >> 3;
    if (!((format === 1 && [1, 2, 3, 4].includes(bytes)) || (format === 3 && (bytes === 4 || bytes === 8)))) throw new DOMException('Unable to decode audio data', 'EncodingError');
    const frames = Math.floor(dataLen / (bytes * fmt.channels));
    if (frames < 1) throw new DOMException('Unable to decode audio data', 'EncodingError');
    const read = (o) => {
      if (format === 3) return bytes === 4 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
      switch (bytes) {
        case 1: return (dv.getUint8(o) - 128) / 128;
        case 2: return dv.getInt16(o, true) / 32768;
        case 3: { const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16); return v / 8388608; }
        default: return dv.getInt32(o, true) / 2147483648;
      }
    };
    const src = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) src[c][i] = read(dataOff + (i * fmt.channels + c) * bytes);
    if (fmt.rate === targetRate) { const b = makeBuffer(fmt.channels, frames, targetRate); src.forEach((s, c) => bufOf(b).channels[c].set(s)); return b; }
    const outLen = Math.max(1, Math.round(frames * targetRate / fmt.rate));
    const b = makeBuffer(fmt.channels, outLen, targetRate);
    const ratio = fmt.rate / targetRate;
    for (let c = 0; c < fmt.channels; c++) {
      const d = bufOf(b).channels[c], s = src[c];
      for (let i = 0; i < outLen; i++) { const p = i * ratio, k = Math.floor(p), f = p - k; const a0 = s[Math.min(k, frames - 1)], a1 = s[Math.min(k + 1, frames - 1)]; d[i] = a0 + (a1 - a0) * f; }
    }
    return b;
  };

  // factories are installed by 47_webaudio_nodes.js (they need the node classes)
  WA.factories = {};

  // ---- AudioContext (realtime, no output device)
  const RT_STEP_MS = 10;
  function rtTick(eng) {
    eng.timer = 0;
    if (eng.state !== 'running') return;
    const now = N_now();
    const due = Math.floor((now - eng.lastWall) * eng.sampleRate / 1000 / QUANTUM);
    const n = Math.min(Math.max(due, 0), 200);
    for (let i = 0; i < n; i++) renderQuantum(eng);
    eng.lastWall += n * QUANTUM * 1000 / eng.sampleRate;
    if (due > 200) eng.lastWall = now;
    eng.timer = L.internalTimeout(() => rtTick(eng), RT_STEP_MS);
  }
  const N_now = () => L.N.now();
  function setState(eng, s) {
    if (eng.state === s) return;
    eng.state = s;
    L.postTask(() => ctxStateEvent(eng.wrapper));
  }
  WA.setState = setState;
  function startRealtime(eng) {
    eng.lastWall = N_now();
    if (!eng.timer) eng.timer = L.internalTimeout(() => rtTick(eng), RT_STEP_MS);
    setState(eng, 'running');
  }
  const activated = () => { try { return L.navigator.userActivation.hasBeenActive; } catch (_) { return true; } };
  WA.startRealtime = startRealtime;
  WA.activated = activated;
})(globalThis.__layer);
