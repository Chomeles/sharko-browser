'use strict';
// Web Audio cases that run in Sharko and in Chromium (webgl_golden.js records Chromium's answers). Rendered signals are
// sampled (every `step`-th frame) and compared with a small absolute tolerance (the oscillator tables come from an FFT
// whose rounding differs).
module.exports = {
  async audio_surface() {
    const ac = new AudioContext();
    const out = {};
    out.ctx = { state0: ac.state, rate: ac.sampleRate > 3000, base: ac.baseLatency, out: ac.outputLatency, dest: [ac.destination.maxChannelCount, ac.destination.numberOfInputs, ac.destination.numberOfOutputs, ac.destination.channelCount, ac.destination.channelCountMode, ac.destination.channelInterpretation], time: ac.currentTime, keys: Object.keys(ac) };
    const o = ac.createOscillator();
    out.osc = [o.type, o.frequency.value, o.detune.value, o.frequency.minValue > -ac.sampleRate, o.frequency.maxValue > 0, o.frequency.automationRate, o.channelCount, o.channelCountMode, o.channelInterpretation, o.numberOfInputs, o.numberOfOutputs];
    const c = ac.createDynamicsCompressor();
    out.comp = [c.threshold.value, c.knee.value, c.ratio.value, c.attack.value, c.release.value, c.reduction, c.channelCount, c.channelCountMode, c.threshold.automationRate, c.threshold.minValue, c.threshold.maxValue, c.ratio.maxValue];
    const a = ac.createAnalyser();
    out.an = [a.fftSize, a.frequencyBinCount, a.minDecibels, a.maxDecibels, a.smoothingTimeConstant, a.channelCount, a.channelCountMode];
    const g = ac.createGain(); out.gain = [g.gain.value, g.channelCount, g.channelCountMode, g.gain.minValue, g.gain.maxValue];
    const b = ac.createBiquadFilter(); out.biquad = [b.type, b.frequency.value, b.Q.value, b.gain.value, b.detune.value, b.frequency.maxValue > 0];
    const d = ac.createDelay(); out.delay = [d.delayTime.value, d.delayTime.maxValue];
    const p = ac.createStereoPanner(); out.pan = [p.pan.value, p.pan.minValue, p.pan.maxValue, p.channelCountMode, p.channelCount];
    const sp = ac.createChannelSplitter(); const mg = ac.createChannelMerger(); out.sm = [sp.numberOfOutputs, sp.channelCount, sp.channelCountMode, sp.channelInterpretation, mg.numberOfInputs, mg.channelCount, mg.channelCountMode];
    const src = ac.createBufferSource(); out.src = [src.loop, src.loopStart, src.loopEnd, src.playbackRate.value, src.buffer];
    const w = ac.createWaveShaper(); out.shaper = [w.curve, w.oversample];
    const k = ac.createConstantSource(); out.cs = [k.offset.value];
    out.l = [ac.listener.positionX.value, ac.listener.forwardZ.value, ac.listener.upY.value];
    out.names = ['BaseAudioContext', 'AudioContext', 'OfflineAudioContext', 'AudioBuffer', 'AudioNode', 'AudioParam', 'OscillatorNode', 'DynamicsCompressorNode', 'AnalyserNode', 'GainNode', 'BiquadFilterNode', 'PeriodicWave', 'AudioBufferSourceNode'].map((n) => [n, Object.getOwnPropertyNames(window[n].prototype).join(','), window[n].length]);
    out.base = Object.getOwnPropertyNames(BaseAudioContext.prototype).filter((n) => n !== 'createPanner' && n !== 'createConvolver').join(',');
    out.tags = [ac, o, c, ac.destination, g.gain, ac.listener].map((x) => Object.prototype.toString.call(x));
    let e1; try { new AudioNode(); } catch (e) { e1 = e.constructor.name; }
    let e2; try { new GainNode({}); } catch (e) { e2 = e.constructor.name; }
    let e3; try { new BaseAudioContext(); } catch (e) { e3 = e.constructor.name; }
    out.errors = [e1, e2, e3];
    await ac.close(); out.closed = ac.state;
    return out;
  },
  async audio_fingerprint() {
    const oc = new OfflineAudioContext(1, 44100, 44100);
    const o = oc.createOscillator(); o.type = 'triangle'; o.frequency.value = 10000;
    const c = oc.createDynamicsCompressor();
    c.threshold.value = -50; c.knee.value = 40; c.ratio.value = 12; c.attack.value = 0; c.release.value = 0.25;
    o.connect(c); c.connect(oc.destination); o.start(0);
    const buf = await oc.startRendering();
    const d = buf.getChannelData(0);
    let sum = 0; for (let i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
    const s = []; for (let i = 0; i < 44100; i += 441) s.push(d[i]);
    return { sum: Math.round(sum * 1000) / 1000, sampled: s, reduction: c.reduction, props: [buf.length, buf.numberOfChannels, buf.sampleRate, buf.duration] };
  },
  async audio_oscillators() {
    const out = {};
    for (const [t, f] of [['sine', 440], ['square', 440], ['sawtooth', 3000], ['triangle', 1234.5]]) {
      const oc = new OfflineAudioContext(1, 1024, 44100);
      const o = oc.createOscillator(); o.type = t; o.frequency.value = f; o.connect(oc.destination); o.start(0);
      const d = (await oc.startRendering()).getChannelData(0);
      out[t] = Array.from({ length: 32 }, (_, i) => d[i * 32 + 3]);
    }
    const oc = new OfflineAudioContext(1, 512, 44100);
    const w = oc.createPeriodicWave(new Float32Array([0, 0, 0.5]), new Float32Array([0, 0.25, 0]));
    const o = oc.createOscillator(); o.setPeriodicWave(w); o.frequency.value = 441; o.connect(oc.destination); o.start(0.001);
    const d = (await oc.startRendering()).getChannelData(0);
    out.custom = [o.type, ...Array.from({ length: 16 }, (_, i) => d[i * 32 + 50])];
    return out;
  },
  async audio_params_and_nodes() {
    const rate = 8000;
    const out = {};
    const render = async (len, build) => {
      const oc = new OfflineAudioContext(2, len, rate);
      build(oc);
      const b = await oc.startRendering();
      return [b.getChannelData(0), b.getChannelData(1)];
    };
    const samp = (a, n) => Array.from({ length: n }, (_, i) => a[Math.floor(i * a.length / n)]);
    // automation on a constant source
    let [l] = await render(4000, (oc) => {
      const s = oc.createConstantSource(); const p = s.offset;
      p.setValueAtTime(0.2, 0); p.linearRampToValueAtTime(1, 0.1); p.setValueAtTime(0.5, 0.15); p.exponentialRampToValueAtTime(0.01, 0.25); p.setTargetAtTime(0.8, 0.3, 0.05);
      s.connect(oc.destination); s.start();
    });
    out.automation = samp(l, 40);
    [l] = await render(2000, (oc) => {
      const s = oc.createConstantSource(); s.offset.setValueCurveAtTime(new Float32Array([0, 1, 0.5, -1]), 0.05, 0.1); s.connect(oc.destination); s.start(0.01); s.stop(0.2);
    });
    out.curve = samp(l, 20);
    // gain + oscillator, stereo panner
    let r;
    [l, r] = await render(1000, (oc) => {
      const o = oc.createOscillator(); o.frequency.value = 400; const g = oc.createGain(); g.gain.value = 0.5; const p = oc.createStereoPanner(); p.pan.value = -0.5;
      o.connect(g); g.connect(p); p.connect(oc.destination); o.start();
    });
    out.pan = [samp(l, 10), samp(r, 10)];
    // buffer source with loop and playbackRate
    [l] = await render(1500, (oc) => {
      const buf = oc.createBuffer(1, 8, rate); buf.copyToChannel(new Float32Array([0, 0.25, 0.5, 1, 0.5, 0, -0.5, -1]), 0);
      const s = oc.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = 0.37; s.connect(oc.destination); s.start(0.01);
    });
    out.buffer = samp(l, 30);
    // delay and biquad
    [l] = await render(1200, (oc) => {
      const o = oc.createOscillator(); o.type = 'square'; o.frequency.value = 200; const d = oc.createDelay(1); d.delayTime.value = 0.05; const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 3;
      o.connect(d); d.connect(f); f.connect(oc.destination); o.start();
    });
    out.delayBiquad = samp(l, 24);
    for (const type of ['highpass', 'bandpass', 'notch', 'allpass', 'peaking', 'lowshelf', 'highshelf']) {
      [l] = await render(600, (oc) => {
        const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 330; const f = oc.createBiquadFilter(); f.type = type; f.frequency.value = 1200; f.Q.value = 2; f.gain.value = 6;
        o.connect(f); f.connect(oc.destination); o.start();
      });
      out[type] = samp(l, 8);
    }
    // wave shaper, splitter/merger, channel up-mix
    [l, r] = await render(800, (oc) => {
      const o = oc.createOscillator(); o.frequency.value = 300; const w = oc.createWaveShaper(); w.curve = new Float32Array([-1, -0.2, 0.2, 1]);
      const sp = oc.createChannelSplitter(2); const mg = oc.createChannelMerger(2);
      o.connect(w); w.connect(sp); sp.connect(mg, 0, 1); mg.connect(oc.destination); o.start();
    });
    out.shaperSwap = [samp(l, 6), samp(r, 6)];
    const iir = await (async () => {
      const oc = new OfflineAudioContext(1, 300, rate);
      const o = oc.createOscillator(); o.frequency.value = 250; const f = oc.createIIRFilter([0.1, 0.2, 0.1], [1, -0.6, 0.2]);
      o.connect(f); f.connect(oc.destination); o.start();
      const d = (await oc.startRendering()).getChannelData(0);
      const mag = new Float32Array(3), ph = new Float32Array(3); f.getFrequencyResponse(new Float32Array([100, 1000, 3000]), mag, ph);
      return { s: samp(d, 6), mag: Array.from(mag), ph: Array.from(ph) };
    })();
    out.iir = iir;
    // analyser on an offline context after suspend
    const oc = new OfflineAudioContext(1, 4096, rate);
    const o = oc.createOscillator(); o.frequency.value = 1000; const an = oc.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = 0;
    o.connect(an); an.connect(oc.destination); o.start();
    let snap;
    oc.suspend(1024 / rate).then(() => { const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f); const by = new Uint8Array(an.frequencyBinCount); an.getByteFrequencyData(by); const td = new Float32Array(an.fftSize); an.getFloatTimeDomainData(td); const bt = new Uint8Array(an.fftSize); an.getByteTimeDomainData(bt);
      let peak = 0; for (let i = 1; i < f.length; i++) if (f[i] > f[peak]) peak = i;
      snap = { peak, peakDb: f[peak], byte: by[peak], td: Array.from(td.slice(100, 106)), bt: Array.from(bt.slice(100, 106)) }; oc.resume(); });
    await oc.startRendering();
    out.analyser = snap;
    return out;
  },
  async audio_errors() {
    const out = {};
    const t = async (name, f) => { try { const v = await f(); out[name] = ['ok', v === undefined ? null : v]; } catch (e) { out[name] = [e.constructor.name, e.name, String(e.message).slice(0, 220)]; } };
    const oc = new OfflineAudioContext(1, 128, 8000);
    const g = oc.createGain();
    await t('badChannels', () => new OfflineAudioContext(0, 10, 8000));
    await t('badRate', () => new OfflineAudioContext(1, 10, 100));
    await t('badLength', () => new OfflineAudioContext(1, 0, 8000));
    await t('startTwice', () => { const o = oc.createOscillator(); o.start(); o.start(); });
    await t('stopBeforeStart', () => oc.createOscillator().stop());
    await t('negStart', () => oc.createOscillator().start(-1));
    await t('connectSelfParam', () => { g.connect(g.gain); return 'ok'; });
    await t('connectOtherCtx', () => g.connect(new OfflineAudioContext(1, 10, 8000).createGain()));
    await t('disconnectNone', () => g.disconnect(oc.createGain()));
    await t('badOutput', () => g.connect(oc.destination, 3));
    await t('expZero', () => g.gain.exponentialRampToValueAtTime(0, 1));
    await t('negTime', () => g.gain.setValueAtTime(1, -1));
    await t('curveShort', () => g.gain.setValueCurveAtTime([1], 0, 1));
    await t('customType', () => { oc.createOscillator().type = 'custom'; });
    await t('badFft', () => { oc.createAnalyser().fftSize = 100; });
    await t('analyserDb', () => { const a = oc.createAnalyser(); a.minDecibels = 0; });
    await t('compMode', () => { oc.createDynamicsCompressor().channelCountMode = 'max'; });
    await t('compChannels', () => { oc.createDynamicsCompressor().channelCount = 3; });
    await t('kRate', () => { oc.createDynamicsCompressor().threshold.automationRate = 'a-rate'; });
    await t('delayMax', () => oc.createDelay(0));
    await t('bufferArgs', () => oc.createBuffer(1, 0, 8000));
    await t('copyIdx', () => oc.createBuffer(1, 4, 8000).getChannelData(2));
    await t('destChannels', () => { oc.destination.channelCount = 1; return oc.destination.channelCount; });
    await t('twiceRender', async () => { await oc.startRendering(); await oc.startRendering(); });
    await t('decodeBad', async () => { await oc.decodeAudioData(new ArrayBuffer(8)); });
    await t('suspendLate', () => oc.suspend(10));
    return out;
  },
  async audio_context_lifecycle() {
    const ac = new AudioContext();
    const out = { s0: ac.state };
    const evs = [];
    ac.onstatechange = () => evs.push(ac.state);
    await ac.suspend(); out.afterSuspend = ac.state;
    await ac.close(); out.afterClose = ac.state;
    await new Promise((r) => setTimeout(r, 20));
    out.events = evs;
    let e; try { await ac.resume(); } catch (x) { e = x.name; } out.resumeClosed = e;
    const oc = new OfflineAudioContext({ numberOfChannels: 2, length: 256, sampleRate: 8000 });
    const done = new Promise((res) => { oc.oncomplete = (ev) => res([ev.type, ev.renderedBuffer.length, ev.renderedBuffer.numberOfChannels, ev.constructor.name]); });
    out.offState = oc.state;
    const p = oc.startRendering();
    out.rendering = oc.state;
    const buf = await p;
    out.complete = await done;
    out.same = buf.length === oc.length;
    out.finalState = oc.state;
    out.ended = await new Promise((res) => { const o2 = new OfflineAudioContext(1, 1024, 8000); const s = o2.createConstantSource(); s.connect(o2.destination); s.onended = () => res('ended'); s.start(0); s.stop(0.05); o2.startRendering(); });
    return out;
  },
};
