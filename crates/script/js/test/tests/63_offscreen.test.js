'use strict';
// OffscreenCanvas, ImageBitmap and createImageBitmap: the cases of offscreen_cases.js compared with the answers
// Chromium recorded (webgl_golden.json).
const assert = require('assert');
const { createEnv } = require('../harness');
const cases = require('../offscreen_cases');
const prelude = require('../webgl_prelude');
const golden = require('../webgl_golden.json');
const { close } = require('../compare');

// the `_2d` cases need the real 2D rasterizer (the mock native has none): they run in crates/script/tests/js_layer.rs
for (const [name, fn] of Object.entries(cases)) {
  if (name.endsWith('_2d')) continue;
  test(`OffscreenCanvas: ${name} agrees with Chromium`, async () => {
    const e = await createEnv();
    const src = `(async () => { ${prelude}\n return JSON.stringify(await (${fn.toString().replace(/^(async\s+)?(\w+)\s*\(/, (m, a) => (a || '') + 'function (')})()); })()`;
    const pr = e.run(src);
    await e.flush(5000);
    const got = JSON.parse(await pr);
    assert.deepStrictEqual(e.errors(), []);
    const want = golden[name];
    assert.ok(want !== undefined && !want.error, `golden answer for ${name}: ${JSON.stringify(want)}`);
    close(got, want, name);
  });
}

test('OffscreenCanvas: interfaces, illegal constructors, argument checks', async () => {
  const e = await createEnv();
  const r = JSON.parse(e.run(`(() => {
    const out = {};
    out.types = ['OffscreenCanvas', 'OffscreenCanvasRenderingContext2D', 'ImageBitmap', 'ImageBitmapRenderingContext', 'createImageBitmap'].map((n) => n + ':' + typeof globalThis[n]);
    try { new OffscreenCanvas(1); } catch (err) { out.few = err.constructor.name; }
    try { new ImageBitmap(); } catch (err) { out.illegal = err.constructor.name; }
    const oc = new OffscreenCanvas(2.9, -1);
    out.dims = [oc.width, oc.height];
    out.handlers = ['oncontextlost', 'oncontextrestored'].map((k) => k in oc);
    out.len = [OffscreenCanvas.length, createImageBitmap.length];
    return JSON.stringify(out);
  })()`));
  assert.deepStrictEqual(r.types, ['OffscreenCanvas:function', 'OffscreenCanvasRenderingContext2D:function', 'ImageBitmap:function', 'ImageBitmapRenderingContext:function', 'createImageBitmap:function']);
  assert.strictEqual(r.few, 'TypeError');
  assert.strictEqual(r.illegal, 'TypeError');
  assert.deepStrictEqual(r.dims, [2, 0]);
  assert.deepStrictEqual(r.handlers, [true, true]);
});
