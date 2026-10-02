'use strict';
// WebGL cases that run unchanged in Sharko's JS layer (tests/62_webgl.test.js) and in Chromium
// (tools: `node test/webgl_golden.js` records Chromium's answers into webgl_golden.json). Every case is a
// plain function returning JSON-able data; `ctx(name)` creates a context without antialiasing (Chromium
// would otherwise multisample). Pixel values are compared with a small tolerance, everything else exactly.
module.exports = {
  tri_flat() {
    const gl = ctx('webgl', 16, 16);
    const p = prog(gl, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }', 'precision mediump float; void main(){ gl_FragColor = vec4(1.0, 0.5, 0.25, 1.0); }');
    gl.useProgram(p);
    quad(gl, 0, [-1, -1, 1, -1, 0, 1]);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { px: [rd(gl, 8, 4), rd(gl, 8, 12), rd(gl, 1, 14), rd(gl, 15, 14)], err: gl.getError() };
  },
  tri_varying() {
    const gl = ctx('webgl', 16, 16);
    const p = prog(gl, 'attribute vec2 p; attribute vec3 c; varying vec3 v; void main(){ v = c; gl_Position = vec4(p, 0.0, 1.0); }', 'precision mediump float; varying vec3 v; void main(){ gl_FragColor = vec4(v, 1.0); }');
    gl.useProgram(p);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, 0, 0, 1, -1, 0, 1, 0, 0, 1, 0, 0, 1]), gl.STATIC_DRAW);
    const lp = gl.getAttribLocation(p, 'p'), lc = gl.getAttribLocation(p, 'c');
    gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 3, gl.FLOAT, false, 20, 8);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { px: [rd(gl, 3, 2), rd(gl, 12, 2), rd(gl, 8, 12), rd(gl, 8, 6)], err: gl.getError() };
  },
  depth_blend() {
    const gl = ctx('webgl', 8, 8, { depth: true });
    const p = prog(gl, 'attribute vec3 p; void main(){ gl_Position = vec4(p, 1.0); }', 'precision mediump float; uniform vec4 c; void main(){ gl_FragColor = c; }');
    gl.useProgram(p);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0.5, 3, -1, 0.5, -1, 3, 0.5, -1, -1, -0.5, 3, -1, -0.5, -1, 3, -0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const c = gl.getUniformLocation(p, 'c');
    gl.clearColor(0, 0, 0, 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    gl.uniform4f(c, 1, 0, 0, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);       // far triangle (red)
    gl.uniform4f(c, 0, 1, 0, 1); gl.drawArrays(gl.TRIANGLES, 3, 3);       // near triangle (green) wins
    const a = rd(gl, 4, 4);
    gl.uniform4f(c, 0, 0, 1, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);       // far again: rejected
    const b2 = rd(gl, 4, 4);
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4f(c, 1, 1, 1, 0.5); gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { first: a, rejected: b2, blended: rd(gl, 4, 4), err: gl.getError() };
  },
  cull_scissor() {
    const gl = ctx('webgl', 8, 8);
    const p = prog(gl, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }', 'precision mediump float; void main(){ gl_FragColor = vec4(1.0); }');
    gl.useProgram(p);
    quad(gl, 0, [-1, -1, 3, -1, -1, 3]); // counter-clockwise
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const back = rd(gl, 4, 4);
    gl.cullFace(gl.FRONT); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const front = rd(gl, 4, 4);
    gl.disable(gl.CULL_FACE); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(2, 2, 3, 3); gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { back, front, inside: rd(gl, 3, 3), outside: rd(gl, 6, 6), edge: [rd(gl, 1, 3), rd(gl, 2, 3), rd(gl, 4, 3), rd(gl, 5, 3)] };
  },
  texture_filters() {
    const gl = ctx('webgl', 8, 4);
    const p = prog(gl, 'attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }', 'precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, vec2(uv.x * 2.0 - 0.5, uv.y)); }');
    gl.useProgram(p);
    quad(gl, 0, [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));
    gl.uniform1i(gl.getUniformLocation(p, 't'), 0);
    const out = {};
    for (const [name, filter, wrap] of [['nearest_clamp', gl.NEAREST, gl.CLAMP_TO_EDGE], ['linear_clamp', gl.LINEAR, gl.CLAMP_TO_EDGE], ['nearest_repeat', gl.NEAREST, gl.REPEAT], ['nearest_mirror', gl.NEAREST, gl.MIRRORED_REPEAT]]) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 6);
      out[name] = [0, 1, 2, 3, 4, 5, 6, 7].map((x) => rd(gl, x, 0));
    }
    out.err = gl.getError();
    return out;
  },
  mipmaps_cube() {
    const gl = ctx('webgl', 4, 4);
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) { data.set([i < 8 ? 255 : 0, 0, i < 8 ? 0 : 255, 255], i * 4); }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
    const p = prog(gl, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }', 'precision mediump float; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, gl_FragCoord.xy / 4.0); }');
    gl.useProgram(p); quad(gl, 0, [-1, -1, 3, -1, -1, 3]);
    gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const lvl0 = [rd(gl, 0, 3), rd(gl, 0, 0)];
    const c = gl.createTexture(); gl.bindTexture(gl.TEXTURE_CUBE_MAP, c);
    const faces = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
    for (let f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...faces[f], 255]));
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const p2 = prog(gl, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }', 'precision mediump float; uniform samplerCube t; uniform vec3 d; void main(){ gl_FragColor = textureCube(t, d); }');
    gl.useProgram(p2); quad(gl, 0, [-1, -1, 3, -1, -1, 3]);
    const dirs = [[1, 0.1, 0.2], [-1, 0.1, 0.2], [0.1, 1, 0.2], [0.1, -1, 0.2], [0.1, 0.2, 1], [0.1, 0.2, -1]];
    const cube = dirs.map((d) => { gl.uniform3f(gl.getUniformLocation(p2, 'd'), d[0], d[1], d[2]); gl.drawArrays(gl.TRIANGLES, 0, 3); return rd(gl, 1, 1); });
    return { lvl0, cube, err: gl.getError() };
  },
  errors() {
    const gl = ctx('webgl', 4, 4);
    const out = [];
    const t = (f) => { f(); out.push(gl.getError()); };
    t(() => gl.enable(0x1234));
    t(() => gl.bindBuffer(0x1234, null));
    t(() => gl.bufferData(gl.ARRAY_BUFFER, 4, gl.STATIC_DRAW));
    t(() => gl.createShader(0x1234));
    t(() => gl.viewport(0, 0, -1, 1));
    t(() => gl.drawArrays(gl.TRIANGLES, 0, 3));
    t(() => gl.drawArrays(0x1234, 0, 3));
    t(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)));
    t(() => gl.activeTexture(gl.TEXTURE0 + 999));
    t(() => gl.getParameter(0x1234));
    t(() => gl.uniform1f(null, 1));
    t(() => gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer()));
    t(() => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)));
    t(() => gl.useProgram(gl.createProgram()));
    t(() => gl.lineWidth(-1));
    t(() => gl.blendFunc(gl.CONSTANT_COLOR, gl.CONSTANT_ALPHA));
    t(() => gl.stencilMask(1));
    return out;
  },
  context_params() {
    const gl = ctx('webgl', 4, 4);
    const p = (n) => { const v = gl.getParameter(gl[n]); return v !== null && typeof v === 'object' ? Array.from(v) : v; };
    const out = {};
    for (const n of ['VERSION', 'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER', 'MAX_VERTEX_ATTRIBS', 'MAX_TEXTURE_IMAGE_UNITS', 'DEPTH_BITS', 'STENCIL_BITS', 'RED_BITS', 'ALPHA_BITS', 'VIEWPORT', 'SCISSOR_BOX', 'COLOR_CLEAR_VALUE',
      'DEPTH_RANGE', 'ALIASED_LINE_WIDTH_RANGE', 'BLEND_EQUATION_RGB', 'FRONT_FACE', 'CULL_FACE_MODE', 'UNPACK_ALIGNMENT', 'COLOR_WRITEMASK', 'IMPLEMENTATION_COLOR_READ_FORMAT', 'IMPLEMENTATION_COLOR_READ_TYPE']) out[n] = p(n);
    out.ext = gl.getSupportedExtensions().includes('WEBGL_debug_renderer_info');
    out.attrs = Object.keys(gl.getContextAttributes());
    out.lostId = Object.prototype.toString.call(gl);
    const f = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    out.highp = [f.rangeMin, f.rangeMax, f.precision];
    return out;
  },
  webgl2_basics() {
    const gl = ctx('webgl2', 8, 8);
    const p = prog(gl, '#version 300 es\nlayout(location=0) in vec2 p; layout(location=1) in vec4 col; flat out vec4 v; out vec2 uv; void main(){ v = col; uv = p; gl_Position = vec4(p, 0.0, 1.0); }',
      '#version 300 es\nprecision highp float; flat in vec4 v; in vec2 uv; layout(location=0) out vec4 o0; layout(location=1) out vec4 o1; void main(){ o0 = v; o1 = vec4(uv * 0.5 + 0.5, 0.0, 1.0); }');
    gl.useProgram(p);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, 0, 0, 1, 3, -1, 0, 1, 0, 1, -1, 3, 0, 0, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const tex = [0, 1].map((i) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 8, 8); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0); return t; });
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]); gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = { status };
    const px = new Uint8Array(4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); out.o0 = Array.from(px);
    gl.readBuffer(gl.COLOR_ATTACHMENT1); gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); out.o1 = Array.from(px);
    // integer texture + texelFetch
    const it = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, it);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, 2, 1, 0, gl.RED_INTEGER, gl.INT, new Int32Array([7, -9]));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const p2 = prog(gl, '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }', '#version 300 es\nprecision highp float; precision highp isampler2D; uniform isampler2D t; out vec4 o; void main(){ ivec4 a = texelFetch(t, ivec2(0, 0), 0); ivec4 b = texelFetch(t, ivec2(1, 0), 0); o = vec4(float(a.r) / 10.0, float(-b.r) / 10.0, float(textureSize(t, 0).x) / 10.0, 1.0); }');
    gl.useProgram(p2); gl.bindVertexArray(null);
    const bb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(p2, 't'), 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);
    out.ints = rd(gl, 3, 3);
    out.err = gl.getError();
    return out;
  },
  instanced_elements() {
    const gl = ctx('webgl2', 8, 4);
    const p = prog(gl, '#version 300 es\nin vec2 p; in float off; void main(){ gl_Position = vec4(p + vec2(off, 0.0), 0.0, 1.0); }', '#version 300 es\nprecision highp float; out vec4 o; void main(){ o = vec4(1.0, 1.0, 1.0, 1.0); }');
    gl.useProgram(p);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.2, -0.5, 0.2, -0.5, 0.2, 0.5, -0.2, 0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const o = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, o);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, 0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, 2);
    return { row: [0, 1, 2, 3, 4, 5, 6, 7].map((x) => rd(gl, x, 2)[0]), err: gl.getError() };
  },
  stencil_masks() {
    const gl = ctx('webgl', 4, 4, { stencil: true });
    const p = prog(gl, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }', 'precision mediump float; uniform vec4 c; void main(){ gl_FragColor = c; }');
    gl.useProgram(p); quad(gl, 0, [-1, -1, 3, -1, -1, 3]);
    const c = gl.getUniformLocation(p, 'c');
    gl.clearColor(0, 0, 0, 1); gl.clearStencil(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 3, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.uniform4f(c, 1, 0, 0, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.stencilFunc(gl.EQUAL, 3, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4f(c, 0, 1, 0, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const eq = rd(gl, 2, 2);
    gl.stencilFunc(gl.NOTEQUAL, 3, 0xff); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4f(c, 0, 0, 1, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { eq, ne: rd(gl, 2, 2), err: gl.getError() };
  },
  float_fbo() {
    const gl = ctx('webgl2', 4, 4);
    gl.getExtension('EXT_color_buffer_float');
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 2, 0, gl.RGBA, gl.FLOAT, null);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const p = prog(gl, '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }', '#version 300 es\nprecision highp float; out vec4 o; void main(){ o = vec4(1.5, -2.0, 1000.25, 0.125); }');
    gl.useProgram(p); quad(gl, 0, [-1, -1, 3, -1, -1, 3]); gl.viewport(0, 0, 2, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const f = new Float32Array(4); gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.FLOAT, f);
    return { f: Array.from(f), status: gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, err: gl.getError() };
  },
  glsl_math() {
    const gl = ctx('webgl', 4, 4);
    const fsrc = 'precision highp float; uniform vec4 u; mat3 m = mat3(2.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 4.0); struct S { vec3 a; float b; };'
      + ' float f(S s) { return dot(s.a, vec3(1.0)) + s.b; }'
      + ' void main(){ S s = S(vec3(1.0, 2.0, 3.0), 4.0); vec3 v = m * vec3(1.0, 1.0, 1.0); float r = f(s) + length(v) + mod(7.5, 2.0) + pow(2.0, 3.0) + floor(-1.5) + sign(-3.0) + clamp(u.x, 0.0, 1.0) + smoothstep(0.0, 1.0, 0.5);'
      + ' vec2 q = vec2(1.0, 2.0).yx; q += vec2(0.5); int i = 5; i /= 2; i = i * 3 + int(u.y);'
      + ' for (int k = 0; k < 4; k++) { if (k == 2) continue; r += float(k); }'
      + ' gl_FragColor = vec4(r / 40.0, q.x / 4.0, float(i) / 10.0, 1.0); }';
    const p = prog(gl, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }', fsrc);
    gl.useProgram(p); quad(gl, 0, [-1, -1, 3, -1, -1, 3]);
    gl.uniform4f(gl.getUniformLocation(p, 'u'), 2, 1, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { px: rd(gl, 2, 2), err: gl.getError() };
  },
  compile_errors() {
    const gl = ctx('webgl', 4, 4);
    const bad = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return [gl.getShaderParameter(s, gl.COMPILE_STATUS), gl.getShaderInfoLog(s).split('\n')[0].replace(/^ERROR: 0:\d+: /, '').split(' : ')[0] !== undefined]; };
    const out = {};
    out.syntax = bad(gl.VERTEX_SHADER, 'void main( { }')[0];
    out.undeclared = bad(gl.VERTEX_SHADER, 'void main(){ gl_Position = vec4(x); }')[0];
    out.noPrecision = bad(gl.FRAGMENT_SHADER, 'varying float v; void main(){ gl_FragColor = vec4(v); }')[0];
    out.ok = bad(gl.FRAGMENT_SHADER, 'precision mediump float; varying float v; void main(){ gl_FragColor = vec4(v); }')[0];
    out.mismatch = bad(gl.VERTEX_SHADER, 'void main(){ float f = 1; gl_Position = vec4(f); }')[0];
    const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, 'varying float a; void main(){ a = 1.0; gl_Position = vec4(0.0); }'); gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, 'precision mediump float; varying vec2 a; void main(){ gl_FragColor = vec4(a, 0.0, 1.0); }'); gl.compileShader(fs);
    const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    out.link = gl.getProgramParameter(pr, gl.LINK_STATUS);
    return out;
  },
  uniform_reflection() {
    const gl = ctx('webgl', 4, 4);
    const p = prog(gl, 'attribute vec4 a; attribute vec2 b; uniform mat4 m; uniform vec3 arr[2]; void main(){ gl_Position = m * a + vec4(arr[1], 0.0) + vec4(b, 0.0, 0.0); }',
      'precision mediump float; uniform sampler2D s; uniform vec4 unused; struct L { float x; vec2 y; }; uniform L l; void main(){ gl_FragColor = texture2D(s, l.y) * l.x; }');
    const out = { attrs: [], uniforms: [] };
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) { const a = gl.getActiveAttrib(p, i); out.attrs.push([a.name, a.size, a.type]); }
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) { const a = gl.getActiveUniform(p, i); out.uniforms.push([a.name, a.size, a.type]); }
    out.sorted = out.uniforms.map((u) => u[0]).sort();
    out.locs = [gl.getUniformLocation(p, 'arr[1]') !== null, gl.getUniformLocation(p, 'unused') === null, gl.getUniformLocation(p, 'l.y') !== null, gl.getUniformLocation(p, 'nope') === null];
    out.attrLocs = [gl.getAttribLocation(p, 'a') >= 0, gl.getAttribLocation(p, 'nope')];
    return out;
  },
};
