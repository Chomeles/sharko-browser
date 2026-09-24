'use strict';
// mock_native.js — a JavaScript implementation of the `__native` contract (NATIVE_API.md)
// for testing the JS layer in Node. It keeps a real node tree (parse5 for parsing,
// css-select for selectors), fake layout, a fake clock (timers/frames/network events are
// driven by the test harness) and a fake network map.
//
// All values handed to the layer (arrays, ArrayBuffers, errors, promises) are created in
// the vm context's realm, exactly like V8 would do for the real engine.

const vm = require('vm');
const path = require('path');
const nodeCrypto = require('crypto');
const parse5 = require('parse5');
const CSSselect = require('css-select');

const NS_HTML = 'http://www.w3.org/1999/xhtml';
const NS_SVG = 'http://www.w3.org/2000/svg';
const NS_MATHML = 'http://www.w3.org/1998/Math/MathML';
const VOID = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAWTEXT = new Set(['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'noscript']);
const BLOCK = new Set(['html', 'body', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'dd', 'dt', 'form',
  'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'blockquote', 'pre', 'address', 'figure',
  'figcaption', 'fieldset', 'hr', 'details', 'summary', 'dialog', 'legend', 'center', 'menu', 'search', 'hgroup']);
const HIDDEN_TAGS = new Set(['head', 'script', 'style', 'title', 'meta', 'link', 'template', 'base', 'noscript', 'datalist', 'param']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class MockNative {
  constructor(opts = {}) {
    this.opts = opts;
    this.url = opts.url || 'https://example.com/';
    this.clock = 0;
    this.origin = 1700000000000;
    this.nodes = new Map();
    this.nextId = 1;
    this.events = []; // {due, seq, kind, ...}
    this.seq = 0;
    this.frameRequested = false;
    this.lastFrame = 0;
    this.routes = opts.routes || {};
    this.requests = [];
    this.logs = [];
    this.navigations = [];
    this.submissions = [];
    this.defaultActions = [];
    this.titles = [];
    this.scrolledIntoView = [];
    this.scrollIntoViewArgs = [];
    this.opened = [];
    this.storage = [new Map(), new Map()];
    this.cookies = new Map();
    this.vp = { w: 1280, h: 720, dpr: 1, sx: 0, sy: 0, sw: 1920, sh: 1080 };
    this.rects = new Map();
    this.scroll = new Map();
    this.images = new Map();
    this.focused = 0;
    this.hist = [{ url: this.url }];
    this.histIndex = 0;
    this.hooks = null;
    this.pendingResources = 0;
    this.blobURLs = new Map();
    this.ctx = vm.createContext({});
    this.R = vm.runInContext('({Array, ArrayBuffer, Uint8Array, Error, TypeError, RangeError, Promise, Object})', this.ctx);
    this.cloneInRealm = vm.runInContext(CLONE_SRC, this.ctx);
    this.templateContents = new Map();
    this.shadowHosts = new Set(); // ids passed to N.setShadowHost(id, true)
    this.definedIds = new Set(); // ids passed to N.setDefined(id)
    this.docId = this.createNode({ type: 9 });
    this.verbose = !!process.env.VERBOSE;
  }

  // ------------------------------------------------------------------ realm helpers
  arr(list) { const a = new this.R.Array(); for (const x of list) a.push(x); return a; }
  ab(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const ab = new this.R.ArrayBuffer(b.length);
    new this.R.Uint8Array(ab).set(b);
    return ab;
  }
  err(name, msg) { return new this.R.Error(`${name}: ${msg}`); }
  bytesOf(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === 'string') return Buffer.from(x, 'utf8');
    if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') return Buffer.from(new Uint8Array(x));
    if (ArrayBuffer.isView(x)) return Buffer.from(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
    return Buffer.from(String(x));
  }

  // ------------------------------------------------------------------ node store
  createNode(fields) {
    const id = this.nextId++;
    const n = Object.assign({ id, type: 1, name: '', ns: '', attrs: [], parent: 0, children: [], data: '', state: {} }, fields);
    this.nodes.set(id, n);
    return id;
  }
  n(id) {
    const x = this.nodes.get(id);
    if (!x) throw this.err('NotFoundError', `no node with id ${id}`);
    return x;
  }
  // O(1) sibling iteration like Rust's sibling hint: remember the last index looked up
  indexInParent(list, id) {
    const h = this.sibHint;
    if (h !== undefined && h.list === list) {
      for (const d of [0, 1, -1]) { const j = h.i + d; if (list[j] === id) { h.i = j; return j; } }
    }
    const i = list.indexOf(id);
    this.sibHint = { list, i };
    return i;
  }
  attr(n, name) { const a = n.attrs.find((x) => x.name === name); return a ? a.value : null; }
  isAncestorOrSelf(a, b) { // a is an inclusive ancestor of b
    for (let x = b; x; x = this.nodes.get(x).parent) if (x === a) return true;
    return false;
  }
  detach(cid) {
    const c = this.n(cid);
    if (c.parent) {
      const p = this.n(c.parent);
      const last = p.children.length - 1;
      const i = p.children[last] === cid ? last : this.indexInParent(p.children, cid);
      if (i >= 0) p.children.splice(i, 1);
      c.parent = 0;
    }
  }
  // Like Rust: parsed template contents are children of the <template> until
  // N.templateContent(id) moves them into a DocumentFragment (created on demand).
  templateContentOf(tid) {
    const f = this.templateContents.get(tid);
    if (f !== undefined && this.nodes.has(f)) return f;
    const frag = this.createNode({ type: 11 });
    for (const c of this.n(tid).children.slice()) this.appendRaw(frag, c);
    this.templateContents.set(tid, frag);
    return frag;
  }
  // opts.noTemplateSupport: a native without any template-contents model (no N.templateContent)
  isTemplate(n) { return !this.opts.noTemplateSupport && n.type === 1 && n.name === 'template' && n.ns === NS_HTML; }
  templateContainer(id) { const f = this.templateContents.get(id); return f === undefined ? id : f; }
  appendRaw(pid, cid) {
    this.detach(cid);
    this.n(pid).children.push(cid);
    this.n(cid).parent = pid;
  }
  connected(id) {
    let x = id;
    while (x) { if (x === this.docId) return true; x = this.nodes.get(x).parent; }
    return false;
  }
  textOf(n) {
    if (n.type === 3) return n.data;
    if (n.type === 8 || n.type === 10) return '';
    let s = '';
    for (const c of n.children) { const cn = this.n(c); if (cn.type === 3) s += cn.data; else if (cn.type === 1 || cn.type === 11) s += this.textOf(cn); }
    return s;
  }

  // ------------------------------------------------------------------ parsing / serialization
  convert(p5, parentId) {
    for (const c of p5.childNodes || []) {
      let id;
      if (c.nodeName === '#text') id = this.createNode({ type: 3, data: c.value });
      else if (c.nodeName === '#comment') id = this.createNode({ type: 8, data: c.data });
      else if (c.nodeName === '#documentType') {
        // like blitz-html, the parser drops the doctype (opts.keepDoctype keeps it)
        if (!this.opts.keepDoctype) continue;
        id = this.createNode({ type: 10, name: c.name });
      }
      else {
        const attrs = c.attrs.map((a) => ({ name: a.prefix ? a.prefix + ':' + a.name : a.name, value: a.value }));
        id = this.createNode({ type: 1, name: c.tagName, ns: c.namespaceURI || NS_HTML, attrs });
        // Like Rust: the parser puts template contents into the content fragment
        // (opts.legacyTemplates: contents stay children until N.templateContent is called).
        if (c.tagName === 'template' && c.content) this.convert(c.content, this.opts.legacyTemplates || this.opts.noTemplateSupport ? id : this.templateContentOf(id));
        else this.convert(c, id);
      }
      this.appendRaw(parentId, id);
    }
  }
  loadDocument(html) {
    const d = parse5.parse(html);
    const dt = (d.childNodes || []).find((c) => c.nodeName === '#documentType');
    this.mainDoctype = dt ? [dt.name, dt.publicId || '', dt.systemId || ''] : null;
    this.convert(d, this.docId);
  }
  fragmentContext(ctxNode) {
    const name = ctxNode && ctxNode.type === 1 ? ctxNode.name : 'body';
    const ns = ctxNode && ctxNode.type === 1 ? ctxNode.ns : NS_HTML;
    return parse5.defaultTreeAdapter.createElement(name, ns, []);
  }
  parseInto(html, ctxNode, targetId) {
    const f = parse5.parseFragment(this.fragmentContext(ctxNode), String(html));
    this.convert(f, targetId);
  }
  escText(s) { return s.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  escAttr(s) { return s.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/"/g, '&quot;'); }
  serialize(id, parentName) {
    const n = this.n(id);
    switch (n.type) {
      case 1: {
        let s = '<' + n.name;
        for (const a of n.attrs) s += ' ' + a.name + '="' + this.escAttr(a.value) + '"';
        s += '>';
        if (n.ns === NS_HTML && VOID.has(n.name)) return s;
        let inner = this.serializeChildren(id);
        if ((n.name === 'pre' || n.name === 'textarea' || n.name === 'listing') && n.children.length) {
          const first = this.n(n.children[0]);
          if (first.type === 3 && first.data.startsWith('\n')) inner = '\n' + inner;
        }
        return s + inner + '</' + n.name + '>';
      }
      case 3: return RAWTEXT.has(parentName) ? n.data : this.escText(n.data);
      case 8: return '<!--' + n.data + '-->';
      case 10: return '<!DOCTYPE ' + (n.name || 'html') + '>';
      default: return this.serializeChildren(id);
    }
  }
  serializeChildren(id) {
    const n = this.n(id);
    const pname = n.type === 1 && n.ns === NS_HTML ? n.name : '';
    const kids = this.isTemplate(n) ? this.n(this.templateContainer(id)).children : n.children;
    let s = '';
    for (const c of kids) s += this.serialize(c, pname);
    return s;
  }

  // ------------------------------------------------------------------ selectors
  get adapter() {
    if (this._adapter) return this._adapter;
    const self = this;
    const kids = (n) => n.children.map((c) => self.nodes.get(c));
    const ad = {
      isTag: (n) => n.type === 1,
      existsOne: (test, elems) => elems.some((e) => e.type === 1 && (test(e) || ad.existsOne(test, kids(e)))),
      getAttributeValue: (e, name) => { const v = self.attr(e, name); return v === null ? undefined : v; },
      getChildren: (n) => kids(n),
      getName: (e) => e.name.toLowerCase(),
      getParent: (n) => (n.parent ? self.nodes.get(n.parent) : null),
      getSiblings: (n) => (n.parent ? kids(self.nodes.get(n.parent)) : [n]),
      getText: (n) => self.textOf(n),
      hasAttrib: (e, name) => self.attr(e, name) !== null,
      removeSubsets: (nodes) => nodes.filter((n, i) => nodes.indexOf(n) === i && !nodes.some((o) => o !== n && self.isAncestorOrSelf(o.id, n.id))),
      findAll: (test, nodes) => {
        const out = [];
        const walk = (list) => { for (const n of list) { if (n.type !== 1) continue; if (test(n)) out.push(n); walk(kids(n)); } };
        walk(nodes);
        return out;
      },
      findOne: (test, elems) => {
        for (const n of elems) {
          if (n.type !== 1) continue;
          if (test(n)) return n;
          const r = ad.findOne(test, kids(n));
          if (r) return r;
        }
        return null;
      },
      equals: (a, b) => a === b,
    };
    this._adapter = ad;
    return ad;
  }
  selOpts(ctx) {
    const self = this;
    return {
      adapter: this.adapter,
      xmlMode: false,
      relativeSelector: false,
      context: ctx && ctx.type === 1 ? ctx : undefined,
      cacheResults: false,
      pseudos: {
        focus: (el) => el.id === self.focused,
        'focus-visible': (el) => el.id === self.focused,
        'focus-within': (el) => self.focused !== 0 && self.isAncestorOrSelf(el.id, self.focused),
        defined: (el) => !el.name.includes('-'),
        'popover-open': () => false,
        indeterminate: (el) => !!el.state.indeterminate,
        'user-invalid': () => false,
        'user-valid': () => false,
        autofill: () => false,
        fullscreen: () => false,
        // live checkedness / selectedness (css-select's built-in :checked alias only looks at attributes)
        'mock-checked': (el) => {
          if (el.name === 'input') {
            const t = (self.attr(el, 'type') || '').toLowerCase();
            if (t !== 'checkbox' && t !== 'radio') return false;
            return el.state.checked !== undefined ? el.state.checked : self.attr(el, 'checked') !== null;
          }
          if (el.name === 'option') {
            let s = el.parent ? self.nodes.get(el.parent) : null;
            if (s && s.name === 'optgroup') s = s.parent ? self.nodes.get(s.parent) : null;
            if (!s || s.name !== 'select' || self.attr(s, 'multiple') !== null) return self.attr(el, 'selected') !== null;
            const i = self.selIndex(s.id);
            return self.options(s.id)[i] === el.id;
          }
          return false;
        },
      },
    };
  }
  fixSel(sel) { return String(sel).replace(/:checked(?![\w-])/g, ':mock-checked'); }
  sel(fn) {
    try { return fn(); } catch (e) {
      throw this.err('SyntaxError', `'${e && e.message ? e.message : e}' is not a valid selector`);
    }
  }

  // ------------------------------------------------------------------ styles (inline + <style> sheets)
  parseDecls(text) {
    const out = new Map();
    for (const part of String(text || '').split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const name = part.slice(0, i).trim().toLowerCase();
      let value = part.slice(i + 1).trim();
      let important = false;
      if (/!\s*important$/i.test(value)) { important = true; value = value.replace(/!\s*important$/i, '').trim(); }
      if (name && value !== '') out.set(name.startsWith('--') ? part.slice(0, i).trim() : name, { value, important });
    }
    return out;
  }
  inlineDecls(n) { return this.parseDecls(this.attr(n, 'style') || ''); }
  writeDecls(n, decls) {
    const s = Array.from(decls, ([k, v]) => `${k}: ${v.value}${v.important ? ' !important' : ''};`).join(' ');
    this.setAttrRaw(n, 'style', s);
  }
  setAttrRaw(n, name, value) {
    const a = n.attrs.find((x) => x.name === name);
    if (a) a.value = String(value); else n.attrs.push({ name, value: String(value) });
  }
  sheetRules() {
    const rules = [];
    const walk = (id) => {
      const n = this.n(id);
      if (n.type === 1 && n.name === 'style') {
        const text = this.textOf(n).replace(/\/\*[\s\S]*?\*\//g, '');
        const re = /([^{}@]+)\{([^{}]*)\}/g;
        let m;
        while ((m = re.exec(text)) !== null) rules.push({ sel: m[1].trim(), decls: this.parseDecls(m[2]) });
      }
      for (const c of n.children) walk(c);
    };
    walk(this.docId);
    return rules;
  }
  cascaded(id, prop) {
    const n = this.n(id);
    const inline = this.inlineDecls(n).get(prop);
    if (inline && inline.important) return inline.value;
    let found, foundImp = false;
    for (const r of this.sheetRules()) {
      const d = r.decls.get(prop);
      if (!d) continue;
      let ok = false;
      try { ok = CSSselect.is(n, this.fixSel(r.sel), this.selOpts()); } catch (_) { ok = false; }
      if (ok && (!foundImp || d.important)) { found = d.value; foundImp = d.important; }
    }
    if (inline && !foundImp) return inline.value;
    return found;
  }
  displayOf(id) {
    const n = this.n(id);
    if (n.type !== 1) return 'inline';
    const c = this.cascaded(id, 'display');
    if (c !== undefined) return c;
    if (n.ns === NS_HTML && this.attr(n, 'hidden') !== null) return 'none';
    if (n.ns !== NS_HTML) return n.name === 'svg' ? 'inline' : 'inline';
    if (HIDDEN_TAGS.has(n.name)) return 'none';
    if (BLOCK.has(n.name)) return 'block';
    if (n.name === 'li') return 'list-item';
    if (n.name === 'table') return 'table';
    if (n.name === 'tr') return 'table-row';
    if (n.name === 'td' || n.name === 'th') return 'table-cell';
    if (n.name === 'tbody') return 'table-row-group';
    if (n.name === 'thead') return 'table-header-group';
    if (n.name === 'tfoot') return 'table-footer-group';
    if (['input', 'button', 'select', 'textarea', 'img', 'canvas', 'video', 'iframe'].includes(n.name)) return 'inline-block';
    return 'inline';
  }
  rendered(id) {
    if (!this.connected(id)) return false;
    for (let x = id; x && x !== this.docId; x = this.n(x).parent) {
      if (this.n(x).type === 1 && this.displayOf(x) === 'none') return false;
    }
    return true;
  }
  rectOf(id) {
    const n = this.n(id);
    if (n.type !== 1 || !this.rendered(id)) return [0, 0, 0, 0];
    if (this.rects.has(id)) return this.rects.get(id).slice();
    const px = (p) => { const v = this.cascaded(id, p); const m = /^(-?[\d.]+)px$/.exec(v || ''); return m ? +m[1] : null; };
    const w = px('width'), h = px('height');
    return [px('left') || 0, px('top') || 0, w || 0, h || 0];
  }

  // ------------------------------------------------------------------ events for the harness
  schedule(due, kind, data) {
    const e = Object.assign({ due, seq: this.seq++, kind }, data);
    this.events.push(e);
    return e;
  }
  nextEvent() {
    let best = null;
    for (const e of this.events) if (best === null || e.due < best.due || (e.due === best.due && e.seq < best.seq)) best = e;
    return best;
  }
  log(level, msg) {
    this.logs.push([level, msg]);
    if (this.verbose) process.stdout.write(`    [${level}] ${msg}\n`);
  }
  route(url, method) {
    let r = this.routes[url];
    if (r === undefined) {
      const noHash = url.split('#')[0];
      r = this.routes[noHash];
      // cache-busting query strings (e.g. jQuery's `_=<timestamp>`) fall back to the bare path
      if (r === undefined) r = this.routes[noHash.split('?')[0]];
    }
    if (typeof r === 'function') r = r({ url, method });
    if (r === undefined && typeof this.routes['*'] === 'function') r = this.routes['*']({ url, method });
    if (r === undefined) return { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/plain' }, body: 'not found' };
    if (typeof r === 'string') return { status: 200, statusText: 'OK', headers: {}, body: r };
    return r;
  }
  responseParts(r, url) {
    let body = r.body === undefined ? '' : r.body;
    const headers = Object.assign({}, r.headers || {});
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      body = JSON.stringify(body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const flat = [];
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) for (const x of v) flat.push(k, String(x)); else flat.push(k, String(v));
    }
    return {
      status: r.status === undefined ? 200 : r.status,
      statusText: r.statusText === undefined ? (r.status === undefined || r.status === 200 ? 'OK' : '') : r.statusText,
      finalUrl: r.finalUrl || url,
      flat,
      body: body === null ? null : this.bytesOf(body),
      error: r.error || null,
    };
  }

  // ------------------------------------------------------------------ the __native object
  build() {
    const M = this;
    const nat = {
      documentId: () => M.docId,
      nodeType: (id) => M.n(id).type,
      localName: (id) => { const n = M.n(id); return n.type === 1 ? n.name : ''; },
      namespaceURI: (id) => { const n = M.n(id); return n.type === 1 ? n.ns : ''; },
      parent: (id) => M.n(id).parent,
      firstChild: (id) => { const c = M.n(id).children; return c.length ? c[0] : 0; },
      lastChild: (id) => { const c = M.n(id).children; return c.length ? c[c.length - 1] : 0; },
      nextSibling: (id) => {
        const n = M.n(id);
        if (!n.parent) return 0;
        const s = M.n(n.parent).children;
        const i = M.indexInParent(s, id);
        return i >= 0 && i + 1 < s.length ? s[i + 1] : 0;
      },
      prevSibling: (id) => {
        const n = M.n(id);
        if (!n.parent) return 0;
        const s = M.n(n.parent).children;
        const i = M.indexInParent(s, id);
        return i > 0 ? s[i - 1] : 0;
      },
      childIds: (id) => M.arr(M.n(id).children),
      childElementIds: (id) => M.arr(M.n(id).children.filter((c) => M.n(c).type === 1)),
      isConnected: (id) => M.connected(id),
      contains: (a, b) => M.isAncestorOrSelf(a, b),
      compareDocumentPosition: (a, b) => {
        if (a === b) return 0;
        const chain = (x) => { const out = []; for (let y = x; y; y = M.n(y).parent) out.unshift(y); return out; };
        const ca = chain(a), cb = chain(b);
        if (ca[0] !== cb[0]) return 1 | 32 | (a < b ? 4 : 2);
        if (cb.includes(a)) return 16 | 4; // b is a descendant of a
        if (ca.includes(b)) return 8 | 2; // b is an ancestor of a
        let i = 0;
        while (ca[i] === cb[i]) i++;
        const parent = M.n(ca[i - 1]);
        return parent.children.indexOf(ca[i]) < parent.children.indexOf(cb[i]) ? 4 : 2;
      },
      createElement: (localName, ns) => M.createNode({ type: 1, name: String(localName), ns: ns === '' ? NS_HTML : String(ns) }),
      createText: (data) => M.createNode({ type: 3, data: String(data) }),
      createComment: (data) => M.createNode({ type: 8, data: String(data) }),
      createFragment: () => M.createNode({ type: 11 }),
      cloneNode: (id, deep) => {
        const clone = (sid) => {
          const s = M.n(sid);
          const cid = M.createNode({ type: s.type, name: s.name, ns: s.ns, attrs: s.attrs.map((a) => ({ name: a.name, value: a.value })), data: s.data, state: Object.assign({}, s.state) });
          if (deep) {
            for (const c of s.children) { const cc = clone(c); M.appendRaw(cid, cc); }
            const sc = M.templateContents.get(sid);
            if (sc !== undefined && M.nodes.has(sc)) {
              const dc = M.templateContentOf(cid);
              for (const c of M.n(sc).children) M.appendRaw(dc, clone(c));
            }
          }
          return cid;
        };
        return clone(id);
      },
      templateContent: (id) => (M.isTemplate(M.n(id)) ? M.templateContentOf(id) : 0),
      setShadowHost: (id, on) => { M.n(id); if (on) M.shadowHosts.add(id); else M.shadowHosts.delete(id); },
      setDefined: (id) => { M.n(id); M.definedIds.add(id); },
      appendChild: (p, c) => nat.insertBefore(p, c, 0),
      insertBefore: (p, c, ref) => {
        const pn = M.n(p), cn = M.n(c);
        if (![1, 9, 11].includes(pn.type)) throw M.err('HierarchyRequestError', 'parent cannot have children');
        if (M.isAncestorOrSelf(c, p)) throw M.err('HierarchyRequestError', 'The new child element contains the parent.');
        if (ref && M.n(ref).parent !== p) throw M.err('NotFoundError', 'The node before which the new node is to be inserted is not a child of this node.');
        const list = cn.type === 11 ? cn.children.slice() : [c];
        for (const x of list) M.detach(x);
        const idx = ref ? pn.children.indexOf(ref) : pn.children.length;
        pn.children.splice(idx, 0, ...list);
        for (const x of list) M.n(x).parent = p;
        M.onInserted(list);
      },
      removeChild: (p, c) => {
        if (M.n(c).parent !== p) throw M.err('NotFoundError', 'The node to be removed is not a child of this node.');
        M.detach(c);
        if (M.focused && !M.connected(M.focused)) M.focused = 0;
      },
      replaceChild: (p, nw, old) => {
        if (M.n(old).parent !== p) throw M.err('NotFoundError', 'The node to be replaced is not a child of this node.');
        const next = nat.nextSibling(old);
        M.detach(old);
        nat.insertBefore(p, nw, next === nw ? nat.nextSibling(nw) : next);
      },
      getAttr: (id, name) => M.attr(M.n(id), name),
      setAttr: (id, name, value) => {
        const n = M.n(id);
        if (n.type !== 1) throw M.err('InvalidStateError', 'not an element');
        M.setAttrRaw(n, name, value);
        if (name === 'src' && n.name === 'img' && M.images.has(id)) M.images.delete(id);
      },
      removeAttr: (id, name) => { const n = M.n(id); n.attrs = n.attrs.filter((a) => a.name !== name); },
      hasAttr: (id, name) => M.attr(M.n(id), name) !== null,
      attrNames: (id) => M.arr(M.n(id).attrs.map((a) => a.name)),
      getText: (id) => M.n(id).data,
      setText: (id, data) => { M.n(id).data = String(data); },
      textContent: (id) => M.textOf(M.n(id)),
      setTextContent: (id, text) => {
        const n = M.n(id);
        for (const c of n.children.slice()) M.detach(c);
        if (text !== '') M.appendRaw(id, M.createNode({ type: 3, data: String(text) }));
      },
      innerHTML: (id) => M.serializeChildren(id),
      setInnerHTML: (id, html) => {
        const n = M.n(id);
        const target = M.isTemplate(n) ? M.templateContentOf(id) : id;
        const tn = M.n(target);
        for (const c of tn.children.slice()) M.detach(c);
        M.parseInto(html, n.type === 1 ? n : null, target);
        M.onInserted(tn.children.slice());
      },
      outerHTML: (id) => M.serialize(id, ''),
      parseHTMLFragment: (html) => {
        const f = M.createNode({ type: 11 });
        M.parseInto(html, null, f);
        return f;
      },
      querySelector: (scope, sel) => M.sel(() => { const s = M.n(scope); const r = CSSselect.selectOne(M.fixSel(sel), s, M.selOpts(s)); return r ? r.id : 0; }),
      querySelectorAll: (scope, sel) => M.sel(() => { const s = M.n(scope); return M.arr(CSSselect.selectAll(M.fixSel(sel), s, M.selOpts(s)).map((x) => x.id)); }),
      matches: (id, sel) => M.sel(() => CSSselect.is(M.n(id), M.fixSel(sel), M.selOpts(M.n(id)))),
      closest: (id, sel) => M.sel(() => {
        for (let x = id; x; x = M.n(x).parent) { const n = M.n(x); if (n.type === 1 && CSSselect.is(n, M.fixSel(sel), M.selOpts(n))) return x; }
        return 0;
      }),
      getElementById: (s) => {
        const walk = (id) => {
          const n = M.n(id);
          if (n.type === 1 && M.attr(n, 'id') === s) return id;
          for (const c of n.children) { const r = walk(c); if (r) return r; }
          return 0;
        };
        return walk(M.docId);
      },
      getBoundingClientRect: (id) => M.arr(M.rectOf(id)),
      getClientRects: (id) => M.arr(M.n(id).type === 1 && M.rendered(id) ? M.rectOf(id) : []),
      offsetMetrics: (id) => {
        const r = M.rectOf(id);
        let op = 0;
        if (M.rendered(id)) {
          for (let x = M.n(id).parent; x && x !== M.docId; x = M.n(x).parent) {
            const pos = M.cascaded(x, 'position');
            const nm = M.n(x).name;
            if ((pos && pos !== 'static') || nm === 'body' || nm === 'td' || nm === 'th' || nm === 'table') { op = x; break; }
          }
        }
        return M.arr([r[0], r[1], r[2], r[3], op]);
      },
      clientMetrics: (id) => { const r = M.rectOf(id); return M.arr([0, 0, r[2], r[3]]); },
      scrollMetrics: (id) => {
        const n = M.n(id);
        if (n.name === 'html' || n.name === 'body') return M.arr([M.vp.sx, M.vp.sy, M.vp.w, M.vp.h]);
        const s = M.scroll.get(id) || [0, 0];
        const r = M.rectOf(id);
        return M.arr([s[0], s[1], r[2], r[3]]);
      },
      setScroll: (id, l, t) => {
        const n = M.n(id);
        if (n.name === 'html' || n.name === 'body') { nat.scrollTo(l, t); return; }
        M.scroll.set(id, [l, t]);
      },
      scrollIntoView: (id, block, inline, behavior) => { M.scrolledIntoView.push(id); M.scrollIntoViewArgs.push([block, inline, behavior]); },
      elementFromPoint: (x, y) => {
        let found = 0;
        for (const [id, r] of M.rects) {
          if (M.connected(id) && x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]) found = id;
        }
        if (found) return found;
        const body = M.body();
        return body || 0;
      },
      viewport: () => M.arr([M.vp.w, M.vp.h, M.vp.dpr, M.vp.sx, M.vp.sy, M.vp.sw, M.vp.sh]),
      scrollTo: (x, y) => {
        M.vp.sx = Math.max(0, x);
        M.vp.sy = Math.max(0, y);
        M.schedule(M.clock, 'hook', { name: 'onScroll', args: [] });
      },
      styleGet: (id, prop) => { const d = M.inlineDecls(M.n(id)).get(prop); return d ? d.value : ''; },
      styleGetPriority: (id, prop) => { const d = M.inlineDecls(M.n(id)).get(prop); return d && d.important ? 'important' : ''; },
      styleSet: (id, prop, value, prio) => {
        const n = M.n(id);
        const decls = M.inlineDecls(n);
        if (value === '') decls.delete(prop);
        else {
          if (!prop.startsWith('--') && !M.cssSupported(prop, value)) return;
          decls.set(prop, { value: String(value), important: prio === 'important' });
        }
        M.writeDecls(n, decls);
      },
      styleRemove: (id, prop) => {
        const n = M.n(id);
        const decls = M.inlineDecls(n);
        const old = decls.get(prop);
        decls.delete(prop);
        if (old) M.writeDecls(n, decls);
        return old ? old.value : '';
      },
      styleCssText: (id) => Array.from(M.inlineDecls(M.n(id)), ([k, v]) => `${k}: ${v.value}${v.important ? ' !important' : ''};`).join(' '),
      styleSetCssText: (id, text) => { const n = M.n(id); M.writeDecls(n, M.parseDecls(text)); },
      styleLength: (id) => M.inlineDecls(M.n(id)).size,
      styleItem: (id, i) => { const k = Array.from(M.inlineDecls(M.n(id)).keys())[i]; return k === undefined ? '' : k; },
      computedStyle: (id, prop, pseudo) => M.computed(id, prop, pseudo),
      cssSupports: (prop, value) => M.cssSupported(String(prop), String(value)),
      matchMedia: (q) => M.evalMedia(String(q)),
      getValue: (id) => {
        const n = M.n(id);
        if (n.state.value !== undefined) return n.state.value;
        if (n.name === 'textarea') return M.textOf(n);
        if (n.name === 'select') {
          const i = nat.getSelectedIndex(id);
          const opts = M.options(id);
          if (i < 0 || !opts[i]) return '';
          const o = M.n(opts[i]);
          const v = M.attr(o, 'value');
          return v !== null ? v : M.textOf(o).trim();
        }
        const v = M.attr(n, 'value');
        return v === null ? '' : v.replace(/[\r\n]/g, '');
      },
      setValue: (id, v) => { M.n(id).state.value = String(v); },
      getChecked: (id) => { const n = M.n(id); return n.state.checked !== undefined ? n.state.checked : M.attr(n, 'checked') !== null; },
      setChecked: (id, b) => { M.n(id).state.checked = !!b; },
      setIndeterminate: (id, b) => { M.n(id).state.indeterminate = !!b; },
      getSelectedIndex: (id) => M.selIndex(id),
      setSelectedIndex: (id, i) => { const opts = M.options(id); M.n(id).state.selectedOption = i >= 0 && i < opts.length ? opts[i] : 0; },
      focus: (id) => {
        const n = M.n(id);
        if (!M.connected(id) || n.type !== 1) return;
        const focusable = M.attr(n, 'tabindex') !== null || M.attr(n, 'contenteditable') !== null ||
          (['input', 'select', 'textarea', 'button', 'iframe', 'summary'].includes(n.name) && M.attr(n, 'disabled') === null && !(n.name === 'input' && M.attr(n, 'type') === 'hidden')) ||
          ((n.name === 'a' || n.name === 'area') && M.attr(n, 'href') !== null);
        if (focusable && M.focused !== id) {
          const old = M.focused;
          M.focused = id;
          if (M.opts.nativeFocusEvents) M.fireFocusEvents(old, id);
        }
      },
      blur: (id) => {
        if (M.focused !== id) return;
        M.focused = 0;
        if (M.opts.nativeFocusEvents) M.fireFocusEvents(id, 0);
      },
      activeElement: () => M.focused,
      runDefaultAction: (id, type) => { M.defaultActions.push([id, type]); },
      submitForm: (formId, submitterId) => { M.submissions.push([formId, submitterId]); },
      evalScript: (source, url, isInline) => {
        try {
          return vm.runInContext(String(source), M.ctx, { filename: String(url) });
        } catch (e) {
          M.log('error', 'Uncaught ' + (e && e.stack ? e.stack : String(e)));
          throw e;
        }
      },
      runModule: (url, source) => new M.R.Promise((resolve, reject) => {
        M.schedule(M.clock, 'task', {
          fn: () => {
            let src = source;
            if (src === null || src === undefined) {
              const r = M.responseParts(M.route(String(url), 'GET'), String(url));
              if (r.error || r.status !== 200) { reject(new M.R.TypeError(`Failed to fetch dynamically imported module: ${url}`)); return; }
              src = r.body.toString('utf8');
            }
            try {
              vm.runInContext('(function(){"use strict";\n' + src + '\n}).call(undefined)', M.ctx, { filename: String(url) });
              resolve(undefined);
            } catch (e) { reject(e); }
          },
        });
      }),
      compileFunction: (body, argNames, url) => vm.compileFunction(String(body), Array.from(argNames, String), { parsingContext: M.ctx, filename: String(url) }),
      fetch: (reqId, method, url, headersFlat, body, mode, credentials, cache, redirect) => {
        const req = { reqId, method, url: String(url), headers: Array.from(headersFlat || []), body: body === null ? null : M.bytesOf(body), mode, credentials, cache, redirect };
        M.requests.push(req);
        const spec = M.route(req.url, method);
        const delay = spec && typeof spec === 'object' && spec.delay !== undefined ? spec.delay : 0;
        M.schedule(M.clock + delay, 'fetch', { reqId, spec, url: req.url });
      },
      abortFetch: (reqId) => { M.events = M.events.filter((e) => !(e.kind === 'fetch' && e.reqId === reqId)); },
      getCookie: () => Array.from(M.cookies, ([k, v]) => (k === '' ? v : `${k}=${v}`)).join('; '),
      setCookie: (str) => {
        const parts = String(str).split(';');
        const nv = parts[0];
        const i = nv.indexOf('=');
        const name = i < 0 ? '' : nv.slice(0, i).trim();
        const value = i < 0 ? nv.trim() : nv.slice(i + 1).trim();
        let expired = false;
        for (const p of parts.slice(1)) {
          const [k, v] = p.split('=').map((s) => (s || '').trim());
          if (k.toLowerCase() === 'expires' && Date.parse(v) < M.origin + M.clock) expired = true;
          if (k.toLowerCase() === 'max-age' && Number(v) <= 0) expired = true;
        }
        if (expired) M.cookies.delete(name); else M.cookies.set(name, value);
      },
      storageGet: (k, key) => { const v = M.storage[k].get(String(key)); return v === undefined ? null : v; },
      storageSet: (k, key, value) => { M.storage[k].set(String(key), String(value)); },
      storageRemove: (k, key) => { M.storage[k].delete(String(key)); },
      storageClear: (k) => { M.storage[k].clear(); },
      storageKeys: (k) => M.arr(Array.from(M.storage[k].keys())),
      setTimer: (timerId, delay) => {
        M.events = M.events.filter((e) => !(e.kind === 'timer' && e.timerId === timerId));
        M.schedule(M.clock + Math.max(0, Number(delay) || 0), 'timer', { timerId });
      },
      clearTimer: (timerId) => { M.events = M.events.filter((e) => !(e.kind === 'timer' && e.timerId === timerId)); },
      requestFrame: () => { M.frameRequested = true; },
      now: () => M.clock,
      timeOrigin: () => M.origin,
      location: () => M.url,
      navigate: (url, replace) => { M.navigations.push({ url: String(url), replace: !!replace }); },
      reload: () => { M.navigations.push({ reload: true }); },
      historyPush: (url, replace) => {
        M.url = String(url);
        if (replace) M.hist[M.histIndex] = { url: M.url };
        else { M.hist.splice(M.histIndex + 1); M.hist.push({ url: M.url }); M.histIndex++; }
      },
      historyGo: (delta) => {
        const ni = M.histIndex + delta;
        if (ni < 0 || ni >= M.hist.length) return;
        M.histIndex = ni;
        M.url = M.hist[ni].url;
        M.schedule(M.clock, 'hook', { name: 'onPopState', args: [M.url, ni] });
      },
      setTitle: (t) => { M.titles.push(String(t)); },
      log: (level, message) => M.log(String(level), String(message)),
      urlParse: (input, base) => {
        let u;
        try { u = base === null || base === undefined ? new URL(String(input)) : new URL(String(input), String(base)); } catch (_) { return null; }
        return M.arr([u.href, u.protocol, u.username, u.password, u.host, u.hostname, u.port, u.pathname, u.search, u.hash, u.origin]);
      },
      urlSet: (href, field, value) => {
        let u;
        try { u = new URL(String(href)); } catch (_) { return null; }
        const f = String(field);
        if (f === 'href') u = new URL(String(value));
        else if (['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'].includes(f)) u[f] = String(value);
        else throw new M.R.TypeError('unknown URL field ' + f);
        return M.arr([u.href, u.protocol, u.username, u.password, u.host, u.hostname, u.port, u.pathname, u.search, u.hash, u.origin]);
      },
      randomBytes: (n) => M.ab(nodeCrypto.randomBytes(n)),
      textEncode: (s) => M.ab(Buffer.from(String(s), 'utf8')),
      textDecode: (buf, label, fatal) => {
        let dec;
        try { dec = new TextDecoder(String(label), { fatal: !!fatal, ignoreBOM: true }); } catch (e) { throw M.err('RangeError', `unknown encoding ${label}`); }
        try { return dec.decode(buf); } catch (e) { throw new M.R.TypeError('The encoded data was not valid.'); }
      },
      userAgent: () => UA,
      structuredClone: (v) => M.cloneInRealm(v),
      pendingResourceCount: () => M.pendingResources,
      setHooks: (h) => { M.hooks = h; },
      // ---- Additions ----
      doctype: () => (M.mainDoctype ? M.arr(M.mainDoctype) : null),
      historyIndex: () => M.histIndex,
      historyLength: () => M.hist.length,
      openWindow: (url, target, features) => { M.opened.push({ url: String(url), target: String(target), features: String(features) }); },
      imageSize: (id) => { const s = M.images.get(id); return s ? M.arr(s) : null; },
      parseHTMLDocument: (html) => {
        // like Rust: a detached DocumentFragment holding the parsed doctype + <html> (scripting disabled)
        const d = M.createNode({ type: 11 });
        M.convert(parse5.parse(String(html)), d);
        return d;
      },
      registerBlobURL: (url, ab, type) => { M.blobURLs.set(String(url), { bytes: M.bytesOf(ab), type }); },
      revokeBlobURL: (url) => { M.blobURLs.delete(String(url)); },
      fetchSync: (method, url, headersFlat, body, credentials) => {
        M.requests.push({ sync: true, method, url: String(url), headers: Array.from(headersFlat || []), body: M.bytesOf(body), credentials });
        const r = M.responseParts(M.route(String(url), method), String(url));
        return M.arr([r.status, r.statusText, r.finalUrl, M.arr(r.flat), r.body === null ? null : M.ab(r.body), r.error]);
      },
    };
    if (this.opts.noTemplateSupport) delete nat.templateContent;
    for (const k of this.opts.disable || []) delete nat[k];
    return nat;
  }
  body() {
    const html = this.n(this.docId).children.find((c) => this.n(c).type === 1);
    if (!html) return 0;
    return this.n(html).children.find((c) => this.n(c).type === 1 && this.n(c).name === 'body') || 0;
  }
  // Like Rust, selectedness belongs to the option node (removing earlier options does not
  // shift the selection); without an explicit choice the `selected` attributes decide.
  // Rust-like N.focus/N.blur: blur/focusout at the old element, focus/focusin at the new one,
  // dispatched synchronously through hooks.onEvent (opts.nativeFocusEvents).
  fireFocusEvents(oldId, newId) {
    const path = (id) => { const out = []; for (let x = id; x; x = this.n(x).parent) out.push(x); return this.arr(out); };
    const fire = (type, target, bubbles, related) => this.hooks.onEvent(type, target, path(target), { bubbles, cancelable: false, composed: true, relatedTargetId: related });
    const body = this.body();
    if (oldId && oldId !== body) { fire('blur', oldId, false, newId); fire('focusout', oldId, true, newId); }
    if (newId) { fire('focus', newId, false, oldId); fire('focusin', newId, true, oldId); }
  }
  selIndex(id) {
    const n = this.n(id);
    const opts = this.options(id);
    if (n.state.selectedOption !== undefined) {
      if (n.state.selectedOption === 0) return -1;
      const i = opts.indexOf(n.state.selectedOption);
      if (i >= 0) return i;
    }
    let idx = -1;
    opts.forEach((o, i) => { if (this.attr(this.n(o), 'selected') !== null) idx = i; });
    if (idx === -1 && opts.length && this.attr(n, 'multiple') === null) idx = 0;
    return idx;
  }
  options(sid) {
    const out = [];
    for (const c of this.n(sid).children) {
      const n = this.n(c);
      if (n.type !== 1) continue;
      if (n.name === 'option') out.push(c);
      else if (n.name === 'optgroup') for (const o of n.children) if (this.n(o).name === 'option') out.push(o);
    }
    return out;
  }
  onInserted(ids) {
    // images in the document "load" (the harness can override with env.images / pendingResources)
    void ids;
  }
  cssSupported(prop, value) {
    if (prop.startsWith('--')) return true;
    if (value === 'invalid-value' || value === 'undefined' || /^\s*$/.test(value)) return false;
    if (!/^-?[a-z][a-z0-9-]*$/.test(prop)) return false;
    if (/(width|height|left|right|top|bottom|margin|padding|size|gap|inset)/.test(prop) && /^-?\d*\.?\d+$/.test(value) && Number(value) !== 0) return false;
    return !prop.startsWith('-moz-') && prop !== 'not-a-property';
  }
  computed(id, prop, pseudo) {
    const n = this.n(id);
    if (n.type !== 1) return '';
    if (pseudo) return prop === 'content' ? 'none' : '';
    if (prop === 'display') return this.displayOf(id);
    const c = this.cascaded(id, prop);
    if (c !== undefined) return c;
    const INHERITED = ['color', 'font-size', 'font-family', 'visibility', 'direction', 'white-space', 'cursor', 'line-height', 'text-align', 'font-weight'];
    if (INHERITED.includes(prop) && n.parent && this.n(n.parent).type === 1) return this.computed(n.parent, prop, '');
    const r = this.rectOf(id);
    switch (prop) {
      case 'width': return this.rendered(id) ? r[2] + 'px' : 'auto';
      case 'height': return this.rendered(id) ? r[3] + 'px' : 'auto';
      case 'visibility': return 'visible';
      case 'position': return 'static';
      case 'opacity': return '1';
      case 'color': return 'rgb(0, 0, 0)';
      case 'background-color': return 'rgba(0, 0, 0, 0)';
      case 'font-size': return '16px';
      case 'font-family': return 'Times New Roman';
      case 'font-weight': return '400';
      case 'line-height': return 'normal';
      case 'box-sizing': return 'content-box';
      case 'float': return 'none';
      case 'overflow': case 'overflow-x': case 'overflow-y': return 'visible';
      case 'transform': return 'none';
      case 'z-index': return 'auto';
      case 'white-space': return n.name === 'pre' || n.name === 'textarea' ? 'pre' : 'normal';
      case 'direction': return 'ltr';
      case 'pointer-events': return 'auto';
      case 'cursor': return 'auto';
      case 'content': return 'normal';
      case 'top': case 'left': case 'right': case 'bottom': return 'auto';
      case 'text-align': return 'start';
      default:
        if (/^(margin|padding)(-|$)/.test(prop) || /^border-.*width$/.test(prop)) return '0px';
        if (/^border-.*style$/.test(prop)) return 'none';
        return '';
    }
  }
  evalMedia(q) {
    const one = (s) => {
      s = s.trim().toLowerCase();
      let neg = false;
      if (s.startsWith('not ')) { neg = true; s = s.slice(4).trim(); }
      if (s.startsWith('only ')) s = s.slice(5).trim();
      const parts = s.split(/\s+and\s+/);
      let ok = true;
      for (let p of parts) {
        p = p.trim();
        if (p === 'all' || p === 'screen') continue;
        if (p === 'print') { ok = false; continue; }
        const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+))?\)$/.exec(p);
        if (!m) { ok = false; continue; }
        const f = m[1], v = (m[2] || '').trim();
        const px = parseFloat(v);
        switch (f) {
          case 'min-width': ok = ok && this.vp.w >= px; break;
          case 'max-width': ok = ok && this.vp.w <= px; break;
          case 'min-height': ok = ok && this.vp.h >= px; break;
          case 'max-height': ok = ok && this.vp.h <= px; break;
          case 'orientation': ok = ok && (v === (this.vp.w >= this.vp.h ? 'landscape' : 'portrait')); break;
          case 'prefers-color-scheme': ok = ok && v === 'light'; break;
          case 'prefers-reduced-motion': ok = ok && v === 'no-preference'; break;
          case 'hover': ok = ok && (v === '' || v === 'hover'); break;
          case 'pointer': ok = ok && (v === '' || v === 'fine'); break;
          case 'min-resolution': ok = ok && this.vp.dpr >= parseFloat(v); break;
          case '-webkit-min-device-pixel-ratio': ok = ok && this.vp.dpr >= px; break;
          default: ok = false;
        }
      }
      return neg ? !ok : ok;
    };
    return q.split(',').some(one);
  }
}

// In-realm structured clone (evaluated inside the vm context)
const CLONE_SRC = `(function () {
  function fail(v) { throw new Error('DataCloneError: ' + String(v) + ' could not be cloned.'); }
  function clone(v, memo) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function' || typeof v === 'symbol') fail(typeof v);
      return v;
    }
    if (memo.has(v)) return memo.get(v);
    let out;
    const tag = Object.prototype.toString.call(v);
    switch (tag) {
      case '[object Date]': out = new Date(v.getTime()); break;
      case '[object RegExp]': out = new RegExp(v.source, v.flags); break;
      case '[object ArrayBuffer]': out = v.slice(0); break;
      case '[object Boolean]': out = new Boolean(v.valueOf()); break;
      case '[object Number]': out = new Number(v.valueOf()); break;
      case '[object String]': out = new String(v.valueOf()); break;
      case '[object Map]': out = new Map(); memo.set(v, out); for (const [k, x] of v) out.set(clone(k, memo), clone(x, memo)); return out;
      case '[object Set]': out = new Set(); memo.set(v, out); for (const x of v) out.add(clone(x, memo)); return out;
      case '[object Error]': out = new Error(v.message); out.name = v.name; break;
      case '[object Array]': out = new Array(v.length); memo.set(v, out); for (let i = 0; i < v.length; i++) if (i in v) out[i] = clone(v[i], memo); return out;
      case '[object Object]': out = {}; memo.set(v, out); for (const k of Object.keys(v)) out[k] = clone(v[k], memo); return out;
      default:
        if (ArrayBuffer.isView(v)) { out = new v.constructor(v); break; }
        fail(tag);
    }
    memo.set(v, out);
    return out;
  }
  return function (v) { return clone(v, new Map()); };
})()`;

module.exports = { MockNative, NS_HTML, NS_SVG, NS_MATHML, UA };
