// 00_prelude.js — first file of the JS DOM/Web-API layer.
//
// Captures the hidden native bridge (`__native`), removes it from the global object and
// creates the shared, layer-private registry `L` that the following files extend.
// `L` is reachable only through `globalThis.__layer`, which 90_bootstrap.js deletes.
// Nothing defined here is visible to page scripts.
(function () {
  'use strict';
  const g = globalThis;
  const N = g.__native;
  if (N === undefined || N === null) throw new Error('JS layer: __native is not installed');
  if (!Reflect.deleteProperty(g, '__native')) {
    try { g.__native = undefined; } catch (_) { /* best effort */ }
  }

  const L = Object.create(null);
  Object.defineProperty(g, '__layer', { value: L, configurable: true, enumerable: false, writable: true });
  L.N = N;
  L.global = g;

  // ---------------------------------------------------------------------------------------
  // Captured intrinsics (pages sometimes replace Promise, e.g. zone.js)
  // ---------------------------------------------------------------------------------------
  const NativePromise = Promise;
  const promiseThen = Promise.prototype.then;
  const resolved = NativePromise.resolve();
  L.Promise = NativePromise;
  L.promiseThen = promiseThen;
  L.newPromise = function (executor) { return new NativePromise(executor); };
  L.resolvedPromise = function (v) { return NativePromise.resolve(v); };
  L.rejectedPromise = function (e) { return NativePromise.reject(e); };
  // Queue a microtask; exceptions are reported, never turned into unhandled rejections.
  L.microtask = function (fn) {
    promiseThen.call(resolved, function () {
      try { fn(); } catch (e) { L.report(e); }
    });
  };
  const nativeFunctionToString = Function.prototype.toString;
  L.nativeFunctionToString = nativeFunctionToString;

  // ---------------------------------------------------------------------------------------
  // DOMException
  // ---------------------------------------------------------------------------------------
  const DOMEXC_CODES = {
    IndexSizeError: 1, DOMStringSizeError: 2, HierarchyRequestError: 3, WrongDocumentError: 4,
    InvalidCharacterError: 5, NoDataAllowedError: 6, NoModificationAllowedError: 7, NotFoundError: 8,
    NotSupportedError: 9, InUseAttributeError: 10, InvalidStateError: 11, SyntaxError: 12,
    InvalidModificationError: 13, NamespaceError: 14, InvalidAccessError: 15, ValidationError: 16,
    TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21,
    QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25,
  };
  const DOMEXC_CONSTANTS = {
    INDEX_SIZE_ERR: 1, DOMSTRING_SIZE_ERR: 2, HIERARCHY_REQUEST_ERR: 3, WRONG_DOCUMENT_ERR: 4,
    INVALID_CHARACTER_ERR: 5, NO_DATA_ALLOWED_ERR: 6, NO_MODIFICATION_ALLOWED_ERR: 7, NOT_FOUND_ERR: 8,
    NOT_SUPPORTED_ERR: 9, INUSE_ATTRIBUTE_ERR: 10, INVALID_STATE_ERR: 11, SYNTAX_ERR: 12,
    INVALID_MODIFICATION_ERR: 13, NAMESPACE_ERR: 14, INVALID_ACCESS_ERR: 15, VALIDATION_ERR: 16,
    TYPE_MISMATCH_ERR: 17, SECURITY_ERR: 18, NETWORK_ERR: 19, ABORT_ERR: 20, URL_MISMATCH_ERR: 21,
    QUOTA_EXCEEDED_ERR: 22, TIMEOUT_ERR: 23, INVALID_NODE_TYPE_ERR: 24, DATA_CLONE_ERR: 25,
  };
  class DOMException extends Error {
    #name;
    #code;
    constructor(message = '', name = 'Error') {
      super(`${message}`);
      this.#name = `${name}`;
      this.#code = DOMEXC_CODES[this.#name] || 0;
    }
    get name() { return this.#name; }
    get code() { return this.#code; }
  }
  for (const k in DOMEXC_CONSTANTS) {
    Object.defineProperty(DOMException, k, { value: DOMEXC_CONSTANTS[k], enumerable: true });
    Object.defineProperty(DOMException.prototype, k, { value: DOMEXC_CONSTANTS[k], enumerable: true });
  }
  L.DOMException = DOMException;
  L.domErr = function (name, message) { return new DOMException(message || '', name); };

  // Convert an exception thrown by a native function ("HierarchyRequestError: ...") into
  // a DOMException (or a proper TypeError/RangeError).
  const NATIVE_ERR_RE = /^([A-Za-z]+Error):\s?([\s\S]*)$/;
  // DOMException names without a legacy code.
  const MODERN_DOMEXC = ['EncodingError', 'NotReadableError', 'UnknownError', 'ConstraintError', 'DataError',
    'TransactionInactiveError', 'ReadOnlyError', 'VersionError', 'OperationError', 'NotAllowedError'];
  L.fromNative = function (e) {
    if (e instanceof DOMException) return e;
    const msg = e && typeof e.message === 'string' ? e.message : null;
    if (msg !== null) {
      const m = NATIVE_ERR_RE.exec(msg);
      if (m) {
        if (m[1] in DOMEXC_CODES || MODERN_DOMEXC.includes(m[1])) return new DOMException(m[2], m[1]);
        if (m[1] === 'TypeError') return new TypeError(m[2]);
        if (m[1] === 'RangeError') return new RangeError(m[2]);
      }
    }
    return e;
  };

  // ---------------------------------------------------------------------------------------
  // Node branding: every node wrapper carries a truly private (#) node id, local name and
  // namespace code, stamped onto an object created with Object.create(proto).
  // ---------------------------------------------------------------------------------------
  class StampBase { constructor(o) { return o; } }
  // `#rm` marks the realm: the private names may be shared by the realms (V8 contexts)
  // of one page, and a node id only means something in its own realm's document.
  class NodeStamp extends StampBase {
    #id; #t; #ln; #ns; #rm;
    constructor(o, id, t, ln, ns) { super(o); this.#id = id; this.#t = t; this.#ln = ln; this.#ns = ns; this.#rm = L; }
    static id(o) { return o.#id; }
    static type(o) { return o.#t; }
    static ln(o) { return o.#ln; }
    static ns(o) { return o.#ns; }
    static is(o) { return typeof o === 'object' && o !== null && #id in o && o.#rm === L; }
    static setNs(o, ns) { o.#ns = ns; }
  }
  // o: wrapper object, id: native node id, t: nodeType, ln: local name ('' for non-elements),
  // ns: namespace code (see L.nsCode)
  L.stamp = function (o, id, t, ln, ns) { new NodeStamp(o, id, t, ln, ns); return o; };
  L.idOf = NodeStamp.id;          // throws TypeError for non-nodes ("illegal invocation")
  L.typeOf = NodeStamp.type;
  L.lnOf = NodeStamp.ln;
  L.nsOf = NodeStamp.ns;
  L.isNode = NodeStamp.is;
  L.setStampNs = NodeStamp.setNs;
  // The nodeType of a node wrapper of another realm of this page (0: not one).
  L.foreignNodeType = function (o) {
    if (typeof o !== 'object' || o === null || typeof N.foreignNodeType !== 'function') return 0;
    try { return N.foreignNodeType(o) | 0; } catch (_) { return 0; }
  };
  L.nodeArg = function (o, method, n) {
    if (NodeStamp.is(o)) return NodeStamp.id(o);
    throw new TypeError(`Failed to execute '${method || 'operation'}': parameter ${n || 1} is not of type 'Node'.`);
  };
  L.nodeArgOrNull = function (o, method, n) {
    if (o === null || o === undefined) return 0;
    return L.nodeArg(o, method, n);
  };

  // Namespace codes stored in the stamp.
  const NS = {
    HTML: 'http://www.w3.org/1999/xhtml',
    SVG: 'http://www.w3.org/2000/svg',
    MATHML: 'http://www.w3.org/1998/Math/MathML',
    XLINK: 'http://www.w3.org/1999/xlink',
    XML: 'http://www.w3.org/XML/1998/namespace',
    XMLNS: 'http://www.w3.org/2000/xmlns/',
  };
  L.NS = NS;
  L.NS_HTML = 0; L.NS_SVG = 1; L.NS_MATHML = 2; L.NS_OTHER = 3; L.NS_NONE = 4;
  L.nsCode = function (uri) {
    if (uri === NS.HTML || uri === '') return 0;
    if (uri === NS.SVG) return 1;
    if (uri === NS.MATHML) return 2;
    if (uri === null || uri === undefined) return 4;
    return 3;
  };
  L.nsURIOfCode = [NS.HTML, NS.SVG, NS.MATHML, null, null];

  // Wrapper cache: node id -> wrapper (identity guarantee). Wrappers are never evicted,
  // see README "Known gaps".
  const cache = new Map();
  L.cache = cache;
  L.createWrapper = null; // installed by 20_dom.js
  L.wrap = function wrap(id) {
    if (id === 0) return null;
    const w = cache.get(id);
    return w !== undefined ? w : L.createWrapper(id);
  };
  L.wrapAll = function (ids) {
    const out = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) out[i] = L.wrap(ids[i]);
    return out;
  };

  // Mutation epochs used to validate caches of live collections.
  //  tree: child-list changes anywhere, attr: attribute changes anywhere,
  //  untracked: child-list changes not recorded per parent (see `childVer` in 20_dom.js).
  L.state = { tree: 1, attr: 1, untracked: 1 };
  L.bumpAll = function () { L.state.tree++; L.state.attr++; L.state.untracked++; };
  // A child-list change that is not attributed to specific parents.
  L.treeChanged = function () { L.state.tree++; L.state.untracked++; };

  // ---------------------------------------------------------------------------------------
  // Error reporting (replaced by the full implementation in 90_bootstrap.js)
  // ---------------------------------------------------------------------------------------
  L.errToString = function (e) {
    try {
      if (e !== null && typeof e === 'object') {
        const st = e.stack;
        if (typeof st === 'string' && st.length) {
          const head = `${e.name}: ${e.message}`;
          return st.indexOf(head) === 0 || st.indexOf(`${e.name}`) === 0 ? st : `${head}\n${st}`;
        }
        if ('message' in e) return `${e.name || 'Error'}: ${e.message}`;
      }
      return String(e);
    } catch (_) {
      return '[exception]';
    }
  };
  L.report = function (e) {
    try { N.log('error', 'Uncaught ' + L.errToString(e)); } catch (_) { /* ignore */ }
  };
  // Run a callback, reporting (not propagating) exceptions.
  L.safeCall = function (fn, thisArg, args) {
    try { return Reflect.apply(fn, thisArg, args || []); } catch (e) { L.report(e); return undefined; }
  };

  // ---------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------
  const UPPER_RE = /[A-Z]/;
  L.asciiLower = function (s) { return UPPER_RE.test(s) ? s.replace(/[A-Z]+/g, (c) => c.toLowerCase()) : s; };
  const LOWER_RE = /[a-z]/;
  L.asciiUpper = function (s) { return LOWER_RE.test(s) ? s.replace(/[a-z]+/g, (c) => c.toUpperCase()) : s; };
  const WS_SPLIT = /[\t\n\f\r ]+/;
  L.splitWS = function (s) {
    if (s === '') return [];
    const parts = s.split(WS_SPLIT);
    if (parts[0] === '') parts.shift();
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  L.stripWS = function (s) { return s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''); };
  L.collapseWS = function (s) { return L.stripWS(s.replace(/[\t\n\f\r ]+/g, ' ')); };
  L.isASCIIWS = function (c) { return c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r'; };
  L.toLong = function (v) { return Number(v) | 0; };
  L.toULong = function (v) { return Number(v) >>> 0; };
  L.toUSV = typeof String.prototype.toWellFormed === 'function'
    ? function (v) { return `${v}`.toWellFormed(); }
    : function (v) { return `${v}`.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, (m) => m.length === 2 ? m[0] + '�' : '�'); };
  L.isObj = function (v) { return (typeof v === 'object' && v !== null) || typeof v === 'function'; };

  // CSS.escape (https://drafts.csswg.org/cssom/#serialize-an-identifier)
  L.cssEscape = function (value) {
    const s = `${value}`;
    const len = s.length;
    let out = '';
    const first = s.charCodeAt(0);
    for (let i = 0; i < len; i++) {
      const c = s.charCodeAt(i);
      if (c === 0) { out += '�'; continue; }
      if ((c >= 0x1 && c <= 0x1f) || c === 0x7f ||
          (i === 0 && c >= 0x30 && c <= 0x39) ||
          (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2d)) {
        out += '\\' + c.toString(16) + ' ';
        continue;
      }
      if (i === 0 && len === 1 && c === 0x2d) { out += '\\' + s.charAt(i); continue; }
      if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
        out += s.charAt(i);
        continue;
      }
      out += '\\' + s.charAt(i);
    }
    return out;
  };
  L.cssString = function (s) { return '"' + `${s}`.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ') + '"'; };

  // ---------------------------------------------------------------------------------------
  // Interface plumbing
  // ---------------------------------------------------------------------------------------
  // Everything exposed on the global object is collected here and installed by bootstrap.
  L.exposed = [];
  L.expose = function (name, value) { L.exposed.push([name, value]); return value; };
  // Internal-construction token for classes whose constructors are "Illegal" for pages.
  L.INTERNAL = Object.freeze(Object.create(null));
  L.illegal = function () { return new TypeError('Illegal constructor'); };

  // Copy accessors/methods from a descriptor source onto one or more prototypes
  // (used for mixins such as ParentNode / ChildNode).
  L.mixin = function (targets, source) {
    const descs = Object.getOwnPropertyDescriptors(source);
    for (const t of Array.isArray(targets) ? targets : [targets]) {
      for (const k of Reflect.ownKeys(descs)) {
        const d = descs[k];
        d.enumerable = typeof k === 'string';
        d.configurable = true;
        Object.defineProperty(t, k, d);
      }
    }
  };
  L.defineConstants = function (targets, consts) {
    for (const t of targets) {
      for (const k in consts) Object.defineProperty(t, k, { value: consts[k], enumerable: true });
    }
  };
  // Replace an accessor/method on a prototype
  L.defineGetter = function (proto, name, get, set) {
    Object.defineProperty(proto, name, { get, set, enumerable: true, configurable: true });
  };

  // Indexed-property support without Proxies: getters for "0".."n-1" are installed on the
  // prototype and grown on demand (whenever a `length` larger than the current capacity is
  // observed).
  const indexed = new Map();
  L.makeIndexed = function (proto, itemFn, initial) {
    const rec = { n: 0, itemFn };
    indexed.set(proto, rec);
    growIndexed(proto, rec, initial || 64);
  };
  function growIndexed(proto, rec, n) {
    for (let i = rec.n; i < n; i++) {
      Object.defineProperty(proto, i, {
        get: function () { return rec.itemFn(this, i); },
        enumerable: false,
        configurable: true,
      });
    }
    rec.n = n;
  }
  L.ensureIndexed = function (proto, n) {
    const rec = indexed.get(proto);
    if (rec !== undefined && n > rec.n) growIndexed(proto, rec, Math.max(n, rec.n * 2));
  };

  // Functions of the layer print as native code (see bootstrap).
  L.nativeFns = new WeakSet();

  // Event handler content attribute names that are compiled lazily.
  L.log = function (level, msg) { try { N.log(level, msg); } catch (_) { /* ignore */ } };
})();
