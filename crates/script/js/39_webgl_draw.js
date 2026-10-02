// 39_webgl_draw.js — WebGL API, part 3: renderbuffers, framebuffers, clear, draw calls, readPixels, copyTexImage,
// queries, sync objects, the default drawing buffer and its presentation into the canvas.
(function (L) {
  'use strict';
  const N = L.N;
  const G = L.glInternals;
  const { C, C2, E, LIM, FMT, Image, OBJ, wrapObj, rec, isObjOf, gerr, glenum, glint, glfloat, argsReq, stOf, classes } = G;
  const { WebGLRenderbuffer, WebGLFramebuffer, WebGLTexture, WebGLQuery, WebGLSync, WebGLTransformFeedback } = classes;
  const { M, M2 } = G;
  const IF1 = 'WebGLRenderingContext';
  const IF2 = 'WebGL2RenderingContext';

  // ---------------------------------------------------------------------------------------
  // Default drawing buffer
  // ---------------------------------------------------------------------------------------
  G.allocDrawingBuffer = function allocDrawingBuffer(S, w, h) {
    S.w = w; S.h = h;
    const n = w * h;
    S.fb0 = { w, h, color: new Uint8Array(n * 4), depth: S.attrs.depth || S.attrs.stencil ? new Float32Array(n) : null, stencil: S.attrs.stencil ? new Uint8Array(n) : null };
    G.clearDefaultBuffer(S);
  };
  G.clearDefaultBuffer = function clearDefaultBuffer(S) {
    const fb = S.fb0;
    fb.color.fill(0);
    if (!S.attrs.alpha) for (let i = 3; i < fb.color.length; i += 4) fb.color[i] = 255;
    if (fb.depth) fb.depth.fill(1);
    if (fb.stencil) fb.stencil.fill(0);
  };
  // Present the drawing buffer into the canvas surface (GL origin is bottom-left).
  G.present = function present(S) {
    if (S.lost || !S.canvas || !S.canvas.present) return;
    const { w, h } = S;
    if (w === 0 || h === 0) return;
    const src = S.fb0.color;
    const out = new Uint8Array(w * h * 4);
    const premul = S.attrs.premultipliedAlpha && S.attrs.alpha;
    for (let y = 0; y < h; y++) {
      let si = (h - 1 - y) * w * 4, di = y * w * 4;
      for (let x = 0; x < w; x++, si += 4, di += 4) {
        const a = src[si + 3];
        if (premul && a !== 255 && a !== 0) { out[di] = Math.min(255, Math.round(src[si] * 255 / a)); out[di + 1] = Math.min(255, Math.round(src[si + 1] * 255 / a)); out[di + 2] = Math.min(255, Math.round(src[si + 2] * 255 / a)); out[di + 3] = a; } else if (premul && a === 0) { out[di + 3] = 0; } else { out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = a; }
      }
    }
    S.canvas.present(out, w, h);
  };
  // After a task the buffer is composited; without preserveDrawingBuffer it is then cleared.
  G.schedulePresent = function schedulePresent(S) {
    if (S.presentScheduled) return;
    S.presentScheduled = true;
    L.postTask(() => {
      S.presentScheduled = false;
      if (!S.dirty) return;
      G.present(S); S.dirty = false;
      if (!S.attrs.preserveDrawingBuffer && !S.lost) { G.clearDefaultBuffer(S); S.cleared = true; }
    });
  };
  // Synchronous flush (toDataURL, drawImage of the canvas, createImageBitmap, texImage2D of the canvas)
  G.flushToCanvas = function flushToCanvas(S) { if (S.dirty) { G.present(S); } };

  // ---------------------------------------------------------------------------------------
  // Renderbuffers
  // ---------------------------------------------------------------------------------------
  M.createRenderbuffer = function createRenderbuffer() { const S = stOf(this); if (S.lost) return null; return wrapObj(WebGLRenderbuffer, S, { kind: 'rb', img: null, w: 0, h: 0, f: null, internal: 0, deleted: false, target: 0, samples: 0 }); };
  M.bindRenderbuffer = function bindRenderbuffer(target, rb) {
    argsReq(IF1, 'bindRenderbuffer', 2, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    if (target !== C.RENDERBUFFER) return gerr(S, C.INVALID_ENUM);
    if (rb === null || rb === undefined) { S.renderbuffer = null; return; }
    if (!(rb instanceof WebGLRenderbuffer)) throw G.typeErr(IF1, 'bindRenderbuffer', 2, 'WebGLRenderbuffer');
    if (!isObjOf(S, rb, WebGLRenderbuffer) || rec(rb).deleted) return gerr(S, C.INVALID_OPERATION);
    rec(rb).target = C.RENDERBUFFER; S.renderbuffer = rec(rb);
  };
  M.deleteRenderbuffer = function deleteRenderbuffer(rb) {
    argsReq(IF1, 'deleteRenderbuffer', 1, arguments.length);
    const S = stOf(this); if (S.lost || rb === null || rb === undefined) return;
    if (!(rb instanceof WebGLRenderbuffer)) throw G.typeErr(IF1, 'deleteRenderbuffer', 1, 'WebGLRenderbuffer');
    if (!isObjOf(S, rb, WebGLRenderbuffer)) return gerr(S, C.INVALID_OPERATION);
    const r = rec(rb); if (r.deleted) return;
    r.deleted = true; if (S.renderbuffer === r) S.renderbuffer = null;
    for (const fb of S.fbos || []) for (const [k, a] of fb.att) if (a.obj === r) fb.att.delete(k);
  };
  M.isRenderbuffer = function isRenderbuffer(rb) { const S = stOf(this); return !S.lost && isObjOf(S, rb, WebGLRenderbuffer) && !rec(rb).deleted && rec(rb).target !== 0; };
  const RB_FORMATS1 = [C.RGBA4, C.RGB565, C.RGB5_A1, C.DEPTH_COMPONENT16, C.STENCIL_INDEX8, C.DEPTH_STENCIL];
  function rbStorage(S, target, samples, internal, w, h, name) {
    if (target !== C.RENDERBUFFER) return gerr(S, C.INVALID_ENUM);
    const rb = S.renderbuffer;
    if (rb === null) return gerr(S, C.INVALID_OPERATION);
    const orig = internal;
    if (internal === C.DEPTH_STENCIL) internal = C2.DEPTH24_STENCIL8;
    let f = FMT.get(internal);
    const okFormat = orig === C.DEPTH_STENCIL || (S.ver === 2 ? (f && !f.unsized && G.colorRenderable(S, f) || f && (f.depth || f.stencil) && f.renderable) : (RB_FORMATS1.includes(orig) || (S.exts.has('EXT_color_buffer_half_float') && (internal === C2.RGBA16F || internal === C2.RGB16F)) || (S.exts.has('WEBGL_color_buffer_float') && internal === C2.RGBA32F)));
    if (!okFormat) return gerr(S, C.INVALID_ENUM);
    if (!f) f = FMT.get(internal);
    if (w < 0 || h < 0 || w > LIM.maxRenderbufferSize || h > LIM.maxRenderbufferSize) return gerr(S, C.INVALID_VALUE);
    if (S.ver === 2 && f.integer && samples > 0) return gerr(S, C.INVALID_OPERATION);
    if (samples > LIM.maxSamples) return gerr(S, C.INVALID_OPERATION);
    try { rb.img = new Image(w, h, 1, f); } catch (_) { return gerr(S, C.OUT_OF_MEMORY); }
    rb.w = w; rb.h = h; rb.f = f; rb.internal = internal; rb.samples = 0;
    void name;
  }
  M.renderbufferStorage = function renderbufferStorage(target, internal, w, h) {
    argsReq(IF1, 'renderbufferStorage', 4, arguments.length);
    const S = stOf(this); if (S.lost) return;
    rbStorage(S, glenum(target), 0, glenum(internal), glint(w), glint(h), 'renderbufferStorage');
  };
  M2.renderbufferStorageMultisample = function renderbufferStorageMultisample(target, samples, internal, w, h) {
    argsReq(IF2, 'renderbufferStorageMultisample', 5, arguments.length);
    const S = stOf(this); if (S.lost) return;
    samples = glint(samples);
    if (samples < 0) return gerr(S, C.INVALID_VALUE);
    rbStorage(S, glenum(target), samples, glenum(internal), glint(w), glint(h), 'renderbufferStorageMultisample');
  };
  M.getRenderbufferParameter = function getRenderbufferParameter(target, pname) {
    argsReq(IF1, 'getRenderbufferParameter', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; target = glenum(target); pname = glenum(pname);
    if (target !== C.RENDERBUFFER) { gerr(S, C.INVALID_ENUM); return null; }
    const rb = S.renderbuffer;
    if (rb === null) { gerr(S, C.INVALID_OPERATION); return null; }
    const f = rb.f;
    switch (pname) {
      case C.RENDERBUFFER_WIDTH: return rb.w; case C.RENDERBUFFER_HEIGHT: return rb.h;
      case C.RENDERBUFFER_INTERNAL_FORMAT: return rb.internal || C.RGBA4;
      case C.RENDERBUFFER_RED_SIZE: return f ? f.bits[0] : 0; case C.RENDERBUFFER_GREEN_SIZE: return f ? f.bits[1] : 0;
      case C.RENDERBUFFER_BLUE_SIZE: return f ? f.bits[2] : 0; case C.RENDERBUFFER_ALPHA_SIZE: return f ? f.bits[3] : 0;
      case C.RENDERBUFFER_DEPTH_SIZE: return f ? f.bits[4] : 0; case C.RENDERBUFFER_STENCIL_SIZE: return f ? f.bits[5] : 0;
      case C2.RENDERBUFFER_SAMPLES: if (S.ver === 2) return rb.samples; break;
      default: break;
    }
    gerr(S, C.INVALID_ENUM); return null;
  };

  // ---------------------------------------------------------------------------------------
  // Framebuffers
  // ---------------------------------------------------------------------------------------
  M.createFramebuffer = function createFramebuffer() {
    const S = stOf(this); if (S.lost) return null;
    const r = { kind: 'fbo', att: new Map(), drawBuffers: [C.COLOR_ATTACHMENT0], readBuffer: C.COLOR_ATTACHMENT0, deleted: false, target: 0 };
    (S.fbos || (S.fbos = [])).push(r);
    return wrapObj(WebGLFramebuffer, S, r);
  };
  function fbTargetSlots(S, target) {
    if (target === C.FRAMEBUFFER) return S.ver === 2 ? ['drawFb', 'readFb'] : ['drawFb', 'readFb'];
    if (S.ver === 2 && target === C2.DRAW_FRAMEBUFFER) return ['drawFb'];
    if (S.ver === 2 && target === C2.READ_FRAMEBUFFER) return ['readFb'];
    return null;
  }
  M.bindFramebuffer = function bindFramebuffer(target, fb) {
    argsReq(IF1, 'bindFramebuffer', 2, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    const slots = fbTargetSlots(S, target);
    if (slots === null) return gerr(S, C.INVALID_ENUM);
    if (fb !== null && fb !== undefined && !(fb instanceof WebGLFramebuffer)) throw G.typeErr(IF1, 'bindFramebuffer', 2, 'WebGLFramebuffer');
    if (fb === null || fb === undefined) { for (const s of slots) S[s] = null; return; }
    if (!isObjOf(S, fb, WebGLFramebuffer) || rec(fb).deleted) return gerr(S, C.INVALID_OPERATION);
    rec(fb).target = C.FRAMEBUFFER;
    for (const s of slots) S[s] = rec(fb);
  };
  M.deleteFramebuffer = function deleteFramebuffer(fb) {
    argsReq(IF1, 'deleteFramebuffer', 1, arguments.length);
    const S = stOf(this); if (S.lost || fb === null || fb === undefined) return;
    if (!(fb instanceof WebGLFramebuffer)) throw G.typeErr(IF1, 'deleteFramebuffer', 1, 'WebGLFramebuffer');
    if (!isObjOf(S, fb, WebGLFramebuffer)) return gerr(S, C.INVALID_OPERATION);
    const r = rec(fb); if (r.deleted) return;
    r.deleted = true;
    if (S.drawFb === r) S.drawFb = null; if (S.readFb === r) S.readFb = null;
  };
  M.isFramebuffer = function isFramebuffer(fb) { const S = stOf(this); return !S.lost && isObjOf(S, fb, WebGLFramebuffer) && !rec(fb).deleted && rec(fb).target !== 0; };
  G.detachTextureFromFbs = (S, t) => { for (const fb of S.fbos || []) for (const [k, a] of fb.att) if (a.obj === t) fb.att.delete(k); };
  const isColorAtt = (a, S) => (a >= C.COLOR_ATTACHMENT0 && a < C.COLOR_ATTACHMENT0 + (S.ver === 2 ? LIM.maxColorAttachments : 1));
  const validAtt = (S, a) => isColorAtt(a, S) || a === C.DEPTH_ATTACHMENT || a === C.STENCIL_ATTACHMENT || a === C.DEPTH_STENCIL_ATTACHMENT || (S.exts.has('WEBGL_draw_buffers') && a >= C.COLOR_ATTACHMENT0 && a < C.COLOR_ATTACHMENT0 + LIM.maxColorAttachments);
  function boundFb(S, target) {
    const slots = fbTargetSlots(S, target);
    if (slots === null) { gerr(S, C.INVALID_ENUM); return undefined; }
    return target === C2.READ_FRAMEBUFFER ? S.readFb : S.drawFb;
  }
  M.framebufferRenderbuffer = function framebufferRenderbuffer(target, att, rbt, rb) {
    argsReq(IF1, 'framebufferRenderbuffer', 4, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target); att = glenum(att); rbt = glenum(rbt);
    const fb = boundFb(S, target); if (fb === undefined) return;
    if (rbt !== C.RENDERBUFFER) return gerr(S, C.INVALID_ENUM);
    if (!validAtt(S, att)) return gerr(S, C.INVALID_ENUM);
    if (fb === null) return gerr(S, C.INVALID_OPERATION);
    if (rb === null || rb === undefined) { fb.att.delete(att); return; }
    if (!(rb instanceof WebGLRenderbuffer)) throw G.typeErr(IF1, 'framebufferRenderbuffer', 4, 'WebGLRenderbuffer');
    if (!isObjOf(S, rb, WebGLRenderbuffer) || rec(rb).deleted) return gerr(S, C.INVALID_OPERATION);
    if (att === C.DEPTH_STENCIL_ATTACHMENT) { fb.att.delete(C.DEPTH_ATTACHMENT); fb.att.delete(C.STENCIL_ATTACHMENT); }
    fb.att.set(att, { type: 'rb', obj: rec(rb), level: 0, layer: 0, face: 0 });
  };
  M.framebufferTexture2D = function framebufferTexture2D(target, att, textarget, tex, level) {
    argsReq(IF1, 'framebufferTexture2D', 5, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target); att = glenum(att); textarget = glenum(textarget); level = glint(level);
    const fb = boundFb(S, target); if (fb === undefined) return;
    if (!validAtt(S, att)) return gerr(S, C.INVALID_ENUM);
    if (fb === null) return gerr(S, C.INVALID_OPERATION);
    if (tex === null || tex === undefined) { fb.att.delete(att); if (att === C.DEPTH_STENCIL_ATTACHMENT) { fb.att.delete(C.DEPTH_ATTACHMENT); fb.att.delete(C.STENCIL_ATTACHMENT); } return; }
    if (!(tex instanceof WebGLTexture)) throw G.typeErr(IF1, 'framebufferTexture2D', 4, 'WebGLTexture');
    if (!isObjOf(S, tex, WebGLTexture) || rec(tex).deleted) return gerr(S, C.INVALID_OPERATION);
    const t = rec(tex);
    const isFace = textarget >= C.TEXTURE_CUBE_MAP_POSITIVE_X && textarget <= C.TEXTURE_CUBE_MAP_NEGATIVE_Z;
    if (textarget !== C.TEXTURE_2D && !isFace) return gerr(S, C.INVALID_ENUM);
    if ((textarget === C.TEXTURE_2D && t.target !== C.TEXTURE_2D) || (isFace && t.target !== C.TEXTURE_CUBE_MAP)) return gerr(S, C.INVALID_OPERATION);
    if (level < 0 || (S.ver === 1 && level !== 0 && !S.exts.has('OES_fbo_render_mipmap'))) return gerr(S, S.ver === 1 && level > 0 ? C.INVALID_VALUE : C.INVALID_VALUE);
    if (att === C.DEPTH_STENCIL_ATTACHMENT) { fb.att.delete(C.DEPTH_ATTACHMENT); fb.att.delete(C.STENCIL_ATTACHMENT); }
    fb.att.set(att, { type: 'tex', obj: t, level, layer: 0, face: isFace ? textarget - C.TEXTURE_CUBE_MAP_POSITIVE_X : 0 });
  };
  M2.framebufferTextureLayer = function framebufferTextureLayer(target, att, tex, level, layer) {
    argsReq(IF2, 'framebufferTextureLayer', 5, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target); att = glenum(att); level = glint(level); layer = glint(layer);
    const fb = boundFb(S, target); if (fb === undefined) return;
    if (!validAtt(S, att)) return gerr(S, C.INVALID_ENUM);
    if (fb === null) return gerr(S, C.INVALID_OPERATION);
    if (tex === null || tex === undefined) { fb.att.delete(att); return; }
    if (!isObjOf(S, tex, WebGLTexture) || rec(tex).deleted) return gerr(S, C.INVALID_OPERATION);
    const t = rec(tex);
    if (t.target !== C2.TEXTURE_3D && t.target !== C2.TEXTURE_2D_ARRAY) return gerr(S, C.INVALID_OPERATION);
    if (level < 0 || layer < 0) return gerr(S, C.INVALID_VALUE);
    if (att === C.DEPTH_STENCIL_ATTACHMENT) { fb.att.delete(C.DEPTH_ATTACHMENT); fb.att.delete(C.STENCIL_ATTACHMENT); }
    fb.att.set(att, { type: 'tex', obj: t, level, layer, face: 0 });
  };
  // The image behind an attachment (or undefined).
  function attImage(a) {
    if (a.type === 'rb') return a.obj.img || undefined;
    return G.getImg(a.obj, a.face, a.level);
  }
  G.attImage = attImage;
  // status of a framebuffer object (null: the default framebuffer, always complete)
  function fbStatus(S, fb) {
    if (fb === null) return C.FRAMEBUFFER_COMPLETE;
    let w = -1, h = -1, any = false;
    const dcount = (fb.att.has(C.DEPTH_ATTACHMENT) ? 1 : 0) + (fb.att.has(C.DEPTH_STENCIL_ATTACHMENT) ? 1 : 0);
    void dcount;
    for (const [k, a] of fb.att) {
      const img = attImage(a);
      if (!img || img.w === 0 || img.h === 0) return C.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      if (a.type === 'tex' && a.layer >= img.d) return C.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      const f = img.f;
      if (isColorAtt(k, S) || (k >= C.COLOR_ATTACHMENT0 && k < C.COLOR_ATTACHMENT0 + 16)) {
        if (!f.color || !G.colorRenderable(S, f)) return C.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      } else if (k === C.DEPTH_ATTACHMENT) { if (!f.depth) return C.FRAMEBUFFER_INCOMPLETE_ATTACHMENT; } else if (k === C.STENCIL_ATTACHMENT) { if (!f.stencil) return C.FRAMEBUFFER_INCOMPLETE_ATTACHMENT; } else if (k === C.DEPTH_STENCIL_ATTACHMENT) { if (!(f.depth && f.stencil)) return C.FRAMEBUFFER_INCOMPLETE_ATTACHMENT; }
      if (w === -1) { w = img.w; h = img.h; } else if (w !== img.w || h !== img.h) return C.FRAMEBUFFER_INCOMPLETE_DIMENSIONS;
      any = true;
    }
    if (!any) return C.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
    if (S.ver === 1 && fb.att.has(C.DEPTH_STENCIL_ATTACHMENT) && (fb.att.has(C.DEPTH_ATTACHMENT) || fb.att.has(C.STENCIL_ATTACHMENT))) return C.FRAMEBUFFER_UNSUPPORTED;
    return C.FRAMEBUFFER_COMPLETE;
  }
  G.fbStatus = fbStatus;
  G.colorRenderable = (S, f) => {
    if (S.ver === 2) {
      if (f.store === 'f32' && f.float32 === undefined && !f.half && f.internal !== C2.RGB10_A2) return f.renderable;
      if (f.internal === C2.R32F || f.internal === C2.RG32F || f.internal === C2.RGBA32F) return S.exts.has('EXT_color_buffer_float');
      if (f.internal === C2.R16F || f.internal === C2.RG16F || f.internal === C2.RGBA16F || f.internal === C2.R11F_G11F_B10F) return S.exts.has('EXT_color_buffer_float') || S.exts.has('EXT_color_buffer_half_float');
      return f.renderable;
    }
    if (f.unsized) {
      if (f.float32) return S.exts.has('WEBGL_color_buffer_float') && f.base === C.RGBA;
      if (f.half) return S.exts.has('EXT_color_buffer_half_float') && (f.base === C.RGBA || f.base === C.RGB);
      return f.renderable;
    }
    return f.renderable;
  };
  M.checkFramebufferStatus = function checkFramebufferStatus(target) {
    argsReq(IF1, 'checkFramebufferStatus', 1, arguments.length);
    const S = stOf(this); if (S.lost) return C.FRAMEBUFFER_UNSUPPORTED; target = glenum(target);
    const fb = boundFb(S, target); if (fb === undefined) return 0;
    return fbStatus(S, fb);
  };
  G.fbBits = function fbBits(S, fb, idx) {
    // idx 0..3 color r,g,b,a ; 4 depth ; 5 stencil
    if (idx < 4) { const a = fb.att.get(C.COLOR_ATTACHMENT0); if (!a) return 0; const img = attImage(a); return img ? img.f.bits[idx] : 0; }
    const a = fb.att.get(idx === 4 ? C.DEPTH_ATTACHMENT : C.STENCIL_ATTACHMENT) || fb.att.get(C.DEPTH_STENCIL_ATTACHMENT);
    if (!a) return 0; const img = attImage(a); return img ? img.f.bits[idx] : 0;
  };
  M.getFramebufferAttachmentParameter = function getFramebufferAttachmentParameter(target, att, pname) {
    argsReq(IF1, 'getFramebufferAttachmentParameter', 3, arguments.length);
    const S = stOf(this); if (S.lost) return null; target = glenum(target); att = glenum(att); pname = glenum(pname);
    const fb = boundFb(S, target); if (fb === undefined) return null;
    if (fb === null) {
      if (S.ver !== 2) { gerr(S, C.INVALID_OPERATION); return null; }
      const ok = [C.BACK, C.DEPTH, C2.DEPTH, C2.STENCIL].includes(att);
      if (!ok) { gerr(S, C.INVALID_ENUM); return null; }
      switch (pname) {
        case C.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: return C.NONE === 0 ? 0x1702 - 0x1702 + C.RENDERBUFFER - C.RENDERBUFFER + C2.FRAMEBUFFER_DEFAULT : 0;
        case C2.FRAMEBUFFER_ATTACHMENT_RED_SIZE: return 8; case C2.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE: return 8; case C2.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE: return 8;
        case C2.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE: return S.attrs.alpha ? 8 : 0; case C2.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE: return S.attrs.depth ? 24 : 0; case C2.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE: return S.attrs.stencil ? 8 : 0;
        case C2.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE: return 0x8C17; case C2.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING: return 0x2601;
        default: gerr(S, C.INVALID_ENUM); return null;
      }
    }
    if (!validAtt(S, att) && att !== C.DEPTH_STENCIL_ATTACHMENT) { gerr(S, C.INVALID_ENUM); return null; }
    let a = fb.att.get(att);
    if (!a && att === C.DEPTH_STENCIL_ATTACHMENT) a = fb.att.get(C.DEPTH_ATTACHMENT);
    if (!a) {
      if (pname === C.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) return C.NONE;
      if (pname === C.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME && S.ver === 2) return null;
      gerr(S, C.INVALID_OPERATION); return null;
    }
    const img = attImage(a);
    switch (pname) {
      case C.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: return a.type === 'rb' ? C.RENDERBUFFER : C.TEXTURE;
      case C.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: return a.obj.wrapper;
      case C.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: if (a.type === 'tex') return a.level; break;
      case C.FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: if (a.type === 'tex') return a.obj.target === C.TEXTURE_CUBE_MAP ? C.TEXTURE_CUBE_MAP_POSITIVE_X + a.face : 0; break;
      default: break;
    }
    if (S.ver === 2 || S.exts.has('EXT_color_buffer_half_float') || S.exts.has('WEBGL_color_buffer_float')) {
      const f = img && img.f;
      switch (pname) {
        case C2.FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER: if (a.type === 'tex') return a.layer; break;
        case C2.FRAMEBUFFER_ATTACHMENT_RED_SIZE: return f ? f.bits[0] : 0; case C2.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE: return f ? f.bits[1] : 0;
        case C2.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE: return f ? f.bits[2] : 0; case C2.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE: return f ? f.bits[3] : 0;
        case C2.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE: return f ? f.bits[4] : 0; case C2.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE: return f ? f.bits[5] : 0;
        case C2.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE: return !f ? C.NONE : f.integer ? (f.store === 'i32' ? C.INT : C.UNSIGNED_INT) : f.store === 'f32' && !f.depth ? C.FLOAT : f.store === 's8' ? C2.SIGNED_NORMALIZED : E.UNSIGNED_NORMALIZED_EXT;
        case C2.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING: return f && f.srgb ? C2.SRGB : C.LINEAR;
        default: break;
      }
    }
    gerr(S, C.INVALID_ENUM); return null;
  };
  M2.readBuffer = function readBuffer(src) {
    argsReq(IF2, 'readBuffer', 1, arguments.length);
    const S = stOf(this); if (S.lost) return; src = glenum(src);
    if (S.readFb === null) { if (src !== C.BACK && src !== C.NONE) return gerr(S, C.INVALID_OPERATION); S.readBuffer = src; return; }
    if (src !== C.NONE && !(src >= C.COLOR_ATTACHMENT0 && src < C.COLOR_ATTACHMENT0 + LIM.maxColorAttachments)) return gerr(S, C.INVALID_ENUM);
    S.readFb.readBuffer = src;
  };
  function drawBuffersImpl(S, bufs) {
    bufs = Array.from(bufs, glenum);
    if (bufs.length > LIM.maxDrawBuffers) return gerr(S, C.INVALID_VALUE);
    if (S.drawFb === null) {
      if (bufs.length !== 1 || (bufs[0] !== C.BACK && bufs[0] !== C.NONE)) return gerr(S, C.INVALID_OPERATION);
      S.drawBuffers = bufs; return;
    }
    for (let i = 0; i < bufs.length; i++) {
      const b = bufs[i];
      if (b === C.NONE) continue;
      if (b === C.BACK) return gerr(S, C.INVALID_OPERATION);
      if (!(b >= C.COLOR_ATTACHMENT0 && b < C.COLOR_ATTACHMENT0 + LIM.maxColorAttachments)) return gerr(S, C.INVALID_ENUM);
      if (b !== C.COLOR_ATTACHMENT0 + i) return gerr(S, C.INVALID_OPERATION);
    }
    S.drawFb.drawBuffers = bufs;
  }
  G.drawBuffersImpl = drawBuffersImpl;
  M2.drawBuffers = function drawBuffers(bufs) { argsReq(IF2, 'drawBuffers', 1, arguments.length); const S = stOf(this); if (!S.lost) drawBuffersImpl(S, bufs); };
  M2.invalidateFramebuffer = function invalidateFramebuffer() { const S = stOf(this); void S; };
  M2.invalidateSubFramebuffer = function invalidateSubFramebuffer() { const S = stOf(this); void S; };

  // ---------------------------------------------------------------------------------------
  // The render target of the draw / read framebuffer, as seen by the pipeline
  // ---------------------------------------------------------------------------------------
  // color: {data, store, w (row length), base (texel offset of the layer), f}
  G.renderTarget = function renderTarget(S, fb) {
    if (fb === null) {
      const d = S.fb0;
      return { w: d.w, h: d.h, def: true, colors: [{ data: d.color, store: 'u8', f: FMT.get(C2.RGBA8), base: 0, noAlpha: !S.attrs.alpha }], depth: d.depth ? { data: d.depth, stride: 1, base: 0 } : null,
        stencil: d.stencil ? { data: d.stencil, stride: 1, ch: 0, base: 0 } : null };
    }
    let w = 0, h = 0;
    const colors = [];
    for (let i = 0; i < fb.drawBuffers.length; i++) {
      const bufEnum = fb.drawBuffers[i];
      if (bufEnum === C.NONE) { colors.push(null); continue; }
      const a = fb.att.get(bufEnum);
      const img = a && attImage(a);
      if (!img) { colors.push(null); continue; }
      colors.push({ data: img.data, store: img.f.store, f: img.f, base: a.type === 'tex' ? a.layer * img.w * img.h : 0, w: img.w });
      w = img.w; h = img.h;
    }
    let depth = null, stencil = null;
    const da = fb.att.get(C.DEPTH_ATTACHMENT) || fb.att.get(C.DEPTH_STENCIL_ATTACHMENT);
    if (da) { const img = attImage(da); if (img) { depth = { data: img.data, stride: 4, base: da.type === 'tex' ? da.layer * img.w * img.h : 0, f: img.f }; w = img.w; h = img.h; } }
    const sa = fb.att.get(C.STENCIL_ATTACHMENT) || fb.att.get(C.DEPTH_STENCIL_ATTACHMENT);
    if (sa) { const img = attImage(sa); if (img) { stencil = { data: img.data, stride: 4, ch: img.f.depth ? 1 : 0, base: sa.type === 'tex' ? sa.layer * img.w * img.h : 0 }; w = img.w; h = img.h; } }
    if (!w) { for (const a of fb.att.values()) { const img = attImage(a); if (img) { w = img.w; h = img.h; break; } } }
    return { w, h, def: false, colors, depth, stencil };
  };

  // ---------------------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------------------
  const clampB = (v) => Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
  function colorToStore(f, store, c, k) {
    switch (store) {
      case 'u8': { let v = c < 0 ? 0 : c > 1 ? 1 : c; if (f.quant) { const q = f.quant[k]; v = Math.round(v * q) / q; } return Math.round(v * 255); }
      case 's8': return Math.round(Math.max(-1, Math.min(1, c)) * 127);
      case 'f32': return f.half ? L.fromHalf(L.toHalf(c)) : c;
      case 'i32': return c | 0;
      default: return c >>> 0;
    }
  }
  G.colorToStore = colorToStore;
  function scissorRect(S, tw, th) {
    let x0 = 0, y0 = 0, x1 = tw, y1 = th;
    if (S.scissorTest) { x0 = Math.max(0, S.scissor[0]); y0 = Math.max(0, S.scissor[1]); x1 = Math.min(tw, S.scissor[0] + S.scissor[2]); y1 = Math.min(th, S.scissor[1] + S.scissor[3]); }
    return [x0, y0, x1, y1];
  }
  G.scissorRect = scissorRect;
  function clearColorBuffer(S, col, rect, vals, mask) {
    if (!col) return;
    const [x0, y0, x1, y1] = rect;
    const w = col.w || S.w;
    const d = col.data;
    const v = [0, 1, 2, 3].map((k) => (mask[k] ? colorToStore(col.f, col.store, vals[k], k) : null));
    if (col.noAlpha) v[3] = null;
    for (let y = y0; y < y1; y++) {
      let o = (col.base + y * w + x0) * 4;
      for (let x = x0; x < x1; x++, o += 4) { for (let k = 0; k < 4; k++) if (v[k] !== null) d[o + k] = v[k]; }
    }
  }
  function clearDepthStencil(S, tgt, rect, doDepth, doStencil, dv, sv) {
    const [x0, y0, x1, y1] = rect;
    const w = tgt.w;
    if (doDepth && tgt.depth && S.depthMask) {
      const { data, stride, base } = tgt.depth;
      for (let y = y0; y < y1; y++) { let o = (base + y * w + x0) * stride; for (let x = x0; x < x1; x++, o += stride) data[o] = dv; }
    }
    if (doStencil && tgt.stencil) {
      const { data, stride, ch, base } = tgt.stencil;
      const m = S.stencilMask[0] & 0xff;
      for (let y = y0; y < y1; y++) { let o = (base + y * w + x0) * stride + ch; for (let x = x0; x < x1; x++, o += stride) data[o] = (data[o] & ~m) | (sv & m); }
    }
  }
  M.clear = function clear(mask) {
    argsReq(IF1, 'clear', 1, arguments.length);
    const S = stOf(this); if (S.lost) return; mask = Number(mask) >>> 0;
    if (mask & ~(C.COLOR_BUFFER_BIT | C.DEPTH_BUFFER_BIT | C.STENCIL_BUFFER_BIT)) return gerr(S, C.INVALID_VALUE);
    const fb = S.drawFb;
    if (fb && fbStatus(S, fb) !== C.FRAMEBUFFER_COMPLETE) return gerr(S, C.INVALID_FRAMEBUFFER_OPERATION);
    if (S.rasterizerDiscard) return;
    const tgt = G.renderTarget(S, fb);
    const rect = scissorRect(S, tgt.w, tgt.h);
    if (S.cleared) S.cleared = false;
    if (mask & C.COLOR_BUFFER_BIT) { for (const col of tgt.colors) if (col) clearColorBuffer(S, col, rect, S.clearColor, S.colorMask); }
    clearDepthStencil(S, tgt, rect, !!(mask & C.DEPTH_BUFFER_BIT), !!(mask & C.STENCIL_BUFFER_BIT), S.clearDepth, S.clearStencil);
    if (fb === null) G.markDirty(S);
  };
  function clearBuf(S, buffer, drawbuffer, type, vals, srcOffset) {
    buffer = glenum(buffer); drawbuffer = glint(drawbuffer);
    const fb = S.drawFb;
    if (fb && fbStatus(S, fb) !== C.FRAMEBUFFER_COMPLETE) return gerr(S, C.INVALID_FRAMEBUFFER_OPERATION);
    const need = buffer === C2.COLOR ? 4 : 1;
    if (!vals || vals.length < (srcOffset || 0) + need) return gerr(S, C.INVALID_VALUE);
    const v = Array.from(vals).slice(srcOffset || 0);
    const tgt = G.renderTarget(S, fb);
    const rect = scissorRect(S, tgt.w, tgt.h);
    if (buffer === C2.COLOR) {
      if (drawbuffer < 0 || drawbuffer >= LIM.maxDrawBuffers) return gerr(S, C.INVALID_VALUE);
      const col = tgt.colors[drawbuffer];
      if (col) {
        const isInt = col.f.integer;
        if ((type === 'f' && isInt) || (type !== 'f' && !isInt)) return gerr(S, C.INVALID_OPERATION);
        clearColorBuffer(S, col, rect, v, S.colorMask);
      }
    } else if (buffer === C2.DEPTH && type === 'f') { if (drawbuffer !== 0) return gerr(S, C.INVALID_VALUE); clearDepthStencil(S, tgt, rect, true, false, v[0], 0); } else if (buffer === C2.STENCIL && type === 'i') { if (drawbuffer !== 0) return gerr(S, C.INVALID_VALUE); clearDepthStencil(S, tgt, rect, false, true, 0, v[0]); } else return gerr(S, C.INVALID_ENUM);
    if (fb === null) G.markDirty(S);
  }
  M2.clearBufferfv = function clearBufferfv(b, d, v, o) { argsReq(IF2, 'clearBufferfv', 3, arguments.length); const S = stOf(this); if (!S.lost) clearBuf(S, b, d, 'f', v, o); };
  M2.clearBufferiv = function clearBufferiv(b, d, v, o) { argsReq(IF2, 'clearBufferiv', 3, arguments.length); const S = stOf(this); if (!S.lost) clearBuf(S, b, d, 'i', v, o); };
  M2.clearBufferuiv = function clearBufferuiv(b, d, v, o) { argsReq(IF2, 'clearBufferuiv', 3, arguments.length); const S = stOf(this); if (!S.lost) clearBuf(S, b, d, 'u', v, o); };
  M2.clearBufferfi = function clearBufferfi(b, d, depth, stencil) {
    argsReq(IF2, 'clearBufferfi', 4, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (glenum(b) !== C2.DEPTH_STENCIL || glint(d) !== 0) return gerr(S, C.INVALID_ENUM);
    const fb = S.drawFb;
    if (fb && fbStatus(S, fb) !== C.FRAMEBUFFER_COMPLETE) return gerr(S, C.INVALID_FRAMEBUFFER_OPERATION);
    const tgt = G.renderTarget(S, fb);
    clearDepthStencil(S, tgt, scissorRect(S, tgt.w, tgt.h), true, true, glfloat(depth), glint(stencil));
    if (fb === null) G.markDirty(S);
  };

  // ---------------------------------------------------------------------------------------
  // readPixels / copyTexImage
  // ---------------------------------------------------------------------------------------
  function readSource(S) {
    const fb = S.readFb;
    if (fb) {
      const st = fbStatus(S, fb);
      if (st !== C.FRAMEBUFFER_COMPLETE) { gerr(S, C.INVALID_FRAMEBUFFER_OPERATION); return null; }
      const a = fb.att.get(fb.readBuffer);
      const img = a && attImage(a);
      if (!img) { gerr(S, C.INVALID_OPERATION); return null; }
      return { w: img.w, h: img.h, data: img.data, store: img.f.store, f: img.f, base: a.type === 'tex' ? a.layer * img.w * img.h : 0 };
    }
    if (S.readBuffer === C.NONE) { gerr(S, C.INVALID_OPERATION); return null; }
    const d = S.fb0;
    return { w: d.w, h: d.h, data: d.color, store: 'u8', f: FMT.get(C2.RGBA8), base: 0, noAlpha: !S.attrs.alpha };
  }
  G.readSource = readSource;
  G.readFormat = function readFormat(S) {
    const fb = S.readFb;
    if (fb) {
      const a = fb.att.get(fb.readBuffer);
      const img = a && attImage(a);
      if (img) {
        const f = img.f;
        if (f.integer) return [C2.RGBA_INTEGER, f.store === 'i32' ? C.INT : C.UNSIGNED_INT];
        if (f.store === 'f32' && f.color) return [C.RGBA, C.FLOAT];
      }
    }
    return [C.RGBA, C.UNSIGNED_BYTE];
  };
  M.readPixels = function readPixels(x, y, w, h, format, type, pixels, dstOffset) {
    argsReq(IF1, 'readPixels', 7, arguments.length);
    const S = stOf(this); if (S.lost) return;
    x = glint(x); y = glint(y); w = glint(w); h = glint(h); format = glenum(format); type = glenum(type);
    const pbo = S.ver === 2 && S.pixelPack !== null && typeof pixels === 'number';
    if (!pbo && pixels !== null && pixels !== undefined && !ArrayBuffer.isView(pixels)) throw new TypeError(`Failed to execute 'readPixels' on '${S.ver === 2 ? IF2 : IF1}': parameter 7 is not of type 'ArrayBufferView'.`);
    if (w < 0 || h < 0) return gerr(S, C.INVALID_VALUE);
    const src = readSource(S); if (src === null) return;
    const [rf, rt] = G.readFormat(S);
    const okCombo = (format === rf && type === rt) || (format === C.RGBA && type === C.UNSIGNED_BYTE && !src.f.integer) || (S.ver === 2 && !src.f.integer && ((format === C.RGBA && type === C.FLOAT && src.store === 'f32') || (format === C2.RED && type === C.UNSIGNED_BYTE) || (format === C2.RG && type === C.UNSIGNED_BYTE) || (format === C.RGB && type === C.UNSIGNED_BYTE)));
    if (PIXEL_BYTES(type) === 0 || G.BASE_COMPONENTS[format] === undefined) return gerr(S, C.INVALID_ENUM);
    if (!okCombo) return gerr(S, C.INVALID_OPERATION);
    if (S.ver === 1 && pixels === null) return gerr(S, C.INVALID_VALUE);
    const lay = G.layoutOfType(format, type);
    const P = S.pack;
    const rowLen = P.rowLength > 0 ? P.rowLength : w;
    const rowBytes = Math.ceil(rowLen * lay.bytes / P.align) * P.align;
    const start = P.skipPixels * lay.bytes + P.skipRows * rowBytes;
    const need = start + (w > 0 && h > 0 ? (h - 1) * rowBytes + w * lay.bytes : 0);
    let bytes, base;
    if (pbo) { bytes = S.pixelPack.data; base = Number(pixels); if (base + need > bytes.length) return gerr(S, C.INVALID_OPERATION); } else {
      if (pixels === null || pixels === undefined) return;
      const es = pixels instanceof DataView ? 1 : pixels.BYTES_PER_ELEMENT;
      if (S.ver === 1) {
        const want = type === C.UNSIGNED_BYTE ? Uint8Array : Float32Array;
        if (!(pixels instanceof want) && !(type === C.UNSIGNED_BYTE && pixels instanceof Uint8ClampedArray)) return gerr(S, C.INVALID_OPERATION);
      } else {
        const ok = { [C.UNSIGNED_BYTE]: [Uint8Array, Uint8ClampedArray], [C.FLOAT]: [Float32Array], [C.INT]: [Int32Array], [C.UNSIGNED_INT]: [Uint32Array], [C.BYTE]: [Int8Array] }[type];
        if (ok && !ok.some((c) => pixels instanceof c)) return gerr(S, C.INVALID_OPERATION);
      }
      bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      base = (dstOffset ? Number(dstOffset) : 0) * es;
      if (base + need > bytes.length) return gerr(S, C.INVALID_OPERATION);
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const comps = lay.comps;
    const kind = src.store === 'u8' ? 'u8' : (src.store === 'i32' || src.store === 'u32') ? 'i' : src.store === 's8' ? 'f' : 'f';
    const vals = [0, 0, 0, 0];
    for (let row = 0; row < h; row++) {
      const sy = y + row;
      for (let col = 0; col < w; col++) {
        const sx = x + col;
        const off = base + start + row * rowBytes + col * lay.bytes;
        if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) { for (let k = 0; k < 4; k++) vals[k] = 0; } else {
          const o = (src.base + sy * src.w + sx) * 4;
          for (let k = 0; k < 4; k++) vals[k] = src.data[o + k];
          if (src.noAlpha) vals[3] = 255;
          if (src.store === 's8') for (let k = 0; k < 4; k++) vals[k] = Math.max(vals[k] / 127, -1);
          if (src.f.base === C.ALPHA) { vals[0] = vals[1] = vals[2] = 0; }
        }
        const out = comps.map((c) => (c === 'r' ? vals[0] : c === 'g' ? vals[1] : c === 'b' ? vals[2] : c === 'a' ? vals[3] : vals[0]));
        G.packTexel(dv, off, type, comps, out, kind);
      }
    }
  };
  const PIXEL_BYTES = (type) => G.PIXEL_TYPE_BYTES[type] || 0;

  // read the current read framebuffer as normalized RGBA floats (or raw values for integer formats)
  function readRegionAsImage(S, x, y, w, h, f) {
    const src = readSource(S); if (src === null) return null;
    const img = new Image(w, h, 1, f);
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      const sx = x + col, sy = y + row;
      const o = (row * w + col) * 4;
      if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) { img.data[o + 3] = f.channels < 4 && f.base !== C.ALPHA ? img.data[o + 3] : 0; continue; }
      const so = (src.base + sy * src.w + sx) * 4;
      for (let k = 0; k < 4; k++) {
        let v = src.data[so + k];
        if (k === 3 && src.noAlpha) v = 255;
        // convert between store domains through normalized floats
        const norm = src.store === 'u8' ? v / 255 : src.store === 's8' ? v / 127 : v;
        img.data[o + k] = colorToStore(f, f.store, norm, k);
      }
      if (f.channels < 4 && f.base !== C.ALPHA && !f.lum) { if (f.channels < 4) img.data[o + 3] = f.store === 'u8' ? 255 : f.store === 's8' ? 127 : 1; }
      if (f.lum) { if (f.base === C.LUMINANCE || f.base === C.LUMINANCE_ALPHA) { img.data[o + 1] = img.data[o + 2] = img.data[o]; } if (f.base === C.LUMINANCE) img.data[o + 3] = f.store === 'u8' ? 255 : 1; if (f.base === C.ALPHA) { img.data[o] = img.data[o + 1] = img.data[o + 2] = 0; } }
    }
    return img;
  }
  M.copyTexImage2D = function copyTexImage2D(target, level, internal, x, y, w, h, border) {
    argsReq(IF1, 'copyTexImage2D', 8, arguments.length);
    const S = stOf(this); if (S.lost) return;
    target = glenum(target); level = glint(level); internal = glenum(internal); x = glint(x); y = glint(y); w = glint(w); h = glint(h); border = glint(border);
    const isFace = target >= C.TEXTURE_CUBE_MAP_POSITIVE_X && target <= C.TEXTURE_CUBE_MAP_NEGATIVE_Z;
    if (target !== C.TEXTURE_2D && !isFace) return gerr(S, C.INVALID_ENUM);
    if (border !== 0 || w < 0 || h < 0 || level < 0) return gerr(S, C.INVALID_VALUE);
    const t = G.boundTex(S, isFace ? C.TEXTURE_CUBE_MAP : C.TEXTURE_2D);
    if (t === null) return gerr(S, C.INVALID_OPERATION);
    let f;
    if (S.ver === 2) { f = FMT.get(internal); if (!f || f.depth || f.stencil) { if (f || ![C.RGBA, C.RGB, C.LUMINANCE, C.LUMINANCE_ALPHA, C.ALPHA].includes(internal)) return gerr(S, C.INVALID_ENUM); } if (!f) f = G.UNSIZED.get(internal * 65536 + C.UNSIGNED_BYTE); } else {
      if (![C.ALPHA, C.LUMINANCE, C.LUMINANCE_ALPHA, C.RGB, C.RGBA].includes(internal)) return gerr(S, C.INVALID_ENUM);
      f = G.UNSIZED.get(internal * 65536 + C.UNSIGNED_BYTE);
    }
    if (isFace && w !== h) return gerr(S, C.INVALID_VALUE);
    if (w > LIM.maxTextureSize || h > LIM.maxTextureSize) return gerr(S, C.INVALID_VALUE);
    if (t.immutable) return gerr(S, C.INVALID_OPERATION);
    const img = readRegionAsImage(S, x, y, w, h, f);
    if (img === null) return;
    t.imgs.set(G.imgKey(isFace ? target - C.TEXTURE_CUBE_MAP_POSITIVE_X : 0, level), img);
    t.serial++;
  };
  function copySub(S, target, level, xo, yo, zo, x, y, w, h) {
    const isFace = target >= C.TEXTURE_CUBE_MAP_POSITIVE_X && target <= C.TEXTURE_CUBE_MAP_NEGATIVE_Z;
    const t = G.boundTex(S, isFace ? C.TEXTURE_CUBE_MAP : target);
    if (t === null) return gerr(S, C.INVALID_OPERATION);
    const dst = G.getImg(t, isFace ? target - C.TEXTURE_CUBE_MAP_POSITIVE_X : 0, level);
    if (!dst) return gerr(S, C.INVALID_OPERATION);
    if (xo < 0 || yo < 0 || zo < 0 || w < 0 || h < 0 || xo + w > dst.w || yo + h > dst.h || zo >= dst.d) return gerr(S, C.INVALID_VALUE);
    if (dst.f.depth || dst.f.stencil) return gerr(S, C.INVALID_OPERATION);
    const img = readRegionAsImage(S, x, y, w, h, dst.f);
    if (img === null) return;
    for (let row = 0; row < h; row++) dst.data.set(img.data.subarray(row * w * 4, (row + 1) * w * 4), (((zo * dst.h) + yo + row) * dst.w + xo) * 4);
    t.serial++;
  }
  M.copyTexSubImage2D = function copyTexSubImage2D(target, level, xo, yo, x, y, w, h) {
    argsReq(IF1, 'copyTexSubImage2D', 8, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    const isFace = target >= C.TEXTURE_CUBE_MAP_POSITIVE_X && target <= C.TEXTURE_CUBE_MAP_NEGATIVE_Z;
    if (target !== C.TEXTURE_2D && !isFace) return gerr(S, C.INVALID_ENUM);
    copySub(S, target, glint(level), glint(xo), glint(yo), 0, glint(x), glint(y), glint(w), glint(h));
  };
  M2.copyTexSubImage3D = function copyTexSubImage3D(target, level, xo, yo, zo, x, y, w, h) {
    argsReq(IF2, 'copyTexSubImage3D', 9, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    if (target !== C2.TEXTURE_3D && target !== C2.TEXTURE_2D_ARRAY) return gerr(S, C.INVALID_ENUM);
    copySub(S, target, glint(level), glint(xo), glint(yo), glint(zo), glint(x), glint(y), glint(w), glint(h));
  };
  // blit (nearest; linear for color when asked)
  M2.blitFramebuffer = function blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) {
    argsReq(IF2, 'blitFramebuffer', 10, arguments.length);
    const S = stOf(this); if (S.lost) return;
    [sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1] = [sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1].map(glint); mask = Number(mask) >>> 0; filter = glenum(filter);
    if (filter !== C.NEAREST && filter !== C.LINEAR) return gerr(S, C.INVALID_ENUM);
    if (mask & ~(C.COLOR_BUFFER_BIT | C.DEPTH_BUFFER_BIT | C.STENCIL_BUFFER_BIT)) return gerr(S, C.INVALID_VALUE);
    if (S.drawFb && fbStatus(S, S.drawFb) !== C.FRAMEBUFFER_COMPLETE) return gerr(S, C.INVALID_FRAMEBUFFER_OPERATION);
    if (S.readFb && fbStatus(S, S.readFb) !== C.FRAMEBUFFER_COMPLETE) return gerr(S, C.INVALID_FRAMEBUFFER_OPERATION);
    const rt = G.renderTarget(S, S.readFb);
    const dtg = G.renderTarget(S, S.drawFb);
    const sw = sx1 - sx0, sh = sy1 - sy0, dw = dx1 - dx0, dh = dy1 - dy0;
    if (sw === 0 || sh === 0 || dw === 0 || dh === 0) return;
    // the read target's color buffer is the read buffer attachment
    const readSrc = (mask & C.COLOR_BUFFER_BIT) ? readSource(S) : null;
    const dcol = dtg.colors[0];
    if (mask & C.COLOR_BUFFER_BIT) {
      if (readSrc && dcol) {
        for (let y = 0; y < Math.abs(dh); y++) for (let x = 0; x < Math.abs(dw); x++) {
          const dx = (dw > 0 ? dx0 + x : dx0 - 1 - x), dy = (dh > 0 ? dy0 + y : dy0 - 1 - y);
          if (dx < 0 || dy < 0 || dx >= dtg.w || dy >= dtg.h) continue;
          if (S.scissorTest && (dx < S.scissor[0] || dy < S.scissor[1] || dx >= S.scissor[0] + S.scissor[2] || dy >= S.scissor[1] + S.scissor[3])) continue;
          const fx = (x + 0.5) * Math.abs(sw) / Math.abs(dw), fy = (y + 0.5) * Math.abs(sh) / Math.abs(dh);
          const sx = sw > 0 ? sx0 + fx : sx0 - fx, sy = sh > 0 ? sy0 + fy : sy0 - fy;
          const px = Math.floor(sx), py = Math.floor(sy);
          if (px < 0 || py < 0 || px >= readSrc.w || py >= readSrc.h) continue;
          const so = (readSrc.base + py * readSrc.w + px) * 4, dof = (dcol.base + dy * (dcol.w || dtg.w) + dx) * 4;
          for (let k = 0; k < 4; k++) {
            if (!S.colorMask[k] && false) continue;
            let v = readSrc.data[so + k];
            if (readSrc.store !== dcol.store) { const norm = readSrc.store === 'u8' ? v / 255 : readSrc.store === 's8' ? v / 127 : v; v = colorToStore(dcol.f, dcol.store, norm, k); }
            dcol.data[dof + k] = v;
          }
        }
      }
    }
    if ((mask & C.DEPTH_BUFFER_BIT) && rt.depth && dtg.depth) {
      for (let y = 0; y < Math.abs(dh); y++) for (let x = 0; x < Math.abs(dw); x++) {
        const dx = dw > 0 ? dx0 + x : dx0 - 1 - x, dy = dh > 0 ? dy0 + y : dy0 - 1 - y;
        const px = Math.floor(sw > 0 ? sx0 + (x + 0.5) * Math.abs(sw) / Math.abs(dw) : sx0 - (x + 0.5) * Math.abs(sw) / Math.abs(dw)), py = Math.floor(sh > 0 ? sy0 + (y + 0.5) * Math.abs(sh) / Math.abs(dh) : sy0 - (y + 0.5) * Math.abs(sh) / Math.abs(dh));
        if (dx < 0 || dy < 0 || dx >= dtg.w || dy >= dtg.h || px < 0 || py < 0 || px >= rt.w || py >= rt.h) continue;
        dtg.depth.data[(dtg.depth.base + dy * dtg.w + dx) * dtg.depth.stride] = rt.depth.data[(rt.depth.base + py * rt.w + px) * rt.depth.stride];
      }
    }
    if ((mask & C.STENCIL_BUFFER_BIT) && rt.stencil && dtg.stencil) {
      for (let y = 0; y < Math.abs(dh); y++) for (let x = 0; x < Math.abs(dw); x++) {
        const dx = dw > 0 ? dx0 + x : dx0 - 1 - x, dy = dh > 0 ? dy0 + y : dy0 - 1 - y;
        const px = Math.floor(sw > 0 ? sx0 + (x + 0.5) * Math.abs(sw) / Math.abs(dw) : sx0 - (x + 0.5) * Math.abs(sw) / Math.abs(dw)), py = Math.floor(sh > 0 ? sy0 + (y + 0.5) * Math.abs(sh) / Math.abs(dh) : sy0 - (y + 0.5) * Math.abs(sh) / Math.abs(dh));
        if (dx < 0 || dy < 0 || dx >= dtg.w || dy >= dtg.h || px < 0 || py < 0 || px >= rt.w || py >= rt.h) continue;
        dtg.stencil.data[(dtg.stencil.base + dy * dtg.w + dx) * dtg.stencil.stride + dtg.stencil.ch] = rt.stencil.data[(rt.stencil.base + py * rt.w + px) * rt.stencil.stride + rt.stencil.ch];
      }
    }
    if (S.drawFb === null) G.markDirty(S);
  };

  // ---------------------------------------------------------------------------------------
  // Draw calls
  // ---------------------------------------------------------------------------------------
  const MODES = [C.POINTS, C.LINES, C.LINE_LOOP, C.LINE_STRIP, C.TRIANGLES, C.TRIANGLE_STRIP, C.TRIANGLE_FAN];
  const ATTR_SIZES = { [C.BYTE]: 1, [C.UNSIGNED_BYTE]: 1, [C.SHORT]: 2, [C.UNSIGNED_SHORT]: 2, [C.INT]: 4, [C.UNSIGNED_INT]: 4, [C.FLOAT]: 4, [C2.HALF_FLOAT]: 2, [C2.INT_2_10_10_10_REV]: 4, [C2.UNSIGNED_INT_2_10_10_10_REV]: 4 };
  G.ATTR_SIZES = ATTR_SIZES;
  // Common validation. Returns the prepared draw description or null (error recorded).
  function prepareDraw(S, mode, instances, indexed) {
    const prog = S.program;
    if (prog === null || !prog.linked) { gerr(S, C.INVALID_OPERATION); return null; }
    if (!MODES.includes(mode)) { gerr(S, C.INVALID_ENUM); return null; }
    if (S.drawFb) {
      const st = fbStatus(S, S.drawFb);
      if (st !== C.FRAMEBUFFER_COMPLETE) { gerr(S, C.INVALID_FRAMEBUFFER_OPERATION); return null; }
    }
    // feedback loops: a bound texture that is also an attachment of the draw framebuffer
    if (S.drawFb) {
      const samplerLeaves = prog.link.active.filter((lf) => L.glsl.info(lf.t).kind === 'sampler');
      for (const lf of samplerLeaves) {
        const vals = prog.link.values.get(lf);
        const units = lf.isArray ? vals : [vals];
        for (const u of units) {
          const unit = u ? u[0] | 0 : 0;
          const tex = textureForSampler(S, unit, L.glsl.info(lf.t).dim);
          if (tex) for (const a of S.drawFb.att.values()) if (a.obj === tex) { gerr(S, C.INVALID_OPERATION); return null; }
        }
      }
    }
    // sampler units: one unit must not be used with two different sampler types
    const unitTypes = new Map();
    for (const lf of prog.link.active) {
      const ti = L.glsl.info(lf.t);
      if (ti.kind !== 'sampler') continue;
      const vals = prog.link.values.get(lf);
      for (const u of (lf.isArray ? vals : [vals])) {
        const unit = u ? u[0] | 0 : 0;
        const prev = unitTypes.get(unit);
        if (prev !== undefined && prev !== ti.dim) { gerr(S, C.INVALID_OPERATION); return null; }
        unitTypes.set(unit, ti.dim);
      }
    }
    // attributes
    const attrs = S.vao.attribs;
    for (const a of prog.link.activeAttrs) {
      for (let s = 0; s < a.slots; s++) {
        const at = attrs[a.loc + s];
        if (at.enabled && at.buffer === null) { gerr(S, C.INVALID_OPERATION); return null; }
      }
    }
    return { prog };
  }
  function textureForSampler(S, unit, dim) {
    const u = S.units[unit];
    if (!u) return null;
    const slot = dim === '2D' || dim === '2DShadow' ? 't2d' : dim === 'Cube' || dim === 'CubeShadow' ? 'cube' : dim === '3D' ? 't3d' : 't2da';
    return u[slot];
  }
  G.textureForSampler = textureForSampler;
  // range check of enabled attribute buffers for vertices [first, first+count) and instances
  function checkAttribRange(S, prog, maxVertex, instances) {
    for (const a of prog.link.activeAttrs) {
      for (let s = 0; s < a.slots; s++) {
        const at = S.vao.attribs[a.loc + s];
        if (!at.enabled) continue;
        const es = ATTR_SIZES[at.type] * at.size;
        const stride = at.stride || es;
        const lastIndex = at.divisor === 0 ? maxVertex : Math.max(0, Math.ceil(instances / at.divisor) - 1);
        if (at.divisor === 0 && maxVertex < 0) continue;
        if (at.divisor !== 0 && instances === 0) continue;
        const need = at.offset + lastIndex * stride + es;
        if (need > at.buffer.size) { gerr(S, C.INVALID_OPERATION); return false; }
      }
    }
    return true;
  }
  function doDraw(S, mode, count, first, indexInfo, instances) {
    if (S.lost) return;
    const prep = prepareDraw(S, mode, instances, indexInfo !== null);
    if (prep === null) return;
    if (count === 0 || instances === 0) return;
    let maxVertex;
    if (indexInfo === null) maxVertex = first + count - 1; else {
      const ib = indexInfo.buffer;
      const bs = indexInfo.size;
      let mx = -1;
      const dv = new DataView(ib.data.buffer, ib.data.byteOffset, ib.data.byteLength);
      for (let i = 0; i < count; i++) {
        const o = indexInfo.offset + i * bs;
        const v = bs === 1 ? dv.getUint8(o) : bs === 2 ? dv.getUint16(o, true) : dv.getUint32(o, true);
        if (v > mx) mx = v;
      }
      maxVertex = mx;
    }
    if (!checkAttribRange(S, prep.prog, maxVertex, instances)) return;
    if (S.rasterizerDiscard && !(S.tf && S.tf.active)) return;
    if (G.rasterDraw) G.rasterDraw(S, prep.prog, mode, count, first, indexInfo, instances);
    if (S.drawFb === null) G.markDirty(S);
  }
  M.drawArrays = function drawArrays(mode, first, count) {
    argsReq(IF1, 'drawArrays', 3, arguments.length);
    const S = stOf(this); if (S.lost) return; mode = glenum(mode); first = glint(first); count = glint(count);
    if (first < 0 || count < 0) return gerr(S, C.INVALID_VALUE);
    doDraw(S, mode, count, first, null, 1);
  };
  function elementInfo(S, type, count, offset) {
    if (type !== C.UNSIGNED_BYTE && type !== C.UNSIGNED_SHORT && !(type === C.UNSIGNED_INT && (S.ver === 2 || S.exts.has('OES_element_index_uint')))) { gerr(S, C.INVALID_ENUM); return null; }
    if (count < 0 || offset < 0) { gerr(S, C.INVALID_VALUE); return null; }
    const size = type === C.UNSIGNED_BYTE ? 1 : type === C.UNSIGNED_SHORT ? 2 : 4;
    if (offset % size !== 0) { gerr(S, C.INVALID_OPERATION); return null; }
    const b = S.vao.element;
    if (b === null) { gerr(S, C.INVALID_OPERATION); return null; }
    if (offset + count * size > b.size) { gerr(S, C.INVALID_OPERATION); return null; }
    return { buffer: b, size, offset, type };
  }
  M.drawElements = function drawElements(mode, count, type, offset) {
    argsReq(IF1, 'drawElements', 4, arguments.length);
    const S = stOf(this); if (S.lost) return; mode = glenum(mode); count = glint(count); type = glenum(type); offset = Number(offset);
    if (!MODES.includes(mode)) return gerr(S, C.INVALID_ENUM);
    const info = elementInfo(S, type, count, offset); if (info === null) return;
    doDraw(S, mode, count, 0, info, 1);
  };
  G.drawArraysInstancedImpl = function (S, mode, first, count, instances) {
    mode = glenum(mode); first = glint(first); count = glint(count); instances = glint(instances);
    if (first < 0 || count < 0 || instances < 0) return gerr(S, C.INVALID_VALUE);
    doDraw(S, mode, count, first, null, instances);
  };
  G.drawElementsInstancedImpl = function (S, mode, count, type, offset, instances) {
    mode = glenum(mode); count = glint(count); type = glenum(type); offset = Number(offset); instances = glint(instances);
    if (!MODES.includes(mode)) return gerr(S, C.INVALID_ENUM);
    if (instances < 0) return gerr(S, C.INVALID_VALUE);
    const info = elementInfo(S, type, count, offset); if (info === null) return;
    doDraw(S, mode, count, 0, info, instances);
  };
  M2.drawArraysInstanced = function drawArraysInstanced(mode, first, count, instances) { argsReq(IF2, 'drawArraysInstanced', 4, arguments.length); const S = stOf(this); if (!S.lost) G.drawArraysInstancedImpl(S, mode, first, count, instances); };
  M2.drawElementsInstanced = function drawElementsInstanced(mode, count, type, offset, instances) { argsReq(IF2, 'drawElementsInstanced', 5, arguments.length); const S = stOf(this); if (!S.lost) G.drawElementsInstancedImpl(S, mode, count, type, offset, instances); };
  M2.drawRangeElements = function drawRangeElements(mode, start, end, count, type, offset) {
    argsReq(IF2, 'drawRangeElements', 6, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (glint(end) < glint(start)) return gerr(S, C.INVALID_VALUE);
    M.drawElements.call(this, mode, count, type, offset);
  };

  // ---------------------------------------------------------------------------------------
  // Queries, sync objects, transform feedback objects (WebGL2)
  // ---------------------------------------------------------------------------------------
  M2.createQuery = function createQuery() { const S = stOf(this); if (S.lost) return null; return wrapObj(WebGLQuery, S, { kind: 'query', target: 0, active: false, result: 0, available: false, deleted: false }); };
  M2.deleteQuery = function deleteQuery(q) {
    const S = stOf(this); if (S.lost || q === null || q === undefined) return;
    if (!(q instanceof WebGLQuery)) throw G.typeErr(IF2, 'deleteQuery', 1, 'WebGLQuery');
    if (!isObjOf(S, q, WebGLQuery)) return gerr(S, C.INVALID_OPERATION);
    rec(q).deleted = true;
  };
  M2.isQuery = function isQuery(q) { const S = stOf(this); return !S.lost && isObjOf(S, q, WebGLQuery) && !rec(q).deleted && rec(q).target !== 0; };
  const QTARGET = (t) => t === C2.ANY_SAMPLES_PASSED || t === C2.ANY_SAMPLES_PASSED_CONSERVATIVE || t === C2.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN;
  M2.beginQuery = function beginQuery(target, q) {
    argsReq(IF2, 'beginQuery', 2, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    if (!QTARGET(target)) return gerr(S, C.INVALID_ENUM);
    if (!(q instanceof WebGLQuery)) throw G.typeErr(IF2, 'beginQuery', 2, 'WebGLQuery');
    if (!isObjOf(S, q, WebGLQuery) || rec(q).deleted) return gerr(S, C.INVALID_OPERATION);
    const r = rec(q);
    if (S.activeQueries && S.activeQueries[target]) return gerr(S, C.INVALID_OPERATION);
    if (r.target !== 0 && r.target !== target) return gerr(S, C.INVALID_OPERATION);
    if (r.active) return gerr(S, C.INVALID_OPERATION);
    r.target = target; r.active = true; r.result = 0; r.available = false;
    (S.activeQueries || (S.activeQueries = {}))[target] = r;
  };
  M2.endQuery = function endQuery(target) {
    argsReq(IF2, 'endQuery', 1, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    if (!QTARGET(target)) return gerr(S, C.INVALID_ENUM);
    const r = S.activeQueries && S.activeQueries[target];
    if (!r) return gerr(S, C.INVALID_OPERATION);
    r.active = false; r.available = true; S.activeQueries[target] = null;
    if (target !== C2.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN) r.result = r.result > 0 ? 1 : 0;
  };
  M2.getQuery = function getQuery(target, pname) {
    argsReq(IF2, 'getQuery', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; target = glenum(target); pname = glenum(pname);
    if (!QTARGET(target)) { gerr(S, C.INVALID_ENUM); return null; }
    if (pname !== C2.CURRENT_QUERY) { gerr(S, C.INVALID_ENUM); return null; }
    const r = S.activeQueries && S.activeQueries[target];
    return r ? r.wrapper : null;
  };
  M2.getQueryParameter = function getQueryParameter(q, pname) {
    argsReq(IF2, 'getQueryParameter', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; pname = glenum(pname);
    if (!(q instanceof WebGLQuery)) throw G.typeErr(IF2, 'getQueryParameter', 1, 'WebGLQuery');
    if (!isObjOf(S, q, WebGLQuery) || rec(q).deleted) { gerr(S, C.INVALID_OPERATION); return null; }
    const r = rec(q);
    if (r.active || r.target === 0) { gerr(S, C.INVALID_OPERATION); return null; }
    if (pname === C2.QUERY_RESULT_AVAILABLE) return r.available;
    if (pname === C2.QUERY_RESULT) return r.target === C2.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN ? r.result : r.result > 0;
    gerr(S, C.INVALID_ENUM); return null;
  };
  M2.fenceSync = function fenceSync(cond, flags) {
    argsReq(IF2, 'fenceSync', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (glenum(cond) !== C2.SYNC_GPU_COMMANDS_COMPLETE) { gerr(S, C.INVALID_ENUM); return null; }
    if (glenum(flags) !== 0) { gerr(S, C.INVALID_VALUE); return null; }
    return wrapObj(WebGLSync, S, { kind: 'sync', deleted: false, signaled: true });
  };
  M2.isSync = function isSync(s) { const S = stOf(this); return !S.lost && isObjOf(S, s, WebGLSync) && !rec(s).deleted; };
  M2.deleteSync = function deleteSync(s) {
    const S = stOf(this); if (S.lost || s === null || s === undefined) return;
    if (!(s instanceof WebGLSync)) throw G.typeErr(IF2, 'deleteSync', 1, 'WebGLSync');
    if (!isObjOf(S, s, WebGLSync)) return gerr(S, C.INVALID_OPERATION);
    rec(s).deleted = true;
  };
  M2.clientWaitSync = function clientWaitSync(s, flags, timeout) {
    argsReq(IF2, 'clientWaitSync', 3, arguments.length);
    const S = stOf(this); if (S.lost) return C2.WAIT_FAILED;
    if (!isObjOf(S, s, WebGLSync) || rec(s).deleted) { gerr(S, C.INVALID_OPERATION); return C2.WAIT_FAILED; }
    if ((Number(flags) >>> 0) & ~C2.SYNC_FLUSH_COMMANDS_BIT) { gerr(S, C.INVALID_VALUE); return C2.WAIT_FAILED; }
    return C2.ALREADY_SIGNALED;
  };
  M2.waitSync = function waitSync(s, flags, timeout) {
    argsReq(IF2, 'waitSync', 3, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!isObjOf(S, s, WebGLSync) || rec(s).deleted) return gerr(S, C.INVALID_OPERATION);
    if (glint(flags) !== 0 || Number(timeout) !== -1) return gerr(S, C.INVALID_VALUE);
  };
  M2.getSyncParameter = function getSyncParameter(s, pname) {
    argsReq(IF2, 'getSyncParameter', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!isObjOf(S, s, WebGLSync) || rec(s).deleted) { gerr(S, C.INVALID_OPERATION); return null; }
    switch (glenum(pname)) {
      case C2.OBJECT_TYPE: return C2.SYNC_FENCE; case C2.SYNC_STATUS: return C2.SIGNALED; case C2.SYNC_CONDITION: return C2.SYNC_GPU_COMMANDS_COMPLETE; case C2.SYNC_FLAGS: return 0;
      default: gerr(S, C.INVALID_ENUM); return null;
    }
  };
  void WebGLTransformFeedback;
})(globalThis.__layer);
