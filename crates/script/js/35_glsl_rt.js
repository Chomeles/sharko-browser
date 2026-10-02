// 35_glsl_rt.js — runtime library (`R`) of the JavaScript the GLSL compiler generates (34_glsl_gen.js):
// operators on vectors and matrices, the built-in functions of GLSL ES 1.00/3.00 and the loop budget.
// Texture access and derivatives are added by 36_glraster.js.
//
// Float precision: shaders run in double precision here; the pipeline rounds to 32 bit (Math.fround)
// where values are stored (varyings, framebuffer, buffers).
(function (L) {
  'use strict';

  const f32 = new Float32Array(1);
  const i32 = new Int32Array(f32.buffer);
  const u32 = new Uint32Array(f32.buffer);

  // IEEE 754 binary16 conversions (packHalf2x16, half-float textures and buffers).
  const f64 = new Float64Array(1);
  const u64 = new Uint32Array(f64.buffer);
  function toHalf(v) {
    f32[0] = v;
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    let exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
    exp = exp - 127 + 15;
    if (exp >= 0x1f) return sign | 0x7c00;
    if (exp <= 0) {
      if (exp < -10) return sign;
      mant = (mant | 0x800000) >> (1 - exp);
      if (mant & 0x1000) mant += 0x2000;
      return sign | (mant >> 13);
    }
    if (mant & 0x1000) { mant += 0x2000; if (mant & 0x800000) { mant = 0; exp++; if (exp >= 0x1f) return sign | 0x7c00; } }
    return sign | (exp << 10) | (mant >> 13);
  }
  function fromHalf(h) {
    const sign = (h & 0x8000) ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) return sign * mant * 5.960464477539063e-8;
    if (exp === 0x1f) return mant ? NaN : sign * Infinity;
    return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
  }
  void f64; void u64;

  const num = (x) => typeof x === 'number';
  function map1(x, f) {
    if (num(x)) return f(x);
    const r = new Array(x.length);
    for (let i = 0; i < x.length; i++) r[i] = f(x[i]);
    return r;
  }
  function map2(a, b, f) {
    if (num(a)) {
      if (num(b)) return f(a, b);
      const r = new Array(b.length);
      for (let i = 0; i < b.length; i++) r[i] = f(a, b[i]);
      return r;
    }
    const r = new Array(a.length);
    if (num(b)) for (let i = 0; i < a.length; i++) r[i] = f(a[i], b);
    else for (let i = 0; i < a.length; i++) r[i] = f(a[i], b[i]);
    return r;
  }
  function map3(a, b, c, f) {
    const n = num(a) ? (num(b) ? (num(c) ? 0 : c.length) : b.length) : a.length;
    if (n === 0 && num(a) && num(b) && num(c)) return f(a, b, c);
    const r = new Array(n);
    for (let i = 0; i < n; i++) r[i] = f(num(a) ? a : a[i], num(b) ? b : b[i], num(c) ? c : c[i]);
    return r;
  }
  const flt = (f) => (x) => map1(x, f);
  const dot = (a, b) => { if (num(a)) return a * b; let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const roundEven = (x) => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; };
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  function det(m, n) {
    if (n === 2) return m[0] * m[3] - m[1] * m[2];
    if (n === 3) return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4]);
    const a = m;
    const s0 = a[0] * a[5] - a[4] * a[1], s1 = a[0] * a[9] - a[8] * a[1], s2 = a[0] * a[13] - a[12] * a[1];
    const s3 = a[4] * a[9] - a[8] * a[5], s4 = a[4] * a[13] - a[12] * a[5], s5 = a[8] * a[13] - a[12] * a[9];
    const c5 = a[10] * a[15] - a[14] * a[11], c4 = a[6] * a[15] - a[14] * a[7], c3 = a[6] * a[11] - a[10] * a[7];
    const c2 = a[2] * a[15] - a[14] * a[3], c1 = a[2] * a[11] - a[10] * a[3], c0 = a[2] * a[7] - a[6] * a[3];
    return s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
  }
  function inverse(m, n) {
    const d = det(m, n);
    const out = new Array(n * n);
    if (n === 2) { out[0] = m[3] / d; out[1] = -m[1] / d; out[2] = -m[2] / d; out[3] = m[0] / d; return out; }
    // Gauss-Jordan on column-major data
    const a = [];
    for (let r = 0; r < n; r++) { a.push([]); for (let c = 0; c < n; c++) a[r].push(m[c * n + r]); for (let c = 0; c < n; c++) a[r].push(r === c ? 1 : 0); }
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      if (a[p][c] === 0) return new Array(n * n).fill(NaN);
      [a[c], a[p]] = [a[p], a[c]];
      const pv = a[c][c];
      for (let k = 0; k < 2 * n; k++) a[c][k] /= pv;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = a[r][c];
        if (f !== 0) for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k];
      }
    }
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[c * n + r] = a[r][n + c];
    return out;
  }

  function cp(x) {
    if (Array.isArray(x)) {
      if (x.length && typeof x[0] === 'object' && x[0] !== null) return x.map(cp);
      return x.slice();
    }
    if (typeof x === 'object' && x !== null) {
      const o = {};
      for (const k in x) o[k] = cp(x[k]);
      return o;
    }
    return x;
  }
  function eq(a, b) {
    if (typeof a !== 'object' || a === null) return a === b;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
      return true;
    }
    for (const k in a) if (!eq(a[k], b[k])) return false;
    return true;
  }
  const cvtBase = (base, x) => (base === 'float' ? +x : base === 'int' ? (Math.trunc(+x) | 0) : base === 'uint' ? (Math.trunc(+x) >>> 0) : x !== 0 && x !== false);

  function makeRuntime() {
    const R = {
      budget: 1e7,
      loopLimit() { R.budget = 1e7; throw new Error('shader loop iteration limit exceeded'); },
      cp, eq, toHalf, fromHalf,
      wI: (x) => map1(x, (v) => v | 0),
      wU: (x) => map1(x, (v) => v >>> 0),
      f2i: (x, u) => (u ? (Math.trunc(x) >>> 0) : (Math.trunc(x) | 0)),
      idiv: (a, b) => (b === 0 ? 0 : (a / b) | 0),
      udiv: (a, b) => (b === 0 ? 0xffffffff : Math.floor(a / b) >>> 0),
      idivv: (a, b, u) => map2(a, b, (x, y) => (y === 0 ? (u ? 0xffffffff : 0) : u ? Math.floor(x / y) >>> 0 : (x / y) | 0)),
      imulv: (a, b, u) => map2(a, b, (x, y) => (u ? Math.imul(x, y) >>> 0 : Math.imul(x, y))),
      imod: (a, b, u) => (b === 0 ? 0 : u ? (a % b) >>> 0 : (a % b) | 0),
      imodv: (a, b, u) => map2(a, b, (x, y) => (y === 0 ? 0 : u ? (x % y) >>> 0 : (x % y) | 0)),
      add: (a, b) => map2(a, b, (x, y) => x + y),
      sub: (a, b) => map2(a, b, (x, y) => x - y),
      mul: (a, b) => map2(a, b, (x, y) => x * y),
      div: (a, b) => map2(a, b, (x, y) => x / y),
      neg: (a) => map1(a, (x) => -x),
      bitv(op, a, b, u) {
        const f = op === '&' ? (x, y) => x & y : op === '|' ? (x, y) => x | y : op === '^' ? (x, y) => x ^ y : op === '<<' ? (x, y) => x << (y & 31) : u ? (x, y) => x >>> (y & 31) : (x, y) => x >> (y & 31);
        return map2(a, b, (x, y) => (u ? f(x, y) >>> 0 : f(x, y) | 0));
      },
      bnot: (a, u) => map1(a, (x) => (u ? ~x >>> 0 : ~x | 0)),
      splat: (n, v) => new Array(n).fill(v),
      ctorV(n, base, args) {
        const out = [];
        for (const a of args) {
          if (typeof a === 'object') { for (let i = 0; i < a.length && out.length < n; i++) out.push(cvtBase(base, a[i])); } else if (out.length < n) out.push(cvtBase(base, a));
        }
        return out;
      },
      matDiag(c, r, v) { const m = new Array(c * r).fill(0); for (let i = 0; i < Math.min(c, r); i++) m[i * r + i] = v; return m; },
      matFromMat(m, mc, mr, c, r) {
        const o = new Array(c * r).fill(0);
        for (let i = 0; i < c; i++) for (let j = 0; j < r; j++) o[i * r + j] = i < mc && j < mr ? m[i * mr + j] : (i === j ? 1 : 0);
        return o;
      },
      mmul(a, b, ac, ar, bc) {
        const o = new Array(bc * ar);
        for (let c = 0; c < bc; c++) for (let r = 0; r < ar; r++) { let s = 0; for (let k = 0; k < ac; k++) s += a[k * ar + r] * b[c * ac + k]; o[c * ar + r] = s; }
        return o;
      },
      mvmul(m, v, c, r) { const o = new Array(r).fill(0); for (let i = 0; i < c; i++) for (let j = 0; j < r; j++) o[j] += m[i * r + j] * v[i]; return o; },
      vmmul(v, m, c, r) { const o = new Array(c); for (let i = 0; i < c; i++) { let s = 0; for (let j = 0; j < r; j++) s += v[j] * m[i * r + j]; o[i] = s; } return o; },
      swz: (a, idx) => idx.map((i) => a[i]),
      swzSet(a, idx, v) { for (let k = 0; k < idx.length; k++) a[idx[k]] = v[k]; return v; },
      col: (m, i, rows) => m.slice(i * rows, (i + 1) * rows),
      setCol(m, i, rows, v) { for (let j = 0; j < rows; j++) m[i * rows + j] = v[j]; return v; },
      transpose(m, c, r) { const o = new Array(c * r); for (let ci = 0; ci < c; ci++) for (let ri = 0; ri < r; ri++) o[ri * c + ci] = m[ci * r + ri]; return o; },
      outer(c, r) { const rows = c.length; const o = new Array(rows * r.length); for (let j = 0; j < r.length; j++) for (let i = 0; i < rows; i++) o[j * rows + i] = c[i] * r[j]; return o; },
      det, inverse,

      radians: flt((x) => x * Math.PI / 180), degrees: flt((x) => x * 180 / Math.PI),
      sin: flt(Math.sin), cos: flt(Math.cos), tan: flt(Math.tan), asin: flt(Math.asin), acos: flt(Math.acos), atan: flt(Math.atan),
      sinh: flt(Math.sinh), cosh: flt(Math.cosh), tanh: flt(Math.tanh), asinh: flt(Math.asinh), acosh: flt(Math.acosh), atanh: flt(Math.atanh),
      exp: flt(Math.exp), log: flt(Math.log), exp2: flt((x) => Math.pow(2, x)), log2: flt(Math.log2), sqrt: flt(Math.sqrt), inversesqrt: flt((x) => 1 / Math.sqrt(x)),
      floor: flt(Math.floor), trunc: flt(Math.trunc), round: flt((x) => Math.floor(x + 0.5)), roundEven: flt(roundEven), ceil: flt(Math.ceil), fract: flt((x) => x - Math.floor(x)),
      abs: flt(Math.abs), sign: flt(sign),
      isnan: flt((x) => x !== x), isinf: flt((x) => x === Infinity || x === -Infinity),
      pow: (a, b) => map2(a, b, Math.pow), atan2: (a, b) => map2(a, b, Math.atan2),
      mod: (a, b) => map2(a, b, (x, y) => x - y * Math.floor(x / y)),
      min: (a, b) => map2(a, b, (x, y) => (y < x ? y : x)), max: (a, b) => map2(a, b, (x, y) => (y > x ? y : x)),
      clamp: (x, lo, hi) => map3(x, lo, hi, (v, l, h) => Math.min(Math.max(v, l), h)),
      mix: (x, y, a) => map3(x, y, a, (p, q, t) => p * (1 - t) + q * t),
      mixB: (x, y, a) => map3(x, y, a, (p, q, t) => (t ? q : p)),
      step: (e, x) => map2(e, x, (ee, xx) => (xx < ee ? 0 : 1)),
      smoothstep: (e0, e1, x) => map3(e0, e1, x, (a, b, v) => { const t = Math.min(Math.max((v - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }),
      length: (a) => (num(a) ? Math.abs(a) : Math.sqrt(dot(a, a))),
      distance: (a, b) => R.length(R.sub(a, b)),
      dot,
      cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
      normalize: (a) => (num(a) ? sign(a) : R.div(a, Math.sqrt(dot(a, a)))),
      faceforward: (n, i, nr) => (dot(nr, i) < 0 ? n : R.neg(n)),
      reflect: (i, n) => R.sub(i, R.mul(n, 2 * dot(n, i))),
      refract(i, n, eta) {
        const d = dot(n, i);
        const k = 1 - eta * eta * (1 - d * d);
        if (k < 0) return num(i) ? 0 : new Array(i.length).fill(0);
        return R.sub(R.mul(i, eta), R.mul(n, eta * d + Math.sqrt(k)));
      },
      lessThan: (a, b) => a.map((x, i) => x < b[i]), lessThanEqual: (a, b) => a.map((x, i) => x <= b[i]),
      greaterThan: (a, b) => a.map((x, i) => x > b[i]), greaterThanEqual: (a, b) => a.map((x, i) => x >= b[i]),
      equal: (a, b) => a.map((x, i) => x === b[i]), notEqual: (a, b) => a.map((x, i) => x !== b[i]),
      any: (a) => a.some(Boolean), all: (a) => a.every(Boolean), notv: (a) => a.map((x) => !x),
      floatBitsToInt: (x) => map1(x, (v) => { f32[0] = v; return i32[0]; }),
      floatBitsToUint: (x) => map1(x, (v) => { f32[0] = v; return u32[0]; }),
      intBitsToFloat: (x) => map1(x, (v) => { i32[0] = v; return f32[0]; }),
      uintBitsToFloat: (x) => map1(x, (v) => { u32[0] = v; return f32[0]; }),
      packSnorm2x16: (v) => ((Math.round(Math.min(Math.max(v[0], -1), 1) * 32767) & 0xffff) | ((Math.round(Math.min(Math.max(v[1], -1), 1) * 32767) & 0xffff) << 16)) >>> 0,
      unpackSnorm2x16: (u) => [Math.max(((u << 16) >> 16) / 32767, -1), Math.max((u >> 16) / 32767, -1)],
      packUnorm2x16: (v) => ((Math.round(Math.min(Math.max(v[0], 0), 1) * 65535)) | (Math.round(Math.min(Math.max(v[1], 0), 1) * 65535) << 16)) >>> 0,
      unpackUnorm2x16: (u) => [(u & 0xffff) / 65535, (u >>> 16) / 65535],
      packHalf2x16: (v) => (toHalf(v[0]) | (toHalf(v[1]) << 16)) >>> 0,
      unpackHalf2x16: (u) => [fromHalf(u & 0xffff), fromHalf(u >>> 16)],
    };
    return R;
  }
  L.glslRuntime = makeRuntime;
  L.toHalf = toHalf;
  L.fromHalf = fromHalf;
})(globalThis.__layer);
