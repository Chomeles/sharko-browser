// 3c_webgl_ctx.js — context classes, extensions, context creation and loss, canvas integration.
(function (L) {
  'use strict';
  const N = L.N;
  const G = L.glInternals;
  const { C, C2, E, LIM, STATE, ctxByCanvas, gerr, stOf, glenum, glint, argsReq, createState, OBJ, wrapObj, rec, isObjOf } = G;
  const { M, M1, M2 } = G;
  const INTERNAL = L.INTERNAL;

  // ---------------------------------------------------------------------------------------
  // Extensions
  // ---------------------------------------------------------------------------------------
  const extClass = (name, members) => {
    const cls = { [name]: class { constructor(token) { if (token !== INTERNAL) throw L.illegal(); } } }[name];
    Object.defineProperty(cls.prototype, Symbol.toStringTag, { value: name, configurable: true });
    for (const k of Object.keys(members)) {
      const v = members[k];
      if (typeof v === 'function') Object.defineProperty(cls.prototype, k, { value: v, writable: true, enumerable: true, configurable: true });
      else Object.defineProperty(cls.prototype, k, { value: v, enumerable: true });
    }
    return cls;
  };
  const ctxOfExt = new WeakMap();
  const extState = (ext) => { const c = ctxOfExt.get(ext); if (!c) throw new TypeError('Illegal invocation'); return STATE.get(c); };
  const EXT = {
    WEBGL_debug_renderer_info: { v: [1, 2], make: () => extClass('WEBGL_debug_renderer_info', { UNMASKED_VENDOR_WEBGL: E.UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL: E.UNMASKED_RENDERER_WEBGL }) },
    WEBGL_lose_context: { v: [1, 2], make: () => extClass('WEBGL_lose_context', {
      loseContext() { loseContext(extState(this), true); },
      restoreContext() { restoreContext(extState(this)); },
    }) },
    OES_vertex_array_object: { v: [1], make: () => extClass('OES_vertex_array_object', {
      VERTEX_ARRAY_BINDING_OES: E.VERTEX_ARRAY_BINDING_OES,
      createVertexArrayOES() { return G.createVao(extState(this)); },
      deleteVertexArrayOES(v) { G.deleteVao(extState(this), v); },
      isVertexArrayOES(v) { return G.isVao(extState(this), v); },
      bindVertexArrayOES(v) { G.bindVao(extState(this), v); },
    }) },
    ANGLE_instanced_arrays: { v: [1], make: () => extClass('ANGLE_instanced_arrays', {
      VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: E.VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE,
      drawArraysInstancedANGLE(mode, first, count, n) { const S = extState(this); if (!S.lost) G.drawArraysInstancedImpl(S, mode, first, count, n); },
      drawElementsInstancedANGLE(mode, count, type, offset, n) { const S = extState(this); if (!S.lost) G.drawElementsInstancedImpl(S, mode, count, type, offset, n); },
      vertexAttribDivisorANGLE(i, d) { const S = extState(this); if (!S.lost) M.vertexAttribDivisorImpl(S, i, d); },
    }) },
    EXT_blend_minmax: { v: [1], make: () => extClass('EXT_blend_minmax', { MIN_EXT: E.MIN_EXT, MAX_EXT: E.MAX_EXT }) },
    EXT_frag_depth: { v: [1], make: () => extClass('EXT_frag_depth', {}) },
    OES_element_index_uint: { v: [1], make: () => extClass('OES_element_index_uint', {}) },
    OES_standard_derivatives: { v: [1], make: () => extClass('OES_standard_derivatives', { FRAGMENT_SHADER_DERIVATIVE_HINT_OES: E.FRAGMENT_SHADER_DERIVATIVE_HINT_OES }) },
    OES_texture_float: { v: [1], make: () => extClass('OES_texture_float', {}) },
    OES_texture_float_linear: { v: [1, 2], make: () => extClass('OES_texture_float_linear', {}) },
    OES_texture_half_float: { v: [1], make: () => extClass('OES_texture_half_float', { HALF_FLOAT_OES: E.HALF_FLOAT_OES }) },
    OES_texture_half_float_linear: { v: [1], make: () => extClass('OES_texture_half_float_linear', {}) },
    WEBGL_depth_texture: { v: [1], make: () => extClass('WEBGL_depth_texture', { UNSIGNED_INT_24_8_WEBGL: E.UNSIGNED_INT_24_8_WEBGL }) },
    WEBGL_draw_buffers: { v: [1], make: () => {
      const m = { drawBuffersWEBGL(bufs) { const S = extState(this); if (S.lost) return; if (!bufs || typeof bufs.length !== 'number') throw new TypeError("Failed to execute 'drawBuffersWEBGL' on 'WEBGL_draw_buffers': The provided value is not of type 'sequence<GLenum>'."); G.drawBuffersImpl(S, bufs); },
        MAX_COLOR_ATTACHMENTS_WEBGL: 0x8CDF, MAX_DRAW_BUFFERS_WEBGL: 0x8824 };
      for (let i = 0; i < 16; i++) { m[`COLOR_ATTACHMENT${i}_WEBGL`] = 0x8CE0 + i; m[`DRAW_BUFFER${i}_WEBGL`] = 0x8825 + i; }
      return extClass('WEBGL_draw_buffers', m);
    } },
    EXT_color_buffer_half_float: { v: [1, 2], make: () => extClass('EXT_color_buffer_half_float', { RGBA16F_EXT: E.RGBA16F_EXT, RGB16F_EXT: E.RGB16F_EXT, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: E.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT, UNSIGNED_NORMALIZED_EXT: E.UNSIGNED_NORMALIZED_EXT }) },
    WEBGL_color_buffer_float: { v: [1], make: () => extClass('WEBGL_color_buffer_float', { RGBA32F_EXT: E.RGBA32F_EXT, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: E.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT, UNSIGNED_NORMALIZED_EXT: E.UNSIGNED_NORMALIZED_EXT }) },
    EXT_color_buffer_float: { v: [2], make: () => extClass('EXT_color_buffer_float', {}) },
  };
  const EXT_ORDER = {
    1: ['ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float', 'EXT_frag_depth', 'OES_element_index_uint', 'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_float_linear',
      'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object', 'WEBGL_color_buffer_float', 'WEBGL_debug_renderer_info', 'WEBGL_depth_texture', 'WEBGL_draw_buffers', 'WEBGL_lose_context'],
    2: ['EXT_color_buffer_float', 'OES_texture_float_linear', 'WEBGL_debug_renderer_info', 'WEBGL_lose_context'],
  };
  const extClasses = new Map();
  M.getSupportedExtensions = function getSupportedExtensions() { const S = stOf(this); if (S.lost) return null; return EXT_ORDER[S.ver].slice(); };
  M.getExtension = function getExtension(name) {
    argsReq('WebGLRenderingContext', 'getExtension', 1, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    name = `${name}`;
    const want = name.toLowerCase().replace(/^(webkit_|moz_)/, '');
    const real = EXT_ORDER[S.ver].find((n) => n.toLowerCase() === want);
    if (!real) return null;
    let o = S.exts.get(real);
    if (o !== undefined) return o;
    let cls = extClasses.get(real);
    if (!cls) { cls = EXT[real].make(); extClasses.set(real, cls); }
    o = Object.create(cls.prototype);
    ctxOfExt.set(o, S.ctx);
    S.exts.set(real, o);
    return o;
  };

  // ---------------------------------------------------------------------------------------
  // Context loss
  // ---------------------------------------------------------------------------------------
  function fireEvent(S, type, cancelable) {
    const owner = S.owner;
    const ev = new G.classes.WebGLContextEvent(type, { cancelable, bubbles: false, statusMessage: '' });
    owner.dispatchEvent(ev);
    return ev;
  }
  function loseContext(S, viaExt) {
    if (S.lost) { if (viaExt) gerr2(S); return; }
    S.lost = true; S.lostErrorReported = false; S.restoreAllowed = false; S.viaExt = viaExt;
    L.postTask(() => {
      const ev = fireEvent(S, 'webglcontextlost', true);
      if (ev.defaultPrevented) S.restoreAllowed = true;
      if (S.restoreRequested && S.restoreAllowed) doRestore(S);
    });
  }
  function gerr2(S) { void S; /* a second loseContext() records INVALID_OPERATION on the lost context: not observable */ }
  function restoreContext(S) {
    if (!S.lost || !S.viaExt) return;
    S.restoreRequested = true;
    if (S.restoreAllowed) L.postTask(() => doRestore(S));
  }
  function doRestore(S) {
    if (!S.lost || S.restored) return;
    S.restored = true;
    const ctx = S.ctx;
    const S2 = G.initContextState(ctx, S.ver, S.canvasEl, S.owner, S.attrs);
    STATE.set(ctx, S2);
    ctxByCanvas.set(S.owner, { ctx, version: S.ver, S: S2 });
    fireEvent(S2, 'webglcontextrestored', false);
  }

  // ---------------------------------------------------------------------------------------
  // Context creation
  // ---------------------------------------------------------------------------------------
  const NativeCanvas = { present(id, bytes, w, h) { N.canvasPutImageData(id, bytes, w, h, 0, 0, 0, 0, w, h); } };
  G.initContextState = function initContextState(ctx, version, canvasEl, owner, attrs) {
    const S = createState(ctx, version, null, attrs);
    S.canvasEl = canvasEl; S.owner = owner;
    const id = L.idOf(canvasEl);
    S.canvas = { present: (bytes, w, h) => NativeCanvas.present(id, bytes, w, h) };
    const w = G.canvasW(canvasEl), h = G.canvasH(canvasEl);
    G.allocDrawingBuffer(S, w, h);
    S.viewport = [0, 0, w, h]; S.scissor = [0, 0, w, h];
    S.drawBuffers = [C.BACK];
    N.canvasReset(id, w, h);
    return S;
  };
  const toBool = (v, d) => (v === undefined ? d : !!v);
  G.createGL = function createGL(canvasEl, owner, version, attrIn) {
    const ent = ctxByCanvas.get(owner);
    if (ent !== undefined) return ent.version === version ? ent.ctx : null;
    G.applyProfile();
    const a = attrIn !== null && typeof attrIn === 'object' ? attrIn : {};
    const attrs = {
      alpha: toBool(a.alpha, true), depth: toBool(a.depth, true), stencil: toBool(a.stencil, false), antialias: false, premultipliedAlpha: toBool(a.premultipliedAlpha, true),
      preserveDrawingBuffer: toBool(a.preserveDrawingBuffer, false), powerPreference: ['low-power', 'high-performance'].includes(a.powerPreference) ? a.powerPreference : 'default',
      failIfMajorPerformanceCaveat: toBool(a.failIfMajorPerformanceCaveat, false), desynchronized: toBool(a.desynchronized, false), xrCompatible: toBool(a.xrCompatible, false),
    };
    const ProtoCls = version === 2 ? G.WebGL2RenderingContext : G.WebGLRenderingContext;
    // creation fails (and 'webglcontextcreationerror' fires) when a major performance caveat was refused
    let err = null;
    if (attrs.failIfMajorPerformanceCaveat && G.adapterInfo().renderer.includes('SwiftShader')) err = 'Software rendering only: failIfMajorPerformanceCaveat';
    const ctx = Object.create(ProtoCls.prototype);
    let S = null;
    if (err === null) {
      try { S = G.initContextState(ctx, version, canvasEl, owner, attrs); } catch (e) { err = `Could not allocate the drawing buffer: ${e && e.message}`; }
    }
    if (err !== null) {
      try { owner.dispatchEvent(new G.classes.WebGLContextEvent('webglcontextcreationerror', { cancelable: true, statusMessage: err })); } catch (_) { /* ignore */ }
      return null;
    }
    STATE.set(ctx, S);
    ctxByCanvas.set(owner, { ctx, version, S });
    return ctx;
  };
  // canvas dimensions (attributes of the element, defaults 300x150)
  G.canvasW = (el) => el.width;
  G.canvasH = (el) => el.height;
  // the canvas was resized: reallocate (and clear) the drawing buffer
  G.resizeGL = function resizeGL(owner, el) {
    const ent = ctxByCanvas.get(owner);
    if (!ent) return;
    const ctx = ent.ctx;
    const S = STATE.get(ctx);
    if (!S || S.lost) return;
    const w = G.canvasW(el), h = G.canvasH(el);
    if (w === S.w && h === S.h) { return; }
    try { G.allocDrawingBuffer(S, w, h); } catch (_) { loseContext(S, false); return; }
    N.canvasReset(L.idOf(el), w, h);
    // framebuffer bindings of the default framebuffer follow the new size; viewport and scissor keep their values
  };
  G.glFlushCanvas = function glFlushCanvas(owner) {
    const ent = ctxByCanvas.get(owner);
    if (!ent) return;
    const S = STATE.get(ent.ctx);
    if (S && !S.lost) G.flushToCanvas(S);
  };
  G.hasGL = (owner) => ctxByCanvas.has(owner);
  // Off by default (N.webglEnabled): contexts stay null until the software pipeline is fast enough for real pages.
  const GL_KINDS = { webgl: 1, 'experimental-webgl': 1, webgl2: 2 };
  // looked up lazily: the layer is snapshotted, the switch is read per process
  let glOn;
  L.glKind = (t) => { if (glOn === undefined) glOn = N.webglEnabled(); return glOn ? GL_KINDS[t] : undefined; };
  L.glGetContext = (canvasEl, owner, type, attrs) => G.createGL(canvasEl, owner, L.glKind(type), attrs);
  L.glResize = (owner, el) => G.resizeGL(owner, el);
  L.glFlush = (owner) => G.glFlushCanvas(owner);
  L.glOf = (owner) => ctxByCanvas.has(owner);

  // ---------------------------------------------------------------------------------------
  // Classes
  // ---------------------------------------------------------------------------------------
  function context2d(self, S) {
    void self; void S;
  }
  void context2d;
  // A per-class wrapper carrying the name and `length` Chromium's IDL gives the operation.
  function method(k, fn, version) {
    const w = { [k](...args) { return fn.apply(this, args); } }[k];
    const len = (G.LEN[version === 2 ? 'webgl2' : 'webgl'] || {})[k];
    Object.defineProperty(w, 'length', { value: len === undefined ? fn.length : len, configurable: true });
    return w;
  }
  function buildClass(name, version) {
    const cls = { [name]: class { constructor() { throw L.illegal(); } } }[name];
    const P = cls.prototype;
    const consts = version === 2 ? G.C2ALL : C;
    // collect every member first, then define them in Blink's order (V8 keeps insertion order, and the
    // non-configurable constants cannot be reordered afterwards)
    const defs = new Map();
    for (const k of Object.keys(consts)) defs.set(k, { value: consts[k], enumerable: true });
    const src = [M, version === 2 ? M2 : M1];
    for (const tbl of src) for (const k of Object.keys(tbl)) {
      if (k === 'vertexAttribDivisorImpl') continue;
      const fn = tbl[k];
      if (typeof fn !== 'function') continue;
      defs.set(k, { value: method(k, fn, version), writable: true, enumerable: true, configurable: true });
    }
    const named = (f, n) => { if (f) Object.defineProperty(f, 'name', { value: n, configurable: true }); return f; };
    const acc = (k, get, set) => defs.set(k, { get: named(get, `get ${k}`), set: set ? named(set, `set ${k}`) : undefined, enumerable: true, configurable: true });
    acc('canvas', function () { return stOf(this).owner; });
    acc('drawingBufferWidth', function () { return stOf(this).w; });
    acc('drawingBufferHeight', function () { return stOf(this).h; });
    acc('drawingBufferColorSpace', function () { stOf(this); return 'srgb'; }, function (v) { stOf(this); void v; });
    acc('unpackColorSpace', function () { stOf(this); return 'srgb'; }, function (v) { stOf(this); void v; });
    acc('drawingBufferFormat', function () { stOf(this); return C2.RGBA8; });
    defs.set('drawingBufferStorage', { value: function drawingBufferStorage(format, width, height) {
      argsReq(name, 'drawingBufferStorage', 3, arguments.length);
      const S = stOf(this); if (S.lost) return;
      format = glenum(format); width = glint(width); height = glint(height);
      if (format !== C2.RGBA8 && format !== C2.RGB8) return gerr(S, C.INVALID_ENUM);
      if (width <= 0 || height <= 0 || width > LIM.maxRenderbufferSize || height > LIM.maxRenderbufferSize) return gerr(S, C.INVALID_VALUE);
      try { G.allocDrawingBuffer(S, width, height); } catch (_) { gerr(S, C.OUT_OF_MEMORY); }
    }, writable: true, enumerable: true, configurable: true });
    defs.get('drawingBufferStorage').value = method('drawingBufferStorage', defs.get('drawingBufferStorage').value, version);
    defs.set('getContextAttributes', { value: function getContextAttributes() {
      const S = stOf(this);
      if (S.lost) return null;
      const a = S.attrs;
      return { alpha: a.alpha, antialias: a.antialias, depth: a.depth, desynchronized: a.desynchronized, failIfMajorPerformanceCaveat: a.failIfMajorPerformanceCaveat, powerPreference: a.powerPreference,
        premultipliedAlpha: a.premultipliedAlpha, preserveDrawingBuffer: a.preserveDrawingBuffer, stencil: a.stencil, xrCompatible: a.xrCompatible };
    }, writable: true, enumerable: true, configurable: true });
    defs.get('getContextAttributes').value = method('getContextAttributes', defs.get('getContextAttributes').value, version);
    defs.set('makeXRCompatible', { value: function makeXRCompatible() { stOf(this); return L.rejectedPromise(new L.DOMException('XR is not supported', 'NotSupportedError')); }, writable: true, enumerable: true, configurable: true });
    const order = G.ORDER[version === 2 ? 'webgl2' : 'webgl'].slice();
    order.splice(order.indexOf('pixelStorei'), 0, 'makeXRCompatible');
    const done = new Set();
    for (const k of order) {
      if (!defs.has(k)) continue;
      Object.defineProperty(P, k, defs.get(k));
      if (typeof defs.get(k).value === 'number') Object.defineProperty(cls, k, defs.get(k));
      done.add(k);
    }
    for (const [k, d] of defs) if (!done.has(k)) { Object.defineProperty(P, k, d); if (typeof d.value === 'number') Object.defineProperty(cls, k, d); }
    { const cd = Reflect.getOwnPropertyDescriptor(P, 'constructor'); Reflect.deleteProperty(P, 'constructor'); Reflect.defineProperty(P, 'constructor', cd); }
    L.orderedProtos.add(P);
    return cls;
  }
  G.WebGLRenderingContext = buildClass('WebGLRenderingContext', 1);
  G.WebGL2RenderingContext = buildClass('WebGL2RenderingContext', 2);
  L.expose('WebGLRenderingContext', G.WebGLRenderingContext);
  L.expose('WebGL2RenderingContext', G.WebGL2RenderingContext);
  for (const n of ['WebGLVertexArrayObject', 'WebGLSampler', 'WebGLSync', 'WebGLQuery', 'WebGLTransformFeedback']) L.expose(n, G.classes[n]);
  void OBJ; void wrapObj; void rec; void isObjOf; void glenum; void glint; void LIM; void C2;
})(globalThis.__layer);
