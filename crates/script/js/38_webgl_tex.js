// 38_webgl_tex.js — WebGL API, part 2: textures (objects, parameters, uploads, mipmaps, storage), samplers and
// the pixel conversion shared with readPixels. Texels are kept expanded to four channels (see 36_webgl.js).
(function (L) {
  'use strict';
  const G = L.glInternals;
  const { C, C2, E, LIM, FMT, UNSIZED, Image, OBJ, wrapObj, rec, isObjOf, gerr, glenum, glint, argsReq, stOf, classes, PIXEL_TYPE_BYTES, PACKED_TYPES, BASE_COMPONENTS, POT } = G;
  const { WebGLTexture, WebGLSampler } = classes;
  const { M, M2 } = G;
  const IF1 = 'WebGLRenderingContext';
  const IF2 = 'WebGL2RenderingContext';

  // ---------------------------------------------------------------------------------------
  // Valid (format, type) pairs per internal format
  // ---------------------------------------------------------------------------------------
  const U8 = C.UNSIGNED_BYTE;
  const SIZED_TYPES = {
    [C2.R8]: [C2.RED, [U8]], [C2.R8_SNORM]: [C2.RED, [C.BYTE]], [C2.RG8]: [C2.RG, [U8]], [C2.RG8_SNORM]: [C2.RG, [C.BYTE]], [C2.RGB8]: [C.RGB, [U8]], [C2.RGB8_SNORM]: [C.RGB, [C.BYTE]],
    [C.RGB565]: [C.RGB, [U8, C.UNSIGNED_SHORT_5_6_5]], [C.RGBA4]: [C.RGBA, [U8, C.UNSIGNED_SHORT_4_4_4_4]], [C.RGB5_A1]: [C.RGBA, [U8, C.UNSIGNED_SHORT_5_5_5_1, C2.UNSIGNED_INT_2_10_10_10_REV]],
    [C2.RGBA8]: [C.RGBA, [U8]], [C2.RGBA8_SNORM]: [C.RGBA, [C.BYTE]], [C2.RGB10_A2]: [C.RGBA, [C2.UNSIGNED_INT_2_10_10_10_REV]], [C2.RGB10_A2UI]: [C2.RGBA_INTEGER, [C2.UNSIGNED_INT_2_10_10_10_REV]],
    [C2.SRGB8]: [C.RGB, [U8]], [C2.SRGB8_ALPHA8]: [C.RGBA, [U8]],
    [C2.R16F]: [C2.RED, [C2.HALF_FLOAT, C.FLOAT]], [C2.RG16F]: [C2.RG, [C2.HALF_FLOAT, C.FLOAT]], [C2.RGB16F]: [C.RGB, [C2.HALF_FLOAT, C.FLOAT]], [C2.RGBA16F]: [C.RGBA, [C2.HALF_FLOAT, C.FLOAT]],
    [C2.R32F]: [C2.RED, [C.FLOAT]], [C2.RG32F]: [C2.RG, [C.FLOAT]], [C2.RGB32F]: [C.RGB, [C.FLOAT]], [C2.RGBA32F]: [C.RGBA, [C.FLOAT]],
    [C2.R11F_G11F_B10F]: [C.RGB, [C2.UNSIGNED_INT_10F_11F_11F_REV, C2.HALF_FLOAT, C.FLOAT]], [C2.RGB9_E5]: [C.RGB, [C2.UNSIGNED_INT_5_9_9_9_REV, C2.HALF_FLOAT, C.FLOAT]],
    [C.DEPTH_COMPONENT16]: [C.DEPTH_COMPONENT, [C.UNSIGNED_SHORT, C.UNSIGNED_INT]], [C2.DEPTH_COMPONENT24]: [C.DEPTH_COMPONENT, [C.UNSIGNED_INT]], [C2.DEPTH_COMPONENT32F]: [C.DEPTH_COMPONENT, [C.FLOAT]],
    [C2.DEPTH24_STENCIL8]: [C.DEPTH_STENCIL, [C2.UNSIGNED_INT_24_8]], [C2.DEPTH32F_STENCIL8]: [C.DEPTH_STENCIL, [C2.FLOAT_32_UNSIGNED_INT_24_8_REV]],
  };
  for (const [n, b] of [['R', C2.RED_INTEGER], ['RG', C2.RG_INTEGER], ['RGB', C2.RGB_INTEGER], ['RGBA', C2.RGBA_INTEGER]]) {
    SIZED_TYPES[C2[`${n}8I`]] = [b, [C.BYTE]]; SIZED_TYPES[C2[`${n}8UI`]] = [b, [U8]];
    SIZED_TYPES[C2[`${n}16I`]] = [b, [C.SHORT]]; SIZED_TYPES[C2[`${n}16UI`]] = [b, [C.UNSIGNED_SHORT]];
    SIZED_TYPES[C2[`${n}32I`]] = [b, [C.INT]]; SIZED_TYPES[C2[`${n}32UI`]] = [b, [C.UNSIGNED_INT]];
  }
  const UNSIZED_TYPES = {
    [C.RGBA]: [C.RGBA, [U8, C.UNSIGNED_SHORT_4_4_4_4, C.UNSIGNED_SHORT_5_5_5_1]], [C.RGB]: [C.RGB, [U8, C.UNSIGNED_SHORT_5_6_5]],
    [C.LUMINANCE_ALPHA]: [C.LUMINANCE_ALPHA, [U8]], [C.LUMINANCE]: [C.LUMINANCE, [U8]], [C.ALPHA]: [C.ALPHA, [U8]],
  };

  // Resolve (internalformat, format, type) to a format descriptor, or null (INVALID_ENUM) / 0 (INVALID_OPERATION).
  function resolveFormat(S, internal, format, type, forSub) {
    if (S.ver === 2) {
      if (PIXEL_TYPE_BYTES[type] === undefined) return null;
      if (BASE_COMPONENTS[format] === undefined) return null;
      if (forSub) {
        // sub-image: the texture's own format decides; here only format/type must be a valid pair
        return { internal, f: FMT.get(internal) };
      }
      const sized = SIZED_TYPES[internal];
      if (sized !== undefined) {
        if (sized[0] !== format || !sized[1].includes(type)) return 0;
        return { internal, f: FMT.get(internal) };
      }
      const un = UNSIZED_TYPES[internal];
      if (un !== undefined) {
        if (un[0] !== format || !un[1].includes(type)) return 0;
        const f = UNSIZED.get(format * 65536 + type);
        return f ? { internal, f } : 0;
      }
      return null;
    }
    // WebGL 1
    if (![C.ALPHA, C.LUMINANCE, C.LUMINANCE_ALPHA, C.RGB, C.RGBA, C.DEPTH_COMPONENT, C.DEPTH_STENCIL].includes(format)) return null;
    if (!forSub && internal !== format) return 0;
    const t = type === E.HALF_FLOAT_OES ? type : type;
    const f = UNSIZED.get(format * 65536 + t);
    if (!f) return PIXEL_TYPE_BYTES[type] === undefined ? null : 0;
    if (f.float32 && !S.exts.has('OES_texture_float')) return null;
    if (f.half && !S.exts.has('OES_texture_half_float')) return null;
    if (f.depth && !S.exts.has('WEBGL_depth_texture')) return null;
    if (f.depth && (type === C.UNSIGNED_INT && format !== C.DEPTH_COMPONENT)) return 0;
    return { internal: format, f };
  }
  G.resolveFormat = resolveFormat;

  // ---------------------------------------------------------------------------------------
  // Pixel unpack: source bytes -> expanded texels
  // ---------------------------------------------------------------------------------------
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const decode10f = (v) => { // 10-bit unsigned float (5e5m)
    const e = (v >> 5) & 31, m = v & 31;
    if (e === 0) return m * Math.pow(2, -14) / 32; if (e === 31) return m ? NaN : Infinity;
    return Math.pow(2, e - 15) * (1 + m / 32);
  };
  const decode11f = (v) => {
    const e = (v >> 6) & 31, m = v & 63;
    if (e === 0) return m * Math.pow(2, -14) / 64; if (e === 31) return m ? NaN : Infinity;
    return Math.pow(2, e - 15) * (1 + m / 64);
  };
  // components of one source texel as "domain" values: normalized floats in [0,1] ('n'), signed normalized ('s'), raw integers ('i') or floats ('f')
  // returns [kind, values...] via callback to avoid allocation: fills `out` (length >= 4) and returns the kind.
  function readTexel(dv, off, type, ncomp, out) {
    switch (type) {
      case C.UNSIGNED_BYTE: for (let k = 0; k < ncomp; k++) out[k] = dv.getUint8(off + k); return 'u8';
      case C.BYTE: for (let k = 0; k < ncomp; k++) out[k] = dv.getInt8(off + k); return 's8';
      case C.UNSIGNED_SHORT: for (let k = 0; k < ncomp; k++) out[k] = dv.getUint16(off + k * 2, true); return 'u16';
      case C.SHORT: for (let k = 0; k < ncomp; k++) out[k] = dv.getInt16(off + k * 2, true); return 's16';
      case C.UNSIGNED_INT: for (let k = 0; k < ncomp; k++) out[k] = dv.getUint32(off + k * 4, true); return 'u32';
      case C.INT: for (let k = 0; k < ncomp; k++) out[k] = dv.getInt32(off + k * 4, true); return 's32';
      case C.FLOAT: for (let k = 0; k < ncomp; k++) out[k] = dv.getFloat32(off + k * 4, true); return 'f';
      case C2.HALF_FLOAT: case E.HALF_FLOAT_OES: for (let k = 0; k < ncomp; k++) out[k] = L.fromHalf(dv.getUint16(off + k * 2, true)); return 'f';
      case C.UNSIGNED_SHORT_5_6_5: { const v = dv.getUint16(off, true); out[0] = (v >> 11) / 31; out[1] = ((v >> 5) & 63) / 63; out[2] = (v & 31) / 31; return 'n'; }
      case C.UNSIGNED_SHORT_4_4_4_4: { const v = dv.getUint16(off, true); out[0] = (v >> 12) / 15; out[1] = ((v >> 8) & 15) / 15; out[2] = ((v >> 4) & 15) / 15; out[3] = (v & 15) / 15; return 'n'; }
      case C.UNSIGNED_SHORT_5_5_5_1: { const v = dv.getUint16(off, true); out[0] = (v >> 11) / 31; out[1] = ((v >> 6) & 31) / 31; out[2] = ((v >> 1) & 31) / 31; out[3] = v & 1; return 'n'; }
      case C2.UNSIGNED_INT_2_10_10_10_REV: { const v = dv.getUint32(off, true); out[0] = v & 1023; out[1] = (v >>> 10) & 1023; out[2] = (v >>> 20) & 1023; out[3] = v >>> 30; return 'p1010102'; }
      case C2.UNSIGNED_INT_10F_11F_11F_REV: { const v = dv.getUint32(off, true); out[0] = decode11f(v & 2047); out[1] = decode11f((v >>> 11) & 2047); out[2] = decode10f(v >>> 22); return 'f'; }
      case C2.UNSIGNED_INT_5_9_9_9_REV: { const v = dv.getUint32(off, true); const e = v >>> 27; const sc = Math.pow(2, e - 15 - 9); out[0] = (v & 511) * sc; out[1] = ((v >>> 9) & 511) * sc; out[2] = ((v >>> 18) & 511) * sc; return 'f'; }
      case C2.UNSIGNED_INT_24_8: { const v = dv.getUint32(off, true); out[0] = v >>> 8; out[1] = v & 255; return 'd24s8'; }
      case C2.FLOAT_32_UNSIGNED_INT_24_8_REV: out[0] = dv.getFloat32(off, true); out[1] = dv.getUint32(off + 4, true) & 255; return 'd32s8';
      default: return 'u8';
    }
  }
  const kindNorm = { u8: 255, u16: 65535, u32: 4294967295 };
  // store a decoded component (kind, raw value) as the destination store domain
  function toStore(f, kind, v, k) {
    switch (f.store) {
      case 'u8': {
        let c;
        if (kind === 'n') c = v; else if (kind === 'p1010102') c = v / (k === 3 ? 3 : 1023);
        else if (kind === 'f') c = clamp01(v); else if (kind === 's8') c = Math.max(v, 0) / 127; else c = v / kindNorm[kind];
        if (f.quant) { const q = f.quant[k]; return Math.round(Math.round(c * q) / q * 255); }
        return Math.round(clamp01(c) * 255);
      }
      case 's8': return kind === 's8' ? v : Math.round(Math.max(-1, Math.min(1, v)) * 127);
      case 'f32': {
        let c;
        if (kind === 'n') c = v; else if (kind === 'p1010102') c = v / (k === 3 ? 3 : 1023); else if (kind === 'f') c = v; else if (kind === 'd24s8') c = k === 0 ? v / 16777215 : v;
        else if (kind === 'd32s8') c = v; else if (kind === 's8') c = Math.max(v / 127, -1); else c = v / kindNorm[kind];
        if (f.half) c = L.fromHalf(L.toHalf(c));
        return c;
      }
      case 'i32': return v | 0;
      default: return v >>> 0;
    }
  }
  // Expand components (by source format) into RGBA of the destination format.
  function srcComponents(format) {
    switch (format) {
      case C.RGBA: case C2.RGBA_INTEGER: return ['r', 'g', 'b', 'a'];
      case C.RGB: case C2.RGB_INTEGER: return ['r', 'g', 'b'];
      case C2.RG: case C2.RG_INTEGER: return ['r', 'g'];
      case C2.RED: case C2.RED_INTEGER: return ['r'];
      case C.LUMINANCE_ALPHA: return ['l', 'a'];
      case C.LUMINANCE: return ['l'];
      case C.ALPHA: return ['a'];
      case C.DEPTH_COMPONENT: return ['d'];
      case C.DEPTH_STENCIL: return ['d', 's'];
      default: return ['r', 'g', 'b', 'a'];
    }
  }
  function layoutOfType(format, type) {
    const comps = srcComponents(format);
    const packed = PACKED_TYPES.has(type);
    const bytes = packed ? PIXEL_TYPE_BYTES[type] : PIXEL_TYPE_BYTES[type] * comps.length;
    return { comps, bytes, packed };
  }
  G.layoutOfType = layoutOfType;
  const roundUp = (n, a) => Math.ceil(n / a) * a;
  // Size in bytes that an unpack of w*h*d texels needs (GL ES 3.0 §3.7.1).
  function unpackGeometry(S, w, h, d, format, type) {
    const lay = layoutOfType(format, type);
    const P = S.unpack;
    const rowLen = P.rowLength > 0 ? P.rowLength : w;
    const rowBytes = lay.packed || true ? roundUp(rowLen * lay.bytes, P.align) : 0;
    const imgH = P.imageHeight > 0 ? P.imageHeight : h;
    const start = P.skipPixels * lay.bytes + P.skipRows * rowBytes + P.skipImages * rowBytes * imgH;
    const need = start + (d > 0 && h > 0 && w > 0 ? ((d - 1) * imgH + (h - 1)) * rowBytes + w * lay.bytes : 0);
    return { lay, rowBytes, imgH, start, need };
  }
  G.unpackGeometry = unpackGeometry;
  // Convert source texels (ArrayBuffer bytes) into an expanded array in dest store. Returns {data, w, h, d} (data in f.store type, 4 channels).
  function unpackToImage(S, bytes, w, h, d, format, type, f, srcOffset) {
    const geo = unpackGeometry(S, w, h, d, format, type);
    const img = new Image(w, h, d, f);
    const out = img.data;
    if (w === 0 || h === 0 || d === 0) return img;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tmp = [0, 0, 0, 0];
    const comps = geo.lay.comps;
    const colorDest = f.color;
    const fast = f.store === 'u8' && type === C.UNSIGNED_BYTE && !f.quant && format === f.base && !f.lum && comps.length === 4;
    for (let z = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        let off = srcOffset + geo.start + (z * geo.imgH + y) * geo.rowBytes;
        let o = ((z * h + y) * w) * 4;
        if (fast) { out.set(bytes.subarray(off, off + w * 4), o); continue; }
        for (let x = 0; x < w; x++, off += geo.lay.bytes, o += 4) {
          const kind = readTexel(dv, off, type, comps.length, tmp);
          if (colorDest) {
            // default channels: missing color -> 0, missing alpha -> 1 (in the store domain)
            let r = 0, g = 0, b = 0, a;
            const one = f.store === 'u8' ? 255 : f.store === 's8' ? 127 : 1;
            a = one;
            for (let k = 0; k < comps.length; k++) {
              const v = toStore(f, kind, tmp[k], comps[k] === 'a' ? 3 : k);
              switch (comps[k]) {
                case 'r': r = v; break; case 'g': g = v; break; case 'b': b = v; break; case 'a': a = v; break;
                case 'l': r = g = b = v; break; default: break;
              }
            }
            if (f.base === C.ALPHA) { r = g = b = 0; }
            if (S.unpack.premul && a !== one && (f.store === 'u8' || f.store === 'f32')) { const s = f.store === 'u8' ? a / 255 : a; r = Math.round(r * s); g = Math.round(g * s); b = Math.round(b * s); if (f.store === 'f32') { r = r / (a === 0 ? 1 : 1); } }
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
          } else {
            out[o] = toStore(f, kind, tmp[0], 0);
            if (f.stencil) out[o + 1] = toStore(f, kind === 'd24s8' || kind === 'd32s8' ? kind : 'u32', tmp[1], 1);
          }
        }
      }
    }
    if (S.unpack.flipY) flipImageY(img);
    return img;
  }
  G.unpackToImage = unpackToImage;
  function flipImageY(img) {
    const rowN = img.w * 4;
    const tmp = new img.data.constructor(rowN);
    for (let z = 0; z < img.d; z++) {
      const base = z * img.h * rowN;
      for (let y = 0; y < (img.h >> 1); y++) {
        const a = base + y * rowN, b = base + (img.h - 1 - y) * rowN;
        tmp.set(img.data.subarray(a, a + rowN)); img.data.copyWithin(a, b, b + rowN); img.data.set(tmp, b);
      }
    }
  }
  // DOM image source pixels (straight RGBA bytes) -> image of the destination format
  function sourceToImage(S, px, f, type) {
    const { w, h, data } = px;
    const img = new Image(w, h, 1, f);
    const out = img.data;
    const premul = S.unpack.premul;
    const one = f.store === 'u8' ? 255 : f.store === 's8' ? 127 : 1;
    for (let i = 0, n = w * h; i < n; i++) {
      let r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const a = data[i * 4 + 3];
      if (premul) { r = Math.round(r * a / 255); g = Math.round(g * a / 255); b = Math.round(b * a / 255); }
      const comp = f.lum ? null : [r, g, b, a];
      let cv;
      if (f.base === C.LUMINANCE) cv = [r, r, r, 255]; else if (f.base === C.LUMINANCE_ALPHA) cv = [r, r, r, a]; else if (f.base === C.ALPHA) cv = [0, 0, 0, a];
      else if (f.channels === 1) cv = [r, 0, 0, 255]; else if (f.channels === 2) cv = [r, g, 0, 255]; else if (f.channels === 3) cv = [r, g, b, 255]; else cv = comp;
      for (let k = 0; k < 4; k++) {
        const c = cv[k] / 255;
        let v;
        if (f.store === 'u8') v = f.quant ? Math.round(Math.round(c * f.quant[k]) / f.quant[k] * 255) : cv[k];
        else if (f.store === 'f32') { v = c; if (f.half) v = L.fromHalf(L.toHalf(v)); } else if (f.store === 's8') v = Math.round(c * 127);
        else v = cv[k];
        out[i * 4 + k] = v;
      }
    }
    void type; void one;
    if (S.unpack.flipY) flipImageY(img);
    return img;
  }

  // ---------------------------------------------------------------------------------------
  // Texture objects
  // ---------------------------------------------------------------------------------------
  const newSamplerParams = () => ({ minFilter: C.NEAREST_MIPMAP_LINEAR, magFilter: C.LINEAR, wrapS: C.REPEAT, wrapT: C.REPEAT, wrapR: C.REPEAT, minLod: -1000, maxLod: 1000, compareMode: C.NONE, compareFunc: C.LEQUAL });
  const newTexRec = () => Object.assign({ target: 0, imgs: new Map(), deleted: false, kind: 'texture', immutable: false, immutableLevels: 0, baseLevel: 0, maxLevel: 1000, serial: 0 }, newSamplerParams());
  G.newSamplerParams = newSamplerParams;
  const TARGETS1 = [C.TEXTURE_2D, C.TEXTURE_CUBE_MAP];
  const targetSlot = (S, t) => {
    switch (t) { case C.TEXTURE_2D: return 't2d'; case C.TEXTURE_CUBE_MAP: return 'cube'; default: break; }
    if (S.ver === 2) { if (t === C2.TEXTURE_3D) return 't3d'; if (t === C2.TEXTURE_2D_ARRAY) return 't2da'; }
    return null;
  };
  void TARGETS1;
  const isCubeFace = (t) => t >= C.TEXTURE_CUBE_MAP_POSITIVE_X && t <= C.TEXTURE_CUBE_MAP_NEGATIVE_Z;
  M.createTexture = function createTexture() { const S = stOf(this); if (S.lost) return null; return wrapObj(WebGLTexture, S, newTexRec()); };
  M.deleteTexture = function deleteTexture(t) {
    argsReq(IF1, 'deleteTexture', 1, arguments.length);
    const S = stOf(this); if (S.lost || t === null || t === undefined) return;
    if (!(t instanceof WebGLTexture)) throw G.typeErr(IF1, 'deleteTexture', 1, 'WebGLTexture');
    if (!isObjOf(S, t, WebGLTexture)) return gerr(S, C.INVALID_OPERATION);
    const r = rec(t); if (r.deleted) return;
    r.deleted = true;
    for (const u of S.units) for (const k of ['t2d', 'cube', 't3d', 't2da']) if (u[k] === r) u[k] = null;
    G.detachTextureFromFbs && G.detachTextureFromFbs(S, r);
  };
  M.isTexture = function isTexture(t) { const S = stOf(this); return !S.lost && isObjOf(S, t, WebGLTexture) && !rec(t).deleted && rec(t).target !== 0; };
  M.activeTexture = function activeTexture(t) {
    argsReq(IF1, 'activeTexture', 1, arguments.length);
    const S = stOf(this); if (S.lost) return; t = glenum(t);
    if (t < C.TEXTURE0 || t >= C.TEXTURE0 + LIM.maxCombinedTextureImageUnits) return gerr(S, C.INVALID_ENUM);
    S.activeTex = t - C.TEXTURE0;
  };
  M.bindTexture = function bindTexture(target, t) {
    argsReq(IF1, 'bindTexture', 2, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    if (t !== null && t !== undefined && !(t instanceof WebGLTexture)) throw G.typeErr(IF1, 'bindTexture', 2, 'WebGLTexture');
    const slot = targetSlot(S, target);
    if (slot === null) return gerr(S, C.INVALID_ENUM);
    if (t === null || t === undefined) { S.units[S.activeTex][slot] = null; return; }
    if (!isObjOf(S, t, WebGLTexture) || rec(t).deleted) return gerr(S, C.INVALID_OPERATION);
    const r = rec(t);
    if (r.target !== 0 && r.target !== target) return gerr(S, C.INVALID_OPERATION);
    r.target = target;
    S.units[S.activeTex][slot] = r;
  };
  const boundTex = (S, target) => { const slot = targetSlot(S, target); return slot === null ? null : S.units[S.activeTex][slot]; };
  G.boundTex = boundTex;
  const FILTERS_MIN = [C.NEAREST, C.LINEAR, C.NEAREST_MIPMAP_NEAREST, C.LINEAR_MIPMAP_NEAREST, C.NEAREST_MIPMAP_LINEAR, C.LINEAR_MIPMAP_LINEAR];
  function setParam(S, params, pname, v, isFloat, isTex, tex) {
    const iv = isFloat ? (Number.isFinite(v) ? Math.trunc(v) : 0) : v | 0;
    const e = iv >>> 0;
    switch (pname) {
      case C.TEXTURE_MIN_FILTER: if (!FILTERS_MIN.includes(e)) return gerr(S, C.INVALID_ENUM); params.minFilter = e; return;
      case C.TEXTURE_MAG_FILTER: if (e !== C.NEAREST && e !== C.LINEAR) return gerr(S, C.INVALID_ENUM); params.magFilter = e; return;
      case C.TEXTURE_WRAP_S: case C.TEXTURE_WRAP_T: case C2.TEXTURE_WRAP_R: {
        if (pname === C2.TEXTURE_WRAP_R && S.ver !== 2) return gerr(S, C.INVALID_ENUM);
        if (e !== C.REPEAT && e !== C.CLAMP_TO_EDGE && e !== C.MIRRORED_REPEAT) return gerr(S, C.INVALID_ENUM);
        params[pname === C.TEXTURE_WRAP_S ? 'wrapS' : pname === C.TEXTURE_WRAP_T ? 'wrapT' : 'wrapR'] = e; return;
      }
      default: break;
    }
    if (S.ver === 2) {
      switch (pname) {
        case C2.TEXTURE_MIN_LOD: params.minLod = Number(v); return;
        case C2.TEXTURE_MAX_LOD: params.maxLod = Number(v); return;
        case C2.TEXTURE_COMPARE_MODE: if (e !== C.NONE && e !== C2.COMPARE_REF_TO_TEXTURE) return gerr(S, C.INVALID_ENUM); params.compareMode = e; return;
        case C2.TEXTURE_COMPARE_FUNC: if (!FUNCS.includes(e)) return gerr(S, C.INVALID_ENUM); params.compareFunc = e; return;
        case C2.TEXTURE_BASE_LEVEL: if (!isTex) break; if (iv < 0) return gerr(S, C.INVALID_VALUE); tex.baseLevel = iv; tex.serial++; return;
        case C2.TEXTURE_MAX_LEVEL: if (!isTex) break; if (iv < 0) return gerr(S, C.INVALID_VALUE); tex.maxLevel = iv; tex.serial++; return;
        default: break;
      }
    }
    gerr(S, C.INVALID_ENUM);
  }
  const FUNCS = [C.NEVER, C.LESS, C.EQUAL, C.LEQUAL, C.GREATER, C.NOTEQUAL, C.GEQUAL, C.ALWAYS];
  const texParam = (isFloat) => function (target, pname, param) {
    const nm = isFloat ? 'texParameterf' : 'texParameteri';
    argsReq(IF1, nm, 3, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target); pname = glenum(pname);
    const t = boundTex(S, target);
    if (targetSlot(S, target) === null) return gerr(S, C.INVALID_ENUM);
    if (t === null) return gerr(S, C.INVALID_OPERATION);
    setParam(S, t, pname, Number(param), isFloat, true, t);
  };
  M.texParameteri = texParam(false);
  M.texParameterf = texParam(true);
  M.getTexParameter = function getTexParameter(target, pname) {
    argsReq(IF1, 'getTexParameter', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; target = glenum(target); pname = glenum(pname);
    if (targetSlot(S, target) === null) { gerr(S, C.INVALID_ENUM); return null; }
    const t = boundTex(S, target);
    if (t === null) { gerr(S, C.INVALID_OPERATION); return null; }
    switch (pname) {
      case C.TEXTURE_MAG_FILTER: return t.magFilter; case C.TEXTURE_MIN_FILTER: return t.minFilter;
      case C.TEXTURE_WRAP_S: return t.wrapS; case C.TEXTURE_WRAP_T: return t.wrapT;
      default: break;
    }
    if (S.ver === 2) {
      switch (pname) {
        case C2.TEXTURE_WRAP_R: return t.wrapR; case C2.TEXTURE_MIN_LOD: return t.minLod; case C2.TEXTURE_MAX_LOD: return t.maxLod;
        case C2.TEXTURE_BASE_LEVEL: return t.baseLevel; case C2.TEXTURE_MAX_LEVEL: return t.maxLevel;
        case C2.TEXTURE_COMPARE_MODE: return t.compareMode; case C2.TEXTURE_COMPARE_FUNC: return t.compareFunc;
        case C2.TEXTURE_IMMUTABLE_FORMAT: return t.immutable; case C2.TEXTURE_IMMUTABLE_LEVELS: return t.immutableLevels;
        default: break;
      }
    }
    gerr(S, C.INVALID_ENUM); return null;
  };

  // image storage addressing
  const imgKey = (face, level) => face * 64 + level;
  const getImg = (t, face, level) => t.imgs.get(imgKey(face, level));
  G.getImg = getImg; G.imgKey = imgKey;
  const faceOf = (target) => (isCubeFace(target) ? target - C.TEXTURE_CUBE_MAP_POSITIVE_X : 0);
  function levelDims(S, target, level) {
    const max = target === C.TEXTURE_2D || isCubeFace(target) || target === C.TEXTURE_CUBE_MAP ? Math.max(1, Math.floor(Math.log2(isCubeFace(target) || target === C.TEXTURE_CUBE_MAP ? LIM.maxCubeMapSize : LIM.maxTextureSize)) + 1)
      : Math.floor(Math.log2(LIM.max3DTextureSize)) + 1;
    void S;
    return max;
  }
  function validTarget2D(S, target) { return target === C.TEXTURE_2D || isCubeFace(target); }
  function checkLevelSize(S, target, level, w, h, d) {
    if (level < 0 || level >= levelDims(S, target, level)) return false;
    const max = isCubeFace(target) ? LIM.maxCubeMapSize : target === C.TEXTURE_2D ? LIM.maxTextureSize : LIM.max3DTextureSize;
    const lw = Math.max(1, max >> level);
    if (w < 0 || h < 0 || d < 0 || w > lw || h > lw || (target === C2.TEXTURE_2D_ARRAY ? d > LIM.maxArrayTextureLayers : d > lw)) return false;
    return true;
  }
  // Is `bytes` (ArrayBufferView) big enough, return a Uint8Array view.
  function viewBytes(v) { return v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }
  function typedArrayOk(type, v) {
    switch (type) {
      case C.UNSIGNED_BYTE: return v instanceof Uint8Array || v instanceof Uint8ClampedArray;
      case C.BYTE: return v instanceof Int8Array;
      case C.UNSIGNED_SHORT: case C.UNSIGNED_SHORT_5_6_5: case C.UNSIGNED_SHORT_4_4_4_4: case C.UNSIGNED_SHORT_5_5_5_1: case C2.HALF_FLOAT: case E.HALF_FLOAT_OES: return v instanceof Uint16Array;
      case C.SHORT: return v instanceof Int16Array;
      case C.UNSIGNED_INT: case C2.UNSIGNED_INT_2_10_10_10_REV: case C2.UNSIGNED_INT_10F_11F_11F_REV: case C2.UNSIGNED_INT_5_9_9_9_REV: case C2.UNSIGNED_INT_24_8: return v instanceof Uint32Array;
      case C.INT: return v instanceof Int32Array;
      case C.FLOAT: case C2.FLOAT_32_UNSIGNED_INT_24_8_REV: return v instanceof Float32Array;
      default: return false;
    }
  }
  const isSource = (v) => v !== null && typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer);

  // Upload implementation shared by texImage2D/3D and texSubImage2D/3D.
  // spec: {sub, target, level, internal, w, h, d, xo, yo, zo, format, type, pixels, srcOffset, src}
  function upload(S, sp) {
    const { target } = sp;
    const t = boundTex(S, target === undefined ? 0 : (isCubeFace(target) ? C.TEXTURE_CUBE_MAP : target));
    if (t === null || t === undefined) return gerr(S, C.INVALID_OPERATION);
    const face = faceOf(target);
    const level = sp.level;
    let fRes;
    if (sp.sub) {
      const img0 = getImg(t, face, level);
      if (!img0) return gerr(S, C.INVALID_OPERATION);
      fRes = resolveFormat(S, img0.f.internal, sp.format, sp.type, true);
      if (fRes === null) return gerr(S, C.INVALID_ENUM);
      // the (format, type) pair must be valid for the texture's internal format
      const chk = resolveFormat(S, img0.f.unsized ? img0.f.base : img0.f.internal, sp.format, sp.type, false);
      if (chk === null) return gerr(S, C.INVALID_ENUM);
      if (chk === 0 && !(S.ver === 1 && sp.format === img0.f.base)) return gerr(S, C.INVALID_OPERATION);
      if (S.ver === 1 && (img0.f.type !== sp.type && !(img0.f.base === sp.format && img0.f.type === sp.type))) return gerr(S, C.INVALID_OPERATION);
      fRes = { internal: img0.f.internal, f: img0.f };
    } else {
      fRes = resolveFormat(S, sp.internal, sp.format, sp.type, false);
      if (fRes === null) return gerr(S, C.INVALID_ENUM);
      if (fRes === 0) return gerr(S, C.INVALID_OPERATION);
      if (t.immutable) return gerr(S, C.INVALID_OPERATION);
    }
    const f = fRes.f;
    if (!sp.sub && !checkLevelSize(S, target, level, sp.w, sp.h, sp.d)) return gerr(S, level < 0 || sp.w < 0 || sp.h < 0 ? C.INVALID_VALUE : C.INVALID_VALUE);
    if (!sp.sub && isCubeFace(target) && sp.w !== sp.h) return gerr(S, C.INVALID_VALUE);
    if (!sp.sub && (f.depth || f.stencil) && (S.ver === 1 && (target !== C.TEXTURE_2D || level !== 0 || sp.pixels))) return gerr(S, C.INVALID_OPERATION);
    let img;
    const w = sp.w, h = sp.h, d = sp.d;
    if (sp.src) {
      if (f.depth) return gerr(S, C.INVALID_OPERATION);
      if (!(sp.type === C.UNSIGNED_BYTE || (S.ver === 2 && f.store !== 'u8') || f.store === 'f32')) return gerr(S, C.INVALID_OPERATION);
      img = sourceToImage(S, sp.src, f, sp.type);
    } else if (sp.pixels === null || sp.pixels === undefined) {
      if (sp.sub) return gerr(S, C.INVALID_VALUE);
      if (S.pixelUnpack !== null && sp.pboOffset !== undefined) {
        const geo = unpackGeometry(S, w, h, d, sp.format, sp.type);
        const pb = S.pixelUnpack;
        if (sp.pboOffset + geo.need > pb.size) return gerr(S, C.INVALID_OPERATION);
        img = unpackToImage(S, pb.data, w, h, d, sp.format, sp.type, f, sp.pboOffset);
      } else {
        try { img = new Image(w, h, d, f); } catch (_) { return gerr(S, C.OUT_OF_MEMORY); }
      }
    } else {
      const view = sp.pixels;
      if (S.ver === 1 && !typedArrayOk(sp.type, view)) return gerr(S, C.INVALID_OPERATION);
      if (S.ver === 2 && !typedArrayOk(sp.type, view) && !(view instanceof DataView)) return gerr(S, C.INVALID_OPERATION);
      const bytes = viewBytes(view);
      const es = ArrayBuffer.isView(view) && !(view instanceof DataView) ? view.BYTES_PER_ELEMENT : 1;
      let off = (sp.srcOffset || 0) * es;
      const geo = unpackGeometry(S, w, h, d, sp.format, sp.type);
      if (off + geo.need > bytes.length) return gerr(S, C.INVALID_OPERATION);
      try { img = unpackToImage(S, bytes, w, h, d, sp.format, sp.type, f, off); } catch (_) { return gerr(S, C.OUT_OF_MEMORY); }
      off = 0;
    }
    if (sp.src) { /* dims come from the source */ }
    if (sp.sub) {
      const dst = getImg(t, face, level);
      const sw = img.w, sh = img.h, sd = img.d;
      if (sp.xo < 0 || sp.yo < 0 || sp.zo < 0 || sp.xo + sw > dst.w || sp.yo + sh > dst.h || sp.zo + sd > dst.d) return gerr(S, C.INVALID_VALUE);
      for (let z = 0; z < sd; z++) for (let y = 0; y < sh; y++) {
        const so = ((z * sh + y) * sw) * 4, dof = (((sp.zo + z) * dst.h + sp.yo + y) * dst.w + sp.xo) * 4;
        dst.data.set(img.data.subarray(so, so + sw * 4), dof);
      }
    } else {
      t.imgs.set(imgKey(face, level), img);
    }
    t.serial++;
  }
  G.uploadTexture = upload;

  // A DOM image source (TexImageSource); anything else is an overload resolution failure.
  function srcPixels(S, v, name) {
    if (!L.isTexImageSource(v)) throw new TypeError(`Failed to execute '${name}' on '${S.ver === 2 ? IF2 : IF1}': Overload resolution failed.`);
    return L.sourcePixels(v);
  }
  M.texImage2D = function texImage2D(target, level, internalformat, a, b, c, d, e, f, g) {
    const n = arguments.length;
    const S = stOf(this); if (S.lost) return;
    if (n !== 6 && n !== 9 && !(S.ver === 2 && n === 10)) throw new TypeError(`Failed to execute 'texImage2D' on '${S.ver === 2 ? IF2 : IF1}': ${n < 6 ? 6 : 9} arguments required, but only ${n} present.`);
    if (n === 6) srcPixels(S, c, 'texImage2D'); // overload resolution (WebIDL) comes before any GL validation
    target = glenum(target); level = glint(level); internalformat = glint(internalformat) >>> 0;
    if (!validTarget2D(S, target)) return gerr(S, C.INVALID_ENUM);
    if (n === 6) {
      const format = glenum(a), type = glenum(b);
      const px = srcPixels(S, c, 'texImage2D');
      if (px === null) return gerr(S, C.INVALID_VALUE);
      return upload(S, { sub: false, target, level, internal: internalformat, w: px.w, h: px.h, d: 1, format, type, src: px });
    }
    const w = glint(a), h = glint(b), border = glint(c);
    const format = glenum(d), type = glenum(e);
    if (border !== 0) return gerr(S, C.INVALID_VALUE);
    if (w < 0 || h < 0) return gerr(S, C.INVALID_VALUE);
    if (n === 9 && S.ver === 2 && typeof f === 'number') return upload(S, { sub: false, target, level, internal: internalformat, w, h, d: 1, format, type, pboOffset: f });
    if (n === 9 && isSource(f) && !ArrayBuffer.isView(f)) {
      const px = srcPixels(S, f, 'texImage2D');
      if (px === null) return gerr(S, C.INVALID_VALUE);
      return upload(S, { sub: false, target, level, internal: internalformat, w: px.w, h: px.h, d: 1, format, type, src: px });
    }
    if (f !== null && f !== undefined && !ArrayBuffer.isView(f)) throw new TypeError("Failed to execute 'texImage2D' on 'WebGLRenderingContext': Overload resolution failed.");
    return upload(S, { sub: false, target, level, internal: internalformat, w, h, d: 1, format, type, pixels: f === undefined ? null : f, srcOffset: n === 10 ? Number(g) >>> 0 : 0 });
  };
  M.texSubImage2D = function texSubImage2D(target, level, xo, yo, a, b, c, d, e, f) {
    const n = arguments.length;
    const S = stOf(this); if (S.lost) return;
    if (n !== 7 && n !== 9 && !(S.ver === 2 && n === 10)) throw new TypeError(`Failed to execute 'texSubImage2D' on '${S.ver === 2 ? IF2 : IF1}': ${n < 7 ? 7 : 9} arguments required, but only ${n} present.`);
    if (n === 7) srcPixels(S, c, 'texSubImage2D');
    target = glenum(target); level = glint(level); xo = glint(xo); yo = glint(yo);
    if (!validTarget2D(S, target)) return gerr(S, C.INVALID_ENUM);
    if (n === 7) {
      const px = srcPixels(S, c, 'texSubImage2D');
      if (px === null) return gerr(S, C.INVALID_VALUE);
      return upload(S, { sub: true, target, level, xo, yo, zo: 0, w: px.w, h: px.h, d: 1, format: glenum(a), type: glenum(b), src: px });
    }
    const w = glint(a), h = glint(b), format = glenum(c), type = glenum(d);
    if (w < 0 || h < 0) return gerr(S, C.INVALID_VALUE);
    if (n === 9 && S.ver === 2 && typeof e === 'number') {
      if (S.pixelUnpack === null) return gerr(S, C.INVALID_OPERATION);
      const geo = unpackGeometry(S, w, h, 1, format, type);
      const f0 = (getImg(boundTex(S, isCubeFace(target) ? C.TEXTURE_CUBE_MAP : target) || { imgs: new Map() }, faceOf(target), level) || {}).f;
      if (!f0) return gerr(S, C.INVALID_OPERATION);
      if (e + geo.need > S.pixelUnpack.size) return gerr(S, C.INVALID_OPERATION);
      return upload(S, { sub: true, target, level, xo, yo, zo: 0, w, h, d: 1, format, type, pixels: S.pixelUnpack.data, srcOffset: e });
    }
    if (n === 9 && isSource(e) && !ArrayBuffer.isView(e)) {
      const px = srcPixels(S, e, 'texSubImage2D');
      if (px === null) return gerr(S, C.INVALID_VALUE);
      return upload(S, { sub: true, target, level, xo, yo, zo: 0, w: px.w, h: px.h, d: 1, format, type, src: px });
    }
    if (e === null || e === undefined) return gerr(S, C.INVALID_VALUE);
    if (!ArrayBuffer.isView(e)) throw new TypeError("Failed to execute 'texSubImage2D' on 'WebGLRenderingContext': Overload resolution failed.");
    return upload(S, { sub: true, target, level, xo, yo, zo: 0, w, h, d: 1, format, type, pixels: e, srcOffset: n === 10 ? Number(f) >>> 0 : 0 });
  };
  const valid3D = (S, t) => t === C2.TEXTURE_3D || t === C2.TEXTURE_2D_ARRAY;
  M2.texImage3D = function texImage3D(target, level, internalformat, w, h, d, border, format, type, src, srcOffset) {
    const n = arguments.length;
    const S = stOf(this); if (S.lost) return;
    if (n < 10 || n > 11) throw new TypeError(`Failed to execute 'texImage3D' on '${IF2}': 10 arguments required, but only ${n} present.`);
    target = glenum(target); level = glint(level); internalformat = glint(internalformat) >>> 0; w = glint(w); h = glint(h); d = glint(d); border = glint(border); format = glenum(format); type = glenum(type);
    if (!valid3D(S, target)) return gerr(S, C.INVALID_ENUM);
    if (border !== 0 || w < 0 || h < 0 || d < 0) return gerr(S, C.INVALID_VALUE);
    if (typeof src === 'number') return upload(S, { sub: false, target, level, internal: internalformat, w, h, d, format, type, pboOffset: src });
    if (src !== null && src !== undefined && !ArrayBuffer.isView(src)) {
      const px = srcPixels(S, src, 'texImage3D');
      if (px === null) return gerr(S, C.INVALID_VALUE);
      return upload(S, { sub: false, target, level, internal: internalformat, w: px.w, h: px.h, d: 1, format, type, src: px });
    }
    return upload(S, { sub: false, target, level, internal: internalformat, w, h, d, format, type, pixels: src === undefined ? null : src, srcOffset: n === 11 ? Number(srcOffset) >>> 0 : 0 });
  };
  M2.texSubImage3D = function texSubImage3D(target, level, xo, yo, zo, w, h, d, format, type, src, srcOffset) {
    const n = arguments.length;
    const S = stOf(this); if (S.lost) return;
    if (n < 11 || n > 12) throw new TypeError(`Failed to execute 'texSubImage3D' on '${IF2}': 11 arguments required, but only ${n} present.`);
    target = glenum(target); level = glint(level); xo = glint(xo); yo = glint(yo); zo = glint(zo); w = glint(w); h = glint(h); d = glint(d); format = glenum(format); type = glenum(type);
    if (!valid3D(S, target)) return gerr(S, C.INVALID_ENUM);
    if (w < 0 || h < 0 || d < 0) return gerr(S, C.INVALID_VALUE);
    if (src === null || src === undefined) return gerr(S, C.INVALID_VALUE);
    if (typeof src === 'number') {
      if (S.pixelUnpack === null) return gerr(S, C.INVALID_OPERATION);
      return upload(S, { sub: true, target, level, xo, yo, zo, w, h, d, format, type, pixels: S.pixelUnpack.data, srcOffset: src });
    }
    if (!ArrayBuffer.isView(src)) {
      const px = srcPixels(S, src, 'texSubImage3D');
      if (px === null) return gerr(S, C.INVALID_VALUE);
      return upload(S, { sub: true, target, level, xo, yo, zo, w: px.w, h: px.h, d: 1, format, type, src: px });
    }
    return upload(S, { sub: true, target, level, xo, yo, zo, w, h, d, format, type, pixels: src, srcOffset: n === 12 ? Number(srcOffset) >>> 0 : 0 });
  };
  // immutable storage
  function storage(S, target, levels, internal, w, h, d, is3D) {
    const t = boundTex(S, target);
    if (t === null) return gerr(S, C.INVALID_OPERATION);
    const f = FMT.get(internal);
    if (!f || f.unsized) return gerr(S, C.INVALID_ENUM);
    if (levels < 1 || w < 1 || h < 1 || d < 1) return gerr(S, C.INVALID_VALUE);
    if (levels > G.maxLevels(w, h, is3D ? d : 1)) return gerr(S, C.INVALID_OPERATION);
    if (t.immutable) return gerr(S, C.INVALID_OPERATION);
    if (!checkLevelSize(S, target, 0, w, h, d)) return gerr(S, C.INVALID_VALUE);
    t.imgs.clear();
    const faces = target === C.TEXTURE_CUBE_MAP ? 6 : 1;
    try {
      for (let fc = 0; fc < faces; fc++) {
        let lw = w, lh = h, ld = d;
        for (let l = 0; l < levels; l++) {
          t.imgs.set(imgKey(fc, l), new Image(lw, lh, ld, f));
          lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1); if (is3D) ld = Math.max(1, ld >> 1);
        }
      }
    } catch (_) { t.imgs.clear(); return gerr(S, C.OUT_OF_MEMORY); }
    t.immutable = true; t.immutableLevels = levels; t.serial++;
  }
  M2.texStorage2D = function texStorage2D(target, levels, internal, w, h) {
    argsReq(IF2, 'texStorage2D', 5, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    if (target !== C.TEXTURE_2D && target !== C.TEXTURE_CUBE_MAP) return gerr(S, C.INVALID_ENUM);
    storage(S, target, glint(levels), glenum(internal), glint(w), glint(h), 1, false);
  };
  M2.texStorage3D = function texStorage3D(target, levels, internal, w, h, d) {
    argsReq(IF2, 'texStorage3D', 6, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    if (!valid3D(S, target)) return gerr(S, C.INVALID_ENUM);
    storage(S, target, glint(levels), glenum(internal), glint(w), glint(h), glint(d), target === C2.TEXTURE_3D);
  };
  // compressed textures are not supported: no compressed format is advertised
  const noCompressed = (name, n, iface) => function () { argsReq(iface, name, n, arguments.length); const S = stOf(this); if (!S.lost) gerr(S, C.INVALID_ENUM); };
  M.compressedTexImage2D = noCompressed('compressedTexImage2D', 7, IF1);
  M.compressedTexSubImage2D = noCompressed('compressedTexSubImage2D', 8, IF1);
  M2.compressedTexImage3D = noCompressed('compressedTexImage3D', 8, IF2);
  M2.compressedTexSubImage3D = noCompressed('compressedTexSubImage3D', 11, IF2);

  // generateMipmap: box filter
  function boxDown(src, store) {
    const w = Math.max(1, src.w >> 1), h = Math.max(1, src.h >> 1), d = src.d > 1 && src.is3D ? Math.max(1, src.d >> 1) : src.d;
    const out = new Image(w, h, d, src.f);
    const sd = src.data, od = out.data;
    const is3D = src.is3D;
    const z1 = is3D ? 2 : 1;
    for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      for (let k = 0; k < 4; k++) {
        let sum = 0, cnt = 0;
        for (let dz = 0; dz < z1; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(src.w - 1, x * 2 + dx), sy = Math.min(src.h - 1, y * 2 + dy), sz = is3D ? Math.min(src.d - 1, z * 2 + dz) : z;
          sum += sd[((sz * src.h + sy) * src.w + sx) * 4 + k]; cnt++;
        }
        od[((z * h + y) * w + x) * 4 + k] = store === 'u8' ? Math.round(sum / cnt) : sum / cnt;
      }
    }
    out.is3D = is3D;
    return out;
  }
  M.generateMipmap = function generateMipmap(target) {
    argsReq(IF1, 'generateMipmap', 1, arguments.length);
    const S = stOf(this); if (S.lost) return; target = glenum(target);
    if (targetSlot(S, target) === null) return gerr(S, C.INVALID_ENUM);
    const t = boundTex(S, target);
    if (t === null) return gerr(S, C.INVALID_OPERATION);
    const faces = target === C.TEXTURE_CUBE_MAP ? 6 : 1;
    const base = getImg(t, 0, 0);
    if (!base) return gerr(S, C.INVALID_OPERATION);
    const f = base.f;
    if (f.depth || f.stencil || f.integer || (f.store === 'f32' && f.float32 && !S.exts.has('OES_texture_float_linear') && S.ver === 2 && false)) return gerr(S, C.INVALID_OPERATION);
    if (S.ver === 1 && (!POT(base.w) || !POT(base.h))) return gerr(S, C.INVALID_OPERATION);
    if (target === C.TEXTURE_CUBE_MAP) for (let fc = 1; fc < 6; fc++) { const o = getImg(t, fc, 0); if (!o || o.w !== base.w || o.h !== base.h || o.f !== f) return gerr(S, C.INVALID_OPERATION); }
    const is3D = target === C2.TEXTURE_3D;
    const lastLevel = Math.min(t.maxLevel, G.maxLevels(base.w, base.h, is3D ? base.d : 1) - 1);
    for (let fc = 0; fc < faces; fc++) {
      let cur = getImg(t, fc, t.baseLevel) || getImg(t, fc, 0);
      cur.is3D = is3D;
      for (let l = t.baseLevel + 1; l <= lastLevel; l++) {
        if (cur.w === 1 && cur.h === 1 && (!is3D || cur.d === 1)) break;
        const next = boxDown(cur, f.store);
        t.imgs.set(imgKey(fc, l), next);
        cur = next;
      }
    }
    t.serial++;
  };

  // ---------------------------------------------------------------------------------------
  // Sampler objects (WebGL2)
  // ---------------------------------------------------------------------------------------
  M2.createSampler = function createSampler() { const S = stOf(this); if (S.lost) return null; const r = Object.assign({ kind: 'sampler', deleted: false }, newSamplerParams()); return wrapObj(WebGLSampler, S, r); };
  M2.deleteSampler = function deleteSampler(s) {
    const S = stOf(this); if (S.lost || s === null || s === undefined) return;
    if (!(s instanceof WebGLSampler)) throw G.typeErr(IF2, 'deleteSampler', 1, 'WebGLSampler');
    if (!isObjOf(S, s, WebGLSampler)) return gerr(S, C.INVALID_OPERATION);
    const r = rec(s); r.deleted = true;
    for (const u of S.units) if (u.sampler === r) u.sampler = null;
  };
  M2.isSampler = function isSampler(s) { const S = stOf(this); return !S.lost && isObjOf(S, s, WebGLSampler) && !rec(s).deleted; };
  M2.bindSampler = function bindSampler(unit, s) {
    argsReq(IF2, 'bindSampler', 2, arguments.length);
    const S = stOf(this); if (S.lost) return; unit = glenum(unit);
    if (unit >= LIM.maxCombinedTextureImageUnits) return gerr(S, C.INVALID_VALUE);
    if (s === null || s === undefined) { S.units[unit].sampler = null; return; }
    if (!(s instanceof WebGLSampler)) throw G.typeErr(IF2, 'bindSampler', 2, 'WebGLSampler');
    if (!isObjOf(S, s, WebGLSampler) || rec(s).deleted) return gerr(S, C.INVALID_OPERATION);
    S.units[unit].sampler = rec(s);
  };
  const samplerParam = (isFloat) => function (s, pname, param) {
    argsReq(IF2, isFloat ? 'samplerParameterf' : 'samplerParameteri', 3, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!(s instanceof WebGLSampler)) throw G.typeErr(IF2, 'samplerParameteri', 1, 'WebGLSampler');
    if (!isObjOf(S, s, WebGLSampler) || rec(s).deleted) return gerr(S, C.INVALID_OPERATION);
    setParam(S, rec(s), glenum(pname), Number(param), isFloat, false, null);
  };
  M2.samplerParameteri = samplerParam(false);
  M2.samplerParameterf = samplerParam(true);
  M2.getSamplerParameter = function getSamplerParameter(s, pname) {
    argsReq(IF2, 'getSamplerParameter', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    if (!(s instanceof WebGLSampler)) throw G.typeErr(IF2, 'getSamplerParameter', 1, 'WebGLSampler');
    if (!isObjOf(S, s, WebGLSampler) || rec(s).deleted) { gerr(S, C.INVALID_OPERATION); return null; }
    const r = rec(s);
    switch (glenum(pname)) {
      case C.TEXTURE_MAG_FILTER: return r.magFilter; case C.TEXTURE_MIN_FILTER: return r.minFilter; case C.TEXTURE_WRAP_S: return r.wrapS; case C.TEXTURE_WRAP_T: return r.wrapT;
      case C2.TEXTURE_WRAP_R: return r.wrapR; case C2.TEXTURE_MIN_LOD: return r.minLod; case C2.TEXTURE_MAX_LOD: return r.maxLod;
      case C2.TEXTURE_COMPARE_MODE: return r.compareMode; case C2.TEXTURE_COMPARE_FUNC: return r.compareFunc;
      default: gerr(S, C.INVALID_ENUM); return null;
    }
  };

  // ---------------------------------------------------------------------------------------
  // Pixel pack (readPixels) helpers: RGBA floats / ints -> destination view
  // ---------------------------------------------------------------------------------------
  G.packTexel = function packTexel(dv, off, type, comps, vals, kind) {
    // vals: numbers in the framebuffer's domain; kind: 'u8' normalized stored as 0..255, 'f' floats [0,1]-normalized or real, 'i' raw ints
    const nC = comps.length;
    const un = (v) => (kind === 'u8' ? v / 255 : v);
    switch (type) {
      case C.UNSIGNED_BYTE: for (let k = 0; k < nC; k++) dv.setUint8(off + k, kind === 'u8' ? vals[k] : kind === 'i' ? vals[k] : Math.round(clamp01(vals[k]) * 255)); break;
      case C.BYTE: for (let k = 0; k < nC; k++) dv.setInt8(off + k, kind === 'i' ? vals[k] : Math.round(Math.max(-1, Math.min(1, un(vals[k]))) * 127)); break;
      case C.UNSIGNED_SHORT: for (let k = 0; k < nC; k++) dv.setUint16(off + k * 2, kind === 'i' ? vals[k] : Math.round(clamp01(un(vals[k])) * 65535), true); break;
      case C.SHORT: for (let k = 0; k < nC; k++) dv.setInt16(off + k * 2, vals[k], true); break;
      case C.UNSIGNED_INT: for (let k = 0; k < nC; k++) dv.setUint32(off + k * 4, kind === 'i' ? vals[k] : Math.round(clamp01(un(vals[k])) * 4294967295), true); break;
      case C.INT: for (let k = 0; k < nC; k++) dv.setInt32(off + k * 4, vals[k], true); break;
      case C.FLOAT: for (let k = 0; k < nC; k++) dv.setFloat32(off + k * 4, un(vals[k]), true); break;
      case C2.HALF_FLOAT: for (let k = 0; k < nC; k++) dv.setUint16(off + k * 2, L.toHalf(un(vals[k])), true); break;
      case C.UNSIGNED_SHORT_4_4_4_4: { const q = (v) => Math.round(clamp01(un(v)) * 15); dv.setUint16(off, (q(vals[0]) << 12) | (q(vals[1]) << 8) | (q(vals[2]) << 4) | q(vals[3]), true); break; }
      case C.UNSIGNED_SHORT_5_5_5_1: { const q = (v) => Math.round(clamp01(un(v)) * 31); dv.setUint16(off, (q(vals[0]) << 11) | (q(vals[1]) << 6) | (q(vals[2]) << 1) | Math.round(clamp01(un(vals[3]))), true); break; }
      case C.UNSIGNED_SHORT_5_6_5: dv.setUint16(off, (Math.round(clamp01(un(vals[0])) * 31) << 11) | (Math.round(clamp01(un(vals[1])) * 63) << 5) | Math.round(clamp01(un(vals[2])) * 31), true); break;
      case C2.UNSIGNED_INT_2_10_10_10_REV: dv.setUint32(off, ((Math.round(clamp01(un(vals[0])) * 1023)) | (Math.round(clamp01(un(vals[1])) * 1023) << 10) | (Math.round(clamp01(un(vals[2])) * 1023) << 20) | (Math.round(clamp01(un(vals[3])) * 3) << 30)) >>> 0, true); break;
      default: break;
    }
  };
  G.clamp01 = clamp01;
})(globalThis.__layer);
