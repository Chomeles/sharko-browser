// 20_dom.js — Node / Element / Document, collections, mutation paths (MutationObserver
// records, custom element reactions, dynamic script insertion hooks), CSSOM, traversal,
// Range/Selection, geometry, DOMParser/XMLSerializer/DOMImplementation.
(function (L) {
  'use strict';
  const N = L.N;
  const DOMException = L.DOMException;
  const idOf = L.idOf, typeOf = L.typeOf, lnOf = L.lnOf, nsOf = L.nsOf, isNode = L.isNode;
  const wrap = L.wrap;
  const state = L.state;
  const treeChanged = L.treeChanged;
  // Child-list version per parent id. Live `children`/`childNodes` collections only
  // recompute when their own parent's child list changed (or on untracked changes),
  // so e.g. setting `textContent` on one child does not invalidate `parent.children`.
  const childVer = new Map();
  function childListChanged(pid, other) {
    const v = ++state.tree;
    childVer.set(pid, v);
    if (other !== 0) childVer.set(other, v);
  }
  function childVerOf(id) {
    const v = childVer.get(id);
    return v === undefined ? 0 : v;
  }
  const cache = L.cache;
  const EventTarget = L.EventTarget;
  const HTML = 0, SVG = 1, MATHML = 2, OTHER = 3, NONE = 4;
  const INTERNAL = L.INTERNAL;

  function hier(msg) { return new DOMException(msg || 'The operation would yield an incorrect node tree.', 'HierarchyRequestError'); }
  function notFound(msg) { return new DOMException(msg, 'NotFoundError'); }
  function invalidChar(msg) { return new DOMException(msg, 'InvalidCharacterError'); }
  function nativeCall(fn) { try { return fn(); } catch (e) { throw L.fromNative(e); } }

  // ---------------------------------------------------------------------------------------
  // Class skeletons (members are attached further below)
  // ---------------------------------------------------------------------------------------
  class Node extends EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
  }
  class CharacterData extends Node {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(token); }
  }
  function makeWrapper(id, t, proto) {
    const w = Object.create(proto);
    L.stamp(w, id, t, '', HTML);
    cache.set(id, w);
    return w;
  }
  L.makeWrapper = makeWrapper;
  class Text extends CharacterData {
    constructor(data = '') { return makeWrapper(N.createText(`${data}`), 3, new.target.prototype); }
  }
  class CDATASection extends Text {
    constructor() { throw L.illegal(); }
  }
  class Comment extends CharacterData {
    constructor(data = '') { return makeWrapper(N.createComment(`${data}`), 8, new.target.prototype); }
  }
  class ProcessingInstruction extends CharacterData {
    constructor() { throw L.illegal(); }
  }
  class DocumentType extends Node {
    constructor() { throw L.illegal(); }
  }
  class DocumentFragment extends Node {
    constructor() { return makeWrapper(N.createFragment(), 11, new.target.prototype); }
  }
  class ShadowRoot extends DocumentFragment {
    constructor() { throw L.illegal(); }
  }
  class Document extends Node {
    // HTML "parse HTML from a string" without sanitization (scripts are not run), like
    // DOMParser's text/html path.
    static parseHTMLUnsafe(html) { return L.createDetachedDocument('html', `${html}`); }
    constructor() { return L.createDetachedDocument('xml', null, new.target.prototype); }
  }
  class HTMLDocument extends Document {
    constructor() { throw L.illegal(); }
  }
  class XMLDocument extends Document {
    constructor() { throw L.illegal(); }
  }
  class Element extends Node {
    constructor() { throw L.illegal(); }
  }
  Object.assign(L, { Node, CharacterData, Text, CDATASection, Comment, ProcessingInstruction, DocumentType,
    DocumentFragment, ShadowRoot, Document, HTMLDocument, XMLDocument, Element });

  // ---------------------------------------------------------------------------------------
  // Wrapper creation
  // ---------------------------------------------------------------------------------------
  L.elementProtoFor = function () { return Element.prototype; }; // replaced by 30_html.js
  L.elementWrapperMakers = new Map(); // HTML localName -> (proto) => object (e.g. form proxies)
  const titleIds = new Set();
  L.createWrapper = function (id) {
    const t = N.nodeType(id);
    let w;
    if (t === 1) {
      const ln = N.localName(id);
      const ns = L.nsCode(N.namespaceURI(id));
      const proto = L.elementProtoFor(ln, ns);
      const mk = ns === HTML ? L.elementWrapperMakers.get(ln) : undefined;
      w = mk !== undefined ? mk(proto) : Object.create(proto);
      L.stamp(w, id, 1, ln, ns);
      if (ln === 'title') titleIds.add(id);
    } else {
      let proto;
      switch (t) {
        case 3: proto = Text.prototype; break;
        case 8: proto = Comment.prototype; break;
        case 9: proto = HTMLDocument.prototype; break;
        case 10: proto = DocumentType.prototype; break;
        case 11: proto = DocumentFragment.prototype; break;
        case 4: proto = CDATASection.prototype; break;
        case 7: proto = ProcessingInstruction.prototype; break;
        default: proto = Node.prototype;
      }
      w = Object.create(proto);
      L.stamp(w, id, t, '', HTML);
      if (t === 9) docState.set(w, { main: false, contentType: 'text/html', url: 'about:blank' });
    }
    cache.set(id, w);
    return w;
  };
  // Create an element wrapper with a specific prototype (custom elements, XML documents).
  let foreignWrappers = 0; // elements whose namespace is only known to the JS stamp
  L.wrapElementAs = function (id, proto, ln, ns) {
    const w = Object.create(proto);
    L.stamp(w, id, 1, ln, ns);
    cache.set(id, w);
    if (ns === OTHER || ns === NONE) foreignWrappers++;
    return w;
  };

  // ---------------------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------------------
  const docState = new WeakMap();
  L.docState = docState;
  const mainDocId = N.documentId();
  const document = Object.create(HTMLDocument.prototype);
  L.stamp(document, mainDocId, 9, '', HTML);
  cache.set(mainDocId, document);
  docState.set(document, { main: true, contentType: 'text/html' });
  L.document = document;
  L.documentId = mainDocId;
  let detachedDocs = 0;
  L.registerDetachedDocument = function (w, backingId, info) {
    detachedDocs++;
    docState.set(w, info);
    cache.set(backingId, w);
  };
  L.isDocument = function (w) { return docState.has(w); };

  // Document URL (cached; refreshed by the bootstrap on navigation-related hooks)
  let docURL = null;
  L.documentURL = function () {
    if (docURL === null) docURL = N.location();
    return docURL;
  };
  L.invalidateDocumentURL = function () { docURL = null; baseCache.epoch = -1; };

  // Base URL: first <base href> in the document, resolved against the document URL.
  const baseCache = { epoch: -1, url: '' };
  L.baseURL = function () {
    const ep = state.tree * 65536 + state.attr;
    if (baseCache.epoch === ep) return baseCache.url;
    const du = L.documentURL();
    let url = du;
    const b = N.querySelector(mainDocId, 'base[href]');
    if (b !== 0) {
      const p = N.urlParse(N.getAttr(b, 'href') || '', du);
      if (p !== null) url = p[0];
    }
    baseCache.epoch = ep;
    baseCache.url = url;
    return url;
  };
  // Resolve a URL against the document base; returns the input on failure.
  const urlCache = new Map();
  L.resolveURL = function (v) {
    const base = L.baseURL();
    const key = base + '\u0000' + v;
    let r = urlCache.get(key);
    if (r !== undefined) return r;
    const p = N.urlParse(v, base);
    r = p === null ? null : p[0];
    if (urlCache.size > 2000) urlCache.clear();
    urlCache.set(key, r);
    return r;
  };

  L.isConnectedNode = function (w) { return N.isConnected(idOf(w)); };

  // ---------------------------------------------------------------------------------------
  // Shadow roots (approximation: content lives in the host's light DOM, see README)
  // ---------------------------------------------------------------------------------------
  const shadowInfo = new WeakMap(); // shadow root -> info
  const shadowOfHost = new WeakMap(); // host wrapper -> shadow root
  function isShadowRoot(w) { return shadowInfo.has(w); }
  L.isShadowRoot = isShadowRoot;

  function shadowPrepare(sr) {
    const info = shadowInfo.get(sr);
    if (info.lightFrag !== 0) return;
    const hostId = idOf(info.host);
    const frag = N.createFragment();
    let c;
    while ((c = N.firstChild(hostId)) !== 0) N.appendChild(frag, c);
    info.lightFrag = frag;
    treeChanged();
  }
  function shadowDistribute(sr) {
    const info = shadowInfo.get(sr);
    const frag = info.lightFrag;
    if (frag === 0 || N.firstChild(frag) === 0) return;
    const hostId = idOf(info.host);
    const slots = N.querySelectorAll(hostId, 'slot');
    if (slots.length === 0) return;
    const byName = new Map();
    for (const s of slots) {
      const n = N.getAttr(s, 'name') || '';
      if (!byName.has(n)) byName.set(n, s);
    }
    for (const c of N.childIds(frag)) {
      const t = N.nodeType(c);
      let name = '';
      if (t === 1) name = N.getAttr(c, 'slot') || '';
      else if (t !== 3) continue;
      const slot = byName.get(name);
      if (slot === undefined) continue;
      if (!info.cleared.has(slot)) {
        info.cleared.add(slot);
        N.setTextContent(slot, '');
      }
      N.appendChild(slot, c);
    }
    treeChanged();
  }
  function lightFragOf(hostW) {
    const sr = shadowOfHost.get(hostW);
    if (sr === undefined) return 0;
    return shadowInfo.get(sr).lightFrag;
  }
  function attachShadowImpl(host, mode, init) {
    const sr = Object.create(ShadowRoot.prototype);
    L.stamp(sr, idOf(host), 11, '', HTML);
    shadowInfo.set(sr, {
      host, mode, delegatesFocus: !!init.delegatesFocus, clonable: !!init.clonable,
      serializable: !!init.serializable, slotAssignment: init.slotAssignment === 'manual' ? 'manual' : 'named',
      lightFrag: 0, cleared: new Set(), declarative: !!init.declarative,
    });
    shadowOfHost.set(host, sr);
    // Stylesheets inside the host are scoped to it from now on (native style scoping).
    if (typeof N.setShadowHost === 'function') N.setShadowHost(idOf(host), true);
    return sr;
  }
  // Remove the shadow content of `sr` (slotted light nodes go back to the light fragment).
  function clearShadowContent(sr) {
    const info = shadowInfo.get(sr);
    const hostId = idOf(info.host);
    if (info.lightFrag !== 0) {
      for (const slot of info.cleared) {
        if (!N.contains(hostId, slot)) continue;
        let c;
        while ((c = N.firstChild(slot)) !== 0) N.appendChild(info.lightFrag, c);
      }
    }
    info.cleared = new Set();
    N.setTextContent(hostId, '');
    treeChanged();
  }
  // Declarative shadow DOM: <template shadowrootmode> attaches a shadow root to its
  // parent when the document is parsed (innermost first).
  L.attachDeclarativeShadowRoots = function (rootId) {
    // Nested declarative roots surface once their outer content moved into the document.
    for (let round = 0; round < 32 && attachDeclarativeRound(rootId) !== 0; round++);
  };
  function attachDeclarativeRound(rootId) {
    let attached = 0;
    const ids = N.querySelectorAll(rootId, 'template[shadowrootmode]');
    for (let i = ids.length - 1; i >= 0; i--) {
      const tid = ids[i];
      const mode = L.asciiLower(N.getAttr(tid, 'shadowrootmode') || '');
      const pid = N.parent(tid);
      if ((mode !== 'open' && mode !== 'closed') || pid === 0 || N.nodeType(pid) !== 1) continue;
      const host = wrap(pid);
      const ln = lnOf(host);
      if (nsOf(host) !== HTML || !(L.isValidCEName(ln) || SHADOW_HOSTS.has(ln)) || shadowOfHost.has(host)) continue;
      const content = L.templateInfo !== null ? L.templateInfo(wrap(tid)) : tid;
      const sr = attachShadowImpl(host, mode, {
        declarative: true,
        delegatesFocus: N.getAttr(tid, 'shadowrootdelegatesfocus') !== null,
        clonable: N.getAttr(tid, 'shadowrootclonable') !== null,
        serializable: N.getAttr(tid, 'shadowrootserializable') !== null,
      });
      N.removeChild(pid, tid);
      shadowPrepare(sr);
      for (const c of N.childIds(content)) N.appendChild(pid, c);
      shadowDistribute(sr);
      treeChanged();
      attached++;
    }
    return attached;
  }

  // ---------------------------------------------------------------------------------------
  // MutationObserver machinery (records are produced by the layer's own mutation paths)
  // ---------------------------------------------------------------------------------------
  const moRegs = new Map(); // node id -> [{observer, o: options}]
  let moRegCount = 0;
  let moPending = false;
  const moObservers = new Set(); // observers with queued records (insertion order)
  let MO; // internals of MutationObserver (set in its static block)
  L.moActive = function () { return moRegCount > 0; };

  function queueMutation(type, tid, name, oldValue, added, removed, prev, next) {
    if (moRegCount === 0) return;
    let interested = null;
    const consider = (nid, regs) => {
      for (let i = 0; i < regs.length; i++) {
        const r = regs[i], o = r.o;
        if (nid !== tid && !o.subtree) continue;
        if (type === 'attributes') {
          if (!o.attributes) continue;
          if (o.attributeFilter !== null && !o.attributeFilter.has(name)) continue;
        } else if (type === 'characterData') {
          if (!o.characterData) continue;
        } else if (!o.childList) {
          continue;
        }
        if (interested === null) interested = new Map();
        if (!interested.has(r.observer)) interested.set(r.observer, null);
        if ((type === 'attributes' && o.attributeOldValue) || (type === 'characterData' && o.characterDataOldValue)) {
          interested.set(r.observer, oldValue);
        }
      }
    };
    if (moRegs.size <= 8) {
      for (const [nid, regs] of moRegs) {
        if (nid !== tid) {
          let anySub = false;
          for (const r of regs) if (r.o.subtree) { anySub = true; break; }
          if (!anySub || !N.contains(nid, tid)) continue;
        }
        consider(nid, regs);
      }
    } else {
      for (let n = tid; n !== 0; n = N.parent(n)) {
        const regs = moRegs.get(n);
        if (regs !== undefined) consider(n, regs);
      }
    }
    if (interested === null) return;
    for (const [obs, old] of interested) {
      MO.push(obs, new MutationRecord(INTERNAL, {
        type, target: tid, attributeName: name, oldValue: old,
        added: added || null, removed: removed || null, prev: prev || 0, next: next || 0,
      }));
      moObservers.add(obs);
    }
    if (!moPending) {
      moPending = true;
      L.microtask(deliverMutations);
    }
  }
  L.queueMutation = queueMutation;
  function deliverMutations() {
    moPending = false;
    const list = Array.from(moObservers).sort((a, b) => MO.order(a) - MO.order(b));
    moObservers.clear();
    for (const obs of list) {
      const recs = MO.take(obs);
      if (recs.length === 0) continue;
      try { Reflect.apply(MO.callback(obs), obs, [recs, obs]); } catch (e) { L.report(e); }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Custom element reactions (definitions live in the registry further below)
  // ---------------------------------------------------------------------------------------
  const ceDefs = new Map(); // name -> definition
  const ceByCtor = new Map(); // constructor -> definition
  const ceState = new WeakMap(); // element wrapper -> definition (upgraded / custom)
  let ceSelector = '';
  L.ceDefs = ceDefs;
  L.ceByCtor = ceByCtor;
  L.ceState = ceState;
  const builtinDefs = new Map(); // customized built-in name ("is" value) -> definition
  function ceActive() { return ceDefs.size !== 0 || builtinDefs.size !== 0; }
  function rebuildCeSelector() {
    const parts = Array.from(ceDefs.keys(), L.cssEscape);
    for (const d of builtinDefs.values()) parts.push(L.cssEscape(d.localName) + '[is=' + L.cssString(d.name) + ']');
    ceSelector = parts.join(',');
  }
  // The definition an element would be upgraded with (autonomous by local name, customized
  // built-in by its `is` attribute).
  function ceDefFor(id, ln) {
    const d = ceDefs.get(ln);
    if (d !== undefined) return d;
    if (builtinDefs.size !== 0) {
      const is = N.getAttr(id, 'is');
      if (is !== null) {
        const b = builtinDefs.get(is);
        if (b !== undefined && b.localName === ln) return b;
      }
    }
    return undefined;
  }
  // ids of elements with a defined custom element name in the subtree rooted at `rootId`
  function collectCE(rootId, includeRoot) {
    const out = [];
    if (includeRoot && N.nodeType(rootId) === 1) {
      const w = cache.get(rootId);
      const ln = w !== undefined ? lnOf(w) : N.localName(rootId);
      if (ceDefFor(rootId, ln) !== undefined && N.namespaceURI(rootId) === L.NS.HTML) out.push(rootId);
    }
    if (ceSelector !== '' && N.firstChild(rootId) !== 0) {
      const ids = N.querySelectorAll(rootId, ceSelector);
      for (let i = 0; i < ids.length; i++) out.push(ids[i]);
    }
    return out;
  }
  function ceCallback(w, def, name, args) {
    const cb = def.callbacks[name];
    if (cb === undefined) return;
    try { Reflect.apply(cb, w, args); } catch (e) { L.report(e); }
  }
  L.ceCallback = ceCallback;
  function ceDisconnected(ids) {
    for (const id of ids) {
      const w = cache.get(id);
      if (w === undefined) continue;
      const def = ceState.get(w);
      if (def !== undefined && def !== FAILED) ceCallback(w, def, 'disconnectedCallback', []);
    }
  }
  const FAILED = { failed: true, callbacks: {}, observed: new Set() };
  // After nodes were inserted into a connected parent: upgrade + connectedCallback.
  function ceConnected(ids) {
    for (const id of ids) {
      const w = wrap(id);
      const def = ceState.get(w);
      if (def === undefined) {
        upgradeElement(w);
      } else if (def !== FAILED) {
        ceCallback(w, def, 'connectedCallback', []);
      }
    }
  }
  // Upgrade elements in a (possibly detached) subtree without connected callbacks.
  function ceUpgradeSubtree(rootId, includeRoot) {
    if (!ceActive()) return;
    for (const id of collectCE(rootId, includeRoot)) {
      const w = wrap(id);
      if (!ceState.has(w)) upgradeElement(w);
    }
  }
  L.ceUpgradeSubtree = ceUpgradeSubtree;

  const constructionStack = [];
  const ALREADY_CONSTRUCTED = {};
  L.constructionStack = constructionStack;
  L.ALREADY_CONSTRUCTED = ALREADY_CONSTRUCTED;
  function upgradeElement(w, defOverride) {
    if (ceState.has(w) || nsOf(w) !== HTML) return;
    const id = idOf(w);
    const def = defOverride !== undefined ? defOverride : ceDefFor(id, lnOf(w));
    if (def === undefined) return;
    const prevProto = Object.getPrototypeOf(w);
    Object.setPrototypeOf(w, def.ctor.prototype);
    ceState.set(w, def);
    def.stack.push(w);
    try {
      const r = Reflect.construct(def.ctor, []);
      if (r !== w) throw new TypeError('Custom element constructor did not return the upgraded element');
    } catch (e) {
      ceState.set(w, FAILED);
      Object.setPrototypeOf(w, prevProto);
      def.stack.pop();
      L.report(e);
      return;
    }
    def.stack.pop();
    if (typeof N.setDefined === 'function') N.setDefined(id);
    if (def.callbacks.attributeChangedCallback !== undefined) {
      for (const name of N.attrNames(id)) {
        if (def.observed.has(name)) ceCallback(w, def, 'attributeChangedCallback', [name, null, N.getAttr(id, name), null]);
      }
    }
    if (N.isConnected(id)) ceCallback(w, def, 'connectedCallback', []);
  }
  L.upgradeElement = upgradeElement;

  // ---------------------------------------------------------------------------------------
  // Tree mutation core. Every DOM mutation made through the API goes through here.
  // ---------------------------------------------------------------------------------------
  L.pendingScripts = new Set(); // ids of script elements that may execute when connected
  L.forceAsync = new Set(); // ids of non-parser-inserted scripts whose "force async" flag is set
  L.checkPendingScripts = null; // installed by 90_bootstrap.js
  L.scriptChildrenChanged = null; // installed by 90_bootstrap.js
  L.observersDirty = null; // installed by 40_webapi.js (IntersectionObserver/ResizeObserver)
  L.templateInfo = null; // installed by 30_html.js

  function childrenChanged(pid, parentW) {
    // parentW may be undefined when only the id is known
    const w = parentW !== undefined ? parentW : cache.get(pid);
    if (w !== undefined && typeOf(w) === 1) {
      const ln = lnOf(w);
      if (ln === 'script' && L.pendingScripts.size !== 0 && L.pendingScripts.has(pid) && L.scriptChildrenChanged !== null) {
        L.scriptChildrenChanged(pid);
      } else if (ln === 'title' && titleIds.has(pid)) {
        titleChanged();
      }
    }
  }
  function titleChanged() {
    if (!N.isConnected(mainDocId)) return;
    try { N.setTitle(document.title); } catch (_) { /* ignore */ }
  }
  L.titleChanged = titleChanged;

  // ---------------------------------------------------------------------------------------
  // Live ranges (https://dom.spec.whatwg.org/#concept-live-range): every Range (and so the
  // selection's range) follows the DOM's insert / remove / replace-data / split / normalize
  // steps. The registry holds WeakRefs so ranges a page drops are collected as usual.
  // ---------------------------------------------------------------------------------------
  //
  // Each Range owns a state `{sc, so, ec, eo}`; `rangeIndex` maps a container node id to
  // the states anchored in it, so a mutation only visits the ranges it can affect (a page
  // with thousands of ranges and a busy DOM stays fast). A FinalizationRegistry drops the
  // state of a collected Range.
  const rangeIndex = new Map(); // node id -> Set<state>
  const liveRanges = { get size() { return rangeIndex.size; } };
  function indexAdd(id, s) {
    let set = rangeIndex.get(id);
    if (set === undefined) { set = new Set(); rangeIndex.set(id, set); }
    set.add(s);
  }
  function indexRemove(id, s) {
    const set = rangeIndex.get(id);
    if (set === undefined) return;
    set.delete(s);
    if (set.size === 0) rangeIndex.delete(id);
  }
  const rangeReaper = new FinalizationRegistry((s) => { indexRemove(s.sc, s); if (s.ec !== s.sc) indexRemove(s.ec, s); });
  function newRangeState(range, sc, so, ec, eo) {
    const s = { sc, so, ec, eo };
    indexAdd(sc, s);
    if (ec !== sc) indexAdd(ec, s);
    rangeReaper.register(range, s);
    return s;
  }
  function setRangeState(s, sc, so, ec, eo) {
    const oSc = s.sc, oEc = s.ec;
    if (sc !== oSc || ec !== oEc) {
      if (oSc !== sc && oSc !== ec) indexRemove(oSc, s);
      if (oEc !== oSc && oEc !== sc && oEc !== ec) indexRemove(oEc, s);
      if (sc !== oSc && sc !== oEc) indexAdd(sc, s);
      if (ec !== sc && ec !== oSc && ec !== oEc) indexAdd(ec, s);
      s.sc = sc; s.ec = ec;
    }
    s.so = so; s.eo = eo;
  }
  // The states with a boundary in the subtree of `nid` (grouped by container).
  function statesInside(nid, skip) {
    let out = null;
    for (const [cid, set] of rangeIndex) {
      if (cid === skip || !N.contains(nid, cid)) continue;
      if (out === null) out = new Set();
      for (const s of set) out.add(s);
    }
    return out;
  }
  // Insert steps: `count` nodes were inserted into `pid` at `index`.
  function rangesOnInsert(pid, index, count) {
    const set = rangeIndex.get(pid);
    if (set === undefined) return;
    for (const s of set) {
      if (s.sc === pid && s.so > index) s.so += count;
      if (s.ec === pid && s.eo > index) s.eo += count;
    }
  }
  // Remove steps (run before the removal): `nid` is the child of `pid` at `index`.
  function rangesOnRemove(pid, nid, index) {
    const inside = statesInside(nid, pid);
    if (inside !== null) {
      for (const s of inside) {
        const a = N.contains(nid, s.sc), b = N.contains(nid, s.ec);
        setRangeState(s, a ? pid : s.sc, a ? index : s.so, b ? pid : s.ec, b ? index : s.eo);
      }
    }
    const set = rangeIndex.get(pid);
    if (set === undefined) return;
    for (const s of set) {
      if (s.sc === pid && s.so > index) s.so -= 1;
      if (s.ec === pid && s.eo > index) s.eo -= 1;
    }
  }
  // Replace all (innerHTML, textContent, replaceChildren): the sequential remove steps for
  // `oldKids` then the insert at 0 leave every range that was in `pid` at (pid, 0).
  function rangesOnReplaceAll(pid, oldKids) {
    const touched = new Set();
    const own = rangeIndex.get(pid);
    if (own !== undefined) for (const s of own) touched.add(s);
    for (const k of oldKids) {
      const inside = statesInside(k, pid);
      if (inside !== null) for (const s of inside) touched.add(s);
    }
    const inOld = (id) => id === pid || oldKids.some((k) => N.contains(k, id));
    for (const s of touched) {
      const a = inOld(s.sc), b = inOld(s.ec);
      setRangeState(s, a ? pid : s.sc, a ? 0 : s.so, b ? pid : s.ec, b ? 0 : s.eo);
    }
  }
  // Replace data steps: in `id`, `count` code units at `offset` were replaced by `added`.
  function rangesOnReplaceData(id, offset, count, added) {
    const set = rangeIndex.get(id);
    if (set === undefined) return;
    for (const s of set) {
      if (s.sc === id) { if (s.so > offset && s.so <= offset + count) s.so = offset; else if (s.so > offset + count) s.so += added - count; }
      if (s.ec === id) { if (s.eo > offset && s.eo <= offset + count) s.eo = offset; else if (s.eo > offset + count) s.eo += added - count; }
    }
  }
  // splitText steps after the new node was inserted at `index + 1` in `pid`.
  function rangesOnSplit(id, newId, offset, pid, index) {
    const own = rangeIndex.get(id);
    if (own !== undefined) {
      for (const s of [...own]) {
        const a = s.sc === id && s.so > offset, b = s.ec === id && s.eo > offset;
        if (a || b) setRangeState(s, a ? newId : s.sc, a ? s.so - offset : s.so, b ? newId : s.ec, b ? s.eo - offset : s.eo);
      }
    }
    const set = rangeIndex.get(pid);
    if (set === undefined) return;
    for (const s of set) {
      if (s.sc === pid && s.so === index + 1) s.so += 1;
      if (s.ec === pid && s.eo === index + 1) s.eo += 1;
    }
  }
  // normalize(): the text node `from` (child `index` of `pid`) is about to be merged into
  // `into`, whose data is `length` code units long so far.
  function rangesOnMerge(into, from, pid, index, length) {
    const own = rangeIndex.get(from);
    if (own !== undefined) {
      for (const s of [...own]) {
        const a = s.sc === from, b = s.ec === from;
        setRangeState(s, a ? into : s.sc, a ? s.so + length : s.so, b ? into : s.ec, b ? s.eo + length : s.eo);
      }
    }
    const set = rangeIndex.get(pid);
    if (set === undefined) return;
    for (const s of [...set]) {
      const a = s.sc === pid && s.so === index, b = s.ec === pid && s.eo === index;
      if (a || b) setRangeState(s, a ? into : s.sc, a ? length : s.so, b ? into : s.ec, b ? length : s.eo);
    }
  }

  L.optionsInserted = null; // installed by 30_html.js (select selectedness on option insertion)
  function afterInsertion(pid, parentW, insertedIds) {
    if (L.pendingScripts.size !== 0 && L.checkPendingScripts !== null) L.checkPendingScripts();
    if (L.optionsInserted !== null) {
      const pln = parentW !== undefined && parentW !== null && typeOf(parentW) === 1 ? lnOf(parentW) : N.localName(pid);
      if (pln === 'select' || pln === 'optgroup') L.optionsInserted(pid, pln, insertedIds);
    }
    if (ceActive() && N.isConnected(pid)) {
      let ids = null;
      for (const nid of insertedIds) {
        const found = collectCE(nid, true);
        if (found.length) ids = ids === null ? found : ids.concat(found);
      }
      if (ids !== null) ceConnected(ids);
    }
    childrenChanged(pid, parentW);
    if (L.observersDirty !== null) L.observersDirty();
  }

  // Insert node `nid` (wrapper nodeW) into `pid` before `refId` (0 = append).
  function insertCore(pid, parentW, nodeW, nid, refId) {
    const nt = typeOf(nodeW);
    const isFrag = nt === 11;
    const mo = moRegCount !== 0, ce = ceActive(), lr = liveRanges.size !== 0;
    let added = null, oldParent = 0, oldPrev = 0, oldNext = 0, ceMoved = null;
    if (isFrag) {
      added = N.childIds(nid);
      if (added.length === 0) return;
      if (mo) queueMutation('childList', nid, null, null, null, added, 0, 0);
      if (lr) for (const c of added) rangesOnRemove(nid, c, 0);
    } else {
      oldParent = N.parent(nid);
      if (oldParent !== 0 && (mo || ce)) {
        if (mo) { oldPrev = N.prevSibling(nid); oldNext = N.nextSibling(nid); }
        if (ce && N.isConnected(nid)) ceMoved = collectCE(nid, true);
      }
      if (lr && oldParent !== 0) rangesOnRemove(oldParent, nid, indexOfNode(nid));
    }
    nativeCall(() => N.insertBefore(pid, nid, refId));
    childListChanged(pid, isFrag ? nid : oldParent);
    const insertedIds = isFrag ? added : [nid];
    if (lr) rangesOnInsert(pid, indexOfNode(insertedIds[0]), insertedIds.length);
    if (mo) {
      if (oldParent !== 0) queueMutation('childList', oldParent, null, null, null, [nid], oldPrev, oldNext);
      const first = insertedIds[0], last = insertedIds[insertedIds.length - 1];
      queueMutation('childList', pid, null, null, insertedIds, null, N.prevSibling(first), N.nextSibling(last));
    }
    if (ceMoved !== null && ceMoved.length) ceDisconnected(ceMoved);
    afterInsertion(pid, parentW, insertedIds);
  }
  L.insertCore = insertCore;

  function removeCore(pid, parentW, nid) {
    const mo = moRegCount !== 0;
    let prev = 0, next = 0, ceList = null;
    if (mo) { prev = N.prevSibling(nid); next = N.nextSibling(nid); }
    if (ceActive() && N.isConnected(nid)) ceList = collectCE(nid, true);
    if (liveRanges.size !== 0) rangesOnRemove(pid, nid, indexOfNode(nid));
    nativeCall(() => N.removeChild(pid, nid));
    childListChanged(pid, 0);
    if (mo) queueMutation('childList', pid, null, null, null, [nid], prev, next);
    if (ceList !== null && ceList.length) ceDisconnected(ceList);
    childrenChanged(pid, parentW);
    if (L.observersDirty !== null) L.observersDirty();
  }
  L.removeCore = removeCore;

  // Replace all children of `pid` by the children produced by `mutate()` (innerHTML,
  // textContent, …). Produces a single childList record.
  // `moves`: `mutate` may take nodes out of other parents (untracked child-list change).
  function replaceAllCore(pid, parentW, mutate, moves) {
    const mo = moRegCount !== 0;
    const ce = ceActive();
    let removed = null, ceList = null;
    const lr = liveRanges.size !== 0;
    if (mo || lr) removed = N.childIds(pid);
    const connected = ce ? N.isConnected(pid) : false;
    if (ce && connected) ceList = collectCE(pid, false);
    nativeCall(mutate);
    if (lr) rangesOnReplaceAll(pid, removed);
    if (moves === true) treeChanged();
    childListChanged(pid, 0);
    const added = mo || ce ? N.childIds(pid) : null;
    if (mo && (removed.length || added.length)) queueMutation('childList', pid, null, null, added, removed, 0, 0);
    if (ceList !== null && ceList.length) ceDisconnected(ceList);
    if (ce) {
      if (connected) {
        let ids = null;
        for (const nid of added) {
          const found = collectCE(nid, true);
          if (found.length) ids = ids === null ? found : ids.concat(found);
        }
        if (ids !== null) ceConnected(ids);
      } else {
        ceUpgradeSubtree(pid, false);
      }
    }
    childrenChanged(pid, parentW);
    if (L.observersDirty !== null) L.observersDirty();
  }
  L.replaceAllCore = replaceAllCore;

  // Pre-insertion validity (https://dom.spec.whatwg.org/#concept-node-ensure-pre-insertion-validity)
  function ensurePreInsert(parentW, pid, nodeW, nid, refId, method) {
    const pt = typeOf(parentW);
    if (pt !== 9 && pt !== 11 && pt !== 1) throw hier(`Failed to execute '${method}' on 'Node': This node type does not support this method.`);
    if (isShadowRoot(nodeW)) throw hier(`Failed to execute '${method}' on 'Node': The new child is a shadow root.`);
    const nt = typeOf(nodeW);
    if (nid === pid || (nt !== 3 && nt !== 8 && N.firstChild(nid) !== 0 && N.contains(nid, pid))) {
      throw hier(`Failed to execute '${method}' on 'Node': The new child element contains the parent.`);
    }
    if (refId !== 0 && N.parent(refId) !== pid) {
      throw notFound(`Failed to execute '${method}' on 'Node': The node before which the new node is to be inserted is not a child of this node.`);
    }
    if (nt === 9 || nt === 2) throw hier(`Failed to execute '${method}' on 'Node': Nodes of type '${nodeW.nodeName}' may not be inserted inside nodes of type '${parentW.nodeName}'.`);
    if ((nt === 3 && pt === 9) || (nt === 10 && pt !== 9)) {
      throw hier(`Failed to execute '${method}' on 'Node': Nodes of type '${nodeW.nodeName}' may not be inserted inside nodes of type '${parentW.nodeName}'.`);
    }
    if (pt === 9) {
      if (nt === 1 || nt === 11) {
        const els = nt === 1 ? 1 : N.childElementIds(nid).length;
        if (els > 1 || (els === 1 && docElementId(pid) !== 0 && docElementId(pid) !== nid)) {
          throw hier(`Failed to execute '${method}' on 'Node': Only one element on document allowed.`);
        }
      }
    }
  }
  function docElementId(docId) {
    for (let c = N.firstChild(docId); c !== 0; c = N.nextSibling(c)) if (N.nodeType(c) === 1) return c;
    return 0;
  }

  // Parent resolution for shadow roots / shadow hosts
  function realParent(parentW) {
    // returns [pid, effectiveParentWrapper]
    return idOf(parentW);
  }

  function preInsert(parentW, nodeW, childW, method) {
    const pid = realParent(parentW);
    const nid = L.nodeArg(nodeW, method, 1);
    let refId = childW === null || childW === undefined ? 0 : L.nodeArg(childW, method, 2);
    const sr = isShadowRoot(parentW) ? parentW : null;
    if (sr === null && lightFragOf(parentW) !== 0) return lightInsert(parentW, nodeW, nid, refId, method);
    ensurePreInsert(parentW, pid, nodeW, nid, refId, method);
    if (refId === nid) refId = N.nextSibling(nid);
    if (sr !== null) shadowPrepare(sr);
    insertCore(pid, parentW, nodeW, nid, refId);
    if (sr !== null) shadowDistribute(sr);
    return nodeW;
  }
  L.preInsert = preInsert;
  // Light-DOM insertion into a shadow host whose shadow root has content: the node goes to
  // the hidden light fragment and is then distributed into the matching <slot>.
  function lightInsert(hostW, nodeW, nid, refId, method) {
    const sr = shadowOfHost.get(hostW);
    const info = shadowInfo.get(sr);
    const refParent = refId !== 0 ? N.parent(refId) : 0;
    const hostId = idOf(hostW);
    if (refParent !== 0 && refParent !== info.lightFrag && !N.contains(hostId, refParent)) {
      throw notFound(`Failed to execute '${method}' on 'Node': The node before which the new node is to be inserted is not a child of this node.`);
    }
    const target = refParent !== 0 ? refParent : info.lightFrag;
    const tw = wrap(target);
    ensurePreInsert(tw, target, nodeW, nid, refId, method);
    insertCore(target, tw, nodeW, nid, refId);
    shadowDistribute(sr);
    return nodeW;
  }

  function removeChildImpl(parentW, childW) {
    const pid = idOf(parentW);
    const cid = L.nodeArg(childW, 'removeChild', 1);
    let actual = pid;
    if (N.parent(cid) !== pid) {
      const lf = lightFragOf(parentW);
      const p = N.parent(cid);
      if (lf !== 0 && p !== 0 && (p === lf || N.contains(pid, p))) actual = p;
      else throw notFound("Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.");
    }
    const sr = isShadowRoot(parentW) ? parentW : null;
    removeCore(actual, actual === pid ? parentW : wrap(actual), cid);
    if (sr !== null) shadowDistribute(sr);
    return childW;
  }

  function replaceChildImpl(parentW, nodeW, childW) {
    const pid = idOf(parentW);
    const nid = L.nodeArg(nodeW, 'replaceChild', 1);
    const cid = L.nodeArg(childW, 'replaceChild', 2);
    const pt = typeOf(parentW);
    if (pt !== 9 && pt !== 11 && pt !== 1) throw hier();
    if (nid === pid || (N.firstChild(nid) !== 0 && N.contains(nid, pid))) throw hier("Failed to execute 'replaceChild' on 'Node': The new child element contains the parent.");
    if (N.parent(cid) !== pid) throw notFound("Failed to execute 'replaceChild' on 'Node': The node to be replaced is not a child of this node.");
    const nt = typeOf(nodeW);
    if (nt === 9 || isShadowRoot(nodeW) || (nt === 3 && pt === 9) || (nt === 10 && pt !== 9)) throw hier();
    if (nid === cid) return childW;
    const mo = moRegCount !== 0, ce = ceActive();
    const isFrag = nt === 11;
    let prev = 0, next = 0, added = null, ceRemoved = null, oldParent = 0, oldPrev = 0, oldNext = 0, ceMoved = null;
    if (mo) {
      next = N.nextSibling(cid);
      if (next === nid) next = N.nextSibling(nid);
      prev = N.prevSibling(cid);
      if (prev === nid) prev = N.prevSibling(nid);
    }
    if (isFrag) added = N.childIds(nid);
    else {
      oldParent = N.parent(nid);
      if (oldParent !== 0 && (mo || ce)) {
        if (mo) { oldPrev = N.prevSibling(nid); oldNext = N.nextSibling(nid); }
        if (ce && N.isConnected(nid)) ceMoved = collectCE(nid, true);
      }
    }
    if (ce && N.isConnected(cid)) ceRemoved = collectCE(cid, true);
    nativeCall(() => N.replaceChild(pid, nid, cid));
    childListChanged(pid, isFrag ? nid : oldParent);
    const insertedIds = isFrag ? added : [nid];
    if (mo) {
      if (oldParent !== 0 && oldParent !== pid) queueMutation('childList', oldParent, null, null, null, [nid], oldPrev, oldNext);
      queueMutation('childList', pid, null, null, insertedIds, [cid], prev, next);
    }
    if (ceRemoved !== null && ceRemoved.length) ceDisconnected(ceRemoved);
    if (ceMoved !== null && ceMoved.length) ceDisconnected(ceMoved);
    afterInsertion(pid, parentW, insertedIds);
    return childW;
  }

  // Convert (Node or string)... into a single node (ParentNode/ChildNode helpers)
  function convertNodes(args, method) {
    if (args.length === 1) {
      const a = args[0];
      if (isNode(a) && !isShadowRoot(a)) return a;
      if (!isNode(a)) return makeWrapper(N.createText(`${a}`), 3, Text.prototype);
    }
    const frag = N.createFragment();
    for (const a of args) {
      if (isNode(a)) {
        const nid = L.nodeArg(a, method, 1);
        if (typeOf(a) === 11) {
          for (const c of N.childIds(nid)) N.appendChild(frag, c);
        } else {
          if (N.parent(nid) !== 0 && moRegCount !== 0) {
            const op = N.parent(nid);
            queueMutation('childList', op, null, null, null, [nid], N.prevSibling(nid), N.nextSibling(nid));
          }
          nativeCall(() => N.appendChild(frag, nid));
        }
      } else {
        N.appendChild(frag, N.createText(`${a}`));
      }
    }
    treeChanged();
    return wrap(frag);
  }

  // Attribute mutation core
  const ATTR_HOOKS = new Map(); // attribute name -> [fn(w, id, name, old, value)]
  L.ATTR_HOOKS = ATTR_HOOKS;
  L.addAttrHook = function (name, fn) {
    let a = ATTR_HOOKS.get(name);
    if (a === undefined) { a = []; ATTR_HOOKS.set(name, a); }
    a.push(fn);
  };
  function setAttrCore(w, id, name, value) {
    const def = ceDefs.size !== 0 ? ceState.get(w) : undefined;
    const observed = def !== undefined && def.observed.has(name);
    const mo = moRegCount !== 0;
    const hooks = ATTR_HOOKS.get(name);
    let old = null;
    if (mo || observed || hooks !== undefined) old = N.getAttr(id, name);
    nativeCall(() => N.setAttr(id, name, value));
    state.attr++;
    if (mo) queueMutation('attributes', id, name, old, null, null, 0, 0);
    if (observed) ceCallback(w, def, 'attributeChangedCallback', [name, old, value, null]);
    if (name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110) L.handlerAttrChanged(w, name, value);
    if (hooks !== undefined) for (const h of hooks) h(w, id, name, old, value);
    if (L.observersDirty !== null) L.observersDirty();
  }
  function removeAttrCore(w, id, name) {
    const old = N.getAttr(id, name);
    if (old === null) return;
    nativeCall(() => N.removeAttr(id, name));
    state.attr++;
    if (moRegCount !== 0) queueMutation('attributes', id, name, old, null, null, 0, 0);
    const def = ceDefs.size !== 0 ? ceState.get(w) : undefined;
    if (def !== undefined && def.observed.has(name)) ceCallback(w, def, 'attributeChangedCallback', [name, old, null, null]);
    if (name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110) L.handlerAttrChanged(w, name, null);
    const hooks = ATTR_HOOKS.get(name);
    if (hooks !== undefined) for (const h of hooks) h(w, id, name, old, null);
    if (L.observersDirty !== null) L.observersDirty();
  }
  L.setAttr = setAttrCore;
  L.removeAttr = removeAttrCore;
  // Set/remove through the public semantics (null removes)
  L.setAttrOrRemove = function (w, name, value) {
    if (value === null) removeAttrCore(w, idOf(w), name);
    else setAttrCore(w, idOf(w), name, value);
  };

  // Character data mutation core
  // Set the data of a CharacterData node. `offset`/`count`/`added` describe the replaced
  // segment for live ranges (default: the whole data).
  function setDataCore(w, id, data, offset, count, added) {
    const mo = moRegCount !== 0, lr = liveRanges.size !== 0;
    const old = mo || (lr && offset === undefined) ? N.getText(id) : null;
    if (lr) {
      if (offset === undefined) rangesOnReplaceData(id, 0, old.length, data.length);
      else rangesOnReplaceData(id, offset, count, added);
    }
    N.setText(id, data);
    if (mo) queueMutation('characterData', id, null, old, null, null, 0, 0);
    if (titleIds.size !== 0 && titleIds.has(N.parent(id))) titleChanged();
    if (L.observersDirty !== null) L.observersDirty();
  }
  L.setDataCore = setDataCore;

  // Parse an HTML fragment in the context of element `ctxW` (wrapper or null = body).
  const SPECIAL_CONTEXTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup',
    'col', 'select', 'optgroup', 'option', 'template', 'html', 'head', 'frameset', 'title', 'textarea', 'style',
    'script', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'noscript']);
  function parseFragment(ctxW, html) {
    let ln = 'body', ns = HTML;
    if (ctxW !== null && ctxW !== undefined && typeOf(ctxW) === 1) { ln = lnOf(ctxW); ns = nsOf(ctxW); }
    let frag;
    if (ns === HTML && (ln === 'html' || !SPECIAL_CONTEXTS.has(ln))) {
      frag = nativeCall(() => N.parseHTMLFragment(html));
    } else {
      const tmp = N.createElement(ln, ns === HTML ? '' : L.nsURIOfCode[ns] || '');
      nativeCall(() => N.setInnerHTML(tmp, html));
      // a native with template contents parses a <template> context into its content fragment
      const from = ln === 'template' && ns === HTML && typeof N.templateContent === 'function' ? N.templateContent(tmp) : tmp;
      frag = N.createFragment();
      let c;
      while ((c = N.firstChild(from)) !== 0) N.appendChild(frag, c);
    }
    extractTemplates(frag, html);
    return frag;
  }
  L.parseFragment = parseFragment;
  // Template contents are not part of the tree: move parsed <template> children into their
  // content fragments right after parsing (the native parser leaves them as children).
  const TEMPLATE_TAG_RE = /<template/i;
  function extractTemplates(rootId, html) {
    if (L.templateInfo === null || (html !== undefined && !TEMPLATE_TAG_RE.test(html))) return;
    let ids;
    try { ids = N.querySelectorAll(rootId, 'template'); } catch (_) { return; }
    for (let i = 0; i < ids.length; i++) {
      const w = wrap(ids[i]);
      if (w !== null && nsOf(w) === HTML) L.templateInfo(w);
    }
  }
  L.extractTemplates = extractTemplates;

  // ---------------------------------------------------------------------------------------
  // Node
  // ---------------------------------------------------------------------------------------
  const childNodesCache = new WeakMap();
  function nodeNameOf(w) {
    switch (typeOf(w)) {
      case 1: return tagNameOf(w);
      case 3: return '#text';
      case 4: return '#cdata-section';
      case 7: return piTarget.get(w) || '';
      case 8: return '#comment';
      case 9: return '#document';
      case 10: { const info = doctypeInfo.get(w); return info !== undefined ? info.name : 'html'; }
      case 11: return '#document-fragment';
      default: return '';
    }
  }
  const upperCache = new Map();
  // The qualified name (prefix included): "div", "x:b".
  function qualifiedNameOf(w) {
    const ln = lnOf(w);
    const p = elementPrefix.get(w);
    return p ? p + ':' + ln : ln;
  }
  // The HTML-uppercased qualified name (prefix included): "DIV", "X:B", but "svg".
  function tagNameOf(w) {
    const q = qualifiedNameOf(w);
    if (nsOf(w) !== HTML) return q;
    let u = upperCache.get(q);
    if (u === undefined) {
      u = L.asciiUpper(q);
      upperCache.set(q, u);
    }
    return u;
  }
  const piTarget = new WeakMap();

  function ownerDocumentOf(w) {
    if (detachedDocs === 0) return document;
    const id = idOf(w);
    if (N.isConnected(id)) return document;
    let r = id, p;
    while ((p = N.parent(r)) !== 0) r = p;
    const rw = cache.get(r);
    if (rw !== undefined && docState.has(rw)) return rw;
    return document;
  }
  L.ownerDocumentOf = ownerDocumentOf;

  function isTemplate(w) { return typeOf(w) === 1 && lnOf(w) === 'template' && nsOf(w) === HTML && L.templateInfo !== null; }
  function textContentGet(w) {
    const t = typeOf(w);
    if (t === 1 || t === 11) {
      if (isTemplate(w)) L.templateInfo(w); // parsed children belong to .content
      return N.textContent(idOf(w));
    }
    if (t === 3 || t === 8 || t === 4 || t === 7) return N.getText(idOf(w));
    return null;
  }
  function textContentSet(w, v) {
    const t = typeOf(w);
    const s = v === null || v === undefined ? '' : `${v}`;
    if (t === 1 || t === 11) {
      const id = idOf(w);
      if (isTemplate(w)) L.templateInfo(w);
      const sr = isShadowRoot(w) ? w : null;
      if (sr !== null) shadowPrepare(sr);
      replaceAllCore(id, sr !== null ? undefined : w, () => N.setTextContent(id, s));
    } else if (t === 3 || t === 8 || t === 4 || t === 7) {
      setDataCore(w, idOf(w), s);
    }
  }

  L.mixin(Node.prototype, {
    get nodeType() { return typeOf(this); },
    get nodeName() { return nodeNameOf(this); },
    get baseURI() { return L.baseURL(); },
    get isConnected() { return N.isConnected(idOf(this)); },
    get ownerDocument() {
      if (typeOf(this) === 9) return null;
      return ownerDocumentOf(this);
    },
    getRootNode(options) {
      if (isShadowRoot(this)) return this;
      let r = idOf(this), p;
      while ((p = N.parent(r)) !== 0) r = p;
      return wrap(r);
    },
    get parentNode() {
      if (isShadowRoot(this)) return null;
      return wrap(N.parent(idOf(this)));
    },
    get parentElement() {
      if (isShadowRoot(this)) return null;
      const p = N.parent(idOf(this));
      if (p === 0) return null;
      const w = wrap(p);
      return typeOf(w) === 1 ? w : null;
    },
    hasChildNodes() { return N.firstChild(idOf(this)) !== 0; },
    get childNodes() {
      let l = childNodesCache.get(this);
      if (l === undefined) {
        l = new NodeList(INTERNAL, 1, idOf(this));
        childNodesCache.set(this, l);
      }
      return l;
    },
    get firstChild() { return wrap(N.firstChild(idOf(this))); },
    get lastChild() { return wrap(N.lastChild(idOf(this))); },
    get previousSibling() {
      if (isShadowRoot(this)) return null;
      return wrap(N.prevSibling(idOf(this)));
    },
    get nextSibling() {
      if (isShadowRoot(this)) return null;
      return wrap(N.nextSibling(idOf(this)));
    },
    get nodeValue() {
      const t = typeOf(this);
      return t === 3 || t === 8 || t === 4 || t === 7 ? N.getText(idOf(this)) : null;
    },
    set nodeValue(v) {
      const t = typeOf(this);
      if (t === 3 || t === 8 || t === 4 || t === 7) setDataCore(this, idOf(this), v === null ? '' : `${v}`);
    },
    get textContent() { return textContentGet(this); },
    set textContent(v) { textContentSet(this, v); },
    normalize() { normalizeNode(idOf(this)); },
    cloneNode(deep = false) { return cloneNodeImpl(this, !!deep); },
    isEqualNode(other) {
      if (other === null || other === undefined) return false;
      if (!isNode(other)) throw new TypeError("Failed to execute 'isEqualNode' on 'Node': parameter 1 is not of type 'Node'.");
      return nodesEqual(idOf(this), idOf(other));
    },
    isSameNode(other) { return this === other; },
    compareDocumentPosition(other) {
      const oid = L.nodeArg(other, 'compareDocumentPosition', 1);
      const id = idOf(this);
      if (oid === id) return 0;
      return N.compareDocumentPosition(id, oid);
    },
    contains(other) {
      if (other === null || other === undefined) return false;
      const oid = L.nodeArg(other, 'contains', 1);
      if (isShadowRoot(other) && other !== this) return false;
      return N.contains(idOf(this), oid);
    },
    lookupPrefix(namespace) {
      if (namespace === null || namespace === undefined || namespace === '') return null;
      let id = idOf(this);
      if (typeOf(this) !== 1) id = N.parent(id);
      for (; id !== 0; id = N.parent(id)) {
        if (N.nodeType(id) !== 1) continue;
        for (const n of N.attrNames(id)) {
          if (n.startsWith('xmlns:') && N.getAttr(id, n) === `${namespace}`) return n.slice(6);
        }
      }
      return null;
    },
    lookupNamespaceURI(prefix) {
      const p = prefix === null || prefix === undefined || prefix === '' ? null : `${prefix}`;
      if (p === 'xml') return L.NS.XML;
      if (p === 'xmlns') return L.NS.XMLNS;
      let w = this;
      if (typeOf(w) === 9) w = w.documentElement;
      else if (typeOf(w) !== 1) w = w.parentElement;
      for (; w !== null && w !== undefined; w = w.parentElement) {
        const id = idOf(w);
        if (p === null && N.hasAttr(id, 'xmlns')) return N.getAttr(id, 'xmlns') || null;
        if (p !== null && N.hasAttr(id, 'xmlns:' + p)) return N.getAttr(id, 'xmlns:' + p) || null;
        if (p === null && nsOf(w) !== NONE) return L.nsURIOfCode[nsOf(w)];
      }
      return null;
    },
    isDefaultNamespace(namespace) {
      const ns = namespace === '' || namespace === undefined ? null : namespace;
      return this.lookupNamespaceURI(null) === ns;
    },
    insertBefore(node, child) {
      if (arguments.length < 2) throw new TypeError(`Failed to execute 'insertBefore' on 'Node': 2 arguments required, but only ${arguments.length} present.`);
      return preInsert(this, node, child, 'insertBefore');
    },
    appendChild(node) { return preInsert(this, node, null, 'appendChild'); },
    replaceChild(node, child) { return replaceChildImpl(this, node, child); },
    removeChild(child) { return removeChildImpl(this, child); },
  });
  L.defineConstants([Node, Node.prototype], {
    ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4, ENTITY_REFERENCE_NODE: 5,
    ENTITY_NODE: 6, PROCESSING_INSTRUCTION_NODE: 7, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11, NOTATION_NODE: 12, DOCUMENT_POSITION_DISCONNECTED: 1,
    DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINS: 8,
    DOCUMENT_POSITION_CONTAINED_BY: 16, DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
  });

  function normalizeNode(id) {
    let c = N.firstChild(id);
    while (c !== 0) {
      const next = N.nextSibling(c);
      const t = N.nodeType(c);
      if (t === 3) {
        const data = N.getText(c);
        if (data === '') {
          removeCore(id, undefined, c);
          c = next;
          continue;
        }
        // Spec order: append the following text nodes' data first (a replace-data step
        // that moves no range), then move the ranges from each merged node, then remove it.
        let s = next, merged = data;
        const toMerge = [];
        while (s !== 0 && N.nodeType(s) === 3) { toMerge.push(s); merged += N.getText(s); s = N.nextSibling(s); }
        if (merged !== data) setDataCore(wrap(c), c, merged, data.length, 0, merged.length - data.length);
        let length = data.length;
        for (const m of toMerge) {
          if (liveRanges.size !== 0) rangesOnMerge(c, m, id, indexOfNode(m), length);
          length += N.getText(m).length;
          removeCore(id, undefined, m);
        }
        c = s;
        continue;
      }
      if (t === 1) normalizeNode(c);
      c = next;
    }
  }

  function nodesEqual(a, b) {
    const ta = N.nodeType(a);
    if (ta !== N.nodeType(b)) return false;
    if (ta === 1) {
      if (N.localName(a) !== N.localName(b) || N.namespaceURI(a) !== N.namespaceURI(b)) return false;
      const an = N.attrNames(a), bn = N.attrNames(b);
      if (an.length !== bn.length) return false;
      for (const n of an) if (N.getAttr(a, n) !== N.getAttr(b, n)) return false;
    } else if (ta === 3 || ta === 8 || ta === 4 || ta === 7) {
      if (N.getText(a) !== N.getText(b)) return false;
    }
    const ca = N.childIds(a), cb = N.childIds(b);
    if (ca.length !== cb.length) return false;
    for (let i = 0; i < ca.length; i++) if (!nodesEqual(ca[i], cb[i])) return false;
    return true;
  }

  L.cloneHooks = []; // fns(srcW, cloneW, deep) — form state, template contents, ...
  function cloneNodeImpl(w, deep) {
    const t = typeOf(w);
    if (isShadowRoot(w)) throw new DOMException("Failed to execute 'cloneNode' on 'Node': ShadowRoot nodes are not clonable.", 'NotSupportedError');
    if (t === 9) return cloneDocument(w, deep);
    if (t === 2) return w.cloneNode(deep);
    const id = idOf(w);
    const cid = nativeCall(() => N.cloneNode(id, deep));
    if (t === 1 || t === 11) mirrorForeignWrappers(id, cid, deep);
    else if (t === 4 || t === 7 || t === 10) mirrorTypedLeaf(w, cid);
    const cw = wrap(cid);
    for (const h of L.cloneHooks) h(w, cw, deep);
    if (ceActive()) ceUpgradeSubtree(cid, true);
    return cw;
  }
  // Elements of XML documents carry their namespace/case only in the JS stamp; give their
  // clones the same stamp.
  function mirrorTypedLeaf(sw, dst) {
    const t = typeOf(sw);
    const cw = makeWrapper(dst, t, Object.getPrototypeOf(sw));
    if (t === 7) piTarget.set(cw, piTarget.get(sw));
    else if (t === 10) L.copyDoctypeInfo(sw, cw);
  }
  function mirrorForeignWrappers(src, dst, deep) {
    const sw = cache.get(src);
    if (sw !== undefined && typeOf(sw) === 1 && (nsOf(sw) === NONE || nsOf(sw) === OTHER) && !cache.has(dst)) {
      const cw = L.wrapElementAs(dst, Object.getPrototypeOf(sw), lnOf(sw), nsOf(sw));
      if (elementNsOther.has(sw)) elementNsOther.set(cw, elementNsOther.get(sw));
      if (elementPrefix.has(sw)) { elementPrefix.set(cw, elementPrefix.get(sw)); prefixedElements++; }
    }
    if (!deep || foreignWrappers === 0) return;
    const a = N.childIds(src), b = N.childIds(dst);
    for (let i = 0; i < a.length && i < b.length; i++) {
      if (N.nodeType(a[i]) === 1) { mirrorForeignWrappers(a[i], b[i], true); continue; }
      const cw = cache.get(a[i]);
      if (cw !== undefined && !cache.has(b[i])) { const t = typeOf(cw); if (t === 4 || t === 7) mirrorTypedLeaf(cw, b[i]); }
    }
  }
  function cloneDocument(w, deep) {
    const info = docState.get(w);
    const d = L.createDetachedDocument(info.contentType === 'text/html' ? 'html-bare' : 'xml', info.contentType,
      Object.getPrototypeOf(w) === HTMLDocument.prototype ? HTMLDocument.prototype : Object.getPrototypeOf(w));
    if (deep) {
      for (const c of N.childIds(idOf(w))) N.appendChild(idOf(d), idOf(cloneNodeImpl(wrap(c), true)));
      treeChanged();
    }
    return d;
  }

  // ---------------------------------------------------------------------------------------
  // NodeList
  // ---------------------------------------------------------------------------------------
  // kind 0: static ids, 1: live childNodes of a parent id, 2: static wrappers
  class NodeList {
    #kind; #src; #ids = null; #epoch = -1; #pv = -1;
    constructor(token, kind, src) {
      if (token !== INTERNAL) throw L.illegal();
      this.#kind = kind;
      this.#src = src;
    }
    static {
      L.nlIds = (o) => {
        const k = o.#kind;
        if (k === 1) {
          const pv = childVerOf(o.#src);
          if (o.#epoch !== state.untracked || o.#pv !== pv) {
            o.#ids = N.childIds(o.#src);
            o.#epoch = state.untracked;
            o.#pv = pv;
          }
          return o.#ids;
        }
        if (k === 3) { // live query (getElementsByName)
          const ep = state.tree * 1048576 + state.attr;
          if (o.#epoch !== ep) {
            o.#ids = N.querySelectorAll(o.#src.scope, o.#src.sel);
            o.#epoch = ep;
          }
          return o.#ids;
        }
        return o.#src;
      };
      L.nlKind = (o) => o.#kind;
    }
    get length() {
      const n = L.nlIds(this).length;
      if (n > 64) L.ensureIndexed(NodeList.prototype, n);
      return n;
    }
    item(i) {
      const v = nodeListItem(this, i >>> 0);
      return v === undefined ? null : v;
    }
    forEach(cb, thisArg) {
      const ids = L.nlIds(this);
      for (let i = 0; i < ids.length; i++) {
        const cur = L.nlIds(this);
        if (i >= cur.length) break;
        Reflect.apply(cb, thisArg, [nodeListItem(this, i), i, this]);
      }
    }
    *entries() { for (let i = 0; i < L.nlIds(this).length; i++) yield [i, nodeListItem(this, i)]; }
    *keys() { for (let i = 0; i < L.nlIds(this).length; i++) yield i; }
    *values() { for (let i = 0; i < L.nlIds(this).length; i++) yield nodeListItem(this, i); }
  }
  NodeList.prototype[Symbol.iterator] = NodeList.prototype.values;
  function nodeListItem(o, i) {
    const src = L.nlIds(o);
    if (i >= src.length) return undefined;
    return L.nlKind(o) === 2 ? src[i] : wrap(src[i]);
  }
  L.makeIndexed(NodeList.prototype, nodeListItem, 128);
  L.NodeList = NodeList;
  L.staticNodeList = function (ids) { return new NodeList(INTERNAL, 0, ids); };
  L.staticNodeListW = function (ws) { return new NodeList(INTERNAL, 2, ws); };

  // ---------------------------------------------------------------------------------------
  // HTMLCollection (live, cached per mutation epoch; some collections support named access)
  // ---------------------------------------------------------------------------------------
  const HC = new WeakMap();
  class HTMLCollection {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get length() {
      const n = hcIds(hcData(this)).length;
      if (n > 64) L.ensureIndexed(HTMLCollection.prototype, n);
      return n;
    }
    item(i) {
      const ids = hcIds(hcData(this));
      const id = ids[Number(i) >>> 0];
      return id === undefined ? null : wrap(id);
    }
    namedItem(name) { return hcNamed(hcData(this), `${name}`); }
    *[Symbol.iterator]() {
      const d = hcData(this);
      for (let i = 0; i < hcIds(d).length; i++) yield wrap(hcIds(d)[i]);
    }
  }
  function hcData(o) {
    const d = HC.get(o);
    if (d === undefined) throw new TypeError('Illegal invocation');
    return d;
  }
  function hcIds(d) {
    let ep;
    switch (d.kind) {
      case 0: return d.ids; // static
      case 1: { // children
        const pv = childVerOf(d.src);
        if (d.epoch !== state.untracked || d.pv !== pv) { d.ids = N.childElementIds(d.src); d.epoch = state.untracked; d.pv = pv; }
        return d.ids;
      }
      default:
        ep = state.tree * 1048576 + state.attr;
        if (d.epoch !== ep) { d.ids = d.compute(); d.epoch = ep; }
        return d.ids;
    }
  }
  function hcNamed(d, name) {
    if (name === '') return null;
    const ids = hcIds(d);
    for (const id of ids) if (N.getAttr(id, 'id') === name) return wrap(id);
    for (const id of ids) {
      if (N.getAttr(id, 'name') === name && N.namespaceURI(id) === L.NS.HTML) return wrap(id);
    }
    return null;
  }
  L.makeIndexed(HTMLCollection.prototype, (o, i) => {
    const d = HC.get(o);
    if (d === undefined) return undefined;
    const id = hcIds(d)[i];
    return id === undefined ? undefined : wrap(id);
  }, 128);
  const namedCollectionHandler = {
    get(t, p, r) {
      if (typeof p === 'string' && !(p in t)) {
        const v = hcNamed(HC.get(r), p);
        if (v !== null) return v;
      }
      return Reflect.get(t, p, r);
    },
    has(t, p) {
      if (Reflect.has(t, p)) return true;
      return typeof p === 'string' && hcNamed(HC.get(t), p) !== null;
    },
  };
  // kind: 1 children(parentId); 2 query(scopeId, selector); 3 custom compute fn; 0 static ids
  L.makeHTMLCollection = function (d, named, Ctor) {
    const o = new (Ctor || HTMLCollection)(INTERNAL);
    d.epoch = -1;
    if (d.ids === undefined) d.ids = null;
    HC.set(o, d);
    if (!named) return o;
    const p = new Proxy(o, namedCollectionHandler);
    HC.set(p, d);
    return p;
  };
  L.hcData = hcData;
  L.hcIds = hcIds;
  L.HTMLCollection = HTMLCollection;
  function queryCollection(scopeId, selector, named) {
    return L.makeHTMLCollection({ kind: 2, compute: () => N.querySelectorAll(scopeId, selector) }, named);
  }
  L.queryCollection = queryCollection;
  function emptyCollection() { return L.makeHTMLCollection({ kind: 0, ids: [] }, false); }

  function tagSelector(qn) {
    if (qn === '*') return '*';
    return L.cssEscape(qn);
  }
  function classSelector(names) {
    const toks = L.splitWS(`${names}`);
    if (toks.length === 0) return null;
    return toks.map((t) => '.' + L.cssEscape(t)).join('');
  }
  function getElementsByTagNameImpl(scopeId, qn) {
    qn = `${qn}`;
    // The selector engine matches the local name (HTML elements case-insensitively, others
    // exactly), which is the spec's rule for qualified names without a prefix. Prefixed
    // elements (createElementNS(ns, 'a:b')) only exist when a page made some.
    if (qn !== '*' && (prefixedElements !== 0 || qn.includes(':'))) {
      const lower = L.asciiLower(qn);
      const compute = () => N.querySelectorAll(scopeId, '*').filter((id) => {
        const w = wrap(id);
        const q = qualifiedNameOf(w);
        return nsOf(w) === HTML ? q === lower : q === qn;
      });
      return L.makeHTMLCollection({ kind: 3, compute }, false);
    }
    return queryCollection(scopeId, tagSelector(qn), false);
  }
  function getElementsByClassNameImpl(scopeId, names) {
    const sel = classSelector(names);
    return sel === null ? emptyCollection() : queryCollection(scopeId, sel, false);
  }
  function getElementsByTagNameNSImpl(scopeId, ns, local) {
    const l = `${local}`;
    const nsv = ns === null || ns === undefined || ns === '' ? null : `${ns}`;
    const compute = () => {
      const ids = N.querySelectorAll(scopeId, l === '*' ? '*' : L.cssEscape(l));
      if (nsv === '*') return ids;
      return ids.filter((id) => (N.namespaceURI(id) || null) === nsv || (nsv === L.NS.HTML && N.namespaceURI(id) === ''));
    };
    return L.makeHTMLCollection({ kind: 3, compute }, false);
  }

  // ---------------------------------------------------------------------------------------
  // DOMTokenList
  // ---------------------------------------------------------------------------------------
  class DOMTokenList {
    #el; #attr; #supported; #str = null; #tokens = [];
    constructor(token, el, attr, supported) {
      if (token !== INTERNAL) throw L.illegal();
      this.#el = el;
      this.#attr = attr;
      this.#supported = supported || null;
    }
    static {
      L.dtlTokens = (o) => {
        const s = N.getAttr(idOf(o.#el), o.#attr);
        const str = s === null ? '' : s;
        if (str !== o.#str) {
          o.#str = str;
          const parts = L.splitWS(str);
          o.#tokens = parts.length > 1 ? Array.from(new Set(parts)) : parts;
        }
        return o.#tokens;
      };
      L.dtlUpdate = (o, tokens) => {
        const id = idOf(o.#el);
        if (tokens.length === 0 && !N.hasAttr(id, o.#attr)) return;
        setAttrCore(o.#el, id, o.#attr, tokens.join(' '));
      };
      L.dtlSupported = (o) => o.#supported;
      L.dtlAttr = (o) => o.#attr;
      L.dtlEl = (o) => o.#el;
    }
    get length() { return L.dtlTokens(this).length; }
    item(i) { const t = L.dtlTokens(this)[Number(i) >>> 0]; return t === undefined ? null : t; }
    contains(token) { return L.dtlTokens(this).includes(`${token}`); }
    add(...tokens) {
      const toks = tokens.map(validateToken);
      const list = L.dtlTokens(this).slice();
      for (const t of toks) if (!list.includes(t)) list.push(t);
      L.dtlUpdate(this, list);
    }
    remove(...tokens) {
      const toks = tokens.map(validateToken);
      const list = L.dtlTokens(this).filter((t) => !toks.includes(t));
      L.dtlUpdate(this, list);
    }
    toggle(token, force) {
      const t = validateToken(token);
      const list = L.dtlTokens(this);
      if (list.includes(t)) {
        if (force === undefined || !force) {
          L.dtlUpdate(this, list.filter((x) => x !== t));
          return false;
        }
        return true;
      }
      if (force === undefined || force) {
        L.dtlUpdate(this, list.concat([t]));
        return true;
      }
      return false;
    }
    replace(token, newToken) {
      const t = validateToken(token), n = validateToken(newToken);
      const list = L.dtlTokens(this);
      if (!list.includes(t)) return false;
      const out = [];
      for (const x of list) {
        const v = x === t ? n : x;
        if (!out.includes(v)) out.push(v);
      }
      L.dtlUpdate(this, out);
      return true;
    }
    supports(token) {
      const sup = L.dtlSupported(this);
      if (sup === null) throw new TypeError(`Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens.`);
      return sup.has(L.asciiLower(`${token}`));
    }
    get value() { const s = N.getAttr(idOf(L.dtlEl(this)), L.dtlAttr(this)); return s === null ? '' : s; }
    set value(v) { setAttrCore(L.dtlEl(this), idOf(L.dtlEl(this)), L.dtlAttr(this), `${v}`); }
    toString() { return this.value; }
    forEach(cb, thisArg) {
      const list = L.dtlTokens(this).slice();
      for (let i = 0; i < list.length; i++) Reflect.apply(cb, thisArg, [list[i], i, this]);
    }
    entries() { return L.dtlTokens(this).slice().entries(); }
    keys() { return L.dtlTokens(this).slice().keys(); }
    values() { return L.dtlTokens(this).slice().values(); }
    [Symbol.iterator]() { return L.dtlTokens(this).slice()[Symbol.iterator](); }
  }
  function validateToken(t) {
    const s = `${t}`;
    if (s === '') throw new DOMException("Failed to execute on 'DOMTokenList': The token provided must not be empty.", 'SyntaxError');
    if (/[\t\n\f\r ]/.test(s)) throw invalidChar(`Failed to execute on 'DOMTokenList': The token provided ('${s}') contains HTML space characters, which are not valid in tokens.`);
    return s;
  }
  L.makeIndexed(DOMTokenList.prototype, (o, i) => L.dtlTokens(o)[i], 32);
  L.DOMTokenList = DOMTokenList;
  const tokenListCache = new WeakMap(); // el -> Map(attr -> list)
  L.tokenList = function (el, attr, supported) {
    let m = tokenListCache.get(el);
    if (m === undefined) { m = new Map(); tokenListCache.set(el, m); }
    let l = m.get(attr);
    if (l === undefined) { l = new DOMTokenList(INTERNAL, el, attr, supported); m.set(attr, l); }
    return l;
  };

  // ---------------------------------------------------------------------------------------
  // DOMStringMap (dataset)
  // ---------------------------------------------------------------------------------------
  class DOMStringMap {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
  }
  const datasetCache = new WeakMap();
  const datasetEl = new WeakMap();
  function camelToData(p) {
    if (/-[a-z]/.test(p)) throw new DOMException(`Failed to set a named property '${p}' on 'DOMStringMap': '${p}' is not a valid property name.`, 'SyntaxError');
    return 'data-' + p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  }
  function dataToCamel(n) { return n.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase()); }
  const datasetHandler = {
    get(t, p, r) {
      if (typeof p === 'string') {
        const el = datasetEl.get(r) || datasetEl.get(t);
        if (!/-[a-z]/.test(p)) {
          const v = N.getAttr(idOf(el), 'data-' + p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
          if (v !== null) return v;
        }
      }
      return Reflect.get(t, p, r);
    },
    set(t, p, v, r) {
      if (typeof p !== 'string') return Reflect.set(t, p, v, r);
      const el = datasetEl.get(t);
      setAttrCore(el, idOf(el), camelToData(p), `${v}`);
      return true;
    },
    has(t, p) {
      if (typeof p === 'string' && !/-[a-z]/.test(p)) {
        const el = datasetEl.get(t);
        if (N.hasAttr(idOf(el), 'data-' + p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()))) return true;
      }
      return Reflect.has(t, p);
    },
    deleteProperty(t, p) {
      if (typeof p !== 'string') return Reflect.deleteProperty(t, p);
      if (/-[a-z]/.test(p)) return true;
      const el = datasetEl.get(t);
      removeAttrCore(el, idOf(el), 'data-' + p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
      return true;
    },
    ownKeys(t) {
      const el = datasetEl.get(t);
      const keys = [];
      for (const n of N.attrNames(idOf(el))) if (n.startsWith('data-')) keys.push(dataToCamel(n));
      return keys.concat(Reflect.ownKeys(t));
    },
    getOwnPropertyDescriptor(t, p) {
      if (typeof p === 'string' && !/-[a-z]/.test(p)) {
        const el = datasetEl.get(t);
        const v = N.getAttr(idOf(el), 'data-' + p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
        if (v !== null) return { value: v, writable: true, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(t, p);
    },
    defineProperty(t, p, desc) {
      if (typeof p !== 'string' || !('value' in desc)) return Reflect.defineProperty(t, p, desc);
      const el = datasetEl.get(t);
      setAttrCore(el, idOf(el), camelToData(p), `${desc.value}`);
      return true;
    },
  };
  L.dataset = function (el) {
    let d = datasetCache.get(el);
    if (d === undefined) {
      const t = new DOMStringMap(INTERNAL);
      datasetEl.set(t, el);
      d = new Proxy(t, datasetHandler);
      datasetEl.set(d, el);
      datasetCache.set(el, d);
    }
    return d;
  };

  // ---------------------------------------------------------------------------------------
  // Attr / NamedNodeMap
  // ---------------------------------------------------------------------------------------
  class Attr extends Node {
    #owner; #name; #local; #prefix; #ns; #value;
    constructor(token, owner, name, value, ns, prefix, local) {
      if (token !== INTERNAL) throw L.illegal();
      super(token);
      this.#owner = owner;
      this.#name = name;
      this.#value = value === undefined ? '' : value;
      this.#ns = ns === undefined ? null : ns;
      this.#prefix = prefix === undefined ? null : prefix;
      this.#local = local === undefined ? name : local;
    }
    static {
      L.attrOwner = (a) => a.#owner;
      L.attrSetOwner = (a, o) => { a.#owner = o; };
      L.attrName = (a) => a.#name;
      L.attrStoredValue = (a) => a.#value;
      L.attrSetStoredValue = (a, v) => { a.#value = v; };
      L.isAttr = (a) => typeof a === 'object' && a !== null && #owner in a;
      L.attrNs = (a) => a.#ns;
      L.attrLocal = (a) => a.#local;
    }
    get name() { return this.#name; }
    get localName() { return this.#local; }
    get namespaceURI() { return this.#ns; }
    get prefix() { return this.#prefix; }
    get ownerElement() { return this.#owner; }
    get specified() { return true; }
    get value() {
      if (this.#owner !== null) {
        const v = N.getAttr(idOf(this.#owner), this.#name);
        if (v !== null) return v;
      }
      return this.#value;
    }
    set value(v) {
      const s = `${v}`;
      this.#value = s;
      if (this.#owner !== null) setAttrCore(this.#owner, idOf(this.#owner), this.#name, s);
    }
    get nodeType() { return 2; }
    get nodeName() { return this.#name; }
    get nodeValue() { return this.value; }
    set nodeValue(v) { this.value = v === null ? '' : v; }
    get textContent() { return this.value; }
    set textContent(v) { this.value = v === null ? '' : v; }
    get parentNode() { return null; }
    get parentElement() { return null; }
    get childNodes() { return L.staticNodeList([]); }
    get firstChild() { return null; }
    get lastChild() { return null; }
    get previousSibling() { return null; }
    get nextSibling() { return null; }
    get isConnected() { return this.#owner !== null && N.isConnected(idOf(this.#owner)); }
    get ownerDocument() { return document; }
    get baseURI() { return L.baseURL(); }
    hasChildNodes() { return false; }
    getRootNode() { return this; }
    cloneNode() { return new Attr(INTERNAL, null, this.#name, this.value, this.#ns, this.#prefix, this.#local); }
    isEqualNode(o) { return L.isAttr(o) && o.name === this.name && o.value === this.value; }
    contains(o) { return o === this; }
    compareDocumentPosition(o) { return o === this ? 0 : 1 | 32 | 2; }
    normalize() { }
    appendChild() { throw hier(); }
    insertBefore() { throw hier(); }
    removeChild() { throw notFound('The node to be removed is not a child of this node.'); }
    replaceChild() { throw hier(); }
  }
  L.Attr = Attr;
  const attrNodeCache = new WeakMap(); // element -> Map(name -> Attr)
  function attrNode(el, name) {
    let m = attrNodeCache.get(el);
    if (m === undefined) { m = new Map(); attrNodeCache.set(el, m); }
    let a = m.get(name);
    if (a === undefined || L.attrOwner(a) !== el) {
      const i = name.indexOf(':');
      const prefix = i > 0 ? name.slice(0, i) : null;
      const ns = prefix === 'xlink' ? L.NS.XLINK : prefix === 'xml' ? L.NS.XML : (prefix === 'xmlns' || name === 'xmlns') ? L.NS.XMLNS : null;
      a = new Attr(INTERNAL, el, name, '', ns, ns !== null ? prefix : null, ns !== null && i > 0 ? name.slice(i + 1) : name);
      m.set(name, a);
    }
    return a;
  }
  function detachAttr(el, name, value) {
    const m = attrNodeCache.get(el);
    const a = m !== undefined ? m.get(name) : undefined;
    if (a !== undefined) {
      m.delete(name);
      L.attrSetOwner(a, null);
      L.attrSetStoredValue(a, value);
      return a;
    }
    return new Attr(INTERNAL, null, name, value);
  }

  const NNM = new WeakMap();
  class NamedNodeMap {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get length() { return N.attrNames(idOf(nnmEl(this))).length; }
    item(i) {
      const el = nnmEl(this);
      const n = N.attrNames(idOf(el))[Number(i) >>> 0];
      return n === undefined ? null : attrNode(el, n);
    }
    getNamedItem(name) {
      const el = nnmEl(this);
      const n = htmlAttrName(el, `${name}`);
      return N.hasAttr(idOf(el), n) ? attrNode(el, n) : null;
    }
    getNamedItemNS(ns, local) {
      const el = nnmEl(this);
      const n = nsAttrName(el, ns, `${local}`);
      return n !== null ? attrNode(el, n) : null;
    }
    setNamedItem(attr) { return nnmEl(this).setAttributeNode(attr); }
    setNamedItemNS(attr) { return nnmEl(this).setAttributeNode(attr); }
    removeNamedItem(name) {
      const el = nnmEl(this);
      const n = htmlAttrName(el, `${name}`);
      const v = N.getAttr(idOf(el), n);
      if (v === null) throw notFound(`Failed to execute 'removeNamedItem' on 'NamedNodeMap': No item with name '${name}' was found.`);
      removeAttrCore(el, idOf(el), n);
      return detachAttr(el, n, v);
    }
    removeNamedItemNS(ns, local) {
      const el = nnmEl(this);
      const n = nsAttrName(el, ns, `${local}`);
      if (n === null) throw notFound(`Failed to execute 'removeNamedItemNS' on 'NamedNodeMap': No item with name '${local}' was found.`);
      const v = N.getAttr(idOf(el), n);
      removeAttrCore(el, idOf(el), n);
      return detachAttr(el, n, v);
    }
    *[Symbol.iterator]() {
      const el = nnmEl(this);
      for (const n of N.attrNames(idOf(el))) yield attrNode(el, n);
    }
  }
  function nnmEl(o) {
    const el = NNM.get(o);
    if (el === undefined) throw new TypeError('Illegal invocation');
    return el;
  }
  const nnmHandler = {
    get(t, p, r) {
      if (typeof p === 'string' && !(p in t)) {
        const el = NNM.get(t);
        const id = idOf(el);
        if (/^(0|[1-9][0-9]*)$/.test(p)) {
          const n = N.attrNames(id)[+p];
          return n === undefined ? undefined : attrNode(el, n);
        }
        if (N.hasAttr(id, p)) return attrNode(el, p);
      }
      return Reflect.get(t, p, r);
    },
    has(t, p) {
      if (typeof p === 'string') {
        const id = idOf(NNM.get(t));
        if (/^(0|[1-9][0-9]*)$/.test(p)) return +p < N.attrNames(id).length;
        if (N.hasAttr(id, p)) return true;
      }
      return Reflect.has(t, p);
    },
    ownKeys(t) {
      const n = N.attrNames(idOf(NNM.get(t))).length;
      const keys = [];
      for (let i = 0; i < n; i++) keys.push(String(i));
      return keys.concat(Reflect.ownKeys(t));
    },
    getOwnPropertyDescriptor(t, p) {
      if (typeof p === 'string' && /^(0|[1-9][0-9]*)$/.test(p)) {
        const el = NNM.get(t);
        const n = N.attrNames(idOf(el))[+p];
        if (n !== undefined) return { value: attrNode(el, n), writable: false, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(t, p);
    },
  };
  const nnmCache = new WeakMap();
  function namedNodeMap(el) {
    let m = nnmCache.get(el);
    if (m === undefined) {
      const t = new NamedNodeMap(INTERNAL);
      NNM.set(t, el);
      m = new Proxy(t, nnmHandler);
      NNM.set(m, el);
      nnmCache.set(el, m);
    }
    return m;
  }

  // Attribute names
  const ATTR_NAME_RE = /^[^\t\n\f\r \0/>=]+$/;
  function validateAttrName(name, method) {
    if (!ATTR_NAME_RE.test(name)) throw invalidChar(`Failed to execute '${method}' on 'Element': '${name}' is not a valid attribute name.`);
  }
  function htmlAttrName(el, name) {
    return nsOf(el) === HTML && docIsHTML(el) ? L.asciiLower(name) : name;
  }
  function docIsHTML() { return true; }
  const NS_PREFIX = new Map([[L.NS.XLINK, 'xlink'], [L.NS.XML, 'xml'], [L.NS.XMLNS, 'xmlns']]);
  // Map (namespace, localName) to the stored attribute name, or null if absent.
  function nsAttrName(el, ns, local) {
    const id = idOf(el);
    const nsv = ns === null || ns === undefined || ns === '' ? null : `${ns}`;
    if (nsv === null) return N.hasAttr(id, local) ? local : null;
    if (nsv === L.NS.XMLNS && local === 'xmlns') return N.hasAttr(id, 'xmlns') ? 'xmlns' : null;
    const known = NS_PREFIX.get(nsv);
    if (known !== undefined && N.hasAttr(id, known + ':' + local)) return known + ':' + local;
    for (const n of N.attrNames(id)) {
      const i = n.indexOf(':');
      if (i > 0 && n.slice(i + 1) === local) {
        const pfx = n.slice(0, i);
        if (lookupNsForPrefix(el, pfx) === nsv) return n;
      }
    }
    return null;
  }
  function lookupNsForPrefix(el, pfx) {
    if (pfx === 'xlink') return L.NS.XLINK;
    if (pfx === 'xml') return L.NS.XML;
    if (pfx === 'xmlns') return L.NS.XMLNS;
    for (let id = idOf(el); id !== 0; id = N.parent(id)) {
      if (N.nodeType(id) !== 1) continue;
      const v = N.getAttr(id, 'xmlns:' + pfx);
      if (v !== null) return v;
    }
    return null;
  }
  // DOM "validate and extract" (https://dom.spec.whatwg.org/#validate-and-extract): the
  // part before the first ':' must be a valid namespace prefix, the rest a valid element
  // local name (the XML Name production is no longer required).
  function validNamespacePrefix(s) { return s.length !== 0 && !/[\t\n\f\r \0/>]/.test(s); }
  function validLocalName(s) {
    if (s.length === 0) return false;
    const c = s.codePointAt(0);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return !/[\t\n\f\r \0/>]/.test(s);
    if (c !== 0x3a && c !== 0x5f && c < 0x80) return false;
    return /^.[-.0-9_:A-Za-z\u{80}-\u{10FFFF}]*$/su.test(s);
  }
  function validateQName(qn, method) {
    const i = qn.indexOf(':');
    const prefix = i === -1 ? null : qn.slice(0, i);
    const local = i === -1 ? qn : qn.slice(i + 1);
    if ((prefix !== null && !validNamespacePrefix(prefix)) || !validLocalName(local)) {
      throw invalidChar(`Failed to execute '${method}': '${qn}' is not a valid qualified name.`);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Element
  // ---------------------------------------------------------------------------------------
  function elementMatchesImpl(id, sel, method) {
    try { return N.matches(id, sel); } catch (e) {
      const c = L.fromNative(e);
      if (c instanceof DOMException) throw new DOMException(`Failed to execute '${method}' on 'Element': '${sel}' is not a valid selector.`, c.name);
      throw c;
    }
  }
  function qs(scopeId, sel, method, iface) {
    try { return N.querySelector(scopeId, sel); } catch (e) {
      const c = L.fromNative(e);
      if (c instanceof DOMException) throw new DOMException(`Failed to execute '${method}' on '${iface}': '${sel}' is not a valid selector.`, c.name);
      throw c;
    }
  }
  function qsa(scopeId, sel, method, iface) {
    try { return N.querySelectorAll(scopeId, sel); } catch (e) {
      const c = L.fromNative(e);
      if (c instanceof DOMException) throw new DOMException(`Failed to execute '${method}' on '${iface}': '${sel}' is not a valid selector.`, c.name);
      throw c;
    }
  }
  L.qsa = qsa;

  function innerHTMLGet(w) {
    if (lnOf(w) === 'template' && nsOf(w) === HTML && L.templateInfo !== null) return N.innerHTML(L.templateInfo(w));
    return N.innerHTML(idOf(w));
  }
  function innerHTMLSet(w, v) {
    const html = v === null || v === undefined ? '' : `${v}`;
    if (typeOf(w) === 1 && lnOf(w) === 'template' && nsOf(w) === HTML && L.templateInfo !== null) {
      const tc = L.templateInfo(w);
      const frag = parseFragment(w, html);
      replaceAllCore(tc, wrap(tc), () => { N.setTextContent(tc, ''); N.appendChild(tc, frag); });
      return;
    }
    const id = idOf(w);
    replaceAllCore(id, w, () => { N.setInnerHTML(id, html); extractTemplates(id, html); });
  }
  L.innerHTMLSet = innerHTMLSet;

  function insertAdjacent(el, where, nodeW, method) {
    const w = L.asciiLower(`${where}`);
    const id = idOf(el);
    switch (w) {
      case 'beforebegin': {
        const p = N.parent(id);
        if (p === 0) return null;
        return preInsert(wrap(p), nodeW, el, method);
      }
      case 'afterbegin': return preInsert(el, nodeW, wrap(N.firstChild(id)), method);
      case 'beforeend': return preInsert(el, nodeW, null, method);
      case 'afterend': {
        const p = N.parent(id);
        if (p === 0) return null;
        return preInsert(wrap(p), nodeW, wrap(N.nextSibling(id)), method);
      }
      default:
        throw new DOMException(`Failed to execute '${method}' on 'Element': The value provided ('${where}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`, 'SyntaxError');
    }
  }

  const ARIA = ['role', 'ariaActiveDescendantElement', 'ariaAtomic', 'ariaAutoComplete', 'ariaBrailleLabel',
    'ariaBrailleRoleDescription', 'ariaBusy', 'ariaChecked', 'ariaColCount', 'ariaColIndex', 'ariaColIndexText',
    'ariaColSpan', 'ariaCurrent', 'ariaDescription', 'ariaDisabled', 'ariaExpanded', 'ariaHasPopup', 'ariaHidden',
    'ariaInvalid', 'ariaKeyShortcuts', 'ariaLabel', 'ariaLevel', 'ariaLive', 'ariaModal', 'ariaMultiLine',
    'ariaMultiSelectable', 'ariaOrientation', 'ariaPlaceholder', 'ariaPosInSet', 'ariaPressed', 'ariaReadOnly',
    'ariaRelevant', 'ariaRequired', 'ariaRoleDescription', 'ariaRowCount', 'ariaRowIndex', 'ariaRowIndexText',
    'ariaRowSpan', 'ariaSelected', 'ariaSetSize', 'ariaSort', 'ariaValueMax', 'ariaValueMin', 'ariaValueNow',
    'ariaValueText'];
  for (const p of ARIA) {
    if (p.endsWith('Element')) continue;
    const attr = p === 'role' ? 'role' : 'aria-' + p.slice(4).toLowerCase();
    Object.defineProperty(Element.prototype, p, {
      get() { return N.getAttr(idOf(this), attr); },
      set(v) { L.setAttrOrRemove(this, attr, v === null || v === undefined ? null : `${v}`); },
      enumerable: true, configurable: true,
    });
  }

  function rectOf(id) { L.flushSheets(); return nativeCall(() => N.getBoundingClientRect(id)); }
  function metrics(fn, id) { L.flushSheets(); return fn(id); }
  L.targetRect = function (t) {
    if (!isNode(t) || typeOf(t) !== 1) return null;
    return N.getBoundingClientRect(idOf(t));
  };
  const pointerCaptures = new WeakMap();

  function scrollArgs(a, b) {
    // returns [left|null, top|null]
    if (a !== null && typeof a === 'object') {
      return [a.left === undefined ? null : Number(a.left) || 0, a.top === undefined ? null : Number(a.top) || 0];
    }
    if (a === undefined) return [null, null];
    return [Number(a) || 0, Number(b) || 0];
  }

  L.mixin(Element.prototype, {
    get namespaceURI() {
      const c = nsOf(this);
      if (c === OTHER) return elementNsOther.get(this) || null;
      return L.nsURIOfCode[c];
    },
    get prefix() { return elementPrefix.get(this) || null; },
    get localName() { return lnOf(this); },
    get tagName() { return tagNameOf(this); },
    get id() { const v = N.getAttr(idOf(this), 'id'); return v === null ? '' : v; },
    set id(v) { setAttrCore(this, idOf(this), 'id', `${v}`); },
    get className() { const v = N.getAttr(idOf(this), 'class'); return v === null ? '' : v; },
    set className(v) { setAttrCore(this, idOf(this), 'class', `${v}`); },
    get classList() { return L.tokenList(this, 'class'); },
    set classList(v) { this.classList.value = v; },
    get slot() { const v = N.getAttr(idOf(this), 'slot'); return v === null ? '' : v; },
    set slot(v) { setAttrCore(this, idOf(this), 'slot', `${v}`); },
    get part() { return L.tokenList(this, 'part'); },
    set part(v) { this.part.value = v; },
    hasAttributes() { return N.attrNames(idOf(this)).length !== 0; },
    get attributes() { return namedNodeMap(this); },
    getAttributeNames() { return N.attrNames(idOf(this)); },
    getAttribute(name) {
      return N.getAttr(idOf(this), htmlAttrName(this, `${name}`));
    },
    getAttributeNS(ns, local) {
      const n = nsAttrName(this, ns, `${local}`);
      return n === null ? null : N.getAttr(idOf(this), n);
    },
    setAttribute(name, value) {
      if (arguments.length < 2) throw new TypeError(`Failed to execute 'setAttribute' on 'Element': 2 arguments required, but only ${arguments.length} present.`);
      let n = `${name}`;
      validateAttrName(n, 'setAttribute');
      n = htmlAttrName(this, n);
      setAttrCore(this, idOf(this), n, `${value}`);
    },
    setAttributeNS(ns, qname, value) {
      const qn = `${qname}`;
      validateQName(qn, 'setAttributeNS');
      const nsv = ns === null || ns === undefined || ns === '' ? null : `${ns}`;
      const i = qn.indexOf(':');
      const prefix = i > 0 ? qn.slice(0, i) : null;
      if (prefix !== null && nsv === null) throw new DOMException("Failed to execute 'setAttributeNS' on 'Element': The namespace URI provided ('') is not valid.", 'NamespaceError');
      if (prefix === 'xml' && nsv !== L.NS.XML) throw new DOMException("Failed to execute 'setAttributeNS' on 'Element': The namespace URI is invalid for the 'xml' prefix.", 'NamespaceError');
      if ((qn === 'xmlns' || prefix === 'xmlns') !== (nsv === L.NS.XMLNS)) throw new DOMException("Failed to execute 'setAttributeNS' on 'Element': 'xmlns' namespace mismatch.", 'NamespaceError');
      let name = qn;
      if (nsv !== null) {
        const known = NS_PREFIX.get(nsv);
        const local = i > 0 ? qn.slice(i + 1) : qn;
        if (known !== undefined && !(nsv === L.NS.XMLNS && local === 'xmlns' && prefix === null)) name = known + ':' + local;
        else if (prefix === null && nsv !== L.NS.XMLNS) {
          // no prefix in a foreign namespace: keep an existing prefixed name if present
          const existing = nsAttrName(this, nsv, local);
          name = existing !== null ? existing : local;
        }
      }
      setAttrCore(this, idOf(this), name, `${value}`);
    },
    removeAttribute(name) {
      removeAttrCore(this, idOf(this), htmlAttrName(this, `${name}`));
    },
    removeAttributeNS(ns, local) {
      const n = nsAttrName(this, ns, `${local}`);
      if (n !== null) removeAttrCore(this, idOf(this), n);
    },
    toggleAttribute(name, force) {
      let n = `${name}`;
      validateAttrName(n, 'toggleAttribute');
      n = htmlAttrName(this, n);
      const id = idOf(this);
      if (N.hasAttr(id, n)) {
        if (force === undefined || !force) { removeAttrCore(this, id, n); return false; }
        return true;
      }
      if (force === undefined || force) { setAttrCore(this, id, n, ''); return true; }
      return false;
    },
    hasAttribute(name) { return N.hasAttr(idOf(this), htmlAttrName(this, `${name}`)); },
    hasAttributeNS(ns, local) { return nsAttrName(this, ns, `${local}`) !== null; },
    getAttributeNode(name) {
      const n = htmlAttrName(this, `${name}`);
      return N.hasAttr(idOf(this), n) ? attrNode(this, n) : null;
    },
    getAttributeNodeNS(ns, local) {
      const n = nsAttrName(this, ns, `${local}`);
      return n === null ? null : attrNode(this, n);
    },
    setAttributeNode(attr) {
      if (!L.isAttr(attr)) throw new TypeError("Failed to execute 'setAttributeNode' on 'Element': parameter 1 is not of type 'Attr'.");
      const owner = L.attrOwner(attr);
      if (owner !== null && owner !== this) throw new DOMException("Failed to execute 'setAttributeNode' on 'Element': The node provided is an attribute node that is already an attribute of another Element; attribute nodes must be explicitly cloned.", 'InUseAttributeError');
      const name = L.attrName(attr);
      const id = idOf(this);
      const oldV = N.getAttr(id, name);
      if (owner === this) return attr;
      const value = L.attrStoredValue(attr);
      let old = null;
      if (oldV !== null) old = detachAttr(this, name, oldV);
      setAttrCore(this, id, name, value);
      L.attrSetOwner(attr, this);
      let m = attrNodeCache.get(this);
      if (m === undefined) { m = new Map(); attrNodeCache.set(this, m); }
      m.set(name, attr);
      return old;
    },
    setAttributeNodeNS(attr) { return this.setAttributeNode(attr); },
    removeAttributeNode(attr) {
      if (!L.isAttr(attr) || L.attrOwner(attr) !== this) throw notFound("Failed to execute 'removeAttributeNode' on 'Element': The node provided is owned by another element.");
      const name = L.attrName(attr);
      const v = N.getAttr(idOf(this), name);
      removeAttrCore(this, idOf(this), name);
      return detachAttr(this, name, v === null ? '' : v);
    },
    attachShadow(init) {
      if (init === null || typeof init !== 'object') throw new TypeError("Failed to execute 'attachShadow' on 'Element': 1 argument required, but only 0 present.");
      const mode = `${init.mode}`;
      if (mode !== 'open' && mode !== 'closed') throw new TypeError(`Failed to execute 'attachShadow' on 'Element': Failed to read the 'mode' property from 'ShadowRootInit': The provided value '${mode}' is not a valid enum value of type ShadowRootMode.`);
      const ln = lnOf(this);
      if (nsOf(this) !== HTML || !(L.isValidCEName(ln) || SHADOW_HOSTS.has(ln))) {
        throw new DOMException(`Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow`, 'NotSupportedError');
      }
      const existing = shadowOfHost.get(this);
      if (existing !== undefined) {
        const info = shadowInfo.get(existing);
        // A declarative shadow root is emptied and reused by the first attachShadow().
        if (info.declarative && info.mode === mode) {
          info.declarative = false;
          clearShadowContent(existing);
          return existing;
        }
        throw new DOMException("Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.", 'NotSupportedError');
      }
      return attachShadowImpl(this, mode, init);
    },
    get shadowRoot() {
      const sr = shadowOfHost.get(this);
      if (sr === undefined) return null;
      return shadowInfo.get(sr).mode === 'open' ? sr : null;
    },
    get assignedSlot() { return null; },
    closest(selectors) {
      const sel = `${selectors}`;
      try { return wrap(N.closest(idOf(this), sel)); } catch (e) {
        const c = L.fromNative(e);
        if (c instanceof DOMException) throw new DOMException(`Failed to execute 'closest' on 'Element': '${sel}' is not a valid selector.`, c.name);
        throw c;
      }
    },
    matches(selectors) { return elementMatchesImpl(idOf(this), `${selectors}`, 'matches'); },
    webkitMatchesSelector(selectors) { return elementMatchesImpl(idOf(this), `${selectors}`, 'webkitMatchesSelector'); },
    getElementsByTagName(qn) { return getElementsByTagNameImpl(idOf(this), qn); },
    getElementsByTagNameNS(ns, local) { return getElementsByTagNameNSImpl(idOf(this), ns, local); },
    getElementsByClassName(names) { return getElementsByClassNameImpl(idOf(this), names); },
    insertAdjacentElement(where, element) {
      if (!isNode(element) || typeOf(element) !== 1) throw new TypeError("Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.");
      return insertAdjacent(this, where, element, 'insertAdjacentElement');
    },
    insertAdjacentText(where, data) {
      const t = makeWrapper(N.createText(`${data}`), 3, Text.prototype);
      insertAdjacent(this, where, t, 'insertAdjacentText');
    },
    insertAdjacentHTML(position, text) {
      const where = L.asciiLower(`${position}`);
      const id = idOf(this);
      let ctx = this;
      if (where === 'beforebegin' || where === 'afterend') {
        const p = N.parent(id);
        if (p === 0 || N.nodeType(p) === 9) throw new DOMException("Failed to execute 'insertAdjacentHTML' on 'Element': The element has no parent.", 'NoModificationAllowedError');
        ctx = wrap(p);
        if (typeOf(ctx) !== 1) ctx = null;
      } else if (where !== 'afterbegin' && where !== 'beforeend') {
        throw new DOMException(`Failed to execute 'insertAdjacentHTML' on 'Element': The value provided ('${position}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`, 'SyntaxError');
      }
      const frag = parseFragment(ctx, `${text}`);
      insertAdjacent(this, where, wrap(frag), 'insertAdjacentHTML');
    },
    get innerHTML() { return innerHTMLGet(this); },
    set innerHTML(v) { innerHTMLSet(this, v); },
    get outerHTML() { return N.outerHTML(idOf(this)); },
    set outerHTML(v) {
      const id = idOf(this);
      const p = N.parent(id);
      if (p === 0) return;
      if (N.nodeType(p) === 9) throw new DOMException("Failed to set the 'outerHTML' property on 'Element': This element's parent is of type '#document', which is not an element node.", 'NoModificationAllowedError');
      const pw = wrap(p);
      const frag = parseFragment(typeOf(pw) === 1 ? pw : null, v === null ? '' : `${v}`);
      replaceChildImpl(pw, wrap(frag), this);
    },
    getHTML() { return innerHTMLGet(this); },
    setHTMLUnsafe(html) { innerHTMLSet(this, html); },
    getBoundingClientRect() {
      const r = rectOf(idOf(this));
      return new DOMRect(r[0], r[1], r[2], r[3]);
    },
    getClientRects() {
      L.flushSheets();
      const a = nativeCall(() => N.getClientRects(idOf(this)));
      const rects = [];
      for (let i = 0; i + 3 < a.length; i += 4) rects.push(new DOMRect(a[i], a[i + 1], a[i + 2], a[i + 3]));
      return new DOMRectList(INTERNAL, rects);
    },
    get scrollTop() { return metrics(N.scrollMetrics, idOf(this))[1]; },
    set scrollTop(v) { const id = idOf(this); N.setScroll(id, metrics(N.scrollMetrics, id)[0], Number(v) || 0); },
    get scrollLeft() { return metrics(N.scrollMetrics, idOf(this))[0]; },
    set scrollLeft(v) { const id = idOf(this); N.setScroll(id, Number(v) || 0, metrics(N.scrollMetrics, id)[1]); },
    get scrollWidth() { return metrics(N.scrollMetrics, idOf(this))[2]; },
    get scrollHeight() { return metrics(N.scrollMetrics, idOf(this))[3]; },
    get clientLeft() { return metrics(N.clientMetrics, idOf(this))[0]; },
    get clientTop() { return metrics(N.clientMetrics, idOf(this))[1]; },
    get clientWidth() { return metrics(N.clientMetrics, idOf(this))[2]; },
    get clientHeight() { return metrics(N.clientMetrics, idOf(this))[3]; },
    get currentCSSZoom() { return 1; },
    scroll(a, b) { elementScroll(this, a, b, false); },
    scrollTo(a, b) { elementScroll(this, a, b, false); },
    scrollBy(a, b) { elementScroll(this, a, b, true); },
    scrollIntoView(arg) {
      let block = 'start', inline = 'nearest', behavior = 'auto';
      if (arg === false) block = 'end';
      else if (arg !== null && typeof arg === 'object') {
        if (arg.block !== undefined) block = String(arg.block);
        if (arg.inline !== undefined) inline = String(arg.inline);
        if (arg.behavior !== undefined) behavior = String(arg.behavior);
      }
      N.scrollIntoView(idOf(this), block, inline, behavior);
    },
    scrollIntoViewIfNeeded(center) { N.scrollIntoView(idOf(this), 'nearest', 'nearest', 'auto'); },
    checkVisibility(options) {
      const id = idOf(this);
      if (!N.isConnected(id)) return false;
      for (let x = id; x !== 0 && N.nodeType(x) === 1; x = N.parent(x)) {
        if (N.computedStyle(x, 'display', '') === 'none') return false;
      }
      if (options && (options.checkVisibilityCSS || options.visibilityProperty)) {
        if (N.computedStyle(id, 'visibility', '') !== 'visible') return false;
      }
      if (options && (options.checkOpacity || options.opacityProperty)) {
        if (N.computedStyle(id, 'opacity', '') === '0') return false;
      }
      return true;
    },
    requestFullscreen() { return L.rejectedPromise(new TypeError('Permissions check failed')); },
    requestPointerLock() { return L.rejectedPromise(new DOMException('Pointer lock not supported', 'NotSupportedError')); },
    setPointerCapture(pointerId) {
      let s = pointerCaptures.get(this);
      if (s === undefined) { s = new Set(); pointerCaptures.set(this, s); }
      s.add(Number(pointerId));
    },
    releasePointerCapture(pointerId) { const s = pointerCaptures.get(this); if (s) s.delete(Number(pointerId)); },
    hasPointerCapture(pointerId) { const s = pointerCaptures.get(this); return !!s && s.has(Number(pointerId)); },
    getAnimations(options) { return L.elementAnimations(this, options); },
    animate(keyframes, options) { return L.elementAnimate(this, keyframes, options); },
  });
  L.defineEventHandlers(Element.prototype, ['onfullscreenchange', 'onfullscreenerror', 'onbeforecopy', 'onbeforecut', 'onbeforepaste', 'onsearch']);
  const elementNsOther = new WeakMap();
  const elementPrefix = new WeakMap();
  let prefixedElements = 0; // how many elements were ever given a prefix (see getElementsByTagName)
  L.elementNsOther = elementNsOther;
  L.elementPrefix = elementPrefix;
  const SHADOW_HOSTS = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span']);

  function elementScroll(el, a, b, relative) {
    const id = idOf(el);
    const [l, t] = scrollArgs(a, b);
    const m = N.scrollMetrics(id);
    let left = l === null ? m[0] : l, top = t === null ? m[1] : t;
    if (relative) { left = m[0] + (l || 0); top = m[1] + (t || 0); }
    N.setScroll(id, left, top);
  }

  // ---------------------------------------------------------------------------------------
  // ParentNode / ChildNode / NonDocumentTypeChildNode mixins
  // ---------------------------------------------------------------------------------------
  function firstElementChildId(id) {
    for (let c = N.firstChild(id); c !== 0; c = N.nextSibling(c)) if (N.nodeType(c) === 1) return c;
    return 0;
  }
  function lastElementChildId(id) {
    for (let c = N.lastChild(id); c !== 0; c = N.prevSibling(c)) if (N.nodeType(c) === 1) return c;
    return 0;
  }
  const childrenCache = new WeakMap();
  const ParentNodeMixin = {
    get children() {
      let c = childrenCache.get(this);
      if (c === undefined) {
        c = L.makeHTMLCollection({ kind: 1, src: idOf(this) }, false);
        childrenCache.set(this, c);
      }
      return c;
    },
    get firstElementChild() { return wrap(firstElementChildId(idOf(this))); },
    get lastElementChild() { return wrap(lastElementChildId(idOf(this))); },
    get childElementCount() { return N.childElementIds(idOf(this)).length; },
    prepend(...nodes) {
      const node = convertNodes(nodes, 'prepend');
      preInsert(this, node, wrap(N.firstChild(idOf(this))), 'prepend');
    },
    append(...nodes) {
      const node = convertNodes(nodes, 'append');
      preInsert(this, node, null, 'append');
    },
    replaceChildren(...nodes) {
      const node = convertNodes(nodes, 'replaceChildren');
      const id = idOf(this);
      ensurePreInsert(this, id, node, idOf(node), 0, 'replaceChildren');
      const sr = isShadowRoot(this) ? this : null;
      if (sr !== null) shadowPrepare(sr);
      const nid = idOf(node);
      const isFrag = typeOf(node) === 11;
      replaceAllCore(id, sr !== null ? undefined : this, () => {
        N.setTextContent(id, '');
        if (!isFrag || N.firstChild(nid) !== 0) N.appendChild(id, nid);
      }, true);
      if (L.pendingScripts.size !== 0 && L.checkPendingScripts !== null) L.checkPendingScripts();
      if (sr !== null) shadowDistribute(sr);
    },
    querySelector(selectors) {
      return wrap(qs(idOf(this), `${selectors}`, 'querySelector', this instanceof Element ? 'Element' : typeOf(this) === 9 ? 'Document' : 'DocumentFragment'));
    },
    querySelectorAll(selectors) {
      return L.staticNodeList(qsa(idOf(this), `${selectors}`, 'querySelectorAll', this instanceof Element ? 'Element' : typeOf(this) === 9 ? 'Document' : 'DocumentFragment'));
    },
  };
  const ChildNodeMixin = {
    before(...nodes) {
      const id = idOf(this);
      const p = N.parent(id);
      if (p === 0) return;
      let viable = N.prevSibling(id);
      const set = new Set(nodes.filter(isNode).map(idOf));
      while (viable !== 0 && set.has(viable)) viable = N.prevSibling(viable);
      const node = convertNodes(nodes, 'before');
      const ref = viable === 0 ? N.firstChild(p) : N.nextSibling(viable);
      preInsert(wrap(p), node, wrap(ref), 'before');
    },
    after(...nodes) {
      const id = idOf(this);
      const p = N.parent(id);
      if (p === 0) return;
      let viable = N.nextSibling(id);
      const set = new Set(nodes.filter(isNode).map(idOf));
      while (viable !== 0 && set.has(viable)) viable = N.nextSibling(viable);
      const node = convertNodes(nodes, 'after');
      preInsert(wrap(p), node, wrap(viable), 'after');
    },
    replaceWith(...nodes) {
      const id = idOf(this);
      const p = N.parent(id);
      if (p === 0) return;
      let viable = N.nextSibling(id);
      const set = new Set(nodes.filter(isNode).map(idOf));
      while (viable !== 0 && set.has(viable)) viable = N.nextSibling(viable);
      const node = convertNodes(nodes, 'replaceWith');
      if (N.parent(id) === p) replaceChildImpl(wrap(p), node, this);
      else preInsert(wrap(p), node, wrap(viable), 'replaceWith');
    },
    remove() {
      const id = idOf(this);
      const p = N.parent(id);
      if (p === 0) return;
      removeCore(p, undefined, id);
    },
  };
  const NonDocTypeChildMixin = {
    get previousElementSibling() {
      for (let c = N.prevSibling(idOf(this)); c !== 0; c = N.prevSibling(c)) if (N.nodeType(c) === 1) return wrap(c);
      return null;
    },
    get nextElementSibling() {
      for (let c = N.nextSibling(idOf(this)); c !== 0; c = N.nextSibling(c)) if (N.nodeType(c) === 1) return wrap(c);
      return null;
    },
  };
  L.mixin([Element.prototype, Document.prototype, DocumentFragment.prototype], ParentNodeMixin);
  L.mixin([Element.prototype, CharacterData.prototype, DocumentType.prototype], ChildNodeMixin);
  L.mixin([Element.prototype, CharacterData.prototype], NonDocTypeChildMixin);
  const unscopables = { before: true, after: true, replaceWith: true, remove: true, prepend: true, append: true, replaceChildren: true, slot: true };
  Object.defineProperty(Element.prototype, Symbol.unscopables, { value: Object.assign(Object.create(null), unscopables), configurable: true });

  // ---------------------------------------------------------------------------------------
  // CharacterData / Text / Comment / ProcessingInstruction / DocumentType
  // ---------------------------------------------------------------------------------------
  function checkOffset(len, offset, method) {
    if (offset > len) throw new DOMException(`Failed to execute '${method}' on 'CharacterData': The offset ${offset} is greater than the node's length (${len}).`, 'IndexSizeError');
  }
  L.mixin(CharacterData.prototype, {
    get data() { return N.getText(idOf(this)); },
    set data(v) { setDataCore(this, idOf(this), v === null ? '' : `${v}`); },
    get length() { return N.getText(idOf(this)).length; },
    substringData(offset, count) {
      const d = N.getText(idOf(this));
      const o = offset >>> 0;
      checkOffset(d.length, o, 'substringData');
      return d.substr(o, count >>> 0);
    },
    appendData(data) { const id = idOf(this); const d = N.getText(id); const s = `${data}`; setDataCore(this, id, d + s, d.length, 0, s.length); },
    insertData(offset, data) {
      const id = idOf(this);
      const d = N.getText(id);
      const o = offset >>> 0;
      checkOffset(d.length, o, 'insertData');
      const s = `${data}`;
      setDataCore(this, id, d.slice(0, o) + s + d.slice(o), o, 0, s.length);
    },
    deleteData(offset, count) {
      const id = idOf(this);
      const d = N.getText(id);
      const o = offset >>> 0;
      checkOffset(d.length, o, 'deleteData');
      const n = Math.min(count >>> 0, d.length - o);
      setDataCore(this, id, d.slice(0, o) + d.slice(o + n), o, n, 0);
    },
    replaceData(offset, count, data) {
      const id = idOf(this);
      const d = N.getText(id);
      const o = offset >>> 0;
      checkOffset(d.length, o, 'replaceData');
      const n = Math.min(count >>> 0, d.length - o);
      const s = `${data}`;
      setDataCore(this, id, d.slice(0, o) + s + d.slice(o + n), o, n, s.length);
    },
  });
  L.mixin(Text.prototype, {
    splitText(offset) {
      const id = idOf(this);
      const d = N.getText(id);
      const o = offset >>> 0;
      if (o > d.length) throw new DOMException(`Failed to execute 'splitText' on 'Text': The offset ${o} is larger than the Text node's length.`, 'IndexSizeError');
      const newNode = makeWrapper(N.createText(d.slice(o)), 3, Text.prototype);
      const p = N.parent(id);
      if (p !== 0) {
        const index = indexOfNode(id);
        insertCore(p, undefined, newNode, idOf(newNode), N.nextSibling(id));
        if (liveRanges.size !== 0) rangesOnSplit(id, idOf(newNode), o, p, index);
      }
      setDataCore(this, id, d.slice(0, o), o, d.length - o, 0);
      return newNode;
    },
    get wholeText() {
      const id = idOf(this);
      let s = id;
      while (N.prevSibling(s) !== 0 && N.nodeType(N.prevSibling(s)) === 3) s = N.prevSibling(s);
      let out = '';
      for (let c = s; c !== 0 && N.nodeType(c) === 3; c = N.nextSibling(c)) out += N.getText(c);
      return out;
    },
    get assignedSlot() { return null; },
  });
  L.mixin(ProcessingInstruction.prototype, {
    get target() { return piTarget.get(this) || ''; },
    get sheet() { return null; },
  });
  L.mixin(DocumentType.prototype, {
    get name() { return 'html'; },
    get publicId() { return ''; },
    get systemId() { return ''; },
  });

  // ---------------------------------------------------------------------------------------
  // DocumentFragment / ShadowRoot
  // ---------------------------------------------------------------------------------------
  L.mixin(DocumentFragment.prototype, {
    getElementById(elementId) {
      const s = `${elementId}`;
      if (s === '') return null;
      return wrap(N.querySelector(idOf(this), '#' + L.cssEscape(s)));
    },
  });
  function srInfo(sr) {
    const i = shadowInfo.get(sr);
    if (i === undefined) throw new TypeError('Illegal invocation');
    return i;
  }
  L.mixin(ShadowRoot.prototype, {
    get mode() { return srInfo(this).mode; },
    get host() { return srInfo(this).host; },
    get delegatesFocus() { return srInfo(this).delegatesFocus; },
    get slotAssignment() { return srInfo(this).slotAssignment; },
    get clonable() { return srInfo(this).clonable; },
    get serializable() { return srInfo(this).serializable; },
    get innerHTML() { return N.innerHTML(idOf(this)); },
    set innerHTML(v) {
      const info = srInfo(this);
      shadowPrepare(this);
      const id = idOf(info.host);
      const html = v === null || v === undefined ? '' : `${v}`;
      replaceAllCore(id, undefined, () => { N.setInnerHTML(id, html); extractTemplates(id, html); });
      info.cleared.clear();
      shadowDistribute(this);
    },
    getHTML() { return N.innerHTML(idOf(this)); },
    setHTMLUnsafe(html) { this.innerHTML = html; },
    get activeElement() {
      const a = N.activeElement();
      if (a === 0) return null;
      return N.contains(idOf(this), a) && a !== idOf(this) ? wrap(a) : null;
    },
    get fullscreenElement() { return null; },
    get pointerLockElement() { return null; },
    get pictureInPictureElement() { return null; },
    get adoptedStyleSheets() { return L.adoptedStyleSheetsOf(this); },
    set adoptedStyleSheets(v) { L.setAdoptedStyleSheets(this, v); },
    get styleSheets() { return srInfo(this).sheets || (srInfo(this).sheets = new StyleSheetList(INTERNAL, this)); },
    getSelection() { return L.getSelection ? L.getSelection() : null; },
    elementFromPoint(x, y) { return document.elementFromPoint(x, y); },
    elementsFromPoint(x, y) { return document.elementsFromPoint(x, y); },
  });
  L.defineEventHandlers(ShadowRoot.prototype, ['onslotchange']);

  // ---------------------------------------------------------------------------------------
  // Event path parent resolution
  // ---------------------------------------------------------------------------------------
  L.eventParent = function (t, ev) {
    if (!isNode(t)) return null;
    if (t === document) return L.EV.type(ev) === 'load' ? null : L.window;
    const si = shadowInfo.get(t);
    if (si !== undefined) return si.host;
    const p = N.parent(idOf(t));
    if (p === 0) return null;
    return wrap(p);
  };
  L.bodyElement = function () {
    const html = docElementId(mainDocId);
    if (html === 0) return null;
    for (let c = N.firstChild(html); c !== 0; c = N.nextSibling(c)) {
      if (N.nodeType(c) === 1) {
        const ln = N.localName(c);
        if ((ln === 'body' || ln === 'frameset') && N.namespaceURI(c) === L.NS.HTML) return wrap(c);
      }
    }
    return null;
  };
  L.isBodyOfDocument = function (el) { return L.bodyElement() === el; };
  L.getSelection = null;

  Object.assign(L, {
    ensurePreInsert, preInsert, removeChildImpl, replaceChildImpl, convertNodes, textContentSet, textContentGet,
    shadowInfo, shadowOfHost, shadowPrepare, shadowDistribute, collectCE, ceConnected, ceDisconnected,
    nodeNameOf, tagNameOf, attrNode, namedNodeMap, htmlAttrName, validateAttrName, validateQName,
    docElementId, firstElementChildId, lastElementChildId, getElementsByTagNameImpl,
    getElementsByClassNameImpl, getElementsByTagNameNSImpl, elementScroll, qs, cloneNodeImpl, nodesEqual,
    childrenChanged, titleIds, rectOf, invalidChar, hier, notFound,
  });
  L.setCeSelector = function (s) { ceSelector = s; };
  L.setMoRegCount = function (d) { moRegCount += d; };
  L.MOInternals = function (m) { MO = m; };

  // =======================================================================================
  // Document
  // =======================================================================================
  function docInfo(d) {
    const i = docState.get(d);
    if (i === undefined) throw new TypeError('Illegal invocation');
    return i;
  }
  const EL_NAME_RE = /^[A-Za-z][^\t\n\f\r \0/>]*$/;
  const EL_NAME_RE2 = /^[:_\u0080-\uFFFF][A-Za-z0-9\-.:_\u00B7\u0080-\uFFFF]*$/;
  function validateElementName(n, method) {
    if (!EL_NAME_RE.test(n) && !EL_NAME_RE2.test(n)) {
      throw invalidChar(`Failed to execute '${method}' on 'Document': The tag name provided ('${n}') is not a valid name.`);
    }
  }
  L.validateElementName = validateElementName;
  function constructCE(def, name) {
    try {
      const r = Reflect.construct(def.ctor, []);
      if (!isNode(r) || typeOf(r) !== 1 || lnOf(r) !== name) throw new TypeError('The result must implement HTMLElement interface');
      return r;
    } catch (e) {
      L.report(e);
      const id = N.createElement(name, '');
      const w = L.wrapElementAs(id, L.elementProtoFor('\u0000unknown', HTML), name, HTML);
      ceState.set(w, FAILED);
      return w;
    }
  }
  // document.createElement(name, { is }): the element records its "is value" (as the `is`
  // attribute, so serialization, cloning and later upgrades see it) and, if a matching
  // customized built-in is defined, is upgraded synchronously.
  function createCustomizedBuiltin(w, id, name, is) {
    N.setAttr(id, 'is', is);
    const def = builtinDefs.get(is);
    if (def !== undefined && def.localName === name) upgradeElement(w, def);
  }
  function findTitleId(docId) {
    const t = N.querySelector(docId, 'title');
    if (t === 0) return 0;
    if (N.namespaceURI(t) === L.NS.HTML) return t;
    for (const id of N.querySelectorAll(docId, 'title')) if (N.namespaceURI(id) === L.NS.HTML) return id;
    return 0;
  }
  function headIdOf(docId) {
    const html = docElementId(docId);
    if (html === 0) return 0;
    for (let c = N.firstChild(html); c !== 0; c = N.nextSibling(c)) {
      if (N.nodeType(c) === 1 && N.localName(c) === 'head' && N.namespaceURI(c) === L.NS.HTML) return c;
    }
    return 0;
  }
  const bodyCache = { epoch: -1, id: 0, doc: 0 };
  function bodyIdOf(docId) {
    if (bodyCache.epoch === state.tree && bodyCache.doc === docId) return bodyCache.id;
    const html = docElementId(docId);
    let found = 0;
    if (html !== 0) {
      for (let c = N.firstChild(html); c !== 0; c = N.nextSibling(c)) {
        if (N.nodeType(c) === 1) {
          const ln = N.localName(c);
          if ((ln === 'body' || ln === 'frameset') && N.namespaceURI(c) === L.NS.HTML) { found = c; break; }
        }
      }
    }
    bodyCache.epoch = state.tree; bodyCache.doc = docId; bodyCache.id = found;
    return found;
  }
  const docElCache = { epoch: -1, id: 0, doc: 0 };
  function docElementCached(docId) {
    if (docElCache.epoch === state.tree && docElCache.doc === docId) return docElCache.id;
    const id = docElementId(docId);
    docElCache.epoch = state.tree; docElCache.doc = docId; docElCache.id = id;
    return id;
  }
  const docCollections = new WeakMap();
  function docCollection(d, key, make) {
    let m = docCollections.get(d);
    if (m === undefined) { m = new Map(); docCollections.set(d, m); }
    let c = m.get(key);
    if (c === undefined) { c = make(); m.set(key, c); }
    return c;
  }
  const CREATE_EVENT = {
    event: 'Event', events: 'Event', htmlevents: 'Event', svgevents: 'Event', customevent: 'CustomEvent',
    uievent: 'UIEvent', uievents: 'UIEvent', mouseevent: 'MouseEvent', mouseevents: 'MouseEvent',
    keyboardevent: 'KeyboardEvent', keyboardevents: 'KeyboardEvent', focusevent: 'FocusEvent',
    compositionevent: 'CompositionEvent', textevent: 'CompositionEvent', messageevent: 'MessageEvent',
    hashchangeevent: 'HashChangeEvent', storageevent: 'StorageEvent', beforeunloadevent: 'BeforeUnloadEvent',
    dragevent: 'DragEvent', errorevent: 'ErrorEvent', popstateevent: 'PopStateEvent', progressevent: 'ProgressEvent',
    pagetransitionevent: 'PageTransitionEvent', transitionevent: 'TransitionEvent', animationevent: 'AnimationEvent',
    wheelevent: 'WheelEvent', pointerevent: 'PointerEvent', inputevent: 'InputEvent', clipboardevent: 'ClipboardEvent',
    promiserejectionevent: 'PromiseRejectionEvent',
  };
  const EMPTY_TITLE_DOC = '';

  L.mixin(Document.prototype, {
    get timeline() { return L.documentTimeline; },
    getAnimations() { return L.documentAnimations(this); },
    get implementation() {
      let m = docCollections.get(this);
      return docCollection(this, 'impl', () => new DOMImplementation(INTERNAL, this));
    },
    get URL() { const i = docInfo(this); return i.main ? L.documentURL() : i.url || 'about:blank'; },
    get documentURI() { const i = docInfo(this); return i.main ? L.documentURL() : i.url || 'about:blank'; },
    get compatMode() {
      for (let c = N.firstChild(idOf(this)); c !== 0; c = N.nextSibling(c)) if (N.nodeType(c) === 10) return 'CSS1Compat';
      return docInfo(this).main && !L.quirksMode ? 'CSS1Compat' : 'BackCompat';
    },
    get characterSet() { return 'UTF-8'; },
    get charset() { return 'UTF-8'; },
    get inputEncoding() { return 'UTF-8'; },
    get contentType() { return docInfo(this).contentType; },
    get doctype() {
      for (let c = N.firstChild(idOf(this)); c !== 0; c = N.nextSibling(c)) {
        const w = wrap(c);
        if (typeOf(w) === 10) return w;
        if (typeOf(w) === 1) break;
      }
      return null;
    },
    get documentElement() { return wrap(docElementCached(idOf(this))); },
    getElementsByTagName(qn) { return getElementsByTagNameImpl(idOf(this), qn); },
    getElementsByTagNameNS(ns, local) { return getElementsByTagNameNSImpl(idOf(this), ns, local); },
    getElementsByClassName(names) { return getElementsByClassNameImpl(idOf(this), names); },
    createElement(localName, options) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'createElement' on 'Document': 1 argument required, but only 0 present.");
      let name = `${localName}`;
      validateElementName(name, 'createElement');
      const info = docInfo(this);
      const html = info.contentType === 'text/html';
      if (html) name = L.asciiLower(name);
      if (html || info.contentType === 'application/xhtml+xml') {
        const isOpt = options !== null && typeof options === 'object' && options.is !== undefined;
        const def = ceDefs.get(name);
        if (def !== undefined && !isOpt) return constructCE(def, name);
        const id = N.createElement(name, '');
        const w = wrap(id);
        if (name === 'script') { L.pendingScripts.add(id); L.forceAsync.add(id); }
        if (isOpt) createCustomizedBuiltin(w, id, name, `${options.is}`);
        return w;
      }
      const id = N.createElement(name, '');
      return L.wrapElementAs(id, Element.prototype, name, NONE);
    },
    createElementNS(namespace, qualifiedName, options) {
      const nsv = namespace === null || namespace === undefined || namespace === '' ? null : `${namespace}`;
      const qn = `${qualifiedName}`;
      validateQName(qn, 'createElementNS');
      const i = qn.indexOf(':');
      const prefix = i > 0 ? qn.slice(0, i) : null;
      const local = i > 0 ? qn.slice(i + 1) : qn;
      if (prefix !== null && nsv === null) throw new DOMException("Failed to execute 'createElementNS' on 'Document': The namespace URI provided ('') is not valid for the qualified name provided.", 'NamespaceError');
      if (prefix === 'xml' && nsv !== L.NS.XML) throw new DOMException("Failed to execute 'createElementNS' on 'Document': The namespace URI provided is not valid for the 'xml' prefix.", 'NamespaceError');
      const code = L.nsCode(nsv);
      let w;
      if (code === HTML) {
        const def = ceDefs.get(local);
        const isOpt = options !== null && typeof options === 'object' && options.is !== undefined;
        if (def !== undefined && !isOpt && prefix === null) return constructCE(def, local);
        const id = N.createElement(local, '');
        w = wrap(id);
        if (local === 'script') { L.pendingScripts.add(id); L.forceAsync.add(id); }
        if (isOpt && prefix === null) createCustomizedBuiltin(w, id, local, `${options.is}`);
      } else if (code === SVG || code === MATHML) {
        w = wrap(N.createElement(local, nsv));
      } else {
        const id = N.createElement(local, nsv === null ? '' : nsv);
        w = L.wrapElementAs(id, Element.prototype, local, code);
        if (code === OTHER) elementNsOther.set(w, nsv);
      }
      if (prefix !== null) { elementPrefix.set(w, prefix); prefixedElements++; }
      return w;
    },
    createDocumentFragment() { return makeWrapper(N.createFragment(), 11, DocumentFragment.prototype); },
    createTextNode(data) { return makeWrapper(N.createText(`${data}`), 3, Text.prototype); },
    createCDATASection(data) {
      if (docInfo(this).contentType === 'text/html') throw new DOMException("Failed to execute 'createCDATASection' on 'Document': This operation is not supported for HTML documents.", 'NotSupportedError');
      const s = `${data}`;
      if (s.includes(']]>')) throw invalidChar("Failed to execute 'createCDATASection' on 'Document': String cannot contain ']]>' since that is the end delimiter of a CData section.");
      return makeWrapper(N.createText(s), 4, CDATASection.prototype);
    },
    createComment(data) { return makeWrapper(N.createComment(`${data}`), 8, Comment.prototype); },
    createProcessingInstruction(target, data) {
      const t = `${target}`, d = `${data}`;
      validateElementName(t, 'createProcessingInstruction');
      if (d.includes('?>')) throw invalidChar("Failed to execute 'createProcessingInstruction' on 'Document': The data provided contains '?>'.");
      const w = makeWrapper(N.createComment(d), 7, ProcessingInstruction.prototype);
      piTarget.set(w, t);
      return w;
    },
    importNode(node, deep = false) {
      if (!isNode(node) && !L.isAttr(node)) throw new TypeError("Failed to execute 'importNode' on 'Document': parameter 1 is not of type 'Node'.");
      if (L.isAttr(node)) return node.cloneNode();
      if (typeOf(node) === 9 || isShadowRoot(node)) throw new DOMException("Failed to execute 'importNode' on 'Document': The node provided is a document, which may not be imported.", 'NotSupportedError');
      return cloneNodeImpl(node, typeof deep === 'object' && deep !== null ? !deep.selfOnly : !!deep);
    },
    adoptNode(node) {
      if (L.isAttr(node)) { if (L.attrOwner(node)) L.attrOwner(node).removeAttributeNode(node); return node; }
      const nid = L.nodeArg(node, 'adoptNode', 1);
      if (typeOf(node) === 9) throw new DOMException("Failed to execute 'adoptNode' on 'Document': The node provided is a document, which may not be adopted.", 'NotSupportedError');
      if (isShadowRoot(node)) throw hier("Failed to execute 'adoptNode' on 'Document': The node provided is a shadow root, which may not be adopted.");
      const p = N.parent(nid);
      if (p !== 0) removeCore(p, undefined, nid);
      return node;
    },
    createAttribute(localName) {
      let n = `${localName}`;
      validateAttrName(n, 'createAttribute');
      if (docInfo(this).contentType === 'text/html') n = L.asciiLower(n);
      return new Attr(INTERNAL, null, n, '');
    },
    createAttributeNS(ns, qn) {
      const q = `${qn}`;
      validateQName(q, 'createAttributeNS');
      const i = q.indexOf(':');
      return new Attr(INTERNAL, null, q, '', ns === '' || ns === undefined ? null : ns, i > 0 ? q.slice(0, i) : null, i > 0 ? q.slice(i + 1) : q);
    },
    createEvent(iface) {
      const key = L.asciiLower(`${iface}`);
      const name = CREATE_EVENT[key];
      if (name === undefined) throw new DOMException(`Failed to execute 'createEvent' on 'Document': The provided event type ('${iface}') is invalid.`, 'NotSupportedError');
      const ev = new L[name]('');
      L.EV.setUninitialized(ev);
      return ev;
    },
    createRange() {
      const r = new Range();
      if (this !== document) { r.setStart(this, 0); r.collapse(true); }
      return r;
    },
    createNodeIterator(root, whatToShow = 0xFFFFFFFF, filter = null) {
      L.nodeArg(root, 'createNodeIterator', 1);
      return new NodeIterator(INTERNAL, root, whatToShow >>> 0, filter === undefined ? null : filter);
    },
    createTreeWalker(root, whatToShow = 0xFFFFFFFF, filter = null) {
      L.nodeArg(root, 'createTreeWalker', 1);
      return new TreeWalker(INTERNAL, root, whatToShow >>> 0, filter === undefined ? null : filter);
    },
    getElementById(elementId) {
      const s = `${elementId}`;
      if (s === '') return null;
      if (this === document) return wrap(N.getElementById(s));
      return wrap(N.querySelector(idOf(this), '#' + L.cssEscape(s)));
    },
    getElementsByName(name) {
      return new NodeList(INTERNAL, 3, { scope: idOf(this), sel: '[name=' + L.cssString(`${name}`) + ']' });
    },
    get title() {
      const t = findTitleId(idOf(this));
      if (t === 0) return EMPTY_TITLE_DOC;
      return L.collapseWS(N.textContent(t));
    },
    set title(v) {
      const docId = idOf(this);
      let t = findTitleId(docId);
      if (t === 0) {
        const head = headIdOf(docId);
        if (head === 0) return;
        const tw = this.createElement('title');
        preInsert(wrap(head), tw, null, 'title');
        t = idOf(tw);
      }
      textContentSet(wrap(t), `${v}`);
      if (this === document) titleChanged();
    },
    get dir() {
      const de = docElementCached(idOf(this));
      if (de === 0) return '';
      const v = L.asciiLower(N.getAttr(de, 'dir') || '');
      return v === 'ltr' || v === 'rtl' || v === 'auto' ? v : '';
    },
    set dir(v) {
      const de = docElementCached(idOf(this));
      if (de !== 0) setAttrCore(wrap(de), de, 'dir', `${v}`);
    },
    get body() { return wrap(bodyIdOf(idOf(this))); },
    set body(v) {
      if (!isNode(v) || typeOf(v) !== 1 || !(lnOf(v) === 'body' || lnOf(v) === 'frameset') || nsOf(v) !== HTML) {
        throw hier("Failed to set the 'body' property on 'Document': The new body element is of type '" + (isNode(v) ? v.nodeName : v) + "'. It must be either a 'BODY' or 'FRAMESET' element.");
      }
      const docId = idOf(this);
      const cur = bodyIdOf(docId);
      if (cur === idOf(v)) return;
      const de = docElementCached(docId);
      if (cur !== 0) replaceChildImpl(wrap(de), v, wrap(cur));
      else if (de !== 0) preInsert(wrap(de), v, null, 'body');
      else throw hier("Failed to set the 'body' property on 'Document': No document element exists.");
    },
    get head() { return wrap(headIdOf(idOf(this))); },
    get images() { return docCollection(this, 'images', () => queryCollection(idOf(this), 'img', true)); },
    get embeds() { return docCollection(this, 'embeds', () => queryCollection(idOf(this), 'embed', true)); },
    get plugins() { return docCollection(this, 'embeds', () => queryCollection(idOf(this), 'embed', true)); },
    get links() { return docCollection(this, 'links', () => queryCollection(idOf(this), 'a[href],area[href]', true)); },
    get forms() { return docCollection(this, 'forms', () => queryCollection(idOf(this), 'form', true)); },
    get scripts() { return docCollection(this, 'scripts', () => queryCollection(idOf(this), 'script', true)); },
    get anchors() { return docCollection(this, 'anchors', () => queryCollection(idOf(this), 'a[name]', true)); },
    get applets() { return docCollection(this, 'applets', () => L.makeHTMLCollection({ kind: 0, ids: [] }, false)); },
    // document.all is an "undetectable" collection in browsers: falsy and == undefined, but
    // not === undefined (V8's MarkAsUndetectable isn't available here). null behaves the
    // same in these checks; YouTube's templates treat `undefined === document.all` as a
    // sign of a broken environment and hide their icons.
    get all() { return null; },
    get scrollingElement() {
      return this.compatMode === 'BackCompat' ? this.body : this.documentElement;
    },
    get activeElement() {
      if (this !== document) return null;
      const a = N.activeElement();
      if (a !== 0 && a !== mainDocId) return wrap(a);
      return this.body || this.documentElement;
    },
    hasFocus() { return this === document; },
    get defaultView() { return this === document ? L.window : null; },
    get domain() {
      if (this !== document) return '';
      const p = N.urlParse(L.documentURL(), null);
      return p ? p[5] : '';
    },
    set domain(v) { /* ignored (origin-keyed agent clusters) */ },
    get referrer() {
      if (this !== document) return '';
      if (L.referrer === undefined) {
        // read lazily: the layer must not call page-specific natives at load time (startup snapshot)
        let r = '';
        if (typeof N.referrer === 'function') { try { r = `${N.referrer()}`; } catch (_) { r = ''; } }
        L.referrer = r;
      }
      return L.referrer;
    },
    get cookie() {
      if (this !== document) return '';
      return N.getCookie();
    },
    set cookie(v) {
      if (this !== document) return;
      N.setCookie(`${v}`);
    },
    get lastModified() {
      if (this === document && L.lastModified === 0) L.lastModified = Math.floor(N.timeOrigin());
      const d = new Date(this === document ? L.lastModified : Date.now());
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    },
    get readyState() { return this === document ? L.readyState : 'complete'; },
    get currentScript() { return this === document ? L.currentScript : null; },
    get location() { return this === document ? L.location : null; },
    set location(v) { if (this === document) L.location.href = v; },
    get visibilityState() { return this === document ? (L.visibilityState || 'visible') : 'visible'; },
    get hidden() { return this === document ? L.visibilityState === 'hidden' : false; },
    get webkitVisibilityState() { return this.visibilityState; },
    get webkitHidden() { return this.hidden; },
    get fullscreenElement() { return null; },
    get fullscreenEnabled() { return false; },
    get fullscreen() { return false; },
    get webkitFullscreenElement() { return null; },
    get webkitFullscreenEnabled() { return false; },
    get webkitIsFullScreen() { return false; },
    get webkitCurrentFullScreenElement() { return null; },
    exitFullscreen() { return L.rejectedPromise(new TypeError('Document not active')); },
    webkitExitFullscreen() { },
    get pictureInPictureEnabled() { return false; },
    get pictureInPictureElement() { return null; },
    exitPictureInPicture() { return L.rejectedPromise(new DOMException('There is no Picture-in-Picture element in this document.', 'InvalidStateError')); },
    get pointerLockElement() { return null; },
    exitPointerLock() { },
    get designMode() { return docInfo(this).designMode || 'off'; },
    set designMode(v) { const s = L.asciiLower(`${v}`); if (s === 'on' || s === 'off') docInfo(this).designMode = s; },
    execCommand() { return false; },
    queryCommandEnabled() { return false; },
    queryCommandIndeterminate() { return false; },
    queryCommandState() { return false; },
    queryCommandSupported() { return false; },
    queryCommandValue() { return ''; },
    get styleSheets() { return docCollection(this, 'sheets', () => new StyleSheetList(INTERNAL, this)); },
    get adoptedStyleSheets() { return L.adoptedStyleSheetsOf(this); },
    set adoptedStyleSheets(v) { L.setAdoptedStyleSheets(this, v); },
    get fonts() { return this === document ? L.fonts : null; },
    getSelection() { return this === document && L.getSelection ? L.getSelection() : null; },
    elementFromPoint(x, y) {
      if (this !== document) return null;
      L.flushSheets();
      return wrap(N.elementFromPoint(Number(x) || 0, Number(y) || 0));
    },
    elementsFromPoint(x, y) {
      const out = [];
      if (this !== document) return out;
      L.flushSheets();
      for (let id = N.elementFromPoint(Number(x) || 0, Number(y) || 0); id !== 0 && N.nodeType(id) === 1; id = N.parent(id)) out.push(wrap(id));
      return out;
    },
    caretRangeFromPoint() { return null; },
    caretPositionFromPoint() { return null; },
    get prerendering() { return false; },
    get wasDiscarded() { return false; },
    get xmlEncoding() { return null; },
    get xmlStandalone() { return false; },
    set xmlStandalone(v) { },
    get xmlVersion() { return docInfo(this).contentType === 'text/html' ? null : '1.0'; },
    set xmlVersion(v) { },
    get alinkColor() { return ''; }, set alinkColor(v) { },
    get bgColor() { return ''; }, set bgColor(v) { },
    get fgColor() { return ''; }, set fgColor(v) { },
    get linkColor() { return ''; }, set linkColor(v) { },
    get vlinkColor() { return ''; }, set vlinkColor(v) { },
    clear() { },
    captureEvents() { },
    releaseEvents() { },
    get rootElement() { return null; },
    get timeline() { return L.documentTimeline || undefined; },
    hasStorageAccess() { return L.resolvedPromise(true); },
    requestStorageAccess() { return L.resolvedPromise(undefined); },
    get featurePolicy() { return undefined; },
  });
  L.defineEventHandlers(Document.prototype, L.GLOBAL_HANDLERS.concat(L.DOCUMENT_HANDLERS));
  L.headId = function () { return headIdOf(mainDocId); };
  L.bodyId = function () { return bodyIdOf(mainDocId); };
  L.findTitleId = findTitleId;

  // =======================================================================================
  // CSSOM: CSSStyleDeclaration, getComputedStyle, style sheets and rules
  // =======================================================================================
  // Pending stylesheet text appends (CSSStyleSheet.insertRule), flushed before layout reads.
  const dirtySheets = new Set();
  let sheetFlushQueued = false;
  L.flushSheets = function () {
    if (dirtySheets.size !== 0) {
      const list = Array.from(dirtySheets);
      dirtySheets.clear();
      for (const s of list) flushSheet(s);
    }
    if (adoptedDirty.size !== 0) {
      const roots = Array.from(adoptedDirty);
      adoptedDirty.clear();
      for (const root of roots) flushAdopted(root);
    }
  };
  function markSheetDirty(sheet) {
    dirtySheets.add(sheet);
    if (!sheetFlushQueued) {
      sheetFlushQueued = true;
      L.microtask(() => { sheetFlushQueued = false; L.flushSheets(); });
    }
  }

  const CSS_PROPS = ('accent-color align-content align-items align-self alignment-baseline all anchor-name anchor-scope animation ' +
    'animation-composition animation-delay animation-direction animation-duration animation-fill-mode ' +
    'animation-iteration-count animation-name animation-play-state animation-range animation-range-end ' +
    'animation-range-start animation-timeline animation-timing-function app-region appearance aspect-ratio ' +
    'backdrop-filter backface-visibility background background-attachment background-blend-mode background-clip ' +
    'background-color background-image background-origin background-position background-position-x ' +
    'background-position-y background-repeat background-size baseline-shift baseline-source block-size border ' +
    'border-block border-block-color border-block-end border-block-end-color border-block-end-style ' +
    'border-block-end-width border-block-start border-block-start-color border-block-start-style ' +
    'border-block-start-width border-block-style border-block-width border-bottom border-bottom-color ' +
    'border-bottom-left-radius border-bottom-right-radius border-bottom-style border-bottom-width border-collapse ' +
    'border-color border-end-end-radius border-end-start-radius border-image border-image-outset border-image-repeat ' +
    'border-image-slice border-image-source border-image-width border-inline border-inline-color border-inline-end ' +
    'border-inline-end-color border-inline-end-style border-inline-end-width border-inline-start ' +
    'border-inline-start-color border-inline-start-style border-inline-start-width border-inline-style ' +
    'border-inline-width border-left border-left-color border-left-style border-left-width border-radius ' +
    'border-right border-right-color border-right-style border-right-width border-spacing border-start-end-radius ' +
    'border-start-start-radius border-style border-top border-top-color border-top-left-radius ' +
    'border-top-right-radius border-top-style border-top-width border-width bottom box-decoration-break box-shadow ' +
    'box-sizing break-after break-before break-inside buffered-rendering caption-side caret-color clear clip ' +
    'clip-path clip-rule color color-interpolation color-interpolation-filters color-rendering color-scheme ' +
    'column-count column-fill column-gap column-rule column-rule-color column-rule-style column-rule-width ' +
    'column-span column-width columns contain contain-intrinsic-block-size contain-intrinsic-height ' +
    'contain-intrinsic-inline-size contain-intrinsic-size contain-intrinsic-width container container-name ' +
    'container-type content content-visibility counter-increment counter-reset counter-set cursor cx cy d ' +
    'direction display dominant-baseline empty-cells field-sizing fill fill-opacity fill-rule filter flex ' +
    'flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap float flood-color flood-opacity font ' +
    'font-display font-family font-feature-settings font-kerning font-optical-sizing font-palette font-size ' +
    'font-size-adjust font-stretch font-style font-synthesis font-synthesis-small-caps font-synthesis-style ' +
    'font-synthesis-weight font-variant font-variant-alternates font-variant-caps font-variant-east-asian ' +
    'font-variant-emoji font-variant-ligatures font-variant-numeric font-variant-position font-variation-settings ' +
    'font-weight forced-color-adjust gap grid grid-area grid-auto-columns grid-auto-flow grid-auto-rows grid-column ' +
    'grid-column-end grid-column-gap grid-column-start grid-gap grid-row grid-row-end grid-row-gap grid-row-start ' +
    'grid-template grid-template-areas grid-template-columns grid-template-rows height hyphenate-character ' +
    'hyphenate-limit-chars hyphens image-orientation image-rendering initial-letter inline-size inset inset-block ' +
    'inset-block-end inset-block-start inset-inline inset-inline-end inset-inline-start interpolate-size isolation ' +
    'justify-content justify-items justify-self left letter-spacing lighting-color line-break line-clamp ' +
    'line-height list-style list-style-image list-style-position list-style-type margin margin-block ' +
    'margin-block-end margin-block-start margin-bottom margin-inline margin-inline-end margin-inline-start ' +
    'margin-left margin-right margin-top marker marker-end marker-mid marker-start mask mask-clip mask-composite ' +
    'mask-image mask-mode mask-origin mask-position mask-repeat mask-size mask-type math-depth math-shift ' +
    'math-style max-block-size max-height max-inline-size max-width min-block-size min-height min-inline-size ' +
    'min-width mix-blend-mode object-fit object-position object-view-box offset offset-anchor offset-distance ' +
    'offset-path offset-position offset-rotate opacity order orphans outline outline-color outline-offset ' +
    'outline-style outline-width overflow overflow-anchor overflow-block overflow-clip-margin overflow-inline ' +
    'overflow-wrap overflow-x overflow-y overlay overscroll-behavior overscroll-behavior-block ' +
    'overscroll-behavior-inline overscroll-behavior-x overscroll-behavior-y padding padding-block padding-block-end ' +
    'padding-block-start padding-bottom padding-inline padding-inline-end padding-inline-start padding-left ' +
    'padding-right padding-top page page-break-after page-break-before page-break-inside paint-order perspective ' +
    'perspective-origin place-content place-items place-self pointer-events position position-anchor ' +
    'position-area position-try position-try-fallbacks position-try-order position-visibility print-color-adjust ' +
    'quotes r resize right rotate row-gap ruby-align ruby-position rx ry scale scroll-behavior scroll-margin ' +
    'scroll-margin-block scroll-margin-block-end scroll-margin-block-start scroll-margin-bottom ' +
    'scroll-margin-inline scroll-margin-inline-end scroll-margin-inline-start scroll-margin-left ' +
    'scroll-margin-right scroll-margin-top scroll-padding scroll-padding-block scroll-padding-block-end ' +
    'scroll-padding-block-start scroll-padding-bottom scroll-padding-inline scroll-padding-inline-end ' +
    'scroll-padding-inline-start scroll-padding-left scroll-padding-right scroll-padding-top scroll-snap-align ' +
    'scroll-snap-stop scroll-snap-type scroll-timeline scroll-timeline-axis scroll-timeline-name scrollbar-color ' +
    'scrollbar-gutter scrollbar-width shape-image-threshold shape-margin shape-outside shape-rendering speak ' +
    'stop-color stop-opacity stroke stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin ' +
    'stroke-miterlimit stroke-opacity stroke-width tab-size table-layout text-align text-align-last text-anchor ' +
    'text-box text-box-edge text-box-trim text-combine-upright text-decoration text-decoration-color ' +
    'text-decoration-line text-decoration-skip-ink text-decoration-style text-decoration-thickness text-emphasis ' +
    'text-emphasis-color text-emphasis-position text-emphasis-style text-indent text-orientation text-overflow ' +
    'text-rendering text-shadow text-size-adjust text-spacing-trim text-transform text-underline-offset ' +
    'text-underline-position text-wrap text-wrap-mode text-wrap-style timeline-scope top touch-action transform ' +
    'transform-box transform-origin transform-style transition transition-behavior transition-delay ' +
    'transition-duration transition-property transition-timing-function translate unicode-bidi user-select ' +
    'vector-effect vertical-align view-timeline view-timeline-axis view-timeline-inset view-timeline-name ' +
    'view-transition-class view-transition-name visibility white-space white-space-collapse widows width ' +
    'will-change word-break word-spacing word-wrap writing-mode x y z-index zoom').split(' ');
  // -webkit- aliases of standard properties
  const WEBKIT_ALIASES = ('align-content align-items align-self animation animation-delay animation-direction ' +
    'animation-duration animation-fill-mode animation-iteration-count animation-name animation-play-state ' +
    'animation-timing-function appearance backface-visibility background-clip background-origin background-size ' +
    'border-bottom-left-radius border-bottom-right-radius border-radius border-top-left-radius ' +
    'border-top-right-radius box-shadow box-sizing clip-path column-count column-gap column-rule column-rule-color ' +
    'column-rule-style column-rule-width column-span column-width columns filter flex flex-basis flex-direction ' +
    'flex-flow flex-grow flex-shrink flex-wrap font-feature-settings hyphens justify-content mask mask-clip ' +
    'mask-composite mask-image mask-origin mask-position mask-repeat mask-size opacity order perspective ' +
    'perspective-origin shape-outside text-size-adjust transform transform-origin transform-style transition ' +
    'transition-delay transition-duration transition-property transition-timing-function user-select ' +
    'writing-mode text-emphasis text-emphasis-color text-emphasis-position text-emphasis-style ' +
    'text-orientation print-color-adjust border-image').split(' ');
  const WEBKIT_ONLY = ('line-clamp box-orient box-align box-pack box-flex box-direction box-ordinal-group ' +
    'font-smoothing tap-highlight-color text-fill-color text-stroke text-stroke-color text-stroke-width ' +
    'user-drag highlight locale rtl-ordering text-security box-reflect mask-box-image border-horizontal-spacing ' +
    'border-vertical-spacing text-decorations-in-effect border-after border-before border-end border-start ' +
    'margin-after margin-before margin-end margin-start padding-after padding-before padding-end padding-start ' +
    'logical-width logical-height min-logical-width min-logical-height max-logical-width max-logical-height ' +
    'app-region text-combine ruby-position').split(' ');
  L.CSS_PROPS = CSS_PROPS;
  const KNOWN_CSS = new Set(CSS_PROPS);
  for (const p of WEBKIT_ALIASES) KNOWN_CSS.add('-webkit-' + p);
  for (const p of WEBKIT_ONLY) KNOWN_CSS.add('-webkit-' + p);
  L.KNOWN_CSS = KNOWN_CSS;
  // Resolve a property name (as given to getPropertyValue etc.) to the name used natively.
  const CSS_ALIAS = new Map();
  for (const p of WEBKIT_ALIASES) CSS_ALIAS.set('-webkit-' + p, p);
  function cssName(prop) {
    const p = `${prop}`;
    if (p.charCodeAt(0) === 45 && p.charCodeAt(1) === 45) return p;
    const l = L.asciiLower(p);
    const a = CSS_ALIAS.get(l);
    return a === undefined ? l : a;
  }
  L.cssName = cssName;

  // mode 0: inline style of an element, 1: computed style, 2: detached (CSS rule / constructed)
  class CSSStyleDeclaration {
    #el; #mode; #pseudo; #decls;
    constructor(token, el, mode, pseudo, decls) {
      if (token !== INTERNAL) throw L.illegal();
      this.#el = el; this.#mode = mode; this.#pseudo = pseudo || ''; this.#decls = decls || null;
    }
    *[Symbol.iterator]() { for (let i = 0, n = this.length; i < n; i++) yield this.item(i); }
    static {
      L.sdGet = (o, name) => {
        const m = o.#mode;
        if (m === 0) return N.styleGet(idOf(o.#el), name);
        if (m === 1) { L.flushSheets(); return N.computedStyle(idOf(o.#el), name, o.#pseudo); }
        const d = o.#decls.map.get(name);
        return d === undefined ? '' : d.value;
      };
      L.sdSet = (o, name, value, prio, jsName) => {
        const m = o.#mode;
        if (m === 1) throw new DOMException(`Failed to set the '${jsName || name}' property on 'CSSStyleDeclaration': These styles are computed, and therefore the '${jsName || name}' property is read-only.`, 'NoModificationAllowedError');
        if (m === 0) {
          const el = o.#el;
          styleMutate(el, () => N.styleSet(idOf(el), name, value, prio));
          return;
        }
        const d = o.#decls;
        if (value === '') d.map.delete(name); else d.map.set(name, { value, important: prio === 'important' });
        if (d.onchange) d.onchange();
      };
      L.sdMode = (o) => o.#mode;
      L.sdEl = (o) => o.#el;
      L.sdDecls = (o) => o.#decls;
    }
    get cssText() {
      const m = L.sdMode(this);
      if (m === 0) return N.styleCssText(idOf(L.sdEl(this)));
      if (m === 1) return '';
      return serializeDecls(L.sdDecls(this));
    }
    set cssText(v) {
      const m = L.sdMode(this);
      if (m === 1) throw new DOMException("Failed to set the 'cssText' property on 'CSSStyleDeclaration': These styles are computed, and therefore read-only.", 'NoModificationAllowedError');
      const s = v === null ? '' : `${v}`;
      if (m === 0) { const el = L.sdEl(this); styleMutate(el, () => N.styleSetCssText(idOf(el), s)); return; }
      const d = L.sdDecls(this);
      d.map = parseDecls(s);
      if (d.onchange) d.onchange();
    }
    get length() {
      const m = L.sdMode(this);
      let n;
      if (m === 0) n = N.styleLength(idOf(L.sdEl(this)));
      else if (m === 1) n = CSS_PROPS.length;
      else n = L.sdDecls(this).map.size;
      if (n > 64) L.ensureIndexed(CSSStyleDeclaration.prototype, n);
      return n;
    }
    item(i) {
      const v = styleItem(this, Number(i) >>> 0);
      return v === undefined ? '' : v;
    }
    getPropertyValue(prop) { return L.sdGet(this, cssName(prop)); }
    getPropertyPriority(prop) {
      const m = L.sdMode(this);
      const n = cssName(prop);
      if (m === 0) return N.styleGetPriority(idOf(L.sdEl(this)), n);
      if (m === 1) return '';
      const d = L.sdDecls(this).map.get(n);
      return d !== undefined && d.important ? 'important' : '';
    }
    setProperty(prop, value, priority = '') {
      const n = cssName(prop);
      const v = value === null || value === undefined ? '' : `${value}`;
      const p = L.asciiLower(`${priority}`);
      if (p !== '' && p !== 'important') return;
      if (n.charCodeAt(0) !== 45 && !KNOWN_CSS.has(n) && L.sdMode(this) !== 1) {
        if (!N.cssSupports(n, v === '' ? 'inherit' : v)) return;
      }
      L.sdSet(this, n, v, p, prop);
    }
    removeProperty(prop) {
      const n = cssName(prop);
      const m = L.sdMode(this);
      if (m === 1) throw new DOMException(`Failed to execute 'removeProperty' on 'CSSStyleDeclaration': These styles are computed, and therefore the '${prop}' property is read-only.`, 'NoModificationAllowedError');
      if (m === 0) {
        const el = L.sdEl(this);
        let old = '';
        styleMutate(el, () => { old = N.styleRemove(idOf(el), n); });
        return old === undefined || old === null ? '' : old;
      }
      const d = L.sdDecls(this);
      const cur = d.map.get(n);
      d.map.delete(n);
      if (d.onchange) d.onchange();
      return cur === undefined ? '' : cur.value;
    }
    get parentRule() { const d = L.sdDecls(this); return d !== null && d.rule ? d.rule : null; }
    get cssFloat() { return L.sdGet(this, 'float'); }
    set cssFloat(v) { L.sdSet(this, 'float', v === null ? '' : `${v}`, '', 'cssFloat'); }
  }
  function styleItem(o, i) {
    const m = L.sdMode(o);
    if (m === 0) {
      const id = idOf(L.sdEl(o));
      if (i >= N.styleLength(id)) return undefined;
      return N.styleItem(id, i);
    }
    if (m === 1) return CSS_PROPS[i];
    return Array.from(L.sdDecls(o).map.keys())[i];
  }
  L.makeIndexed(CSSStyleDeclaration.prototype, styleItem, 64);
  function styleMutate(el, fn) {
    const id = idOf(el);
    const mo = moRegCount !== 0;
    const def = ceDefs.size !== 0 ? ceState.get(el) : undefined;
    const observed = def !== undefined && def.observed.has('style');
    const old = mo || observed ? N.getAttr(id, 'style') : null;
    nativeCall(fn);
    state.attr++;
    if (mo) queueMutation('attributes', id, 'style', old, null, null, 0, 0);
    if (observed) ceCallback(el, def, 'attributeChangedCallback', ['style', old, N.getAttr(id, 'style'), null]);
    if (L.observersDirty !== null) L.observersDirty();
  }
  function camelOf(dashed) { return dashed.replace(/-([a-z])/g, (m, c) => c.toUpperCase()); }
  function defineStyleProp(jsName, nativeName) {
    if (Object.prototype.hasOwnProperty.call(CSSStyleDeclaration.prototype, jsName)) return;
    Object.defineProperty(CSSStyleDeclaration.prototype, jsName, {
      get() { return L.sdGet(this, nativeName); },
      set(v) { L.sdSet(this, nativeName, v === null ? '' : `${v}`, '', jsName); },
      enumerable: true, configurable: true,
    });
  }
  for (const p of CSS_PROPS) {
    if (p === 'float') continue;
    defineStyleProp(camelOf(p), p);
    if (p.includes('-')) defineStyleProp(p, p);
  }
  for (const p of WEBKIT_ALIASES) {
    const c = camelOf(p);
    defineStyleProp('webkit' + c[0].toUpperCase() + c.slice(1), p);
    defineStyleProp('Webkit' + c[0].toUpperCase() + c.slice(1), p);
    defineStyleProp('-webkit-' + p, p);
  }
  for (const p of WEBKIT_ONLY) {
    const c = camelOf(p);
    defineStyleProp('webkit' + c[0].toUpperCase() + c.slice(1), '-webkit-' + p);
    defineStyleProp('Webkit' + c[0].toUpperCase() + c.slice(1), '-webkit-' + p);
    defineStyleProp('-webkit-' + p, '-webkit-' + p);
  }
  Object.defineProperty(CSSStyleDeclaration.prototype, 'float', Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssFloat'));

  const inlineStyleCache = new WeakMap();
  L.inlineStyle = function (el) {
    let s = inlineStyleCache.get(el);
    if (s === undefined) {
      s = new CSSStyleDeclaration(INTERNAL, el, 0, '');
      inlineStyleCache.set(el, s);
    }
    return s;
  };
  L.computedStyle = function (el, pseudo) {
    let p = pseudo === undefined || pseudo === null ? '' : `${pseudo}`;
    if (p !== '' && p.charCodeAt(0) === 58 && p.charCodeAt(1) !== 58) p = ':' + p;
    return new CSSStyleDeclaration(INTERNAL, el, 1, p);
  };
  L.detachedStyle = function (decls) { return new CSSStyleDeclaration(INTERNAL, null, 2, '', decls); };

  // --- tiny CSS text tools -------------------------------------------------------------
  function skipComment(s, i) { const e = s.indexOf('*/', i + 2); return e < 0 ? s.length : e + 2; }
  function skipString(s, i) {
    const q = s[i];
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === q || s[j] === '\n') return j + 1;
    }
    return s.length;
  }
  // Split a style sheet into top-level rules: [{prelude, body|null, text}]
  function splitRules(s) {
    const out = [];
    let i = 0, start = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '*') { if (start === i) { i = skipComment(s, i); start = i; continue; } i = skipComment(s, i); continue; }
      if (c === '"' || c === "'") { i = skipString(s, i); continue; }
      if (c === ';' && s.slice(start, i).trim().startsWith('@')) {
        out.push({ prelude: s.slice(start, i).trim(), body: null, text: s.slice(start, i + 1).trim() });
        i++; start = i; continue;
      }
      if (c === '{') {
        let depth = 1, j = i + 1;
        while (j < n && depth > 0) {
          const d = s[j];
          if (d === '/' && s[j + 1] === '*') { j = skipComment(s, j); continue; }
          if (d === '"' || d === "'") { j = skipString(s, j); continue; }
          if (d === '{') depth++;
          else if (d === '}') depth--;
          j++;
        }
        const prelude = s.slice(start, i).trim();
        const body = s.slice(i + 1, depth === 0 ? j - 1 : j);
        out.push({ prelude, body, text: s.slice(start, j).trim() });
        i = j; start = j; continue;
      }
      if (c === '}' ) { i++; start = i; continue; }
      i++;
    }
    return out;
  }
  function parseDecls(text) {
    const map = new Map();
    let i = 0, start = 0;
    const s = text;
    const parts = [];
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '*') { i = skipComment(s, i); continue; }
      if (c === '"' || c === "'") { i = skipString(s, i); continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth <= 0) { parts.push(s.slice(start, i)); start = i + 1; }
      i++;
    }
    parts.push(s.slice(start));
    for (let p of parts) {
      p = p.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const k = p.indexOf(':');
      if (k <= 0) continue;
      const name = cssName(p.slice(0, k).trim());
      let value = p.slice(k + 1).trim();
      let important = false;
      const m = /!\s*important\s*$/i.exec(value);
      if (m) { important = true; value = value.slice(0, m.index).trim(); }
      map.set(name, { value, important });
    }
    return map;
  }
  L.parseDecls = parseDecls;
  function serializeDecls(d) {
    const out = [];
    for (const [k, v] of d.map) out.push(`${k}: ${v.value}${v.important ? ' !important' : ''};`);
    return out.join(' ');
  }

  // --- MediaList ---
  class MediaList {
    #get; #set;
    constructor(token, get, set) { if (token !== INTERNAL) throw L.illegal(); this.#get = get; this.#set = set; }
    static { L.mlParts = (o) => { const v = o.#get(); return v.trim() === '' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean); }; L.mlSet = (o, v) => o.#set(v); }
    get mediaText() { return L.mlParts(this).join(', '); }
    set mediaText(v) { L.mlSet(this, v === null ? '' : `${v}`); }
    get length() { return L.mlParts(this).length; }
    item(i) { const v = L.mlParts(this)[Number(i) >>> 0]; return v === undefined ? null : v; }
    appendMedium(m) { const p = L.mlParts(this); const s = `${m}`; if (!p.includes(s)) { p.push(s); L.mlSet(this, p.join(', ')); } }
    deleteMedium(m) { const s = `${m}`; const p = L.mlParts(this); const i = p.indexOf(s); if (i < 0) throw notFound("Failed to execute 'deleteMedium' on 'MediaList': Failed to delete '" + s + "'."); p.splice(i, 1); L.mlSet(this, p.join(', ')); }
    toString() { return this.mediaText; }
    *[Symbol.iterator]() { yield* L.mlParts(this); }
  }
  L.makeIndexed(MediaList.prototype, (o, i) => L.mlParts(o)[i], 8);

  // --- CSS rules ---
  const RULE_TYPES = { STYLE_RULE: 1, CHARSET_RULE: 2, IMPORT_RULE: 3, MEDIA_RULE: 4, FONT_FACE_RULE: 5, PAGE_RULE: 6,
    KEYFRAMES_RULE: 7, KEYFRAME_RULE: 8, MARGIN_RULE: 9, NAMESPACE_RULE: 10, COUNTER_STYLE_RULE: 11,
    SUPPORTS_RULE: 12, FONT_FEATURE_VALUES_RULE: 14 };
  const ruleData = new WeakMap(); // rule -> {text, prelude, body, sheet, parent, children, decls, type}
  function rd(o) { const d = ruleData.get(o); if (d === undefined) throw new TypeError('Illegal invocation'); return d; }
  class CSSRule {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get cssText() { return ruleText(this); }
    set cssText(v) { }
    get parentRule() { return rd(this).parent || null; }
    get parentStyleSheet() { return rd(this).sheet || null; }
    get type() { return rd(this).type; }
  }
  L.defineConstants([CSSRule, CSSRule.prototype], RULE_TYPES);
  class CSSStyleRule extends CSSRule {
    get selectorText() { return rd(this).prelude; }
    set selectorText(v) { const d = rd(this); d.prelude = `${v}`; d.text = null; ruleChanged(this); }
    get style() {
      const d = rd(this);
      if (!d.style) {
        d.decls = { map: parseDecls(d.body || ''), rule: this, onchange: () => { d.body = serializeDecls(d.decls); d.text = null; ruleChanged(this); } };
        d.style = L.detachedStyle(d.decls);
      }
      return d.style;
    }
    set style(v) { this.style.cssText = v; }
    get styleMap() { return undefined; }
    get cssRules() { return ruleList(this); }
  }
  class CSSGroupingRule extends CSSRule {
    get cssRules() { return ruleList(this); }
    insertRule(rule, index = 0) { return insertRuleInto(rd(this), this, `${rule}`, index >>> 0); }
    deleteRule(index) { deleteRuleFrom(rd(this), index >>> 0); ruleChanged(this); }
  }
  class CSSConditionRule extends CSSGroupingRule {
    get conditionText() { return rd(this).prelude.replace(/^@[\w-]+\s*/, ''); }
  }
  class CSSMediaRule extends CSSConditionRule {
    get media() { const d = rd(this); return new MediaList(INTERNAL, () => d.prelude.replace(/^@media\s*/i, ''), (v) => { d.prelude = '@media ' + v; d.text = null; ruleChanged(this); }); }
  }
  class CSSSupportsRule extends CSSConditionRule { }
  class CSSContainerRule extends CSSConditionRule {
    get containerName() { return ''; }
    get containerQuery() { return this.conditionText; }
  }
  class CSSLayerBlockRule extends CSSGroupingRule { get name() { return rd(this).prelude.replace(/^@layer\s*/i, ''); } }
  class CSSImportRule extends CSSRule {
    get href() { const m = /^@import\s+(?:url\()?\s*['"]?([^'")\s]+)/i.exec(rd(this).prelude); return m ? m[1] : ''; }
    get media() { return new MediaList(INTERNAL, () => '', () => { }); }
    get styleSheet() { return null; }
    get layerName() { return null; }
    get supportsText() { return null; }
  }
  class CSSFontFaceRule extends CSSRule { get style() { return CSSStyleRule.prototype.__lookupGetter__('style').call(this); } }
  class CSSKeyframeRule extends CSSRule {
    get keyText() { return rd(this).prelude; }
    set keyText(v) { const d = rd(this); d.prelude = `${v}`; d.text = null; ruleChanged(this); }
    get style() { return CSSStyleRule.prototype.__lookupGetter__('style').call(this); }
  }
  class CSSKeyframesRule extends CSSRule {
    get name() { return rd(this).prelude.replace(/^@(-webkit-)?keyframes\s*/i, ''); }
    set name(v) { const d = rd(this); d.prelude = '@keyframes ' + v; d.text = null; ruleChanged(this); }
    get cssRules() { return ruleList(this); }
    get length() { return rd(this).children.length; }
    *[Symbol.iterator]() { yield* this.cssRules; }
    appendRule(rule) { insertRuleInto(rd(this), this, `${rule}`, rd(this).children.length, true); }
    deleteRule(select) { const d = rd(this); const i = d.children.findIndex((c) => rd(c).prelude === `${select}`); if (i >= 0) { deleteRuleFrom(d, i); ruleChanged(this); } }
    findRule(select) { return rd(this).children.find((c) => rd(c).prelude === `${select}`) || null; }
  }
  class CSSNamespaceRule extends CSSRule {
    get namespaceURI() { const m = /url\(\s*['"]?([^'")]*)|['"]([^'"]*)['"]/.exec(rd(this).prelude); return m ? (m[1] || m[2] || '') : ''; }
    get prefix() { const m = /^@namespace\s+([\w-]+)\s/i.exec(rd(this).prelude); return m ? m[1] : ''; }
  }
  class CSSPageRule extends CSSGroupingRule {
    get selectorText() { return rd(this).prelude.replace(/^@page\s*/i, ''); }
    get style() { return CSSStyleRule.prototype.__lookupGetter__('style').call(this); }
  }
  class CSSCounterStyleRule extends CSSRule { get name() { return rd(this).prelude.replace(/^@counter-style\s*/i, ''); } }
  class CSSLayerStatementRule extends CSSRule { get nameList() { return Object.freeze(rd(this).prelude.replace(/^@layer\s*/i, '').split(',').map((s) => s.trim())); } }
  class CSSPropertyRule extends CSSRule { get name() { return rd(this).prelude.replace(/^@property\s*/i, ''); } }

  // At-rules browsers drop from the CSSOM: `@charset` and unknown ones.
  const KNOWN_AT_RULES = /^@(-webkit-|-moz-)?(media|supports|container|layer|import|font-face|keyframes|namespace|page|counter-style|property|scope|font-feature-values|font-palette-values|starting-style|view-transition|position-try|document)\b/;
  function keepsRule(item) {
    const p = item.prelude;
    if (p.charCodeAt(0) !== 64) return true;
    return KNOWN_AT_RULES.test(p.toLowerCase());
  }
  function makeRules(items, sheet, parent) {
    const out = [];
    for (const item of items) if (keepsRule(item)) out.push(makeRule(item, sheet, parent));
    return out;
  }
  function makeRule(item, sheet, parent) {
    const prelude = item.prelude;
    const lower = prelude.toLowerCase();
    let C = CSSStyleRule, type = 1, nested = false;
    if (parent && ruleData.get(parent) && ruleData.get(parent).type === 7) { C = CSSKeyframeRule; type = 8; }
    else if (lower.startsWith('@media')) { C = CSSMediaRule; type = 4; nested = true; }
    else if (lower.startsWith('@supports')) { C = CSSSupportsRule; type = 12; nested = true; }
    else if (lower.startsWith('@container')) { C = CSSContainerRule; type = 0; nested = true; }
    else if (lower.startsWith('@layer')) { if (item.body === null) { C = CSSLayerStatementRule; type = 0; } else { C = CSSLayerBlockRule; type = 0; nested = true; } }
    else if (lower.startsWith('@import')) { C = CSSImportRule; type = 3; }
    else if (lower.startsWith('@font-face')) { C = CSSFontFaceRule; type = 5; }
    else if (/^@(-webkit-)?keyframes/.test(lower)) { C = CSSKeyframesRule; type = 7; nested = true; }
    else if (lower.startsWith('@namespace')) { C = CSSNamespaceRule; type = 10; }
    else if (lower.startsWith('@charset')) { C = CSSRule; type = 2; }
    else if (lower.startsWith('@page')) { C = CSSPageRule; type = 6; }
    else if (lower.startsWith('@counter-style')) { C = CSSCounterStyleRule; type = 11; }
    else if (lower.startsWith('@property')) { C = CSSPropertyRule; type = 0; }
    else if (lower.startsWith('@')) { C = CSSRule; type = 0; }
    const r = new C(INTERNAL);
    const d = { prelude, body: item.body, text: item.text, sheet, parent: parent || null, type, children: [], style: null, decls: null };
    ruleData.set(r, d);
    if (nested && item.body !== null) {
      d.children = makeRules(splitRules(item.body), sheet, r);
    }
    return r;
  }
  function ruleText(r) {
    const d = rd(r);
    if (d.text !== null) return d.text;
    if (d.body === null) return d.prelude + ';';
    if (d.children.length || d.type === 4 || d.type === 12 || d.type === 7) {
      return d.prelude + ' {\n' + d.children.map((c) => '  ' + ruleText(c)).join('\n') + '\n}';
    }
    return d.prelude + ' { ' + (d.body || '').trim() + ' }';
  }
  function ruleChanged(r) {
    let d = rd(r);
    while (d.parent) { d.text = null; d = rd(d.parent); }
    d.text = null;
    if (d.sheet) { sheetDataOf(d.sheet).rewrite = true; markSheetDirty(d.sheet); }
  }
  function insertRuleInto(d, owner, text, index, append) {
    if (index > d.children.length) throw new DOMException(`Failed to execute 'insertRule': The index provided (${index}) is larger than the maximum index (${d.children.length}).`, 'IndexSizeError');
    const items = splitRules(text);
    if (items.length !== 1) throw new DOMException(`Failed to execute 'insertRule': Failed to parse the rule '${text}'.`, 'SyntaxError');
    const r = makeRule(items[0], d.sheet, owner);
    d.children.splice(index, 0, r);
    ruleChanged(owner);
    return index;
  }
  function deleteRuleFrom(d, index) {
    if (index >= d.children.length) throw new DOMException(`Failed to execute 'deleteRule': The index provided (${index}) is larger than the maximum index (${d.children.length - 1}).`, 'IndexSizeError');
    d.children.splice(index, 1);
  }
  class CSSRuleList {
    #get;
    constructor(token, get) { if (token !== INTERNAL) throw L.illegal(); this.#get = get; }
    static { L.crlItems = (o) => o.#get(); }
    get length() { const n = L.crlItems(this).length; if (n > 256) L.ensureIndexed(CSSRuleList.prototype, n); return n; }
    item(i) { const v = L.crlItems(this)[Number(i) >>> 0]; return v === undefined ? null : v; }
    *[Symbol.iterator]() { yield* L.crlItems(this); }
  }
  L.makeIndexed(CSSRuleList.prototype, (o, i) => L.crlItems(o)[i], 256);
  const ruleLists = new WeakMap();
  function ruleList(r) {
    let l = ruleLists.get(r);
    if (l === undefined) { l = new CSSRuleList(INTERNAL, () => rd(r).children); ruleLists.set(r, l); }
    return l;
  }

  // --- StyleSheet / CSSStyleSheet ---
  const sheetData = new WeakMap(); // sheet -> {owner, rules, text (last synced), pendingAppend, rewrite, disabled, href, constructed, media}
  function sheetDataOf(s) { const d = sheetData.get(s); if (d === undefined) throw new TypeError('Illegal invocation'); return d; }
  class StyleSheet {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get type() { return 'text/css'; }
    get href() { return sheetDataOf(this).href; }
    get ownerNode() { return sheetDataOf(this).owner; }
    get parentStyleSheet() { return null; }
    get title() { const o = sheetDataOf(this).owner; return o ? N.getAttr(idOf(o), 'title') : null; }
    get media() {
      const d = sheetDataOf(this);
      return new MediaList(INTERNAL, () => (d.owner ? N.getAttr(idOf(d.owner), 'media') || '' : d.media || ''),
        (v) => { if (d.owner) setAttrCore(d.owner, idOf(d.owner), 'media', v); else d.media = v; });
    }
    get disabled() { return sheetDataOf(this).disabled; }
    set disabled(v) {
      const d = sheetDataOf(this);
      const b = !!v;
      if (d.disabled === b) return;
      d.disabled = b;
      if (d.adopters) for (const root of d.adopters) adoptedChanged(root);
      if (d.owner && lnOf(d.owner) === 'style') {
        // approximate: disabling a <style> sheet empties its rendered text
        if (b) { d.savedText = N.textContent(idOf(d.owner)); N.setTextContent(idOf(d.owner), ''); d.text = ''; }
        else if (d.savedText !== undefined) { N.setTextContent(idOf(d.owner), d.savedText); d.text = d.savedText; d.savedText = undefined; }
        treeChanged();
      }
    }
  }
  class CSSStyleSheet extends StyleSheet {
    constructor(options) {
      super(INTERNAL);
      const o = options || {};
      let baseURL = null;
      if (o.baseURL !== undefined) {
        baseURL = L.resolveURL(`${o.baseURL}`);
        if (baseURL === null || baseURL === '') throw new DOMException("Failed to construct 'CSSStyleSheet': Invalid base URL.", 'NotAllowedError');
      }
      sheetData.set(this, { owner: null, rules: [], text: '', rewrite: false, pending: '', disabled: !!o.disabled, href: null, constructed: true, media: o.media ? `${o.media}` : '', adopters: new Set(), baseURL });
    }
    get ownerRule() { return null; }
    get cssRules() {
      checkSheetAccess(this, 'cssRules');
      syncSheet(this);
      let l = ruleLists.get(this);
      if (l === undefined) { l = new CSSRuleList(INTERNAL, () => { syncSheet(this); return sheetDataOf(this).rules; }); ruleLists.set(this, l); }
      return l;
    }
    get rules() { return this.cssRules; }
    insertRule(rule, index = 0) {
      checkSheetAccess(this, 'insertRule');
      syncSheet(this);
      const d = sheetDataOf(this);
      const idx = index >>> 0;
      if (idx > d.rules.length) throw new DOMException(`Failed to execute 'insertRule' on 'CSSStyleSheet': The index provided (${idx}) is larger than the maximum index (${d.rules.length}).`, 'IndexSizeError');
      const text = `${rule}`;
      const items = splitRules(text);
      if (items.length !== 1) throw new DOMException(`Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to parse the rule '${text}'.`, 'SyntaxError');
      if (d.constructed && /^@import\b/i.test(items[0].prelude)) throw new DOMException("Failed to execute 'insertRule' on 'CSSStyleSheet': Can't insert @import rules into a constructed stylesheet.", 'SyntaxError');
      const r = makeRule(items[0], this, null);
      d.rules.splice(idx, 0, r);
      if (idx === d.rules.length - 1 && !d.rewrite) d.pending += (d.pending ? '\n' : '') + ruleText(r);
      else d.rewrite = true;
      markSheetDirty(this);
      return idx;
    }
    deleteRule(index) {
      checkSheetAccess(this, 'deleteRule');
      syncSheet(this);
      const d = sheetDataOf(this);
      const idx = index >>> 0;
      if (idx >= d.rules.length) throw new DOMException(`Failed to execute 'deleteRule' on 'CSSStyleSheet': The index provided (${idx}) is larger than the maximum index (${d.rules.length - 1}).`, 'IndexSizeError');
      d.rules.splice(idx, 1);
      d.rewrite = true;
      markSheetDirty(this);
    }
    addRule(selector = 'undefined', style = 'undefined', index) {
      const d = sheetDataOf(this);
      this.insertRule(`${selector}{${style}}`, index === undefined ? d.rules.length : index);
      return -1;
    }
    removeRule(index = 0) { this.deleteRule(index); }
    replace(text) {
      try { this.replaceSync(text); return L.resolvedPromise(this); } catch (e) { return L.rejectedPromise(e); }
    }
    replaceSync(text) {
      const d = sheetDataOf(this);
      if (!d.constructed) throw new DOMException("Failed to execute 'replaceSync' on 'CSSStyleSheet': Can't call replaceSync on non-constructed CSSStyleSheets.", 'NotAllowedError');
      d.rules = makeRules(splitRules(`${text}`).filter((i) => !/^@import/i.test(i.prelude)), this, null);
      d.rewrite = true;
      markSheetDirty(this);
    }
  }
  // Bring the JS rule list in sync with the owner <style>'s text (if it changed externally),
  // or parse a <link>'s sheet once it has loaded.
  function syncSheet(s) {
    const d = sheetDataOf(s);
    if (d.owner === null) return;
    if (d.linked) {
      if (d.text !== null) return;
      const text = N.linkSheetText(idOf(d.owner));
      if (text === null) return;
      d.text = text;
      d.rules = makeRules(splitRules(text), s, null);
      return;
    }
    if (d.pending !== '' || d.rewrite) return; // our own changes not flushed yet: JS state is authoritative
    const text = N.textContent(idOf(d.owner));
    if (text === d.text) return;
    d.text = text;
    d.rules = makeRules(splitRules(text), s, null);
  }
  // A linked sheet from another origin hides its rules (as in browsers).
  function checkSheetAccess(s, what) {
    const d = sheetDataOf(s);
    if (!d.linked || d.href === null) return;
    const p = N.urlParse(d.href, null);
    const origin = p === null ? null : p[10];
    if (origin !== null && origin !== 'null' && origin === L.location.origin) return;
    throw new DOMException(`Failed to ${what === 'cssRules' ? "read the 'cssRules' property from" : `execute '${what}' on`} 'CSSStyleSheet': Cannot access rules`, 'SecurityError');
  }
  function flushSheet(s) {
    const d = sheetData.get(s);
    if (d === undefined || d.owner === null || d.linked) {
      if (d) {
        d.pending = ''; d.rewrite = false;
        // A constructed sheet applies through the roots that adopted it.
        if (d.adopters) for (const root of d.adopters) adoptedDirty.add(root);
      }
      return;
    }
    const id = idOf(d.owner);
    if (d.rewrite) {
      const text = d.rules.map(ruleText).join('\n');
      N.setTextContent(id, text);
      d.text = text;
    } else if (d.pending !== '') {
      const cur = N.textContent(id);
      N.appendChild(id, N.createText((cur === '' ? '' : '\n') + d.pending));
      d.text = cur + (cur === '' ? '' : '\n') + d.pending;
    }
    d.pending = '';
    d.rewrite = false;
    treeChanged();
  }
  const ownerSheets = new WeakMap();
  // Sheet object of a <style> or <link rel=stylesheet> element (created lazily).
  L.sheetFor = function (el, isLink) {
    let s = ownerSheets.get(el);
    if (s === undefined) {
      s = Object.create(CSSStyleSheet.prototype);
      sheetData.set(s, { owner: el, rules: [], text: null, rewrite: false, pending: '', disabled: false,
        href: isLink ? L.resolveURL(N.getAttr(idOf(el), 'href') || '') : null, constructed: false, linked: !!isLink });
      ownerSheets.set(el, s);
    }
    return s;
  };

  // --- adoptedStyleSheets: an ObservableArray<CSSStyleSheet> per document / shadow root ---
  // Mutations (index and length writes, the attribute setter) are validated like the
  // WebIDL set/delete algorithms and re-apply the root's adopted sheets natively (their
  // rule text, after every <style>/<link> sheet; scoped to the host for a shadow root).
  const adoptedArrays = new WeakMap(); // document or shadow root -> proxy
  const adoptedTargets = new WeakMap(); // proxy -> backing array
  const adoptedDirty = new Set();
  const isIndexKey = (key) => typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
  function checkAdoptable(v) {
    if (!(v instanceof CSSStyleSheet)) throw new TypeError("Failed to set the 'adoptedStyleSheets' property on 'DocumentOrShadowRoot': Failed to convert value to 'CSSStyleSheet'.");
    if (!sheetDataOf(v).constructed) throw new DOMException("Failed to set the 'adoptedStyleSheets' property on 'DocumentOrShadowRoot': Can't adopt non-constructed stylesheets.", 'NotAllowedError');
  }
  function adoptedChanged(root) {
    adoptedDirty.add(root);
    if (!sheetFlushQueued) {
      sheetFlushQueued = true;
      L.microtask(() => { sheetFlushQueued = false; L.flushSheets(); });
    }
  }
  function adoptedHostId(root) {
    if (root === document) return 0;
    if (isShadowRoot(root)) return idOf(shadowInfo.get(root).host);
    return -1; // other documents render nothing
  }
  function flushAdopted(root) {
    const hostId = adoptedHostId(root);
    if (hostId < 0) return;
    const sheets = Array.from(adoptedTargets.get(adoptedArrays.get(root)), (s) => {
      const d = sheetDataOf(s);
      d.adopters.add(root);
      if (d.disabled) return null;
      const text = d.rules.map(ruleText).join('\n');
      return [d.media ? `@media ${d.media} {\n${text}\n}` : text, d.baseURL];
    }).filter((x) => x !== null);
    N.setAdoptedSheets(hostId, sheets.map((x) => x[0]), sheets.map((x) => x[1]));
  }
  L.adoptedStyleSheetsOf = function (root) {
    let p = adoptedArrays.get(root);
    if (p !== undefined) return p;
    const t = [];
    const setIndexed = (key, value) => {
      const i = Number(key);
      if (i > t.length) throw new RangeError("Failed to set an indexed property on 'ObservableArray': The index is out of range.");
      checkAdoptable(value);
      // Own data property, not [[Set]]: an accessor on Array.prototype must never see
      // the backing array.
      Object.defineProperty(t, i, { value, writable: true, enumerable: true, configurable: true });
      adoptedChanged(root);
      return true;
    };
    const setLength = (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 4294967295) throw new RangeError('Invalid array length');
      if (n > t.length) throw new RangeError("Failed to set the 'length' property on 'ObservableArray': The provided value is larger than the current length.");
      if (n !== t.length) { t.length = n; adoptedChanged(root); }
      return true;
    };
    p = new Proxy(t, {
      set(target, key, value) {
        if (isIndexKey(key)) return setIndexed(key, value);
        if (key === 'length') return setLength(value);
        return Reflect.set(target, key, value);
      },
      defineProperty(target, key, desc) {
        if (isIndexKey(key) || key === 'length') {
          if (!('value' in desc) || desc.get !== undefined || desc.set !== undefined) return false;
          return key === 'length' ? setLength(desc.value) : setIndexed(key, desc.value);
        }
        return Reflect.defineProperty(target, key, desc);
      },
      deleteProperty(target, key) {
        if (isIndexKey(key)) {
          if (Number(key) !== t.length - 1) return false;
          t.length -= 1;
          adoptedChanged(root);
          return true;
        }
        return Reflect.deleteProperty(target, key);
      },
    });
    adoptedArrays.set(root, p);
    adoptedTargets.set(p, t);
    return p;
  };
  L.setAdoptedStyleSheets = function (root, value) {
    if (value === null || value === undefined || typeof value[Symbol.iterator] !== 'function') {
      throw new TypeError("Failed to set the 'adoptedStyleSheets' property on 'DocumentOrShadowRoot': The provided value cannot be converted to a sequence.");
    }
    // (Array.from, not push: setters installed on Array.prototype must not observe the list.)
    const items = Array.from(value, (v) => {
      if (!(v instanceof CSSStyleSheet)) throw new TypeError("Failed to set the 'adoptedStyleSheets' property on 'DocumentOrShadowRoot': Failed to convert value to 'CSSStyleSheet'.");
      return v;
    });
    const t = adoptedTargets.get(L.adoptedStyleSheetsOf(root));
    t.length = 0;
    adoptedChanged(root);
    for (const v of items) {
      checkAdoptable(v);
      Object.defineProperty(t, t.length, { value: v, writable: true, enumerable: true, configurable: true });
    }
  };
  class StyleSheetList {
    #doc;
    constructor(token, doc) { if (token !== INTERNAL) throw L.illegal(); this.#doc = doc; }
    static {
      L.sslItems = (o) => {
        const ids = N.querySelectorAll(idOf(o.#doc), 'style, link');
        const out = [];
        for (const id of ids) {
          const w = wrap(id);
          const sh = w.sheet;
          if (sh) out.push(sh);
        }
        return out;
      };
    }
    get length() { const n = L.sslItems(this).length; if (n > 32) L.ensureIndexed(StyleSheetList.prototype, n); return n; }
    item(i) { const v = L.sslItems(this)[Number(i) >>> 0]; return v === undefined ? null : v; }
    *[Symbol.iterator]() { yield* L.sslItems(this); }
  }
  L.makeIndexed(StyleSheetList.prototype, (o, i) => L.sslItems(o)[i], 32);

  // Layout reads flush pending stylesheet changes first.
  const layoutNatives = ['getBoundingClientRect', 'getClientRects', 'offsetMetrics', 'clientMetrics', 'scrollMetrics'];
  L.layoutRead = function () { if (dirtySheets.size !== 0) L.flushSheets(); };

  // =======================================================================================
  // MutationObserver
  // =======================================================================================
  let moOrderCounter = 0;
  function normalizeMOOptions(options) {
    const o = options === undefined || options === null ? {} : options;
    const childList = !!o.childList, subtree = !!o.subtree;
    let attributes = o.attributes, characterData = o.characterData;
    const aov = o.attributeOldValue, cov = o.characterDataOldValue, af = o.attributeFilter;
    if (attributes === undefined && (aov !== undefined || af !== undefined)) attributes = true;
    if (characterData === undefined && cov !== undefined) characterData = true;
    attributes = !!attributes;
    characterData = !!characterData;
    const pre = "Failed to execute 'observe' on 'MutationObserver': ";
    if (!childList && !attributes && !characterData) throw new TypeError(pre + "The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.");
    if (aov && !attributes) throw new TypeError(pre + "The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.");
    if (af !== undefined && !attributes) throw new TypeError(pre + "The options object may only set 'attributeFilter' when 'attributes' is true or not present.");
    if (cov && !characterData) throw new TypeError(pre + "The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.");
    return {
      childList, attributes, characterData, subtree, attributeOldValue: !!aov, characterDataOldValue: !!cov,
      attributeFilter: af === undefined ? null : new Set(Array.from(af, (x) => `${x}`)),
    };
  }
  class MutationObserver {
    #cb; #records = []; #order; #targets = new Set();
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError("Failed to construct 'MutationObserver': The callback provided as parameter 1 is not a function.");
      this.#cb = callback;
      this.#order = moOrderCounter++;
    }
    observe(target, options) {
      const tid = L.nodeArg(target, 'observe', 1);
      const o = normalizeMOOptions(options);
      let regs = moRegs.get(tid);
      if (regs === undefined) { regs = []; moRegs.set(tid, regs); }
      for (const r of regs) {
        if (r.observer === this) { r.o = o; return; }
      }
      regs.push({ observer: this, o });
      this.#targets.add(tid);
      moRegCount++;
    }
    disconnect() {
      for (const tid of this.#targets) {
        const regs = moRegs.get(tid);
        if (regs === undefined) continue;
        const rest = regs.filter((r) => r.observer !== this);
        moRegCount -= regs.length - rest.length;
        if (rest.length) moRegs.set(tid, rest); else moRegs.delete(tid);
      }
      this.#targets.clear();
      this.#records = [];
    }
    takeRecords() {
      const r = this.#records;
      this.#records = [];
      return r;
    }
    static {
      MO = {
        push: (o, r) => { o.#records.push(r); },
        take: (o) => { const r = o.#records; o.#records = []; return r; },
        callback: (o) => o.#cb,
        order: (o) => o.#order,
      };
    }
  }
  class MutationRecord {
    #r;
    constructor(token, r) { if (token !== INTERNAL) throw L.illegal(); this.#r = r; }
    get type() { return this.#r.type; }
    get target() { return wrap(this.#r.target); }
    get addedNodes() { const r = this.#r; if (!r.addedList) r.addedList = L.staticNodeList(r.added || []); return r.addedList; }
    get removedNodes() { const r = this.#r; if (!r.removedList) r.removedList = L.staticNodeList(r.removed || []); return r.removedList; }
    get previousSibling() { return wrap(this.#r.prev); }
    get nextSibling() { return wrap(this.#r.next); }
    get attributeName() { return this.#r.attributeName === undefined ? null : this.#r.attributeName; }
    get attributeNamespace() { return null; }
    get oldValue() { return this.#r.oldValue === undefined ? null : this.#r.oldValue; }
  }

  // =======================================================================================
  // Custom elements
  // =======================================================================================
  const CE_RESERVED = new Set(['annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri',
    'font-face-format', 'font-face-name', 'missing-glyph']);
  const PCEN_RE = /^[a-z][\-.0-9_a-z\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C\u200D\u203F\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]*$/u;
  L.isValidCEName = function (n) { return n.includes('-') && PCEN_RE.test(n) && !CE_RESERVED.has(n); };
  function isConstructor(f) {
    try { Reflect.construct(String, [], f); return true; } catch (_) { return false; }
  }
  const CE_CALLBACKS = ['connectedCallback', 'disconnectedCallback', 'adoptedCallback', 'attributeChangedCallback', 'connectedMoveCallback'];
  const CE_FORM_CALLBACKS = ['formAssociatedCallback', 'formResetCallback', 'formDisabledCallback', 'formStateRestoreCallback'];
  class CustomElementRegistry {
    #defining = false;
    #when = new Map();
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    define(name, constructor, options) {
      const n = `${name}`;
      const pre = "Failed to execute 'define' on 'CustomElementRegistry': ";
      if (typeof constructor !== 'function' || !isConstructor(constructor)) throw new TypeError(pre + "The provided value cannot be converted to a constructor.");
      if (!L.isValidCEName(n)) throw new DOMException(pre + `"${n}" is not a valid custom element name`, 'SyntaxError');
      if (ceDefs.has(n) || builtinDefs.has(n)) throw new DOMException(pre + `the name "${n}" has already been used with this registry`, 'NotSupportedError');
      if (ceByCtor.has(constructor)) throw new DOMException(pre + 'this constructor has already been used with this registry', 'NotSupportedError');
      let ext = null;
      if (options !== undefined && options !== null && options.extends !== undefined && options.extends !== null) {
        ext = `${options.extends}`;
        if (L.isValidCEName(ext)) throw new DOMException(pre + `"${ext}" is a valid custom element name`, 'NotSupportedError');
      }
      if (this.#defining) throw new DOMException(pre + 'this registry is already defining an element', 'NotSupportedError');
      this.#defining = true;
      const callbacks = {};
      let observed = new Set(), formAssociated = false;
      try {
        const proto = constructor.prototype;
        if (!L.isObj(proto)) throw new TypeError(pre + "The 'prototype' property of the constructor is not an object.");
        for (const cb of CE_CALLBACKS) {
          const v = proto[cb];
          if (v !== undefined) {
            if (typeof v !== 'function') throw new TypeError(pre + `The '${cb}' property on the prototype is not a function.`);
            callbacks[cb] = v;
          }
        }
        if (callbacks.attributeChangedCallback !== undefined) {
          const oa = constructor.observedAttributes;
          if (oa !== undefined && oa !== null) observed = new Set(Array.from(oa, (x) => `${x}`));
        }
        formAssociated = !!constructor.formAssociated;
        if (formAssociated) {
          for (const cb of CE_FORM_CALLBACKS) {
            const v = proto[cb];
            if (v !== undefined && typeof v === 'function') callbacks[cb] = v;
          }
        }
      } finally {
        this.#defining = false;
      }
      const def = { name: n, localName: ext === null ? n : ext, ctor: constructor, callbacks, observed, stack: [], ext, formAssociated };
      if (ext !== null) builtinDefs.set(n, def);
      else ceDefs.set(n, def);
      ceByCtor.set(constructor, def);
      rebuildCeSelector();
      const sel = ext === null ? L.cssEscape(n) : L.cssEscape(ext) + '[is=' + L.cssString(n) + ']';
      for (const id of N.querySelectorAll(mainDocId, sel)) {
        const w = wrap(id);
        if (!ceState.has(w)) upgradeElement(w);
      }
      const pending = this.#when.get(n);
      if (pending !== undefined) {
        this.#when.delete(n);
        pending.resolve(constructor);
      }
    }
    get(name) {
      const d = ceDefs.get(`${name}`) || builtinDefs.get(`${name}`);
      return d === undefined ? undefined : d.ctor;
    }
    getName(constructor) {
      const d = ceByCtor.get(constructor);
      return d === undefined ? null : d.name;
    }
    whenDefined(name) {
      const n = `${name}`;
      if (!L.isValidCEName(n)) return L.rejectedPromise(new DOMException(`Failed to execute 'whenDefined' on 'CustomElementRegistry': "${n}" is not a valid custom element name`, 'SyntaxError'));
      const d = ceDefs.get(n) || builtinDefs.get(n);
      if (d !== undefined) return L.resolvedPromise(d.ctor);
      let p = this.#when.get(n);
      if (p === undefined) {
        let resolve;
        const promise = L.newPromise((r) => { resolve = r; });
        p = { promise, resolve };
        this.#when.set(n, p);
      }
      return p.promise;
    }
    upgrade(root) {
      const id = L.nodeArg(root, 'upgrade', 1);
      ceUpgradeSubtree(id, true);
    }
  }
  L.customElements = new CustomElementRegistry(INTERNAL);
  L.CE_FAILED = FAILED;

  // =======================================================================================
  // NodeFilter / TreeWalker / NodeIterator
  // =======================================================================================
  const NODE_FILTER_CONSTS = {
    FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3, SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 0x1,
    SHOW_ATTRIBUTE: 0x2, SHOW_TEXT: 0x4, SHOW_CDATA_SECTION: 0x8, SHOW_ENTITY_REFERENCE: 0x10, SHOW_ENTITY: 0x20,
    SHOW_PROCESSING_INSTRUCTION: 0x40, SHOW_COMMENT: 0x80, SHOW_DOCUMENT: 0x100, SHOW_DOCUMENT_TYPE: 0x200,
    SHOW_DOCUMENT_FRAGMENT: 0x400, SHOW_NOTATION: 0x800,
  };
  const NodeFilter = function NodeFilter() { throw L.illegal(); };
  for (const k in NODE_FILTER_CONSTS) Object.defineProperty(NodeFilter, k, { value: NODE_FILTER_CONSTS[k], enumerable: true });
  Object.defineProperty(NodeFilter, 'prototype', { value: Object.create(Object.prototype), writable: false });
  Object.defineProperty(NodeFilter.prototype, 'acceptNode', { value: function acceptNode() { }, writable: true, enumerable: true, configurable: true });

  const traversalActive = new WeakSet();
  function runFilter(self, whatToShow, filter, id) {
    if (traversalActive.has(self)) throw new DOMException('Failed to execute traversal: The filter is already running.', 'InvalidStateError');
    const w = wrap(id);
    const t = typeOf(w);
    if (!((1 << (t - 1)) & whatToShow)) return 3;
    if (filter === null) return 1;
    traversalActive.add(self);
    try {
      let r;
      if (typeof filter === 'function') r = filter(w);
      else {
        const fn = filter.acceptNode;
        if (typeof fn !== 'function') throw new TypeError("Failed to execute 'acceptNode' on 'NodeFilter': The provided callback is not callable.");
        r = Reflect.apply(fn, filter, [w]);
      }
      return Number(r) >>> 0;
    } finally {
      traversalActive.delete(self);
    }
  }
  class TreeWalker {
    #root; #what; #filter; #cur;
    constructor(token, root, what, filter) {
      if (token !== INTERNAL) throw L.illegal();
      this.#root = idOf(root); this.#what = what; this.#filter = filter; this.#cur = idOf(root);
    }
    get root() { return wrap(this.#root); }
    get whatToShow() { return this.#what; }
    get filter() { return this.#filter; }
    get currentNode() { return wrap(this.#cur); }
    set currentNode(v) { this.#cur = L.nodeArg(v, 'currentNode', 1); }
    #f(id) { return runFilter(this, this.#what, this.#filter, id); }
    parentNode() {
      let node = this.#cur;
      while (node !== 0 && node !== this.#root) {
        node = N.parent(node);
        if (node !== 0 && this.#f(node) === 1) { this.#cur = node; return wrap(node); }
      }
      return null;
    }
    #children(first) {
      let node = first ? N.firstChild(this.#cur) : N.lastChild(this.#cur);
      while (node !== 0) {
        const r = this.#f(node);
        if (r === 1) { this.#cur = node; return wrap(node); }
        if (r === 3) {
          const child = first ? N.firstChild(node) : N.lastChild(node);
          if (child !== 0) { node = child; continue; }
        }
        while (node !== 0) {
          const sib = first ? N.nextSibling(node) : N.prevSibling(node);
          if (sib !== 0) { node = sib; break; }
          const p = N.parent(node);
          if (p === 0 || p === this.#root || p === this.#cur) return null;
          node = p;
        }
      }
      return null;
    }
    firstChild() { return this.#children(true); }
    lastChild() { return this.#children(false); }
    #siblings(next) {
      let node = this.#cur;
      if (node === this.#root) return null;
      for (;;) {
        let sib = next ? N.nextSibling(node) : N.prevSibling(node);
        while (sib !== 0) {
          node = sib;
          const r = this.#f(node);
          if (r === 1) { this.#cur = node; return wrap(node); }
          sib = next ? N.firstChild(node) : N.lastChild(node);
          if (r === 2 || sib === 0) sib = next ? N.nextSibling(node) : N.prevSibling(node);
        }
        node = N.parent(node);
        if (node === 0 || node === this.#root) return null;
        if (this.#f(node) === 1) return null;
      }
    }
    nextSibling() { return this.#siblings(true); }
    previousSibling() { return this.#siblings(false); }
    previousNode() {
      let node = this.#cur;
      while (node !== this.#root) {
        let sib = N.prevSibling(node);
        while (sib !== 0) {
          node = sib;
          let r = this.#f(node);
          while (r !== 2 && N.firstChild(node) !== 0) {
            node = N.lastChild(node);
            r = this.#f(node);
          }
          if (r === 1) { this.#cur = node; return wrap(node); }
          sib = N.prevSibling(node);
        }
        if (node === this.#root) return null;
        const p = N.parent(node);
        if (p === 0) return null;
        node = p;
        if (this.#f(node) === 1) { this.#cur = node; return wrap(node); }
      }
      return null;
    }
    nextNode() {
      let node = this.#cur;
      let r = 1;
      for (;;) {
        while (r !== 2 && N.firstChild(node) !== 0) {
          node = N.firstChild(node);
          r = this.#f(node);
          if (r === 1) { this.#cur = node; return wrap(node); }
        }
        let sib = 0, tmp = node;
        while (tmp !== 0) {
          if (tmp === this.#root) return null;
          sib = N.nextSibling(tmp);
          if (sib !== 0) { node = sib; break; }
          tmp = N.parent(tmp);
        }
        if (tmp === 0) return null;
        r = this.#f(node);
        if (r === 1) { this.#cur = node; return wrap(node); }
      }
    }
  }
  function followingInRoot(id, root) {
    const c = N.firstChild(id);
    if (c !== 0) return c;
    for (let n = id; n !== 0 && n !== root; n = N.parent(n)) {
      const s = N.nextSibling(n);
      if (s !== 0) return s;
    }
    return 0;
  }
  function precedingInRoot(id, root) {
    if (id === root) return 0;
    let s = N.prevSibling(id);
    if (s !== 0) {
      while (N.lastChild(s) !== 0) s = N.lastChild(s);
      return s;
    }
    return N.parent(id);
  }
  L.followingInRoot = followingInRoot;
  class NodeIterator {
    #root; #what; #filter; #ref; #before = true;
    constructor(token, root, what, filter) {
      if (token !== INTERNAL) throw L.illegal();
      this.#root = idOf(root); this.#what = what; this.#filter = filter; this.#ref = idOf(root);
    }
    get root() { return wrap(this.#root); }
    get referenceNode() { return wrap(this.#ref); }
    get pointerBeforeReferenceNode() { return this.#before; }
    get whatToShow() { return this.#what; }
    get filter() { return this.#filter; }
    #traverse(next) {
      let node = this.#ref, before = this.#before;
      for (;;) {
        if (next) {
          if (!before) {
            node = followingInRoot(node, this.#root);
            if (node === 0) return null;
          } else before = false;
        } else if (before) {
          node = precedingInRoot(node, this.#root);
          if (node === 0) return null;
        } else before = true;
        const r = runFilter(this, this.#what, this.#filter, node);
        if (r === 1) break;
      }
      this.#ref = node;
      this.#before = before;
      return wrap(node);
    }
    nextNode() { return this.#traverse(true); }
    previousNode() { return this.#traverse(false); }
    detach() { }
  }

  // =======================================================================================
  // Range / StaticRange / Selection
  // =======================================================================================
  function nodeLength(id) {
    const t = N.nodeType(id);
    if (t === 10) return 0;
    if (t === 3 || t === 8 || t === 4 || t === 7) return N.getText(id).length;
    return N.childIds(id).length;
  }
  function indexOfNode(id) {
    const p = N.parent(id);
    if (p === 0) return 0;
    return N.childIds(p).indexOf(id);
  }
  function rootOf(id) { let r = id, p; while ((p = N.parent(r)) !== 0) r = p; return r; }
  function isCharData(id) { const t = N.nodeType(id); return t === 3 || t === 8 || t === 4 || t === 7; }
  // Compare boundary points: -1 before, 0 equal, 1 after
  function bpCompare(a, oa, b, ob) {
    if (a === b) return oa === ob ? 0 : oa < ob ? -1 : 1;
    const pos = N.compareDocumentPosition(a, b);
    if (pos & 2) return -bpCompare(b, ob, a, oa);
    if (pos & 16) {
      let child = b;
      while (N.parent(child) !== a) child = N.parent(child);
      if (indexOfNode(child) < oa) return 1;
    }
    return -1;
  }
  L.bpCompare = bpCompare;
  class AbstractRange {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
  }
  class StaticRange extends AbstractRange {
    #sc; #so; #ec; #eo;
    constructor(init) {
      super(INTERNAL);
      if (!init || !isNode(init.startContainer) || !isNode(init.endContainer)) throw new TypeError("Failed to construct 'StaticRange': required member startContainer/endContainer is undefined.");
      const t1 = typeOf(init.startContainer), t2 = typeOf(init.endContainer);
      if (t1 === 10 || t1 === 2 || t2 === 10 || t2 === 2) throw new DOMException("Failed to construct 'StaticRange': invalid node type", 'InvalidNodeTypeError');
      this.#sc = init.startContainer; this.#so = init.startOffset >>> 0; this.#ec = init.endContainer; this.#eo = init.endOffset >>> 0;
    }
    get startContainer() { return this.#sc; }
    get startOffset() { return this.#so; }
    get endContainer() { return this.#ec; }
    get endOffset() { return this.#eo; }
    get collapsed() { return this.#sc === this.#ec && this.#so === this.#eo; }
  }
  class Range extends AbstractRange {
    #s; // live-range state {sc, so, ec, eo}, indexed by container (see rangeIndex)
    constructor() {
      super(INTERNAL);
      this.#s = newRangeState(this, mainDocId, 0, mainDocId, 0);
    }
    static {
      L.rangeGet = (r) => { const s = r.#s; return [s.sc, s.so, s.ec, s.eo]; };
      L.rangeSet = (r, sc, so, ec, eo) => { setRangeState(r.#s, sc, so, ec, eo); };
    }
    get startContainer() { return wrap(this.#s.sc); }
    get startOffset() { return this.#s.so; }
    get endContainer() { return wrap(this.#s.ec); }
    get endOffset() { return this.#s.eo; }
    get collapsed() { const s = this.#s; return s.sc === s.ec && s.so === s.eo; }
    get commonAncestorContainer() {
      const s = this.#s;
      let a = s.sc;
      while (a !== 0 && !N.contains(a, s.ec)) a = N.parent(a);
      return wrap(a);
    }
    #setBoundary(node, offset, start, method) {
      const id = L.nodeArg(node, method, 1);
      if (typeOf(node) === 10) throw new DOMException(`Failed to execute '${method}' on 'Range': The node provided is of type 'DocumentType'.`, 'InvalidNodeTypeError');
      const off = offset >>> 0;
      if (off > nodeLength(id)) throw new DOMException(`Failed to execute '${method}' on 'Range': The offset ${off} is larger than the node's length (${nodeLength(id)}).`, 'IndexSizeError');
      const s = this.#s;
      if (start) {
        if (rootOf(id) !== rootOf(s.ec) || bpCompare(id, off, s.ec, s.eo) > 0) setRangeState(s, id, off, id, off);
        else setRangeState(s, id, off, s.ec, s.eo);
      } else if (rootOf(id) !== rootOf(s.sc) || bpCompare(id, off, s.sc, s.so) < 0) setRangeState(s, id, off, id, off);
      else setRangeState(s, s.sc, s.so, id, off);
    }
    setStart(node, offset) { this.#setBoundary(node, offset, true, 'setStart'); }
    setEnd(node, offset) { this.#setBoundary(node, offset, false, 'setEnd'); }
    #parentOf(node, method) {
      const id = L.nodeArg(node, method, 1);
      const p = N.parent(id);
      if (p === 0) throw new DOMException(`Failed to execute '${method}' on 'Range': the given Node has no parent.`, 'InvalidNodeTypeError');
      return [p, indexOfNode(id)];
    }
    setStartBefore(node) { const [p, i] = this.#parentOf(node, 'setStartBefore'); this.#setBoundary(wrap(p), i, true, 'setStartBefore'); }
    setStartAfter(node) { const [p, i] = this.#parentOf(node, 'setStartAfter'); this.#setBoundary(wrap(p), i + 1, true, 'setStartAfter'); }
    setEndBefore(node) { const [p, i] = this.#parentOf(node, 'setEndBefore'); this.#setBoundary(wrap(p), i, false, 'setEndBefore'); }
    setEndAfter(node) { const [p, i] = this.#parentOf(node, 'setEndAfter'); this.#setBoundary(wrap(p), i + 1, false, 'setEndAfter'); }
    collapse(toStart = false) {
      const s = this.#s;
      if (toStart) setRangeState(s, s.sc, s.so, s.sc, s.so); else setRangeState(s, s.ec, s.eo, s.ec, s.eo);
    }
    selectNode(node) {
      const [p, i] = this.#parentOf(node, 'selectNode');
      setRangeState(this.#s, p, i, p, i + 1);
    }
    selectNodeContents(node) {
      const id = L.nodeArg(node, 'selectNodeContents', 1);
      if (typeOf(node) === 10) throw new DOMException("Failed to execute 'selectNodeContents' on 'Range': The node provided is of type 'DocumentType'.", 'InvalidNodeTypeError');
      setRangeState(this.#s, id, 0, id, nodeLength(id));
    }
    compareBoundaryPoints(how, sourceRange) {
      // WebIDL `unsigned short`: ToNumber, truncate, modulo 2^16 (NaN/±Infinity → 0).
      let h = Number(how);
      h = Number.isFinite(h) ? Math.trunc(h) % 65536 : 0;
      if (h < 0) h += 65536;
      if (!(sourceRange instanceof Range)) throw new TypeError("Failed to execute 'compareBoundaryPoints' on 'Range': parameter 2 is not of type 'Range'.");
      if (h !== 0 && h !== 1 && h !== 2 && h !== 3) throw new DOMException("Failed to execute 'compareBoundaryPoints' on 'Range': The comparison method provided must be one of 'START_TO_START', 'START_TO_END', 'END_TO_END', or 'END_TO_START'.", 'NotSupportedError');
      const [ssc, sso, sec, seo] = L.rangeGet(sourceRange);
      if (rootOf(this.#s.sc) !== rootOf(ssc)) throw new DOMException("Failed to execute 'compareBoundaryPoints' on 'Range': The source range is in a different document than this range.", 'WrongDocumentError');
      switch (h) {
        case 0: return bpCompare(this.#s.sc, this.#s.so, ssc, sso);
        case 1: return bpCompare(this.#s.ec, this.#s.eo, ssc, sso);
        case 2: return bpCompare(this.#s.ec, this.#s.eo, sec, seo);
        default: return bpCompare(this.#s.sc, this.#s.so, sec, seo);
      }
    }
    comparePoint(node, offset) {
      const id = L.nodeArg(node, 'comparePoint', 1);
      if (rootOf(id) !== rootOf(this.#s.sc)) throw new DOMException("Failed to execute 'comparePoint' on 'Range': The node provided and the Range are not in the same tree.", 'WrongDocumentError');
      if (N.nodeType(id) === 10) throw new DOMException("Failed to execute 'comparePoint' on 'Range': The node provided is a doctype.", 'InvalidNodeTypeError');
      const off = offset >>> 0;
      if (off > nodeLength(id)) throw new DOMException("Failed to execute 'comparePoint' on 'Range': The offset is larger than the node's length.", 'IndexSizeError');
      if (bpCompare(id, off, this.#s.sc, this.#s.so) < 0) return -1;
      if (bpCompare(id, off, this.#s.ec, this.#s.eo) > 0) return 1;
      return 0;
    }
    isPointInRange(node, offset) {
      const id = L.nodeArg(node, 'isPointInRange', 1);
      if (rootOf(id) !== rootOf(this.#s.sc)) return false;
      if (N.nodeType(id) === 10) throw new DOMException("Failed to execute 'isPointInRange' on 'Range': The node provided is a doctype.", 'InvalidNodeTypeError');
      const off = offset >>> 0;
      if (off > nodeLength(id)) throw new DOMException("Failed to execute 'isPointInRange' on 'Range': The offset is larger than the node's length.", 'IndexSizeError');
      return bpCompare(id, off, this.#s.sc, this.#s.so) >= 0 && bpCompare(id, off, this.#s.ec, this.#s.eo) <= 0;
    }
    intersectsNode(node) {
      const id = L.nodeArg(node, 'intersectsNode', 1);
      if (rootOf(id) !== rootOf(this.#s.sc)) return false;
      const p = N.parent(id);
      if (p === 0) return true;
      const i = indexOfNode(id);
      return bpCompare(p, i, this.#s.ec, this.#s.eo) < 0 && bpCompare(p, i + 1, this.#s.sc, this.#s.so) > 0;
    }
    cloneRange() {
      const r = new Range();
      L.rangeSet(r, this.#s.sc, this.#s.so, this.#s.ec, this.#s.eo);
      return r;
    }
    detach() { }
    toString() {
      const sc = this.#s.sc, so = this.#s.so, ec = this.#s.ec, eo = this.#s.eo;
      if (sc === ec && N.nodeType(sc) === 3) return N.getText(sc).slice(so, eo);
      let s = '';
      if (N.nodeType(sc) === 3) s += N.getText(sc).slice(so);
      const root = rootOf(sc);
      for (let n = followingInRoot(sc, root); n !== 0; n = followingInRoot(n, root)) {
        if (n === ec) break;
        if (N.nodeType(n) === 3 && rangeContains(this, n)) s += N.getText(n);
        if (bpCompare(n, 0, ec, eo) >= 0) break;
      }
      if (N.nodeType(ec) === 3 && ec !== sc) s += N.getText(ec).slice(0, eo);
      return s;
    }
    cloneContents() { return wrap(rangeProcess(this, 'clone')); }
    extractContents() { return wrap(rangeProcess(this, 'extract')); }
    deleteContents() { rangeDelete(this); }
    insertNode(node) { rangeInsert(this, node); }
    surroundContents(newParent) {
      const npid = L.nodeArg(newParent, 'surroundContents', 1);
      const [sc, , ec] = L.rangeGet(this);
      const ptrs = [sc, ec];
      for (const x of ptrs) {
        if (N.nodeType(x) !== 3 && partiallyContained(this, x)) throw new DOMException("Failed to execute 'surroundContents' on 'Range': The Range has partially selected a non-Text node.", 'InvalidStateError');
      }
      const t = typeOf(newParent);
      if (t === 9 || t === 10 || t === 11) throw new DOMException("Failed to execute 'surroundContents' on 'Range': The node provided is of an invalid type.", 'InvalidNodeTypeError');
      const frag = rangeProcess(this, 'extract');
      if (N.firstChild(npid) !== 0) replaceAllCore(npid, newParent, () => N.setTextContent(npid, ''));
      rangeInsert(this, newParent);
      preInsert(newParent, wrap(frag), null, 'surroundContents');
      this.selectNode(newParent);
    }
    getBoundingClientRect() {
      const rects = rangeRects(this);
      if (rects.length === 0) return new DOMRect(0, 0, 0, 0);
      // Like Element.getBoundingClientRect: the union of the non-empty rects.
      const sized = rects.filter((r) => r[2] !== 0 || r[3] !== 0);
      if (sized.length === 0) return new DOMRect(rects[0][0], rects[0][1], rects[0][2], rects[0][3]);
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const r of sized) { x1 = Math.min(x1, r[0]); y1 = Math.min(y1, r[1]); x2 = Math.max(x2, r[0] + r[2]); y2 = Math.max(y2, r[1] + r[3]); }
      return new DOMRect(x1, y1, x2 - x1, y2 - y1);
    }
    getClientRects() { return new DOMRectList(INTERNAL, rangeRects(this).map((r) => new DOMRect(r[0], r[1], r[2], r[3]))); }
    createContextualFragment(fragment) {
      let ctx = this.#s.sc;
      if (N.nodeType(ctx) !== 1) ctx = N.parent(ctx);
      const ctxW = ctx === 0 || N.nodeType(ctx) !== 1 ? null : wrap(ctx);
      const frag = parseFragment(ctxW, `${fragment}`);
      for (const s of N.querySelectorAll(frag, 'script')) L.pendingScripts.add(s);
      if (ceActive()) ceUpgradeSubtree(frag, false);
      return wrap(frag);
    }
  }
  L.defineConstants([Range, Range.prototype], { START_TO_START: 0, START_TO_END: 1, END_TO_END: 2, END_TO_START: 3 });
  function rangeContains(r, id) {
    const [sc, so, ec, eo] = L.rangeGet(r);
    if (rootOf(id) !== rootOf(sc)) return false;
    return bpCompare(id, 0, sc, so) > 0 && bpCompare(id, nodeLength(id), ec, eo) < 0;
  }
  function partiallyContained(r, id) {
    const [sc, , ec] = L.rangeGet(r);
    const a = N.contains(id, sc), b = N.contains(id, ec);
    return a !== b;
  }
  // CSSOM View: the border boxes of the elements the range selects (whose parent it
  // doesn't), and the rects of the selected parts of text nodes.
  function rangeRects(r) {
    L.layoutRead();
    const [sc, so, ec, eo] = L.rangeGet(r);
    const out = [];
    const pushFlat = (f) => { if (f) for (let i = 0; i + 3 < f.length; i += 4) out.push([f[i], f[i + 1], f[i + 2], f[i + 3]]); };
    const isText = (id) => N.nodeType(id) === 3;
    const text = (id, a, b) => pushFlat(nativeCall(() => N.textRects(id, a, b)));
    const elem = (id) => pushFlat(nativeCall(() => N.getClientRects(id)));
    if (sc === ec && isText(sc)) { text(sc, so, eo); return out; }
    if (isText(sc)) text(sc, so, nodeLength(sc));
    const root = rootOf(sc);
    for (let n = followingInRoot(sc, root); n !== 0 && n !== ec; n = followingInRoot(n, root)) {
      if (bpCompare(n, 0, ec, eo) >= 0) break; // past the end
      if (!rangeContains(r, n)) continue;
      if (isText(n)) text(n, 0, nodeLength(n));
      else if (N.nodeType(n) === 1) {
        const p = N.parent(n);
        if (p === 0 || !rangeContains(r, p)) elem(n);
      }
    }
    if (ec !== sc && isText(ec)) text(ec, 0, eo);
    return out;
  }
  // Clone or extract range contents into a new fragment (returns fragment id)
  function rangeProcess(r, mode) {
    const extract = mode === 'extract';
    const frag = N.createFragment();
    const [sc, so, ec, eo] = L.rangeGet(r);
    if (sc === ec && so === eo) return frag;
    if (sc === ec && isCharData(sc)) {
      const clone = N.cloneNode(sc, false);
      const data = N.getText(sc);
      N.setText(clone, data.slice(so, eo));
      N.appendChild(frag, clone);
      if (extract) setDataCore(wrap(sc), sc, data.slice(0, so) + data.slice(eo), so, eo - so, 0);
      return frag;
    }
    let ca = sc;
    while (!N.contains(ca, ec)) ca = N.parent(ca);
    let firstPC = 0, lastPC = 0;
    if (!N.contains(sc, ec)) { for (const c of N.childIds(ca)) if (N.contains(c, sc)) { firstPC = c; break; } }
    if (!N.contains(ec, sc)) { for (const c of N.childIds(ca)) if (N.contains(c, ec)) { lastPC = c; break; } }
    const contained = N.childIds(ca).filter((c) => rangeContains(r, c));
    for (const c of contained) if (N.nodeType(c) === 10) throw hier("Failed to execute 'cloneContents' on 'Range': A DocumentType node would be cloned.");
    let newNode = sc, newOffset = so;
    if (extract && !N.contains(sc, ec)) {
      let ref = sc;
      while (N.parent(ref) !== 0 && !N.contains(N.parent(ref), ec)) ref = N.parent(ref);
      newNode = N.parent(ref);
      newOffset = indexOfNode(ref) + 1;
    }
    if (firstPC !== 0 && isCharData(firstPC)) {
      const clone = N.cloneNode(sc, false);
      const data = N.getText(sc);
      N.setText(clone, data.slice(so));
      N.appendChild(frag, clone);
      if (extract) setDataCore(wrap(sc), sc, data.slice(0, so), so, data.length - so, 0);
    } else if (firstPC !== 0) {
      const clone = N.cloneNode(firstPC, false);
      N.appendChild(frag, clone);
      const sub = new Range();
      L.rangeSet(sub, sc, so, firstPC, nodeLength(firstPC));
      const subFrag = rangeProcess(sub, mode);
      N.appendChild(clone, subFrag);
    }
    for (const c of contained) {
      if (extract) {
        removeCore(N.parent(c), undefined, c);
        N.appendChild(frag, c);
      } else {
        N.appendChild(frag, N.cloneNode(c, true));
      }
    }
    if (lastPC !== 0 && isCharData(lastPC)) {
      const clone = N.cloneNode(ec, false);
      const data = N.getText(ec);
      N.setText(clone, data.slice(0, eo));
      N.appendChild(frag, clone);
      if (extract) setDataCore(wrap(ec), ec, data.slice(eo), 0, eo, 0);
    } else if (lastPC !== 0) {
      const clone = N.cloneNode(lastPC, false);
      N.appendChild(frag, clone);
      const sub = new Range();
      L.rangeSet(sub, lastPC, 0, ec, eo);
      const subFrag = rangeProcess(sub, mode);
      N.appendChild(clone, subFrag);
    }
    treeChanged();
    if (extract) L.rangeSet(r, newNode, newOffset, newNode, newOffset);
    return frag;
  }
  function rangeDelete(r) {
    const [sc, so, ec, eo] = L.rangeGet(r);
    if (sc === ec && so === eo) return;
    if (sc === ec && isCharData(sc)) {
      const d = N.getText(sc);
      setDataCore(wrap(sc), sc, d.slice(0, so) + d.slice(eo), so, eo - so, 0);
      return;
    }
    const toRemove = [];
    let ca = sc;
    while (!N.contains(ca, ec)) ca = N.parent(ca);
    const collect = (id) => {
      for (const c of N.childIds(id)) {
        if (rangeContains(r, c)) toRemove.push(c);
        else if (N.contains(c, sc) || N.contains(c, ec)) collect(c);
      }
    };
    collect(ca);
    let newNode, newOffset;
    if (N.contains(sc, ec)) { newNode = sc; newOffset = so; } else {
      let ref = sc;
      while (N.parent(ref) !== 0 && !N.contains(N.parent(ref), ec)) ref = N.parent(ref);
      newNode = N.parent(ref); newOffset = indexOfNode(ref) + 1;
    }
    if (isCharData(sc)) { const d = N.getText(sc); setDataCore(wrap(sc), sc, d.slice(0, so), so, d.length - so, 0); }
    for (const c of toRemove) { const p = N.parent(c); if (p !== 0) removeCore(p, undefined, c); }
    if (isCharData(ec) && ec !== sc) { const d = N.getText(ec); setDataCore(wrap(ec), ec, d.slice(eo), 0, eo, 0); }
    L.rangeSet(r, newNode, newOffset, newNode, newOffset);
  }
  function rangeInsert(r, node) {
    const nid = L.nodeArg(node, 'insertNode', 1);
    const [sc, so, ec, eo] = L.rangeGet(r);
    const st = N.nodeType(sc);
    if (st === 7 || st === 8 || (st === 3 && N.parent(sc) === 0) || sc === nid) throw hier("Failed to execute 'insertNode' on 'Range': The range start is in a node that cannot contain the inserted node.");
    let ref = st === 3 ? sc : (N.childIds(sc)[so] || 0);
    const parent = ref === 0 ? sc : N.parent(ref);
    ensurePreInsert(wrap(parent), parent, node, nid, ref, 'insertNode');
    if (st === 3) ref = idOf(wrap(sc).splitText(so));
    if (nid === ref) ref = N.nextSibling(nid);
    const op = N.parent(nid);
    if (op !== 0) removeCore(op, undefined, nid);
    let newOffset = ref === 0 ? nodeLength(parent) : indexOfNode(ref);
    newOffset += typeOf(node) === 11 ? N.childIds(nid).length : 1;
    const collapsed = sc === ec && so === eo;
    preInsert(wrap(parent), node, wrap(ref), 'insertNode');
    if (collapsed) {
      const cur = L.rangeGet(r);
      L.rangeSet(r, cur[0], cur[1], parent, newOffset);
    }
  }

  class Selection {
    #range = null; #backward = false;
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    #changed() { L.queueSelectionChange(); }
    get anchorNode() { const r = this.#range; return r === null ? null : (this.#backward ? r.endContainer : r.startContainer); }
    get anchorOffset() { const r = this.#range; return r === null ? 0 : (this.#backward ? r.endOffset : r.startOffset); }
    get focusNode() { const r = this.#range; return r === null ? null : (this.#backward ? r.startContainer : r.endContainer); }
    get focusOffset() { const r = this.#range; return r === null ? 0 : (this.#backward ? r.startOffset : r.endOffset); }
    // Legacy aliases (WebKit/Blink).
    get baseNode() { return this.anchorNode; }
    get baseOffset() { return this.anchorOffset; }
    get extentNode() { return this.focusNode; }
    get extentOffset() { return this.focusOffset; }
    get isCollapsed() { return this.#range === null || this.#range.collapsed; }
    get rangeCount() { return this.#range === null ? 0 : 1; }
    get type() { return this.#range === null ? 'None' : this.#range.collapsed ? 'Caret' : 'Range'; }
    get direction() { return this.#range === null || this.#range.collapsed ? 'none' : this.#backward ? 'backward' : 'forward'; }
    getRangeAt(index) {
      if ((index >>> 0) !== 0 || this.#range === null) throw new DOMException(`Failed to execute 'getRangeAt' on 'Selection': ${index} is not a valid index.`, 'IndexSizeError');
      return this.#range;
    }
    getComposedRanges() {
      const r = this.#range;
      if (r === null) return [];
      return [new StaticRange({ startContainer: r.startContainer, startOffset: r.startOffset, endContainer: r.endContainer, endOffset: r.endOffset })];
    }
    addRange(range) {
      if (!(range instanceof Range)) throw new TypeError("Failed to execute 'addRange' on 'Selection': parameter 1 is not of type 'Range'.");
      if (this.#range !== null) return;
      this.#range = range; this.#backward = false; this.#changed();
    }
    removeRange(range) {
      if (range !== this.#range) throw notFound("Failed to execute 'removeRange' on 'Selection': The given range isn't in document.");
      this.#range = null; this.#changed();
    }
    removeAllRanges() { if (this.#range !== null) { this.#range = null; this.#changed(); } }
    empty() { this.removeAllRanges(); }
    collapse(node, offset = 0) {
      if (node === null || node === undefined) { this.removeAllRanges(); return; }
      const r = new Range();
      r.setStart(node, offset);
      r.collapse(true);
      this.#range = r; this.#backward = false; this.#changed();
    }
    setPosition(node, offset = 0) { this.collapse(node, offset); }
    collapseToStart() {
      if (this.#range === null) throw new DOMException("Failed to execute 'collapseToStart' on 'Selection': there is no selection.", 'InvalidStateError');
      const r = this.#range.cloneRange(); r.collapse(true); this.#range = r; this.#changed();
    }
    collapseToEnd() {
      if (this.#range === null) throw new DOMException("Failed to execute 'collapseToEnd' on 'Selection': there is no selection.", 'InvalidStateError');
      const r = this.#range.cloneRange(); r.collapse(false); this.#range = r; this.#changed();
    }
    extend(node, offset = 0) {
      if (this.#range === null) throw new DOMException("Failed to execute 'extend' on 'Selection': This Selection object doesn't have any Ranges.", 'InvalidStateError');
      const anchorN = this.anchorNode, anchorO = this.anchorOffset;
      this.setBaseAndExtent(anchorN, anchorO, node, offset);
    }
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
      const a = L.nodeArg(anchorNode, 'setBaseAndExtent', 1), f = L.nodeArg(focusNode, 'setBaseAndExtent', 3);
      const ao = anchorOffset >>> 0, fo = focusOffset >>> 0;
      const r = new Range();
      if (bpCompare(a, ao, f, fo) <= 0) { r.setStart(anchorNode, ao); r.setEnd(focusNode, fo); this.#backward = false; }
      else { r.setStart(focusNode, fo); r.setEnd(anchorNode, ao); this.#backward = true; }
      this.#range = r; this.#changed();
    }
    selectAllChildren(node) {
      const r = new Range();
      r.selectNodeContents(node);
      this.#range = r; this.#backward = false; this.#changed();
    }
    modify() { }
    deleteFromDocument() { if (this.#range !== null) this.#range.deleteContents(); }
    containsNode(node, allowPartialContainment = false) {
      if (this.#range === null) return false;
      const id = L.nodeArg(node, 'containsNode', 1);
      if (allowPartialContainment) return this.#range.intersectsNode(node);
      return rangeContains(this.#range, id);
    }
    toString() { return this.#range === null ? '' : this.#range.toString(); }
  }
  const selection = new Selection(INTERNAL);
  L.getSelection = function () { return selection; };
  let selChangeQueued = false;
  L.queueSelectionChange = function () {
    if (selChangeQueued) return;
    selChangeQueued = true;
    L.postTask(() => { selChangeQueued = false; L.fire(document, 'selectionchange', { bubbles: false }); });
  };

  // =======================================================================================
  // Geometry: DOMRect(ReadOnly), DOMRectList, DOMPoint(ReadOnly), DOMQuad, DOMMatrix(ReadOnly)
  // =======================================================================================
  class DOMRectReadOnly {
    #x; #y; #w; #h;
    constructor(x = 0, y = 0, width = 0, height = 0) { this.#x = +x; this.#y = +y; this.#w = +width; this.#h = +height; }
    static fromRect(o) { o = o || {}; return new this(o.x || 0, o.y || 0, o.width || 0, o.height || 0); }
    get x() { return this.#x; }
    get y() { return this.#y; }
    get width() { return this.#w; }
    get height() { return this.#h; }
    get top() { return Math.min(this.#y, this.#y + this.#h); }
    get right() { return Math.max(this.#x, this.#x + this.#w); }
    get bottom() { return Math.max(this.#y, this.#y + this.#h); }
    get left() { return Math.min(this.#x, this.#x + this.#w); }
    toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left }; }
    static { L.rectSet = (r, k, v) => { if (k === 0) r.#x = v; else if (k === 1) r.#y = v; else if (k === 2) r.#w = v; else r.#h = v; }; }
  }
  class DOMRect extends DOMRectReadOnly {
    get x() { return super.x; } set x(v) { L.rectSet(this, 0, +v); }
    get y() { return super.y; } set y(v) { L.rectSet(this, 1, +v); }
    get width() { return super.width; } set width(v) { L.rectSet(this, 2, +v); }
    get height() { return super.height; } set height(v) { L.rectSet(this, 3, +v); }
  }
  class DOMRectList {
    #rects;
    constructor(token, rects) { if (token !== INTERNAL) throw L.illegal(); this.#rects = rects; }
    static { L.rectListItems = (o) => o.#rects; }
    get length() { return this.#rects.length; }
    item(i) { const r = this.#rects[Number(i) >>> 0]; return r === undefined ? null : r; }
    *[Symbol.iterator]() { yield* this.#rects; }
  }
  L.makeIndexed(DOMRectList.prototype, (o, i) => L.rectListItems(o)[i], 16);
  class DOMPointReadOnly {
    #p;
    constructor(x = 0, y = 0, z = 0, w = 1) { this.#p = [+x, +y, +z, +w]; }
    static fromPoint(o) { o = o || {}; return new this(o.x || 0, o.y || 0, o.z || 0, o.w === undefined ? 1 : o.w); }
    get x() { return this.#p[0]; }
    get y() { return this.#p[1]; }
    get z() { return this.#p[2]; }
    get w() { return this.#p[3]; }
    matrixTransform(m) { const mm = m instanceof DOMMatrixReadOnly ? m : DOMMatrixReadOnly.fromMatrix(m); return mm.transformPoint(this); }
    toJSON() { return { x: this.x, y: this.y, z: this.z, w: this.w }; }
    static { L.pointSet = (o, i, v) => { o.#p[i] = +v; }; }
  }
  class DOMPoint extends DOMPointReadOnly {
    get x() { return super.x; } set x(v) { L.pointSet(this, 0, v); }
    get y() { return super.y; } set y(v) { L.pointSet(this, 1, v); }
    get z() { return super.z; } set z(v) { L.pointSet(this, 2, v); }
    get w() { return super.w; } set w(v) { L.pointSet(this, 3, v); }
  }
  class DOMQuad {
    #p;
    constructor(p1, p2, p3, p4) { this.#p = [DOMPoint.fromPoint(p1), DOMPoint.fromPoint(p2), DOMPoint.fromPoint(p3), DOMPoint.fromPoint(p4)]; }
    static fromRect(r) { r = r || {}; const x = r.x || 0, y = r.y || 0, w = r.width || 0, h = r.height || 0; return new DOMQuad({ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }); }
    static fromQuad(q) { q = q || {}; return new DOMQuad(q.p1, q.p2, q.p3, q.p4); }
    get p1() { return this.#p[0]; }
    get p2() { return this.#p[1]; }
    get p3() { return this.#p[2]; }
    get p4() { return this.#p[3]; }
    getBounds() {
      const xs = this.#p.map((p) => p.x), ys = this.#p.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return new DOMRect(x, y, Math.max(...xs) - x, Math.max(...ys) - y);
    }
    toJSON() { return { p1: this.p1, p2: this.p2, p3: this.p3, p4: this.p4 }; }
  }
  // 4x4 column-major like CSS: m11..m44; 2D a..f = m11 m12 m21 m22 m41 m42
  function matMul(a, b) { // returns a*b
    const r = new Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
        r[i * 4 + j] = s;
      }
    }
    return r;
  }
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function parseTransformList(s) {
    let m = IDENT.slice();
    let is2D = true;
    const str = `${s}`.trim();
    if (str === '' || str === 'none') return [m, true];
    const re = /([a-zA-Z0-9]+)\(([^)]*)\)/g;
    let match, consumed = '';
    const toPx = (v) => parseFloat(v);
    const toRad = (v) => {
      const n = parseFloat(v);
      if (/deg$/.test(v)) return n * Math.PI / 180;
      if (/grad$/.test(v)) return n * Math.PI / 200;
      if (/turn$/.test(v)) return n * 2 * Math.PI;
      return n;
    };
    while ((match = re.exec(str)) !== null) {
      consumed += match[0];
      const fn = match[1].toLowerCase();
      const args = match[2].split(/\s*,\s*|\s+/).filter(Boolean);
      let t = IDENT.slice();
      switch (fn) {
        case 'matrix': t = [+args[0], +args[1], 0, 0, +args[2], +args[3], 0, 0, 0, 0, 1, 0, +args[4], +args[5], 0, 1]; break;
        case 'matrix3d': t = args.map(Number); is2D = false; break;
        case 'translate': t[12] = toPx(args[0]); t[13] = args[1] ? toPx(args[1]) : 0; break;
        case 'translatex': t[12] = toPx(args[0]); break;
        case 'translatey': t[13] = toPx(args[0]); break;
        case 'translatez': t[14] = toPx(args[0]); is2D = false; break;
        case 'translate3d': t[12] = toPx(args[0]); t[13] = toPx(args[1]); t[14] = toPx(args[2]); is2D = false; break;
        case 'scale': t[0] = +args[0]; t[5] = args[1] === undefined ? +args[0] : +args[1]; break;
        case 'scalex': t[0] = +args[0]; break;
        case 'scaley': t[5] = +args[0]; break;
        case 'scalez': t[10] = +args[0]; is2D = false; break;
        case 'scale3d': t[0] = +args[0]; t[5] = +args[1]; t[10] = +args[2]; is2D = false; break;
        case 'rotate': case 'rotatez': { const a = toRad(args[0]); t[0] = Math.cos(a); t[1] = Math.sin(a); t[4] = -Math.sin(a); t[5] = Math.cos(a); if (fn === 'rotatez') is2D = false; break; }
        case 'skew': t[4] = Math.tan(toRad(args[0])); t[1] = args[1] ? Math.tan(toRad(args[1])) : 0; break;
        case 'skewx': t[4] = Math.tan(toRad(args[0])); break;
        case 'skewy': t[1] = Math.tan(toRad(args[0])); break;
        default: throw new DOMException(`Failed to construct 'DOMMatrix': Failed to parse '${str}'.`, 'SyntaxError');
      }
      m = matMul(m, t);
    }
    if (consumed.replace(/\s+/g, '') !== str.replace(/\s+/g, '')) throw new DOMException(`Failed to construct 'DOMMatrix': Failed to parse '${str}'.`, 'SyntaxError');
    return [m, is2D];
  }
  class DOMMatrixReadOnly {
    #m; #is2D;
    constructor(init) {
      if (init === undefined) { this.#m = IDENT.slice(); this.#is2D = true; return; }
      if (typeof init === 'string') {
        const [m, is2D] = parseTransformList(init);
        this.#m = m; this.#is2D = is2D;
        return;
      }
      const a = Array.from(init, Number);
      if (a.length === 6) { this.#m = [a[0], a[1], 0, 0, a[2], a[3], 0, 0, 0, 0, 1, 0, a[4], a[5], 0, 1]; this.#is2D = true; }
      else if (a.length === 16) { this.#m = a; this.#is2D = false; }
      else throw new TypeError("Failed to construct 'DOMMatrix': The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix.");
    }
    static { L.matGet = (o) => o.#m; L.matSet = (o, m, is2D) => { o.#m = m; if (is2D !== undefined) o.#is2D = is2D; }; L.matIs2D = (o) => o.#is2D; }
    static fromMatrix(o) {
      o = o || {};
      if (o instanceof DOMMatrixReadOnly) return new this(L.matGet(o).slice());
      const is2D = o.is2D !== false && (o.m13 || 0) === 0 && (o.m33 === undefined || o.m33 === 1);
      if (is2D) return new this([o.a ?? o.m11 ?? 1, o.b ?? o.m12 ?? 0, o.c ?? o.m21 ?? 0, o.d ?? o.m22 ?? 1, o.e ?? o.m41 ?? 0, o.f ?? o.m42 ?? 0]);
      return new this([o.m11 ?? 1, o.m12 ?? 0, o.m13 ?? 0, o.m14 ?? 0, o.m21 ?? 0, o.m22 ?? 1, o.m23 ?? 0, o.m24 ?? 0, o.m31 ?? 0, o.m32 ?? 0, o.m33 ?? 1, o.m34 ?? 0, o.m41 ?? 0, o.m42 ?? 0, o.m43 ?? 0, o.m44 ?? 1]);
    }
    static fromFloat32Array(a) { return new this(Array.from(a)); }
    static fromFloat64Array(a) { return new this(Array.from(a)); }
    get a() { return this.#m[0]; } get b() { return this.#m[1]; } get c() { return this.#m[4]; }
    get d() { return this.#m[5]; } get e() { return this.#m[12]; } get f() { return this.#m[13]; }
    get m11() { return this.#m[0]; } get m12() { return this.#m[1]; } get m13() { return this.#m[2]; } get m14() { return this.#m[3]; }
    get m21() { return this.#m[4]; } get m22() { return this.#m[5]; } get m23() { return this.#m[6]; } get m24() { return this.#m[7]; }
    get m31() { return this.#m[8]; } get m32() { return this.#m[9]; } get m33() { return this.#m[10]; } get m34() { return this.#m[11]; }
    get m41() { return this.#m[12]; } get m42() { return this.#m[13]; } get m43() { return this.#m[14]; } get m44() { return this.#m[15]; }
    get is2D() { return this.#is2D; }
    get isIdentity() { return this.#m.every((v, i) => v === IDENT[i]); }
    translate(tx = 0, ty = 0, tz = 0) { return new DOMMatrix(L.matGet(this).slice()).translateSelf(tx, ty, tz); }
    scale(sx = 1, sy, sz = 1, ox = 0, oy = 0, oz = 0) { return new DOMMatrix(L.matGet(this).slice()).scaleSelf(sx, sy, sz, ox, oy, oz); }
    scale3d(s = 1, ox = 0, oy = 0, oz = 0) { return this.scale(s, s, s, ox, oy, oz); }
    scaleNonUniform(sx = 1, sy = 1) { return this.scale(sx, sy); }
    rotate(rx = 0, ry, rz) { return new DOMMatrix(L.matGet(this).slice()).rotateSelf(rx, ry, rz); }
    rotateFromVector(x = 0, y = 0) { return this.rotate(Math.atan2(y, x) * 180 / Math.PI); }
    rotateAxisAngle(x = 0, y = 0, z = 0, angle = 0) { return new DOMMatrix(L.matGet(this).slice()).rotateAxisAngleSelf(x, y, z, angle); }
    skewX(sx = 0) { return new DOMMatrix(L.matGet(this).slice()).skewXSelf(sx); }
    skewY(sy = 0) { return new DOMMatrix(L.matGet(this).slice()).skewYSelf(sy); }
    multiply(other) { return new DOMMatrix(L.matGet(this).slice()).multiplySelf(other); }
    flipX() { return this.multiply(new DOMMatrix([-1, 0, 0, 1, 0, 0])); }
    flipY() { return this.multiply(new DOMMatrix([1, 0, 0, -1, 0, 0])); }
    inverse() { return new DOMMatrix(L.matGet(this).slice()).invertSelf(); }
    transformPoint(p) {
      p = p || {};
      const x = p.x || 0, y = p.y || 0, z = p.z || 0, w = p.w === undefined ? 1 : p.w;
      const m = this.#m;
      return new DOMPoint(m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w,
        m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w);
    }
    toFloat32Array() { return new Float32Array(this.#m); }
    toFloat64Array() { return new Float64Array(this.#m); }
    toJSON() {
      const o = { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f };
      for (const k of ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44']) o[k] = this[k];
      o.is2D = this.is2D; o.isIdentity = this.isIdentity;
      return o;
    }
    toString() {
      const m = this.#m;
      const f = (v) => String(+v.toFixed(6));
      if (this.#is2D) return `matrix(${[m[0], m[1], m[4], m[5], m[12], m[13]].map(f).join(', ')})`;
      return `matrix3d(${m.map(f).join(', ')})`;
    }
  }
  class DOMMatrix extends DOMMatrixReadOnly {
    multiplySelf(other) {
      const o = other instanceof DOMMatrixReadOnly ? other : DOMMatrixReadOnly.fromMatrix(other);
      L.matSet(this, matMul(L.matGet(this), L.matGet(o)), L.matIs2D(this) && L.matIs2D(o));
      return this;
    }
    preMultiplySelf(other) {
      const o = other instanceof DOMMatrixReadOnly ? other : DOMMatrixReadOnly.fromMatrix(other);
      L.matSet(this, matMul(L.matGet(o), L.matGet(this)), L.matIs2D(this) && L.matIs2D(o));
      return this;
    }
    translateSelf(tx = 0, ty = 0, tz = 0) {
      const t = IDENT.slice(); t[12] = +tx; t[13] = +ty; t[14] = +tz;
      L.matSet(this, matMul(L.matGet(this), t), L.matIs2D(this) && !tz);
      return this;
    }
    scaleSelf(sx = 1, sy, sz = 1, ox = 0, oy = 0, oz = 0) {
      if (sy === undefined) sy = sx;
      this.translateSelf(ox, oy, oz);
      const t = IDENT.slice(); t[0] = +sx; t[5] = +sy; t[10] = +sz;
      L.matSet(this, matMul(L.matGet(this), t), L.matIs2D(this) && +sz === 1);
      this.translateSelf(-ox, -oy, -oz);
      return this;
    }
    scale3dSelf(s = 1, ox = 0, oy = 0, oz = 0) { return this.scaleSelf(s, s, s, ox, oy, oz); }
    rotateSelf(rx = 0, ry, rz) {
      if (ry === undefined && rz === undefined) { rz = rx; rx = 0; ry = 0; }
      ry = ry || 0; rz = rz || 0;
      if (rz) this.rotateAxisAngleSelf(0, 0, 1, rz);
      if (ry) this.rotateAxisAngleSelf(0, 1, 0, ry);
      if (rx) this.rotateAxisAngleSelf(1, 0, 0, rx);
      return this;
    }
    rotateAxisAngleSelf(x = 0, y = 0, z = 0, angle = 0) {
      const len = Math.hypot(x, y, z);
      if (len === 0) return this;
      x /= len; y /= len; z /= len;
      const a = angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
      const r = [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
        t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
      L.matSet(this, matMul(L.matGet(this), r), L.matIs2D(this) && x === 0 && y === 0);
      return this;
    }
    skewXSelf(sx = 0) { const t = IDENT.slice(); t[4] = Math.tan(sx * Math.PI / 180); L.matSet(this, matMul(L.matGet(this), t)); return this; }
    skewYSelf(sy = 0) { const t = IDENT.slice(); t[1] = Math.tan(sy * Math.PI / 180); L.matSet(this, matMul(L.matGet(this), t)); return this; }
    invertSelf() {
      const m = L.matGet(this);
      const inv = new Array(16);
      inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
      inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
      inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
      inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
      inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
      inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
      inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
      inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
      inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
      inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
      inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
      inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
      inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
      inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
      inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
      inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
      const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
      if (det === 0) { L.matSet(this, new Array(16).fill(NaN), false); return this; }
      L.matSet(this, inv.map((v) => v / det));
      return this;
    }
    setMatrixValue(s) { const [m, is2D] = parseTransformList(s); L.matSet(this, m, is2D); return this; }
  }
  for (const [k, i] of [['a', 0], ['b', 1], ['c', 4], ['d', 5], ['e', 12], ['f', 13], ['m11', 0], ['m12', 1], ['m13', 2], ['m14', 3],
    ['m21', 4], ['m22', 5], ['m23', 6], ['m24', 7], ['m31', 8], ['m32', 9], ['m33', 10], ['m34', 11], ['m41', 12], ['m42', 13], ['m43', 14], ['m44', 15]]) {
    Object.defineProperty(DOMMatrix.prototype, k, {
      get() { return L.matGet(this)[i]; },
      set(v) { const m = L.matGet(this); m[i] = +v; if (i === 2 || i === 3 || (i >= 6 && i <= 11) || i === 14 || i === 15) { if (!(i === 10 && +v === 1) && !(i === 15 && +v === 1)) L.matSet(this, m, false); } },
      enumerable: true, configurable: true,
    });
  }

  // =======================================================================================
  // DOMImplementation / DOMParser / XMLSerializer (+ a small XML parser)
  // =======================================================================================
  function escHTML(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function newDocWrapper(backing, proto, contentType) {
    const w = Object.create(proto);
    L.stamp(w, backing, 9, '', HTML);
    L.registerDetachedDocument(w, backing, { main: false, contentType, url: 'about:blank' });
    return w;
  }
  function copyTagAttrs(src, tag, elId) {
    const m = new RegExp('<' + tag + '((?:\\s+[^\\s/>"\'=]+(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>]+))?)*)\\s*/?>', 'i').exec(src);
    if (!m) return;
    const re = /([^\s/>"'=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = re.exec(m[1])) !== null) {
      const v = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
      try { N.setAttr(elId, a[1].toLowerCase(), decodeEntities(v)); } catch (_) { /* ignore */ }
    }
  }
  const HEAD_TAGS = new Set(['title', 'meta', 'link', 'style', 'script', 'base', 'noscript', 'template']);
  function buildHTMLDocument(html, title) {
    if (typeof N.parseHTMLDocument === 'function') {
      let src = html;
      if (src === null) src = '<!DOCTYPE html><html><head>' + (title !== undefined ? '<title>' + escHTML(`${title}`) + '</title>' : '') + '</head><body></body></html>';
      return nativeCall(() => N.parseHTMLDocument(src));
    }
    const frag = N.createFragment();
    const htmlEl = N.createElement('html', ''), head = N.createElement('head', ''), body = N.createElement('body', '');
    N.appendChild(frag, htmlEl); N.appendChild(htmlEl, head); N.appendChild(htmlEl, body);
    if (html === null) {
      if (title !== undefined) {
        const t = N.createElement('title', '');
        N.appendChild(t, N.createText(`${title}`));
        N.appendChild(head, t);
      }
      return frag;
    }
    const src = `${html}`;
    copyTagAttrs(src, 'html', htmlEl);
    copyTagAttrs(src, 'body', body);
    const clean = (s) => s.replace(/<!doctype[^>]*>/gi, '').replace(/<\/?html(\s[^>]*)?>/gi, '').replace(/<\/?head(\s[^>]*)?>/gi, '');
    const bm = /<body[\s>/]/i.exec(src);
    if (bm) {
      const headPart = clean(src.slice(0, bm.index));
      let bodyPart = src.slice(bm.index).replace(/^<body[^>]*>/i, '');
      bodyPart = bodyPart.replace(/<\/body\s*>/i, '').replace(/<\/html\s*>/i, '');
      if (headPart.trim()) N.setInnerHTML(head, headPart);
      N.setInnerHTML(body, bodyPart);
    } else {
      N.setInnerHTML(body, clean(src));
      // leading metadata elements belong to <head>
      for (let c = N.firstChild(body); c !== 0;) {
        const next = N.nextSibling(c);
        const t = N.nodeType(c);
        if (t === 1 && HEAD_TAGS.has(N.localName(c))) { N.appendChild(head, c); c = next; continue; }
        if (t === 3 && /^[\t\n\f\r ]*$/.test(N.getText(c))) { c = next; continue; }
        if (t === 8) { c = next; continue; }
        break;
      }
    }
    return frag;
  }
  // kind: 'html' (parse string arg), 'html-empty' (title arg), 'xml' (empty)
  // kind 'html-bare': an HTML document without children (Document.cloneNode)
  L.createDetachedDocument = function (kind, arg, proto) {
    if (kind === 'html-bare') return newDocWrapper(N.createFragment(), proto || HTMLDocument.prototype, 'text/html');
    if (kind === 'html' || kind === 'html-empty') {
      const src = arg === null || arg === undefined ? '' : `${arg}`;
      const backing = kind === 'html' ? buildHTMLDocument(src) : buildHTMLDocument(null, arg);
      if (kind === 'html') extractTemplates(backing, src);
      ensureDoctype(backing, kind === 'html' ? parseDoctype(src) : ['html', '', '']);
      const w = newDocWrapper(backing, proto || HTMLDocument.prototype, 'text/html');
      treeChanged();
      return w;
    }
    const backing = N.createFragment();
    return newDocWrapper(backing, proto || XMLDocument.prototype, typeof arg === 'string' ? arg : 'application/xml');
  };

  const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  function decodeEntities(s, strict) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\uFFFD';
      }
      if (e in XML_ENTITIES) return XML_ENTITIES[e];
      if (e === 'nbsp') return '\u00A0';
      if (strict) throw new SyntaxError(`Entity '${e}' not defined`);
      return m;
    });
  }
  L.decodeEntities = decodeEntities;
  function parseXML(src, contentType) {
    const frag = N.createFragment();
    const stack = [{ id: frag, qn: null, ns: new Map([['xml', L.NS.XML], ['xmlns', L.NS.XMLNS]]), dflt: null }];
    const s = src;
    let i = 0, sawRoot = false;
    const n = s.length;
    const err = (msg) => { throw new SyntaxError(msg); };
    const cur = () => stack[stack.length - 1];
    while (i < n) {
      const c = s[i];
      if (c === '<') {
        if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i); if (e < 0) err('Unterminated processing instruction'); i = e + 2; continue; }
        if (s.startsWith('<!--', i)) {
          const e = s.indexOf('-->', i + 4);
          if (e < 0) err('Unterminated comment');
          N.appendChild(cur().id, N.createComment(s.slice(i + 4, e)));
          i = e + 3; continue;
        }
        if (s.startsWith('<![CDATA[', i)) {
          const e = s.indexOf(']]>', i);
          if (e < 0) err('Unterminated CDATA section');
          if (stack.length === 1) err('CDATA outside of the document element');
          const t = N.createText(s.slice(i + 9, e));
          L.makeWrapper(t, 4, CDATASection.prototype);
          N.appendChild(cur().id, t);
          i = e + 3; continue;
        }
        if (s.startsWith('<!DOCTYPE', i) || s.startsWith('<!doctype', i)) {
          let depth = 0, j = i + 9;
          for (; j < n; j++) { if (s[j] === '[') depth++; else if (s[j] === ']') depth--; else if (s[j] === '>' && depth <= 0) break; }
          i = j + 1; continue;
        }
        if (s[i + 1] === '/') {
          const m = /^<\/([^\s>]+)\s*>/.exec(s.slice(i, i + 256));
          if (!m) err('Malformed end tag');
          const top = cur();
          if (stack.length === 1 || top.qn !== m[1]) err(`Opening and ending tag mismatch: ${top.qn} and ${m[1]}`);
          stack.pop();
          i += m[0].length; continue;
        }
        const m = /^<([^\s/>!?]+)/.exec(s.slice(i, i + 512));
        if (!m) err('Malformed start tag');
        const qn = m[1];
        let j = i + m[0].length;
        const attrs = [];
        let selfClose = false;
        for (;;) {
          while (j < n && /\s/.test(s[j])) j++;
          if (s[j] === '/' && s[j + 1] === '>') { selfClose = true; j += 2; break; }
          if (s[j] === '>') { j++; break; }
          const am = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(s.slice(j, j + 65536));
          if (!am) err(`Malformed attribute in <${qn}>`);
          attrs.push([am[1], decodeEntities(am[3] !== undefined ? am[3] : am[4], true)]);
          j += am[0].length;
        }
        if (stack.length === 1 && sawRoot) err('Extra content at the end of the document');
        const parent = cur();
        const scope = { ns: new Map(parent.ns), dflt: parent.dflt };
        for (const [an, av] of attrs) {
          if (an === 'xmlns') scope.dflt = av === '' ? null : av;
          else if (an.startsWith('xmlns:')) scope.ns.set(an.slice(6), av);
        }
        const k = qn.indexOf(':');
        const prefix = k > 0 ? qn.slice(0, k) : null;
        const local = k > 0 ? qn.slice(k + 1) : qn;
        let nsURI = prefix === null ? scope.dflt : scope.ns.get(prefix);
        if (prefix !== null && nsURI === undefined) err(`Namespace prefix ${prefix} on ${local} is not defined`);
        if (nsURI === undefined) nsURI = null;
        const code = L.nsCode(nsURI);
        let id;
        if (code === SVG || code === MATHML) id = N.createElement(local, nsURI);
        else id = N.createElement(local, nsURI === null ? '' : nsURI);
        let w;
        if (code === SVG || code === MATHML) w = wrap(id);
        else if (code === HTML && contentType === 'application/xhtml+xml') w = wrap(id);
        else {
          w = L.wrapElementAs(id, code === HTML ? L.elementProtoFor(local, HTML) : Element.prototype, local, code === HTML ? HTML : code);
          if (code === OTHER) elementNsOther.set(w, nsURI);
        }
        if (prefix !== null) { elementPrefix.set(w, prefix); prefixedElements++; }
        for (const [an, av] of attrs) N.setAttr(id, an, av);
        N.appendChild(parent.id, id);
        if (stack.length === 1) sawRoot = true;
        if (!selfClose) stack.push({ id, qn, ns: scope.ns, dflt: scope.dflt });
        i = j;
        continue;
      }
      const e = s.indexOf('<', i);
      const end = e < 0 ? n : e;
      const text = s.slice(i, end);
      if (stack.length === 1) {
        if (/[^\t\n\r ]/.test(text)) err(sawRoot ? 'Extra content at the end of the document' : 'Start tag expected');
      } else {
        N.appendChild(cur().id, N.createText(decodeEntities(text, true)));
      }
      i = end;
    }
    if (stack.length > 1) err(`Premature end of data in tag ${cur().qn}`);
    if (!sawRoot) err('Document is empty');
    return frag;
  }
  function xmlErrorDocument(msg, contentType) {
    const frag = N.createFragment();
    const pe = N.createElement('parsererror', '');
    N.setAttr(pe, 'style', 'display: block; white-space: pre; border: 2px solid #c77; padding: 0 1em 0 1em; margin: 1em; background-color: #fdd; color: black');
    const h3 = N.createElement('h3', '');
    N.appendChild(h3, N.createText('This page contains the following errors:'));
    const div = N.createElement('div', '');
    N.appendChild(div, N.createText(msg));
    N.appendChild(pe, h3); N.appendChild(pe, div);
    N.appendChild(frag, pe);
    L.wrapElementAs(pe, Element.prototype, 'parsererror', NONE);
    return frag;
  }
  class DOMParser {
    parseFromString(string, type) {
      const t = `${type}`;
      const s = `${string}`;
      if (t === 'text/html') {
        const d = L.createDetachedDocument('html', s);
        return d;
      }
      if (t === 'text/xml' || t === 'application/xml' || t === 'application/xhtml+xml' || t === 'image/svg+xml') {
        let backing;
        try { backing = parseXML(s, t); } catch (e) { backing = xmlErrorDocument(e && e.message ? e.message : String(e), t); }
        const w = Object.create(XMLDocument.prototype);
        L.stamp(w, backing, 9, '', HTML);
        L.registerDetachedDocument(w, backing, { main: false, contentType: t, url: 'about:blank' });
        treeChanged();
        return w;
      }
      throw new TypeError(`Failed to execute 'parseFromString' on 'DOMParser': The provided value '${t}' is not a valid enum value of type DOMParserSupportedType.`);
    }
  }
  L.parseXMLDocument = function (text, contentType) {
    try {
      const backing = parseXML(text, contentType || 'application/xml');
      const w = Object.create(XMLDocument.prototype);
      L.stamp(w, backing, 9, '', HTML);
      L.registerDetachedDocument(w, backing, { main: false, contentType: contentType || 'application/xml', url: 'about:blank' });
      return w;
    } catch (_) {
      return null;
    }
  };

  const VOID_ELEMENTS = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img',
    'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  L.VOID_ELEMENTS = VOID_ELEMENTS;
  function xmlEscText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function xmlEscAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;'); }
  function xmlSerialize(w, inheritedNs) {
    const t = typeOf(w);
    const id = idOf(w);
    switch (t) {
      case 1: {
        const nsURI = w.namespaceURI;
        const prefix = elementPrefix.get(w) || null;
        const ln = lnOf(w);
        const qn = prefix ? prefix + ':' + ln : ln;
        let out = '<' + qn;
        const names = N.attrNames(id);
        let declared = inheritedNs;
        if (nsURI !== inheritedNs && prefix === null) {
          if (!names.includes('xmlns')) {
            if (nsURI === null) { if (inheritedNs !== null) out += ' xmlns=""'; } else out += ' xmlns="' + xmlEscAttr(nsURI) + '"';
          }
          declared = nsURI;
        }
        for (const a of names) out += ' ' + a + '="' + xmlEscAttr(N.getAttr(id, a) || '') + '"';
        const kids = ln === 'template' && nsOf(w) === HTML && L.templateInfo !== null ? N.childIds(L.templateInfo(w)) : N.childIds(id);
        if (kids.length === 0) {
          if (nsOf(w) === HTML && !VOID_ELEMENTS.has(ln)) return out + '></' + qn + '>';
          return out + ' />';
        }
        out += '>';
        for (const k of kids) out += xmlSerialize(wrap(k), declared);
        return out + '</' + qn + '>';
      }
      case 3: return xmlEscText(N.getText(id));
      case 4: return '<![CDATA[' + N.getText(id) + ']]>';
      case 8: return '<!--' + N.getText(id) + '-->';
      case 7: return '<?' + (piTarget.get(w) || '') + ' ' + N.getText(id) + '?>';
      case 10: return '<!DOCTYPE ' + (w.name || 'html') + '>';
      case 9: case 11: {
        let out = '';
        for (const k of N.childIds(id)) out += xmlSerialize(wrap(k), inheritedNs);
        return out;
      }
      default: return '';
    }
  }
  class XMLSerializer {
    serializeToString(root) {
      if (L.isAttr(root)) return root.value;
      L.nodeArg(root, 'serializeToString', 1);
      return xmlSerialize(root, typeOf(root) === 1 ? null : null);
    }
  }
  L.xmlSerialize = xmlSerialize;

  const doctypeInfo = new WeakMap();
  // DocumentType nodes are comment-backed natively (the Rust DOM has no doctype nodes:
  // blitz-html drops them while parsing), typed 10 by the JS stamp.
  function makeDoctype(name, publicId, systemId) {
    const id = N.createComment('');
    const w = Object.create(DocumentType.prototype);
    L.stamp(w, id, 10, '', HTML);
    cache.set(id, w);
    doctypeInfo.set(w, { name, publicId, systemId });
    return w;
  }
  // [name, publicId, systemId] of a leading <!DOCTYPE ...> in markup, or null
  const DOCTYPE_RE = /^\uFEFF?(?:[\t\n\f\r ]|<!--[\s\S]*?-->)*<!doctype([^>]*)>/i;
  function parseDoctype(src) {
    const m = DOCTYPE_RE.exec(src);
    if (m === null) return null;
    const body = m[1];
    const nm = /^[\t\n\f\r ]*([^\t\n\f\r >]*)/.exec(body);
    const rest = body.slice(nm[0].length);
    let publicId = '', systemId = '';
    const q = '("([^"]*)"|\'([^\']*)\')';
    const pm = new RegExp('^[\\t\\n\\f\\r ]*public[\\t\\n\\f\\r ]*' + q + '(?:[\\t\\n\\f\\r ]*' + q + ')?', 'i').exec(rest);
    if (pm !== null) {
      publicId = pm[2] !== undefined ? pm[2] : pm[3];
      if (pm[4] !== undefined) systemId = pm[5] !== undefined ? pm[5] : pm[6];
    } else {
      const sm = new RegExp('^[\\t\\n\\f\\r ]*system[\\t\\n\\f\\r ]*' + q, 'i').exec(rest);
      if (sm !== null) systemId = sm[2] !== undefined ? sm[2] : sm[3];
    }
    return [L.asciiLower(nm[1]), publicId, systemId];
  }
  L.parseDoctype = parseDoctype;
  L.copyDoctypeInfo = function (from, to) { const i = doctypeInfo.get(from); if (i !== undefined) doctypeInfo.set(to, Object.assign({}, i)); };
  // Give the document (backing id) a leading DocumentType unless it already has one.
  function ensureDoctype(backingId, dt) {
    if (dt === null || dt === undefined) return;
    const info = { name: `${dt[0]}`, publicId: dt[1] === undefined ? '' : `${dt[1]}`, systemId: dt[2] === undefined ? '' : `${dt[2]}` };
    for (let c = N.firstChild(backingId); c !== 0; c = N.nextSibling(c)) {
      const t = N.nodeType(c);
      const cw = cache.get(c);
      if (t === 10) { // a native doctype node (natives that keep them): only the ids are unknown
        const w = cw !== undefined ? cw : wrap(c);
        if (!doctypeInfo.has(w)) doctypeInfo.set(w, info);
        return;
      }
      if (cw !== undefined && typeOf(cw) === 10) return;
      if (t === 1) break;
    }
    const w = makeDoctype(info.name, info.publicId, info.systemId);
    N.insertBefore(backingId, idOf(w), N.firstChild(backingId));
    treeChanged();
  }
  L.ensureDoctype = ensureDoctype;
  L.mixin(DocumentType.prototype, {
    get name() { const i = doctypeInfo.get(this); return i ? i.name : 'html'; },
    get publicId() { const i = doctypeInfo.get(this); return i ? i.publicId : ''; },
    get systemId() { const i = doctypeInfo.get(this); return i ? i.systemId : ''; },
  });
  class DOMImplementation {
    #doc;
    constructor(token, doc) { if (token !== INTERNAL) throw L.illegal(); this.#doc = doc; }
    createDocumentType(qualifiedName, publicId, systemId) {
      const qn = `${qualifiedName}`;
      // A valid doctype name: no ASCII whitespace, NUL or '>' (the empty name is valid).
      if (/[\t\n\f\r \0>]/.test(qn)) throw invalidChar(`Failed to execute 'createDocumentType' on 'DOMImplementation': The qualified name provided ('${qn}') contains an invalid character.`);
      return makeDoctype(qn, `${publicId}`, `${systemId}`);
    }
    createDocument(namespace, qualifiedName, doctype = null) {
      const ns = namespace === null || namespace === undefined || namespace === '' ? null : `${namespace}`;
      const ct = ns === L.NS.HTML ? 'application/xhtml+xml' : ns === L.NS.SVG ? 'image/svg+xml' : 'application/xml';
      const d = L.createDetachedDocument('xml', ct, XMLDocument.prototype);
      if (doctype !== null && doctype !== undefined) preInsert(d, doctype, null, 'createDocument');
      const qn = qualifiedName === null || qualifiedName === undefined ? '' : `${qualifiedName}`;
      if (qn !== '') {
        const el = Document.prototype.createElementNS.call(d, ns, qn);
        preInsert(d, el, null, 'createDocument');
      }
      return d;
    }
    createHTMLDocument(title) {
      return L.createDetachedDocument('html-empty', title);
    }
    hasFeature() { return true; }
  }

  // =======================================================================================
  // Exposure
  // =======================================================================================
  const exposedDom = {
    Node, Element, CharacterData, Text, CDATASection, Comment, ProcessingInstruction, DocumentType,
    DocumentFragment, ShadowRoot, Document, HTMLDocument, XMLDocument, Attr, NamedNodeMap, NodeList,
    HTMLCollection, DOMTokenList, DOMStringMap, CSSStyleDeclaration, StyleSheet, CSSStyleSheet, CSSRule,
    CSSStyleRule, CSSGroupingRule, CSSConditionRule, CSSMediaRule, CSSSupportsRule, CSSContainerRule,
    CSSLayerBlockRule, CSSLayerStatementRule, CSSImportRule, CSSFontFaceRule, CSSKeyframesRule, CSSKeyframeRule,
    CSSNamespaceRule, CSSPageRule, CSSCounterStyleRule, CSSPropertyRule, CSSRuleList, StyleSheetList, MediaList,
    MutationObserver, MutationRecord, CustomElementRegistry, NodeFilter, TreeWalker, NodeIterator, AbstractRange,
    Range, StaticRange, Selection, DOMRectReadOnly, DOMRect, DOMRectList, DOMPointReadOnly, DOMPoint, DOMQuad,
    DOMMatrixReadOnly, DOMMatrix, DOMImplementation, DOMParser, XMLSerializer,
  };
  for (const k in exposedDom) L.expose(k, exposedDom[k]);
  L.expose('WebKitCSSMatrix', DOMMatrix);
  L.expose('WebKitMutationObserver', MutationObserver);
  Object.assign(L, exposedDom);

  L.dom2 = { Node, Element, Document, HTMLDocument, XMLDocument, DocumentFragment, ShadowRoot, Text, Comment,
    CharacterData, ProcessingInstruction, CDATASection, DocumentType, Attr, NodeList, HTMLCollection,
    DOMTokenList, DOMStringMap, NamedNodeMap };
})(globalThis.__layer);
