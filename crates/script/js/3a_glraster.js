// 3a_glraster.js — the software rendering pipeline behind WebGL draw calls: vertex fetch, vertex shader
// invocation, primitive assembly and clipping, rasterization of points, lines and triangles (integer
// edge functions on a 1/256 pixel grid, top-left rule, perspective-correct interpolation), the fragment
// shader (with probe invocations for derivatives, see 3b_gltex_sample.js) and the per-fragment
// operations (scissor, stencil, depth, blending, masks, occlusion queries).
(function (L) {
  'use strict';
  const G = L.glInternals;
  const { C, C2, LIM, FMT } = G;

  const SUB = 256;
  const FRAC = Math.fround;

  // ---- vertex attribute fetch -------------------------------------------------------------
  const dvOf = (b) => { if (b.dvData !== b.data) { b.dvData = b.data; b.dv = new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength); } return b.dv; };
  function fetchAttrib(at, idx, out) {
    const dv = dvOf(at.buffer);
    const es = G.ATTR_SIZES[at.type];
    const stride = at.stride || es * at.size;
    const off = at.offset + idx * stride;
    const n = at.size;
    const integer = at.integer;
    const norm = at.normalized;
    switch (at.type) {
      case C.FLOAT: for (let k = 0; k < n; k++) out[k] = dv.getFloat32(off + k * 4, true); return;
      case C.UNSIGNED_BYTE: for (let k = 0; k < n; k++) { const v = dv.getUint8(off + k); out[k] = norm ? v / 255 : v; } return;
      case C.BYTE: for (let k = 0; k < n; k++) { const v = dv.getInt8(off + k); out[k] = norm ? Math.max(v / 127, -1) : v; } return;
      case C.UNSIGNED_SHORT: for (let k = 0; k < n; k++) { const v = dv.getUint16(off + k * 2, true); out[k] = norm ? v / 65535 : v; } return;
      case C.SHORT: for (let k = 0; k < n; k++) { const v = dv.getInt16(off + k * 2, true); out[k] = norm ? Math.max(v / 32767, -1) : v; } return;
      case C.UNSIGNED_INT: for (let k = 0; k < n; k++) { const v = dv.getUint32(off + k * 4, true); out[k] = norm && !integer ? v / 4294967295 : v; } return;
      case C.INT: for (let k = 0; k < n; k++) { const v = dv.getInt32(off + k * 4, true); out[k] = norm && !integer ? Math.max(v / 2147483647, -1) : v; } return;
      case C2.HALF_FLOAT: for (let k = 0; k < n; k++) out[k] = L.fromHalf(dv.getUint16(off + k * 2, true)); return;
      case C2.UNSIGNED_INT_2_10_10_10_REV: { const v = dv.getUint32(off, true); const c = [v & 1023, (v >>> 10) & 1023, (v >>> 20) & 1023, v >>> 30]; for (let k = 0; k < 4; k++) out[k] = norm ? c[k] / (k === 3 ? 3 : 1023) : c[k]; return; }
      case C2.INT_2_10_10_10_REV: {
        const v = dv.getUint32(off, true);
        const s10 = (x) => (x << 22) >> 22; const s2 = (x) => (x << 30) >> 30;
        const c = [s10(v & 1023), s10((v >>> 10) & 1023), s10((v >>> 20) & 1023), s2(v >>> 30)];
        for (let k = 0; k < 4; k++) out[k] = norm ? Math.max(c[k] / (k === 3 ? 1 : 511), -1) : c[k];
        return;
      }
      default: return;
    }
  }

  // build a JS value of GLSL type `t` from a flat array starting at `o`
  function builderOf(t) {
    const ti = L.glsl.info(t);
    if (ti.kind === 'scalar') return ti.base === 'float' ? (a, o) => a[o] : (a, o) => Math.round(a[o]);
    if (ti.kind === 'vec') { const n = ti.n; return ti.base === 'float' ? (a, o) => { const r = new Array(n); for (let k = 0; k < n; k++) r[k] = a[o + k]; return r; } : (a, o) => { const r = new Array(n); for (let k = 0; k < n; k++) r[k] = Math.round(a[o + k]); return r; }; }
    if (ti.kind === 'mat') { const n = ti.n; return (a, o) => { const r = new Array(n); for (let k = 0; k < n; k++) r[k] = a[o + k]; return r; }; }
    if (ti.kind === 'array') { const eb = builderOf(ti.elem); const en = compsOf(ti.elem); const len = ti.len; return (a, o) => { const r = new Array(len); for (let k = 0; k < len; k++) r[k] = eb(a, o + k * en); return r; }; }
    return () => null;
  }
  function compsOf(t) {
    const ti = L.glsl.info(t);
    if (ti.kind === 'scalar') return 1; if (ti.kind === 'vec' || ti.kind === 'mat') return ti.n;
    if (ti.kind === 'array') return ti.len * compsOf(ti.elem);
    return 0;
  }
  function flattenInto(v, t, out, o) {
    const ti = L.glsl.info(t);
    if (ti.kind === 'scalar') { out[o] = +v; return o + 1; }
    if (ti.kind === 'vec' || ti.kind === 'mat') { for (let k = 0; k < ti.n; k++) out[o + k] = +v[k]; return o + ti.n; }
    if (ti.kind === 'array') { for (let k = 0; k < ti.len; k++) o = flattenInto(v[k], ti.elem, out, o); return o; }
    return o;
  }

  // per-link cached varying layout
  function varLayout(lnk) {
    if (lnk.vlayout) return lnk.vlayout;
    let off = 0;
    const list = lnk.varyings.map((v) => { const n = compsOf(v.t); const e = { name: v.name, t: v.t, off, n, flat: !!v.flat || L.glsl.info(v.t).base !== 'float' && !(L.glsl.info(v.t).kind === 'array' && L.glsl.info(L.glsl.info(v.t).elem).base === 'float'), build: builderOf(v.t) }; off += n; return e; });
    lnk.vlayout = { list, total: off };
    return lnk.vlayout;
  }
  function vertexOutputsOf(vi, name) { return vi.varyings.find((x) => x.name === name); }

  // ---- shader outputs ----------------------------------------------------------------------
  function zeroValue(t) { return new Function(`return ${L.glsl.zeroJS(t)}`)(); }

  // ---------------------------------------------------------------------------------------
  // Draw
  // ---------------------------------------------------------------------------------------
  G.rasterDraw = function rasterDraw(S, prog, mode, count, first, indexInfo, instances) {
    const lnk = prog.link;
    const R = lnk.R;
    const tgt = G.renderTarget(S, S.drawFb);
    if (!tgt.w || !tgt.h) return;
    const ctx = makeContext(S, prog, lnk, R, tgt);
    G.cur = ctx;
    R.cur = ctx;
    try {
      // the index sequence
      let seq;
      if (indexInfo === null) { seq = new Int32Array(count); for (let i = 0; i < count; i++) seq[i] = first + i; } else {
        seq = new Float64Array(count);
        const dv = dvOf(indexInfo.buffer);
        const bs = indexInfo.size;
        for (let i = 0; i < count; i++) { const o = indexInfo.offset + i * bs; seq[i] = bs === 1 ? dv.getUint8(o) : bs === 2 ? dv.getUint16(o, true) : dv.getUint32(o, true); }
        ctx.restartIndex = bs === 1 ? 255 : bs === 2 ? 65535 : 4294967295;
      }
      for (let inst = 0; inst < instances; inst++) {
        ctx.instance = inst;
        ctx.vcache = new Map();
        assemble(ctx, mode, seq, indexInfo !== null);
      }
    } finally {
      G.cur = null; R.cur = null;
    }
  };

  function makeContext(S, prog, lnk, R, tgt) {
    const vl = varLayout(lnk);
    const fi = lnk.fi;
    const ctx = {
      S, prog, lnk, R, tgt, vl, instance: 0, vcache: null, restartIndex: -1,
      vp: S.viewport.slice(), dnear: S.depth.near, dfar: S.depth.far,
      rect: null, early: false, texViews: new Map(), probe: null, frag: null,
      isInt: false, qAny: S.activeQueries && (S.activeQueries[C2.ANY_SAMPLES_PASSED] || S.activeQueries[C2.ANY_SAMPLES_PASSED_CONSERVATIVE]) || null,
    };
    // viewport clamped to the target; scissor
    const vx = ctx.vp[0], vy = ctx.vp[1], vw = ctx.vp[2], vh = ctx.vp[3];
    let x0 = Math.max(0, vx), y0 = Math.max(0, vy), x1 = Math.min(tgt.w, vx + vw), y1 = Math.min(tgt.h, vy + vh);
    if (S.scissorTest) { x0 = Math.max(x0, S.scissor[0]); y0 = Math.max(y0, S.scissor[1]); x1 = Math.min(x1, S.scissor[0] + S.scissor[2]); y1 = Math.min(y1, S.scissor[1] + S.scissor[3]); }
    ctx.rect = [x0, y0, x1, y1];
    ctx.usesFragCoord = fi.usesFragCoord;
    // fragment output routing
    ctx.outputs = lnk.version === 300 ? lnk.outs : null;
    ctx.attachments = tgt.colors;
    ctx.writeColors = S.colorMask.some(Boolean);
    ctx.blendOn = S.blend.enabled;
    // early depth test when the shader cannot change the outcome
    ctx.early = S.depth.enabled && !S.stencil.enabled && !fi.usesDiscard && !fi.usesFragDepth && !!tgt.depth && !ctx.qAny;
    ctx.dq = tgt.depth && tgt.depth.f ? (tgt.depth.f.bits[4] === 16 ? 65535 : tgt.depth.f.bits[4] === 24 ? 16777215 : 0) : (S.attrs.depth ? 16777215 : 0);
    // vertex processing prep
    ctx.attrTable = lnk.activeAttrs.map((a) => ({ a, ti: L.glsl.info(a.t) }));
    ctx.tfpos = null;
    return ctx;
  }

  const tmpComp = [0, 0, 0, 1];
  function runVertex(ctx, index) {
    const key = index;
    const hit = ctx.vcache.get(key);
    if (hit !== undefined) return hit;
    const { S, lnk, R } = ctx;
    const Gv = lnk.Gv;
    for (const { a, ti } of ctx.attrTable) {
      const kind = ti.kind === 'array' ? L.glsl.info(ti.elem) : ti;
      const slots = kind.kind === 'mat' ? kind.cols : 1;
      const comp = kind.kind === 'mat' ? kind.rows : kind.kind === 'vec' ? kind.n : 1;
      const base = kind.base;
      const readOne = (loc) => {
        const at = S.vao.attribs[loc];
        const vals = [0, 0, 0, 1];
        if (at.enabled) {
          const idx = at.divisor === 0 ? index : Math.floor(ctx.instance / at.divisor);
          tmpComp[0] = 0; tmpComp[1] = 0; tmpComp[2] = 0; tmpComp[3] = 1;
          fetchAttrib(at, idx, tmpComp);
          for (let k = 0; k < 4; k++) vals[k] = k < at.size ? tmpComp[k] : (k === 3 ? 1 : 0);
        } else {
          const g = S.generic[loc];
          const arr = g.type === C.INT ? g.i : g.type === C.UNSIGNED_INT ? g.u : g.f;
          for (let k = 0; k < 4; k++) vals[k] = arr[k];
        }
        return vals;
      };
      let value;
      if (slots === 1) {
        const v = readOne(a.loc);
        const conv = (x) => (base === 'float' ? x : base === 'int' ? x | 0 : x >>> 0);
        value = kind.kind === 'scalar' ? conv(v[0]) : v.slice(0, comp).map(conv);
      } else {
        value = [];
        for (let c = 0; c < slots; c++) { const v = readOne(a.loc + c); for (let r = 0; r < comp; r++) value.push(v[r]); }
      }
      Gv[`a_${a.name}`] = value;
    }
    Gv.gl_Position = [0, 0, 0, 1]; Gv.gl_PointSize = 1; Gv.gl_VertexID = index | 0; Gv.gl_InstanceID = ctx.instance;
    R.budget = 4e6;
    lnk.runVS();
    const p = Gv.gl_Position;
    const vl = ctx.vl;
    const vars = new Float64Array(vl.total);
    for (const e of vl.list) { const v = Gv[`v_${e.name}`]; if (v !== undefined) flattenInto(v, e.t, vars, e.off); }
    const out = { x: p[0], y: p[1], z: p[2], w: p[3], vars, size: Gv.gl_PointSize, index };
    ctx.vcache.set(key, out);
    return out;
  }

  function assemble(ctx, mode, seq, indexed) {
    const n = seq.length;
    const restart = indexed ? ctx.restartIndex : -1;
    const V = (i) => runVertex(ctx, seq[i]);
    switch (mode) {
      case C.POINTS: for (let i = 0; i < n; i++) { if (seq[i] === restart && false) continue; point(ctx, V(i)); } break;
      case C.LINES: for (let i = 0; i + 1 < n; i += 2) line(ctx, V(i), V(i + 1)); break;
      case C.LINE_STRIP: case C.LINE_LOOP: {
        let start = 0;
        for (let i = 0; i <= n; i++) {
          if (i === n || seq[i] === restart) {
            const len = i - start;
            if (len >= 2) { for (let k = start; k + 1 < i; k++) line(ctx, V(k), V(k + 1)); if (mode === C.LINE_LOOP && len > 2) line(ctx, V(i - 1), V(start)); else if (mode === C.LINE_LOOP && len === 2) line(ctx, V(i - 1), V(start)); }
            start = i + 1;
          }
        }
        break;
      }
      case C.TRIANGLES: for (let i = 0; i + 2 < n; i += 3) triangle(ctx, V(i), V(i + 1), V(i + 2)); break;
      case C.TRIANGLE_STRIP: {
        let start = 0;
        for (let i = 0; i <= n; i++) {
          if (i === n || seq[i] === restart) {
            for (let k = 0; start + k + 2 < i; k++) { const a = V(start + k), b = V(start + k + 1), c = V(start + k + 2); if (k & 1) triangle(ctx, b, a, c, true); else triangle(ctx, a, b, c); }
            start = i + 1;
          }
        }
        break;
      }
      case C.TRIANGLE_FAN: {
        let start = 0;
        for (let i = 0; i <= n; i++) {
          if (i === n || seq[i] === restart) {
            for (let k = 1; start + k + 1 < i; k++) triangle(ctx, V(start), V(start + k), V(start + k + 1));
            start = i + 1;
          }
        }
        break;
      }
      default: break;
    }
  }

  // ---- clipping ----------------------------------------------------------------------------
  // A clip-space vertex: {x,y,z,w,vars}. Clip against w > eps, -w <= z <= w.
  const EPS_W = 1e-9;
  function clipPoly(poly) {
    const planes = [(v) => v.w - EPS_W, (v) => v.w + v.z, (v) => v.w - v.z];
    let cur = poly;
    for (const d of planes) {
      if (cur.length === 0) break;
      const next = [];
      for (let i = 0; i < cur.length; i++) {
        const a = cur[i], b = cur[(i + 1) % cur.length];
        const da = d(a), db = d(b);
        if (da >= 0) next.push(a);
        if ((da >= 0) !== (db >= 0)) {
          const t = da / (da - db);
          const vars = new Float64Array(a.vars.length);
          for (let k = 0; k < vars.length; k++) vars[k] = a.vars[k] + (b.vars[k] - a.vars[k]) * t;
          next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, w: a.w + (b.w - a.w) * t, vars, size: a.size, flatFrom: a.flatFrom });
        }
      }
      cur = next;
    }
    return cur;
  }
  // clip vertex -> window vertex with perspective-premultiplied varyings
  function toWindow(ctx, v, flatSrc) {
    const iw = 1 / v.w;
    const nx = v.x * iw, ny = v.y * iw, nz = v.z * iw;
    const [vx, vy, vw, vh] = ctx.vp;
    const vars = v.vars;
    const vwv = new Float64Array(vars.length);
    for (let k = 0; k < vars.length; k++) vwv[k] = vars[k] * iw;
    return { x: vx + (nx + 1) * 0.5 * vw, y: vy + (ny + 1) * 0.5 * vh, z: ctx.dnear + (ctx.dfar - ctx.dnear) * (nz + 1) * 0.5, iw, vw: vwv, flat: flatSrc.vars };
  }

  function triangle(ctx, a, b, c, flipped) {
    // quick reject: all vertices outside the same clip plane
    const poly = clipPoly([a, b, c]);
    if (poly.length < 3) return;
    const flat = c; // provoking vertex: last
    const W = poly.map((v) => toWindow(ctx, v, flat));
    for (let i = 1; i + 1 < W.length; i++) rasterTriangle(ctx, W[0], W[i], W[i + 1]);
    void flipped;
  }

  // ---- triangle rasterization ----------------------------------------------------------------
  function rasterTriangle(ctx, v0, v1, v2) {
    const S = ctx.S;
    const X0 = Math.round(v0.x * SUB), Y0 = Math.round(v0.y * SUB), X1 = Math.round(v1.x * SUB), Y1 = Math.round(v1.y * SUB), X2 = Math.round(v2.x * SUB), Y2 = Math.round(v2.y * SUB);
    const area = (X1 - X0) * (Y2 - Y0) - (X2 - X0) * (Y1 - Y0);
    if (area === 0) return;
    const ccw = area > 0;
    const front = ccw === (S.frontFace === C.CCW);
    if (S.cull) {
      const m = S.cullMode;
      if (m === C.FRONT_AND_BACK) return;
      if ((m === C.FRONT && front) || (m === C.BACK && !front)) return;
    }
    let a = v0, b = v1, c = v2, ax = X0, ay = Y0, bx = X1, by = Y1, cx = X2, cy = Y2, ar = area;
    if (!ccw) { b = v2; c = v1; bx = X2; by = Y2; cx = X1; cy = Y1; ar = -area; }
    const [rx0, ry0, rx1, ry1] = ctx.rect;
    const minX = Math.max(rx0, Math.floor(Math.min(ax, bx, cx) / SUB)), maxX = Math.min(rx1 - 1, Math.floor(Math.max(ax, bx, cx) / SUB));
    const minY = Math.max(ry0, Math.floor(Math.min(ay, by, cy) / SUB)), maxY = Math.min(ry1 - 1, Math.floor(Math.max(ay, by, cy) / SUB));
    if (minX > maxX || minY > maxY) return;
    // tie-break inclusion per directed edge
    const inc = (dx, dy) => dy > 0 || (dy === 0 && dx < 0);
    const i0 = inc(cx - bx, cy - by), i1 = inc(ax - cx, ay - cy), i2 = inc(bx - ax, by - ay);
    // depth plane for polygon offset
    let zoff = 0;
    const needOff = S.polyOffset && (S.polyFactor !== 0 || S.polyUnits !== 0);
    if (needOff) {
      const dzdx = ((b.z - a.z) * (cy - ay) - (c.z - a.z) * (by - ay)) / ar * SUB;
      const dzdy = ((c.z - a.z) * (bx - ax) - (b.z - a.z) * (cx - ax)) / ar * SUB;
      const slope = Math.max(Math.abs(dzdx), Math.abs(dzdy));
      const r = ctx.dq ? 1 / ctx.dq : 1.1920929e-7;
      zoff = S.polyFactor * slope + S.polyUnits * r;
    }
    const fragCtx = { a, b, c, ar, ax, ay, bx, by, cx, cy, front, zoff, flat: v2.flat, i0, i1, i2 };
    ctx.frag = fragCtx;
    for (let y = minY; y <= maxY; y++) {
      const py = (y + 0.5) * SUB;
      for (let x = minX; x <= maxX; x++) {
        const px = (x + 0.5) * SUB;
        const e0 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const e1 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        const e2 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        if ((e0 === 0 && !i0) || (e1 === 0 && !i1) || (e2 === 0 && !i2)) continue;
        fragment(ctx, x, y, e0 / ar, e1 / ar, e2 / ar, fragCtx);
      }
    }
  }

  // ---- lines and points ----------------------------------------------------------------------
  function clipLine(a, b) {
    let t0 = 0, t1 = 1;
    const planes = [(v) => v.w - EPS_W, (v) => v.w + v.z, (v) => v.w - v.z];
    for (const d of planes) {
      const da = d(a), db = d(b);
      if (da < 0 && db < 0) return null;
      if (da < 0) { const t = da / (da - db); if (t > t0) t0 = t; } else if (db < 0) { const t = da / (da - db); if (t < t1) t1 = t; }
    }
    if (t0 > t1) return null;
    const at = (t) => {
      if (t === 0) return a; if (t === 1) return b;
      const vars = new Float64Array(a.vars.length);
      for (let k = 0; k < vars.length; k++) vars[k] = a.vars[k] + (b.vars[k] - a.vars[k]) * t;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, w: a.w + (b.w - a.w) * t, vars, size: a.size };
    };
    return [at(t0), at(t1)];
  }
  function line(ctx, a, b) {
    const seg = clipLine(a, b);
    if (seg === null) return;
    const flat = b;
    const p0 = toWindow(ctx, seg[0], flat), p1 = toWindow(ctx, seg[1], flat);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const hw = 0.5 * 1; // lineWidth is 1 (the only supported width)
    const nx = -dy / len * hw, ny = dx / len * hw;
    // quad corners carry linearly interpolated (screen-space) attributes
    const mk = (p, sx, sy) => ({ x: p.x + sx, y: p.y + sy, z: p.z, iw: p.iw, vw: p.vw, flat: p.flat });
    const c0 = mk(p0, nx, ny), c1 = mk(p1, nx, ny), c2 = mk(p1, -nx, -ny), c3 = mk(p0, -nx, -ny);
    // The perpendicular offset must not change attributes: they depend on the position along the line only.
    rasterTriangle(ctx, c0, c1, c2);
    rasterTriangle(ctx, c0, c2, c3);
  }
  function point(ctx, v) {
    if (!(v.w > EPS_W) || v.x < -v.w || v.x > v.w || v.y < -v.w || v.y > v.w || v.z < -v.w || v.z > v.w) return;
    const p = toWindow(ctx, v, v);
    let size = v.size;
    size = Math.min(Math.max(Number.isFinite(size) ? size : 1, LIM.pointSize[0]), LIM.pointSize[1]);
    const half = size / 2;
    const [rx0, ry0, rx1, ry1] = ctx.rect;
    const minX = Math.max(rx0, Math.floor(p.x - half)), maxX = Math.min(rx1 - 1, Math.ceil(p.x + half) - 1);
    const minY = Math.max(ry0, Math.floor(p.y - half)), maxY = Math.min(ry1 - 1, Math.ceil(p.y + half) - 1);
    const fragCtx = { point: true, p, size, front: true, zoff: 0, flat: v.vars };
    ctx.frag = fragCtx;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const fx = x + 0.5, fy = y + 0.5;
      if (fx < p.x - half || fx >= p.x + half || fy < p.y - half || fy >= p.y + half) continue;
      fragment(ctx, x, y, 0, 0, 0, fragCtx);
    }
  }

  // ---- fragment stage --------------------------------------------------------------------------
  // interpolate attributes at pixel (x, y) given barycentrics (l0 for vertex a, l1 for b, l2 for c)
  function interpolate(ctx, x, y, l0, l1, l2, fc, out) {
    const vl = ctx.vl;
    if (fc.point) {
      const p = fc.p;
      out.z = p.z; out.iw = p.iw;
      const vars = out.vars;
      for (let k = 0; k < vl.total; k++) vars[k] = p.vw[k] / p.iw;
      out.pc = [(x + 0.5 - (p.x - fc.size / 2)) / fc.size, 1 - (y + 0.5 - (p.y - fc.size / 2)) / fc.size];
      return;
    }
    const { a, b, c } = fc;
    out.z = a.z * l0 + b.z * l1 + c.z * l2;
    const iw = a.iw * l0 + b.iw * l1 + c.iw * l2;
    out.iw = iw;
    const vars = out.vars;
    const flat = fc.flat;
    for (const e of vl.list) {
      if (e.flat) { for (let k = 0; k < e.n; k++) vars[e.off + k] = flat[e.off + k]; continue; }
      for (let k = e.off, end = e.off + e.n; k < end; k++) vars[k] = (a.vw[k] * l0 + b.vw[k] * l1 + c.vw[k] * l2) / iw;
    }
    out.pc = [0, 0];
  }
  // barycentrics of an arbitrary pixel position (for derivative probes)
  function baryAt(fc, x, y) {
    const px = (x + 0.5) * SUB, py = (y + 0.5) * SUB;
    const e0 = (fc.cx - fc.bx) * (py - fc.by) - (fc.cy - fc.by) * (px - fc.bx);
    const e1 = (fc.ax - fc.cx) * (py - fc.cy) - (fc.ay - fc.cy) * (px - fc.cx);
    const e2 = (fc.bx - fc.ax) * (py - fc.ay) - (fc.by - fc.ay) * (px - fc.ax);
    return [e0 / fc.ar, e1 / fc.ar, e2 / fc.ar];
  }
  G.baryAt = baryAt;

  // Run the fragment shader at pixel (x,y) with the given interpolation; returns the shader's output state.
  function shade(ctx, x, y, l0, l1, l2, fc, probe) {
    const { lnk, R } = ctx;
    const Gf = lnk.Gf;
    const out = ctx.interpOut || (ctx.interpOut = { vars: new Float64Array(ctx.vl.total), z: 0, iw: 0, pc: [0, 0] });
    interpolate(ctx, x, y, l0, l1, l2, fc, out);
    for (const e of ctx.vl.list) Gf[`v_${e.name}`] = e.build(out.vars, e.off);
    Gf.gl_FragCoord = [x + 0.5, y + 0.5, out.z, out.iw];
    Gf.gl_FrontFacing = fc.front;
    Gf.gl_PointCoord = out.pc;
    Gf.$discard = false;
    if (lnk.version === 100) { Gf.gl_FragColor = [0, 0, 0, 0]; Gf.gl_FragData = Array.from({ length: Math.max(1, ctx.S.exts.has('WEBGL_draw_buffers') ? LIM.maxDrawBuffers : 1) }, () => [0, 0, 0, 0]); } else for (const o of ctx.outputs) Gf[`o_${o.name}`] = zeroValue(o.t);
    Gf.gl_FragDepth = out.z;
    const saveProbe = ctx.probe;
    ctx.probe = probe || null;
    ctx.pix = { x, y, fc };
    R.budget = 4e6;
    lnk.runFS();
    ctx.probe = saveProbe;
    return { z: out.z, depthOut: lnk.fi.usesFragDepth ? Gf.gl_FragDepth : null };
  }
  G.shadeAt = function shadeAt(ctx, x, y, probe) {
    const fc = ctx.pix.fc;
    const savedPix = ctx.pix;
    try {
      if (fc.point) return shade(ctx, x, y, 0, 0, 0, fc, probe);
      const [l0, l1, l2] = baryAt(fc, x, y);
      return shade(ctx, x, y, l0, l1, l2, fc, probe);
    } finally { ctx.pix = savedPix; }
  };

  const cmp = (f, a, b) => {
    switch (f) {
      case C.NEVER: return false; case C.LESS: return a < b; case C.EQUAL: return a === b; case C.LEQUAL: return a <= b;
      case C.GREATER: return a > b; case C.NOTEQUAL: return a !== b; case C.GEQUAL: return a >= b; default: return true;
    }
  };
  G.cmpFunc = cmp;
  function stencilOp(op, cur, ref, max) {
    switch (op) {
      case C.KEEP: return cur; case C.ZERO: return 0; case C.REPLACE: return ref;
      case C.INCR: return cur < max ? cur + 1 : max; case C.DECR: return cur > 0 ? cur - 1 : 0; case C.INVERT: return (~cur) & max;
      case C.INCR_WRAP: return (cur + 1) & max; case C.DECR_WRAP: return (cur - 1) & max; default: return cur;
    }
  }

  function fragment(ctx, x, y, l0, l1, l2, fc) {
    const { S, tgt } = ctx;
    const w = tgt.w;
    const pixIdx = y * w + x;
    // z for the depth test
    let z;
    if (fc.point) z = fc.p.z; else z = fc.a.z * l0 + fc.b.z * l1 + fc.c.z * l2;
    z += fc.zoff;
    z = z < 0 ? 0 : z > 1 ? 1 : z;
    if (ctx.dq) z = Math.round(z * ctx.dq) / ctx.dq;
    const depth = tgt.depth;
    // early depth test
    if (ctx.early) {
      const dz = depth.data[(depth.base + pixIdx) * depth.stride];
      if (!cmp(S.depth.func, z, dz)) return;
    }
    ctx.pix = { x, y, fc };
    let res = null;
    if (!ctx.skipShader) {
      ctx.probeState = null;
      res = shade(ctx, x, y, l0, l1, l2, fc, null);
      if (ctx.lnk.Gf.$discard) return;
      if (res.depthOut !== null) { z = Math.min(Math.max(res.depthOut, 0), 1); if (ctx.dq) z = Math.round(z * ctx.dq) / ctx.dq; }
    }
    const faceIdx = fc.front ? 0 : 1;
    // stencil test
    const st = S.stencil;
    const sten = tgt.stencil;
    let stencilVal = 0, stencilPass = true;
    const sMask = S.stencilMask[faceIdx] & 0xff;
    if (st.enabled && sten) {
      const so = (sten.base + pixIdx) * sten.stride + sten.ch;
      stencilVal = sten.data[so];
      const ref = st.ref[faceIdx] & 0xff, vm = st.vmask[faceIdx] & 0xff;
      stencilPass = cmp(st.func[faceIdx], ref & vm, stencilVal & vm);
      if (!stencilPass) { sten.data[so] = (stencilVal & ~sMask) | (stencilOp(st.fail[faceIdx], stencilVal, ref, 255) & sMask); return; }
    }
    // depth test
    let depthPass = true;
    if (S.depth.enabled && depth && !ctx.early) {
      const dz = depth.data[(depth.base + pixIdx) * depth.stride];
      depthPass = cmp(S.depth.func, z, dz);
    }
    if (st.enabled && sten) {
      const so = (sten.base + pixIdx) * sten.stride + sten.ch;
      const ref = st.ref[faceIdx] & 0xff;
      const nv = stencilOp(depthPass ? st.zpass[faceIdx] : st.zfail[faceIdx], stencilVal, ref, 255);
      sten.data[so] = (stencilVal & ~sMask) | (nv & sMask);
    }
    if (!depthPass) return;
    if (ctx.qAny) ctx.qAny.result++;
    if (S.depth.enabled && depth && S.depthMask) depth.data[(depth.base + pixIdx) * depth.stride] = z;
    else if (!S.depth.enabled && depth && S.depthMask && false) depth.data[(depth.base + pixIdx) * depth.stride] = z;
    // color
    if (!ctx.writeColors || res === null) return;
    writeColors(ctx, pixIdx);
  }

  // sRGB transfer
  const srgbEnc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const srgbDec = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  G.srgbDec = srgbDec;
  function writeColors(ctx, pixIdx) {
    const { S, lnk, tgt } = ctx;
    const Gf = lnk.Gf;
    const nAtt = tgt.colors.length;
    for (let i = 0; i < nAtt; i++) {
      const col = tgt.colors[i];
      if (!col) continue;
      let outv;
      if (lnk.version === 100) {
        if (Gf.gl_FragColor !== undefined && !lnk.fi.usesFragData) outv = i === 0 ? Gf.gl_FragColor : null;
        else outv = Gf.gl_FragData[i] || null;
      } else {
        const o = ctx.outputs.find((q) => i >= q.loc && i < q.loc + q.n);
        if (!o) outv = null; else { const v = Gf[`o_${o.name}`]; const val = o.n > 1 ? v[i - o.loc] : v; outv = typeof val === 'number' ? [val, 0, 0, 1] : val.length === 4 ? val : [val[0], val.length > 1 ? val[1] : 0, val.length > 2 ? val[2] : 0, val.length > 3 ? val[3] : 1]; }
      }
      if (outv === null) continue;
      const f = col.f;
      const d = col.data;
      const o = (col.base + pixIdx) * 4;
      const cm = S.colorMask;
      if (f.integer) {
        for (let k = 0; k < 4; k++) if (cm[k]) d[o + k] = f.store === 'i32' ? outv[k] | 0 : outv[k] >>> 0;
        continue;
      }
      let src = [outv[0], outv[1], outv[2], outv[3]];
      if (ctx.blendOn && !(f.store === 'f32' && false)) {
        const dst = readNorm(col, o);
        src = blend(S.blend, src, dst, f);
      }
      for (let k = 0; k < 4; k++) {
        if (!cm[k]) continue;
        if (col.noAlpha && k === 3) continue;
        let v = src[k];
        if (f.srgb && k < 3) v = srgbEnc(v < 0 ? 0 : v > 1 ? 1 : v);
        d[o + k] = G.colorToStore(f, col.store, v, k);
      }
    }
  }
  function readNorm(col, o) {
    const d = col.data;
    const f = col.f;
    const r = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      let v = d[o + k];
      v = col.store === 'u8' ? v / 255 : col.store === 's8' ? Math.max(v / 127, -1) : v;
      if (f.srgb && k < 3) v = srgbDec(v);
      r[k] = v;
    }
    if (col.noAlpha) r[3] = 1;
    if (f.channels < 4 && !f.lum) { if (f.channels < 4) r[3] = col.store === 'u8' || col.store === 'f32' ? 1 : 1; }
    return r;
  }
  function factor(fn, src, dst, cc, k) {
    switch (fn) {
      case C.ZERO: return 0; case C.ONE: return 1;
      case C.SRC_COLOR: return k === 3 ? src[3] : src[k]; case C.ONE_MINUS_SRC_COLOR: return 1 - src[k];
      case C.DST_COLOR: return dst[k]; case C.ONE_MINUS_DST_COLOR: return 1 - dst[k];
      case C.SRC_ALPHA: return src[3]; case C.ONE_MINUS_SRC_ALPHA: return 1 - src[3];
      case C.DST_ALPHA: return dst[3]; case C.ONE_MINUS_DST_ALPHA: return 1 - dst[3];
      case C.CONSTANT_COLOR: return cc[k]; case C.ONE_MINUS_CONSTANT_COLOR: return 1 - cc[k];
      case C.CONSTANT_ALPHA: return cc[3]; case C.ONE_MINUS_CONSTANT_ALPHA: return 1 - cc[3];
      case C.SRC_ALPHA_SATURATE: return k === 3 ? 1 : Math.min(src[3], 1 - dst[3]);
      default: return 1;
    }
  }
  function blend(b, src, dst, f) {
    const fixed = f.store === 'u8' || f.store === 's8';
    const clampS = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const s = fixed ? src.map(clampS) : src;
    const out = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const rgb = k < 3;
      const eq = rgb ? b.rgb : b.alpha;
      const sf = factor(rgb ? b.srcRGB : b.srcA, s, dst, b.color, k), df = factor(rgb ? b.dstRGB : b.dstA, s, dst, b.color, k);
      let v;
      switch (eq) {
        case C.FUNC_ADD: v = s[k] * sf + dst[k] * df; break;
        case C.FUNC_SUBTRACT: v = s[k] * sf - dst[k] * df; break;
        case C.FUNC_REVERSE_SUBTRACT: v = dst[k] * df - s[k] * sf; break;
        case C2.MIN: v = Math.min(s[k], dst[k]); break;
        default: v = Math.max(s[k], dst[k]); break;
      }
      out[k] = v;
    }
    return out;
  }
})(globalThis.__layer);
