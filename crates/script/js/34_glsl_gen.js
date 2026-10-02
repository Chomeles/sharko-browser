// 34_glsl_gen.js — type checker and JavaScript code generator for GLSL ES 1.00 / 3.00 shaders.
//
// `L.glsl.compile(source, stage, opts)` returns `{ ok, log, info, factory }`. `factory(R, G)` builds the
// shader for one program: `G` is the object holding every global (attributes `a_*`, varyings `v_*`,
// uniforms `u_*`, outputs `o_*`, built-ins `gl_*`), `R` the runtime library of 35_glsl_rt.js. The factory
// returns `run()`: it initialises the private globals and executes `main`.
//
// Value representation: float/int/uint are numbers, bool is a boolean, vecN/ivecN/uvecN/bvecN are arrays,
// matCxR is a flat column-major array, structs are objects (fields `f_<name>`), arrays are arrays.
// Aggregates are copied on store (`R.cp`) unless the expression result is fresh.
(function (L) {
  'use strict';
  const { GlslError, preprocess, lex, parse } = L.glslFront;

  // ---------------------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------------------
  let structs = new Map();
  const tcache = new Map();
  const PFX = { float: '', int: 'i', uint: 'u', bool: 'b' };
  const VEC_RE = /^([ibu]?)vec([234])$/;
  const MAT_RE = /^mat([234])(?:x([234]))?$/;
  const SAMP_RE = /^([iu]?)sampler(2D|3D|Cube|2DArray|2DShadow|CubeShadow|2DArrayShadow)$/;
  const ARR_RE = /^(.+)\[(\d+)\]$/;
  const BASE_OF = { '': 'float', i: 'int', u: 'uint', b: 'bool' };
  const vecName = (base, n) => (n === 1 ? base : `${PFX[base]}vec${n}`);
  const matName = (c, r) => (c === r ? `mat${c}` : `mat${c}x${r}`);

  function info(t) {
    let r = tcache.get(t);
    if (r !== undefined && (r.kind !== 'struct' || structs.get(t) === r.def)) return r;
    let m;
    if (t === 'void') r = { t, kind: 'void' };
    else if (t === 'float' || t === 'int' || t === 'uint' || t === 'bool') r = { t, kind: 'scalar', base: t, n: 1 };
    else if ((m = VEC_RE.exec(t))) r = { t, kind: 'vec', base: BASE_OF[m[1]], n: +m[2] };
    else if ((m = MAT_RE.exec(t))) { const c = +m[1]; const rr = m[2] ? +m[2] : c; r = { t, kind: 'mat', base: 'float', cols: c, rows: rr, n: c * rr }; } else if ((m = SAMP_RE.exec(t))) r = { t, kind: 'sampler', dim: m[2], sbase: BASE_OF[m[1]] };
    else if ((m = ARR_RE.exec(t))) r = { t, kind: 'array', elem: m[1], len: +m[2] };
    else if (structs.has(t)) r = { t, kind: 'struct', def: structs.get(t) };
    else return null;
    tcache.set(t, r);
    return r;
  }
  const isFloatBased = (t) => { const i = info(t); return i !== null && (i.kind === 'scalar' || i.kind === 'vec' || i.kind === 'mat') && i.base === 'float'; };
  const isAggregate = (t) => { const k = info(t).kind; return k === 'vec' || k === 'mat' || k === 'struct' || k === 'array'; };
  const scalarOf = (t) => info(t).base;
  function zeroJS(t) {
    const i = info(t);
    switch (i.kind) {
      case 'scalar': return i.base === 'bool' ? 'false' : '0';
      case 'vec': return `[${new Array(i.n).fill(i.base === 'bool' ? 'false' : '0').join(',')}]`;
      case 'mat': return `[${new Array(i.n).fill('0').join(',')}]`;
      case 'struct': return `{${i.def.fields.map((f) => `f_${f.name}:${zeroJS(f.type)}`).join(',')}}`;
      case 'array': return `Array.from({length:${i.len}},()=>${zeroJS(i.elem)})`;
      default: return 'null';
    }
  }

  // ---------------------------------------------------------------------------------------
  // Compile
  // ---------------------------------------------------------------------------------------
  function compile(source, stage, opts) {
    const o = opts || {};
    let ver = 100;
    try {
      const pp = preprocess(source, { extensions: o.extensions || {} });
      ver = pp.version;
      const ast = parse(lex(pp.text), pp.version);
      const res = generate(ast, stage, pp, o);
      return { ok: true, log: '', info: res.info, factory: res.factory, version: ver };
    } catch (e) {
      if (e instanceof GlslError) return { ok: false, log: `${e.log}\n`, info: null, factory: null, version: ver };
      throw e;
    }
  }

  function generate(ast, stage, pp, o) {
    const es3 = pp.version === 300;
    const isVS = stage === 'vertex';
    const caps = o.caps || {};
    structs = new Map();
    tcache.clear();
    const E = (line, tok, msg) => { throw new GlslError(line, tok, msg); };

    const scopes = [new Map()];
    const glob = scopes[0];
    const funcs = new Map(); // name -> [{ret, params:[{t,dir}], js, body}]
    const lines = [];        // generated function sources
    const initLines = [];    // per-invocation initialisation of private globals
    const constLines = [];   // const globals (evaluated once)
    let uid = 0;
    let temps = [];
    let curFunc = null;
    let loopDepth = 0;
    let defaultFloat = isVS ? 'highp' : null;
    const infoOut = { attributes: [], uniforms: [], varyings: [], outputs: [], structs, version: pp.version, extensions: pp.extensions, usesFragColor: false, usesFragData: false, usesFragDepth: false, usesDiscard: false, usesPointSize: false, usesFragCoord: false, usesPointCoord: false, usesFrontFacing: false };

    const lookup = (name) => { for (let i = scopes.length - 1; i >= 0; i--) { const r = scopes[i].get(name); if (r !== undefined) return r; } return undefined; };
    const declareVar = (name, rec, line) => {
      const sc = scopes[scopes.length - 1];
      if (sc.has(name) && !(sc === glob && sc.get(name).builtin)) E(line, name, 'redefinition');
      sc.set(name, rec);
    };
    const newTemp = () => { const n = `$t${++uid}`; temps.push(n); return n; };

    // ---- builtin variables
    const bv = (name, t, extra) => glob.set(name, Object.assign({ name, t, js: `G.${name}`, builtin: true, kind: 'global' }, extra));
    if (isVS) {
      bv('gl_Position', 'vec4'); bv('gl_PointSize', 'float');
      if (es3) { bv('gl_VertexID', 'int', { ro: true }); bv('gl_InstanceID', 'int', { ro: true }); }
    } else {
      bv('gl_FragCoord', 'vec4', { ro: true }); bv('gl_FrontFacing', 'bool', { ro: true }); bv('gl_PointCoord', 'vec2', { ro: true });
      if (!es3) { bv('gl_FragColor', 'vec4'); bv(`gl_FragData`, `vec4[${caps.maxDrawBuffers || 1}]`); }
      bv('gl_FragDepth', 'float');
      if (!es3 && pp.extensions.includes('GL_EXT_frag_depth')) glob.set('gl_FragDepthEXT', { name: 'gl_FragDepthEXT', t: 'float', js: 'G.gl_FragDepth', builtin: true, kind: 'global' });
    }
    const BCONST = { gl_MaxVertexAttribs: caps.maxVertexAttribs, gl_MaxVertexUniformVectors: caps.maxVertexUniformVectors, gl_MaxVaryingVectors: caps.maxVaryingVectors,
      gl_MaxVertexTextureImageUnits: caps.maxVertexTextureImageUnits, gl_MaxCombinedTextureImageUnits: caps.maxCombinedTextureImageUnits,
      gl_MaxTextureImageUnits: caps.maxTextureImageUnits, gl_MaxFragmentUniformVectors: caps.maxFragmentUniformVectors, gl_MaxDrawBuffers: caps.maxDrawBuffers || 1 };
    for (const k in BCONST) glob.set(k, { name: k, t: 'int', js: String(BCONST[k] | 0), builtin: true, kind: 'const', ro: true, cv: BCONST[k] | 0 });
    if (es3) {
      glob.set('gl_MinProgramTexelOffset', { name: 'gl_MinProgramTexelOffset', t: 'int', js: '-8', builtin: true, kind: 'const', ro: true, cv: -8 });
      glob.set('gl_MaxProgramTexelOffset', { name: 'gl_MaxProgramTexelOffset', t: 'int', js: '7', builtin: true, kind: 'const', ro: true, cv: 7 });
    }

    // ---- type resolution
    const constInt = (e, line) => {
      const r = genExpr(e);
      if (r.cv === undefined || r.t !== 'int' && r.t !== 'uint') E(line, 'array size', 'array size must be a constant integer expression');
      if (r.cv <= 0) E(line, String(r.cv), 'array size must be greater than zero');
      return r.cv;
    };
    function resolveType(t, line) {
      if (typeof t === 'object') {
        const el = resolveType(t.arr, line);
        if (info(el).kind === 'array') E(line, el, 'arrays of arrays are not supported');
        if (!es3 && info(el).kind === 'struct' && false) E(line, el, 'unsupported');
        return `${el}[${constInt(t.len, line)}]`;
      }
      if (info(t) === null) E(line, t, 'undeclared type');
      return t;
    }
    function registerStruct(def) {
      if (structs.has(def.name) && !def.name.startsWith('anon_')) E(def.line, def.name, 'redefinition');
      const fields = [];
      const seen = new Set();
      for (const f of def.fields) {
        if (seen.has(f.name)) E(def.line, f.name, 'duplicate field name in structure');
        seen.add(f.name);
        const ft = resolveType(f.type, def.line);
        fields.push({ name: f.name, type: ft });
      }
      structs.set(def.name, { name: def.name, fields });
      tcache.delete(def.name);
    }

    // ---- expression helpers
    const R = (js, t, extra) => Object.assign({ js, t, fresh: true }, extra);
    const T = (t) => info(t);
    const isNumeric = (t) => { const i = T(t); return (i.kind === 'scalar' || i.kind === 'vec' || i.kind === 'mat') && i.base !== 'bool'; };
    const wrap = (js, base) => (base === 'int' ? `(${js}|0)` : base === 'uint' ? `(${js}>>>0)` : js);
    const wrapV = (js, base) => (base === 'int' ? `R.wI(${js})` : base === 'uint' ? `R.wU(${js})` : js);
    const copyIfNeeded = (r) => (isAggregate(r.t) && !r.fresh ? `R.cp(${r.js})` : r.js);
    const cvName = (t) => t;

    function genBinary(op, a, b, line) {
      const ta = T(a.t), tb = T(b.t);
      const bad = () => E(line, op, `wrong operand types - no operation '${op}' exists that takes a left-hand operand of type '${a.t}' and a right operand of type '${b.t}' (or there is no acceptable conversion)`);
      switch (op) {
        case '+': case '-': case '*': case '/': {
          if (!isNumeric(a.t) || !isNumeric(b.t)) bad();
          if (ta.base !== tb.base) bad();
          const base = ta.base;
          const jsop = op;
          const isInt = base !== 'float';
          if (ta.kind === 'scalar' && tb.kind === 'scalar') {
            if (op === '*' && isInt) return R(base === 'int' ? `Math.imul(${a.js},${b.js})` : `(Math.imul(${a.js},${b.js})>>>0)`, a.t);
            if (op === '/' && isInt) return R(base === 'int' ? `R.idiv(${a.js},${b.js})` : `R.udiv(${a.js},${b.js})`, a.t);
            return R(wrap(`(${a.js}${jsop}${b.js})`, base), a.t);
          }
          if (ta.kind === 'mat' || tb.kind === 'mat') {
            if (op === '*') {
              if (ta.kind === 'mat' && tb.kind === 'mat') {
                if (ta.cols !== tb.rows) bad();
                return R(`R.mmul(${a.js},${b.js},${ta.cols},${ta.rows},${tb.cols})`, matName(tb.cols, ta.rows));
              }
              if (ta.kind === 'mat' && tb.kind === 'vec') {
                if (ta.cols !== tb.n) bad();
                return R(`R.mvmul(${a.js},${b.js},${ta.cols},${ta.rows})`, vecName('float', ta.rows));
              }
              if (ta.kind === 'vec' && tb.kind === 'mat') {
                if (tb.rows !== ta.n) bad();
                return R(`R.vmmul(${a.js},${b.js},${tb.cols},${tb.rows})`, vecName('float', tb.cols));
              }
            }
            if (ta.kind === 'mat' && tb.kind === 'mat' && a.t !== b.t) bad();
            if (ta.kind === 'vec' || tb.kind === 'vec') bad();
            const rt = ta.kind === 'mat' ? a.t : b.t;
            const fn = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }[op];
            return R(`R.${fn}(${a.js},${b.js})`, rt);
          }
          // vector/scalar combos
          if (ta.kind === 'vec' && tb.kind === 'vec' && ta.n !== tb.n) bad();
          const rt = ta.kind === 'vec' ? a.t : b.t;
          const fn = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }[op];
          if (isInt && op === '/') return R(`R.idivv(${a.js},${b.js},${base === 'uint'})`, rt);
          if (isInt && op === '*') return R(`R.imulv(${a.js},${b.js},${base === 'uint'})`, rt);
          return R(wrapV(`R.${fn}(${a.js},${b.js})`, base), rt);
        }
        case '%': {
          if (!(ta.base === 'int' || ta.base === 'uint') || ta.base !== tb.base || ta.kind === 'mat' || tb.kind === 'mat') bad();
          if (ta.kind === 'scalar' && tb.kind === 'scalar') return R(`R.imod(${a.js},${b.js},${ta.base === 'uint'})`, a.t);
          if (ta.kind === 'vec' && tb.kind === 'vec' && ta.n !== tb.n) bad();
          return R(`R.imodv(${a.js},${b.js},${ta.base === 'uint'})`, ta.kind === 'vec' ? a.t : b.t);
        }
        case '<': case '>': case '<=': case '>=':
          if (ta.kind !== 'scalar' || tb.kind !== 'scalar' || ta.base !== tb.base || ta.base === 'bool') bad();
          return R(`(${a.js}${op}${b.js})`, 'bool');
        case '==': case '!=': {
          if (a.t !== b.t || ta.kind === 'sampler' || ta.kind === 'void') bad();
          if (ta.kind === 'scalar') return R(`(${a.js}${op === '==' ? '===' : '!=='}${b.js})`, 'bool');
          return R(`${op === '!=' ? '!' : ''}R.eq(${a.js},${b.js})`, 'bool');
        }
        case '&&': case '||':
          if (a.t !== 'bool' || b.t !== 'bool') bad();
          return R(`(${a.js}${op}${b.js})`, 'bool');
        case '^^':
          if (a.t !== 'bool' || b.t !== 'bool') bad();
          return R(`(${a.js}!==${b.js})`, 'bool');
        case '&': case '|': case '^': case '<<': case '>>': {
          if (!es3) bad();
          if (!(ta.base === 'int' || ta.base === 'uint') || !(tb.base === 'int' || tb.base === 'uint') || ta.kind === 'mat' || tb.kind === 'mat') bad();
          if (op !== '<<' && op !== '>>' && ta.base !== tb.base) bad();
          if (ta.kind === 'scalar' && tb.kind === 'scalar') {
            const js = op === '>>' && ta.base === 'uint' ? `(${a.js}>>>(${b.js}&31))` : `(${a.js}${op}${op === '<<' || op === '>>' ? `(${b.js}&31)` : b.js})`;
            return R(wrap(js, ta.base), a.t);
          }
          if (ta.kind === 'vec' && tb.kind === 'vec' && ta.n !== tb.n) bad();
          return R(`R.bitv(${JSON.stringify(op)},${a.js},${b.js},${ta.base === 'uint'})`, ta.kind === 'vec' ? a.t : b.t);
        }
      }
      return bad();
    }

    function markUse(r) {
      r.used = true;
      switch (r.name) {
        case 'gl_FragCoord': infoOut.usesFragCoord = true; break;
        case 'gl_PointCoord': infoOut.usesPointCoord = true; break;
        case 'gl_FrontFacing': infoOut.usesFrontFacing = true; break;
        case 'gl_PointSize': infoOut.usesPointSize = true; break;
        case 'gl_FragColor': infoOut.usesFragColor = true; break;
        case 'gl_FragData': infoOut.usesFragData = true; break;
        case 'gl_FragDepth': case 'gl_FragDepthEXT': infoOut.usesFragDepth = true; break;
        default: break;
      }
    }

    // ---- lvalues
    function place(n) {
      switch (n.k) {
        case 'id': {
          const r = lookup(n.name);
          if (r === undefined) E(n.line, n.name, 'undeclared identifier');
          if (r.ro || r.kind === 'const' || r.quals && (r.quals.const || r.quals.uniform || r.quals.attribute || (r.quals.in && !r.quals.out))) E(n.line, n.name, 'l-value required (can\'t modify a const/uniform/input)');
          if (r.t && info(r.t).kind === 'sampler') E(n.line, n.name, 'l-value required (can\'t modify a sampler)');
          markUse(r);
          return { js: r.box ? `${r.js}.v` : r.js, t: r.t };
        }
        case 'field': {
          const bt = exprType(n.e);
          const bi = T(bt);
          if (bi.kind === 'struct') {
            const f = bi.def.fields.find((x) => x.name === n.name);
            if (!f) E(n.line, n.name, 'no such field in structure');
            const bp = place(n.e);
            if (bp.swz || bp.col) E(n.line, n.name, 'l-value required');
            return { js: `${bp.js}.f_${n.name}`, t: f.type };
          }
          if (bi.kind === 'vec') {
            const sw = parseSwizzle(n.name, bi.n, n.line);
            const seen = new Set(sw);
            if (seen.size !== sw.length) E(n.line, n.name, 'l-value required (swizzle with repeated components)');
            const bp = place(n.e);
            if (bp.swz || bp.col) E(n.line, n.name, 'l-value required');
            return { swz: sw, base: bp.js, t: sw.length === 1 ? bi.base : vecName(bi.base, sw.length) };
          }
          E(n.line, n.name, 'field selection requires structure or vector on left hand side');
          break;
        }
        case 'index': {
          const bt = exprType(n.e);
          const bi = T(bt);
          const idx = genExpr(n.i);
          if (idx.t !== 'int' && idx.t !== 'uint') E(n.line, '[', 'array index must be an integer');
          const bp = place(n.e);
          if (bp.swz) E(n.line, '[', 'l-value required');
          if (bi.kind === 'vec') return { js: `${bp.js}[${idx.js}]`, t: bi.base };
          if (bi.kind === 'array') return { js: `${bp.js}[${idx.js}]`, t: bi.elem };
          if (bi.kind === 'mat') return { col: true, base: bp.js, idx: idx.js, rows: bi.rows, t: vecName('float', bi.rows) };
          E(n.line, '[', 'left of \'[\' is not of type array, matrix, or vector');
          break;
        }
        default: E(n.line, '', 'l-value required');
      }
      return null;
    }
    function exprType(n) {
      // type of an expression without keeping generated code (side-effect-free re-generation)
      const savedTemps = temps.length;
      const r = genExpr(n);
      temps.length = savedTemps;
      return r.t;
    }
    function parseSwizzle(name, n, line) {
      const sets = ['xyzw', 'rgba', 'stpq'];
      let set = null;
      for (const s of sets) if (s.includes(name[0])) set = s;
      if (set === null || name.length > 4) E(line, name, 'illegal vector field selection');
      const out = [];
      for (const ch of name) {
        const i = set.indexOf(ch);
        if (i < 0) E(line, name, 'illegal vector field selection');
        if (i >= n) E(line, name, 'vector field selection out of range');
        out.push(i);
      }
      return out;
    }
    function storeTo(pl, valueJS, valueType, line, what) {
      if (pl.t !== valueType) E(line, what || '=', `cannot convert from '${valueType}' to '${pl.t}'`);
      if (pl.swz) {
        if (pl.swz.length === 1) return `(${pl.base}[${pl.swz[0]}]=${valueJS})`;
        return `R.swzSet(${pl.base},[${pl.swz.join(',')}],${valueJS})`;
      }
      if (pl.col) return `R.setCol(${pl.base},${pl.idx},${pl.rows},${valueJS})`;
      return `(${pl.js}=${valueJS})`;
    }
    const placeRead = (pl) => {
      if (pl.swz) return pl.swz.length === 1 ? `${pl.base}[${pl.swz[0]}]` : `R.swz(${pl.base},[${pl.swz.join(',')}])`;
      if (pl.col) return `R.col(${pl.base},${pl.idx},${pl.rows})`;
      return pl.js;
    };

    // ---- expressions
    function genExpr(n) {
      switch (n.k) {
        case 'num': {
          if (n.type === 'float') return R(Number.isFinite(n.v) ? String(n.v) : 'Infinity', 'float', { cv: n.v });
          if (n.type === 'uint') return R(String(n.v >>> 0), 'uint', { cv: n.v >>> 0 });
          return R(String(n.v | 0), 'int', { cv: n.v | 0 });
        }
        case 'bool': return R(n.v ? 'true' : 'false', 'bool', { cv: n.v });
        case 'id': {
          const r = lookup(n.name);
          if (r === undefined) E(n.line, n.name, 'undeclared identifier');
          markUse(r);
          if (r.quals && (r.quals.out || r.quals.varying) && !isVS && !(r.quals.in)) { /* writing outputs of the FS is fine */ }
          return { js: r.box ? `${r.js}.v` : r.js, t: r.t, fresh: false, cv: r.cv };
        }
        case 'comma': { const a = genExpr(n.l); const b = genExpr(n.r); return R(`(${a.js},${b.js})`, b.t); }
        case 'cond': {
          const c = genExpr(n.c);
          if (c.t !== 'bool') E(n.line, '?', 'boolean expression expected');
          const a = genExpr(n.a), b = genExpr(n.b);
          if (a.t !== b.t) E(n.line, ':', 'operands of ?: must have the same type');
          return { js: `(${c.js}?${copyIfNeeded(a)}:${copyIfNeeded(b)})`, t: a.t, fresh: true };
        }
        case 'un': {
          const e = genExpr(n.e);
          const ti = T(e.t);
          if (n.op === '!') { if (e.t !== 'bool') E(n.line, '!', 'wrong operand type - no operation \'!\' exists that takes an operand of type \'' + e.t + '\''); return R(`(!${e.js})`, 'bool', { cv: e.cv === undefined ? undefined : !e.cv }); }
          if (n.op === '~') {
            if (!es3 || !(ti.base === 'int' || ti.base === 'uint') || ti.kind === 'mat') E(n.line, '~', 'wrong operand type');
            return R(ti.kind === 'scalar' ? wrap(`(~${e.js})`, ti.base) : `R.bnot(${e.js},${ti.base === 'uint'})`, e.t);
          }
          if (!isNumeric(e.t)) E(n.line, n.op, `wrong operand type - no operation '${n.op}' exists that takes an operand of type '${e.t}'`);
          if (n.op === '+') return { js: e.js, t: e.t, fresh: e.fresh, cv: e.cv };
          if (ti.kind === 'scalar') return R(ti.base === 'float' ? `(-${e.js})` : wrap(`(-${e.js})`, ti.base), e.t, { cv: e.cv === undefined ? undefined : (ti.base === 'float' ? -e.cv : ti.base === 'int' ? -e.cv | 0 : (-e.cv) >>> 0) });
          return R(wrapV(`R.neg(${e.js})`, ti.base), e.t);
        }
        case 'pre': case 'post': {
          const pl = place(n.e);
          const ti = T(pl.t);
          if (!isNumeric(pl.t) || ti.kind === 'mat' && false) E(n.line, n.op, 'wrong operand type');
          const one = { js: '1', t: ti.base === 'float' ? 'float' : ti.base };
          const cur = { js: placeRead(pl), t: pl.t, fresh: false };
          const oneT = ti.kind === 'scalar' ? { js: '1', t: pl.t } : { js: `R.splat(${ti.n || 1},1)`, t: ti.kind === 'vec' ? pl.t : pl.t };
          let bi;
          if (ti.kind === 'scalar') bi = genBinary(n.op === '++' ? '+' : '-', cur, oneT, n.line);
          else if (ti.kind === 'vec') bi = genBinary(n.op === '++' ? '+' : '-', cur, { js: '1', t: ti.base }, n.line);
          else bi = genBinary(n.op === '++' ? '+' : '-', cur, { js: '1', t: 'float' }, n.line);
          if (n.k === 'pre') return R(storeTo(pl, bi.js, bi.t, n.line, n.op), pl.t);
          const t = newTemp();
          return R(`(${t}=${isAggregate(pl.t) ? `R.cp(${cur.js})` : cur.js},${storeTo(pl, bi.js, bi.t, n.line, n.op)},${t})`, pl.t);
        }
        case 'bin': {
          const a = genExpr(n.l);
          const b = genExpr(n.r);
          const r = genBinary(n.op, a, b, n.line);
          if (a.cv !== undefined && b.cv !== undefined && a.t === b.t && (a.t === 'int' || a.t === 'uint') && '+-*'.includes(n.op)) {
            const v = n.op === '+' ? a.cv + b.cv : n.op === '-' ? a.cv - b.cv : Math.imul(a.cv, b.cv);
            r.cv = a.t === 'int' ? v | 0 : v >>> 0;
          } else if (a.cv !== undefined && b.cv !== undefined && a.t === b.t && (a.t === 'int') && n.op === '/' && b.cv !== 0) r.cv = (a.cv / b.cv) | 0;
          return r;
        }
        case 'assign': {
          const pl = place(n.l);
          let rhs = genExpr(n.r);
          if (n.op === '=') {
            return { js: storeTo(pl, copyIfNeeded(rhs), rhs.t, n.line, '='), t: pl.t, fresh: false };
          }
          const op = n.op.slice(0, -1);
          const cur = { js: placeRead(pl), t: pl.t, fresh: false };
          rhs = genBinary(op, cur, rhs, n.line);
          return { js: storeTo(pl, rhs.js, rhs.t, n.line, n.op), t: pl.t, fresh: false };
        }
        case 'field': {
          const e = genExpr(n.e);
          const ti = T(e.t);
          if (ti.kind === 'struct') {
            const f = ti.def.fields.find((x) => x.name === n.name);
            if (!f) E(n.line, n.name, 'no such field in structure');
            return { js: `${e.js}.f_${n.name}`, t: f.type, fresh: false };
          }
          if (ti.kind === 'vec') {
            const sw = parseSwizzle(n.name, ti.n, n.line);
            if (sw.length === 1) return R(`${e.js}[${sw[0]}]`, ti.base);
            const simple = /^[\w$.]+$/.test(e.js);
            return R(simple ? `[${sw.map((i) => `${e.js}[${i}]`).join(',')}]` : `R.swz(${e.js},[${sw.join(',')}])`, vecName(ti.base, sw.length));
          }
          if (ti.kind === 'scalar' && /^[xyzwrgbastpq]+$/.test(n.name)) E(n.line, n.name, 'illegal vector field selection');
          return E(n.line, n.name, 'field selection requires structure or vector on left hand side');
        }
        case 'index': {
          const e = genExpr(n.e);
          const i = genExpr(n.i);
          if (i.t !== 'int' && i.t !== 'uint') E(n.line, '[', 'array index must be an integer');
          const ti = T(e.t);
          if (ti.kind === 'vec') {
            if (i.cv !== undefined && (i.cv < 0 || i.cv >= ti.n)) E(n.line, '[', 'vector index out of range');
            return R(`${e.js}[${i.js}]`, ti.base);
          }
          if (ti.kind === 'array') {
            if (i.cv !== undefined && (i.cv < 0 || i.cv >= ti.len)) E(n.line, '[', 'array index out of range');
            return { js: `${e.js}[${i.js}]`, t: ti.elem, fresh: false };
          }
          if (ti.kind === 'mat') {
            if (i.cv !== undefined && (i.cv < 0 || i.cv >= ti.cols)) E(n.line, '[', 'matrix index out of range');
            return R(`R.col(${e.js},${i.js},${ti.rows})`, vecName('float', ti.rows));
          }
          return E(n.line, '[', 'left of \'[\' is not of type array, matrix, or vector');
        }
        case 'length': {
          const e = genExpr(n.e);
          const ti = T(e.t);
          if (ti.kind === 'array') return R(String(ti.len), 'int', { cv: ti.len });
          if (ti.kind === 'vec') return R(String(ti.n), 'int', { cv: ti.n });
          if (ti.kind === 'mat') return R(String(ti.cols), 'int', { cv: ti.cols });
          return E(n.line, 'length', 'length can only be called on arrays, vectors and matrices');
        }
        case 'call': return genCall(n);
      }
      return E(n.line || 0, n.k, 'unsupported expression');
    }

    const CVT = { float: (x) => `(+${x})`, int: (x) => `(${x}|0)`, uint: (x) => `(${x}>>>0)`, bool: (x) => `(${x}!=0)` };
    function convertScalar(js, from, to) {
      if (from === to) return js;
      if (from === 'bool') return to === 'bool' ? js : to === 'float' ? `(${js}?1:0)` : `(${js}?1:0)`;
      if (to === 'bool') return `(${js}!==0)`;
      if (to === 'float') return js;
      return `R.f2i(${js},${to === 'uint'})`;
    }
    function genCtor(n) {
      const t = resolveType(n.type, n.line);
      const ti = T(t);
      const args = n.args.map(genExpr);
      for (const a of args) if (T(a.t).kind === 'sampler' || T(a.t).kind === 'void') E(n.line, t, 'cannot convert a sampler/void to a constructor argument');
      if (ti.kind === 'array') {
        if (!es3) E(n.line, t, 'array constructors are not supported in GLSL ES 1.00');
        if (args.length !== ti.len) E(n.line, t, 'array constructor needs one argument per element');
        for (const a of args) if (a.t !== ti.elem) E(n.line, t, 'array constructor argument type mismatch');
        return R(`[${args.map(copyIfNeeded).join(',')}]`, t);
      }
      if (ti.kind === 'struct') {
        const fs = ti.def.fields;
        if (args.length !== fs.length) E(n.line, t, 'Number of constructor parameters does not match the number of structure fields');
        const parts = fs.map((f, i) => { if (args[i].t !== f.type) E(n.line, t, 'Structure constructor argument type mismatch'); return `f_${f.name}:${copyIfNeeded(args[i])}`; });
        return R(`{${parts.join(',')}}`, t);
      }
      if (args.length === 0) E(n.line, t, 'constructor: not enough data provided for construction');
      let total = 0;
      for (const a of args) { const ai = T(a.t); if (ai.kind === 'array' || ai.kind === 'struct') E(n.line, t, 'cannot convert nonscalar/vector/matrix to constructor argument'); total += ai.kind === 'mat' ? ai.n : ai.kind === 'vec' ? ai.n : 1; }
      if (ti.kind === 'scalar') {
        const a = args[0];
        if (args.length > 1) E(n.line, t, 'too many arguments');
        const ai = T(a.t);
        const first = ai.kind === 'scalar' ? a.js : `${a.js}[0]`;
        const r = R(convertScalar(first, ai.base, ti.base), t);
        if (a.cv !== undefined && ai.kind === 'scalar') {
          const v = a.cv;
          r.cv = ti.base === 'float' ? +v : ti.base === 'bool' ? v !== 0 : ti.base === 'int' ? Math.trunc(+v) | 0 : Math.trunc(+v) >>> 0;
        }
        return r;
      }
      if (ti.kind === 'vec') {
        const base = ti.base;
        if (args.length === 1 && T(args[0].t).kind === 'scalar') {
          const v = convertScalar(args[0].js, T(args[0].t).base, base);
          return R(`R.splat(${ti.n},${v})`, t);
        }
        if (total < ti.n) E(n.line, t, 'not enough data provided for construction');
        // too many: only allowed when the last argument is not fully used
        let used = 0;
        for (let i = 0; i < args.length; i++) {
          const ai = T(args[i].t);
          const c = ai.kind === 'mat' || ai.kind === 'vec' ? ai.n : 1;
          if (used >= ti.n) E(n.line, t, 'too many arguments');
          used += c;
        }
        if (args.every((a) => T(a.t).kind === 'scalar') && args.length === ti.n) {
          return R(`[${args.map((a) => convertScalar(a.js, T(a.t).base, base)).join(',')}]`, t);
        }
        return R(`R.ctorV(${ti.n},${JSON.stringify(base)},[${args.map((a) => a.js).join(',')}])`, t);
      }
      if (ti.kind === 'mat') {
        if (args.length === 1) {
          const ai = T(args[0].t);
          if (ai.kind === 'scalar') return R(`R.matDiag(${ti.cols},${ti.rows},${convertScalar(args[0].js, ai.base, 'float')})`, t);
          if (ai.kind === 'mat') return R(`R.matFromMat(${args[0].js},${ai.cols},${ai.rows},${ti.cols},${ti.rows})`, t);
        }
        if (total < ti.n) E(n.line, t, 'not enough data provided for construction');
        if (total > ti.n && args.length > 1) { let used = 0; for (const a of args) { if (used >= ti.n) E(n.line, t, 'too many arguments'); const ai = T(a.t); used += ai.kind === 'mat' || ai.kind === 'vec' ? ai.n : 1; } }
        if (args.some((a) => T(a.t).kind === 'mat')) E(n.line, t, 'matrix constructed from matrix and other arguments is not allowed');
        return R(`R.ctorV(${ti.n},"float",[${args.map((a) => a.js).join(',')}])`, t);
      }
      return E(n.line, t, 'cannot construct this type');
    }

    function genCall(n) {
      if (n.ctor) return genCtor(n);
      const args = n.args.map(genExpr);
      const sig = args.map((a) => a.t);
      // user functions
      const cands = funcs.get(n.name);
      if (cands !== undefined) {
        const f = cands.find((c) => c.params.length === sig.length && c.params.every((p, i) => p.t === sig[i]));
        if (f !== undefined) {
          f.used = true;
          const pre = [];
          const post = [];
          const jsArgs = [];
          for (let i = 0; i < args.length; i++) {
            const p = f.params[i];
            if (p.dir === 'in') jsArgs.push(copyIfNeeded(args[i]));
            else {
              const pl = place(n.args[i]);
              const tmp = newTemp();
              pre.push(`${tmp}={v:${p.dir === 'inout' ? `R.cp(${placeRead(pl)})` : zeroJS(p.t)}}`);
              post.push(storeTo(pl, `${tmp}.v`, p.t, n.line));
              jsArgs.push(tmp);
            }
          }
          if (!pre.length) return R(`${f.js}(${jsArgs.join(',')})`, f.ret);
          const rt = newTemp();
          return R(`(${pre.join(',')},${rt}=${f.js}(${jsArgs.join(',')}),${post.join(',')},${rt})`, f.ret);
        }
        if (!BUILTIN_NAMES.has(n.name)) E(n.line, n.name, `no matching overloaded function found: ${n.name}(${sig.join(', ')})`);
      }
      const b = resolveBuiltin(n.name, args, sig, n.line);
      if (b === null) {
        if (!BUILTIN_NAMES.has(n.name)) E(n.line, n.name, 'no matching overloaded function found');
        E(n.line, n.name, `no matching overloaded function found: ${n.name}(${sig.join(', ')})`);
      }
      return b;
    }

    // ---- builtin functions
    const gF = (t) => { const i = T(t); return (i.kind === 'scalar' || i.kind === 'vec') && i.base === 'float'; };
    const gI = (t) => { const i = T(t); return (i.kind === 'scalar' || i.kind === 'vec') && i.base === 'int'; };
    const gU = (t) => { const i = T(t); return (i.kind === 'scalar' || i.kind === 'vec') && i.base === 'uint'; };
    const gB = (t) => { const i = T(t); return (i.kind === 'scalar' || i.kind === 'vec') && i.base === 'bool'; };
    const nOf = (t) => T(t).n;
    const isVec = (t) => T(t).kind === 'vec';
    const F1 = ['radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt', 'floor', 'trunc', 'round', 'roundEven', 'ceil', 'fract'];
    const ES3_ONLY = new Set(['sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'trunc', 'round', 'roundEven', 'isnan', 'isinf', 'transpose', 'determinant', 'inverse', 'outerProduct', 'texture', 'textureLod', 'textureProj', 'texelFetch', 'textureSize', 'textureOffset', 'textureGrad', 'floatBitsToInt', 'floatBitsToUint', 'intBitsToFloat', 'uintBitsToFloat', 'packSnorm2x16', 'unpackSnorm2x16', 'packUnorm2x16', 'unpackUnorm2x16', 'packHalf2x16', 'unpackHalf2x16', 'modf']);
    const ES1_ONLY = new Set(['texture2D', 'texture2DProj', 'texture2DLod', 'texture2DProjLod', 'textureCube', 'textureCubeLod']);
    const BUILTIN_NAMES = new Set([...F1, 'abs', 'sign', 'isnan', 'isinf', 'pow', 'atan', 'mod', 'modf', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'length', 'distance', 'dot', 'cross',
      'normalize', 'faceforward', 'reflect', 'refract', 'matrixCompMult', 'outerProduct', 'transpose', 'determinant', 'inverse', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
      'equal', 'notEqual', 'any', 'all', 'not', 'texture2D', 'texture2DProj', 'texture2DLod', 'texture2DProjLod', 'textureCube', 'textureCubeLod', 'texture', 'textureLod', 'textureProj',
      'texelFetch', 'textureSize', 'textureOffset', 'textureGrad', 'floatBitsToInt', 'floatBitsToUint', 'intBitsToFloat', 'uintBitsToFloat', 'packSnorm2x16', 'unpackSnorm2x16',
      'packUnorm2x16', 'unpackUnorm2x16', 'packHalf2x16', 'unpackHalf2x16', 'dFdx', 'dFdy', 'fwidth']);
    const sameFloat = (sig) => sig.every((t) => t === sig[0]);

    function resolveBuiltin(name, args, sig, line) {
      const n = sig.length;
      const out = (js, t) => R(js, t);
      const call = (fn) => `R.${fn}(${args.map((a) => a.js).join(',')})`;
      if (ES3_ONLY.has(name) && !es3) return null;
      if (ES1_ONLY.has(name) && es3) return null;
      if (F1.includes(name)) return n === 1 && gF(sig[0]) ? out(call(name), sig[0]) : null;
      switch (name) {
        case 'abs': case 'sign':
          return n === 1 && (gF(sig[0]) || (es3 && gI(sig[0]))) ? out(call(name), sig[0]) : null;
        case 'isnan': case 'isinf': return n === 1 && gF(sig[0]) ? out(call(name), vecName('bool', nOf(sig[0]))) : null;
        case 'pow': return n === 2 && gF(sig[0]) && sig[0] === sig[1] ? out(call('pow'), sig[0]) : null;
        case 'atan':
          if (n === 1 && gF(sig[0])) return out(call('atan'), sig[0]);
          return n === 2 && gF(sig[0]) && sig[0] === sig[1] ? out(call('atan2'), sig[0]) : null;
        case 'mod': return n === 2 && gF(sig[0]) && (sig[1] === sig[0] || sig[1] === 'float') ? out(call('mod'), sig[0]) : null;
        case 'modf': return null;
        case 'min': case 'max': {
          if (n !== 2) return null;
          const ok = (g) => g(sig[0]) && (sig[1] === sig[0] || (T(sig[1]).kind === 'scalar' && T(sig[1]).base === T(sig[0]).base && isVec(sig[0])));
          return ok(gF) || (es3 && (ok(gI) || ok(gU))) ? out(call(name), sig[0]) : null;
        }
        case 'clamp': {
          if (n !== 3) return null;
          const ok = (g) => g(sig[0]) && ((sig[1] === sig[0] && sig[2] === sig[0]) || (T(sig[1]).kind === 'scalar' && T(sig[1]).base === T(sig[0]).base && sig[2] === sig[1] && isVec(sig[0])));
          return ok(gF) || (es3 && (ok(gI) || ok(gU))) ? out(call('clamp'), sig[0]) : null;
        }
        case 'mix': {
          if (n !== 3 || !gF(sig[0]) || sig[1] !== sig[0]) return null;
          if (sig[2] === sig[0] || (sig[2] === 'float' && isVec(sig[0]))) return out(call('mix'), sig[0]);
          if (es3 && gB(sig[2]) && nOf(sig[2]) === nOf(sig[0]) && sig[2] !== 'bool' || (es3 && sig[2] === 'bool' && sig[0] === 'float')) return out(call('mixB'), sig[0]);
          return null;
        }
        case 'step': return n === 2 && gF(sig[1]) && (sig[0] === sig[1] || (sig[0] === 'float' && isVec(sig[1]))) ? out(call('step'), sig[1]) : null;
        case 'smoothstep': return n === 3 && gF(sig[2]) && (sig[0] === sig[2] && sig[1] === sig[2] || (sig[0] === 'float' && sig[1] === 'float' && isVec(sig[2]))) ? out(call('smoothstep'), sig[2]) : null;
        case 'length': return n === 1 && gF(sig[0]) ? out(call('length'), 'float') : null;
        case 'distance': return n === 2 && gF(sig[0]) && sig[0] === sig[1] ? out(call('distance'), 'float') : null;
        case 'dot': return n === 2 && gF(sig[0]) && sig[0] === sig[1] ? out(call('dot'), 'float') : null;
        case 'cross': return n === 2 && sig[0] === 'vec3' && sig[1] === 'vec3' ? out(call('cross'), 'vec3') : null;
        case 'normalize': return n === 1 && gF(sig[0]) ? out(call('normalize'), sig[0]) : null;
        case 'faceforward': return n === 3 && gF(sig[0]) && sameFloat(sig) ? out(call('faceforward'), sig[0]) : null;
        case 'reflect': return n === 2 && gF(sig[0]) && sig[0] === sig[1] ? out(call('reflect'), sig[0]) : null;
        case 'refract': return n === 3 && gF(sig[0]) && sig[0] === sig[1] && sig[2] === 'float' ? out(call('refract'), sig[0]) : null;
        case 'matrixCompMult': return n === 2 && T(sig[0]).kind === 'mat' && sig[0] === sig[1] ? out(call('mul'), sig[0]) : null;
        case 'outerProduct': {
          if (n !== 2 || !isVec(sig[0]) || !isVec(sig[1]) || !gF(sig[0]) || !gF(sig[1])) return null;
          return out(`R.outer(${args[0].js},${args[1].js})`, matName(nOf(sig[1]), nOf(sig[0])));
        }
        case 'transpose': {
          if (n !== 1 || T(sig[0]).kind !== 'mat') return null;
          const m = T(sig[0]);
          return out(`R.transpose(${args[0].js},${m.cols},${m.rows})`, matName(m.rows, m.cols));
        }
        case 'determinant': { if (n !== 1 || T(sig[0]).kind !== 'mat' || T(sig[0]).cols !== T(sig[0]).rows) return null; return out(`R.det(${args[0].js},${T(sig[0]).cols})`, 'float'); }
        case 'inverse': { if (n !== 1 || T(sig[0]).kind !== 'mat' || T(sig[0]).cols !== T(sig[0]).rows) return null; return out(`R.inverse(${args[0].js},${T(sig[0]).cols})`, sig[0]); }
        case 'lessThan': case 'lessThanEqual': case 'greaterThan': case 'greaterThanEqual': {
          if (n !== 2 || !isVec(sig[0]) || sig[0] !== sig[1] || gB(sig[0])) return null;
          return out(call(name), vecName('bool', nOf(sig[0])));
        }
        case 'equal': case 'notEqual': {
          if (n !== 2 || !isVec(sig[0]) || sig[0] !== sig[1]) return null;
          return out(call(name), vecName('bool', nOf(sig[0])));
        }
        case 'any': case 'all': return n === 1 && isVec(sig[0]) && gB(sig[0]) ? out(call(name), 'bool') : null;
        case 'not': return n === 1 && isVec(sig[0]) && gB(sig[0]) ? out(call('notv'), sig[0]) : null;
        case 'floatBitsToInt': case 'floatBitsToUint': return n === 1 && gF(sig[0]) ? out(call(name), vecName(name === 'floatBitsToInt' ? 'int' : 'uint', nOf(sig[0]))) : null;
        case 'intBitsToFloat': return n === 1 && gI(sig[0]) ? out(call(name), vecName('float', nOf(sig[0]))) : null;
        case 'uintBitsToFloat': return n === 1 && gU(sig[0]) ? out(call(name), vecName('float', nOf(sig[0]))) : null;
        case 'packSnorm2x16': case 'packUnorm2x16': case 'packHalf2x16': return n === 1 && sig[0] === 'vec2' ? out(call(name), 'uint') : null;
        case 'unpackSnorm2x16': case 'unpackUnorm2x16': case 'unpackHalf2x16': return n === 1 && sig[0] === 'uint' ? out(call(name), 'vec2') : null;
        case 'dFdx': case 'dFdy': case 'fwidth':
          if (isVS) return null;
          if (!(es3 || pp.extensions.includes('GL_OES_standard_derivatives'))) return null;
          return n === 1 && gF(sig[0]) ? out(call(name), sig[0]) : null;
        default: break;
      }
      // texture functions
      return resolveTexture(name, args, sig, line);
    }
    function resolveTexture(name, args, sig, line) {
      const n = sig.length;
      const si = n > 0 ? T(sig[0]) : null;
      if (!si || si.kind !== 'sampler') return null;
      const dim = si.dim;
      const shadow = dim.endsWith('Shadow');
      const cdim = { '2D': 2, '3D': 3, Cube: 3, '2DArray': 3, '2DShadow': 3, CubeShadow: 4, '2DArrayShadow': 4 }[dim];
      const retT = shadow ? 'float' : vecName(si.sbase, 4);
      const coordT = vecName('float', cdim);
      const a = (i) => args[i].js;
      const lodOk = isVS || es3 || false;
      const mk = (fn, extra) => R(`R.${fn}(${a(0)},${extra})`, retT);
      switch (name) {
        case 'texture2D': if (dim === '2D' && n >= 2 && n <= 3 && sig[1] === 'vec2' && (n === 2 || (!isVS && sig[2] === 'float'))) return mk('texture', `${a(1)},${n === 3 ? a(2) : 'undefined'}`); return null;
        case 'textureCube': if (dim === 'Cube' && n >= 2 && n <= 3 && sig[1] === 'vec3' && (n === 2 || (!isVS && sig[2] === 'float'))) return mk('texture', `${a(1)},${n === 3 ? a(2) : 'undefined'}`); return null;
        case 'texture2DProj': if (dim === '2D' && n >= 2 && n <= 3 && (sig[1] === 'vec3' || sig[1] === 'vec4') && (n === 2 || (!isVS && sig[2] === 'float'))) return mk('textureProj', `${a(1)},${n === 3 ? a(2) : 'undefined'}`); return null;
        case 'texture2DLod': if (dim === '2D' && isVS && n === 3 && sig[1] === 'vec2' && sig[2] === 'float') return mk('textureLod', `${a(1)},${a(2)}`); return null;
        case 'textureCubeLod': if (dim === 'Cube' && isVS && n === 3 && sig[1] === 'vec3' && sig[2] === 'float') return mk('textureLod', `${a(1)},${a(2)}`); return null;
        case 'texture2DProjLod': return null;
        case 'texture':
          if (n >= 2 && n <= 3 && sig[1] === coordT && (n === 2 || (!isVS && sig[2] === 'float' && !(dim === 'CubeShadow' || dim === '2DArrayShadow')))) return mk('texture', `${a(1)},${n === 3 ? a(2) : 'undefined'}`);
          return null;
        case 'textureProj':
          if (dim === '2D' && n >= 2 && n <= 3 && (sig[1] === 'vec3' || sig[1] === 'vec4')) return mk('textureProj', `${a(1)},${n === 3 ? a(2) : 'undefined'}`);
          if (dim === '2DShadow' && n === 2 && sig[1] === 'vec4') return mk('textureProj', `${a(1)},undefined`);
          if (dim === '3D' && n >= 2 && n <= 3 && sig[1] === 'vec4') return mk('textureProj', `${a(1)},${n === 3 ? a(2) : 'undefined'}`);
          return null;
        case 'textureLod': if (n === 3 && sig[1] === coordT && sig[2] === 'float' && lodOk) return mk('textureLod', `${a(1)},${a(2)}`); return null;
        case 'textureOffset': {
          const offT = dim === '3D' ? 'ivec3' : 'ivec2';
          if ((dim === '2D' || dim === '3D' || dim === '2DShadow' || dim === '2DArray' || dim === '2DArrayShadow') && n >= 3 && n <= 4 && sig[1] === coordT && sig[2] === (dim === '3D' ? 'ivec3' : 'ivec2') && (n === 3 || sig[3] === 'float')) return mk('textureOffset', `${a(1)},${a(2)},${n === 4 ? a(3) : 'undefined'}`);
          void offT;
          return null;
        }
        case 'textureGrad': {
          const gT = dim === 'Cube' ? 'vec3' : dim === '3D' ? 'vec3' : 'vec2';
          if (n === 4 && sig[1] === coordT && sig[2] === gT && sig[3] === gT) return mk('textureGrad', `${a(1)},${a(2)},${a(3)}`);
          return null;
        }
        case 'texelFetch': {
          const pT = dim === '2D' ? 'ivec2' : dim === '3D' || dim === '2DArray' ? 'ivec3' : null;
          if (pT !== null && n === 3 && sig[1] === pT && sig[2] === 'int') return mk('texelFetch', `${a(1)},${a(2)}`);
          return null;
        }
        case 'textureSize': {
          if (n !== 2 || sig[1] !== 'int') return null;
          const rt = dim === '2D' || dim === 'Cube' || dim === '2DShadow' || dim === 'CubeShadow' ? 'ivec2' : 'ivec3';
          return R(`R.textureSize(${a(0)},${a(1)})`, rt);
        }
        default: return null;
      }
    }

    // ---- statements
    function genBlockBody(stmts) { return stmts.map(genStmt).join('\n'); }
    function declLocal(d, line) {
      const rt = resolveType(d.type, d.line);
      const ti = T(rt);
      if (ti.kind === 'void') E(d.line, d.name, 'illegal use of type \'void\'');
      if (isFloatBased(rt) || (ti.kind === 'array' && isFloatBased(ti.elem)) || ti.kind === 'struct') {
        if (isFloatBased(rt) && !d.quals.precision && defaultFloat === null) E(d.line, d.name, 'No precision specified for (float)');
      }
      let init = null;
      let cv;
      if (d.init) {
        const r = genExpr(d.init);
        if (r.t !== rt) E(d.line, d.name, `cannot convert from '${r.t}' to '${rt}'`);
        init = copyIfNeeded(r);
        if (d.quals.const) cv = r.cv;
      } else if (d.quals.const) E(d.line, d.name, 'variables with qualifier \'const\' must be initialized');
      const js = `l_${d.name}_${++uid}`;
      const rec = { name: d.name, t: rt, js, kind: 'local', quals: d.quals, cv };
      declareVar(d.name, rec, d.line);
      void line;
      return `let ${js}=${init !== null ? init : zeroJS(rt)};`;
    }
    const tick = () => 'if(--R.budget<0)R.loopLimit();';
    function genStmt(s) {
      switch (s.k) {
        case 'empty': return '';
        case 'block': {
          scopes.push(new Map());
          const body = genBlockBody(s.body);
          scopes.pop();
          return `{${body}}`;
        }
        case 'decl': {
          let out = '';
          for (const d of s.decls) {
            if (d.k === 'struct') { registerStruct(d); continue; }
            out += declLocal(d, s.line);
          }
          return out;
        }
        case 'expr': return `${genExpr(s.e).js};`;
        case 'if': {
          const c = genExpr(s.c);
          if (c.t !== 'bool') E(s.line, 'if', 'boolean expression expected');
          scopes.push(new Map());
          const a = genStmt(s.a);
          scopes.pop();
          let b = '';
          if (s.b) { scopes.push(new Map()); b = `else{${genStmt(s.b)}}`; scopes.pop(); }
          return `if(${c.js}){${a}}${b}`;
        }
        case 'for': {
          scopes.push(new Map());
          let init = '';
          if (s.init) init = s.init.k === 'decl' ? genStmt(s.init).replace(/;$/, '') : `${genExpr(s.init.e).js}`;
          let cond = '';
          if (s.cond) { const c = genExpr(s.cond); if (c.t !== 'bool') E(s.line, 'for', 'boolean expression expected'); cond = c.js; }
          const iter = s.iter ? genExpr(s.iter).js : '';
          loopDepth++;
          scopes.push(new Map());
          const body = genStmt(s.body);
          scopes.pop();
          loopDepth--;
          scopes.pop();
          return `for(${init};${cond};${iter}){${tick()}${body}}`;
        }
        case 'while': {
          scopes.push(new Map());
          let pre = '';
          let cond;
          if (s.cond.decl) { pre = genStmt({ k: 'decl', decls: s.cond.decl, line: s.line }); const dd = s.cond.decl[0]; cond = lookup(dd.name).js; } else { const c = genExpr(s.cond); if (c.t !== 'bool') E(s.line, 'while', 'boolean expression expected'); cond = c.js; }
          loopDepth++;
          const body = genStmt(s.body);
          loopDepth--;
          scopes.pop();
          return pre ? `{${pre}while(${cond}){${tick()}${body}}}` : `while(${cond}){${tick()}${body}}`;
        }
        case 'dowhile': {
          loopDepth++;
          scopes.push(new Map());
          const body = genStmt(s.body);
          scopes.pop();
          loopDepth--;
          const c = genExpr(s.cond);
          if (c.t !== 'bool') E(s.line, 'while', 'boolean expression expected');
          return `do{${tick()}${body}}while(${c.js});`;
        }
        case 'switch': {
          const e = genExpr(s.e);
          if (e.t !== 'int' && e.t !== 'uint') E(s.line, 'switch', 'init-expression in a switch statement must be a scalar integer');
          let out = `switch(${e.js}){`;
          loopDepth++;
          scopes.push(new Map());
          for (const c of s.cases) {
            if (c.test === null) out += 'default:'; else { const t = genExpr(c.test); if (t.cv === undefined || t.t !== e.t) E(s.line, 'case', 'case label must be a constant integer of the same type'); out += `case ${t.js}:`; }
            out += c.body.map(genStmt).join('');
          }
          scopes.pop();
          loopDepth--;
          return `${out}}`;
        }
        case 'return': {
          if (curFunc === null) E(s.line, 'return', 'unexpected return');
          if (s.e) {
            const r = genExpr(s.e);
            if (curFunc.ret === 'void') E(s.line, 'return', 'void function cannot return a value');
            if (r.t !== curFunc.ret) E(s.line, 'return', `function return is not matching type`);
            return `return ${copyIfNeeded(r)};`;
          }
          if (curFunc.ret !== 'void') E(s.line, 'return', 'non-void function must return a value');
          return 'return;';
        }
        case 'break': if (loopDepth === 0) E(s.line, 'break', 'break statement only allowed in loops and switch'); return 'break;';
        case 'continue': if (loopDepth === 0) E(s.line, 'continue', 'continue statement only allowed in loops'); return 'continue;';
        case 'discard': if (isVS) E(s.line, 'discard', 'discard statement only allowed in fragment shaders'); infoOut.usesDiscard = true; return 'G.$discard=true;';
      }
      return E(s.line || 0, s.k, 'unsupported statement');
    }

    // ---- translation unit
    for (const d of ast.decls) {
      switch (d.k) {
        case 'precision': {
          if (d.type === 'float') defaultFloat = d.prec;
          break;
        }
        case 'struct': registerStruct(d); break;
        case 'var': {
          const q = d.quals;
          const rt = resolveType(d.type, d.line);
          const ti = T(rt);
          if (ti.kind === 'void') E(d.line, d.name, 'illegal use of type \'void\'');
          const kinds = ['uniform', 'attribute', 'varying', 'in', 'out'].filter((k) => q[k]);
          if (kinds.length > 1 && !(q.in && q.out)) E(d.line, d.name, 'invalid qualifier combination');
          if (ti.kind === 'sampler' && !q.uniform) E(d.line, d.name, 'samplers can only be declared as uniforms or function parameters');
          if (isFloatBased(rt) || (ti.kind === 'array' && isFloatBased(ti.elem))) {
            if (!q.precision && defaultFloat === null) E(d.line, d.name, 'No precision specified for (float)');
          }
          if (q.uniform) {
            if (d.init) E(d.line, d.name, 'uniforms cannot have initializers (ES 1.00/3.00)');
            const rec = { name: d.name, t: rt, js: `G.u_${d.name}`, kind: 'global', quals: q, used: false };
            declareVar(d.name, rec, d.line);
            infoOut.uniforms.push(rec);
          } else if (q.attribute || (q.in && isVS)) {
            if (!isVS) E(d.line, d.name, 'attribute only allowed in vertex shaders');
            if (ti.kind === 'struct' || ti.kind === 'array' && es3 === false || ti.base === 'bool') E(d.line, d.name, 'attributes cannot have this type');
            const rec = { name: d.name, t: rt, js: `G.a_${d.name}`, kind: 'global', quals: Object.assign({}, q, { in: true }), used: false, location: q.layout && q.layout.location };
            declareVar(d.name, rec, d.line);
            infoOut.attributes.push(rec);
          } else if (q.varying || q.out && isVS || q.in && !isVS) {
            if (d.init) E(d.line, d.name, 'varyings cannot have initializers');
            const input = !isVS && (q.in || q.varying);
            const rec = { name: d.name, t: rt, js: `G.v_${d.name}`, kind: 'global', quals: Object.assign({}, q, input ? { in: true } : { out: true }), used: false, flat: !!q.flat, centroid: !!q.centroid };
            declareVar(d.name, rec, d.line);
            infoOut.varyings.push(Object.assign(rec, { dir: input ? 'in' : 'out' }));
          } else if (q.out && !isVS) {
            if (!es3) E(d.line, d.name, 'out qualifier not supported in GLSL ES 1.00');
            const rec = { name: d.name, t: rt, js: `G.o_${d.name}`, kind: 'global', quals: Object.assign({}, q, { out: true }), used: false, location: q.layout && q.layout.location !== undefined ? q.layout.location : undefined };
            declareVar(d.name, rec, d.line);
            infoOut.outputs.push(rec);
          } else if (q.const) {
            if (!d.init) E(d.line, d.name, 'variables with qualifier \'const\' must be initialized');
            const r = genExpr(d.init);
            if (r.t !== rt) E(d.line, d.name, `cannot convert from '${r.t}' to '${rt}'`);
            const js = `c_${d.name}_${++uid}`;
            constLines.push(`const ${js}=${copyIfNeeded(r)};`);
            declareVar(d.name, { name: d.name, t: rt, js, kind: 'global', quals: q, cv: r.cv, ro: true }, d.line);
          } else {
            const js = `G.p_${d.name}`;
            let init = zeroJS(rt);
            if (d.init) {
              const r = genExpr(d.init);
              if (r.t !== rt) E(d.line, d.name, `cannot convert from '${r.t}' to '${rt}'`);
              init = copyIfNeeded(r);
            }
            initLines.push(`${js}=${init};`);
            declareVar(d.name, { name: d.name, t: rt, js, kind: 'global', quals: q }, d.line);
          }
          break;
        }
        case 'func': {
          const params = d.params.map((p) => ({ t: resolveType(p.type, d.line), dir: p.dir, name: p.name }));
          const ret = resolveType(d.ret, d.line);
          if (d.name === 'main') {
            if (ret !== 'void' || params.length) E(d.line, 'main', 'function \'main\' is not allowed to have parameters / must return void');
          }
          if (d.name.startsWith('gl_')) E(d.line, d.name, 'function names starting with "gl_" are reserved');
          let list = funcs.get(d.name);
          if (list === undefined) { list = []; funcs.set(d.name, list); }
          let f = list.find((c) => c.params.length === params.length && c.params.every((p, i) => p.t === params[i].t));
          if (f === undefined) {
            f = { ret, params, js: `f_${d.name}_${list.length}`, body: false, used: d.name === 'main' };
            list.push(f);
          } else if (f.ret !== ret) E(d.line, d.name, 'overloaded functions must have the same return type');
          if (d.body === null) break;
          if (f.body) E(d.line, d.name, 'function already has a body');
          f.body = true;
          curFunc = f;
          temps = [];
          scopes.push(new Map());
          const pn = [];
          params.forEach((p, i) => {
            const pdef = d.params[i];
            if (isFloatBased(p.t) && defaultFloat === null) E(d.line, pdef.name || 'param', 'No precision specified for (float)');
            const js = `p_${p.name || 'unnamed'}_${++uid}`;
            pn.push(js);
            if (p.name) declareVar(p.name, { name: p.name, t: p.t, js, kind: 'param', box: p.dir !== 'in', quals: {} }, d.line);
          });
          const body = genBlockBody(d.body.body);
          scopes.pop();
          lines.push(`function ${f.js}(${pn.join(',')}){${temps.length ? `let ${temps.join(',')};` : ''}${body}}`);
          curFunc = null;
          break;
        }
      }
    }
    const mainList = funcs.get('main');
    if (!mainList || !mainList.some((f) => f.body)) E(1, 'main', 'Missing main()');
    if (!isVS && es3 && infoOut.outputs.length === 0 && !infoOut.usesFragDepth) { /* a fragment shader without outputs is legal */ }
    if (!isVS && es3 && infoOut.usesFragColor) E(1, 'gl_FragColor', 'undeclared identifier');
    if (!isVS && !es3 && infoOut.usesFragColor && infoOut.usesFragData) E(1, 'gl_FragData', 'gl_FragColor and gl_FragData cannot both be used in a shader');

    infoOut.uniformLeaves = [];
    const leavesOf = (t, name, path, out, rec) => {
      const i = info(t);
      if (i.kind === 'struct') for (const f of i.def.fields) leavesOf(f.type, `${name}.${f.name}`, path.concat(`f_${f.name}`), out, rec);
      else if (i.kind === 'array') {
        const ek = info(i.elem).kind;
        if (ek === 'struct') for (let k = 0; k < i.len; k++) leavesOf(i.elem, `${name}[${k}]`, path.concat(k), out, rec);
        else out.push({ name: `${name}[0]`, baseName: name, t: i.elem, path, size: i.len, isArray: true, rec });
      } else out.push({ name, baseName: name, t, path, size: 1, isArray: false, rec });
    };
    for (const u of infoOut.uniforms) leavesOf(u.t, u.name, [`u_${u.name}`], infoOut.uniformLeaves, u);
    const code = `${constLines.join('\n')}\nfunction $init(){${initLines.join('')}}\n${lines.join('\n')}\nreturn function(){$init();${mainList.find((f) => f.body).js}();};`;
    const factory = new Function('R', 'G', `'use strict';${code}`);
    infoOut.src = code;
    return { info: infoOut, factory: (rt, g) => factory(rt, g) };
  }

  L.glsl = { compile, info: (t) => info(t), vecName, matName, zeroJS: (t) => zeroJS(t) };
})(globalThis.__layer);
