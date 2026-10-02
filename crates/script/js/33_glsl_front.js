// 33_glsl_front.js — GLSL ES 1.00 / 3.00 front end for the WebGL implementation: comment stripping,
// the preprocessor (#define incl. function-like macros, #if/#ifdef/#elif/#else, #extension, #version),
// the lexer and a recursive-descent parser producing a small AST. 34_glsl_gen.js type-checks it and
// generates JavaScript, 36_webgl.js runs that in a software pipeline.
//
// Error messages imitate ANGLE's info log: `ERROR: 0:<line>: '<token>' : <message>`.
(function (L) {
  'use strict';

  class GlslError extends Error {
    constructor(line, tok, msg) { super(msg); this.line = line; this.tok = tok; }
    get log() { return `ERROR: 0:${this.line}: '${this.tok}' : ${this.message}`; }
  }

  // ---------------------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------------------
  function stripComments(src) {
    let out = '';
    const n = src.length;
    for (let i = 0; i < n;) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
      } else if (c === '/' && src[i + 1] === '*') {
        i += 2;
        let nl = '';
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') nl += '\n'; i++; }
        i += 2;
        out += ' ' + nl;
      } else { out += c; i++; }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // Preprocessor
  // ---------------------------------------------------------------------------------------
  const NUM_RE = /^(?:0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFuU]?)/;
  const ID_RE = /^[A-Za-z_]\w*/;

  function preprocess(source, opts) {
    const supportedExt = opts.extensions || {};
    const macros = new Map();
    macros.set('GL_ES', { body: '1' });
    macros.set('__LINE__', { dyn: true });
    macros.set('__FILE__', { body: '0' });
    macros.set('__VERSION__', { body: '100' });
    macros.set('GL_FRAGMENT_PRECISION_HIGH', { body: '1' });
    const extStates = [];
    let version = 100;
    const lines = stripComments(source.replace(/\r\n?/g, '\n').replace(/\\\n/g, ' ')).split('\n');
    const out = [];
    const stack = []; // {active, taken, parentActive}
    let active = true;
    let lineNo = 0;
    let sawCode = false;

    function expand(text, disabled, depth) {
      if (depth > 64) return text;
      let res = '';
      let i = 0;
      while (i < text.length) {
        const c = text[i];
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
          const m = NUM_RE.exec(text.slice(i));
          const tok = m ? m[0] : c;
          res += tok; i += tok.length;
          continue;
        }
        if (/[A-Za-z_]/.test(c)) {
          const id = ID_RE.exec(text.slice(i))[0];
          i += id.length;
          const mac = macros.get(id);
          if (mac === undefined || disabled.has(id)) { res += id; continue; }
          if (mac.dyn) { res += String(lineNo); continue; }
          if (!mac.params) {
            const d = new Set(disabled); d.add(id);
            res += expand(mac.body, d, depth + 1);
            continue;
          }
          let j = i;
          while (j < text.length && /\s/.test(text[j])) j++;
          if (text[j] !== '(') { res += id; continue; }
          // collect arguments
          j++;
          const args = [];
          let cur = '';
          let lvl = 0;
          let closed = false;
          for (; j < text.length; j++) {
            const ch = text[j];
            if (ch === '(') { lvl++; cur += ch; } else if (ch === ')') {
              if (lvl === 0) { closed = true; j++; break; }
              lvl--; cur += ch;
            } else if (ch === ',' && lvl === 0) { args.push(cur); cur = ''; } else cur += ch;
          }
          if (!closed) throw new GlslError(lineNo, id, 'unterminated macro invocation');
          if (args.length || cur.trim() !== '' || mac.params.length) args.push(cur);
          if (args.length !== mac.params.length) throw new GlslError(lineNo, id, 'Invalid number of macro arguments');
          const ea = args.map((a) => expand(a.trim(), disabled, depth + 1));
          let body = '';
          for (let k = 0; k < mac.body.length;) {
            const cc = mac.body[k];
            if (/[A-Za-z_]/.test(cc)) {
              const bid = ID_RE.exec(mac.body.slice(k))[0];
              k += bid.length;
              const pi = mac.params.indexOf(bid);
              body += pi >= 0 ? ea[pi] : bid;
            } else if (/[0-9]/.test(cc)) {
              const m = NUM_RE.exec(mac.body.slice(k));
              const tok = m ? m[0] : cc;
              body += tok; k += tok.length;
            } else { body += cc; k++; }
          }
          const d = new Set(disabled); d.add(id);
          res += expand(body, d, depth + 1);
          i = j;
          continue;
        }
        res += c; i++;
      }
      return res;
    }

    function evalCond(text) {
      // defined X / defined(X)
      let t = text.replace(/\bdefined\s*\(\s*([A-Za-z_]\w*)\s*\)|\bdefined\s+([A-Za-z_]\w*)/g, (m, a, b) => (macros.has(a || b) ? ' 1 ' : ' 0 '));
      t = expand(t, new Set(), 0);
      const toks = [];
      let i = 0;
      while (i < t.length) {
        const c = t[i];
        if (/\s/.test(c)) { i++; continue; }
        if (/[0-9]/.test(c)) { const m = NUM_RE.exec(t.slice(i)); toks.push(['n', parseInt(m[0].replace(/[uU]$/, ''), /^0[xX]/.test(m[0]) ? 16 : /^0\d/.test(m[0]) ? 8 : 10) | 0]); i += m[0].length; continue; }
        if (/[A-Za-z_]/.test(c)) { const id = ID_RE.exec(t.slice(i))[0]; toks.push(['n', 0]); i += id.length; continue; }
        const two = t.slice(i, i + 2);
        if (['&&', '||', '==', '!=', '<=', '>=', '<<', '>>'].includes(two)) { toks.push(['p', two]); i += 2; continue; }
        toks.push(['p', c]); i++;
      }
      let p = 0;
      const peek = () => (toks[p] ? toks[p][1] : null);
      const prim = () => {
        const tk = toks[p++];
        if (!tk) throw new GlslError(lineNo, '', 'invalid preprocessor expression');
        if (tk[0] === 'n') return tk[1];
        if (tk[1] === '(') { const v = lor(); p++; return v; }
        if (tk[1] === '!') return prim() ? 0 : 1;
        if (tk[1] === '-') return -prim() | 0;
        if (tk[1] === '+') return prim();
        if (tk[1] === '~') return ~prim();
        throw new GlslError(lineNo, tk[1], 'invalid preprocessor expression');
      };
      const bin = (next, ops) => () => {
        let v = next();
        while (toks[p] && toks[p][0] === 'p' && ops.includes(toks[p][1])) {
          const op = toks[p++][1]; const r = next();
          switch (op) {
            case '*': v = Math.imul(v, r); break;
            case '/': if (r === 0) throw new GlslError(lineNo, '/', 'Division by zero in preprocessor expression'); v = (v / r) | 0; break;
            case '%': if (r === 0) throw new GlslError(lineNo, '%', 'Division by zero in preprocessor expression'); v %= r; break;
            case '+': v = (v + r) | 0; break; case '-': v = (v - r) | 0; break;
            case '<<': v <<= r; break; case '>>': v >>= r; break;
            case '<': v = v < r ? 1 : 0; break; case '>': v = v > r ? 1 : 0; break;
            case '<=': v = v <= r ? 1 : 0; break; case '>=': v = v >= r ? 1 : 0; break;
            case '==': v = v === r ? 1 : 0; break; case '!=': v = v !== r ? 1 : 0; break;
            case '&': v &= r; break; case '^': v ^= r; break; case '|': v |= r; break;
            case '&&': v = v && r ? 1 : 0; break; case '||': v = v || r ? 1 : 0; break;
          }
        }
        return v;
      };
      const mul = bin(prim, ['*', '/', '%']);
      const add = bin(mul, ['+', '-']);
      const sh = bin(add, ['<<', '>>']);
      const rel = bin(sh, ['<', '>', '<=', '>=']);
      const eq = bin(rel, ['==', '!=']);
      const band = bin(eq, ['&']);
      const bxor = bin(band, ['^']);
      const bor = bin(bxor, ['|']);
      const land = bin(bor, ['&&']);
      const lor = bin(land, ['||']);
      const r = lor();
      if (p < toks.length) throw new GlslError(lineNo, String(peek()), 'invalid preprocessor expression');
      return r !== 0;
    }

    for (let li = 0; li < lines.length; li++) {
      lineNo = li + 1;
      const line = lines[li];
      const dm = /^\s*#\s*(\w*)\s*(.*)$/.exec(line);
      if (dm) {
        const dir = dm[1];
        const rest = dm[2];
        out.push('');
        switch (dir) {
          case 'version': {
            if (sawCode) throw new GlslError(lineNo, '#version', '#version directive must occur before anything else, except for comments and white space');
            const m = /^(\d+)(?:\s+(\w+))?$/.exec(rest.trim());
            if (!m) throw new GlslError(lineNo, '#version', 'invalid version directive');
            version = parseInt(m[1], 10);
            if (version === 300 && m[2] !== 'es') throw new GlslError(lineNo, '#version', 'invalid version directive');
            if (version !== 100 && version !== 300) throw new GlslError(lineNo, '#version', `version number not supported: ${version}`);
            if (version === 100 && m[2] !== undefined && m[2] !== 'es') throw new GlslError(lineNo, '#version', 'invalid version directive');
            macros.set('__VERSION__', { body: String(version) });
            break;
          }
          case 'define': {
            if (!active) break;
            const m = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s?(.*)$/.exec(rest);
            if (!m) throw new GlslError(lineNo, '#define', 'Invalid macro definition');
            if (m[1].startsWith('GL_') || m[1].includes('__')) throw new GlslError(lineNo, m[1], 'Macro name is reserved');
            macros.set(m[1], { params: m[2] !== undefined ? m[3].split(',').map((s) => s.trim()).filter((s) => s !== '') : null, body: m[4].trim() });
            break;
          }
          case 'undef': if (active) macros.delete(rest.trim()); break;
          case 'if': { const par = active; const v = par ? evalCond(rest) : false; stack.push({ par, taken: v }); active = par && v; break; }
          case 'ifdef': { const par = active; const v = macros.has(rest.trim()); stack.push({ par, taken: v }); active = par && v; break; }
          case 'ifndef': { const par = active; const v = !macros.has(rest.trim()); stack.push({ par, taken: v }); active = par && v; break; }
          case 'elif': {
            const s = stack[stack.length - 1];
            if (!s) throw new GlslError(lineNo, '#elif', 'unexpected #elif');
            if (s.taken) active = false; else { const v = s.par ? evalCond(rest) : false; s.taken = v; active = s.par && v; }
            break;
          }
          case 'else': {
            const s = stack[stack.length - 1];
            if (!s) throw new GlslError(lineNo, '#else', 'unexpected #else');
            active = s.par && !s.taken; s.taken = true;
            break;
          }
          case 'endif': {
            const s = stack.pop();
            if (!s) throw new GlslError(lineNo, '#endif', 'unexpected #endif');
            active = s.par;
            break;
          }
          case 'extension': {
            if (!active) break;
            const m = /^(\w+)\s*:\s*(\w+)$/.exec(rest.trim());
            if (!m) throw new GlslError(lineNo, '#extension', 'invalid extension directive');
            const [, name, behavior] = m;
            if (!['enable', 'require', 'warn', 'disable'].includes(behavior)) throw new GlslError(lineNo, behavior, 'invalid extension behavior');
            const known = name === 'all' || supportedExt[name] === true;
            if (!known && behavior === 'require') throw new GlslError(lineNo, name, `extension is not supported`);
            if (known && name !== 'all' && behavior !== 'disable') { extStates.push(name); macros.set(name, { body: '1' }); }
            if (known && name !== 'all' && behavior === 'disable') macros.delete(name);
            break;
          }
          case 'error': if (active) throw new GlslError(lineNo, '#error', rest.trim()); break;
          case 'pragma': case 'line': case '': break;
          default: if (active) throw new GlslError(lineNo, '#' + dir, 'invalid directive name');
        }
        continue;
      }
      if (!active) { out.push(''); continue; }
      if (line.trim() !== '') sawCode = true;
      out.push(expand(line, new Set(), 0));
    }
    if (stack.length) throw new GlslError(lines.length, '#if', 'unexpected end of file found in conditional block');
    return { text: out.join('\n'), version, extensions: extStates };
  }

  // ---------------------------------------------------------------------------------------
  // Lexer
  // ---------------------------------------------------------------------------------------
  const PUNCT3 = ['<<=', '>>='];
  const PUNCT2 = ['++', '--', '+=', '-=', '*=', '/=', '%=', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '^^', '&=', '|=', '^='];
  function lex(src) {
    const toks = [];
    let line = 1;
    for (let i = 0; i < src.length;) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const m = NUM_RE.exec(src.slice(i));
        let s = m[0];
        i += s.length;
        const hex = /^0[xX]/.test(s);
        const isUint = /[uU]$/.test(s);
        const isFloat = !hex && !isUint && (/[.eE]/.test(s) || /[fF]$/.test(s));
        s = s.replace(/[uUfF]$/, hex ? (x) => (/[uU]/.test(x) ? '' : x) : '');
        let v;
        if (isFloat) v = parseFloat(s);
        else if (hex) v = parseInt(s, 16);
        else if (/^0\d/.test(s)) v = parseInt(s, 8);
        else v = parseInt(s, 10);
        if (!isFloat && !isUint && v > 2147483647 && v <= 4294967295) throw new GlslError(line, s, 'Integer overflow');
        if (!isFloat && v > 4294967295) throw new GlslError(line, s, 'Integer overflow');
        toks.push({ t: 'num', v, type: isFloat ? 'float' : isUint ? 'uint' : 'int', line, s });
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const id = ID_RE.exec(src.slice(i))[0];
        i += id.length;
        toks.push({ t: 'id', v: id, line });
        continue;
      }
      const three = src.slice(i, i + 3);
      if (PUNCT3.includes(three)) { toks.push({ t: 'p', v: three, line }); i += 3; continue; }
      const two = src.slice(i, i + 2);
      if (PUNCT2.includes(two)) { toks.push({ t: 'p', v: two, line }); i += 2; continue; }
      if ('{}()[];,.+-*/%<>=!&|^~?:'.includes(c)) { toks.push({ t: 'p', v: c, line }); i++; continue; }
      throw new GlslError(line, c, 'Illegal character');
    }
    toks.push({ t: 'eof', v: '<EOF>', line });
    return toks;
  }

  // ---------------------------------------------------------------------------------------
  // Parser
  // ---------------------------------------------------------------------------------------
  const BASIC_TYPES = new Set(['void', 'bool', 'int', 'uint', 'float']);
  const TYPE_RE = /^(?:[ibu]?vec[234]|mat[234](?:x[234])?|[iu]?sampler(?:2D|3D|Cube|2DArray|2DShadow|CubeShadow|2DArrayShadow))$/;
  const KEYWORDS = new Set(['break', 'continue', 'do', 'for', 'while', 'switch', 'case', 'default', 'if', 'else', 'discard', 'return', 'struct',
    'const', 'in', 'out', 'inout', 'attribute', 'varying', 'uniform', 'layout', 'centroid', 'flat', 'smooth', 'invariant', 'highp', 'mediump', 'lowp',
    'precision', 'true', 'false']);
  const RESERVED = new Set(['asm', 'class', 'union', 'enum', 'typedef', 'template', 'this', 'packed', 'goto', 'inline', 'noinline', 'volatile', 'public',
    'static', 'extern', 'external', 'interface', 'long', 'short', 'double', 'half', 'fixed', 'unsigned', 'superp', 'input', 'output', 'hvec2', 'hvec3', 'hvec4',
    'dvec2', 'dvec3', 'dvec4', 'fvec2', 'fvec3', 'fvec4', 'sampler1D', 'sampler1DShadow', 'sampler2DRect', 'sampler2DRectShadow', 'sizeof', 'cast', 'namespace', 'using']);

  function parse(tokens, version) {
    let p = 0;
    const structs = new Map(); // name -> {name, fields}
    const es3 = version === 300;
    const peek = (o) => tokens[p + (o || 0)];
    const err = (tok, msg) => { throw new GlslError(tok.line, tok.t === 'num' ? tok.s : tok.v, msg); };
    const isP = (v, o) => { const t = tokens[p + (o || 0)]; return t.t === 'p' && t.v === v; };
    const isId = (v) => { const t = tokens[p]; return t.t === 'id' && t.v === v; };
    const eatP = (v) => { if (isP(v)) { p++; return true; } return false; };
    const expectP = (v) => { if (!eatP(v)) { const t = peek(); err(t, t.t === 'eof' ? 'syntax error, unexpected end of file' : `syntax error, expected '${v}'`); } };
    const isTypeName = (t) => t.t === 'id' && (BASIC_TYPES.has(t.v) || TYPE_RE.test(t.v) || structs.has(t.v));
    const ident = () => {
      const t = peek();
      if (t.t !== 'id' || KEYWORDS.has(t.v)) err(t, 'syntax error');
      if (RESERVED.has(t.v)) err(t, 'reserved word');
      if (t.v.startsWith('gl_')) err(t, 'identifiers starting with "gl_" are reserved');
      p++;
      return t.v;
    };

    function typeSpecifier() {
      const t = peek();
      if (t.t === 'id' && t.v === 'struct') {
        p++;
        let name = null;
        if (peek().t === 'id' && !isP('{')) name = ident();
        expectP('{');
        const fields = [];
        while (!isP('}')) {
          while (isId('highp') || isId('mediump') || isId('lowp')) p++;
          const ft = typeSpecifier();
          do {
            const fname = ident();
            let ftype = ft;
            if (eatP('[')) { const e = assignment(); expectP(']'); ftype = { arr: ft, len: e }; }
            fields.push({ name: fname, type: ftype });
          } while (eatP(','));
          expectP(';');
        }
        expectP('}');
        if (name === null) name = `anon_struct_${p}`;
        const def = { k: 'struct', name, fields, line: t.line };
        structs.set(name, def);
        return { structDef: def, name };
      }
      if (!isTypeName(t)) err(t, 'syntax error');
      p++;
      return t.v;
    }
    const typeName = (ts) => (typeof ts === 'string' ? ts : ts.name);

    // ---- expressions
    function primary() {
      const t = peek();
      if (t.t === 'num') { p++; return { k: 'num', v: t.v, type: t.type, line: t.line }; }
      if (t.t === 'id') {
        if (t.v === 'true' || t.v === 'false') { p++; return { k: 'bool', v: t.v === 'true', line: t.line }; }
        if (isTypeName(t)) {
          // constructor
          const ty = typeSpecifier();
          let ctype = typeName(ty);
          if (isP('[')) { p++; const len = assignment(); expectP(']'); ctype = { arr: ctype, len }; }
          expectP('(');
          const args = argList();
          return { k: 'call', ctor: true, type: ctype, args, line: t.line };
        }
        if (KEYWORDS.has(t.v)) err(t, 'syntax error');
        p++;
        if (isP('(')) { p++; const args = argList(); return { k: 'call', name: t.v, args, line: t.line }; }
        return { k: 'id', name: t.v, line: t.line };
      }
      if (t.t === 'p' && t.v === '(') { p++; const e = expression(); expectP(')'); return e; }
      err(t, t.t === 'eof' ? 'syntax error, unexpected end of file' : 'syntax error');
    }
    function argList() {
      const args = [];
      if (isId('void') && isP(')', 1)) { p += 2; return args; }
      if (eatP(')')) return args;
      do { args.push(assignment()); } while (eatP(','));
      expectP(')');
      return args;
    }
    function postfix() {
      let e = primary();
      for (;;) {
        const t = peek();
        if (t.t !== 'p') break;
        if (t.v === '[') { p++; const i = expression(); expectP(']'); e = { k: 'index', e, i, line: t.line }; } else if (t.v === '.') {
          p++;
          const nt = peek();
          if (nt.t !== 'id') err(nt, 'syntax error');
          p++;
          if (nt.v === 'length' && isP('(')) { p++; expectP(')'); e = { k: 'length', e, line: t.line }; } else e = { k: 'field', e, name: nt.v, line: t.line };
        } else if (t.v === '++' || t.v === '--') { p++; e = { k: 'post', op: t.v, e, line: t.line }; } else break;
      }
      return e;
    }
    function unary() {
      const t = peek();
      if (t.t === 'p' && (t.v === '+' || t.v === '-' || t.v === '!' || t.v === '~' || t.v === '++' || t.v === '--')) {
        p++;
        const e = unary();
        if (t.v === '++' || t.v === '--') return { k: 'pre', op: t.v, e, line: t.line };
        return { k: 'un', op: t.v, e, line: t.line };
      }
      return postfix();
    }
    const LEVELS = [['||'], ['^^'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
    function binary(level) {
      if (level >= LEVELS.length) return unary();
      let l = binary(level + 1);
      for (;;) {
        const t = peek();
        if (t.t === 'p' && LEVELS[level].includes(t.v)) {
          p++;
          const r = binary(level + 1);
          l = { k: 'bin', op: t.v, l, r, line: t.line };
        } else break;
      }
      return l;
    }
    function conditional() {
      const c = binary(0);
      if (isP('?')) {
        const t = peek(); p++;
        const a = expression();
        expectP(':');
        const b = assignment();
        return { k: 'cond', c, a, b, line: t.line };
      }
      return c;
    }
    const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^='];
    function assignment() {
      const l = conditional();
      const t = peek();
      if (t.t === 'p' && ASSIGN_OPS.includes(t.v)) {
        p++;
        const r = assignment();
        return { k: 'assign', op: t.v, l, r, line: t.line };
      }
      return l;
    }
    function expression() {
      let e = assignment();
      while (isP(',')) { const t = peek(); p++; e = { k: 'comma', l: e, r: assignment(), line: t.line }; }
      return e;
    }

    // ---- declarations
    function qualifiers() {
      const q = {};
      let any = false;
      for (;;) {
        const t = peek();
        if (t.t !== 'id') break;
        const v = t.v;
        if (v === 'const' || v === 'uniform' || v === 'in' || v === 'out' || v === 'inout' || v === 'centroid' || v === 'flat' || v === 'smooth' || v === 'invariant') {
          q[v] = true; p++; any = true;
        } else if (v === 'attribute' || v === 'varying') {
          if (es3) err(t, `'${v}' : Illegal use of reserved word`);
          q[v] = true; p++; any = true;
        } else if (v === 'highp' || v === 'mediump' || v === 'lowp') { q.precision = v; p++; any = true; } else if (v === 'layout') {
          p++; expectP('(');
          q.layout = {};
          do {
            const idt = peek(); p++;
            if (eatP('=')) { const nt = peek(); if (nt.t !== 'num') err(nt, 'syntax error'); p++; q.layout[idt.v] = nt.v; } else q.layout[idt.v] = true;
          } while (eatP(','));
          expectP(')'); any = true;
        } else break;
      }
      q.any = any;
      return q;
    }
    function declarators(quals, ts, baseTypeLine) {
      const decls = [];
      do {
        const nt = peek();
        const name = ident();
        let type = typeName(ts);
        let arr = null;
        if (isP('[')) { p++; arr = assignment(); expectP(']'); type = { arr: type, len: arr }; }
        let init = null;
        if (eatP('=')) init = assignment();
        decls.push({ k: 'var', quals, type, name, init, line: nt.line });
      } while (eatP(','));
      return decls;
    }
    function funcParams() {
      const params = [];
      if (isId('void') && isP(')', 1)) { p += 2; return params; }
      if (eatP(')')) return params;
      do {
        const q = { const: false, dir: 'in' };
        for (;;) {
          if (isId('const')) { q.const = true; p++; } else if (isId('in') || isId('out') || isId('inout')) { q.dir = peek().v; p++; } else if (isId('highp') || isId('mediump') || isId('lowp')) p++;
          else break;
        }
        const ts = typeSpecifier();
        let type = typeName(ts);
        let name = null;
        if (peek().t === 'id' && !isP(',') && !isP(')')) name = ident();
        if (isP('[')) { p++; const e = assignment(); expectP(']'); type = { arr: type, len: e }; }
        params.push({ name, type, dir: q.dir, line: peek().line });
      } while (eatP(','));
      expectP(')');
      return params;
    }

    function declarationStatement() {
      const t0 = peek();
      const quals = qualifiers();
      let ts = typeSpecifier();
      const out = [];
      if (ts.structDef) out.push(ts.structDef);
      if (isP(';')) return out;
      if (isP('[')) { p++; const len = assignment(); expectP(']'); ts = { name: { arr: typeName(ts), len } }; }
      return out.concat(declarators(quals, ts, t0.line));
    }

    function statement() {
      const t = peek();
      if (t.t === 'p') {
        if (t.v === '{') return block();
        if (t.v === ';') { p++; return { k: 'empty', line: t.line }; }
      }
      if (t.t === 'id') {
        switch (t.v) {
          case 'if': {
            p++; expectP('('); const c = expression(); expectP(')');
            const a = statement();
            let b = null;
            if (isId('else')) { p++; b = statement(); }
            return { k: 'if', c, a, b, line: t.line };
          }
          case 'for': {
            p++; expectP('(');
            let init = null;
            if (!eatP(';')) {
              if (isTypeName(peek()) || isId('const') || isId('highp') || isId('mediump') || isId('lowp')) {
                const d = declarationStatement();
                expectP(';');
                init = { k: 'decl', decls: d, line: t.line };
              } else { init = { k: 'expr', e: expression(), line: t.line }; expectP(';'); }
            }
            let cond = null;
            if (!isP(';')) cond = expression();
            expectP(';');
            let iter = null;
            if (!isP(')')) iter = expression();
            expectP(')');
            const body = statement();
            return { k: 'for', init, cond, iter, body, line: t.line };
          }
          case 'while': {
            p++; expectP('(');
            let cond;
            if (isTypeName(peek())) { const d = declarationStatement(); cond = { decl: d }; } else cond = expression();
            expectP(')');
            return { k: 'while', cond, body: statement(), line: t.line };
          }
          case 'do': {
            p++; const body = statement();
            if (!isId('while')) err(peek(), 'syntax error');
            p++; expectP('('); const cond = expression(); expectP(')'); expectP(';');
            return { k: 'dowhile', cond, body, line: t.line };
          }
          case 'return': { p++; let e = null; if (!isP(';')) e = expression(); expectP(';'); return { k: 'return', e, line: t.line }; }
          case 'break': p++; expectP(';'); return { k: 'break', line: t.line };
          case 'continue': p++; expectP(';'); return { k: 'continue', line: t.line };
          case 'discard': p++; expectP(';'); return { k: 'discard', line: t.line };
          case 'switch': {
            if (!es3) err(t, 'switch statements are not supported in GLSL ES 1.00');
            p++; expectP('('); const e = expression(); expectP(')'); expectP('{');
            const cases = [];
            let cur = null;
            while (!isP('}')) {
              if (isId('case')) { p++; const v = expression(); expectP(':'); cur = { test: v, body: [] }; cases.push(cur); } else if (isId('default')) { p++; expectP(':'); cur = { test: null, body: [] }; cases.push(cur); } else {
                if (cur === null) err(peek(), 'syntax error');
                cur.body.push(statement());
              }
            }
            expectP('}');
            return { k: 'switch', e, cases, line: t.line };
          }
        }
        if ((isTypeName(t) && !isP('(', 1)) || isId('const') || isId('highp') || isId('mediump') || isId('lowp')) {
          const d = declarationStatement();
          expectP(';');
          return { k: 'decl', decls: d, line: t.line };
        }
      }
      const e = expression();
      expectP(';');
      return { k: 'expr', e, line: t.line };
    }
    function block() {
      const t = peek();
      expectP('{');
      const body = [];
      while (!isP('}')) {
        if (peek().t === 'eof') err(peek(), 'syntax error, unexpected end of file');
        body.push(statement());
      }
      p++;
      return { k: 'block', body, line: t.line };
    }
    // ---- translation unit
    const decls = [];
    while (peek().t !== 'eof') {
      const t = peek();
      if (isId('precision')) {
        p++;
        const prec = peek().v; p++;
        const ty = typeSpecifier();
        expectP(';');
        decls.push({ k: 'precision', prec, type: typeName(ty), line: t.line });
        continue;
      }
      const quals = qualifiers();
      const ts = typeSpecifier();
      if (ts.structDef) decls.push(ts.structDef);
      if (isP(';')) { p++; continue; }
      // function or variable
      const nt = peek();
      if (nt.t === 'id' && isP('(', 1)) {
        const name = ident();
        expectP('(');
        const params = funcParams();
        if (eatP(';')) { decls.push({ k: 'func', ret: typeName(ts), name, params, body: null, line: nt.line }); continue; }
        if (!isP('{')) err(peek(), 'syntax error');
        const body = block();
        decls.push({ k: 'func', ret: typeName(ts), name, params, body, line: nt.line });
        continue;
      }
      const vs = declarators(quals, ts, t.line);
      expectP(';');
      for (const d of vs) decls.push(d);
    }
    return { decls, structs };
  }

  L.glslFront = { GlslError, preprocess, lex, parse };
})(globalThis.__layer);
