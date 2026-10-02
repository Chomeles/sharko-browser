// 37_webgl_api.js — WebGL API, part 1: state, buffers, vertex arrays, shaders, programs, uniforms, getParameter.
// The methods are collected in `M` (L.glInternals.M) and installed on the context classes by 3c_webgl_ctx.js.
(function (L) {
  'use strict';
  const G = L.glInternals;
  const { C, C2, C2ALL, E, LIM, OBJ, wrapObj, rec, isObjOf, gerr, glenum, glint, glfloat, glbool, argsReq, stOf, classes } = G;
  const { WebGLBuffer, WebGLProgram, WebGLShader, WebGLUniformLocation, WebGLActiveInfo, WebGLShaderPrecisionFormat, WebGLVertexArrayObject } = classes;
  const M = {};      // methods shared by both contexts
  const M2 = {};     // WebGL2 only
  const M1 = {};     // WebGL1 only
  G.M = M; G.M1 = M1; G.M2 = M2;
  const IF1 = 'WebGLRenderingContext';
  const lostNull = (S) => S.lost;
  const markDirty = (S) => { S.dirty = true; if (G.schedulePresent) G.schedulePresent(S); };
  G.markDirty = markDirty;

  const sizedInt = { [C.BYTE]: 1, [C.UNSIGNED_BYTE]: 1, [C.SHORT]: 2, [C.UNSIGNED_SHORT]: 2, [C.INT]: 4, [C.UNSIGNED_INT]: 4, [C.FLOAT]: 4 };

  // ---------------------------------------------------------------------------------------
  // enable / state
  // ---------------------------------------------------------------------------------------
  function capGet(S, cap) {
    switch (cap) {
      case C.BLEND: return S.blend.enabled; case C.CULL_FACE: return S.cull; case C.DEPTH_TEST: return S.depth.enabled;
      case C.DITHER: return S.dither; case C.POLYGON_OFFSET_FILL: return S.polyOffset; case C.SAMPLE_ALPHA_TO_COVERAGE: return S.sampleAlpha;
      case C.SAMPLE_COVERAGE: return S.sampleCoverage; case C.SCISSOR_TEST: return S.scissorTest; case C.STENCIL_TEST: return S.stencil.enabled;
      case C2.RASTERIZER_DISCARD: return S.rasterizerDiscard; default: return undefined;
    }
  }
  function capSet(S, cap, v) {
    switch (cap) {
      case C.BLEND: S.blend.enabled = v; return true; case C.CULL_FACE: S.cull = v; return true; case C.DEPTH_TEST: S.depth.enabled = v; return true;
      case C.DITHER: S.dither = v; return true; case C.POLYGON_OFFSET_FILL: S.polyOffset = v; return true; case C.SAMPLE_ALPHA_TO_COVERAGE: S.sampleAlpha = v; return true;
      case C.SAMPLE_COVERAGE: S.sampleCoverage = v; return true; case C.SCISSOR_TEST: S.scissorTest = v; return true; case C.STENCIL_TEST: S.stencil.enabled = v; return true;
      default: return false;
    }
  }
  M.enable = function enable(cap) {
    argsReq(IF1, 'enable', 1, arguments.length);
    const S = stOf(this); if (S.lost) return;
    cap = glenum(cap);
    if (cap === C2.RASTERIZER_DISCARD && S.ver === 2) { S.rasterizerDiscard = true; return; }
    if (!capSet(S, cap, true)) gerr(S, C.INVALID_ENUM);
  };
  M.disable = function disable(cap) {
    argsReq(IF1, 'disable', 1, arguments.length);
    const S = stOf(this); if (S.lost) return;
    cap = glenum(cap);
    if (cap === C2.RASTERIZER_DISCARD && S.ver === 2) { S.rasterizerDiscard = false; return; }
    if (!capSet(S, cap, false)) gerr(S, C.INVALID_ENUM);
  };
  M.isEnabled = function isEnabled(cap) {
    argsReq(IF1, 'isEnabled', 1, arguments.length);
    const S = stOf(this); if (S.lost) return false;
    cap = glenum(cap);
    if (cap === C2.RASTERIZER_DISCARD && S.ver === 2) return S.rasterizerDiscard;
    const v = capGet(S, cap);
    if (v === undefined) { gerr(S, C.INVALID_ENUM); return false; }
    return v;
  };
  M.blendColor = function blendColor(r, g, b, a) { argsReq(IF1, 'blendColor', 4, arguments.length); const S = stOf(this); if (S.lost) return; S.blend.color = [r, g, b, a].map(glfloat); };
  const BLEND_EQ = [C.FUNC_ADD, C.FUNC_SUBTRACT, C.FUNC_REVERSE_SUBTRACT];
  const eqOk = (S, m) => BLEND_EQ.includes(m) || ((S.ver === 2 || S.exts.has('EXT_blend_minmax')) && (m === C2.MIN || m === C2.MAX));
  M.blendEquation = function blendEquation(mode) {
    argsReq(IF1, 'blendEquation', 1, arguments.length);
    const S = stOf(this); if (S.lost) return; mode = glenum(mode);
    if (!eqOk(S, mode)) return gerr(S, C.INVALID_ENUM);
    S.blend.rgb = S.blend.alpha = mode;
  };
  M.blendEquationSeparate = function blendEquationSeparate(a, b) {
    argsReq(IF1, 'blendEquationSeparate', 2, arguments.length);
    const S = stOf(this); if (S.lost) return; a = glenum(a); b = glenum(b);
    if (!eqOk(S, a) || !eqOk(S, b)) return gerr(S, C.INVALID_ENUM);
    S.blend.rgb = a; S.blend.alpha = b;
  };
  const BLEND_FACTORS = new Set([C.ZERO, C.ONE, C.SRC_COLOR, C.ONE_MINUS_SRC_COLOR, C.DST_COLOR, C.ONE_MINUS_DST_COLOR, C.SRC_ALPHA, C.ONE_MINUS_SRC_ALPHA, C.DST_ALPHA,
    C.ONE_MINUS_DST_ALPHA, C.CONSTANT_COLOR, C.ONE_MINUS_CONSTANT_COLOR, C.CONSTANT_ALPHA, C.ONE_MINUS_CONSTANT_ALPHA, C.SRC_ALPHA_SATURATE]);
  const isConstColor = (f) => f === C.CONSTANT_COLOR || f === C.ONE_MINUS_CONSTANT_COLOR;
  const isConstAlpha = (f) => f === C.CONSTANT_ALPHA || f === C.ONE_MINUS_CONSTANT_ALPHA;
  function blendFuncImpl(S, sr, dr, sa, da) {
    sr = glenum(sr); dr = glenum(dr); sa = glenum(sa); da = glenum(da);
    if (![sr, dr, sa, da].every((f) => BLEND_FACTORS.has(f)) || dr === C.SRC_ALPHA_SATURATE || da === C.SRC_ALPHA_SATURATE) return gerr(S, C.INVALID_ENUM);
    if ((isConstColor(sr) && isConstAlpha(dr)) || (isConstAlpha(sr) && isConstColor(dr))) return gerr(S, C.INVALID_OPERATION);
    S.blend.srcRGB = sr; S.blend.dstRGB = dr; S.blend.srcA = sa; S.blend.dstA = da;
  }
  M.blendFunc = function blendFunc(s, d) { argsReq(IF1, 'blendFunc', 2, arguments.length); const S = stOf(this); if (!S.lost) blendFuncImpl(S, s, d, s, d); };
  M.blendFuncSeparate = function blendFuncSeparate(a, b, c, d) { argsReq(IF1, 'blendFuncSeparate', 4, arguments.length); const S = stOf(this); if (!S.lost) blendFuncImpl(S, a, b, c, d); };
  M.clearColor = function clearColor(r, g, b, a) { argsReq(IF1, 'clearColor', 4, arguments.length); const S = stOf(this); if (!S.lost) S.clearColor = [r, g, b, a].map(glfloat); };
  M.clearDepth = function clearDepth(d) { argsReq(IF1, 'clearDepth', 1, arguments.length); const S = stOf(this); if (!S.lost) S.clearDepth = glfloat(d); };
  M.clearStencil = function clearStencil(s) { argsReq(IF1, 'clearStencil', 1, arguments.length); const S = stOf(this); if (!S.lost) S.clearStencil = glint(s); };
  M.colorMask = function colorMask(r, g, b, a) { argsReq(IF1, 'colorMask', 4, arguments.length); const S = stOf(this); if (!S.lost) S.colorMask = [!!r, !!g, !!b, !!a]; };
  M.cullFace = function cullFace(m) {
    argsReq(IF1, 'cullFace', 1, arguments.length); const S = stOf(this); if (S.lost) return; m = glenum(m);
    if (m !== C.FRONT && m !== C.BACK && m !== C.FRONT_AND_BACK) return gerr(S, C.INVALID_ENUM);
    S.cullMode = m;
  };
  const FUNCS = [C.NEVER, C.LESS, C.EQUAL, C.LEQUAL, C.GREATER, C.NOTEQUAL, C.GEQUAL, C.ALWAYS];
  M.depthFunc = function depthFunc(f) {
    argsReq(IF1, 'depthFunc', 1, arguments.length); const S = stOf(this); if (S.lost) return; f = glenum(f);
    if (!FUNCS.includes(f)) return gerr(S, C.INVALID_ENUM);
    S.depth.func = f;
  };
  M.depthMask = function depthMask(f) { argsReq(IF1, 'depthMask', 1, arguments.length); const S = stOf(this); if (!S.lost) S.depthMask = !!f; };
  M.depthRange = function depthRange(n, f) {
    argsReq(IF1, 'depthRange', 2, arguments.length); const S = stOf(this); if (S.lost) return; n = glfloat(n); f = glfloat(f);
    if (n > f) return gerr(S, C.INVALID_OPERATION);
    S.depth.near = Math.min(Math.max(n, 0), 1); S.depth.far = Math.min(Math.max(f, 0), 1);
  };
  M.frontFace = function frontFace(m) {
    argsReq(IF1, 'frontFace', 1, arguments.length); const S = stOf(this); if (S.lost) return; m = glenum(m);
    if (m !== C.CW && m !== C.CCW) return gerr(S, C.INVALID_ENUM);
    S.frontFace = m;
  };
  M.hint = function hint(t, m) {
    argsReq(IF1, 'hint', 2, arguments.length); const S = stOf(this); if (S.lost) return; t = glenum(t); m = glenum(m);
    if (m !== C.DONT_CARE && m !== C.FASTEST && m !== C.NICEST) return gerr(S, C.INVALID_ENUM);
    if (t === C.GENERATE_MIPMAP_HINT) S.hints.genMipmap = m;
    else if (t === C2.FRAGMENT_SHADER_DERIVATIVE_HINT && (S.ver === 2 || S.exts.has('OES_standard_derivatives'))) S.hints.derivative = m;
    else gerr(S, C.INVALID_ENUM);
  };
  M.lineWidth = function lineWidth(w) { argsReq(IF1, 'lineWidth', 1, arguments.length); const S = stOf(this); if (S.lost) return; w = Number(w); if (!(w > 0)) return gerr(S, C.INVALID_VALUE); S.lineWidth = Math.fround(w); };
  M.polygonOffset = function polygonOffset(f, u) { argsReq(IF1, 'polygonOffset', 2, arguments.length); const S = stOf(this); if (S.lost) return; S.polyFactor = glfloat(f); S.polyUnits = glfloat(u); };
  M.sampleCoverage = function sampleCoverage(v, inv) { argsReq(IF1, 'sampleCoverage', 2, arguments.length); const S = stOf(this); if (S.lost) return; S.sampleCoverageValue = Math.min(Math.max(glfloat(v), 0), 1); S.sampleCoverageInvert = !!inv; };
  M.scissor = function scissor(x, y, w, h) {
    argsReq(IF1, 'scissor', 4, arguments.length); const S = stOf(this); if (S.lost) return;
    [x, y, w, h] = [x, y, w, h].map(glint);
    if (w < 0 || h < 0) return gerr(S, C.INVALID_VALUE);
    S.scissor = [x, y, w, h];
  };
  M.viewport = function viewport(x, y, w, h) {
    argsReq(IF1, 'viewport', 4, arguments.length); const S = stOf(this); if (S.lost) return;
    [x, y, w, h] = [x, y, w, h].map(glint);
    if (w < 0 || h < 0) return gerr(S, C.INVALID_VALUE);
    S.viewport = [x, y, Math.min(w, LIM.maxViewport), Math.min(h, LIM.maxViewport)];
  };
  const FACE = (f) => f === C.FRONT || f === C.BACK || f === C.FRONT_AND_BACK;
  M.stencilFunc = function stencilFunc(f, r, m) { argsReq(IF1, 'stencilFunc', 3, arguments.length); return M.stencilFuncSeparate.call(this, C.FRONT_AND_BACK, f, r, m); };
  M.stencilFuncSeparate = function stencilFuncSeparate(face, f, r, m) {
    argsReq(IF1, 'stencilFuncSeparate', 4, arguments.length); const S = stOf(this); if (S.lost) return;
    face = glenum(face); f = glenum(f); r = glint(r); m = glenum(m);
    if (!FACE(face) || !FUNCS.includes(f)) return gerr(S, C.INVALID_ENUM);
    for (const i of [0, 1]) if (face === C.FRONT_AND_BACK || face === (i === 0 ? C.FRONT : C.BACK)) { S.stencil.func[i] = f; S.stencil.ref[i] = r; S.stencil.vmask[i] = m; }
  };
  M.stencilMask = function stencilMask(m) { argsReq(IF1, 'stencilMask', 1, arguments.length); return M.stencilMaskSeparate.call(this, C.FRONT_AND_BACK, m); };
  M.stencilMaskSeparate = function stencilMaskSeparate(face, m) {
    argsReq(IF1, 'stencilMaskSeparate', 2, arguments.length); const S = stOf(this); if (S.lost) return; face = glenum(face);
    if (!FACE(face)) return gerr(S, C.INVALID_ENUM);
    for (const i of [0, 1]) if (face === C.FRONT_AND_BACK || face === (i === 0 ? C.FRONT : C.BACK)) S.stencilMask[i] = glenum(m);
  };
  const SOPS = [C.KEEP, C.ZERO, C.REPLACE, C.INCR, C.DECR, C.INVERT, C.INCR_WRAP, C.DECR_WRAP];
  M.stencilOp = function stencilOp(a, b, c) { argsReq(IF1, 'stencilOp', 3, arguments.length); return M.stencilOpSeparate.call(this, C.FRONT_AND_BACK, a, b, c); };
  M.stencilOpSeparate = function stencilOpSeparate(face, a, b, c) {
    argsReq(IF1, 'stencilOpSeparate', 4, arguments.length); const S = stOf(this); if (S.lost) return;
    face = glenum(face); a = glenum(a); b = glenum(b); c = glenum(c);
    if (!FACE(face) || ![a, b, c].every((o) => SOPS.includes(o))) return gerr(S, C.INVALID_ENUM);
    for (const i of [0, 1]) if (face === C.FRONT_AND_BACK || face === (i === 0 ? C.FRONT : C.BACK)) { S.stencil.fail[i] = a; S.stencil.zfail[i] = b; S.stencil.zpass[i] = c; }
  };
  M.pixelStorei = function pixelStorei(p, v) {
    argsReq(IF1, 'pixelStorei', 2, arguments.length); const S = stOf(this); if (S.lost) return; p = glenum(p);
    const n = glint(v);
    switch (p) {
      case C.PACK_ALIGNMENT: case C.UNPACK_ALIGNMENT: if (![1, 2, 4, 8].includes(n)) return gerr(S, C.INVALID_VALUE); (p === C.PACK_ALIGNMENT ? S.pack : S.unpack).align = n; return;
      case C.UNPACK_FLIP_Y_WEBGL: S.unpack.flipY = !!v; return;
      case C.UNPACK_PREMULTIPLY_ALPHA_WEBGL: S.unpack.premul = !!v; return;
      case C.UNPACK_COLORSPACE_CONVERSION_WEBGL: if (n !== C.NONE && n !== C.BROWSER_DEFAULT_WEBGL) return gerr(S, C.INVALID_VALUE); S.unpack.colorspace = n; return;
      default: break;
    }
    if (S.ver === 2) {
      const tbl = { [C2.PACK_ROW_LENGTH]: [S.pack, 'rowLength'], [C2.PACK_SKIP_ROWS]: [S.pack, 'skipRows'], [C2.PACK_SKIP_PIXELS]: [S.pack, 'skipPixels'], [C2.UNPACK_ROW_LENGTH]: [S.unpack, 'rowLength'],
        [C2.UNPACK_IMAGE_HEIGHT]: [S.unpack, 'imageHeight'], [C2.UNPACK_SKIP_ROWS]: [S.unpack, 'skipRows'], [C2.UNPACK_SKIP_PIXELS]: [S.unpack, 'skipPixels'], [C2.UNPACK_SKIP_IMAGES]: [S.unpack, 'skipImages'] };
      const t = tbl[p];
      if (t) { if (n < 0) return gerr(S, C.INVALID_VALUE); t[0][t[1]] = n; return; }
    }
    gerr(S, C.INVALID_ENUM);
  };
  M.getError = function getError() {
    const S = stOf(this);
    if (S.lost) { if (!S.lostErrorReported) { S.lostErrorReported = true; return C.CONTEXT_LOST_WEBGL; } return 0; }
    const e = S.err; S.err = 0; return e;
  };
  M.flush = function flush() { const S = stOf(this); void S; };
  M.finish = function finish() { const S = stOf(this); void S; };
  M.isContextLost = function isContextLost() { return stOf(this).lost; };

  // ---------------------------------------------------------------------------------------
  // Buffers
  // ---------------------------------------------------------------------------------------
  const newBufferRec = () => ({ data: new Uint8Array(0), size: 0, usage: C.STATIC_DRAW, deleted: false, bound: 0, target: 0, kind: 'buffer', views: null });
  M.createBuffer = function createBuffer() { const S = stOf(this); if (S.lost) return null; return wrapObj(WebGLBuffer, S, newBufferRec()); };
  function bufferSlot(S, target) {
    switch (target) {
      case C.ARRAY_BUFFER: return 'arrayBuffer';
      case C.ELEMENT_ARRAY_BUFFER: return 'element';
      default: break;
    }
    if (S.ver === 2) {
      switch (target) {
        case C2.COPY_READ_BUFFER: return 'copyRead'; case C2.COPY_WRITE_BUFFER: return 'copyWrite'; case C2.PIXEL_PACK_BUFFER: return 'pixelPack';
        case C2.PIXEL_UNPACK_BUFFER: return 'pixelUnpack'; case C2.UNIFORM_BUFFER: return 'uniformBuffer'; case C2.TRANSFORM_FEEDBACK_BUFFER: return 'tfBuffer';
        default: break;
      }
    }
    return null;
  }
  const getBound = (S, slot) => (slot === 'element' ? S.vao.element : S[slot]);
  const setBound = (S, slot, b) => { if (slot === 'element') S.vao.element = b; else S[slot] = b; };
  G.getBoundBuffer = (S, target) => { const sl = bufferSlot(S, target); return sl === null ? null : getBound(S, sl); };
  M.bindBuffer = function bindBuffer(target, buffer) {
    argsReq(IF1, 'bindBuffer', 2, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    if (buffer !== null && buffer !== undefined && !(buffer instanceof WebGLBuffer)) throw G.typeErr(IF1, 'bindBuffer', 2, 'WebGLBuffer');
    const slot = bufferSlot(S, target);
    if (slot === null) return gerr(S, C.INVALID_ENUM);
    if (buffer === null || buffer === undefined) { setBound(S, slot, null); return; }
    if (!isObjOf(S, buffer, WebGLBuffer) || rec(buffer).deleted) return gerr(S, C.INVALID_OPERATION);
    const r = rec(buffer);
    if (S.ver === 2) {
      const isEl = target === C.ELEMENT_ARRAY_BUFFER;
      if (r.target && r.target !== target && (isEl || r.target === C.ELEMENT_ARRAY_BUFFER)) return gerr(S, C.INVALID_OPERATION);
    } else if (r.target && r.target !== target) return gerr(S, C.INVALID_OPERATION);
    if (!r.target) r.target = target;
    setBound(S, slot, r);
  };
  M.deleteBuffer = function deleteBuffer(b) {
    argsReq(IF1, 'deleteBuffer', 1, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (b === null || b === undefined) return;
    if (!(b instanceof WebGLBuffer)) throw G.typeErr(IF1, 'deleteBuffer', 1, 'WebGLBuffer');
    if (!isObjOf(S, b, WebGLBuffer)) return gerr(S, C.INVALID_OPERATION);
    const r = rec(b);
    if (r.deleted) return;
    r.deleted = true;
    for (const sl of ['arrayBuffer', 'copyRead', 'copyWrite', 'pixelPack', 'pixelUnpack', 'uniformBuffer', 'tfBuffer']) if (S[sl] === r) S[sl] = null;
    for (const vao of [S.defaultVao, ...(S.vaos || [])]) {
      if (vao.element === r) vao.element = null;
      for (const a of vao.attribs) if (a.buffer === r) a.buffer = null;
    }
    if (S.uboBindings) for (const bd of S.uboBindings) if (bd && bd.buffer === r) { bd.buffer = null; }
  };
  M.isBuffer = function isBuffer(b) { const S = stOf(this); if (S.lost) return false; return isObjOf(S, b, WebGLBuffer) && !rec(b).deleted && rec(b).target !== 0; };
  const BUF_USAGE = [C.STREAM_DRAW, C.STATIC_DRAW, C.DYNAMIC_DRAW];
  const BUF_USAGE2 = [C2.STREAM_READ, C2.STREAM_COPY, C2.STATIC_READ, C2.STATIC_COPY, C2.DYNAMIC_READ, C2.DYNAMIC_COPY];
  const isBufferSource = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v) || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer);
  const bytesOf = (v) => (ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v));
  function boundForTarget(S, target) {
    const slot = bufferSlot(S, target);
    if (slot === null) { gerr(S, C.INVALID_ENUM); return undefined; }
    const b = getBound(S, slot);
    if (b === null) { gerr(S, C.INVALID_OPERATION); return undefined; }
    return b;
  }
  M.bufferData = function bufferData(target, data, usage, srcOffset, length) {
    argsReq(IF1, 'bufferData', 3, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target); usage = glenum(usage);
    if (data !== null && typeof data !== 'number' && !isBufferSource(data) && typeof data !== 'object') data = Number(data);
    if (data === null) { gerr(S, C.INVALID_VALUE); return; }
    if (!BUF_USAGE.includes(usage) && !(S.ver === 2 && BUF_USAGE2.includes(usage))) return gerr(S, C.INVALID_ENUM);
    const b = boundForTarget(S, target); if (b === undefined) return;
    let bytes;
    if (typeof data === 'number' || (typeof data === 'object' && !isBufferSource(data))) {
      const n = Number(data);
      if (!(n >= 0) || !Number.isFinite(n)) { gerr(S, C.INVALID_VALUE); return; }
      if (n > 0x7fffffff) { gerr(S, C.OUT_OF_MEMORY); return; }
      try { bytes = new Uint8Array(n); } catch (_) { gerr(S, C.OUT_OF_MEMORY); return; }
    } else {
      let src = bytesOf(data);
      if (S.ver === 2 && srcOffset !== undefined) {
        const es = ArrayBuffer.isView(data) && !(data instanceof DataView) ? data.BYTES_PER_ELEMENT : 1;
        const off = Number(srcOffset) >>> 0; const len = length === undefined ? 0 : Number(length) >>> 0;
        if (off * es > src.length) { gerr(S, C.INVALID_VALUE); return; }
        const end = len === 0 ? src.length : off * es + len * es;
        if (end > src.length) { gerr(S, C.INVALID_VALUE); return; }
        src = src.subarray(off * es, end);
      }
      bytes = new Uint8Array(src.length); bytes.set(src);
    }
    b.data = bytes; b.size = bytes.length; b.usage = usage; b.views = null;
  };
  M.bufferSubData = function bufferSubData(target, offset, data, srcOffset, length) {
    argsReq(IF1, 'bufferSubData', 3, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    const off = Math.trunc(Number(offset)) || 0;
    if (!isBufferSource(data)) throw G.typeErr(IF1, 'bufferSubData', 3, 'ArrayBuffer');
    const b = boundForTarget(S, target); if (b === undefined) return;
    let src = bytesOf(data);
    if (S.ver === 2 && srcOffset !== undefined) {
      const es = ArrayBuffer.isView(data) && !(data instanceof DataView) ? data.BYTES_PER_ELEMENT : 1;
      const o = Number(srcOffset) >>> 0; const len = length === undefined ? 0 : Number(length) >>> 0;
      if (o * es > src.length) return gerr(S, C.INVALID_VALUE);
      const end = len === 0 ? src.length : o * es + len * es;
      if (end > src.length) return gerr(S, C.INVALID_VALUE);
      src = src.subarray(o * es, end);
    }
    if (!(off >= 0) || off + src.length > b.size) return gerr(S, C.INVALID_VALUE);
    b.data.set(src, off); b.views = null;
  };
  M.getBufferParameter = function getBufferParameter(target, pname) {
    argsReq(IF1, 'getBufferParameter', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; target = glenum(target); pname = glenum(pname);
    const b = boundForTarget(S, target); if (b === undefined) return null;
    if (pname === C.BUFFER_SIZE) return b.size;
    if (pname === C.BUFFER_USAGE) return b.usage;
    gerr(S, C.INVALID_ENUM); return null;
  };
  M2.copyBufferSubData = function copyBufferSubData(rt, wt, ro, wo, size) {
    argsReq('WebGL2RenderingContext', 'copyBufferSubData', 5, arguments.length);
    const S = stOf(this); if (S.lost) return;
    const rs = bufferSlot(S, glenum(rt)), ws = bufferSlot(S, glenum(wt));
    if (rs === null || ws === null) return gerr(S, C.INVALID_ENUM);
    const r = getBound(S, rs), w = getBound(S, ws);
    if (!r || !w) return gerr(S, C.INVALID_OPERATION);
    ro = Number(ro); wo = Number(wo); size = Number(size);
    if (ro < 0 || wo < 0 || size < 0 || ro + size > r.size || wo + size > w.size) return gerr(S, C.INVALID_VALUE);
    if (r === w && !(ro + size <= wo || wo + size <= ro)) return gerr(S, C.INVALID_VALUE);
    w.data.set(r.data.subarray(ro, ro + size), wo); w.views = null;
  };
  M2.getBufferSubData = function getBufferSubData(target, srcByteOffset, dst, dstOffset, length) {
    argsReq('WebGL2RenderingContext', 'getBufferSubData', 3, arguments.length);
    const S = stOf(this); if (S.lost) return;
    const b = boundForTarget(S, glenum(target)); if (b === undefined) return;
    if (!ArrayBuffer.isView(dst)) throw G.typeErr('WebGL2RenderingContext', 'getBufferSubData', 3, 'ArrayBufferView');
    const es = dst instanceof DataView ? 1 : dst.BYTES_PER_ELEMENT;
    const doff = dstOffset === undefined ? 0 : Number(dstOffset) >>> 0;
    const n = length === undefined || Number(length) === 0 ? (dst.byteLength / es) - doff : Number(length) >>> 0;
    const so = Number(srcByteOffset);
    if (so < 0 || doff * es + n * es > dst.byteLength || so + n * es > b.size) return gerr(S, C.INVALID_VALUE);
    new Uint8Array(dst.buffer, dst.byteOffset + doff * es, n * es).set(b.data.subarray(so, so + n * es));
  };

  // ---------------------------------------------------------------------------------------
  // Vertex attributes and vertex arrays
  // ---------------------------------------------------------------------------------------
  const checkIdx = (S, i) => { if (i >= LIM.maxVertexAttribs) { gerr(S, C.INVALID_VALUE); return false; } return true; };
  M.enableVertexAttribArray = function enableVertexAttribArray(i) { argsReq(IF1, 'enableVertexAttribArray', 1, arguments.length); const S = stOf(this); if (S.lost) return; i = glenum(i); if (checkIdx(S, i)) S.vao.attribs[i].enabled = true; };
  M.disableVertexAttribArray = function disableVertexAttribArray(i) { argsReq(IF1, 'disableVertexAttribArray', 1, arguments.length); const S = stOf(this); if (S.lost) return; i = glenum(i); if (checkIdx(S, i)) S.vao.attribs[i].enabled = false; };
  M.vertexAttribPointer = function vertexAttribPointer(idx, size, type, normalized, stride, offset) {
    argsReq(IF1, 'vertexAttribPointer', 6, arguments.length);
    const S = stOf(this); if (S.lost) return;
    idx = glenum(idx); size = glint(size); type = glenum(type); stride = glint(stride); offset = Number(offset);
    if (!checkIdx(S, idx)) return;
    if (size < 1 || size > 4 || stride < 0 || stride > 255 || offset < 0) return gerr(S, C.INVALID_VALUE);
    const okTypes = [C.BYTE, C.UNSIGNED_BYTE, C.SHORT, C.UNSIGNED_SHORT, C.FLOAT];
    if (S.ver === 2) okTypes.push(C.INT, C.UNSIGNED_INT, C2.HALF_FLOAT, C2.INT_2_10_10_10_REV, C2.UNSIGNED_INT_2_10_10_10_REV);
    else if (type === C.INT || type === C.UNSIGNED_INT) return gerr(S, C.INVALID_ENUM);
    if (!okTypes.includes(type)) return gerr(S, C.INVALID_ENUM);
    if ((type === C2.INT_2_10_10_10_REV || type === C2.UNSIGNED_INT_2_10_10_10_REV) && size !== 4) return gerr(S, C.INVALID_OPERATION);
    const bs = sizedInt[type] || (type === C2.HALF_FLOAT ? 2 : 4);
    if (offset % bs !== 0 || stride % bs !== 0) return gerr(S, C.INVALID_OPERATION);
    if (S.arrayBuffer === null && offset !== 0) return gerr(S, C.INVALID_OPERATION);
    const a = S.vao.attribs[idx];
    a.size = size; a.type = type; a.normalized = !!normalized; a.stride = stride; a.offset = offset; a.buffer = S.arrayBuffer; a.integer = false;
  };
  M2.vertexAttribIPointer = function vertexAttribIPointer(idx, size, type, stride, offset) {
    argsReq('WebGL2RenderingContext', 'vertexAttribIPointer', 5, arguments.length);
    const S = stOf(this); if (S.lost) return;
    idx = glenum(idx); size = glint(size); type = glenum(type); stride = glint(stride); offset = Number(offset);
    if (!checkIdx(S, idx)) return;
    if (size < 1 || size > 4 || stride < 0 || stride > 255 || offset < 0) return gerr(S, C.INVALID_VALUE);
    if (![C.BYTE, C.UNSIGNED_BYTE, C.SHORT, C.UNSIGNED_SHORT, C.INT, C.UNSIGNED_INT].includes(type)) return gerr(S, C.INVALID_ENUM);
    const bs = sizedInt[type];
    if (offset % bs !== 0 || stride % bs !== 0) return gerr(S, C.INVALID_OPERATION);
    if (S.arrayBuffer === null && offset !== 0) return gerr(S, C.INVALID_OPERATION);
    const a = S.vao.attribs[idx];
    a.size = size; a.type = type; a.normalized = false; a.stride = stride; a.offset = offset; a.buffer = S.arrayBuffer; a.integer = true;
  };
  M.vertexAttribDivisorImpl = function vertexAttribDivisorImpl(S, idx, d) {
    idx = glenum(idx); d = glenum(d);
    if (!checkIdx(S, idx)) return;
    S.vao.attribs[idx].divisor = d;
  };
  function setGeneric(S, idx, vals, kind) {
    idx = glenum(idx);
    if (!checkIdx(S, idx)) return;
    const g = S.generic[idx];
    if (kind === 'f') { g.f.set([vals[0], vals[1] === undefined ? 0 : vals[1], vals[2] === undefined ? 0 : vals[2], vals[3] === undefined ? 1 : vals[3]]); g.type = C.FLOAT; }
    else if (kind === 'i') { g.i.set([vals[0], vals[1] || 0, vals[2] || 0, vals[3] === undefined ? 1 : vals[3]]); g.type = C.INT; }
    else { g.u.set([vals[0], vals[1] || 0, vals[2] || 0, vals[3] === undefined ? 1 : vals[3]]); g.type = C.UNSIGNED_INT; }
  }
  for (let n = 1; n <= 4; n++) {
    M[`vertexAttrib${n}f`] = { [`vertexAttrib${n}f`]: function (idx, ...v) { argsReq(IF1, `vertexAttrib${n}f`, n + 1, arguments.length); const S = stOf(this); if (!S.lost) setGeneric(S, idx, v.slice(0, n).map(Number), 'f'); } }[`vertexAttrib${n}f`];
    M[`vertexAttrib${n}fv`] = { [`vertexAttrib${n}fv`]: function (idx, v) {
      argsReq(IF1, `vertexAttrib${n}fv`, 2, arguments.length); const S = stOf(this); if (S.lost) return;
      if (v === null || v === undefined || (typeof v.length !== 'number')) throw G.typeErr(IF1, `vertexAttrib${n}fv`, 2, 'Float32Array');
      if (v.length < n) return gerr(S, C.INVALID_VALUE);
      setGeneric(S, idx, Array.from(v).slice(0, n).map(Number), 'f');
    } }[`vertexAttrib${n}fv`];
  }
  M2.vertexAttribI4i = function vertexAttribI4i(idx, x, y, z, w) { argsReq('WebGL2RenderingContext', 'vertexAttribI4i', 5, arguments.length); const S = stOf(this); if (!S.lost) setGeneric(S, idx, [x, y, z, w].map(glint), 'i'); };
  M2.vertexAttribI4iv = function vertexAttribI4iv(idx, v) { argsReq('WebGL2RenderingContext', 'vertexAttribI4iv', 2, arguments.length); const S = stOf(this); if (S.lost) return; if (!v || v.length < 4) return gerr(S, C.INVALID_VALUE); setGeneric(S, idx, Array.from(v).map(glint), 'i'); };
  M2.vertexAttribI4ui = function vertexAttribI4ui(idx, x, y, z, w) { argsReq('WebGL2RenderingContext', 'vertexAttribI4ui', 5, arguments.length); const S = stOf(this); if (!S.lost) setGeneric(S, idx, [x, y, z, w].map((v) => Number(v) >>> 0), 'u'); };
  M2.vertexAttribI4uiv = function vertexAttribI4uiv(idx, v) { argsReq('WebGL2RenderingContext', 'vertexAttribI4uiv', 2, arguments.length); const S = stOf(this); if (S.lost) return; if (!v || v.length < 4) return gerr(S, C.INVALID_VALUE); setGeneric(S, idx, Array.from(v).map((x) => Number(x) >>> 0), 'u'); };
  M2.vertexAttribDivisor = function vertexAttribDivisor(idx, d) { argsReq('WebGL2RenderingContext', 'vertexAttribDivisor', 2, arguments.length); const S = stOf(this); if (!S.lost) M.vertexAttribDivisorImpl(S, idx, d); };
  M.getVertexAttrib = function getVertexAttrib(idx, pname) {
    argsReq(IF1, 'getVertexAttrib', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; idx = glenum(idx); pname = glenum(pname);
    if (!checkIdx(S, idx)) return null;
    const a = S.vao.attribs[idx];
    switch (pname) {
      case C.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: return a.buffer ? a.buffer.wrapper : null;
      case C.VERTEX_ATTRIB_ARRAY_ENABLED: return a.enabled;
      case C.VERTEX_ATTRIB_ARRAY_SIZE: return a.size;
      case C.VERTEX_ATTRIB_ARRAY_STRIDE: return a.stride;
      case C.VERTEX_ATTRIB_ARRAY_TYPE: return a.type;
      case C.VERTEX_ATTRIB_ARRAY_NORMALIZED: return a.normalized;
      case C.CURRENT_VERTEX_ATTRIB: { const g = S.generic[idx]; return g.type === C.INT ? new Int32Array(g.i) : g.type === C.UNSIGNED_INT ? new Uint32Array(g.u) : new Float32Array(g.f); }
      default: break;
    }
    if (S.ver === 2 && pname === C2.VERTEX_ATTRIB_ARRAY_INTEGER) return a.integer;
    if ((S.ver === 2 || S.exts.has('ANGLE_instanced_arrays')) && pname === C2.VERTEX_ATTRIB_ARRAY_DIVISOR) return a.divisor;
    gerr(S, C.INVALID_ENUM); return null;
  };
  M.getVertexAttribOffset = function getVertexAttribOffset(idx, pname) {
    argsReq(IF1, 'getVertexAttribOffset', 2, arguments.length);
    const S = stOf(this); if (S.lost) return 0; idx = glenum(idx); pname = glenum(pname);
    if (pname !== C.VERTEX_ATTRIB_ARRAY_POINTER) { gerr(S, C.INVALID_ENUM); return 0; }
    if (!checkIdx(S, idx)) return 0;
    return S.vao.attribs[idx].offset;
  };
  // vertex array objects (WebGL2 core, OES_vertex_array_object)
  G.createVao = function createVao(S) { if (S.lost) return null; const r = G.newVaoRec(S.ctx, S); (S.vaos || (S.vaos = [])).push(r); return wrapObj(WebGLVertexArrayObject, S, r); };
  G.bindVao = function bindVao(S, v) {
    if (S.lost) return;
    if (v === null || v === undefined) { S.vao = S.defaultVao; return; }
    if (!isObjOf(S, v, WebGLVertexArrayObject) || rec(v).deleted) return gerr(S, C.INVALID_OPERATION);
    const r = rec(v); r.everBound = true; S.vao = r;
  };
  G.deleteVao = function deleteVao(S, v) {
    if (S.lost || v === null || v === undefined) return;
    if (!isObjOf(S, v, WebGLVertexArrayObject)) return gerr(S, C.INVALID_OPERATION);
    const r = rec(v); if (r.deleted) return;
    r.deleted = true; if (S.vao === r) S.vao = S.defaultVao;
  };
  G.isVao = (S, v) => !S.lost && isObjOf(S, v, WebGLVertexArrayObject) && !rec(v).deleted && rec(v).everBound;
  M2.createVertexArray = function createVertexArray() { return G.createVao(stOf(this)); };
  M2.bindVertexArray = function bindVertexArray(v) { G.bindVao(stOf(this), v); };
  M2.deleteVertexArray = function deleteVertexArray(v) { G.deleteVao(stOf(this), v); };
  M2.isVertexArray = function isVertexArray(v) { return G.isVao(stOf(this), v); };

  // ---------------------------------------------------------------------------------------
  // Shaders and programs
  // ---------------------------------------------------------------------------------------
  let RT = null; // shared GLSL runtime of this realm
  const runtime = () => { if (RT === null) { RT = L.glslRuntime(); if (G.extendRuntime) G.extendRuntime(RT); } return RT; };
  G.runtime = runtime;
  M.createShader = function createShader(type) {
    argsReq(IF1, 'createShader', 1, arguments.length);
    const S = stOf(this); if (S.lost) return null; type = glenum(type);
    if (type !== C.VERTEX_SHADER && type !== C.FRAGMENT_SHADER) { gerr(S, C.INVALID_ENUM); return null; }
    return wrapObj(WebGLShader, S, { type, source: '', compiled: false, log: '', deleted: false, attachedCount: 0, res: null, kind: 'shader', pendingDelete: false });
  };
  M.shaderSource = function shaderSource(sh, src) {
    argsReq(IF1, 'shaderSource', 2, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!(sh instanceof WebGLShader)) throw G.typeErr(IF1, 'shaderSource', 1, 'WebGLShader');
    if (!isObjOf(S, sh, WebGLShader) || rec(sh).deleted) return gerr(S, C.INVALID_OPERATION);
    rec(sh).source = `${src}`;
  };
  M.getShaderSource = function getShaderSource(sh) {
    argsReq(IF1, 'getShaderSource', 1, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!(sh instanceof WebGLShader)) throw G.typeErr(IF1, 'getShaderSource', 1, 'WebGLShader');
    if (!isObjOf(S, sh, WebGLShader) || rec(sh).deleted) { gerr(S, C.INVALID_OPERATION); return null; }
    return rec(sh).source;
  };
  function shaderCaps(S) {
    return { maxVertexAttribs: LIM.maxVertexAttribs, maxVertexUniformVectors: LIM.maxVertexUniformVectors, maxVaryingVectors: LIM.maxVaryingVectors, maxVertexTextureImageUnits: LIM.maxVertexTextureImageUnits,
      maxCombinedTextureImageUnits: LIM.maxCombinedTextureImageUnits, maxTextureImageUnits: LIM.maxTextureImageUnits, maxFragmentUniformVectors: LIM.maxFragmentUniformVectors,
      maxDrawBuffers: S.ver === 2 || S.exts.has('WEBGL_draw_buffers') ? LIM.maxDrawBuffers : 1 };
  }
  M.compileShader = function compileShader(sh) {
    argsReq(IF1, 'compileShader', 1, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!(sh instanceof WebGLShader)) throw G.typeErr(IF1, 'compileShader', 1, 'WebGLShader');
    if (!isObjOf(S, sh, WebGLShader) || rec(sh).deleted) return gerr(S, C.INVALID_OPERATION);
    const r = rec(sh);
    const exts = {};
    const sup = S.ver === 1 ? ['GL_OES_standard_derivatives', 'GL_EXT_frag_depth', 'GL_EXT_draw_buffers', 'GL_EXT_shader_texture_lod'] : [];
    const map = { GL_OES_standard_derivatives: 'OES_standard_derivatives', GL_EXT_frag_depth: 'EXT_frag_depth', GL_EXT_draw_buffers: 'WEBGL_draw_buffers', GL_EXT_shader_texture_lod: 'EXT_shader_texture_lod' };
    for (const e of sup) if (S.exts.has(map[e])) exts[e] = true;
    // an extension directive needs the extension to have been enabled with getExtension (WebGL 1.0 §5.14.14)
    const res = L.glsl.compile(r.source, r.type === C.VERTEX_SHADER ? 'vertex' : 'fragment', { caps: shaderCaps(S), extensions: exts });
    r.compiled = res.ok; r.log = res.log; r.res = res.ok ? res : null;
    if (res.ok && res.version === 300 && S.ver !== 2) { r.compiled = false; r.res = null; r.log = "ERROR: 0:1: '#version' : version number not supported\n"; }
  };
  M.getShaderParameter = function getShaderParameter(sh, pname) {
    argsReq(IF1, 'getShaderParameter', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; pname = glenum(pname);
    if (!(sh instanceof WebGLShader)) throw G.typeErr(IF1, 'getShaderParameter', 1, 'WebGLShader');
    if (!isObjOf(S, sh, WebGLShader)) { gerr(S, C.INVALID_OPERATION); return null; }
    const r = rec(sh);
    switch (pname) {
      case C.SHADER_TYPE: return r.type; case C.DELETE_STATUS: return r.deleted || r.pendingDelete; case C.COMPILE_STATUS: return r.compiled;
      default: gerr(S, C.INVALID_ENUM); return null;
    }
  };
  M.getShaderInfoLog = function getShaderInfoLog(sh) {
    argsReq(IF1, 'getShaderInfoLog', 1, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!(sh instanceof WebGLShader)) throw G.typeErr(IF1, 'getShaderInfoLog', 1, 'WebGLShader');
    if (!isObjOf(S, sh, WebGLShader)) { gerr(S, C.INVALID_OPERATION); return null; }
    return rec(sh).log;
  };
  M.deleteShader = function deleteShader(sh) {
    argsReq(IF1, 'deleteShader', 1, arguments.length);
    const S = stOf(this); if (S.lost || sh === null || sh === undefined) return;
    if (!(sh instanceof WebGLShader)) throw G.typeErr(IF1, 'deleteShader', 1, 'WebGLShader');
    if (!isObjOf(S, sh, WebGLShader)) return gerr(S, C.INVALID_OPERATION);
    const r = rec(sh);
    if (r.attachedCount > 0) r.pendingDelete = true; else r.deleted = true;
  };
  M.isShader = function isShader(sh) { const S = stOf(this); return !S.lost && isObjOf(S, sh, WebGLShader) && !rec(sh).deleted; };
  M.getShaderPrecisionFormat = function getShaderPrecisionFormat(st, pt) {
    argsReq(IF1, 'getShaderPrecisionFormat', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; st = glenum(st); pt = glenum(pt);
    if (st !== C.VERTEX_SHADER && st !== C.FRAGMENT_SHADER) { gerr(S, C.INVALID_ENUM); return null; }
    // shaders run in double precision with 32-bit storage: highp/mediump/lowp float report the IEEE single format (as ANGLE D3D11 does for highp)
    switch (pt) {
      case C.LOW_FLOAT: case C.MEDIUM_FLOAT: case C.HIGH_FLOAT: return new WebGLShaderPrecisionFormat(L.INTERNAL, 127, 127, 23);
      case C.LOW_INT: case C.MEDIUM_INT: case C.HIGH_INT: return new WebGLShaderPrecisionFormat(L.INTERNAL, 31, 30, 0);
      default: gerr(S, C.INVALID_ENUM); return null;
    }
  };

  // ---- programs
  M.createProgram = function createProgram() {
    const S = stOf(this); if (S.lost) return null;
    return wrapObj(WebGLProgram, S, { vs: null, fs: null, linked: false, log: '', deleted: false, pendingDelete: false, attribBind: new Map(), link: null, kind: 'program', validated: false, tfVaryings: [], tfMode: C2.INTERLEAVED_ATTRIBS });
  };
  M.attachShader = function attachShader(p, sh) {
    argsReq(IF1, 'attachShader', 2, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'attachShader', 1, 'WebGLProgram');
    if (!(sh instanceof WebGLShader)) throw G.typeErr(IF1, 'attachShader', 2, 'WebGLShader');
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted || !isObjOf(S, sh, WebGLShader) || rec(sh).deleted) return gerr(S, C.INVALID_OPERATION);
    const pr = rec(p), s = rec(sh);
    const slot = s.type === C.VERTEX_SHADER ? 'vs' : 'fs';
    if (pr[slot] !== null) return gerr(S, C.INVALID_OPERATION);
    pr[slot] = s; s.attachedCount++;
  };
  M.detachShader = function detachShader(p, sh) {
    argsReq(IF1, 'detachShader', 2, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'detachShader', 1, 'WebGLProgram');
    if (!(sh instanceof WebGLShader)) throw G.typeErr(IF1, 'detachShader', 2, 'WebGLShader');
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted || !isObjOf(S, sh, WebGLShader)) return gerr(S, C.INVALID_OPERATION);
    const pr = rec(p), s = rec(sh);
    const slot = s.type === C.VERTEX_SHADER ? 'vs' : 'fs';
    if (pr[slot] !== s) return gerr(S, C.INVALID_OPERATION);
    pr[slot] = null; s.attachedCount--;
    if (s.attachedCount === 0 && s.pendingDelete) s.deleted = true;
  };
  M.getAttachedShaders = function getAttachedShaders(p) {
    argsReq(IF1, 'getAttachedShaders', 1, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'getAttachedShaders', 1, 'WebGLProgram');
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) { gerr(S, C.INVALID_OPERATION); return null; }
    const pr = rec(p); const out = [];
    if (pr.vs) out.push(pr.vs.wrapper); if (pr.fs) out.push(pr.fs.wrapper);
    return out;
  };
  const GL_TYPE = (() => {
    const t = { float: C.FLOAT_VEC2 - 1, int: C.INT_VEC2 - 1, uint: C2.UNSIGNED_INT_VEC2 - 1, bool: C.BOOL };
    const m = { float: t.float, int: t.int, uint: t.uint, bool: t.bool };
    const out = { float: C.FLOAT, int: C.INT, uint: C.UNSIGNED_INT, bool: C.BOOL };
    for (const base of ['float', 'int', 'uint', 'bool']) {
      const pre = { float: '', int: 'i', uint: 'u', bool: 'b' }[base];
      const e0 = { float: C.FLOAT_VEC2, int: C.INT_VEC2, uint: C2.UNSIGNED_INT_VEC2, bool: C.BOOL_VEC2 }[base];
      for (let n = 2; n <= 4; n++) out[`${pre}vec${n}`] = e0 + n - 2;
    }
    void m;
    Object.assign(out, { mat2: C.FLOAT_MAT2, mat3: C.FLOAT_MAT3, mat4: C.FLOAT_MAT4, mat2x3: C2.FLOAT_MAT2x3, mat2x4: C2.FLOAT_MAT2x4, mat3x2: C2.FLOAT_MAT3x2, mat3x4: C2.FLOAT_MAT3x4, mat4x2: C2.FLOAT_MAT4x2, mat4x3: C2.FLOAT_MAT4x3,
      sampler2D: C.SAMPLER_2D, samplerCube: C.SAMPLER_CUBE, sampler3D: C2.SAMPLER_3D, sampler2DArray: C2.SAMPLER_2D_ARRAY, sampler2DShadow: C2.SAMPLER_2D_SHADOW, samplerCubeShadow: C2.SAMPLER_CUBE_SHADOW,
      sampler2DArrayShadow: C2.SAMPLER_2D_ARRAY_SHADOW, isampler2D: C2.INT_SAMPLER_2D, isampler3D: C2.INT_SAMPLER_3D, isamplerCube: C2.INT_SAMPLER_CUBE, isampler2DArray: C2.INT_SAMPLER_2D_ARRAY,
      usampler2D: C2.UNSIGNED_INT_SAMPLER_2D, usampler3D: C2.UNSIGNED_INT_SAMPLER_3D, usamplerCube: C2.UNSIGNED_INT_SAMPLER_CUBE, usampler2DArray: C2.UNSIGNED_INT_SAMPLER_2D_ARRAY });
    return out;
  })();
  G.GL_TYPE = GL_TYPE;
  const slotsOf = (t) => { const i = L.glsl.info(t); return i.kind === 'mat' ? i.cols : 1; };

  M.linkProgram = function linkProgram(p) {
    argsReq(IF1, 'linkProgram', 1, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'linkProgram', 1, 'WebGLProgram');
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) return gerr(S, C.INVALID_OPERATION);
    const pr = rec(p);
    pr.linked = false; pr.link = null; pr.validated = false;
    const fail = (m) => { pr.log = `${m}\n`; };
    if (!pr.vs || !pr.vs.compiled || !pr.fs || !pr.fs.compiled) return fail(!pr.vs || !pr.vs.compiled ? 'ERROR: Must have a compiled vertex shader attached.' : 'ERROR: Must have a compiled fragment shader attached.');
    const vi = pr.vs.res.info, fi = pr.fs.res.info;
    if (pr.vs.res.version !== pr.fs.res.version) return fail('ERROR: Versions of linked shaders have to match.');
    // attributes
    const usedAttrs = vi.attributes.filter((a) => a.used || true);
    const taken = new Map();
    const attrs = [];
    for (const a of usedAttrs) {
      const n = slotsOf(a.t) * (L.glsl.info(a.t).kind === 'array' ? L.glsl.info(a.t).len : 1);
      let loc = a.location !== undefined ? a.location : pr.attribBind.get(a.name);
      attrs.push({ name: a.name, t: a.t, slots: n, loc: loc === undefined ? -1 : loc, rec: a });
    }
    for (const a of attrs) {
      if (a.loc >= 0) {
        for (let k = 0; k < a.slots; k++) {
          if (a.loc + k >= LIM.maxVertexAttribs) return fail(`ERROR: Active attribute '${a.name}' exceeds MAX_VERTEX_ATTRIBS.`);
          if (taken.has(a.loc + k)) return fail(`ERROR: Attribute '${a.name}' aliases '${taken.get(a.loc + k)}' (same location ${a.loc + k}).`);
          taken.set(a.loc + k, a.name);
        }
      }
    }
    for (const a of attrs) {
      if (a.loc >= 0) continue;
      let loc = 0;
      for (;;) {
        let ok = loc + a.slots <= LIM.maxVertexAttribs;
        if (!ok) return fail('ERROR: Too many vertex attributes.');
        for (let k = 0; k < a.slots; k++) if (taken.has(loc + k)) { ok = false; break; }
        if (ok) break;
        loc++;
      }
      a.loc = loc;
      for (let k = 0; k < a.slots; k++) taken.set(loc + k, a.name);
    }
    // varyings
    let vecs = 0;
    for (const fv of fi.varyings) {
      const vv = vi.varyings.find((x) => x.name === fv.name);
      if (vv === undefined) {
        if (fv.used) return fail(`ERROR: Varyings with the same name but different type, or statically used varyings in fragment shader are not declared in vertex shader: ${fv.name}`);
        continue;
      }
      if (vv.t !== fv.t) return fail(`ERROR: Types for varying '${fv.name}' differ between vertex and fragment shaders.`);
      if (pr.fs.res.version === 300 && (!!vv.flat) !== (!!fv.flat)) return fail(`ERROR: Interpolation qualifiers for varying '${fv.name}' differ between shaders.`);
      const ti = L.glsl.info(fv.t);
      vecs += (ti.kind === 'mat' ? ti.cols : 1) * (ti.kind === 'array' ? ti.len * (L.glsl.info(ti.elem).kind === 'mat' ? L.glsl.info(ti.elem).cols : 1) : 1);
    }
    if (vecs > LIM.maxVaryingVectors) return fail('ERROR: Too many varyings');
    // uniforms: merge by name
    const leaves = [];
    const byName = new Map();
    for (const stage of [['vs', vi], ['fs', fi]]) {
      for (const lf of stage[1].uniformLeaves) {
        let m = byName.get(lf.name);
        if (m === undefined) { m = { name: lf.name, baseName: lf.baseName, t: lf.t, size: lf.size, isArray: lf.isArray, paths: {}, used: false, locBase: -1 }; byName.set(lf.name, m); leaves.push(m); }
        else if (m.t !== lf.t || m.size !== lf.size) return fail(`ERROR: Uniform '${lf.name}' differs between the vertex and the fragment shader.`);
        m.paths[stage[0]] = lf.path;
        if (lf.rec.used) m.used = true;
      }
    }
    // sampler / uniform vector budgets
    // ANGLE lists the uniforms in declaration order (vertex shader first) with the samplers behind the others
    const isSamp = (lf) => L.glsl.info(lf.t).kind === 'sampler';
    const ordered = leaves.filter((lf) => !isSamp(lf)).concat(leaves.filter(isSamp));
    let loc = 0;
    const active = [];
    for (const lf of ordered) {
      if (!lf.used) continue;
      lf.locBase = loc; loc += lf.size;
      active.push(lf);
    }
    // fragment outputs
    const outs = [];
    if (pr.fs.res.version === 300) {
      let next = 0;
      const explicit = new Set(fi.outputs.filter((o) => o.location !== undefined).map((o) => o.location));
      for (const o of fi.outputs) {
        const n = (L.glsl.info(o.t).kind === 'array' ? L.glsl.info(o.t).len : 1);
        let l = o.location;
        if (l === undefined) { while (explicit.has(next)) next++; l = next; next += n; }
        outs.push({ name: o.name, t: o.t, loc: l, n });
      }
      for (const o of outs) if (o.loc + o.n > LIM.maxDrawBuffers) return fail('ERROR: Fragment output location exceeds MAX_DRAW_BUFFERS.');
    }
    // build the runtime objects
    const R = runtime();
    const Gv = {}, Gf = {};
    const mk = (t) => { const ti = L.glsl.info(t); return ti.kind === 'sampler' ? { unit: 0, dim: ti.dim, sbase: ti.sbase } : new Function(`return ${L.glsl.zeroJS(t)}`)(); };
    for (const lf of leaves) {
      for (const [st, GG] of [['vs', Gv], ['fs', Gf]]) {
        const path = lf.paths[st];
        if (!path) continue;
        let o = GG;
        for (let i = 0; i < path.length - 1; i++) {
          if (o[path[i]] === undefined) o[path[i]] = typeof path[i + 1] === 'number' ? [] : {};
          o = o[path[i]];
        }
        const last = path[path.length - 1];
        o[last] = lf.isArray ? Array.from({ length: lf.size }, () => mk(lf.t)) : mk(lf.t);
      }
    }
    let runVS, runFS;
    try { runVS = pr.vs.res.factory(R, Gv); runFS = pr.fs.res.factory(R, Gf); } catch (e) { return fail(`ERROR: internal shader error: ${e && e.message}`); }
    const attrInfo = attrs.map((a) => ({ name: a.name, t: a.t, loc: a.loc, slots: a.slots, used: a.rec.used }));
    // transform feedback varyings are validated in 39_webgl_draw.js
    pr.link = {
      vs: pr.vs, fs: pr.fs, vi, fi, attrs: attrInfo, leaves, active, outs, varyings: fi.varyings.filter((f) => vi.varyings.some((v) => v.name === f.name)), Gv, Gf, runVS, runFS, R,
      version: pr.fs.res.version, values: new Map(), samplerUnits: new Map(), blocks: [],
    };
    // inactive attributes do not count, but their binding stays reserved: keep only the used ones in the active list
    pr.link.activeAttrs = attrInfo.filter((a) => a.used);
    for (const lf of active) pr.link.values.set(lf, lf.isArray ? Array.from({ length: lf.size }, () => null) : null);
    pr.linked = true;
    pr.log = '';
    if (G.afterLink) G.afterLink(S, pr);
  };
  M.validateProgram = function validateProgram(p) {
    argsReq(IF1, 'validateProgram', 1, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'validateProgram', 1, 'WebGLProgram');
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) return gerr(S, C.INVALID_OPERATION);
    rec(p).validated = rec(p).linked;
  };
  M.useProgram = function useProgram(p) {
    argsReq(IF1, 'useProgram', 1, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (p === null || p === undefined) { S.program = null; return; }
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'useProgram', 1, 'WebGLProgram');
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) return gerr(S, C.INVALID_OPERATION);
    if (!rec(p).linked) return gerr(S, C.INVALID_OPERATION);
    S.program = rec(p);
  };
  M.deleteProgram = function deleteProgram(p) {
    argsReq(IF1, 'deleteProgram', 1, arguments.length);
    const S = stOf(this); if (S.lost || p === null || p === undefined) return;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'deleteProgram', 1, 'WebGLProgram');
    if (!isObjOf(S, p, WebGLProgram)) return gerr(S, C.INVALID_OPERATION);
    const r = rec(p);
    if (S.program === r) { r.pendingDelete = true; return; }
    r.deleted = true;
    for (const sh of [r.vs, r.fs]) if (sh) { sh.attachedCount--; if (sh.attachedCount === 0 && sh.pendingDelete) sh.deleted = true; }
  };
  M.isProgram = function isProgram(p) { const S = stOf(this); return !S.lost && isObjOf(S, p, WebGLProgram) && !rec(p).deleted; };
  M.getProgramParameter = function getProgramParameter(p, pname) {
    argsReq(IF1, 'getProgramParameter', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; pname = glenum(pname);
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'getProgramParameter', 1, 'WebGLProgram');
    if (!isObjOf(S, p, WebGLProgram)) { gerr(S, C.INVALID_OPERATION); return null; }
    const r = rec(p);
    switch (pname) {
      case C.DELETE_STATUS: return r.deleted || r.pendingDelete;
      case C.LINK_STATUS: return r.linked;
      case C.VALIDATE_STATUS: return r.validated;
      case C.ATTACHED_SHADERS: return (r.vs ? 1 : 0) + (r.fs ? 1 : 0);
      case C.ACTIVE_ATTRIBUTES: return r.linked ? r.link.activeAttrs.length : 0;
      case C.ACTIVE_UNIFORMS: return r.linked ? r.link.active.length : 0;
      default: break;
    }
    if (S.ver === 2) {
      switch (pname) {
        case C2.TRANSFORM_FEEDBACK_BUFFER_MODE: return r.tfMode;
        case C2.TRANSFORM_FEEDBACK_VARYINGS: return r.linked && r.link.tf ? r.link.tf.varyings.length : 0;
        case C2.ACTIVE_UNIFORM_BLOCKS: return r.linked ? r.link.blocks.length : 0;
        default: break;
      }
    }
    gerr(S, C.INVALID_ENUM); return null;
  };
  M.getProgramInfoLog = function getProgramInfoLog(p) {
    argsReq(IF1, 'getProgramInfoLog', 1, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'getProgramInfoLog', 1, 'WebGLProgram');
    if (!isObjOf(S, p, WebGLProgram)) { gerr(S, C.INVALID_OPERATION); return null; }
    return rec(p).log;
  };
  M.bindAttribLocation = function bindAttribLocation(p, idx, name) {
    argsReq(IF1, 'bindAttribLocation', 3, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'bindAttribLocation', 1, 'WebGLProgram');
    idx = glenum(idx); name = `${name}`;
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) return gerr(S, C.INVALID_OPERATION);
    if (idx >= LIM.maxVertexAttribs) return gerr(S, C.INVALID_VALUE);
    if (name.startsWith('gl_')) return gerr(S, C.INVALID_OPERATION);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return gerr(S, C.INVALID_VALUE);
    rec(p).attribBind.set(name, idx);
  };
  M.getAttribLocation = function getAttribLocation(p, name) {
    argsReq(IF1, 'getAttribLocation', 2, arguments.length);
    const S = stOf(this); if (S.lost) return -1;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'getAttribLocation', 1, 'WebGLProgram');
    name = `${name}`;
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) { gerr(S, C.INVALID_OPERATION); return -1; }
    const r = rec(p);
    if (!r.linked) { gerr(S, C.INVALID_OPERATION); return -1; }
    const a = r.link.activeAttrs.find((x) => x.name === name);
    return a ? a.loc : -1;
  };
  M.getActiveAttrib = function getActiveAttrib(p, idx) {
    argsReq(IF1, 'getActiveAttrib', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'getActiveAttrib', 1, 'WebGLProgram');
    idx = glenum(idx);
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) { gerr(S, C.INVALID_OPERATION); return null; }
    const r = rec(p);
    if (!r.linked || idx >= r.link.activeAttrs.length) { gerr(S, C.INVALID_VALUE); return null; }
    const a = r.link.activeAttrs[idx];
    const ti = L.glsl.info(a.t);
    return new WebGLActiveInfo(L.INTERNAL, a.name, ti.kind === 'array' ? ti.len : 1, GL_TYPE[ti.kind === 'array' ? ti.elem : a.t]);
  };
  M.getActiveUniform = function getActiveUniform(p, idx) {
    argsReq(IF1, 'getActiveUniform', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'getActiveUniform', 1, 'WebGLProgram');
    idx = glenum(idx);
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) { gerr(S, C.INVALID_OPERATION); return null; }
    const r = rec(p);
    if (!r.linked || idx >= r.link.active.length) { gerr(S, C.INVALID_VALUE); return null; }
    const lf = r.link.active[idx];
    return new WebGLActiveInfo(L.INTERNAL, lf.isArray ? lf.name : lf.name, lf.size, GL_TYPE[lf.t]);
  };
  // location lookup: "name", "name[3]", "s.member", "s[1].member[2]"
  M.getUniformLocation = function getUniformLocation(p, name) {
    argsReq(IF1, 'getUniformLocation', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'getUniformLocation', 1, 'WebGLProgram');
    name = `${name}`;
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) { gerr(S, C.INVALID_OPERATION); return null; }
    const r = rec(p);
    if (!r.linked) { gerr(S, C.INVALID_OPERATION); return null; }
    if (name.startsWith('gl_')) return null;
    let idx = 0;
    let key = name;
    const m = /^(.*)\[(\d+)\]$/.exec(name);
    for (const lf of r.link.active) {
      if (lf.name === name) { idx = 0; key = null; return mkLoc(S, r, lf, 0); }
      if (lf.isArray && m && `${m[1]}[0]` === lf.name) { idx = +m[2]; if (idx < lf.size) return mkLoc(S, r, lf, idx); }
      if (lf.isArray && lf.name.endsWith('[0]') && lf.name.slice(0, -3) === name) return mkLoc(S, r, lf, 0);
    }
    void key; void idx;
    return null;
  };
  function mkLoc(S, r, lf, i) {
    const o = Object.create(WebGLUniformLocation.prototype);
    OBJ.set(o, { ctx: S, prog: r, link: r.link, leaf: lf, index: i, loc: lf.locBase + i, kind: 'uloc' });
    return o;
  }
  G.mkLoc = mkLoc;

  // ---- uniforms
  const TYPE_COMPONENTS = (t) => { const i = L.glsl.info(t); return i.kind === 'scalar' ? 1 : i.kind === 'vec' ? i.n : i.kind === 'mat' ? i.n : 1; };
  function writeLeaf(lnk, lf, index, value) {
    for (const st of ['vs', 'fs']) {
      const path = lf.paths[st];
      if (!path) continue;
      let o = st === 'vs' ? lnk.Gv : lnk.Gf;
      for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
      const last = path[path.length - 1];
      if (lf.isArray) o[last][index] = value; else o[last] = value;
    }
  }
  G.writeLeaf = writeLeaf;
  function uniformLoc(S, loc, method) {
    if (loc === null || loc === undefined) return null;
    if (!(loc instanceof WebGLUniformLocation)) throw G.typeErr(IF1, method, 1, 'WebGLUniformLocation');
    const r = OBJ.get(loc);
    if (!r || r.ctx !== S) { gerr(S, C.INVALID_OPERATION); return undefined; }
    if (S.program === null || r.prog !== S.program || r.link !== S.program.link) { gerr(S, C.INVALID_OPERATION); return undefined; }
    return r;
  }
  const isSamplerType = (t) => L.glsl.info(t).kind === 'sampler';
  function baseOfType(t) { const i = L.glsl.info(t); return i.kind === 'sampler' ? 'int' : i.base; }
  // uniform<n>{f,i,ui}(v): `vals` is an array of numbers (count*n), kind 'f' | 'i' | 'ui'
  function setUniform(S, r, vals, n, kind, count, method) {
    const lf = r.leaf;
    const t = lf.t;
    const ti = L.glsl.info(t);
    const comps = ti.kind === 'sampler' ? 1 : TYPE_COMPONENTS(t);
    const base = baseOfType(t);
    const okKind = (kind === 'f' && (base === 'float' || base === 'bool')) || (kind === 'i' && (base === 'int' || base === 'bool')) || (kind === 'ui' && (base === 'uint' || base === 'bool'));
    if (ti.kind === 'mat' || comps !== n || !okKind) return gerr(S, C.INVALID_OPERATION);
    if (count > 1 && !lf.isArray) return gerr(S, C.INVALID_OPERATION);
    if (r.index + count > lf.size) count = lf.size - r.index;
    const vals0 = r.link.values.get(lf);
    for (let k = 0; k < count; k++) {
      const slice = vals.slice(k * n, k * n + n);
      let v;
      if (ti.kind === 'sampler') {
        const unit = slice[0] | 0;
        if (unit < 0 || unit >= LIM.maxCombinedTextureImageUnits) return gerr(S, C.INVALID_VALUE);
        v = { unit, dim: ti.dim, sbase: ti.sbase };
      } else if (ti.kind === 'scalar') v = base === 'bool' ? slice[0] !== 0 : slice[0];
      else v = base === 'bool' ? slice.map((x) => x !== 0) : slice;
      writeLeaf(r.link, lf, r.index + k, v);
      if (lf.isArray) vals0[r.index + k] = slice; else r.link.values.set(lf, slice);
    }
    void method;
  }
  const numArr = (v) => (v !== null && v !== undefined && typeof v === 'object' && typeof v.length === 'number');
  function defU(name, n, kind, vec) {
    const ifc = IF1;
    M[name] = { [name]: function (loc, ...a) {
      argsReq(ifc, name, vec ? 2 : n + 1, arguments.length);
      const S = stOf(this); if (S.lost) return;
      const r = uniformLoc(S, loc, name); if (r === null || r === undefined) return;
      let vals;
      if (vec) {
        const v = a[0];
        if (!numArr(v)) throw G.typeErr(ifc, name, 2, kind === 'f' ? 'Float32Array' : 'Int32Array');
        if (v.length % n !== 0 || v.length === 0) return gerr(S, C.INVALID_VALUE);
        vals = Array.from(a.length > 1 ? Array.prototype.slice.call(v, Number(a[1]) || 0, a[2] ? (Number(a[1]) || 0) + Number(a[2]) * n : undefined) : v);
        if (a.length > 1 && vals.length % n !== 0) return gerr(S, C.INVALID_VALUE);
      } else vals = a.slice(0, n);
      vals = kind === 'f' ? vals.map((x) => Math.fround(Number(x))) : kind === 'i' ? vals.map((x) => Number(x) | 0) : vals.map((x) => Number(x) >>> 0);
      setUniform(S, r, vals, n, kind, vals.length / n, name);
    } }[name];
  }
  for (let n = 1; n <= 4; n++) { defU(`uniform${n}f`, n, 'f', false); defU(`uniform${n}fv`, n, 'f', true); defU(`uniform${n}i`, n, 'i', false); defU(`uniform${n}iv`, n, 'i', true); }
  const defU2 = (name, n, kind, vec) => { const tmp = {}; const saved = M[name]; defU(name, n, kind, vec); tmp[name] = M[name]; if (saved) M[name] = saved; M2[name] = tmp[name]; delete M[name]; };
  for (let n = 1; n <= 4; n++) { defU2(`uniform${n}ui`, n, 'ui', false); defU2(`uniform${n}uiv`, n, 'ui', true); }
  function defM(name, cols, rows, es3) {
    (es3 ? M2 : M)[name] = { [name]: function (loc, transpose, v, srcOffset, srcLength) {
      argsReq(IF1, name, 3, arguments.length);
      const S = stOf(this); if (S.lost) return;
      const r = uniformLoc(S, loc, name); if (r === null || r === undefined) return;
      if (!numArr(v)) throw G.typeErr(IF1, name, 3, 'Float32Array');
      if (transpose && S.ver === 1) return gerr(S, C.INVALID_VALUE);
      const n = cols * rows;
      let arr = Array.from(v);
      if (srcOffset !== undefined) arr = arr.slice(Number(srcOffset) || 0, srcLength ? (Number(srcOffset) || 0) + Number(srcLength) : undefined);
      if (arr.length % n !== 0 || arr.length === 0) return gerr(S, C.INVALID_VALUE);
      arr = arr.map((x) => Math.fround(Number(x)));
      let out = arr;
      if (transpose) { out = []; for (let k = 0; k < arr.length / n; k++) for (let c = 0; c < cols; c++) for (let rr = 0; rr < rows; rr++) out.push(arr[k * n + rr * cols + c]); }
      const ti = L.glsl.info(r.leaf.t);
      if (ti.kind !== 'mat' || ti.cols !== cols || ti.rows !== rows) return gerr(S, C.INVALID_OPERATION);
      const count = out.length / n;
      if (count > 1 && !r.leaf.isArray) return gerr(S, C.INVALID_OPERATION);
      const cnt = Math.min(count, r.leaf.size - r.index);
      for (let k = 0; k < cnt; k++) {
        const slice = out.slice(k * n, k * n + n);
        writeLeaf(r.link, r.leaf, r.index + k, slice);
        if (r.leaf.isArray) r.link.values.get(r.leaf)[r.index + k] = slice; else r.link.values.set(r.leaf, slice);
      }
    } }[name];
  }
  for (const n of [2, 3, 4]) defM(`uniformMatrix${n}fv`, n, n, false);
  for (const [c, r] of [[2, 3], [2, 4], [3, 2], [3, 4], [4, 2], [4, 3]]) defM(`uniformMatrix${c}x${r}fv`, c, r, true);
  M.getUniform = function getUniform(p, loc) {
    argsReq(IF1, 'getUniform', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF1, 'getUniform', 1, 'WebGLProgram');
    if (!(loc instanceof WebGLUniformLocation)) throw G.typeErr(IF1, 'getUniform', 2, 'WebGLUniformLocation');
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) { gerr(S, C.INVALID_OPERATION); return null; }
    const pr = rec(p); const r = OBJ.get(loc);
    if (!pr.linked || !r || r.prog !== pr || r.link !== pr.link) { gerr(S, C.INVALID_OPERATION); return null; }
    const lf = r.leaf;
    const stored = lf.isArray ? pr.link.values.get(lf)[r.index] : pr.link.values.get(lf);
    const ti = L.glsl.info(lf.t);
    const base = baseOfType(lf.t);
    const n = ti.kind === 'sampler' ? 1 : TYPE_COMPONENTS(lf.t);
    const arr = stored === null || stored === undefined ? new Array(n).fill(0) : stored;
    if (ti.kind === 'sampler') return arr[0];
    if (base === 'bool') return n === 1 ? !!arr[0] : arr.map((x) => !!x);
    if (n === 1) return arr[0];
    return base === 'float' ? new Float32Array(arr) : base === 'int' ? new Int32Array(arr) : new Uint32Array(arr);
  };
  M2.getFragDataLocation = function getFragDataLocation(p, name) {
    argsReq('WebGL2RenderingContext', 'getFragDataLocation', 2, arguments.length);
    const S = stOf(this); if (S.lost) return -1;
    if (!(p instanceof WebGLProgram)) throw G.typeErr('WebGL2RenderingContext', 'getFragDataLocation', 1, 'WebGLProgram');
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted || !rec(p).linked) { gerr(S, C.INVALID_OPERATION); return -1; }
    const o = rec(p).link.outs.find((x) => x.name === `${name}`);
    return o ? o.loc : -1;
  };

  // ---------------------------------------------------------------------------------------
  // getParameter
  // ---------------------------------------------------------------------------------------
  const bufName = (b) => (b ? b.wrapper : null);
  M.getParameter = function getParameter(pname) {
    argsReq(IF1, 'getParameter', 1, arguments.length);
    const S = stOf(this); if (S.lost) return null; pname = glenum(pname);
    const v2 = S.ver === 2;
    const fb = (S.drawFb || null);
    switch (pname) {
      case C.ACTIVE_TEXTURE: return C.TEXTURE0 + S.activeTex;
      case C.ALIASED_LINE_WIDTH_RANGE: return new Float32Array(LIM.lineWidth);
      case C.ALIASED_POINT_SIZE_RANGE: return new Float32Array(LIM.pointSize);
      case C.ALPHA_BITS: return fb ? G.fbBits(S, fb, 3) : (S.attrs.alpha ? 8 : 0);
      case C.ARRAY_BUFFER_BINDING: return bufName(S.arrayBuffer);
      case C.BLEND: return S.blend.enabled;
      case C.BLEND_COLOR: return new Float32Array(S.blend.color);
      case C.BLEND_DST_ALPHA: return S.blend.dstA; case C.BLEND_DST_RGB: return S.blend.dstRGB;
      case C.BLEND_EQUATION_ALPHA: return S.blend.alpha; case C.BLEND_EQUATION_RGB: return S.blend.rgb;
      case C.BLEND_SRC_ALPHA: return S.blend.srcA; case C.BLEND_SRC_RGB: return S.blend.srcRGB;
      case C.BLUE_BITS: return fb ? G.fbBits(S, fb, 2) : 8;
      case C.COLOR_CLEAR_VALUE: return new Float32Array(S.clearColor);
      case C.COLOR_WRITEMASK: return S.colorMask.slice();
      case C.COMPRESSED_TEXTURE_FORMATS: return new Uint32Array(0);
      case C.CULL_FACE: return S.cull; case C.CULL_FACE_MODE: return S.cullMode;
      case C.CURRENT_PROGRAM: return S.program ? S.program.wrapper : null;
      case C.DEPTH_BITS: return fb ? G.fbBits(S, fb, 4) : (S.attrs.depth ? 24 : 0);
      case C.DEPTH_CLEAR_VALUE: return S.clearDepth; case C.DEPTH_FUNC: return S.depth.func;
      case C.DEPTH_RANGE: return new Float32Array([S.depth.near, S.depth.far]);
      case C.DEPTH_TEST: return S.depth.enabled; case C.DEPTH_WRITEMASK: return S.depthMask;
      case C.DITHER: return S.dither;
      case C.ELEMENT_ARRAY_BUFFER_BINDING: return bufName(S.vao.element);
      case C.FRAMEBUFFER_BINDING: return S.drawFb ? S.drawFb.wrapper : null;
      case C.FRONT_FACE: return S.frontFace;
      case C.GENERATE_MIPMAP_HINT: return S.hints.genMipmap;
      case C.GREEN_BITS: return fb ? G.fbBits(S, fb, 1) : 8;
      case C.IMPLEMENTATION_COLOR_READ_FORMAT: return G.readFormat ? G.readFormat(S)[0] : C.RGBA;
      case C.IMPLEMENTATION_COLOR_READ_TYPE: return G.readFormat ? G.readFormat(S)[1] : C.UNSIGNED_BYTE;
      case C.LINE_WIDTH: return S.lineWidth;
      case C.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return LIM.maxCombinedTextureImageUnits;
      case C.MAX_CUBE_MAP_TEXTURE_SIZE: return LIM.maxCubeMapSize;
      case C.MAX_FRAGMENT_UNIFORM_VECTORS: return LIM.maxFragmentUniformVectors;
      case C.MAX_RENDERBUFFER_SIZE: return LIM.maxRenderbufferSize;
      case C.MAX_TEXTURE_IMAGE_UNITS: return LIM.maxTextureImageUnits;
      case C.MAX_TEXTURE_SIZE: return LIM.maxTextureSize;
      case C.MAX_VARYING_VECTORS: return LIM.maxVaryingVectors;
      case C.MAX_VERTEX_ATTRIBS: return LIM.maxVertexAttribs;
      case C.MAX_VERTEX_TEXTURE_IMAGE_UNITS: return LIM.maxVertexTextureImageUnits;
      case C.MAX_VERTEX_UNIFORM_VECTORS: return LIM.maxVertexUniformVectors;
      case C.MAX_VIEWPORT_DIMS: return new Int32Array([LIM.maxViewport, LIM.maxViewport]);
      case C.PACK_ALIGNMENT: return S.pack.align;
      case C.POLYGON_OFFSET_FACTOR: return S.polyFactor; case C.POLYGON_OFFSET_FILL: return S.polyOffset; case C.POLYGON_OFFSET_UNITS: return S.polyUnits;
      case C.RED_BITS: return fb ? G.fbBits(S, fb, 0) : 8;
      case C.RENDERBUFFER_BINDING: return S.renderbuffer ? S.renderbuffer.wrapper : null;
      case C.RENDERER: return 'WebKit WebGL';
      case C.SAMPLE_ALPHA_TO_COVERAGE: return S.sampleAlpha; case C.SAMPLE_BUFFERS: return 0; case C.SAMPLE_COVERAGE: return S.sampleCoverage;
      case C.SAMPLE_COVERAGE_INVERT: return S.sampleCoverageInvert; case C.SAMPLE_COVERAGE_VALUE: return S.sampleCoverageValue; case C.SAMPLES: return 0;
      case C.SCISSOR_BOX: return new Int32Array(S.scissor); case C.SCISSOR_TEST: return S.scissorTest;
      case C.SHADING_LANGUAGE_VERSION: return v2 ? 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)' : 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
      case C.STENCIL_BACK_FAIL: return S.stencil.fail[1]; case C.STENCIL_BACK_FUNC: return S.stencil.func[1];
      case C.STENCIL_BACK_PASS_DEPTH_FAIL: return S.stencil.zfail[1]; case C.STENCIL_BACK_PASS_DEPTH_PASS: return S.stencil.zpass[1];
      case C.STENCIL_BACK_REF: return S.stencil.ref[1]; case C.STENCIL_BACK_VALUE_MASK: return S.stencil.vmask[1] >>> 0; case C.STENCIL_BACK_WRITEMASK: return S.stencilMask[1] >>> 0;
      case C.STENCIL_BITS: return fb ? G.fbBits(S, fb, 5) : (S.attrs.stencil ? 8 : 0);
      case C.STENCIL_CLEAR_VALUE: return S.clearStencil;
      case C.STENCIL_FAIL: return S.stencil.fail[0]; case C.STENCIL_FUNC: return S.stencil.func[0];
      case C.STENCIL_PASS_DEPTH_FAIL: return S.stencil.zfail[0]; case C.STENCIL_PASS_DEPTH_PASS: return S.stencil.zpass[0];
      case C.STENCIL_REF: return S.stencil.ref[0]; case C.STENCIL_TEST: return S.stencil.enabled;
      case C.STENCIL_VALUE_MASK: return S.stencil.vmask[0] >>> 0; case C.STENCIL_WRITEMASK: return S.stencilMask[0] >>> 0;
      case C.SUBPIXEL_BITS: return LIM.subpixelBits;
      case C.TEXTURE_BINDING_2D: { const t = S.units[S.activeTex].t2d; return t ? t.wrapper : null; }
      case C.TEXTURE_BINDING_CUBE_MAP: { const t = S.units[S.activeTex].cube; return t ? t.wrapper : null; }
      case C.UNPACK_ALIGNMENT: return S.unpack.align;
      case C.UNPACK_COLORSPACE_CONVERSION_WEBGL: return S.unpack.colorspace;
      case C.UNPACK_FLIP_Y_WEBGL: return S.unpack.flipY;
      case C.UNPACK_PREMULTIPLY_ALPHA_WEBGL: return S.unpack.premul;
      case C.VENDOR: return 'WebKit';
      case C.VERSION: return v2 ? 'WebGL 2.0 (OpenGL ES 3.0 Chromium)' : 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
      case C.VIEWPORT: return new Int32Array(S.viewport);
      case C.CONTEXT_LOST_WEBGL: break;
      default: break;
    }
    if (v2) {
      switch (pname) {
        case C2.COPY_READ_BUFFER_BINDING: return bufName(S.copyRead); case C2.COPY_WRITE_BUFFER_BINDING: return bufName(S.copyWrite);
        case C2.DRAW_FRAMEBUFFER_BINDING: return S.drawFb ? S.drawFb.wrapper : null; case C2.READ_FRAMEBUFFER_BINDING: return S.readFb ? S.readFb.wrapper : null;
        case C2.PIXEL_PACK_BUFFER_BINDING: return bufName(S.pixelPack); case C2.PIXEL_UNPACK_BUFFER_BINDING: return bufName(S.pixelUnpack);
        case C2.UNIFORM_BUFFER_BINDING: return bufName(S.uniformBuffer); case C2.TRANSFORM_FEEDBACK_BUFFER_BINDING: return bufName(S.tfBuffer);
        case C2.TRANSFORM_FEEDBACK_BINDING: return S.tf && S.tf.id !== 0 ? S.tf.wrapper : null;
        case C2.TRANSFORM_FEEDBACK_ACTIVE: return !!(S.tf && S.tf.active); case C2.TRANSFORM_FEEDBACK_PAUSED: return !!(S.tf && S.tf.paused);
        case C2.VERTEX_ARRAY_BINDING: return S.vao === S.defaultVao ? null : S.vao.wrapper;
        case C2.FRAGMENT_SHADER_DERIVATIVE_HINT: return S.hints.derivative;
        case C2.MAX_3D_TEXTURE_SIZE: return LIM.max3DTextureSize; case C2.MAX_ARRAY_TEXTURE_LAYERS: return LIM.maxArrayTextureLayers;
        case C2.MAX_COLOR_ATTACHMENTS: return LIM.maxColorAttachments; case C2.MAX_DRAW_BUFFERS: return LIM.maxDrawBuffers;
        case C2.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: return LIM.maxUniformBlockSize ? LIM.maxCombinedFragComponents : LIM.maxFragUniformComponents;
        case C2.MAX_COMBINED_UNIFORM_BLOCKS: return LIM.maxCombinedUniformBlocks; case C2.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS: return LIM.maxUniformBlockSize ? LIM.maxCombinedVertComponents : LIM.maxVertUniformComponents;
        case C2.MAX_ELEMENT_INDEX: return LIM.maxElementIndex; case C2.MAX_ELEMENTS_INDICES: return LIM.maxElementsIndices; case C2.MAX_ELEMENTS_VERTICES: return LIM.maxElementsVertices;
        case C2.MAX_FRAGMENT_INPUT_COMPONENTS: return LIM.maxFragmentInputComponents; case C2.MAX_FRAGMENT_UNIFORM_BLOCKS: return LIM.maxFragmentUniformBlocks; case C2.MAX_FRAGMENT_UNIFORM_COMPONENTS: return LIM.maxFragUniformComponents;
        case C2.MAX_PROGRAM_TEXEL_OFFSET: return 7; case C2.MIN_PROGRAM_TEXEL_OFFSET: return -8; case C2.MAX_SAMPLES: return LIM.maxSamples;
        case C2.MAX_SERVER_WAIT_TIMEOUT: return 0; case C2.MAX_TEXTURE_LOD_BIAS: return LIM.maxTextureLodBias;
        case C2.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: return LIM.maxTfInterleaved; case C2.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS: return LIM.maxTfSeparateAttribs; case C2.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS: return LIM.maxTfSeparateComponents;
        case C2.MAX_UNIFORM_BLOCK_SIZE: return LIM.maxUniformBlockSize; case C2.MAX_UNIFORM_BUFFER_BINDINGS: return LIM.maxUniformBufferBindings; case C2.MAX_VARYING_COMPONENTS: return LIM.maxVaryingComponents;
        case C2.MAX_VERTEX_OUTPUT_COMPONENTS: return LIM.maxVertexOutputComponents; case C2.MAX_VERTEX_UNIFORM_BLOCKS: return LIM.maxVertexUniformBlocks; case C2.MAX_VERTEX_UNIFORM_COMPONENTS: return LIM.maxVertUniformComponents;
        case C2.PACK_ROW_LENGTH: return S.pack.rowLength; case C2.PACK_SKIP_PIXELS: return S.pack.skipPixels; case C2.PACK_SKIP_ROWS: return S.pack.skipRows;
        case C2.READ_BUFFER: return S.readFb ? S.readFb.readBuffer : S.readBuffer;
        case C2.SAMPLER_BINDING: { const s = S.units[S.activeTex].sampler; return s ? s.wrapper : null; }
        case C2.RASTERIZER_DISCARD: return S.rasterizerDiscard;
        case C2.MAX_CLIENT_WAIT_TIMEOUT_WEBGL: return 0;
        case C2.TEXTURE_BINDING_2D_ARRAY: { const t = S.units[S.activeTex].t2da; return t ? t.wrapper : null; }
        case C2.TEXTURE_BINDING_3D: { const t = S.units[S.activeTex].t3d; return t ? t.wrapper : null; }
        case C2.UNIFORM_BUFFER_OFFSET_ALIGNMENT: return 256;
        case C2.UNPACK_IMAGE_HEIGHT: return S.unpack.imageHeight; case C2.UNPACK_ROW_LENGTH: return S.unpack.rowLength;
        case C2.UNPACK_SKIP_IMAGES: return S.unpack.skipImages; case C2.UNPACK_SKIP_PIXELS: return S.unpack.skipPixels; case C2.UNPACK_SKIP_ROWS: return S.unpack.skipRows;
        default:
          if (pname >= C2.DRAW_BUFFER0 && pname < C2.DRAW_BUFFER0 + LIM.maxDrawBuffers) {
            const i = pname - C2.DRAW_BUFFER0;
            // the default framebuffer reports BACK for every draw buffer (as Chromium does)
            if (!S.drawFb) return C.BACK;
            return i < S.drawFb.drawBuffers.length ? S.drawFb.drawBuffers[i] : C.NONE;
          }
          break;
      }
    } else {
      // extension parameters
      if (pname === E.UNMASKED_VENDOR_WEBGL || pname === E.UNMASKED_RENDERER_WEBGL) { /* handled below for both */ }
    }
    if ((pname === E.UNMASKED_VENDOR_WEBGL || pname === E.UNMASKED_RENDERER_WEBGL) && S.exts.has('WEBGL_debug_renderer_info')) {
      const a = G.adapterInfo();
      return pname === E.UNMASKED_VENDOR_WEBGL ? a.vendor : a.renderer;
    }
    if (pname === E.VERTEX_ARRAY_BINDING_OES && S.exts.has('OES_vertex_array_object')) return S.vao === S.defaultVao ? null : S.vao.wrapper;
    if (pname === E.FRAGMENT_SHADER_DERIVATIVE_HINT_OES && S.exts.has('OES_standard_derivatives')) return S.hints.derivative;
    if (S.exts.has('WEBGL_draw_buffers')) {
      if (pname === 0x8824) return LIM.maxDrawBuffers;
      if (pname === 0x8CDF) return LIM.maxColorAttachments;
      if (pname >= C2.DRAW_BUFFER0 && pname <= C2.DRAW_BUFFER15) { const i = pname - C2.DRAW_BUFFER0; const bufs = S.drawFb ? S.drawFb.drawBuffers : S.drawBuffers; return i < bufs.length ? bufs[i] : C.NONE; }
    }
    gerr(S, C.INVALID_ENUM);
    return null;
  };

  void lostNull;
})(globalThis.__layer);
