// 25_xpath.js — XPath 1.0 through the DOM Level 3 XPath API: Document.evaluate/createExpression/
// createNSResolver, XPathEvaluator, XPathExpression, XPathResult.
//
// An expression is parsed to a small AST and compiled to closures `(node, position, size) =>
// value`. Values are numbers, strings, booleans and node-sets. A node-set is an array in
// document order without duplicates whose members are native node ids (numbers) or Attr
// objects: nodes are wrapped only when they reach the page, and the node tests read kinds and
// names through the wrapper cache or natives, so a `//name` query does not create a wrapper for
// every node it walks past. The layer calls no native while loading.
(function (L) {
  'use strict';
  const N = L.N;
  const DOMException = L.DOMException;
  const idOf = L.idOf, typeOf = L.typeOf, lnOf = L.lnOf, nsOf = L.nsOf, isNode = L.isNode, wrap = L.wrap;
  const INTERNAL = L.INTERNAL;
  const cache = L.cache;
  const state = L.state;
  const XHTML = L.NS.HTML, XMLNS = L.NS.XMLNS, XML_NS = L.NS.XML, XLINK = L.NS.XLINK;
  const OTHER = 3; // namespace code of elements whose namespace is a plain URI (see L.nsCode)
  const isSet = Array.isArray;

  // ---------------------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------------------
  // Thrown by the parser; turned into a DOMException by the API entry points.
  class XPathError {
    constructor(namespace) { this.namespace = namespace; }
  }
  function badExpression() { return new XPathError(false); }
  // A node-set was needed and something else was given. The spec leaves this open; engines
  // report it as a SyntaxError.
  function typeConversion() {
    return new DOMException('Type conversion failed while evaluating the expression.', 'SyntaxError');
  }
  function nodeSetOf(v) {
    if (!isSet(v)) throw typeConversion();
    return v;
  }

  // ---------------------------------------------------------------------------------------
  // Node access. A node is a native id (number) or an Attr object.
  // ---------------------------------------------------------------------------------------
  // nodeType as the page sees it: a cached wrapper knows about CDATA, PI and doctype nodes,
  // which are text and comment nodes natively.
  function kindOf(id) {
    const w = cache.get(id);
    return w !== undefined ? typeOf(w) : N.nodeType(id);
  }
  // Elements, documents and fragments are the nodes with children.
  function hasChildren(k) { return k === 1 || k === 9 || k === 11; }
  function elLocal(id) {
    const w = cache.get(id);
    return w !== undefined ? lnOf(w) : N.localName(id);
  }
  // Namespace URI of an element, null for none. Elements of XML documents keep it in the JS
  // stamp only, as "no namespace" and "HTML" are the same natively.
  function elNs(id) {
    const w = cache.get(id);
    if (w !== undefined) {
      const c = nsOf(w);
      return c === OTHER ? (L.elementNsOther.get(w) || null) : L.nsURIOfCode[c];
    }
    const u = N.namespaceURI(id);
    const c = L.nsCode(u);
    return c === OTHER ? u : L.nsURIOfCode[c];
  }
  function ownerId(attr) {
    const o = L.attrOwner(attr);
    return o === null ? 0 : idOf(o);
  }
  function rootOf(n) {
    let id = n;
    if (typeof n !== 'number') {
      id = ownerId(n);
      if (id === 0) return n;
    }
    for (let p = N.parent(id); p !== 0; p = N.parent(id)) id = p;
    return id;
  }

  let htmlMode = false; // the evaluation runs in an HTML document, see runExpression()
  // The HTML parser only gives foreign (SVG, MathML) elements namespaced attributes. Those of an
  // HTML element are plain names, colons included: `xmlns`, `xml:lang` and `xlink:href` on a
  // <div> are attributes of no namespace, and not namespace declarations.
  function plainAttrs(id) { return htmlMode && elNs(id) === XHTML; }
  // The XPath data model has no namespace declarations among the attributes.
  function isNsDecl(id, name) { return (name === 'xmlns' || name.startsWith('xmlns:')) && !plainAttrs(id); }
  // Namespace and local name of the attribute `name` of element `id`. The layer stores the
  // qualified name only, so a prefix is resolved against the xmlns declarations in scope
  // (XML documents) or the fixed set the HTML parser gives foreign attributes.
  function attrParts(id, name) {
    if (plainAttrs(id)) return [name, null, null];
    const i = name.indexOf(':');
    if (i <= 0) return name === 'xmlns' ? [name, XMLNS, null] : [name, null, null];
    const prefix = name.slice(0, i), local = name.slice(i + 1);
    let ns = null;
    if (prefix === 'xmlns') ns = XMLNS;
    else if (prefix === 'xml') ns = XML_NS;
    else {
      if (!htmlMode) {
        for (let e = id; e !== 0 && ns === null; e = N.parent(e)) {
          if (kindOf(e) === 1) ns = N.getAttr(e, 'xmlns:' + prefix) || null;
        }
      }
      if (ns === null && prefix === 'xlink') ns = XLINK;
    }
    return ns === null ? [name, null, null] : [local, ns, prefix];
  }
  // [local name, namespace URI, prefix] of a node that has an expanded name, else null.
  function nameParts(n) {
    if (typeof n !== 'number') {
      const owner = L.attrOwner(n);
      return owner !== null ? attrParts(idOf(owner), L.attrName(n)) : [n.localName, n.namespaceURI, n.prefix];
    }
    const k = kindOf(n);
    if (k === 1) {
      const w = wrap(n);
      return [lnOf(w), elNs(n), L.elementPrefix.get(w) || null];
    }
    if (k === 7) return [wrap(n).nodeName, null, null];
    return null;
  }
  // String-value (XPath 1.0 section 5).
  function stringValue(n) {
    if (typeof n !== 'number') return n.value;
    switch (kindOf(n)) {
      case 1: case 9: case 11: return N.textContent(n);
      case 3: case 4: case 7: case 8: return N.getText(n);
      default: return '';
    }
  }

  // ---------------------------------------------------------------------------------------
  // Conversions
  // ---------------------------------------------------------------------------------------
  const NUMBER_RE = /^[\t\n\r ]*-?(?:\d+(?:\.\d*)?|\.\d+)[\t\n\r ]*$/;
  function strToNum(s) { return NUMBER_RE.test(s) ? parseFloat(s) : NaN; }
  // XPath never prints an exponent: 1e21 is "1000000000000000000000" and 1e-7 "0.0000001".
  function numToStr(v) {
    if (v !== v) return 'NaN';
    if (v === 0) return '0';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    const s = String(v);
    const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
    if (m === null) return s;
    const digits = m[2] + (m[3] || '');
    const exp = Number(m[4]);
    if (exp < 0) return m[1] + '0.' + '0'.repeat(-exp - 1) + digits;
    const point = 1 + exp;
    return m[1] + (digits.length <= point ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point));
  }
  function toStr(v) {
    switch (typeof v) {
      case 'string': return v;
      case 'number': return numToStr(v);
      case 'boolean': return v ? 'true' : 'false';
      default: return v.length === 0 ? '' : stringValue(v[0]);
    }
  }
  function toNum(v) {
    switch (typeof v) {
      case 'number': return v;
      case 'string': return strToNum(v);
      case 'boolean': return v ? 1 : 0;
      default: return strToNum(toStr(v));
    }
  }
  function toBool(v) {
    switch (typeof v) {
      case 'boolean': return v;
      case 'number': return v !== 0 && v === v;
      case 'string': return v.length !== 0;
      default: return v.length !== 0;
    }
  }

  // Comparisons (XPath 1.0 section 3.4).
  function cmpPrim(op, x, y) {
    if (op === '=' || op === '!=') {
      let eq;
      if (typeof x === 'boolean' || typeof y === 'boolean') eq = toBool(x) === toBool(y);
      else if (typeof x === 'number' || typeof y === 'number') eq = toNum(x) === toNum(y);
      else eq = x === y;
      return op === '=' ? eq : !eq;
    }
    return cmpNum(op, toNum(x), toNum(y));
  }
  function cmpNum(op, a, b) {
    switch (op) {
      case '=': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      default: return a >= b;
    }
  }
  function compare(op, x, y) {
    const xs = isSet(x), ys = isSet(y);
    if (!xs && !ys) return cmpPrim(op, x, y);
    if (xs && ys) {
      // "there is a node in each set such that the comparison of their string-values is true"
      const strs = new Array(y.length);
      for (let j = 0; j < y.length; j++) strs[j] = stringValue(y[j]);
      const seen = op === '=' ? new Set(strs) : null;
      for (let i = 0; i < x.length; i++) {
        const sx = stringValue(x[i]);
        if (seen !== null) { if (seen.has(sx)) return true; continue; }
        for (let j = 0; j < strs.length; j++) if (cmpPrim(op, sx, strs[j])) return true;
      }
      return false;
    }
    const set = xs ? x : y, other = xs ? y : x;
    if (typeof other === 'boolean') return xs ? cmpPrim(op, set.length !== 0, other) : cmpPrim(op, other, set.length !== 0);
    for (let i = 0; i < set.length; i++) {
      const sv = stringValue(set[i]);
      if (xs ? cmpPrim(op, sv, other) : cmpPrim(op, other, sv)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------
  // Document order
  // ---------------------------------------------------------------------------------------
  const FOLLOWING = 4, PRECEDING = 2; // Node.compareDocumentPosition bits
  // Sort a node-set into document order and drop duplicates. Sets that are already ordered
  // (concatenated runs) cost about one comparison per node.
  function docOrder(nodes) {
    if (nodes.length < 2) return nodes;
    const uniq = Array.from(new Set(nodes));
    if (uniq.length < 2) return uniq;
    const attrNames = new Map(); // element id -> attribute names, for the order of attributes
    const items = new Array(uniq.length);
    for (let i = 0; i < uniq.length; i++) {
      const n = uniq[i];
      if (typeof n === 'number') { items[i] = { n, id: n, ai: 0 }; continue; }
      const oid = ownerId(n);
      let ai = 0;
      if (oid !== 0) {
        let names = attrNames.get(oid);
        if (names === undefined) { names = N.attrNames(oid); attrNames.set(oid, names); }
        ai = 1 + names.indexOf(L.attrName(n));
      }
      items[i] = { n, id: oid, ai };
    }
    items.sort((a, b) => {
      if (a.id === b.id) return a.ai - b.ai;
      const r = N.compareDocumentPosition(a.id, b.id);
      return (r & FOLLOWING) !== 0 ? -1 : (r & PRECEDING) !== 0 ? 1 : 0;
    });
    return items.map((it) => it.n);
  }

  // ---------------------------------------------------------------------------------------
  // Lexer (XPath 1.0 section 3.7)
  // ---------------------------------------------------------------------------------------
  const AXES = new Set(['ancestor', 'ancestor-or-self', 'attribute', 'child', 'descendant', 'descendant-or-self',
    'following', 'following-sibling', 'namespace', 'parent', 'preceding', 'preceding-sibling', 'self']);
  const NODE_TYPES = new Set(['comment', 'text', 'processing-instruction', 'node']);
  // Tokens after which `*` and the names and/or/mod/div are not operators.
  const NOT_BEFORE_OPERAND = new Set(['@', 'axis', '(', '[', ',', 'and', 'or', 'mul', 'mod', 'div', '/', '//', '|', '+', '-',
    '=', '!=', '<', '<=', '>', '>=']);
  const NAME_START = /[\p{L}\p{Nl}_]/u;
  const NAME_CHAR = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Me}\p{Lm}\p{Nd}._\-\u00B7]/u;
  const NUM_RE = /(?:\d+(?:\.\d*)?|\.\d+)/y;
  // Only these four are whitespace (ExprWhitespace).
  function isSpace(c) { return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a; }
  // End of the NCName starting at `i` (== i if there is none).
  function scanName(s, i) {
    let j = i;
    while (j < s.length) {
      const ch = String.fromCodePoint(s.codePointAt(j));
      if (!(j === i ? NAME_START : NAME_CHAR).test(ch)) break;
      j += ch.length;
    }
    return j;
  }
  function tokenize(s) {
    const toks = [];
    let i = 0;
    for (;;) {
      while (i < s.length && isSpace(s.charCodeAt(i))) i++;
      if (i >= s.length) break;
      const c = s[i];
      const prev = toks.length === 0 ? null : toks[toks.length - 1].t;
      const operatorContext = prev !== null && !NOT_BEFORE_OPERAND.has(prev);
      switch (c) {
        case '(': case ')': case '[': case ']': case '@': case ',': case '|': case '+': case '-': case '=':
          toks.push({ t: c }); i++; continue;
        case '"': case "'": {
          const e = s.indexOf(c, i + 1);
          if (e < 0) throw badExpression();
          toks.push({ t: 'lit', v: s.slice(i + 1, e) });
          i = e + 1;
          continue;
        }
        case '.':
          if (s[i + 1] === '.') { toks.push({ t: '..' }); i += 2; continue; }
          if (!(s[i + 1] >= '0' && s[i + 1] <= '9')) { toks.push({ t: '.' }); i++; continue; }
          break;
        case '/':
          if (s[i + 1] === '/') { toks.push({ t: '//' }); i += 2; } else { toks.push({ t: '/' }); i++; }
          continue;
        case '!':
          if (s[i + 1] !== '=') throw badExpression();
          toks.push({ t: '!=' }); i += 2; continue;
        case '<': case '>':
          if (s[i + 1] === '=') { toks.push({ t: c + '=' }); i += 2; } else { toks.push({ t: c }); i++; }
          continue;
        case '*':
          toks.push(operatorContext ? { t: 'mul' } : { t: 'name', prefix: null, local: '*' });
          i++;
          continue;
        case '$': {
          // A variable reference: the DOM API has no way to bind one.
          let e = scanName(s, i + 1);
          if (e === i + 1) throw badExpression();
          if (s[e] === ':') {
            const e2 = scanName(s, e + 1);
            if (e2 === e + 1) throw badExpression();
            e = e2;
          }
          toks.push({ t: 'var' });
          i = e;
          continue;
        }
        default:
          break;
      }
      if (c >= '0' && c <= '9' || c === '.') {
        NUM_RE.lastIndex = i;
        const m = NUM_RE.exec(s);
        toks.push({ t: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
        continue;
      }
      const e = scanName(s, i);
      if (e === i) throw badExpression();
      const name = s.slice(i, e);
      let j = e;
      while (j < s.length && isSpace(s.charCodeAt(j))) j++;
      if (s[j] === ':' && s[j + 1] === ':') {
        if (!AXES.has(name)) throw badExpression();
        toks.push({ t: 'axis', v: name });
        i = j + 2;
        continue;
      }
      if (operatorContext && (name === 'and' || name === 'or' || name === 'mod' || name === 'div')) {
        toks.push({ t: name });
        i = e;
        continue;
      }
      let prefix = null, local = name;
      j = e;
      if (s[j] === ':') {
        if (s[j + 1] === '*') { prefix = name; local = '*'; j += 2; } else {
          const e2 = scanName(s, j + 1);
          if (e2 === j + 1) throw badExpression();
          prefix = name; local = s.slice(j + 1, e2); j = e2;
        }
      }
      let k = j;
      while (k < s.length && isSpace(s.charCodeAt(k))) k++;
      i = j;
      if (s[k] === '(') {
        if (prefix === null && NODE_TYPES.has(local)) toks.push({ t: local === 'processing-instruction' ? 'pi' : 'ntype', v: local });
        else toks.push({ t: 'func', v: prefix === null ? local : prefix + ':' + local });
      } else toks.push({ t: 'name', prefix, local });
    }
    toks.push({ t: 'eof' });
    return toks;
  }

  // ---------------------------------------------------------------------------------------
  // Function library (XPath 1.0 section 4). def(name, minArgs, maxArgs, resultType, make):
  // make(args) returns the closure that evaluates a call with the compiled argument closures.
  // ---------------------------------------------------------------------------------------
  const FN = Object.create(null);
  function def(name, min, max, type, make) { FN[name] = { min, max, type, make }; }
  function nameFn(pick) {
    return (a) => a.length === 0
      ? (n) => { const p = nameParts(n); return p === null ? '' : pick(p); }
      : (n, pos, size) => {
        const v = a[0](n, pos, size);
        if (!isSet(v) || v.length === 0) return '';
        const p = nameParts(v[0]);
        return p === null ? '' : pick(p);
      };
  }
  function stringArg(a) { return a.length === 0 ? (n) => stringValue(n) : (n, p, s) => toStr(a[0](n, p, s)); }
  function elementById(rootId, s) {
    if (s === '') return 0;
    if (rootId === L.documentId) return N.getElementById(s);
    if (kindOf(rootId) === 1 && N.getAttr(rootId, 'id') === s) return rootId;
    return N.querySelector(rootId, '#' + L.cssEscape(s));
  }
  function xmlLang(n) {
    let id = typeof n === 'number' ? n : ownerId(n);
    for (; id !== 0; id = N.parent(id)) {
      if (kindOf(id) !== 1 || plainAttrs(id)) continue;
      const v = N.getAttr(id, 'xml:lang');
      if (v !== null) return v;
    }
    return null;
  }

  def('last', 0, 0, 'number', () => (n, p, s) => s);
  def('position', 0, 0, 'number', () => (n, p) => p);
  def('count', 1, 1, 'number', (a) => (n, p, s) => nodeSetOf(a[0](n, p, s)).length);
  def('id', 1, 1, 'nodeset', (a) => (n, p, s) => {
    const v = a[0](n, p, s);
    const list = isSet(v) ? v.map(stringValue).join(' ') : toStr(v);
    const root = rootOf(n);
    const found = [];
    // The tree of an orphaned attribute has no elements.
    if (typeof root === 'number') {
      for (const token of list.split(/[\t\n\r ]+/)) {
        const id = elementById(root, token);
        if (id !== 0) found.push(id);
      }
    }
    return docOrder(found);
  });
  def('local-name', 0, 1, 'string', nameFn((p) => p[0]));
  def('namespace-uri', 0, 1, 'string', nameFn((p) => p[1] || ''));
  def('name', 0, 1, 'string', nameFn((p) => (p[2] === null ? p[0] : p[2] + ':' + p[0])));
  def('string', 0, 1, 'string', stringArg);
  def('concat', 2, Infinity, 'string', (a) => (n, p, s) => {
    let r = '';
    for (let i = 0; i < a.length; i++) r += toStr(a[i](n, p, s));
    return r;
  });
  def('starts-with', 2, 2, 'boolean', (a) => (n, p, s) => toStr(a[0](n, p, s)).startsWith(toStr(a[1](n, p, s))));
  def('contains', 2, 2, 'boolean', (a) => (n, p, s) => toStr(a[0](n, p, s)).includes(toStr(a[1](n, p, s))));
  def('substring-before', 2, 2, 'string', (a) => (n, p, s) => {
    const x = toStr(a[0](n, p, s));
    const i = x.indexOf(toStr(a[1](n, p, s)));
    return i < 0 ? '' : x.slice(0, i);
  });
  def('substring-after', 2, 2, 'string', (a) => (n, p, s) => {
    const x = toStr(a[0](n, p, s)), y = toStr(a[1](n, p, s));
    const i = x.indexOf(y);
    return i < 0 ? '' : x.slice(i + y.length);
  });
  // The characters at the positions p with round(start) <= p < round(start) + round(length).
  def('substring', 2, 3, 'string', (a) => (n, p, s) => {
    const x = toStr(a[0](n, p, s));
    const start = Math.round(toNum(a[1](n, p, s)));
    const end = a.length === 3 ? start + Math.round(toNum(a[2](n, p, s))) : Infinity;
    if (start !== start || end !== end) return '';
    const from = Math.max(start, 1), to = Math.min(end, x.length + 1);
    return to > from ? x.slice(from - 1, to - 1) : '';
  });
  def('string-length', 0, 1, 'number', (a) => { const f = stringArg(a); return (n, p, s) => f(n, p, s).length; });
  def('normalize-space', 0, 1, 'string', (a) => {
    const f = stringArg(a);
    return (n, p, s) => f(n, p, s).replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '');
  });
  def('translate', 3, 3, 'string', (a) => (n, p, s) => {
    const x = toStr(a[0](n, p, s)), from = toStr(a[1](n, p, s)), to = toStr(a[2](n, p, s));
    let r = '';
    for (let i = 0; i < x.length; i++) {
      const j = from.indexOf(x[i]);
      if (j < 0) r += x[i];
      else if (j < to.length) r += to[j];
    }
    return r;
  });
  def('boolean', 1, 1, 'boolean', (a) => (n, p, s) => toBool(a[0](n, p, s)));
  def('not', 1, 1, 'boolean', (a) => (n, p, s) => !toBool(a[0](n, p, s)));
  def('true', 0, 0, 'boolean', () => () => true);
  def('false', 0, 0, 'boolean', () => () => false);
  // "the same as or a sublanguage of": ASCII case-insensitive, optionally followed by -subtag.
  def('lang', 1, 1, 'boolean', (a) => (n, p, s) => {
    const want = L.asciiLower(toStr(a[0](n, p, s)));
    const have = xmlLang(n);
    if (have === null) return false;
    const h = L.asciiLower(have);
    return h === want || h.startsWith(want + '-');
  });
  def('number', 0, 1, 'number', (a) => a.length === 0 ? (n) => strToNum(stringValue(n)) : (n, p, s) => toNum(a[0](n, p, s)));
  def('sum', 1, 1, 'number', (a) => (n, p, s) => {
    const v = a[0](n, p, s);
    if (!isSet(v)) return 0;
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += strToNum(stringValue(v[i]));
    return sum;
  });
  def('floor', 1, 1, 'number', (a) => (n, p, s) => Math.floor(toNum(a[0](n, p, s))));
  def('ceiling', 1, 1, 'number', (a) => (n, p, s) => Math.ceil(toNum(a[0](n, p, s))));
  // Math.round rounds halves towards +Infinity and keeps -0, as round() is specified.
  def('round', 1, 1, 'number', (a) => (n, p, s) => Math.round(toNum(a[0](n, p, s))));

  // ---------------------------------------------------------------------------------------
  // Parser: tokens -> AST. `lookup(prefix)` resolves a prefix to a namespace URI or null.
  //   {k:'num'|'str', v}  {k:'or'|'and'|'cmp'|'arith', op?, a, b}  {k:'neg', a}  {k:'union', list}
  //   {k:'call', name, args, def}  {k:'filter', e, preds}  {k:'path', start, abs, steps}
  // A step is {axis, test, preds}; a test is {k:'node'|'text'|'comment'|'pi'|'name', ...}.
  // ---------------------------------------------------------------------------------------
  const DESCENDANT_OR_SELF = { axis: 'descendant-or-self', test: { k: 'node' }, preds: [] };
  function parse(src, lookup) {
    const toks = tokenize(src);
    let pos = 0;
    const peek = () => toks[pos].t;
    const eat = (t) => { if (toks[pos].t === t) { pos++; return true; } return false; };
    const expect = (t) => { if (!eat(t)) throw badExpression(); };
    function binary(next, ops, kind) {
      return function () {
        let l = next();
        for (;;) {
          const t = peek();
          if (!ops.includes(t)) return l;
          pos++;
          l = { k: kind, op: t, a: l, b: next() };
        }
      };
    }
    const parseUnary = () => (eat('-') ? { k: 'neg', a: parseUnary() } : parseUnion());
    const parseMul = binary(parseUnary, ['mul', 'div', 'mod'], 'arith');
    const parseAdd = binary(parseMul, ['+', '-'], 'arith');
    const parseRel = binary(parseAdd, ['<', '<=', '>', '>='], 'cmp');
    const parseEq = binary(parseRel, ['=', '!='], 'cmp');
    const parseAnd = binary(parseEq, ['and'], 'and');
    const parseOr = binary(parseAnd, ['or'], 'or');
    function parseUnion() {
      const first = parsePath();
      if (peek() !== '|') return first;
      const list = [first];
      while (eat('|')) list.push(parsePath());
      return { k: 'union', list };
    }
    function startsStep(t) {
      return t === 'name' || t === 'axis' || t === '@' || t === 'ntype' || t === 'pi' || t === '.' || t === '..';
    }
    function parsePath() {
      const t = peek();
      if (t === '/') {
        pos++;
        return { k: 'path', start: null, abs: true, steps: startsStep(peek()) ? parseRelative() : [] };
      }
      if (t === '//') {
        pos++;
        return { k: 'path', start: null, abs: true, steps: [DESCENDANT_OR_SELF].concat(parseRelative()) };
      }
      if (startsStep(t)) return { k: 'path', start: null, abs: false, steps: parseRelative() };
      let e = parsePrimary();
      const preds = parsePredicates();
      if (preds.length !== 0) e = { k: 'filter', e, preds };
      const t2 = peek();
      if (t2 !== '/' && t2 !== '//') return e;
      pos++;
      const steps = parseRelative();
      if (t2 === '//') steps.unshift(DESCENDANT_OR_SELF);
      return { k: 'path', start: e, abs: false, steps };
    }
    function parseRelative() {
      const steps = [parseStep()];
      for (;;) {
        const t = peek();
        if (t === '/') pos++;
        else if (t === '//') { pos++; steps.push(DESCENDANT_OR_SELF); } else return steps;
        steps.push(parseStep());
      }
    }
    function nameTest(tok) {
      const ns = tok.prefix === null ? null : lookup(tok.prefix);
      if (tok.prefix !== null && ns === null) throw new XPathError(true);
      return { k: 'name', l: tok.local, lower: L.asciiLower(tok.local), ns, any: tok.local === '*' };
    }
    function parseStep() {
      if (eat('.')) return { axis: 'self', test: { k: 'node' }, preds: [] };
      if (eat('..')) return { axis: 'parent', test: { k: 'node' }, preds: [] };
      let axis = 'child';
      if (peek() === 'axis') axis = toks[pos++].v;
      else if (eat('@')) axis = 'attribute';
      const tok = toks[pos++];
      let test;
      switch (tok.t) {
        case 'name': test = nameTest(tok); break;
        case 'ntype': expect('('); expect(')'); test = { k: tok.v }; break;
        case 'pi': {
          expect('(');
          const target = peek() === 'lit' ? L.stripWS(toks[pos++].v) : null;
          expect(')');
          test = { k: 'pi', target };
          break;
        }
        default: throw badExpression();
      }
      return { axis, test, preds: parsePredicates() };
    }
    function parsePredicates() {
      const preds = [];
      while (eat('[')) { preds.push(parseOr()); expect(']'); }
      return preds;
    }
    function parsePrimary() {
      const tok = toks[pos++];
      switch (tok.t) {
        case 'num': return { k: 'num', v: tok.v };
        case 'lit': return { k: 'str', v: tok.v };
        case 'var': return { k: 'str', v: '' }; // an unbound variable is the empty string, as in Blink
        case '(': { const e = parseOr(); expect(')'); return e; }
        case 'func': {
          const d = FN[tok.v];
          if (d === undefined) throw badExpression();
          expect('(');
          const args = [];
          if (peek() !== ')') { do args.push(parseOr()); while (eat(',')); }
          expect(')');
          if (args.length < d.min || args.length > d.max) throw badExpression();
          return { k: 'call', name: tok.v, args, def: d };
        }
        default: throw badExpression();
      }
    }
    const ast = parseOr();
    if (peek() !== 'eof') throw badExpression();
    return ast;
  }

  // ---------------------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------------------
  const REVERSE_AXES = new Set(['ancestor', 'ancestor-or-self', 'preceding', 'preceding-sibling']);
  // Attribute and self steps keep a document-ordered input in order (an element's attributes
  // sit between it and the next element), every other step may interleave the results of
  // different inputs.
  const ORDER_KEEPING_AXES = new Set(['attribute', 'self']);

  // Does the element `id` pass the name test `t`? In an HTML document an unprefixed name
  // matches HTML elements whatever the case of their name; other elements need their exact
  // name and a prefixed test.
  function elementMatches(id, t) {
    if (t.any) return t.ns === null || t.ns === elNs(id);
    const ln = elLocal(id);
    const sameName = ln === t.l;
    // (the name decides for nearly every element, so it is looked at before the namespace)
    if (!sameName && !(htmlMode && L.asciiLower(ln) === t.lower)) return false;
    const ns = elNs(id);
    if (htmlMode && ns === XHTML) return t.ns === null || t.ns === XHTML;
    return sameName && t.ns === ns && (t.ns !== null || !htmlMode);
  }
  function attributeMatches(id, name, t) {
    if (isNsDecl(id, name)) return false;
    let local = name, ns = null;
    if (name.indexOf(':') > 0) { const p = attrParts(id, name); local = p[0]; ns = p[1]; }
    if (t.any) return t.ns === null || t.ns === ns;
    if (htmlMode && t.ns === null && ns === null && elNs(id) === XHTML) return L.asciiLower(local) === t.lower;
    return local === t.l && ns === t.ns;
  }
  // A predicate for tree nodes (id, kind) that avoids looking at nodes it cannot match.
  function treeTest(t) {
    switch (t.k) {
      case 'node': return () => true;
      case 'text': return (id, k) => k === 3 || k === 4;
      case 'comment': return (id, k) => k === 8;
      case 'pi': return t.target === null ? (id, k) => k === 7 : (id, k) => k === 7 && wrap(id).nodeName === t.target;
      default: return (id, k) => k === 1 && elementMatches(id, t);
    }
  }
  // Descendants of `id` in document order that pass `test`.
  function descend(id, test, out) {
    const stack = [N.childIds(id)];
    const at = [0];
    while (stack.length !== 0) {
      const top = stack.length - 1;
      const kids = stack[top];
      const i = at[top]++;
      if (i >= kids.length) { stack.pop(); at.pop(); continue; }
      const c = kids[i];
      const k = kindOf(c);
      if (test(c, k)) out.push(c);
      if (k === 1) {
        const sub = N.childIds(c);
        if (sub.length !== 0) { stack.push(sub); at.push(0); }
      }
    }
  }
  // Nodes after `id` in document order that are not its descendants.
  function following(id, test, out) {
    for (let a = id; a !== 0; a = N.parent(a)) {
      for (let s = N.nextSibling(a); s !== 0; s = N.nextSibling(s)) {
        const k = kindOf(s);
        if (test(s, k)) out.push(s);
        if (k === 1) descend(s, test, out);
      }
    }
  }
  // Nodes before `id` that are not its ancestors, in reverse document order.
  function preceding(id, test, out) {
    for (let a = id; a !== 0; a = N.parent(a)) {
      for (let s = N.prevSibling(a); s !== 0; s = N.prevSibling(s)) {
        const k = kindOf(s);
        const sub = [];
        if (test(s, k)) sub.push(s);
        if (k === 1) descend(s, test, sub);
        for (let j = sub.length - 1; j >= 0; j--) out.push(sub[j]);
      }
    }
  }
  function collect(step, node, out) {
    const test = step.tree;
    if (typeof node !== 'number') { collectFromAttr(step, node, out); return; }
    const id = node;
    switch (step.axis) {
      case 'child': {
        if (!hasChildren(kindOf(id))) return;
        const kids = N.childIds(id);
        for (let i = 0; i < kids.length; i++) {
          const k = kindOf(kids[i]);
          if (test(kids[i], k)) out.push(kids[i]);
        }
        return;
      }
      case 'descendant': case 'descendant-or-self': {
        const k = kindOf(id);
        if (step.axis === 'descendant-or-self' && test(id, k)) out.push(id);
        if (hasChildren(k)) descend(id, test, out);
        return;
      }
      case 'self':
        if (test(id, kindOf(id))) out.push(id);
        return;
      case 'parent': {
        const p = N.parent(id);
        if (p !== 0 && test(p, kindOf(p))) out.push(p);
        return;
      }
      case 'ancestor': case 'ancestor-or-self':
        if (step.axis === 'ancestor-or-self' && test(id, kindOf(id))) out.push(id);
        for (let a = N.parent(id); a !== 0; a = N.parent(a)) if (test(a, kindOf(a))) out.push(a);
        return;
      case 'following-sibling':
        for (let s = N.nextSibling(id); s !== 0; s = N.nextSibling(s)) if (test(s, kindOf(s))) out.push(s);
        return;
      case 'preceding-sibling':
        for (let s = N.prevSibling(id); s !== 0; s = N.prevSibling(s)) if (test(s, kindOf(s))) out.push(s);
        return;
      case 'following': following(id, test, out); return;
      case 'preceding': preceding(id, test, out); return;
      case 'attribute': {
        if (kindOf(id) !== 1) return;
        let el = null;
        for (const name of N.attrNames(id)) {
          if (step.attr(id, name)) {
            if (el === null) el = wrap(id);
            out.push(L.attrNode(el, name));
          }
        }
        return;
      }
      default: // the namespace axis: namespace nodes are not part of this model
    }
  }
  // An attribute has no children, siblings or attributes; its parent is its element.
  function collectFromAttr(step, attr, out) {
    const test = step.tree;
    const oid = ownerId(attr);
    const self = step.test.k === 'node'; // the principal node type of these axes is element
    switch (step.axis) {
      case 'self': case 'descendant-or-self':
        if (self) out.push(attr);
        return;
      case 'parent':
        if (oid !== 0 && test(oid, 1)) out.push(oid);
        return;
      case 'ancestor': case 'ancestor-or-self':
        if (step.axis === 'ancestor-or-self' && self) out.push(attr);
        for (let a = oid; a !== 0; a = N.parent(a)) if (test(a, kindOf(a))) out.push(a);
        return;
      case 'following':
        // (after the element's subtree, like Blink and libxml2: the spec would also count its children)
        if (oid !== 0) following(oid, test, out);
        return;
      case 'preceding':
        if (oid !== 0) preceding(oid, test, out);
        return;
      default:
    }
  }
  function applyPredicate(list, pred) {
    const size = list.length;
    const out = [];
    for (let i = 0; i < size; i++) {
      const v = pred(list[i], i + 1, size);
      if (typeof v === 'number' ? v === i + 1 : toBool(v)) out.push(list[i]);
    }
    return out;
  }
  function stepFrom(step, node) {
    let list = [];
    collect(step, node, list);
    for (let i = 0; i < step.preds.length && list.length !== 0; i++) list = applyPredicate(list, step.preds[i]);
    if (step.reverse) list.reverse();
    return list;
  }
  // Without predicates, following:: of a set of nodes is the following:: of the one whose subtree
  // ends first (the last of a chain of nested ones), and preceding:: that of the last one.
  // Walking every input's axis instead is quadratic for `//b/following::li`.
  function reduceInputs(step, input) {
    if (step.preds.length !== 0 || (step.axis !== 'following' && step.axis !== 'preceding')) return input;
    for (let i = 0; i < input.length; i++) if (typeof input[i] !== 'number') return input;
    if (step.axis === 'preceding') return [input[input.length - 1]];
    let best = input[0];
    for (let i = 1; i < input.length; i++) if (N.contains(best, input[i])) best = input[i];
    return [best];
  }
  function evalStep(step, input) {
    if (input.length > 1) input = reduceInputs(step, input);
    if (input.length === 1) return stepFrom(step, input[0]);
    const out = [];
    for (let i = 0; i < input.length; i++) {
      const r = stepFrom(step, input[i]);
      for (let j = 0; j < r.length; j++) out.push(r[j]);
    }
    return step.keepsOrder ? out : docOrder(out);
  }

  // ---------------------------------------------------------------------------------------
  // Compiler: AST -> closures
  // ---------------------------------------------------------------------------------------
  function staticType(a) {
    switch (a.k) {
      case 'num': case 'arith': case 'neg': return 'number';
      case 'str': return 'string';
      case 'or': case 'and': case 'cmp': return 'boolean';
      case 'call': return a.def.type;
      default: return 'nodeset';
    }
  }
  // Does the value of `a` depend on the context position or size? (Conservative: it looks
  // inside nested predicates too.)
  function usesPosition(a) {
    switch (a.k) {
      case 'call': return a.name === 'position' || a.name === 'last' || a.args.some(usesPosition);
      case 'or': case 'and': case 'cmp': case 'arith': return usesPosition(a.a) || usesPosition(a.b);
      case 'neg': return usesPosition(a.a);
      case 'union': return a.list.some(usesPosition);
      case 'filter': return usesPosition(a.e) || a.preds.some(usesPosition);
      case 'path': return (a.start !== null && usesPosition(a.start)) || a.steps.some((s) => s.preds.some(usesPosition));
      default: return false;
    }
  }
  // A numeric predicate compares with the position.
  function positional(pred) { return staticType(pred) === 'number' || usesPosition(pred); }
  // `//x` is descendant-or-self::node()/child::x; where the predicates do not care about the
  // position, one descendant::x step selects the same nodes without visiting every node twice.
  function mergeDescendantSteps(steps) {
    const out = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i], next = steps[i + 1];
      if (s === DESCENDANT_OR_SELF && next !== undefined && next.axis === 'child' && !next.preds.some(positional)) {
        out.push({ axis: 'descendant', test: next.test, preds: next.preds });
        i++;
      } else out.push(s);
    }
    return out;
  }
  function compileStep(s) {
    const t = s.test;
    return {
      axis: s.axis,
      test: t,
      tree: treeTest(t),
      attr: t.k === 'name' ? (id, name) => attributeMatches(id, name, t)
        : t.k === 'node' ? (id, name) => !isNsDecl(id, name) : () => false,
      preds: s.preds.map(compile),
      reverse: REVERSE_AXES.has(s.axis),
      keepsOrder: ORDER_KEEPING_AXES.has(s.axis),
    };
  }
  function compilePath(a) {
    const steps = mergeDescendantSteps(a.steps).map(compileStep);
    const start = a.start === null ? null : compile(a.start);
    const abs = a.abs;
    return (n, p, s) => {
      let cur;
      if (start !== null) cur = nodeSetOf(start(n, p, s));
      else cur = [abs ? rootOf(n) : n];
      for (let i = 0; i < steps.length && cur.length !== 0; i++) cur = evalStep(steps[i], cur);
      return cur;
    };
  }
  function compile(a) {
    switch (a.k) {
      case 'num': case 'str': { const v = a.v; return () => v; }
      case 'or': { const x = compile(a.a), y = compile(a.b); return (n, p, s) => toBool(x(n, p, s)) || toBool(y(n, p, s)); }
      case 'and': { const x = compile(a.a), y = compile(a.b); return (n, p, s) => toBool(x(n, p, s)) && toBool(y(n, p, s)); }
      case 'cmp': { const op = a.op, x = compile(a.a), y = compile(a.b); return (n, p, s) => compare(op, x(n, p, s), y(n, p, s)); }
      case 'neg': { const x = compile(a.a); return (n, p, s) => -toNum(x(n, p, s)); }
      case 'arith': {
        const x = compile(a.a), y = compile(a.b);
        switch (a.op) {
          case '+': return (n, p, s) => toNum(x(n, p, s)) + toNum(y(n, p, s));
          case '-': return (n, p, s) => toNum(x(n, p, s)) - toNum(y(n, p, s));
          case 'mul': return (n, p, s) => toNum(x(n, p, s)) * toNum(y(n, p, s));
          case 'div': return (n, p, s) => toNum(x(n, p, s)) / toNum(y(n, p, s));
          default: return (n, p, s) => toNum(x(n, p, s)) % toNum(y(n, p, s)); // truncating, like mod
        }
      }
      case 'union': {
        const parts = a.list.map(compile);
        return (n, p, s) => {
          let all = nodeSetOf(parts[0](n, p, s));
          for (let i = 1; i < parts.length; i++) all = docOrder(all.concat(nodeSetOf(parts[i](n, p, s))));
          return all;
        };
      }
      case 'call': { const args = a.args.map(compile); return a.def.make(args); }
      case 'filter': {
        const e = compile(a.e), preds = a.preds.map(compile);
        return (n, p, s) => {
          let list = nodeSetOf(e(n, p, s));
          for (let i = 0; i < preds.length && list.length !== 0; i++) list = applyPredicate(list, preds[i]);
          return list;
        };
      }
      default: return compilePath(a);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Namespace resolvers (callback interface XPathNSResolver)
  // ---------------------------------------------------------------------------------------
  // A resolver is a function or an object with a lookupNamespaceURI method, consulted at
  // parse time. Whatever it throws is reported to the page (as an uncaught error) and the
  // prefix stays unresolved.
  function resolverFn(resolver) {
    if (resolver === null) return () => null;
    return function (prefix) {
      try {
        let f = resolver, self;
        if (typeof resolver !== 'function') {
          f = resolver.lookupNamespaceURI;
          self = resolver;
          if (typeof f !== 'function') throw new TypeError("The resolver's 'lookupNamespaceURI' is not a function.");
        }
        const r = Reflect.apply(f, self, [prefix]);
        return r === null || r === undefined ? null : `${r}`;
      } catch (e) {
        L.report(e);
        return null;
      }
    };
  }
  function compileExpression(src, resolver, where) {
    let ast;
    try {
      ast = parse(src, resolverFn(resolver));
    } catch (e) {
      if (e instanceof XPathError) {
        throw new DOMException(`${where}The string '${src}' ${e.namespace ? 'contains unresolvable namespaces' : 'is not a valid XPath expression'}.`,
          e.namespace ? 'NamespaceError' : 'SyntaxError');
      }
      if (e instanceof RangeError) throw new DOMException(`${where}The string '${src}' is too deeply nested.`, 'SyntaxError');
      throw e;
    }
    try {
      return compile(ast);
    } catch (e) {
      if (e instanceof RangeError) throw new DOMException(`${where}The string '${src}' is too deeply nested.`, 'SyntaxError');
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------
  // XPathResult
  // ---------------------------------------------------------------------------------------
  const ANY_TYPE = 0, NUMBER_TYPE = 1, STRING_TYPE = 2, BOOLEAN_TYPE = 3, UNORDERED_NODE_ITERATOR_TYPE = 4,
    ORDERED_NODE_ITERATOR_TYPE = 5, UNORDERED_NODE_SNAPSHOT_TYPE = 6, ORDERED_NODE_SNAPSHOT_TYPE = 7,
    ANY_UNORDERED_NODE_TYPE = 8, FIRST_ORDERED_NODE_TYPE = 9;
  const RESULT_CONSTANTS = { ANY_TYPE, NUMBER_TYPE, STRING_TYPE, BOOLEAN_TYPE, UNORDERED_NODE_ITERATOR_TYPE,
    ORDERED_NODE_ITERATOR_TYPE, UNORDERED_NODE_SNAPSHOT_TYPE, ORDERED_NODE_SNAPSHOT_TYPE, ANY_UNORDERED_NODE_TYPE,
    FIRST_ORDERED_NODE_TYPE };
  function wrapNode(n) { return typeof n === 'number' ? wrap(n) : n; }
  let isResult;
  class XPathResult {
    #type; #value; #pos; #tree; #attr;
    static { isResult = (o) => typeof o === 'object' && o !== null && #type in o; }
    constructor(token, type, value) {
      if (token !== INTERNAL) throw L.illegal();
      this.#type = type;
      this.#value = value;
      this.#pos = 0;
      // Iterators go stale when the document changes.
      this.#tree = state.tree;
      this.#attr = state.attr;
    }
    get resultType() { return this.#type; }
    get numberValue() {
      if (this.#type !== NUMBER_TYPE) throw new TypeError("Failed to read the 'numberValue' property from 'XPathResult': The result type is not a number.");
      return this.#value;
    }
    get stringValue() {
      if (this.#type !== STRING_TYPE) throw new TypeError("Failed to read the 'stringValue' property from 'XPathResult': The result type is not a string.");
      return this.#value;
    }
    get booleanValue() {
      if (this.#type !== BOOLEAN_TYPE) throw new TypeError("Failed to read the 'booleanValue' property from 'XPathResult': The result type is not a boolean.");
      return this.#value;
    }
    get singleNodeValue() {
      if (this.#type !== ANY_UNORDERED_NODE_TYPE && this.#type !== FIRST_ORDERED_NODE_TYPE) {
        throw new TypeError("Failed to read the 'singleNodeValue' property from 'XPathResult': The result type is not a single node.");
      }
      return this.#value.length === 0 ? null : wrapNode(this.#value[0]);
    }
    get invalidIteratorState() {
      if (this.#type !== UNORDERED_NODE_ITERATOR_TYPE && this.#type !== ORDERED_NODE_ITERATOR_TYPE) return false;
      return this.#tree !== state.tree || this.#attr !== state.attr;
    }
    get snapshotLength() {
      if (this.#type !== UNORDERED_NODE_SNAPSHOT_TYPE && this.#type !== ORDERED_NODE_SNAPSHOT_TYPE) {
        throw new TypeError("Failed to read the 'snapshotLength' property from 'XPathResult': The result type is not a snapshot.");
      }
      return this.#value.length;
    }
    iterateNext() {
      if (this.#type !== UNORDERED_NODE_ITERATOR_TYPE && this.#type !== ORDERED_NODE_ITERATOR_TYPE) {
        throw new TypeError("Failed to execute 'iterateNext' on 'XPathResult': The result type is not an iterator.");
      }
      if (this.invalidIteratorState) throw new DOMException("Failed to execute 'iterateNext' on 'XPathResult': The document has mutated since the result was returned.", 'InvalidStateError');
      return this.#pos < this.#value.length ? wrapNode(this.#value[this.#pos++]) : null;
    }
    snapshotItem(index) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'snapshotItem' on 'XPathResult': 1 argument required, but only 0 present.");
      if (this.#type !== UNORDERED_NODE_SNAPSHOT_TYPE && this.#type !== ORDERED_NODE_SNAPSHOT_TYPE) {
        throw new TypeError("Failed to execute 'snapshotItem' on 'XPathResult': The result type is not a snapshot.");
      }
      const i = Number(index) >>> 0;
      return i < this.#value.length ? wrapNode(this.#value[i]) : null;
    }
  }
  L.defineConstants([XPathResult, XPathResult.prototype], RESULT_CONSTANTS);
  // Turn an evaluation result into the requested type (ANY_TYPE: the natural one). Node-set
  // results are always in document order, which the "unordered" types allow.
  function makeResult(v, type, where) {
    if (type === NUMBER_TYPE) return new XPathResult(INTERNAL, type, toNum(v));
    if (type === STRING_TYPE) return new XPathResult(INTERNAL, type, toStr(v));
    if (type === BOOLEAN_TYPE) return new XPathResult(INTERNAL, type, toBool(v));
    if (type >= UNORDERED_NODE_ITERATOR_TYPE && type <= FIRST_ORDERED_NODE_TYPE) {
      if (!isSet(v)) throw new TypeError(`${where}The result is not a node set, and therefore cannot be converted to the desired type.`);
      return new XPathResult(INTERNAL, type, v);
    }
    // Any other value (ANY_TYPE, or a number no type has) keeps the natural type.
    if (isSet(v)) return new XPathResult(INTERNAL, UNORDERED_NODE_ITERATOR_TYPE, v);
    return new XPathResult(INTERNAL, typeof v === 'number' ? NUMBER_TYPE : typeof v === 'string' ? STRING_TYPE : BOOLEAN_TYPE, v);
  }

  // ---------------------------------------------------------------------------------------
  // Entry points: XPathExpression, XPathEvaluatorBase (Document, XPathEvaluator)
  // ---------------------------------------------------------------------------------------
  function argCount(args, n, method, iface) {
    if (args.length < n) throw new TypeError(`Failed to execute '${method}' on '${iface}': ${n} argument${n === 1 ? '' : 's'} required, but only ${args.length} present.`);
  }
  function isAnyNode(o) { return isNode(o) || L.isAttr(o); }
  function toContext(v, method, iface, index) {
    if (!isAnyNode(v)) throw new TypeError(`Failed to execute '${method}' on '${iface}': parameter ${index} is not of type 'Node'.`);
    return v;
  }
  function toResolver(v, method, iface, index) {
    if (v === null || v === undefined) return null;
    if (!L.isObj(v)) throw new TypeError(`Failed to execute '${method}' on '${iface}': parameter ${index} is not of type 'XPathNSResolver'.`);
    return v;
  }
  function toResultArg(v, method, iface, index) {
    if (v !== null && v !== undefined && !isResult(v)) {
      throw new TypeError(`Failed to execute '${method}' on '${iface}': parameter ${index} is not of type 'XPathResult'.`);
    }
  }
  // Evaluate a compiled expression with the context node `ctx` (a node wrapper or an Attr).
  function runExpression(fn, ctx, type, method, iface) {
    const where = `Failed to execute '${method}' on '${iface}': `;
    let node, doc;
    if (L.isAttr(ctx)) {
      const owner = L.attrOwner(ctx);
      node = ctx;
      doc = owner === null ? L.document : L.ownerDocumentOf(owner);
    } else {
      const t = typeOf(ctx);
      if (t === 10 || t === 11) {
        throw new DOMException(`${where}The node provided is '${ctx.nodeName}', which is not a valid context node type.`, 'NotSupportedError');
      }
      node = idOf(ctx);
      doc = t === 9 ? ctx : L.ownerDocumentOf(ctx);
    }
    const prevHtml = htmlMode;
    // In an HTML document, names are matched the way HTML does (see elementMatches).
    htmlMode = L.docState.get(doc).contentType === 'text/html';
    let v;
    try {
      v = fn(node, 1, 1);
    } finally {
      htmlMode = prevHtml;
    }
    return makeResult(v, type, where);
  }
  class XPathExpression {
    #fn;
    constructor(token, fn) {
      if (token !== INTERNAL) throw L.illegal();
      this.#fn = fn;
    }
    evaluate(contextNode, type = 0, result = null) {
      argCount(arguments, 1, 'evaluate', 'XPathExpression');
      const fn = this.#fn;
      toContext(contextNode, 'evaluate', 'XPathExpression', 1);
      const t = Number(type) & 0xffff;
      toResultArg(result, 'evaluate', 'XPathExpression', 3);
      return runExpression(fn, contextNode, t, 'evaluate', 'XPathExpression');
    }
  }
  const evaluators = new WeakSet();
  function baseMethods(iface, isThis) {
    const brand = (self, method) => {
      if (!isThis(self)) throw new TypeError(`Failed to execute '${method}' on '${iface}': Illegal invocation`);
    };
    return {
      createExpression(expression, resolver = null) {
        brand(this, 'createExpression');
        argCount(arguments, 1, 'createExpression', iface);
        const src = `${expression}`;
        const r = toResolver(resolver, 'createExpression', iface, 2);
        return new XPathExpression(INTERNAL, compileExpression(src, r, `Failed to execute 'createExpression' on '${iface}': `));
      },
      createNSResolver(nodeResolver) {
        brand(this, 'createNSResolver');
        argCount(arguments, 1, 'createNSResolver', iface);
        return toContext(nodeResolver, 'createNSResolver', iface, 1);
      },
      evaluate(expression, contextNode, resolver = null, type = 0, result = null) {
        brand(this, 'evaluate');
        argCount(arguments, 2, 'evaluate', iface);
        const src = `${expression}`;
        toContext(contextNode, 'evaluate', iface, 2);
        const r = toResolver(resolver, 'evaluate', iface, 3);
        const t = Number(type) & 0xffff;
        toResultArg(result, 'evaluate', iface, 5);
        const fn = compileExpression(src, r, `Failed to execute 'evaluate' on '${iface}': `);
        return runExpression(fn, contextNode, t, 'evaluate', iface);
      },
    };
  }
  class XPathEvaluator {
    constructor() { evaluators.add(this); }
  }
  L.mixin(XPathEvaluator.prototype, baseMethods('XPathEvaluator', (o) => evaluators.has(o)));
  L.mixin(L.Document.prototype, baseMethods('Document', (o) => L.isDocument(o)));

  L.expose('XPathResult', XPathResult);
  L.expose('XPathExpression', XPathExpression);
  L.expose('XPathEvaluator', XPathEvaluator);
  Object.assign(L, { XPathResult, XPathExpression, XPathEvaluator });
})(globalThis.__layer);
