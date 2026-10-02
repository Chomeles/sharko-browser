'use strict';
// WebGL: the cases of webgl_cases.js run in Sharko and are compared with the answers Chromium recorded for
// them (webgl_golden.json, regenerate with test/webgl_golden.js). Pixel values may differ by rounding.
const assert = require('assert');
const { createEnv } = require('../harness');
const cases = require('../webgl_cases');
const prelude = require('../webgl_prelude');
const golden = require('../webgl_golden.json');

const { close } = require('../compare');
// the answers that legitimately differ from Chromium's: what this implementation can honour
const OWN = {
  context_params: (r, g) => { const { highp, lostId, ...rest } = r; void rest; return [r, Object.assign({}, g)]; },
};

for (const [name, fn] of Object.entries(cases)) {
  test(`WebGL: ${name} agrees with Chromium`, async () => {
    const e = await createEnv();
    const src = `(() => { ${prelude}\n return JSON.stringify((${fn.toString().replace(/^(\w+)\s*\(/, 'function (')})()); })()`;
    const got = JSON.parse(e.run(src));
    assert.deepStrictEqual(e.errors(), []);
    const want = golden[name];
    assert.ok(want !== undefined && !want.error, `golden answer for ${name}: ${JSON.stringify(want)}`);
    if (OWN[name]) { const [a, b] = OWN[name](got, want); close(a, b, name); } else close(got, want, name);
  });
}

test('WebGL: the identity is a consistent ANGLE/SwiftShader profile and extensions only list what is implemented', async () => {
  const e = await createEnv();
  const r = JSON.parse(e.run(`(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return JSON.stringify({ vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), before: (() => { const g2 = document.createElement('canvas').getContext('webgl'); return g2.getParameter(0x9246); })(),
      exts: gl.getSupportedExtensions(), attrs: gl.getContextAttributes(), maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), samples: gl.getParameter(gl.SAMPLES), ctor: gl.constructor.name, tag: String(gl), canvasSame: gl.canvas.constructor.name });
  })()`));
  assert.strictEqual(r.vendor, 'Google Inc. (Google)');
  assert.match(r.renderer, /^ANGLE \(Google, Vulkan 1\.3\.0 \(SwiftShader Device \(Subzero\)/);
  assert.strictEqual(r.maxTex, 8192);
  assert.strictEqual(r.samples, 0, 'no multisampling is reported because none is implemented');
  assert.strictEqual(r.attrs.antialias, false);
  assert.ok(r.exts.includes('WEBGL_debug_renderer_info') && r.exts.includes('OES_texture_float') && !r.exts.includes('WEBGL_compressed_texture_s3tc'));
  assert.strictEqual(r.ctor, 'WebGLRenderingContext');
  assert.strictEqual(r.tag, '[object WebGLRenderingContext]');
  assert.strictEqual(r.before, null, 'UNMASKED_RENDERER_WEBGL needs the extension to have been enabled on that context');
});

test('WebGL: one context type per canvas; getContext variants and illegal constructors', async () => {
  const e = await createEnv();
  const r = JSON.parse(e.run(`(() => {
    const c = document.createElement('canvas');
    const a = c.getContext('webgl'); const b = c.getContext('experimental-webgl'); const c2 = c.getContext('webgl2'); const d = c.getContext('2d');
    const o = document.createElement('canvas'); const g2 = o.getContext('webgl2'); const none = o.getContext('webgl');
    let illegal; try { new WebGLRenderingContext(); } catch (err) { illegal = err.constructor.name + ':' + err.message; }
    let illegal2; try { new WebGLBuffer(); } catch (err) { illegal2 = err.constructor.name; }
    const p = document.createElement('canvas'); const first2d = p.getContext('2d'); const glAfter2d = p.getContext('webgl');
    return JSON.stringify({ same: a === b, c2: c2, d: d, g2: Object.prototype.toString.call(g2), none, illegal, illegal2, glAfter2d, first2d: !!first2d, canvasBack: a.canvas === c, w: a.drawingBufferWidth, h: a.drawingBufferHeight });
  })()`));
  assert.strictEqual(r.same, true);
  assert.strictEqual(r.c2, null);
  assert.strictEqual(r.d, null);
  assert.strictEqual(r.g2, '[object WebGL2RenderingContext]');
  assert.strictEqual(r.none, null);
  assert.strictEqual(r.illegal, 'TypeError:Illegal constructor');
  assert.strictEqual(r.illegal2, 'TypeError');
  assert.strictEqual(r.glAfter2d, null);
  assert.strictEqual(r.first2d, true);
  assert.strictEqual(r.canvasBack, true);
  assert.deepStrictEqual([r.w, r.h], [300, 150]);
});

test('WebGL: rendering reaches the canvas (toDataURL, resize clears) and is cleared after the frame unless preserved', async () => {
  const e = await createEnv();
  e.run(`
    var c = document.createElement('canvas'); c.width = 8; c.height = 8;
    var gl = c.getContext('webgl', { preserveDrawingBuffer: false });
    gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    var before = c.toDataURL();
    var px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); var syncRead = Array.from(px);
  `);
  assert.deepStrictEqual(Array.from(e.run('syncRead')), [255, 0, 0, 255]);
  await e.flush();
  e.run(`var px2 = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px2); var afterFrame = Array.from(px2); var presented = c.toDataURL();`);
  assert.deepStrictEqual(Array.from(e.run('afterFrame')), [0, 0, 0, 0], 'the drawing buffer is cleared after compositing');
  assert.strictEqual(e.run('presented'), e.run('before'), 'the canvas keeps showing the last frame (Chromium would encode the cleared buffer)');
  e.run(`c.width = 4; var dims = [gl.drawingBufferWidth, gl.drawingBufferHeight, gl.getParameter(gl.VIEWPORT).join()];`);
  assert.deepStrictEqual(Array.from(e.run('dims')), [4, 8, '0,0,8,8']);
});

test('WebGL: context loss and restore dispatch events and invalidate objects', async () => {
  const e = await createEnv();
  e.run(`
    var c = document.createElement('canvas'); var gl = c.getContext('webgl'); var log = [];
    c.addEventListener('webglcontextlost', (ev) => { log.push('lost'); ev.preventDefault(); });
    c.addEventListener('webglcontextrestored', () => log.push('restored'));
    var ext = gl.getExtension('WEBGL_lose_context'); var buf = gl.createBuffer();
    ext.loseContext();
    var lostNow = [gl.isContextLost(), gl.createBuffer(), gl.getError() === gl.CONTEXT_LOST_WEBGL, gl.getError()];
  `);
  assert.deepStrictEqual(Array.from(e.run('lostNow')), [true, null, true, 0]);
  await e.flush();
  e.run('ext.restoreContext()');
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('log')), ['lost', 'restored']);
  assert.strictEqual(e.run('gl.isContextLost()'), false);
  assert.strictEqual(e.run('gl.isBuffer(buf)'), false, 'objects of the lost context are invalid');
  assert.strictEqual(e.run('gl.getExtension("WEBGL_lose_context") !== ext'), true, 'extensions are re-created');
});

test('WebGL: two identical frames hash identically (stable canvas fingerprint)', async () => {
  const e = await createEnv();
  const urls = JSON.parse(e.run(`(() => { ${prelude}
    const draw = () => { const gl = ctx('webgl', 64, 32, { preserveDrawingBuffer: true });
      const p = prog(gl, 'attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }', 'precision mediump float; varying vec2 v; void main(){ gl_FragColor = vec4(v * 0.5 + 0.5, sin(v.x * 9.0) * 0.5 + 0.5, 1.0); }');
      gl.useProgram(p); quad(gl, 0, [-0.9, -0.9, 0.9, -0.8, 0.0, 0.9]); gl.clearColor(0.1, 0.2, 0.3, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3); return gl.canvas.toDataURL(); };
    return JSON.stringify([draw(), draw()]); })()`));
  assert.strictEqual(urls[0], urls[1]);
  assert.ok(urls[0].startsWith('data:image/png'));
});
