// 3b_gltex_sample.js — texture sampling and derivatives for the GLSL runtime: texture(), textureLod(),
// textureProj(), textureOffset(), textureGrad(), texelFetch(), textureSize(), dFdx/dFdy/fwidth.
//
// Filtering follows the GL ES 3.0 spec (§3.8.9–3.8.13): wrap modes, nearest/linear within a level,
// nearest/linear between mip levels, shadow comparison, completeness. Derivatives (automatic LOD,
// dFdx/dFdy) come from probe invocations: the fragment shader is re-run at the neighbouring pixel with
// its derivative-consuming calls recorded, as a 2x2 quad would provide them (see `probeFor`).
(function (L) {
  'use strict';
  const G = L.glInternals;
  const { C, C2, FMT, POT } = G;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function wrapIdx(i, n, mode) {
    switch (mode) {
      case C.REPEAT: return ((i % n) + n) % n;
      case C.MIRRORED_REPEAT: { const m = ((i % (2 * n)) + 2 * n) % (2 * n); return m < n ? m : 2 * n - 1 - m; }
      default: return i < 0 ? 0 : i >= n ? n - 1 : i;
    }
  }
  const isMipFilter = (f) => f >= C.NEAREST_MIPMAP_NEAREST && f <= C.LINEAR_MIPMAP_LINEAR;

  // ---- texture views (completeness, resolved parameters), cached per draw -----------------------
  function viewFor(ctx, unit, dim) {
    const key = unit * 8 + ({ '2D': 0, '2DShadow': 0, Cube: 1, CubeShadow: 1, '3D': 2, '2DArray': 3, '2DArrayShadow': 3 }[dim]);
    let v = ctx.texViews.get(key);
    if (v !== undefined) return v;
    v = buildView(ctx.S, unit, dim);
    ctx.texViews.set(key, v);
    return v;
  }
  function buildView(S, unit, dim) {
    const tex = G.textureForSampler(S, unit, dim);
    const empty = { complete: false, tex: null };
    if (!tex) return empty;
    const u = S.units[unit];
    const p = u.sampler || tex;
    const cube = dim === 'Cube' || dim === 'CubeShadow';
    const base = S.ver === 2 ? tex.baseLevel : 0;
    const faces = cube ? 6 : 1;
    const img0 = G.getImg(tex, 0, base);
    if (!img0 || img0.w === 0 || img0.h === 0 || img0.d === 0) return empty;
    const f = img0.f;
    const minF = p.minFilter, magF = p.magFilter;
    const mip = isMipFilter(minF);
    if (S.ver === 1 && (!POT(img0.w) || !POT(img0.h)) && (mip || p.wrapS !== C.CLAMP_TO_EDGE || p.wrapT !== C.CLAMP_TO_EDGE)) return empty;
    if (cube) {
      if (img0.w !== img0.h) return empty;
      for (let fc = 1; fc < 6; fc++) { const o = G.getImg(tex, fc, base); if (!o || o.w !== img0.w || o.h !== img0.h || o.f !== f) return empty; }
    }
    // filterability
    const linear = minF === C.LINEAR || minF === C.LINEAR_MIPMAP_LINEAR || minF === C.LINEAR_MIPMAP_NEAREST || magF === C.LINEAR;
    const shadow = dim.endsWith('Shadow');
    if (linear && f.integer) return empty;
    if (linear && f.store === 'f32' && f.float32 !== undefined && !S.exts.has('OES_texture_float_linear') && f.internal !== undefined && (f.float32 || [C2.R32F, C2.RG32F, C2.RGB32F, C2.RGBA32F].includes(f.internal)) && !shadow) return empty;
    if (linear && f.depth && !shadow && S.ver === 2 && p.compareMode !== C2.COMPARE_REF_TO_TEXTURE) return empty;
    if (shadow !== (f.depth && p.compareMode === C2.COMPARE_REF_TO_TEXTURE) && S.ver === 2) {
      if (shadow && !(f.depth && p.compareMode === C2.COMPARE_REF_TO_TEXTURE)) return empty;
      if (!shadow && f.depth && p.compareMode === C2.COMPARE_REF_TO_TEXTURE) return empty;
    }
    const levels = [];
    let maxIdx = base;
    if (mip) {
      const d = dim === '3D' ? img0.d : 1;
      const q = Math.min(base + Math.floor(Math.log2(Math.max(img0.w, img0.h, d))), S.ver === 2 ? tex.maxLevel : 1000);
      for (let l = base; l <= q; l++) {
        const im = G.getImg(tex, 0, l);
        const ew = Math.max(1, img0.w >> (l - base)), eh = Math.max(1, img0.h >> (l - base)), ed = dim === '3D' ? Math.max(1, img0.d >> (l - base)) : img0.d;
        if (!im || im.w !== ew || im.h !== eh || im.f !== f || (dim !== '2DArray' && dim !== '2DArrayShadow' && im.d !== ed) || ((dim === '2DArray' || dim === '2DArrayShadow') && im.d !== img0.d)) return empty;
        levels.push(cube ? null : im);
        maxIdx = l;
      }
      if (cube) { for (let l = base; l <= q; l++) { const arr = []; for (let fc = 0; fc < 6; fc++) { const im = G.getImg(tex, fc, l); if (!im || im.f !== f || im.w !== Math.max(1, img0.w >> (l - base))) return empty; arr.push(im); } levels[l - base] = arr; } }
    } else {
      if (cube) { const arr = []; for (let fc = 0; fc < 6; fc++) arr.push(G.getImg(tex, fc, base)); levels.push(arr); } else levels.push(img0);
    }
    return { complete: true, tex, p, f, cube, base, levels, maxIdx, mip, minF, magF, wrapS: p.wrapS, wrapT: p.wrapT, wrapR: p.wrapR, minLod: p.minLod, maxLod: p.maxLod, depthNoCompare: f.depth && p.compareMode !== C2.COMPARE_REF_TO_TEXTURE,
      shadowFn: p.compareFunc, ver: S.ver, w: img0.w, h: img0.h, d: img0.d, needsLod: mip || minF !== magF };
  }

  // fetch one texel (4 values) of an image
  function texel(img, x, y, z, out, sbase) {
    const o = (((z * img.h) + y) * img.w + x) * 4;
    const d = img.data;
    const f = img.f;
    switch (f.store) {
      case 'u8': out[0] = d[o] / 255; out[1] = d[o + 1] / 255; out[2] = d[o + 2] / 255; out[3] = d[o + 3] / 255; if (f.srgb) { out[0] = G.srgbDec(out[0]); out[1] = G.srgbDec(out[1]); out[2] = G.srgbDec(out[2]); } break;
      case 's8': for (let k = 0; k < 4; k++) out[k] = Math.max(d[o + k] / 127, -1); break;
      default: out[0] = d[o]; out[1] = d[o + 1]; out[2] = d[o + 2]; out[3] = d[o + 3];
    }
    void sbase;
  }

  const tmp = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  // sample one level of a 2D image (z = layer) with nearest/linear filtering at normalized (u, v)
  function sampleLevel2D(img, u, v, z, filt, wrapS, wrapT, out) {
    const w = img.w, h = img.h;
    if (filt === C.NEAREST) {
      texel(img, wrapIdx(Math.floor(u * w), w, wrapS), wrapIdx(Math.floor(v * h), h, wrapT), z, out);
      return;
    }
    const fx = u * w - 0.5, fy = v * h - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const ax = fx - x0, ay = fy - y0;
    const xa = wrapIdx(x0, w, wrapS), xb = wrapIdx(x0 + 1, w, wrapS), ya = wrapIdx(y0, h, wrapT), yb = wrapIdx(y0 + 1, h, wrapT);
    texel(img, xa, ya, z, tmp[0]); texel(img, xb, ya, z, tmp[1]); texel(img, xa, yb, z, tmp[2]); texel(img, xb, yb, z, tmp[3]);
    for (let k = 0; k < 4; k++) out[k] = (tmp[0][k] * (1 - ax) + tmp[1][k] * ax) * (1 - ay) + (tmp[2][k] * (1 - ax) + tmp[3][k] * ax) * ay;
  }
  function sampleLevel3D(img, u, v, r, filt, view, out) {
    const w = img.w, h = img.h, d = img.d;
    if (filt === C.NEAREST) { texel(img, wrapIdx(Math.floor(u * w), w, view.wrapS), wrapIdx(Math.floor(v * h), h, view.wrapT), wrapIdx(Math.floor(r * d), d, view.wrapR), out); return; }
    const fx = u * w - 0.5, fy = v * h - 0.5, fz = r * d - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const ax = fx - x0, ay = fy - y0, az = fz - z0;
    const xs = [wrapIdx(x0, w, view.wrapS), wrapIdx(x0 + 1, w, view.wrapS)], ys = [wrapIdx(y0, h, view.wrapT), wrapIdx(y0 + 1, h, view.wrapT)], zs = [wrapIdx(z0, d, view.wrapR), wrapIdx(z0 + 1, d, view.wrapR)];
    out[0] = out[1] = out[2] = out[3] = 0;
    for (let i = 0; i < 8; i++) {
      const xi = i & 1, yi = (i >> 1) & 1, zi = (i >> 2) & 1;
      texel(img, xs[xi], ys[yi], zs[zi], tmp[0]);
      const wgt = (xi ? ax : 1 - ax) * (yi ? ay : 1 - ay) * (zi ? az : 1 - az);
      for (let k = 0; k < 4; k++) out[k] += tmp[0][k] * wgt;
    }
  }
  const cubeFace = (x, y, z) => {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let face, sc, tc, ma;
    if (ax >= ay && ax >= az) { ma = ax; if (x >= 0) { face = 0; sc = -z; tc = -y; } else { face = 1; sc = z; tc = -y; } } else if (ay >= az) { ma = ay; if (y >= 0) { face = 2; sc = x; tc = z; } else { face = 3; sc = x; tc = -z; } } else { ma = az; if (z >= 0) { face = 4; sc = x; tc = -y; } else { face = 5; sc = -x; tc = -y; } }
    return [face, 0.5 * (sc / ma + 1), 0.5 * (tc / ma + 1), ma];
  };

  // compute the level of detail from the screen-space derivatives of the texture coordinate
  function lodFromDerivs(view, dx, dy, dim) {
    let sx, sy;
    const w = view.w, h = view.h, d = view.d;
    if (dim === '3D') { sx = Math.hypot(dx[0] * w, dx[1] * h, dx[2] * d); sy = Math.hypot(dy[0] * w, dy[1] * h, dy[2] * d); } else { sx = Math.hypot(dx[0] * w, dx[1] * h); sy = Math.hypot(dy[0] * w, dy[1] * h); }
    const rho = Math.max(sx, sy);
    return rho > 0 ? Math.log2(rho) : -1000;
  }

  // The core: `smp` is the sampler uniform ({unit, dim, sbase}), `c` the coordinate array.
  // mode: 0 = automatic LOD (+bias a), 1 = explicit LOD a, 2 = gradients (a = dPdx, b = dPdy)
  function sample(R, smp, c, mode, a, b, offset) {
    const ctx = R.cur;
    const S = ctx.S;
    const dim = smp.dim;
    const view = viewFor(ctx, smp.unit, dim);
    const isInt = smp.sbase !== 'float';
    const shadow = dim.endsWith('Shadow');
    const outDefault = () => (shadow ? 0 : (isInt ? [0, 0, 0, 1] : [0, 0, 0, 1]));
    // derivative probe bookkeeping: during a probe we record the coordinate and answer with a plain lookup
    let needsDeriv = mode === 0 && view.complete && view.needsLod;
    if (ctx.probe) {
      if (needsDeriv) ctx.probe.rec.push(c);
      mode = 1; a = 0; needsDeriv = false;
    }
    if (!view.complete) return outDefault();
    let lod = 0;
    if (mode === 0) {
      let bias = a || 0;
      if (needsDeriv) {
        const dd = derivatives(R, c);
        lod = lodFromDerivs(view, dd[0], dd[1], dim === '3D' ? '3D' : '2D') + bias;
        if (dim === 'Cube' || dim === 'CubeShadow') lod = cubeLod(view, c, dd) + bias;
      } else lod = bias;
    } else if (mode === 1) lod = a;
    else if (mode === 2) lod = lodFromDerivs(view, a, b, dim === '3D' ? '3D' : '2D');
    const out = [0, 0, 0, 0];
    doSample(view, c, lod, dim, offset, out, S);
    // component mapping for formats without all channels
    const f = view.f;
    if (f.depth) {
      if (shadow) return out[0];
      return view.ver === 1 ? [out[0], out[0], out[0], 1] : [out[0], 0, 0, 1];
    }
    if (isInt) return out.map((v) => (smp.sbase === 'int' ? v | 0 : v >>> 0));
    return out;
  }
  function cubeLod(view, c, dd) {
    const [face, u, v] = cubeFace(c[0], c[1], c[2]);
    const mapAt = (dc) => { const f2 = cubeFaceFixed(c[0] + dc[0], c[1] + dc[1], c[2] + dc[2], face); return [f2[0] - u, f2[1] - v]; };
    const dx = mapAt(dd[0]), dy = mapAt(dd[1]);
    const w = view.w;
    return Math.log2(Math.max(Math.hypot(dx[0] * w, dx[1] * w), Math.hypot(dy[0] * w, dy[1] * w), 1e-30));
  }
  function cubeFaceFixed(x, y, z, face) {
    let sc, tc, ma;
    switch (face) {
      case 0: ma = x; sc = -z; tc = -y; break; case 1: ma = -x; sc = z; tc = -y; break;
      case 2: ma = y; sc = x; tc = z; break; case 3: ma = -y; sc = x; tc = -z; break;
      case 4: ma = z; sc = x; tc = -y; break; default: ma = -z; sc = -x; tc = -y; break;
    }
    return [0.5 * (sc / ma + 1), 0.5 * (tc / ma + 1)];
  }
  function doSample(view, c, lod, dim, offset, out, S) {
    void S;
    lod = clamp(lod, view.minLod, view.maxLod);
    const magnify = lod <= 0;
    let filt, l0, l1 = -1, frac = 0;
    const maxStep = view.maxIdx - view.base;
    if (magnify) { filt = view.magF; l0 = 0; } else {
      const mf = view.minF;
      if (mf === C.NEAREST || mf === C.LINEAR) { filt = mf; l0 = 0; } else {
        filt = (mf === C.NEAREST_MIPMAP_NEAREST || mf === C.NEAREST_MIPMAP_LINEAR) ? C.NEAREST : C.LINEAR;
        if (mf === C.NEAREST_MIPMAP_NEAREST || mf === C.LINEAR_MIPMAP_NEAREST) l0 = clamp(Math.ceil(lod + 0.5) - 1, 0, maxStep);
        else { const lc = clamp(lod, 0, maxStep); l0 = Math.floor(lc); frac = lc - l0; if (frac > 0 && l0 < maxStep) l1 = l0 + 1; }
      }
    }
    const lv = (i) => view.levels[Math.min(i, view.levels.length - 1)];
    const one = (li, res) => {
      const img0 = lv(li);
      const lod2 = li;
      void lod2;
      switch (dim) {
        case '2D': case '2DShadow': {
          const img = img0;
          const off = offset || [0, 0];
          const u = c[0] + off[0] / img.w, v = c[1] + off[1] / img.h;
          if (dim === '2DShadow') return shadow2D(view, img, u, v, 0, c[2], filt, res);
          sampleLevel2D(img, u, v, 0, filt, view.wrapS, view.wrapT, res); return undefined;
        }
        case '2DArray': case '2DArrayShadow': {
          const img = img0;
          const layer = clamp(Math.floor(c[2] + 0.5), 0, img.d - 1);
          const off = offset || [0, 0];
          const u = c[0] + off[0] / img.w, v = c[1] + off[1] / img.h;
          if (dim === '2DArrayShadow') return shadow2D(view, img, u, v, layer, c[3], filt, res);
          sampleLevel2D(img, u, v, layer, filt, view.wrapS, view.wrapT, res); return undefined;
        }
        case '3D': {
          const img = img0; const off = offset || [0, 0, 0];
          sampleLevel3D(img, c[0] + off[0] / img.w, c[1] + off[1] / img.h, c[2] + off[2] / img.d, filt, view, res); return undefined;
        }
        default: { // cube
          const [face, u, v] = cubeFace(c[0], c[1], c[2]);
          const imgs = img0;
          if (dim === 'CubeShadow') return shadow2D(view, imgs[face], u, v, 0, c[3], filt, res);
          sampleLevel2D(imgs[face], u, v, 0, filt, C.CLAMP_TO_EDGE, C.CLAMP_TO_EDGE, res); return undefined;
        }
      }
    };
    if (dim.endsWith('Shadow')) { const r = one(l0, out); out[0] = r; if (l1 >= 0) { const r1 = one(l1, tmp[7]); out[0] = r * (1 - frac) + r1 * frac; } return; }
    one(l0, out);
    if (l1 >= 0) { one(l1, tmp[6]); for (let k = 0; k < 4; k++) out[k] = out[k] * (1 - frac) + tmp[6][k] * frac; }
  }
  function shadow2D(view, img, u, v, layer, ref, filt, out) {
    const w = img.w, h = img.h;
    const f = view.shadowFn;
    const cmpAt = (x, y) => { texel(img, x, y, layer, tmp[5]); return G.cmpFunc(f, clamp(ref, 0, 1), tmp[5][0]) ? 1 : 0; };
    void out;
    if (filt === C.NEAREST) return cmpAt(wrapIdx(Math.floor(u * w), w, view.wrapS), wrapIdx(Math.floor(v * h), h, view.wrapT));
    const fx = u * w - 0.5, fy = v * h - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const xa = wrapIdx(x0, w, view.wrapS), xb = wrapIdx(x0 + 1, w, view.wrapS), ya = wrapIdx(y0, h, view.wrapT), yb = wrapIdx(y0 + 1, h, view.wrapT);
    return (cmpAt(xa, ya) * (1 - ax) + cmpAt(xb, ya) * ax) * (1 - ay) + (cmpAt(xa, yb) * (1 - ax) + cmpAt(xb, yb) * ax) * ay;
  }

  // ---- derivatives through probe invocations ---------------------------------------------------------
  // Returns the derivative vectors [d/dx, d/dy] of `val` (a number or array) at the current fragment.
  // The i-th derivative-consuming call of the primary run pairs with the i-th recorded call of the probes.
  function probeFor(ctx) {
    if (ctx.probeState) return ctx.probeState;
    const pix = ctx.pix;
    const run = (dx, dy) => {
      const rec = [];
      const saved = Object.assign({}, ctx.lnk.Gf);
      const savedPix = ctx.pix, savedProbe = ctx.probe;
      try { G.shadeAt(ctx, pix.x + dx, pix.y + dy, { rec }); } catch (_) { /* a diverging probe can fail; its derivatives stay zero */ }
      ctx.probe = savedProbe;
      ctx.pix = savedPix;
      const Gf = ctx.lnk.Gf;
      for (const k of Object.keys(Gf)) delete Gf[k];
      Object.assign(Gf, saved);
      return rec;
    };
    ctx.probeState = { x: run(1, 0), y: run(0, 1), n: 0 };
    return ctx.probeState;
  }
  function sub(a, b) { return typeof a === 'number' ? a - b : a.map((v, i) => v - b[i]); }
  function derivatives(R, val) {
    const ctx = R.cur;
    const ps = probeFor(ctx);
    const k = ps.n++;
    const vx = ps.x[k], vy = ps.y[k];
    const zero = typeof val === 'number' ? 0 : val.map(() => 0);
    return [vx === undefined ? zero : sub(vx, val), vy === undefined ? zero : sub(vy, val)];
  }
  const abs = (v) => (typeof v === 'number' ? Math.abs(v) : v.map(Math.abs));

  G.extendRuntime = function extendRuntime(R) {
    R.texture = (smp, c, bias) => sample(R, smp, c, 0, bias);
    R.textureProj = (smp, c, bias) => {
      const n = c.length;
      const dimN = smp.dim === '3D' ? 3 : 2;
      const q = c[n - 1];
      const cc = c.slice(0, dimN).map((v) => v / q);
      if (smp.dim === '2DShadow') cc.push(c[2] / q);
      return sample(R, smp, cc, 0, bias);
    };
    R.textureLod = (smp, c, lod) => sample(R, smp, c, 1, lod);
    R.textureOffset = (smp, c, off, bias) => sample(R, smp, c, 0, bias, undefined, off);
    R.textureGrad = (smp, c, dx, dy) => sample(R, smp, c, 2, dx, dy);
    R.texelFetch = (smp, p, lod) => {
      const ctx = R.cur;
      const view = viewFor(ctx, smp.unit, smp.dim);
      const isInt = smp.sbase !== 'float';
      if (!view.complete) return [0, 0, 0, 1];
      const lv = clamp(lod | 0, 0, view.maxIdx - view.base);
      const img = view.levels[Math.min(lv, view.levels.length - 1)];
      const x = p[0], y = p[1], z = smp.dim === '2D' ? 0 : p[2];
      if (!img || x < 0 || y < 0 || x >= img.w || y >= img.h || z < 0 || z >= img.d) return [0, 0, 0, 0];
      const out = [0, 0, 0, 0];
      texel(img, x, y, z, out);
      if (view.f.depth) return view.ver === 1 ? [out[0], out[0], out[0], 1] : [out[0], 0, 0, 1];
      return isInt ? out.map((v) => (smp.sbase === 'int' ? v | 0 : v >>> 0)) : out;
    };
    R.textureSize = (smp, lod) => {
      const ctx = R.cur;
      const view = viewFor(ctx, smp.unit, smp.dim);
      if (!view.complete) return smp.dim === '3D' || smp.dim.startsWith('2DArray') ? [0, 0, 0] : [0, 0];
      const lv = clamp(lod | 0, 0, view.maxIdx - view.base);
      const img = view.levels[Math.min(lv, view.levels.length - 1)];
      const im = Array.isArray(img) ? img[0] : img;
      if (smp.dim === '3D' || smp.dim.startsWith('2DArray')) return [im.w, im.h, im.d];
      return [im.w, im.h];
    };
    const deriv = (which) => (val) => {
      const ctx = R.cur;
      if (ctx.probe) { ctx.probe.rec.push(val); return typeof val === 'number' ? 0 : val.map(() => 0); }
      const d = derivatives(R, val);
      return d[which];
    };
    R.dFdx = deriv(0);
    R.dFdy = deriv(1);
    R.fwidth = (val) => {
      const ctx = R.cur;
      if (ctx.probe) { ctx.probe.rec.push(val); return typeof val === 'number' ? 0 : val.map(() => 0); }
      const d = derivatives(R, val);
      const ax = abs(d[0]), ay = abs(d[1]);
      return typeof ax === 'number' ? ax + ay : ax.map((v, i) => v + ay[i]);
    };
  };
  void FMT;
})(globalThis.__layer);
