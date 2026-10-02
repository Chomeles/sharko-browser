// 3d_offscreen.js — OffscreenCanvas (2d, webgl, webgl2, bitmaprenderer), OffscreenCanvasRenderingContext2D,
// ImageBitmap, ImageBitmapRenderingContext, createImageBitmap and HTMLCanvasElement.transferControlToOffscreen.
//
// An OffscreenCanvas is backed by a detached <canvas> element: the 2D context is the page's
// CanvasRenderingContext2D on that element (subclassed so that `canvas` and the interface name are right),
// the WebGL contexts present into the element's surface (3c_webgl_ctx.js), so every consumer that can read a
// canvas (drawImage, texImage2D, toDataURL of the element behind it) reads an OffscreenCanvas the same way.
(function (L) {
  'use strict';
  const N = L.N;
  const INTERNAL = L.INTERNAL;
  const DOMException = L.DOMException;
  const G = L.glInternals;
  const doc = () => L.document;

  const BITMAP = new WeakMap(); // ImageBitmap -> {w, h, data (straight RGBA Uint8ClampedArray) | null when closed}
  class ImageBitmap {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get width() { const r = BITMAP.get(this); if (!r) throw new TypeError('Illegal invocation'); return r.data === null ? 0 : r.w; }
    get height() { const r = BITMAP.get(this); if (!r) throw new TypeError('Illegal invocation'); return r.data === null ? 0 : r.h; }
    close() { const r = BITMAP.get(this); if (!r) throw new TypeError('Illegal invocation'); r.data = null; }
  }
  function makeBitmap(w, h, data) { const b = Object.create(ImageBitmap.prototype); BITMAP.set(b, { w, h, data }); return b; }
  L.expose('ImageBitmap', ImageBitmap);

  // ---- OffscreenCanvas ------------------------------------------------------------------------
  const OC = new WeakMap(); // OffscreenCanvas -> {el, ctx, kind, detached}
  const stateOf = (o) => { const s = OC.get(o); if (!s) throw new TypeError('Illegal invocation'); return s; };
  const dim = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, 0), 4294967295) : 0; };

  // 2D context of an OffscreenCanvas: the page's 2D context on the backing element
  const OFFCTX2D = new WeakMap();
  class OffscreenCanvasRenderingContext2D extends L.CanvasRenderingContext2D {
    constructor(token, el, attrs, owner) { super(token, el, attrs); OFFCTX2D.set(this, owner); }
    get canvas() { return OFFCTX2D.get(this); }
    commit() { /* frames are committed when the task ends */ }
  }
  // Chrome's OffscreenCanvasRenderingContext2D has no focus-ring/scroll helpers; keep the prototype free of them
  for (const k of ['drawFocusIfNeeded', 'scrollPathIntoView']) { try { Object.defineProperty(OffscreenCanvasRenderingContext2D.prototype, k, { value: undefined, configurable: true, writable: true }); delete OffscreenCanvasRenderingContext2D.prototype[k]; } catch (_) { /* ignore */ } }

  class ImageBitmapRenderingContext {
    #owner; #el;
    constructor(token, owner, el) { if (token !== INTERNAL) throw L.illegal(); this.#owner = owner; this.#el = el; }
    get canvas() { return this.#owner; }
    transferFromImageBitmap(bitmap) {
      const el = this.#el;
      const id = L.idOf(el);
      if (bitmap === null || bitmap === undefined) { N.canvasReset(id, el.width, el.height); return; }
      const r = BITMAP.get(bitmap);
      if (!r) throw new TypeError("Failed to execute 'transferFromImageBitmap' on 'ImageBitmapRenderingContext': parameter 1 is not of type 'ImageBitmap'.");
      if (r.data === null) throw new DOMException("Failed to execute 'transferFromImageBitmap' on 'ImageBitmapRenderingContext': The image source is detached.", 'InvalidStateError');
      el.width = r.w; el.height = r.h;
      N.canvasPutImageData(id, r.data, r.w, r.h, 0, 0, 0, 0, r.w, r.h);
      r.data = null; // the bitmap is transferred
    }
  }
  L.expose('ImageBitmapRenderingContext', ImageBitmapRenderingContext);
  L.expose('OffscreenCanvasRenderingContext2D', OffscreenCanvasRenderingContext2D);

  function readElementPixels(s, flush) {
    const el = s.el;
    const w = el.width, h = el.height;
    if (w === 0 || h === 0) return { w, h, data: new Uint8ClampedArray(0) };
    if (s.ctx && s.kind === '2d') L.ctxSync(s.ctx);
    if (flush && L.glFlush) L.glFlush(s.owner);
    return { w, h, data: new Uint8ClampedArray(N.canvasGetImageData(L.idOf(el), 0, 0, w, h)) };
  }

  class OffscreenCanvas extends L.EventTarget {
    constructor(width, height) {
      if (arguments.length < 2) throw new TypeError(`Failed to construct 'OffscreenCanvas': 2 arguments required, but only ${arguments.length} present.`);
      super();
      const el = doc().createElement('canvas');
      const w = dim(width), h = dim(height);
      el.width = w; el.height = h;
      OC.set(this, { el, ctx: null, kind: null, owner: this, placeholder: null });
    }
    get width() { return stateOf(this).el.width; }
    set width(v) { const s = stateOf(this); s.el.width = dim(v); if (s.ctx && s.kind === '2d') L.ctxResize(s.ctx); else if (s.kind) L.glResize(this, s.el); }
    get height() { return stateOf(this).el.height; }
    set height(v) { const s = stateOf(this); s.el.height = dim(v); if (s.ctx && s.kind === '2d') L.ctxResize(s.ctx); else if (s.kind) L.glResize(this, s.el); }
    getContext(contextId, options) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'getContext' on 'OffscreenCanvas': 1 argument required, but only 0 present.");
      const s = stateOf(this);
      const id = `${contextId}`;
      if (s.placeholder === 'detached') throw new DOMException("Failed to execute 'getContext' on 'OffscreenCanvas': Cannot get context from a canvas that has transferred its control to offscreen.", 'InvalidStateError');
      const kind = id === '2d' ? '2d' : L.glContextKinds[id] !== undefined ? 'gl' : id === 'bitmaprenderer' ? 'bitmap' : null;
      if (kind === null) return null;
      if (s.kind !== null && s.kindName !== (kind === 'gl' ? (L.glContextKinds[id] === 2 ? 'webgl2' : 'webgl') : kind)) return null;
      if (s.ctx) return s.ctx;
      if (kind === '2d') s.ctx = new OffscreenCanvasRenderingContext2D(INTERNAL, s.el, options, this);
      else if (kind === 'bitmap') s.ctx = new ImageBitmapRenderingContext(INTERNAL, this, s.el);
      else { s.ctx = L.glGetContext(s.el, this, id, options); if (s.ctx === null) return null; }
      s.kind = kind === 'gl' ? 'gl' : kind;
      s.kindName = kind === 'gl' ? (L.glContextKinds[id] === 2 ? 'webgl2' : 'webgl') : kind;
      return s.ctx;
    }
    transferToImageBitmap() {
      const s = stateOf(this);
      if (s.ctx === null || s.kind === null) throw new DOMException("Failed to execute 'transferToImageBitmap' on 'OffscreenCanvas': ImageBitmap construction failed", 'InvalidStateError');
      if (s.kind === 'bitmap') throw new DOMException("Failed to execute 'transferToImageBitmap' on 'OffscreenCanvas': ImageBitmap construction failed", 'InvalidStateError');
      const px = readElementPixels(s, true);
      const bmp = makeBitmap(px.w, px.h, px.data);
      // the canvas is cleared afterwards (a transferred drawing buffer is fresh)
      if (s.kind === '2d') { s.ctx.clearRect(0, 0, px.w, px.h); } else { const st = G.stOf(s.ctx); G.clearDefaultBuffer(st); N.canvasReset(L.idOf(s.el), px.w, px.h); st.dirty = false; }
      return bmp;
    }
    convertToBlob(options) {
      const s = stateOf(this);
      if (s.placeholder === 'detached') return L.rejectedPromise(new DOMException("Failed to execute 'convertToBlob' on 'OffscreenCanvas': OffscreenCanvas has been transferred.", 'InvalidStateError'));
      if (s.el.width === 0 || s.el.height === 0) return L.rejectedPromise(new DOMException("Failed to execute 'convertToBlob' on 'OffscreenCanvas': Cannot convert a canvas with a width or height of 0 to a blob.", 'IndexSizeError'));
      const type = options && options.type !== undefined ? `${options.type}` : 'image/png';
      void type;
      return new L.Promise((resolve) => {
        L.postTask(() => {
          if (s.ctx && s.kind === '2d') L.ctxSync(s.ctx);
          if (L.glFlush) L.glFlush(this);
          const url = s.el.toDataURL('image/png');
          const bin = atob(url.slice(url.indexOf(',') + 1));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          resolve(new L.Blob([bytes], { type: 'image/png' }));
        });
      });
    }
  }
  L.defineEventHandlers(OffscreenCanvas.prototype, ['oncontextlost', 'oncontextrestored']);
  L.expose('OffscreenCanvas', OffscreenCanvas);

  // consumers that read canvases: 2D drawImage (`imageBitmapPixels` hook), WebGL uploads (`texSourceTests`/`sourcePixels`)
  L.imageBitmapPixels = function imageBitmapPixels(o) {
    if (o instanceof ImageBitmap) {
      const r = BITMAP.get(o);
      if (r.data === null) throw new DOMException("The image source is detached.", 'InvalidStateError');
      return [1, r.data, r.w, r.h];
    }
    if (o instanceof OffscreenCanvas) {
      const px = readElementPixels(stateOf(o), true);
      if (px.w === 0 || px.h === 0) throw new DOMException('The image argument is a canvas element with a width or height of 0.', 'InvalidStateError');
      return [1, px.data, px.w, px.h];
    }
    return null;
  };
  L.texSourceTests.push((v) => v instanceof ImageBitmap || v instanceof OffscreenCanvas);

  // transferControlToOffscreen: the placeholder element keeps displaying what the OffscreenCanvas draws
  L.transferred = new WeakSet();
  Object.defineProperty(L.HTMLCanvasElement.prototype, 'transferControlToOffscreen', { value: function transferControlToOffscreen() {
    const canvas = this;
    if (L.transferred.has(canvas)) throw new DOMException("Failed to execute 'transferControlToOffscreen' on 'HTMLCanvasElement': Cannot transfer control from a canvas for more than one time.", 'InvalidStateError');
    if (L.glOf(canvas)) throw new DOMException("Failed to execute 'transferControlToOffscreen' on 'HTMLCanvasElement': Cannot transfer control from a canvas that has a rendering context.", 'InvalidStateError');
    const off = new OffscreenCanvas(0, 0);
    OC.set(off, { el: canvas, ctx: null, kind: null, owner: off, placeholder: null });
    L.transferred.add(canvas);
    return off;
  }, writable: true, enumerable: true, configurable: true });

  // ---- createImageBitmap ------------------------------------------------------------------------
  function resizeBits(px, rw, rh, flipY) {
    let { w, h, data } = px;
    if (rw !== undefined || rh !== undefined) {
      const nw = rw === undefined ? Math.max(1, Math.round(w * rh / h)) : rw, nh = rh === undefined ? Math.max(1, Math.round(h * rw / w)) : rh;
      const out = new Uint8ClampedArray(nw * nh * 4);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) { const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / nw)), sy = Math.min(h - 1, Math.floor((y + 0.5) * h / nh)); for (let k = 0; k < 4; k++) out[(y * nw + x) * 4 + k] = data[(sy * w + sx) * 4 + k]; }
      w = nw; h = nh; data = out;
    }
    if (flipY) {
      const out = new Uint8ClampedArray(data.length);
      for (let y = 0; y < h; y++) out.set(data.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
      data = out;
    }
    return { w, h, data };
  }
  function crop(px, sx, sy, sw, sh) {
    const out = new Uint8ClampedArray(Math.abs(sw) * Math.abs(sh) * 4);
    const w = Math.abs(sw), h = Math.abs(sh);
    const x0 = sw < 0 ? sx + sw : sx, y0 = sh < 0 ? sy + sh : sy;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const px_ = x0 + x, py_ = y0 + y; if (px_ < 0 || py_ < 0 || px_ >= px.w || py_ >= px.h) continue; for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = px.data[(py_ * px.w + px_) * 4 + k]; }
    return { w, h, data: out };
  }
  L.createImageBitmap = function createImageBitmap(image, a, b, c, d, e) {
    const n = arguments.length;
    if (n < 1) return L.rejectedPromise(new TypeError("Failed to execute 'createImageBitmap' on 'Window': 1 argument required, but only 0 present."));
    let sx, sy, sw, sh, options;
    if (n >= 5 && typeof a === 'number') { sx = a; sy = b; sw = c; sh = d; options = e; } else options = a;
    const reject = (err) => L.rejectedPromise(err);
    const finish = (px) => {
      if (sx !== undefined) {
        if (!sw || !sh) return reject(new RangeError("Failed to execute 'createImageBitmap' on 'Window': The crop rect width or height is 0."));
        px = crop(px, Math.trunc(sx), Math.trunc(sy), Math.trunc(sw), Math.trunc(sh));
      }
      const o = options !== null && typeof options === 'object' ? options : {};
      const rw = o.resizeWidth !== undefined ? Math.trunc(Number(o.resizeWidth)) : undefined, rh = o.resizeHeight !== undefined ? Math.trunc(Number(o.resizeHeight)) : undefined;
      if ((rw !== undefined && rw <= 0) || (rh !== undefined && rh <= 0)) return reject(new RangeError("Failed to execute 'createImageBitmap' on 'Window': The resize width or height is 0."));
      const r = resizeBits(px, rw, rh, o.imageOrientation === 'flipY');
      return L.resolvedPromise(makeBitmap(r.w, r.h, r.data));
    };
    if (image instanceof ImageBitmap && BITMAP.get(image).data === null) return reject(new DOMException("Failed to execute 'createImageBitmap' on 'Window': The image source is detached.", 'InvalidStateError'));
    if (L.isTexImageSource(image)) {
      let px;
      try { px = L.sourcePixels(image); } catch (err) { return reject(err); }
      if (px === null) return reject(new DOMException("Failed to execute 'createImageBitmap' on 'Window': The image source is not decoded or has no size.", 'InvalidStateError'));
      if (px.w === 0 || px.h === 0) return reject(new DOMException("Failed to execute 'createImageBitmap' on 'Window': The source image width or height is 0.", 'InvalidStateError'));
      return finish({ w: px.w, h: px.h, data: new Uint8ClampedArray(px.data) });
    }
    if (image instanceof L.Blob) {
      // decode through an <img> on a blob URL
      return new L.Promise((resolve, reject2) => {
        const img = doc().createElement('img');
        const url = L.URL.createObjectURL(image);
        img.onload = () => { L.URL.revokeObjectURL(url); const px = L.sourcePixels(img); if (px === null) reject2(new DOMException('The source image could not be decoded.', 'InvalidStateError')); else resolve(finish({ w: px.w, h: px.h, data: new Uint8ClampedArray(px.data) })); };
        img.onerror = () => { L.URL.revokeObjectURL(url); reject2(new DOMException('The source image could not be decoded.', 'InvalidStateError')); };
        img.src = url;
      });
    }
    return reject(new TypeError("Failed to execute 'createImageBitmap' on 'Window': The provided value is not of type '(Blob or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or ImageData or OffscreenCanvas or SVGImageElement or VideoFrame)'."));
  };
})(globalThis.__layer);
