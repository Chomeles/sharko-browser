// 90_bootstrap.js — creates the window/document globals, the script execution model,
// document.write, error reporting, registers the native hooks and finally hides `__layer`.
(function (L) {
  'use strict';
  const N = L.N;
  const g = L.global;
  const DOMException = L.DOMException;
  const EventTarget = L.EventTarget;
  const INTERNAL = L.INTERNAL;
  const idOf = L.idOf, typeOf = L.typeOf, lnOf = L.lnOf, isNode = L.isNode, wrap = L.wrap;
  const document = L.document;
  const docId = L.documentId;

  // =======================================================================================
  // Window
  // =======================================================================================
  class Window extends EventTarget {
    constructor() { throw L.illegal(); }
  }
  L.window = g;
  // WindowProperties: named access to elements by id (window.myId)
  const namedPropsTarget = Object.create(EventTarget.prototype);
  const NAMED_SEL_CACHE = new Map();
  const INDEX_RE = /^(0|[1-9][0-9]{0,8})$/;
  function namedWindowProp(name) {
    if (name === '' || name.length > 256) return undefined;
    if (INDEX_RE.test(name)) {
      const f = L.childFrames()[+name];
      return f === undefined ? undefined : L.remoteWindowFor(f);
    }
    let id = 0;
    // A child browsing context with that name comes first (window.frames['__tcfapiLocator']).
    try { id = N.querySelector(docId, `iframe[name=${L.cssString(name)}],frame[name=${L.cssString(name)}]`); } catch (_) { id = 0; }
    if (id !== 0 && !notYetParsed(id)) return L.remoteWindowFor(id);
    try { id = N.getElementById(name); } catch (_) { id = 0; }
    if (id !== 0 && notYetParsed(id)) id = 0;
    if (id !== 0) return wrap(id);
    let sel = NAMED_SEL_CACHE.get(name);
    if (sel === undefined) {
      const v = L.cssString(name);
      sel = ['embed', 'form', 'img', 'object', 'iframe', 'frame', 'frameset'].map((t) => `${t}[name=${v}]`).join(',');
      if (NAMED_SEL_CACHE.size > 500) NAMED_SEL_CACHE.clear();
      NAMED_SEL_CACHE.set(name, sel);
    }
    try { id = N.querySelector(docId, sel); } catch (_) { id = 0; }
    if (id !== 0 && notYetParsed(id)) id = 0;
    return id === 0 ? undefined : wrap(id);
  }
  // The whole document is parsed before scripts run. While a parser-blocking script
  // runs, parser-created elements after its insertion point would not exist yet in a
  // browser: named access must not find them (`window.cfg = window.cfg || {}` next to a
  // later `<script id=cfg>` would keep the element). Elements created later have higher
  // ids than any parser-created one.
  let parserMaxNodeId = 0;
  function notYetParsed(id) {
    try {
      if (id > parserMaxNodeId || inParserScript === null || writeState === null) return false;
      const pos = N.compareDocumentPosition(writeState.anchor, id);
      return (pos & 4) !== 0 && (pos & 16) === 0;
    } catch (_) { return false; }
  }
  const WindowProperties = new Proxy(namedPropsTarget, {
    get(t, p, r) {
      if (typeof p === 'string' && !(p in t)) {
        const v = namedWindowProp(p);
        if (v !== undefined) return v;
      }
      return Reflect.get(t, p, r);
    },
    has(t, p) {
      if (Reflect.has(t, p)) return true;
      return typeof p === 'string' && namedWindowProp(p) !== undefined;
    },
  });
  Object.setPrototypeOf(Window.prototype, WindowProperties);
  let protoOK = true;
  try { Object.setPrototypeOf(g, Window.prototype); } catch (_) { protoOK = false; }
  if (!protoOK || Object.getPrototypeOf(g) !== Window.prototype) {
    // Fallback: make EventTarget methods available as own properties
    for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
      Object.defineProperty(g, k, { value: EventTarget.prototype[k], writable: true, enumerable: true, configurable: true });
    }
    Object.defineProperty(g, Symbol.toStringTag, { value: 'Window', configurable: true });
  }
  Object.defineProperty(Window.prototype, Symbol.toStringTag, { value: 'Window', configurable: true });
  L.expose('Window', Window);

  // Install interface objects (constructors) as non-enumerable globals
  for (const [name, value] of L.exposed) {
    Object.defineProperty(g, name, { value, writable: true, enumerable: false, configurable: true });
  }

  // --- own properties of the global object ---
  function defGetter(name, get, opts) {
    const o = opts || {};
    const desc = { get, enumerable: true, configurable: !o.unforgeable };
    if (o.set) desc.set = o.set;
    else if (o.replaceable) desc.set = function (v) { Object.defineProperty(g, name, { value: v, writable: true, enumerable: true, configurable: true }); };
    Object.defineProperty(g, name, desc);
  }
  function defMethod(name, fn) {
    Object.defineProperty(g, name, { value: fn, writable: true, enumerable: true, configurable: true });
  }
  defGetter('window', function window() { return g; }, { unforgeable: true });
  defGetter('self', function self() { return g; }, { replaceable: true });
  defGetter('frames', function frames() { return g; }, { replaceable: true });
  defGetter('parent', function parent() { return L.parentWindow(); }, { replaceable: true });
  defGetter('top', function top() { return L.windowTop(); }, { unforgeable: true });
  defGetter('document', function document_() { return document; }, { unforgeable: true });
  Object.defineProperty(g, 'location', {
    get: function location() { return L.location; },
    set: function location(v) { L.location.href = v; },
    enumerable: true, configurable: false,
  });
  defGetter('history', () => L.history);
  defGetter('navigator', () => L.navigator);
  defGetter('clientInformation', () => L.navigator, { replaceable: true });
  defGetter('screen', () => L.screen, { replaceable: true });
  defGetter('customElements', () => L.customElements);
  defGetter('localStorage', () => L.localStorage);
  defGetter('sessionStorage', () => L.sessionStorage);
  defGetter('performance', () => L.performance, { replaceable: true });
  defGetter('crypto', () => L.crypto);
  defGetter('visualViewport', () => L.visualViewport, { replaceable: true });
  defGetter('event', () => L.currentEvent, { replaceable: true });
  defGetter('origin', () => L.location.origin, { replaceable: true });
  defGetter('isSecureContext', () => {
    const p = N.urlParse(L.documentURL(), null);
    if (p === null) return false;
    if (p[1] === 'https:' || p[1] === 'wss:' || p[1] === 'file:') return true;
    const h = p[5];
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
  });
  defGetter('crossOriginIsolated', () => false);
  defGetter('originAgentCluster', () => false);
  defGetter('closed', () => false);
  defGetter('length', () => L.childFrames().length, { replaceable: true });
  defGetter('opener', () => null, { replaceable: true });
  // The <iframe> in the parent realm hosting this window (null at the top
  // or across origins).
  defGetter('frameElement', () => {
    if (typeof N.frameElement !== 'function') return null;
    try { return N.frameElement() ?? null; } catch (_) { return null; }
  });
  let windowName = null; // read from the host on first use (not while snapshotting)
  const getWindowName = () => {
    if (windowName === null) {
      try { windowName = N.initialWindowName(); } catch (_) { windowName = ''; }
    }
    return windowName;
  };
  defGetter('name', getWindowName, { set(v) { windowName = `${v}`; } });
  let windowStatus = '';
  defGetter('status', () => windowStatus, { set(v) { windowStatus = `${v}`; } });
  const vp = () => N.viewport();
  defGetter('innerWidth', () => vp()[0], { replaceable: true });
  defGetter('innerHeight', () => vp()[1], { replaceable: true });
  defGetter('outerWidth', () => vp()[0], { replaceable: true });
  defGetter('outerHeight', () => vp()[1] + 85, { replaceable: true });
  defGetter('devicePixelRatio', () => vp()[2], { replaceable: true });
  defGetter('scrollX', () => vp()[3], { replaceable: true });
  defGetter('scrollY', () => vp()[4], { replaceable: true });
  defGetter('pageXOffset', () => vp()[3], { replaceable: true });
  defGetter('pageYOffset', () => vp()[4], { replaceable: true });
  defGetter('screenX', () => 0, { replaceable: true });
  defGetter('screenY', () => 0, { replaceable: true });
  defGetter('screenLeft', () => 0, { replaceable: true });
  defGetter('screenTop', () => 0, { replaceable: true });
  class BarProp {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get visible() { return true; }
  }
  const barProp = new BarProp(INTERNAL);
  for (const b of ['locationbar', 'menubar', 'personalbar', 'scrollbars', 'statusbar', 'toolbar']) defGetter(b, () => barProp, { replaceable: true });
  L.expose('BarProp', BarProp);
  Object.defineProperty(g, 'BarProp', { value: BarProp, writable: true, enumerable: false, configurable: true });
  const external = { AddSearchProvider() { }, IsSearchProviderInstalled() { return 0; } };
  defGetter('external', () => external, { replaceable: true });
  Object.defineProperty(g, 'console', { value: L.console, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(g, 'CSS', { value: L.CSS, writable: true, enumerable: false, configurable: true });

  for (const [k, fn] of Object.entries(L.windowFunctions)) defMethod(k, fn);
  defMethod('reportError', function reportError(e) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'reportError' on 'Window': 1 argument required, but only 0 present.");
    L.reportException(e);
  });
  // The native itself (an API function): V8 then knows the calling realm, so a message
  // from another frame's script has that frame as its source (see hook windowPostMessage).
  const postMessageFn = typeof N.windowPostMessage === 'function'
    ? N.windowPostMessage
    : function postMessage(message, targetOrigin, transfer) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.");
      L.windowPostMessage(message, targetOrigin, transfer, null);
    };
  Object.defineProperty(postMessageFn, 'name', { value: 'postMessage', configurable: true });
  Object.defineProperty(postMessageFn, 'length', { value: 1, configurable: true });
  defMethod('postMessage', postMessageFn);
  defMethod('getSelection', function getSelection() { return L.getSelection(); });
  function scrollArgs(a, b, relative) {
    const v = N.viewport();
    let x, y;
    if (a !== null && typeof a === 'object') {
      x = a.left === undefined ? (relative ? 0 : v[3]) : Number(a.left) || 0;
      y = a.top === undefined ? (relative ? 0 : v[4]) : Number(a.top) || 0;
    } else {
      x = Number(a) || 0;
      y = Number(b) || 0;
    }
    if (relative) { x += v[3]; y += v[4]; }
    N.scrollTo(x, y);
  }
  defMethod('scroll', function scroll(a, b) { scrollArgs(a, b, false); });
  defMethod('scrollTo', function scrollTo(a, b) { scrollArgs(a, b, false); });
  defMethod('scrollBy', function scrollBy(a, b) { scrollArgs(a, b, true); });
  for (const k of ['moveTo', 'moveBy', 'resizeTo', 'resizeBy', 'print', 'stop', 'focus', 'blur', 'close', 'captureEvents', 'releaseEvents']) {
    defMethod(k, { [k]() { } }[k]);
  }
  defMethod('find', function find() { return false; });
  defMethod('alert', function alert(message) { L.log('info', '[alert] ' + (message === undefined ? '' : `${message}`)); });
  defMethod('confirm', function confirm(message) { L.log('info', '[confirm] ' + (message === undefined ? '' : `${message}`)); return false; });
  defMethod('prompt', function prompt(message, def) { L.log('info', '[prompt] ' + (message === undefined ? '' : `${message}`)); return null; });
  defMethod('open', function open(url, target, features) {
    const u = url === undefined || url === null || `${url}` === '' ? 'about:blank' : `${url}`;
    const p = N.urlParse(u, L.baseURL());
    if (p === null) throw new DOMException(`Failed to execute 'open' on 'Window': Unable to open a window with invalid URL '${u}'.`, 'SyntaxError');
    const t = target === undefined || target === null || `${target}` === '' ? '_blank' : `${target}`;
    if (t === '_self' || t === '_top' || t === '_parent' || (getWindowName() !== '' && t === getWindowName())) {
      if (p[1] === 'javascript:') { L.postTask(() => L.runJavascriptURL(p[0])); return g; }
      N.navigate(p[0], false);
      return g;
    }
    if (typeof N.openWindow === 'function') {
      try { N.openWindow(p[0], t, features === undefined ? '' : `${features}`); } catch (_) { /* ignore */ }
    }
    return null;
  });
  defMethod('createImageBitmap', function createImageBitmap() {
    return L.rejectedPromise(new DOMException("Failed to execute 'createImageBitmap' on 'Window': not supported", 'InvalidStateError'));
  });
  L.defineEventHandlers(g, L.GLOBAL_HANDLERS.concat(L.WINDOW_HANDLERS), () => g);

  // =======================================================================================
  // Error reporting
  // =======================================================================================
  const STACK_LOC_RE = /((?:https?|file|blob|data|about|chrome-extension):[^\s()]*?):(\d+):(\d+)\)?\s*$/m;
  function errorLocation(err) {
    try {
      const st = err !== null && typeof err === 'object' ? err.stack : undefined;
      if (typeof st === 'string') {
        for (const line of st.split('\n').slice(1)) {
          const m = STACK_LOC_RE.exec(line);
          if (m) return { filename: m[1], lineno: +m[2], colno: +m[3] };
        }
      }
    } catch (_) { /* ignore */ }
    return { filename: L.documentURL(), lineno: 0, colno: 0 };
  }
  function errorMessage(err) {
    try {
      if (err !== null && typeof err === 'object' && 'message' in err && 'name' in err) return `Uncaught ${err.name}: ${err.message}`;
      return 'Uncaught ' + String(err);
    } catch (_) {
      return 'Uncaught exception';
    }
  }
  let reporting = 0;
  L.reportException = function (err, opts) {
    const logged = !!(opts && opts.logged);
    if (reporting > 2) { if (!logged) L.log('error', 'Uncaught ' + L.errToString(err)); return; }
    reporting++;
    try {
      const loc = opts && opts.filename ? opts : errorLocation(err);
      const ev = new L.ErrorEvent('error', {
        message: opts && opts.message ? opts.message : errorMessage(err),
        filename: loc.filename, lineno: loc.lineno | 0, colno: loc.colno | 0, error: err,
        cancelable: true, bubbles: false,
      });
      const notCanceled = L.dispatch(g, ev, true);
      if (notCanceled && !logged) L.log('error', 'Uncaught ' + L.errToString(err));
    } catch (e2) {
      L.log('error', 'Uncaught ' + L.errToString(err));
    } finally {
      reporting--;
    }
  };
  L.report = L.reportException;
  L.reportScriptError = function (err) { L.reportException(err, { logged: true }); };

  // =======================================================================================
  // Script execution model
  // =======================================================================================
  L.readyState = 'loading';
  L.currentScript = null;
  L.visibilityState = 'visible';
  // Page-specific values are read lazily (document getters): the layer runs once and is
  // snapshotted by Rust, so it must not call Date.now()/Math.random()/page natives at load.
  L.referrer = undefined;
  L.lastModified = 0;

  const JS_MIME = new Set(['application/ecmascript', 'application/javascript', 'application/x-ecmascript',
    'application/x-javascript', 'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1',
    'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript',
    'text/livescript', 'text/x-ecmascript', 'text/x-javascript']);
  function scriptType(id) {
    let t = N.getAttr(id, 'type');
    if (t === null || t === '') {
      const lang = N.getAttr(id, 'language');
      if (t === null && lang !== null && lang !== '') t = 'text/' + lang;
      else return 'classic';
    }
    t = L.stripWS(t).toLowerCase();
    if (JS_MIME.has(t)) return 'classic';
    if (t === 'module') return 'module';
    if (t === 'importmap') return 'importmap';
    return null;
  }
  function scriptSrc(id) {
    const src = N.getAttr(id, 'src');
    if (src !== null) return src;
    if (N.namespaceURI(id) === L.NS.SVG) {
      const h = N.getAttr(id, 'href');
      if (h !== null) return h;
      return N.getAttr(id, 'xlink:href');
    }
    return null;
  }
  function childText(id) {
    let s = '';
    for (let c = N.firstChild(id); c !== 0; c = N.nextSibling(c)) if (N.nodeType(c) === 3) s += N.getText(c);
    return s;
  }
  function decodeScript(body, flat, el) {
    if (body === null || body === undefined) return '';
    let enc = 'utf-8';
    for (let i = 0; i + 1 < (flat || []).length; i += 2) {
      if (`${flat[i]}`.toLowerCase() === 'content-type') {
        const m = /charset=([^;]+)/i.exec(`${flat[i + 1]}`);
        if (m) enc = L.resolveEncoding(m[1].replace(/"/g, '').trim()) || enc;
      }
    }
    if (enc === 'utf-8' && el) {
      const cs = N.getAttr(idOf(el), 'charset');
      if (cs) enc = L.resolveEncoding(cs) || enc;
    }
    let s;
    try { s = N.textDecode(body, enc, false); } catch (_) { s = L.utf8Decode(new Uint8Array(body)); }
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  }
  function startScriptFetch(rec, done) {
    const co = N.getAttr(rec.id, 'crossorigin');
    // no-cors classic scripts and crossorigin=use-credentials send credentials; anonymous CORS is same-origin only
    const credentials = co === null || co.toLowerCase() === 'use-credentials' ? 'include' : 'same-origin';
    L.startNativeFetch('GET', rec.url, [], null, co !== null ? 'cors' : 'no-cors', (status, statusText, finalUrl, flat, body, error) => {
      if ((error !== null && error !== undefined) || !(status >= 200 && status < 300)) {
        rec.state = 'error';
      } else {
        rec.source = decodeScript(body, flat, rec.el);
        rec.state = 'ready';
      }
      done(rec);
    }, credentials);
  }
  function makeRecord(id, parser) {
    const type = scriptType(id);
    if (type === null || type === 'importmap') return null;
    if (type === 'classic' && N.hasAttr(id, 'nomodule')) return null;
    const el = wrap(id);
    const src = scriptSrc(id);
    const rec = { id, el, type, external: src !== null, url: null, source: null, state: 'ready', parser,
      async: N.hasAttr(id, 'async'), defer: N.hasAttr(id, 'defer') };
    if (rec.external) {
      const u = src === '' ? null : L.resolveURL(src);
      if (u === null) { rec.state = 'error'; rec.url = ''; return rec; }
      rec.url = u;
      rec.state = 'pending';
    } else {
      rec.source = childText(id);
    }
    return rec;
  }

  let inParserScript = null;       // record of the executing parser-blocking script
  let inNonBlockingScript = 0;     // depth of async/defer script execution
  let parserQueue = [];            // parser-blocking scripts in order
  const deferQueue = [];           // defer classic + non-async module scripts
  let asyncPending = 0;            // scripts delaying the load event
  let parsingFinished = false, deferredDone = false, dclFired = false, loadQueued = false;
  let inlineModuleCounter = 0;
  L.milestones.domLoading = 0;

  function fireScriptEvent(el, type) {
    L.fire(el, type, { bubbles: false, cancelable: false });
  }
  // <body onload=...> etc. are window event handlers registered when the parser reaches
  // <body>: after listeners added by scripts in <head>, before those of scripts in <body>.
  let bodyHandlersRegistered = false;
  function registerBodyHandlers(beforeScriptId) {
    if (bodyHandlersRegistered) return;
    const b = L.bodyId();
    if (b === 0) return;
    if (beforeScriptId !== undefined && !(N.compareDocumentPosition(b, beforeScriptId) & 4)) return;
    bodyHandlersRegistered = true;
    const bw = wrap(b);
    for (const name of N.attrNames(b)) {
      if (name.startsWith('on') && L.BODY_FORWARDED.includes(name)) L.handlerAttrChanged(bw, name, N.getAttr(b, name));
    }
  }
  function execClassic(rec, mode) {
    // mode: 'parser' | 'nonblocking' | 'dynamic'
    if (mode === 'parser' && !bodyHandlersRegistered) registerBodyHandlers(rec.id);
    const prevScript = L.currentScript;
    const prevParser = inParserScript;
    const prevWrite = writeState;
    L.currentScript = rec.el;
    if (mode === 'parser') { inParserScript = rec; writeState = { anchor: rec.id, stack: [] }; }
    // HTML "ignore-destructive-writes counter": while any external script without an
    // insertion point runs (async/defer, or inserted by another script, e.g. an ad
    // loader), document.write() must not implicitly reopen and wipe the document.
    const ignoresWrites = mode === 'nonblocking' || (mode === 'dynamic' && rec.external);
    if (ignoresWrites) inNonBlockingScript++;
    try {
      N.evalScript(rec.source === null ? '' : rec.source, rec.external ? rec.url : L.documentURL(), !rec.external);
    } catch (e) {
      L.reportScriptError(e);
    } finally {
      L.currentScript = prevScript;
      if (mode === 'parser') { inParserScript = prevParser; lastParserAnchor = writeState.anchor; writeState = prevWrite; }
      if (ignoresWrites) inNonBlockingScript--;
    }
    if (rec.external) fireScriptEvent(rec.el, 'load');
  }
  function runModuleRecord(rec) {
    let url, source = null;
    if (rec.external) url = rec.url;
    else { url = L.documentURL().split('#')[0] + '#inline-module-' + (++inlineModuleCounter); source = rec.source; }
    let p;
    try { p = N.runModule(url, source); } catch (e) { p = L.rejectedPromise(e); }
    return L.resolvedPromise(p).then(() => {
      if (rec.external) fireScriptEvent(rec.el, 'load');
    }, (e) => {
      L.reportException(e);
      fireScriptEvent(rec.el, 'error');
    });
  }

  let parserSeq = 0;               // document order of parser-inserted scripts
  const asyncWaiting = [];         // fetched async scripts the parser has not reached yet
  function asyncMayRun(rec) {
    return rec.seq === undefined || parsingFinished || parserQueue.length === 0 || parserQueue[0].seq > rec.seq;
  }
  function releaseAsync() {
    for (let i = 0; i < asyncWaiting.length;) {
      const w = asyncWaiting[i];
      if (asyncMayRun(w.rec)) { asyncWaiting.splice(i, 1); L.postTask(w.run); } else i++;
    }
  }
  // Parser-blocking scripts written (document.write) during the current parser step,
  // already queued ahead of the rest: later writes queue behind them (two written
  // `<script src>`s ran in reverse order when the second one arrived first).
  let writtenQueued = 0;
  function pumpParser() {
    if (parserQueue.length === 0) { finishParsing(); return; }
    const rec = parserQueue[0];
    if (rec.state === 'pending') return;
    parserQueue.shift();
    writtenQueued = 0;
    if (asyncWaiting.length) releaseAsync();
    L.internalTimeout(pumpParser, 0); // next parser step runs in its own task
    if (rec.state === 'error') { fireScriptEvent(rec.el, 'error'); return; }
    if (rec.type === 'module') { deferQueue.push(rec); return; }
    execClassic(rec, 'parser');
  }
  function finishParsing() {
    if (parsingFinished) return;
    parsingFinished = true;
    if (asyncWaiting.length) releaseAsync();
    registerBodyHandlers();
    L.milestones.domInteractive = N.now();
    setReadyState('interactive');
    runDeferred();
  }
  let deferRunning = false;
  function runDeferred() {
    if (deferredDone || deferRunning) return;
    if (deferQueue.length === 0) {
      deferredDone = true;
      fireDOMContentLoaded();
      return;
    }
    const rec = deferQueue[0];
    if (rec.type === 'module') {
      deferQueue.shift();
      deferRunning = true;
      runModuleRecord(rec).then(() => { deferRunning = false; L.internalTimeout(runDeferred, 0); });
      return;
    }
    if (rec.state === 'pending') return;
    deferQueue.shift();
    L.internalTimeout(runDeferred, 0);
    if (rec.state === 'error') { fireScriptEvent(rec.el, 'error'); return; }
    execClassic(rec, 'nonblocking');
  }
  function fireDOMContentLoaded() {
    if (dclFired) return;
    dclFired = true;
    L.milestones.domContentLoadedEventStart = N.now();
    L.fire(document, 'DOMContentLoaded', { bubbles: true, cancelable: false });
    L.milestones.domContentLoadedEventEnd = N.now();
    maybeFireLoad();
  }
  function setReadyState(s) {
    if (L.readyState === s) return;
    L.readyState = s;
    L.fire(document, 'readystatechange', { bubbles: false, cancelable: false });
  }
  function maybeFireLoad() {
    if (loadQueued || !dclFired) return;
    if (asyncPending > 0) return;
    let pending = 0;
    try { pending = N.pendingResourceCount(); } catch (_) { pending = 0; }
    if (pending > 0) return;
    loadQueued = true;
    L.postTask(() => {
      L.milestones.domComplete = N.now();
      setReadyState('complete');
      L.milestones.loadEventStart = N.now();
      L.fireAtWindowWithDocumentTarget('load', { bubbles: false, cancelable: false }, L.Event);
      L.milestones.loadEventEnd = N.now();
      L.fireAtWindowWithDocumentTarget('pageshow', { bubbles: false, cancelable: false, persisted: false }, L.PageTransitionEvent);
    });
  }
  L.maybeFireLoad = maybeFireLoad;

  function onScriptFetched(rec) {
    if (parserQueue.length && parserQueue[0] === rec) pumpParser();
    else if (parsingFinished && deferQueue.length && deferQueue[0] === rec) runDeferred();
  }
  function scheduleParserRecord(rec) {
    // classify a parser-inserted script (initial document or document.write)
    if (rec.type === 'classic') {
      if (rec.external && rec.async) {
        asyncPending++;
        startScriptFetch(rec, (r) => {
          const run = () => {
            asyncPending--;
            if (r.state === 'error') fireScriptEvent(r.el, 'error');
            else execClassic(r, 'nonblocking');
            maybeFireLoad();
          };
          // An async script cannot run before the parser has reached it: earlier
          // parser-blocking and inline scripts go first (consent managers configure
          // themselves in an inline script before their async loader).
          if (asyncMayRun(r)) run();
          else asyncWaiting.push({ rec: r, run });
        });
        return 'async';
      }
      if (rec.external && rec.defer) {
        deferQueue.push(rec);
        startScriptFetch(rec, onScriptFetched);
        return 'defer';
      }
      if (rec.external && rec.state === 'pending') startScriptFetch(rec, onScriptFetched);
      return 'blocking';
    }
    // module
    if (rec.async) {
      asyncPending++;
      runModuleRecord(rec).then(() => { asyncPending--; maybeFireLoad(); });
      return 'async';
    }
    deferQueue.push(rec);
    return 'defer';
  }
  function onDocumentParsed() {
    L.milestones.responseEnd = N.now();
    L.extractTemplates(docId); // parsed template contents leave the document tree
    L.attachDeclarativeShadowRoots(docId);
    // The native parser drops the doctype: recreate it (optional N.doctype() says which,
    // null = none in the source = quirks mode; without it assume <!DOCTYPE html>).
    let dt = ['html', '', ''];
    if (typeof N.doctype === 'function') { try { dt = N.doctype(); } catch (_) { /* keep default */ } }
    if (dt === null || dt === undefined) L.quirksMode = true;
    else L.ensureDoctype(docId, dt);
    for (const id of N.querySelectorAll(docId, '*')) if (id > parserMaxNodeId) parserMaxNodeId = id;
    const ids = N.querySelectorAll(docId, 'script');
    for (const id of ids) {
      L.pendingScripts.delete(id);
      if (N.closest(id, 'template') !== 0) continue;
      const rec = makeRecord(id, true);
      if (rec === null) continue;
      rec.seq = ++parserSeq;
      if (rec.state === 'error' && rec.external) { L.postTask(() => fireScriptEvent(rec.el, 'error')); continue; }
      if (scheduleParserRecord(rec) === 'blocking') parserQueue.push(rec);
    }
    pumpParser();
  }

  // --- dynamically inserted scripts ---
  const orderedDynamic = []; // non-async dynamic external scripts, executed in insertion order
  function runOrderedDynamic() {
    while (orderedDynamic.length && orderedDynamic[0].state !== 'pending') {
      const rec = orderedDynamic.shift();
      if (rec.state === 'error') fireScriptEvent(rec.el, 'error');
      else execClassic(rec, 'dynamic');
      asyncPending--;
    }
    maybeFireLoad();
  }
  function prepareDynamicScript(id) {
    if (!L.pendingScripts.has(id)) return;
    const src = scriptSrc(id);
    if (src === null && childText(id) === '') return; // not started yet; may start later
    L.pendingScripts.delete(id);
    const rec = makeRecord(id, false);
    if (rec === null) return;
    const el = rec.el;
    if (rec.state === 'error') { L.postTask(() => fireScriptEvent(el, 'error')); return; }
    if (rec.type === 'module') {
      if (!loadQueued) asyncPending++;
      const counted = !loadQueued;
      runModuleRecord(rec).then(() => { if (counted) { asyncPending--; maybeFireLoad(); } });
      return;
    }
    if (!rec.external) {
      execClassic(rec, 'dynamic');
      return;
    }
    const counted = !loadQueued;
    if (counted) asyncPending++;
    const isAsync = N.hasAttr(id, 'async') || L.forceAsync.has(id);
    if (!isAsync) {
      if (!counted) asyncPending++;
      orderedDynamic.push(rec);
      startScriptFetch(rec, () => runOrderedDynamic());
      return;
    }
    startScriptFetch(rec, (r) => {
      if (r.state === 'error') fireScriptEvent(r.el, 'error');
      else execClassic(r, 'dynamic');
      if (counted) { asyncPending--; maybeFireLoad(); }
    });
  }
  L.checkPendingScripts = function () {
    let connected = null;
    for (const id of L.pendingScripts) {
      if (N.isConnected(id)) (connected || (connected = [])).push(id);
    }
    if (connected === null) return;
    if (connected.length > 1) connected.sort((a, b) => (N.compareDocumentPosition(a, b) & 4 ? -1 : 1));
    for (const id of connected) prepareDynamicScript(id);
  };
  L.scriptChildrenChanged = function (id) {
    if (L.pendingScripts.has(id) && N.isConnected(id)) prepareDynamicScript(id);
  };

  // --- document.write / open / close ---
  let writeState = null;           // {anchor: node id after which to insert, stack: [open element ids]}
  let lastParserAnchor = 0;        // insertion point after the last executed parser script
  let reopened = false;
  const VOID = L.VOID_ELEMENTS;
  const RAWTEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
  function unclosedTags(html) {
    const stack = [];
    const re = /<(\/)?([a-zA-Z][\w:-]*)((?:\s+[^\s/>"'=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*(\/)?>/g;
    let m;
    let raw = null;
    while ((m = re.exec(html)) !== null) {
      const name = m[2].toLowerCase();
      if (raw !== null) {
        if (m[1] && name === raw) raw = null;
        continue;
      }
      if (m[1]) {
        const i = stack.lastIndexOf(name);
        if (i >= 0) stack.length = i;
        else stack.push('/' + name);
      } else if (!VOID.has(name) && !m[4]) {
        if (RAWTEXT.has(name)) { raw = name; continue; }
        stack.push(name);
      }
    }
    return stack;
  }
  function writeInto(parentId, refId, html) {
    const ctx = wrap(parentId);
    const frag = L.parseFragment(typeOf(ctx) === 1 ? ctx : null, html);
    const kids = N.childIds(frag);
    const scripts = N.querySelectorAll(frag, 'script');
    if (kids.length) L.insertCore(parentId, ctx, wrap(frag), frag, refId);
    return { kids, scripts };
  }
  function runWrittenScripts(ids) {
    let blocked = false;
    const queued = [];
    for (const id of ids) {
      L.pendingScripts.delete(id);
      const rec = makeRecord(id, true);
      if (rec === null) continue;
      if (rec.state === 'error' && rec.external) { L.postTask(() => fireScriptEvent(rec.el, 'error')); continue; }
      if (!blocked && !rec.external && rec.type === 'classic') { execClassic(rec, 'parser'); continue; }
      const kind = scheduleParserRecord(rec);
      if (kind === 'blocking') { queued.push(rec); blocked = true; }
    }
    if (queued.length) {
      parserQueue.splice(Math.min(writtenQueued, parserQueue.length), 0, ...queued);
      writtenQueued += queued.length;
    }
  }
  function writeAtInsertionPoint(ws, html) {
    // pure closing tags close previously written open elements
    const unclosed = unclosedTags(html);
    let closes = 0;
    while (unclosed.length && unclosed[0].startsWith('/')) { unclosed.shift(); closes++; }
    let parentId, refId;
    if (ws.stack.length) {
      parentId = ws.stack[ws.stack.length - 1];
      refId = 0;
    } else {
      parentId = N.parent(ws.anchor);
      if (parentId === 0) return;
      refId = N.nextSibling(ws.anchor);
    }
    const { kids, scripts } = writeInto(parentId, refId, html);
    for (let i = 0; i < closes && ws.stack.length; i++) ws.stack.pop();
    if (kids.length) {
      if (ws.stack.length === 0 || closes > 0) {
        if (ws.stack.length === 0) ws.anchor = kids[kids.length - 1];
      }
      // descend into elements left open by this chunk
      let cur = kids[kids.length - 1];
      for (const name of unclosed) {
        if (name.startsWith('/')) continue;
        if (cur === 0 || N.nodeType(cur) !== 1) break;
        ws.stack.push(cur);
        let last = N.lastChild(cur);
        while (last !== 0 && N.nodeType(last) !== 1) last = N.prevSibling(last);
        cur = last;
        void name;
      }
    }
    if (scripts.length) runWrittenScripts(scripts);
  }
  function docWrite(doc, args, newline) {
    let html = '';
    for (const a of args) html += `${a}`;
    if (newline) html += '\n';
    if (doc !== document) {
      const b = doc.body;
      if (b !== null) writeInto(idOf(b), 0, html);
      return;
    }
    if (inParserScript !== null && writeState !== null) { writeAtInsertionPoint(writeState, html); return; }
    if (inNonBlockingScript > 0) {
      L.log('warn', "Failed to execute 'write' on 'Document': It isn't possible to write into a document from an asynchronously-loaded external script unless it is explicitly opened.");
      return;
    }
    if (!parsingFinished && L.readyState === 'loading') {
      const anchor = lastParserAnchor !== 0 && N.isConnected(lastParserAnchor) ? lastParserAnchor : 0;
      if (anchor !== 0) { writeAtInsertionPoint({ anchor, stack: [] }, html); return; }
      const b = L.bodyId();
      if (b !== 0) { const r = writeInto(b, 0, html); if (r.scripts.length) runWrittenScripts(r.scripts); }
      return;
    }
    // After parsing: implicit document.open() replaces the body content
    const b = L.bodyId();
    if (b === 0) return;
    if (!reopened) {
      reopened = true;
      L.replaceAllCore(b, wrap(b), () => N.setTextContent(b, ''));
    }
    const r = writeInto(b, 0, html);
    for (const id of r.scripts) L.pendingScripts.add(id);
    if (r.scripts.length) L.checkPendingScripts();
  }
  L.mixin(L.Document.prototype, {
    write(...text) { docWrite(this, text, false); },
    writeln(...text) { docWrite(this, text, true); },
    open(a, b, c) {
      if (arguments.length >= 3) return g.open(a, b, c);
      if (this !== document) return this;
      if (inParserScript !== null) return this;
      if (parsingFinished || L.readyState !== 'loading') {
        const bid = L.bodyId();
        if (bid !== 0) L.replaceAllCore(bid, wrap(bid), () => N.setTextContent(bid, ''));
        reopened = true;
      }
      return this;
    },
    close() { if (this === document) reopened = false; },
  });

  // =======================================================================================
  // Native events (hooks.onEvent)
  // =======================================================================================
  const NON_BUBBLING = new Set(['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave', 'focus', 'blur', 'load',
    'error', 'scroll', 'scrollend', 'resize', 'gotpointercapture', 'lostpointercapture', 'mediaerror', 'toggle', 'invalid']);
  const NON_CANCELABLE = new Set(['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave', 'focus', 'blur', 'focusin',
    'focusout', 'input', 'change', 'scroll', 'scrollend', 'resize', 'load', 'error', 'select', 'compositionend',
    'pointercancel', 'gotpointercapture', 'lostpointercapture', 'selectionchange', 'toggle']);
  const MOUSEISH = /^(click|dblclick|auxclick|contextmenu|mouse|pointer|wheel|drag|drop|touch)/;
  const IMPLICIT_BLOCKERS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number']);
  function implicitSubmission(target) {
    if (!isNode(target) || typeOf(target) !== 1 || lnOf(target) !== 'input') return false;
    const t = L.inputType(target);
    if (!IMPLICIT_BLOCKERS.has(t)) return false;
    const form = L.formOwnerOf(target);
    if (form === null) return false;
    const ids = L.formControlIds(form).concat(N.querySelectorAll(idOf(form), 'input[type=image i]'));
    ids.sort((a, b) => (a === b ? 0 : N.compareDocumentPosition(a, b) & 4 ? -1 : 1));
    for (const id of ids) {
      const el = wrap(id);
      if (L.formOwnerOf(el) !== form) continue;
      if (L.isSubmitButton(el)) {
        if (!L.isDisabledFormControl(el)) el.click();
        return true;
      }
    }
    let blockers = 0;
    for (const id of L.formControlIds(form)) {
      if (N.localName(id) === 'input' && IMPLICIT_BLOCKERS.has(L.inputType(wrap(id)))) blockers++;
    }
    if (blockers > 1) return false;
    L.submitFormAlgorithm(form, null);
    return true;
  }
  const FOCUS_TYPES = new Set(['focus', 'blur', 'focusin', 'focusout']);
  function onEvent(type, targetId, pathIds, init) {
    const t = `${type}`;
    const i = init || {};
    const d = {};
    for (const k in i) d[k] = i[k];
    if (FOCUS_TYPES.has(t)) L.nativeFocusEvents++;
    if (i.relatedTargetId !== undefined) {
      d.relatedTarget = i.relatedTargetId ? wrap(i.relatedTargetId) : null;
      delete d.relatedTargetId;
    }
    if (i.submitterId !== undefined) {
      d.submitter = i.submitterId ? wrap(i.submitterId) : null;
      delete d.submitterId;
    }
    if (d.bubbles === undefined) d.bubbles = !NON_BUBBLING.has(t);
    if (d.cancelable === undefined) d.cancelable = !NON_CANCELABLE.has(t);
    if (d.composed === undefined) d.composed = true;
    d.view = g;
    let ids = Array.isArray(pathIds) ? Array.from(pathIds) : [];
    let tid = targetId;
    if (!tid) {
      tid = N.activeElement() || L.bodyId() || docId;
      ids = [];
    }
    if (ids.length === 0 || ids[0] !== tid) {
      ids = [];
      for (let x = tid; x !== 0; x = N.parent(x)) ids.push(x);
    }
    if (MOUSEISH.test(t) && N.nodeType(tid) === 3) {
      ids.shift();
      tid = ids.length ? ids[0] : docId;
    }
    const Ctor = L.nativeEventClass(t, i);
    const ev = L.createNativeEvent(Ctor, t, d);
    const path = [];
    for (const x of ids) { const w = wrap(x); if (w !== null) path.push(w); }
    if (path.length === 0) path.push(document);
    if (path[path.length - 1] === document || (t !== 'load' && N.isConnected(tid))) {
      if (path[path.length - 1] !== document && N.isConnected(tid)) path.push(document);
      path.push(g);
    }
    let flags = L.dispatchCore(path[0], ev, path);
    if (t === 'keydown' && !(flags & 1) && i.key === 'Enter' && !i.isComposing && !i.altKey && !i.ctrlKey && !i.metaKey) {
      try { if (implicitSubmission(path[0])) flags |= 4; } catch (e) { L.reportException(e); }
    }
    if (t === 'scroll' || t === 'wheel' || t === 'resize') L.observersDirty();
    return flags;
  }

  // =======================================================================================
  // Other hooks
  // =======================================================================================
  function onViewportChanged() {
    L.fire(g, 'resize', { bubbles: false, cancelable: false, view: g }, L.UIEvent);
    L.fire(L.visualViewport, 'resize', {});
    L.checkMediaQueries();
    L.observersDirty();
  }
  function onScroll() {
    L.fire(document, 'scroll', { bubbles: true, cancelable: false });
    L.fire(L.visualViewport, 'scroll', {});
    L.observersDirty();
  }
  let pageHidden = false;
  function onPageHide() {
    if (pageHidden) return;
    pageHidden = true;
    L.fireAtWindowWithDocumentTarget('beforeunload', { cancelable: true }, L.BeforeUnloadEvent);
    if (L.visibilityState !== 'hidden') {
      L.visibilityState = 'hidden';
      L.fire(document, 'visibilitychange', { bubbles: true, cancelable: false });
    }
    L.fireAtWindowWithDocumentTarget('pagehide', { persisted: false }, L.PageTransitionEvent);
    L.fireAtWindowWithDocumentTarget('unload', {}, L.Event);
  }
  function onElementEvent(id, type) {
    const el = wrap(id);
    if (el === null) return;
    const t = `${type}`;
    if (lnOf(el) === 'img' && (t === 'load' || t === 'error')) L.imageEvent(el, t);
    L.fire(el, t, { bubbles: false, cancelable: false });
    L.observersDirty();
  }
  function onUnhandledRejection(promise, reason) {
    const ev = new L.PromiseRejectionEvent('unhandledrejection', { cancelable: true, promise, reason });
    if (L.dispatch(g, ev, true)) L.log('error', 'Uncaught (in promise) ' + L.errToString(reason));
  }
  // An exception reached Rust (and was logged there): only dispatch the window ErrorEvent.
  function onError(msg, file, line, col, error) {
    L.reportException(error, { logged: true, message: msg === undefined || msg === null ? '' : `${msg}`, filename: file ? `${file}` : L.documentURL(), lineno: +line || 0, colno: +col || 0 });
  }
  function onRejectionHandled(promise, reason) {
    L.fire(g, 'rejectionhandled', { cancelable: false, promise, reason }, L.PromiseRejectionEvent);
  }
  function guard(fn) {
    return function () {
      L.bumpAll();
      try {
        return Reflect.apply(fn, undefined, arguments);
      } catch (e) {
        L.reportException(e);
        return undefined;
      }
    };
  }
  function guardFlags(fn) {
    return function () {
      L.bumpAll();
      try {
        return Reflect.apply(fn, undefined, arguments) | 0;
      } catch (e) {
        L.reportException(e);
        return 0;
      }
    };
  }
  // CSS animation/transition events recorded by the style engine.
  function onAnimationEvent(id, type, name, elapsedTime, pseudoElement) {
    if (!N.isConnected(id)) return;
    const el = L.wrap(id);
    if (type.startsWith('animation')) {
      L.fire(el, type, { bubbles: true, animationName: name, elapsedTime, pseudoElement }, L.AnimationEvent);
    } else {
      L.fire(el, type, { bubbles: true, propertyName: name, elapsedTime, pseudoElement }, L.TransitionEvent);
    }
  }
  N.setHooks({
    onDocumentParsed: guard(onDocumentParsed),
    onEvent: guardFlags(onEvent),
    onTimer: guard(L.onTimer),
    onFrame: guard(L.onFrame),
    onFetch: guard(L.onFetch),
    onResourcesLoaded: guard(maybeFireLoad),
    onViewportChanged: guard(onViewportChanged),
    onScroll: guard(onScroll),
    onPageHide: guard(onPageHide),
    // Additions (see NATIVE_API.md)
    onElementEvent: guard(onElementEvent),
    onPopState: guard(L.onPopState),
    onUnhandledRejection: guard(onUnhandledRejection),
    onRejectionHandled: guard(onRejectionHandled),
    onError: guard(onError),
    onWebSocket: guard(L.onWebSocket),
    onFetchProgress: guard(L.onFetchProgress),
    onAnimationEvent: guard(onAnimationEvent),
    onMessage: guard(L.onMessage),
    // Wrapper for a node of this realm's document (used by `frameElement`
    // of a child realm).
    wrapNode: (id) => wrap(id),
    nodeTypeOf: (o) => (isNode(o) ? typeOf(o) : 0),
    // Not guarded: its exceptions are the caller's (invalid target origin, DataCloneError).
    windowPostMessage: (message, targetOrigin, transfer, source) => L.windowPostMessage(message, targetOrigin, transfer, source),
  });

  // =======================================================================================
  // Final hardening: WebIDL-like property attributes, toStringTag, native-looking functions
  // =======================================================================================
  const nativeFns = L.nativeFns;
  function markFns(obj, seen) {
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function') || seen.has(obj)) return;
    seen.add(obj);
    for (const k of Reflect.ownKeys(obj)) {
      let d;
      try { d = Reflect.getOwnPropertyDescriptor(obj, k); } catch (_) { continue; }
      if (d === undefined) continue;
      if (typeof d.value === 'function') nativeFns.add(d.value);
      if (typeof d.get === 'function') nativeFns.add(d.get);
      if (typeof d.set === 'function') nativeFns.add(d.set);
    }
  }
  const seen = new Set();
  const interfaces = L.exposed.concat([['Window', Window]]);
  for (const [name, C] of interfaces) {
    if (typeof C !== 'function') continue;
    nativeFns.add(C);
    markFns(C, seen);
    const P = C.prototype;
    if (P === null || typeof P !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(P, Symbol.toStringTag) && C !== L.DOMException) {
      Object.defineProperty(P, Symbol.toStringTag, { value: name, configurable: true });
    }
    for (const k of Object.getOwnPropertyNames(P)) {
      if (k === 'constructor' || /^\d+$/.test(k)) continue;
      const d = Object.getOwnPropertyDescriptor(P, k);
      if (d.enumerable || !d.configurable) continue;
      d.enumerable = true;
      Object.defineProperty(P, k, d);
    }
    markFns(P, seen);
  }
  markFns(g, seen);
  for (const o of [L.console, L.CSS, L.location, L.history, L.navigator, L.screen, L.performance, L.crypto, L.document, L.customElements]) markFns(o, seen);
  const origToString = L.nativeFunctionToString;
  const patchedToString = {
    toString() {
      if (nativeFns.has(this)) return 'function ' + (this.name || '') + '() { [native code] }';
      return Reflect.apply(origToString, this, []);
    },
  }.toString;
  nativeFns.add(patchedToString);
  Object.defineProperty(Function.prototype, 'toString', { value: patchedToString, writable: true, enumerable: false, configurable: true });

  // Hide the layer registry from page scripts.
  delete g.__layer;
})(globalThis.__layer);
