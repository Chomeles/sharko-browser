'use strict';
// Web Audio: the cases of audio_cases.js run in Sharko and are compared with the answers Chromium recorded
// (webgl_golden.json). Rendered samples may differ by 5e-5 (the oscillator tables come from an FFT).
const assert = require('assert');
const { createEnv } = require('../harness');
const cases = require('../audio_cases');
const golden = require('../webgl_golden.json');
const { close } = require('../compare');

// what depends on the autoplay policy / the environment of the recording and therefore legitimately differs
const OWN = {
  // no media pipeline: createMediaElementSource / createMediaStreamSource / createMediaStreamDestination are absent
  audio_surface: (got, want) => {
    got.ctx.state0 = want.ctx.state0;
    for (const n of want.names) if (n[0] === 'AudioContext') n[1] = n[1].split(',').filter((k) => !/^createMedia/.test(k)).join(',');
    return [got, want];
  },
  audio_context_lifecycle: (got, want) => { got.s0 = want.s0; got.events = want.events; return [got, want]; },
};

for (const [name, fn] of Object.entries(cases)) {
  test(`Web Audio: ${name} agrees with Chromium`, async () => {
    const e = await createEnv();
    const src = `(async () => { return JSON.stringify(await (${fn.toString().replace(/^(async\s+)?(\w+)\s*\(/, (m, a) => (a || '') + 'function (')})()); })()`;
    const pr = e.run(src);
    await e.flush(20000);
    const got = JSON.parse(await pr);
    assert.deepStrictEqual(e.errors(), []);
    let want = golden[name];
    assert.ok(want !== undefined && !want.error, `golden answer for ${name}: ${JSON.stringify(want)}`);
    if (OWN[name]) [, want] = OWN[name](got, want);
    close(got, want, name, 5e-5);
  }, { timeout: 60000 });
}

test('Web Audio: the classic OfflineAudioContext fingerprint (triangle 10 kHz through a compressor) is stable and close to Chromium', async () => {
  const e = await createEnv();
  const run = async () => {
    const pr = e.run(`(async () => { const oc = new OfflineAudioContext(1, 44100, 44100); const o = oc.createOscillator(); o.type = 'triangle'; o.frequency.value = 10000;
      const c = oc.createDynamicsCompressor(); c.threshold.value = -50; c.knee.value = 40; c.ratio.value = 12; c.attack.value = 0; c.release.value = 0.25;
      o.connect(c); c.connect(oc.destination); o.start(0); const d = (await oc.startRendering()).getChannelData(0); let s = 0; for (let i = 4500; i < 5000; i++) s += Math.abs(d[i]); return [s, c.reduction]; })()`);
    await e.flush(20000);
    return Array.from(await pr);
  };
  const a = await run(), b = await run();
  assert.deepStrictEqual(a, b, 'deterministic');
  // Chromium 140 (Linux): 124.04347527516074 and a reduction of exactly -19.004104614257812
  assert.ok(Math.abs(a[0] - 124.04347527516074) < 1e-4, `sum ${a[0]}`);
  assert.strictEqual(a[1], -19.004104614257812);
});
