// 40_webapi.js — timers, task queue, animation frames, messaging, URL, encoding, Blob/File,
// FormData, fetch/Headers/Request/Response, XMLHttpRequest, crypto, performance, console,
// navigator/screen/location/history, storage, matchMedia, observers, CSS namespace, fonts.
(function (L) {
  'use strict';
  const N = L.N;
  const DOMException = L.DOMException;
  const EventTarget = L.EventTarget;
  const INTERNAL = L.INTERNAL;
  const idOf = L.idOf, isNode = L.isNode, typeOf = L.typeOf, wrap = L.wrap;

  // =======================================================================================
  // Timers / tasks / frames
  // =======================================================================================
  let nextTimerId = 1;
  const pageTimers = new Map();     // id -> {handler, args, repeat, delay, nesting}
  const internalTimers = new Map(); // id -> fn
  let currentNesting = 0;
  function normDelay(t) {
    let d = Number(t);
    if (!(d > 0)) d = 0;
    if (d > 2147483647) d = 1;
    return d;
  }
  // HTML timer initialization steps: clamp to >= 4ms when the *current* task's timer nesting
  // level is > 5; the new timer's task gets nesting level + 1.
  function addTimer(handler, timeout, args, repeat) {
    const id = nextTimerId++;
    const delay = normDelay(timeout);
    pageTimers.set(id, { handler, args, repeat, delay, nesting: currentNesting + 1 });
    N.setTimer(id, currentNesting > 5 && delay < 4 ? 4 : delay);
    return id;
  }
  function clearTimer(id) {
    const n = Number(id);
    if (pageTimers.has(n)) {
      pageTimers.delete(n);
      N.clearTimer(n);
    }
  }
  L.internalTimeout = function (fn, delay) {
    const id = nextTimerId++;
    internalTimers.set(id, fn);
    N.setTimer(id, normDelay(delay));
    return id;
  };
  L.clearInternalTimeout = function (id) {
    if (internalTimers.delete(id)) N.clearTimer(id);
  };
  L.onTimer = function (id) {
    const fn = internalTimers.get(id);
    if (fn !== undefined) {
      internalTimers.delete(id);
      try { fn(); } catch (e) { L.reportException(e); }
      return;
    }
    const t = pageTimers.get(id);
    if (t === undefined) return;
    if (!t.repeat) pageTimers.delete(id);
    const prev = currentNesting;
    currentNesting = t.nesting;
    try {
      if (typeof t.handler === 'function') {
        Reflect.apply(t.handler, L.window, t.args);
      } else {
        try { N.evalScript(`${t.handler}`, L.documentURL(), true); } catch (e) { L.reportScriptError(e); }
      }
    } catch (e) {
      L.reportException(e);
    } finally {
      currentNesting = prev;
    }
    if (t.repeat && pageTimers.get(id) === t) {
      const cur = t.nesting;
      t.nesting = cur + 1;
      N.setTimer(id, cur > 5 && t.delay < 4 ? 4 : t.delay);
    }
  };
  function setTimeout(handler, timeout = 0, ...args) { return addTimer(handler, timeout, args, false); }
  function setInterval(handler, timeout = 0, ...args) { return addTimer(handler, timeout, args, true); }
  function clearTimeout(id) { if (id !== undefined && id !== null) clearTimer(id); }
  function clearInterval(id) { if (id !== undefined && id !== null) clearTimer(id); }

  // Macrotask queue: one task per native timer turn (so microtasks drain in between).
  const taskQueue = [];
  let taskTimer = 0;
  function runOneTask() {
    taskTimer = 0;
    const fn = taskQueue.shift();
    if (taskQueue.length) taskTimer = L.internalTimeout(runOneTask, 0);
    if (fn !== undefined) {
      try { fn(); } catch (e) { L.reportException(e); }
    }
  }
  L.postTask = function (fn) {
    taskQueue.push(fn);
    if (taskTimer === 0) taskTimer = L.internalTimeout(runOneTask, 0);
  };

  function queueMicrotask(callback) {
    if (typeof callback !== 'function') throw new TypeError("Failed to execute 'queueMicrotask' on 'Window': The callback provided as parameter 1 is not a function.");
    L.promiseThen.call(L.resolvedPromise(), () => {
      try { callback(); } catch (e) { L.reportException(e); }
    });
  }

  // Animation frames
  let obsDirty = true; // IntersectionObserver/ResizeObserver need a re-check at the next frame
  let rafId = 0;
  const rafCallbacks = new Map();
  let frameRequested = false;
  function requestFrame() {
    if (!frameRequested) {
      frameRequested = true;
      N.requestFrame();
    }
  }
  L.requestFrame = requestFrame;
  function requestAnimationFrame(callback) {
    if (typeof callback !== 'function') throw new TypeError("Failed to execute 'requestAnimationFrame' on 'Window': The callback provided as parameter 1 is not a function.");
    const id = ++rafId;
    rafCallbacks.set(id, callback);
    requestFrame();
    return id;
  }
  function cancelAnimationFrame(id) { rafCallbacks.delete(Number(id)); }
  L.onFrame = function (ts) {
    frameRequested = false;
    const t = Number(ts);
    const maxId = rafId;
    for (const [id, cb] of rafCallbacks) {
      if (id > maxId) break;
      rafCallbacks.delete(id);
      try { Reflect.apply(cb, L.window, [t]); } catch (e) { L.reportException(e); }
    }
    const dirty = obsDirty;
    obsDirty = false;
    try { runResizeObservers(dirty); } catch (e) { L.reportException(e); }
    try { runIntersectionObservers(t, dirty); } catch (e) { L.reportException(e); }
    if (rafCallbacks.size) requestFrame();
  };

  // requestIdleCallback
  class IdleDeadline {
    #end; #timeout;
    constructor(token, end, didTimeout) { if (token !== INTERNAL) throw L.illegal(); this.#end = end; this.#timeout = didTimeout; }
    get didTimeout() { return this.#timeout; }
    timeRemaining() { return Math.max(0, this.#end - N.now()); }
  }
  let idleId = 0;
  const idleCallbacks = new Map();
  function requestIdleCallback(callback, options) {
    if (typeof callback !== 'function') throw new TypeError("Failed to execute 'requestIdleCallback' on 'Window': The callback provided as parameter 1 is not a function.");
    const id = ++idleId;
    const tid = L.internalTimeout(() => {
      if (!idleCallbacks.has(id)) return;
      idleCallbacks.delete(id);
      try { Reflect.apply(callback, L.window, [new IdleDeadline(INTERNAL, N.now() + 49.9, false)]); } catch (e) { L.reportException(e); }
    }, 1);
    idleCallbacks.set(id, tid);
    return id;
  }
  function cancelIdleCallback(id) {
    const tid = idleCallbacks.get(Number(id));
    if (tid !== undefined) { idleCallbacks.delete(Number(id)); L.clearInternalTimeout(tid); }
  }

  // =======================================================================================
  // structuredClone / messaging
  // =======================================================================================
  function cloneValue(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      if (typeof value === 'symbol') throw new DOMException(`Failed to execute 'structuredClone' on 'Window': ${String(value)} could not be cloned.`, 'DataCloneError');
      return value;
    }
    if (typeof value === 'function') throw new DOMException(`Failed to execute 'structuredClone' on 'Window': ${L.nativeFunctionToString.call(value).slice(0, 60)} could not be cloned.`, 'DataCloneError');
    if (isNode(value)) throw new DOMException("Failed to execute 'structuredClone' on 'Window': Node object could not be cloned.", 'DataCloneError');
    if (value instanceof Blob) return value;
    try {
      return N.structuredClone(value);
    } catch (e) {
      const c = L.fromNative(e);
      if (c instanceof DOMException) throw c;
      throw new DOMException(`Failed to execute 'structuredClone' on 'Window': ${e && e.message ? e.message : 'value could not be cloned.'}`, 'DataCloneError');
    }
  }
  L.cloneValue = cloneValue;
  function structuredClone(value, options) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'structuredClone' on 'Window': 1 argument required, but only 0 present.");
    return cloneValue(value);
  }

  class MessagePort extends EventTarget {
    #other = null; #queue = []; #started = false; #closed = false;
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    static {
      L.entangle = (a, b) => { a.#other = b; b.#other = a; };
      L.portEnqueue = (port, data, ports) => {
        if (port.#closed) return;
        port.#queue.push([data, ports]);
        if (port.#started) L.postTask(() => L.portDeliver(port));
      };
      L.portDeliver = (port) => {
        if (port.#closed) return;
        const m = port.#queue.shift();
        if (m === undefined) return;
        L.fire(port, 'message', { data: m[0], ports: m[1] }, L.MessageEvent);
      };
      L.portStart = (port) => {
        if (port.#started) return;
        port.#started = true;
        for (let i = 0; i < port.#queue.length; i++) L.postTask(() => L.portDeliver(port));
      };
    }
    postMessage(message, transfer) {
      const other = this.#other;
      if (this.#closed || other === null) return;
      const list = Array.isArray(transfer) ? transfer : (transfer && Array.isArray(transfer.transfer) ? transfer.transfer : []);
      const ports = list.filter((x) => x instanceof MessagePort);
      L.portEnqueue(other, cloneValue(message), ports);
    }
    start() { L.portStart(this); }
    close() { this.#closed = true; }
    get onmessage() { return L.getHandlerIDL(this, 'message'); }
    set onmessage(v) { L.setHandlerIDL(this, 'message', v); L.portStart(this); }
  }
  L.defineEventHandlers(MessagePort.prototype, ['onmessageerror', 'onclose']);
  class MessageChannel {
    #p1; #p2;
    constructor() {
      this.#p1 = new MessagePort(INTERNAL);
      this.#p2 = new MessagePort(INTERNAL);
      L.entangle(this.#p1, this.#p2);
    }
    get port1() { return this.#p1; }
    get port2() { return this.#p2; }
  }
  const broadcastChannels = new Map(); // name -> Set
  class BroadcastChannel extends EventTarget {
    #name; #closed = false;
    constructor(name) {
      super();
      this.#name = `${name}`;
      let s = broadcastChannels.get(this.#name);
      if (s === undefined) { s = new Set(); broadcastChannels.set(this.#name, s); }
      s.add(this);
    }
    get name() { return this.#name; }
    postMessage(message) {
      if (this.#closed) throw new DOMException("Failed to execute 'postMessage' on 'BroadcastChannel': Channel is closed", 'InvalidStateError');
      const data = cloneValue(message);
      const origin = L.location ? L.location.origin : '';
      for (const ch of broadcastChannels.get(this.#name)) {
        if (ch === this) continue;
        L.postTask(() => { if (!L.bcClosed(ch)) L.fire(ch, 'message', { data: cloneValue(data), origin }, L.MessageEvent); });
      }
    }
    close() { this.#closed = true; const s = broadcastChannels.get(this.#name); if (s) s.delete(this); }
    static { L.bcClosed = (c) => c.#closed; }
  }
  L.defineEventHandlers(BroadcastChannel.prototype, ['onmessage', 'onmessageerror']);
  L.windowPostMessage = function (message, targetOrigin, transfer) {
    let target = '/';
    let list = [];
    if (targetOrigin !== null && typeof targetOrigin === 'object') {
      target = targetOrigin.targetOrigin === undefined ? '/' : `${targetOrigin.targetOrigin}`;
      list = Array.isArray(targetOrigin.transfer) ? targetOrigin.transfer : [];
    } else {
      target = targetOrigin === undefined ? '/' : `${targetOrigin}`;
      list = Array.isArray(transfer) ? transfer : [];
    }
    const origin = L.location.origin;
    if (target !== '*' && target !== '/') {
      const p = N.urlParse(target, null);
      if (p === null) throw new DOMException(`Failed to execute 'postMessage' on 'Window': Invalid target origin '${target}' in a call to 'postMessage'.`, 'SyntaxError');
      if (p[10] !== origin) return;
    }
    const data = cloneValue(message);
    const ports = list.filter((x) => x instanceof MessagePort);
    L.postTask(() => L.fire(L.window, 'message', { data, origin, source: L.window, ports }, L.MessageEvent));
  };

  // =======================================================================================
  // UTF-8 helpers (JS; used for URL encoding, multipart bodies, ...)
  // =======================================================================================
  function utf8Encode(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        else c = 0xfffd;
      } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  function utf8Decode(bytes) {
    let out = '';
    const n = bytes.length;
    let i = 0;
    while (i < n) {
      const b = bytes[i];
      if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
      let need = 0, cp = 0, min = 0;
      if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; min = 0x80; }
      else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f; min = 0x800; }
      else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07; min = 0x10000; }
      else { out += '�'; i++; continue; }
      let j = 1;
      for (; j <= need; j++) {
        const c = bytes[i + j];
        if (c === undefined || (c & 0xc0) !== 0x80) break;
        cp = (cp << 6) | (c & 0x3f);
      }
      if (j <= need || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { out += '�'; i += Math.max(1, j); continue; }
      out += String.fromCodePoint(cp);
      i += need + 1;
    }
    return out;
  }
  L.utf8Encode = utf8Encode;
  L.utf8Decode = utf8Decode;
  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (typeof SharedArrayBuffer !== 'undefined' && x instanceof SharedArrayBuffer) return new Uint8Array(x);
    return null;
  }
  L.toBytes = toBytes;
  function copyToArrayBuffer(u8) {
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
  }
  L.copyToArrayBuffer = copyToArrayBuffer;

  // =======================================================================================
  // URL / URLSearchParams
  // =======================================================================================
  const SPECIAL_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:']);
  function percentDecodeBytes(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 37 && i + 2 < s.length && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
        bytes.push(parseInt(s.substr(i + 1, 2), 16));
        i += 2;
      } else if (c < 0x80) {
        bytes.push(c);
      } else {
        const e = utf8Encode(s.slice(i, (c >= 0xd800 && c <= 0xdbff) ? i + 2 : i + 1));
        for (const b of e) bytes.push(b);
        if (c >= 0xd800 && c <= 0xdbff) i++;
      }
    }
    return new Uint8Array(bytes);
  }
  function formDecode(s) {
    if (s.indexOf('%') < 0 && s.indexOf('+') < 0) return s;
    return utf8Decode(percentDecodeBytes(s.replace(/\+/g, ' ')));
  }
  function parseQuery(s) {
    const out = [];
    if (s === '') return out;
    for (const part of s.split('&')) {
      if (part === '') continue;
      const i = part.indexOf('=');
      const name = i < 0 ? part : part.slice(0, i);
      const value = i < 0 ? '' : part.slice(i + 1);
      out.push([formDecode(name), formDecode(value)]);
    }
    return out;
  }
  const FORM_SAFE = /^[A-Za-z0-9*\-._]*$/;
  function formEncode(s) {
    if (FORM_SAFE.test(s)) return s;
    const bytes = utf8Encode(s);
    let out = '';
    for (const b of bytes) {
      if (b === 0x20) out += '+';
      else if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f) out += String.fromCharCode(b);
      else out += '%' + (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
    }
    return out;
  }
  function serializeQuery(list) {
    let out = '';
    for (let i = 0; i < list.length; i++) {
      if (i) out += '&';
      out += formEncode(list[i][0]) + '=' + formEncode(list[i][1]);
    }
    return out;
  }
  L.serializeQuery = serializeQuery;
  L.parseQuery = parseQuery;

  class URLSearchParams {
    #list = [];
    #url = null;
    constructor(init = '') {
      if (init instanceof URLSearchParams) {
        this.#list = init.#list.map((p) => [p[0], p[1]]);
      } else if (init !== null && typeof init === 'object' || typeof init === 'function') {
        if (typeof init[Symbol.iterator] === 'function') {
          for (const pair of init) {
            if (pair === null || typeof pair !== 'object' || typeof pair[Symbol.iterator] !== 'function') throw new TypeError("Failed to construct 'URLSearchParams': The provided value cannot be converted to a sequence.");
            const a = Array.from(pair);
            if (a.length !== 2) throw new TypeError("Failed to construct 'URLSearchParams': Sequence initializer must only contain pair elements");
            this.#list.push([L.toUSV(a[0]), L.toUSV(a[1])]);
          }
        } else {
          for (const k of Reflect.ownKeys(init)) {
            if (typeof k !== 'string') continue;
            const d = Reflect.getOwnPropertyDescriptor(init, k);
            if (d === undefined || !d.enumerable) continue;
            this.#list.push([L.toUSV(k), L.toUSV(init[k])]);
          }
        }
      } else {
        let s = L.toUSV(init);
        if (s.charCodeAt(0) === 63) s = s.slice(1);
        this.#list = parseQuery(s);
      }
    }
    static {
      L.uspLink = (p, url) => { p.#url = url; };
      L.uspSetList = (p, list) => { p.#list = list; };
      L.uspList = (p) => p.#list;
    }
    #update() {
      if (this.#url !== null) L.urlSetQueryFromParams(this.#url, serializeQuery(this.#list));
    }
    get size() { return this.#list.length; }
    append(name, value) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'append' on 'URLSearchParams': 2 arguments required, but only " + arguments.length + ' present.');
      this.#list.push([L.toUSV(name), L.toUSV(value)]);
      this.#update();
    }
    delete(name, value) {
      const n = L.toUSV(name);
      if (value === undefined) this.#list = this.#list.filter((p) => p[0] !== n);
      else { const v = L.toUSV(value); this.#list = this.#list.filter((p) => !(p[0] === n && p[1] === v)); }
      this.#update();
    }
    get(name) { const n = L.toUSV(name); const p = this.#list.find((x) => x[0] === n); return p === undefined ? null : p[1]; }
    getAll(name) { const n = L.toUSV(name); return this.#list.filter((x) => x[0] === n).map((x) => x[1]); }
    has(name, value) {
      const n = L.toUSV(name);
      if (value === undefined) return this.#list.some((x) => x[0] === n);
      const v = L.toUSV(value);
      return this.#list.some((x) => x[0] === n && x[1] === v);
    }
    set(name, value) {
      const n = L.toUSV(name), v = L.toUSV(value);
      const i = this.#list.findIndex((x) => x[0] === n);
      if (i < 0) this.#list.push([n, v]);
      else {
        this.#list[i][1] = v;
        this.#list = this.#list.filter((x, j) => j <= i || x[0] !== n);
      }
      this.#update();
    }
    sort() {
      const indexed = this.#list.map((p, i) => [p, i]);
      indexed.sort((a, b) => {
        const x = a[0][0], y = b[0][0];
        const n = Math.min(x.length, y.length);
        for (let i = 0; i < n; i++) {
          const d = x.charCodeAt(i) - y.charCodeAt(i);
          if (d !== 0) return d;
        }
        return x.length - y.length || a[1] - b[1];
      });
      this.#list = indexed.map((p) => p[0]);
      this.#update();
    }
    forEach(cb, thisArg) {
      for (let i = 0; i < this.#list.length; i++) Reflect.apply(cb, thisArg, [this.#list[i][1], this.#list[i][0], this]);
    }
    *entries() { for (let i = 0; i < this.#list.length; i++) yield [this.#list[i][0], this.#list[i][1]]; }
    *keys() { for (let i = 0; i < this.#list.length; i++) yield this.#list[i][0]; }
    *values() { for (let i = 0; i < this.#list.length; i++) yield this.#list[i][1]; }
    toString() { return serializeQuery(this.#list); }
  }
  URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;

  // URL component array: [href, protocol, username, password, host, hostname, port, pathname, search, hash, origin]
  const USERINFO_ENC = /[\u0000-\u001f\u007f-￿ "#<>?`{}/:;=@[\\\]^|%]/g;
  function encUserinfo(s) { return s.replace(USERINFO_ENC, (c) => (c === '%' ? '%' : Array.from(utf8Encode(c), (b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''))); }
  function rebuild(p, parts) {
    const protocol = parts.protocol !== undefined ? parts.protocol : p[1];
    const hasAuth = p[0].startsWith(p[1] + '//');
    const user = parts.username !== undefined ? parts.username : p[2];
    const pass = parts.password !== undefined ? parts.password : p[3];
    const host = parts.host !== undefined ? parts.host : p[4];
    const path = parts.pathname !== undefined ? parts.pathname : p[7];
    const search = parts.search !== undefined ? parts.search : p[8];
    const hash = parts.hash !== undefined ? parts.hash : p[9];
    let s = protocol;
    if (hasAuth || parts.forceAuth) {
      s += '//';
      if (user !== '' || pass !== '') s += user + (pass !== '' ? ':' + pass : '') + '@';
      s += host;
    }
    s += path + search + hash;
    return s;
  }
  const URL_SET_NATIVE = typeof N.urlSet === 'function';
  class URL {
    #p;
    #sp = null;
    constructor(url, base) {
      if (arguments.length === 0) throw new TypeError("Failed to construct 'URL': 1 argument required, but only 0 present.");
      const u = L.toUSV(url);
      let parsed;
      if (base !== undefined) {
        const b = N.urlParse(L.toUSV(base), null);
        if (b === null) throw new TypeError(`Failed to construct 'URL': Invalid base URL`);
        parsed = N.urlParse(u, b[0]);
      } else {
        parsed = N.urlParse(u, null);
      }
      if (parsed === null) throw new TypeError(`Failed to construct 'URL': Invalid URL`);
      this.#p = parsed;
    }
    static canParse(url, base) {
      if (base !== undefined) {
        const b = N.urlParse(L.toUSV(base), null);
        if (b === null) return false;
        return N.urlParse(L.toUSV(url), b[0]) !== null;
      }
      return N.urlParse(L.toUSV(url), null) !== null;
    }
    static parse(url, base) {
      try { return new URL(url, base); } catch (_) { return null; }
    }
    static createObjectURL(obj) {
      if (!(obj instanceof Blob) && !(L.MediaSource && obj instanceof L.MediaSource)) throw new TypeError("Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.");
      const origin = L.location ? L.location.origin : 'null';
      const url = 'blob:' + (origin === 'null' ? 'null' : origin) + '/' + randomUUID();
      blobURLs.set(url, obj);
      if (typeof N.registerBlobURL === 'function') {
        try { N.registerBlobURL(url, copyToArrayBuffer(L.blobBytes(obj)), obj.type); } catch (_) { /* optional */ }
      }
      return url;
    }
    static revokeObjectURL(url) {
      const u = `${url}`;
      if (blobURLs.delete(u) && typeof N.revokeBlobURL === 'function') {
        try { N.revokeBlobURL(u); } catch (_) { /* optional */ }
      }
    }
    static {
      L.urlSetQueryFromParams = (u, q) => {
        const p = u.#p;
        const np = N.urlParse(rebuild(p, { search: q === '' ? '' : '?' + q }), null);
        if (np !== null) u.#p = np;
        if (q === '' && np !== null) {
          // strip an empty '?' left behind
          u.#p = np;
        }
      };
      L.urlParts = (u) => u.#p;
    }
    #reparse(href) {
      const np = N.urlParse(href, null);
      if (np === null) return false;
      this.#p = np;
      if (this.#sp !== null) L.uspSetList(this.#sp, parseQuery(np[8].slice(1)));
      return true;
    }
    // Exact WHATWG setter semantics from the native when available (optional N.urlSet).
    #nativeSet(field, v) {
      if (!URL_SET_NATIVE) return false;
      let np;
      try { np = N.urlSet(this.#p[0], field, L.toUSV(v)); } catch (_) { return false; }
      if (np === null || np === undefined) return false;
      this.#p = np;
      if (this.#sp !== null && field === 'search') L.uspSetList(this.#sp, parseQuery(np[8].slice(1)));
      return true;
    }
    get href() { return this.#p[0]; }
    set href(v) {
      if (!this.#reparse(L.toUSV(v))) throw new TypeError(`Failed to set the 'href' property on 'URL': Invalid URL`);
    }
    get origin() { return this.#p[10]; }
    get protocol() { return this.#p[1]; }
    set protocol(v) {
      if (this.#nativeSet('protocol', v)) return;
      const m = /^([A-Za-z][A-Za-z0-9+\-.]*)/.exec(L.toUSV(v));
      if (!m) return;
      const scheme = m[1].toLowerCase() + ':';
      const p = this.#p;
      if (SPECIAL_SCHEMES.has(p[1]) !== SPECIAL_SCHEMES.has(scheme)) return;
      if (scheme === 'file:' && (p[2] !== '' || p[3] !== '' || p[6] !== '')) return;
      const np = N.urlParse(scheme + p[0].slice(p[1].length), null);
      if (np !== null) this.#p = np;
    }
    get username() { return this.#p[2]; }
    set username(v) {
      if (this.#nativeSet('username', v)) return;
      const p = this.#p;
      if (p[5] === '' || p[1] === 'file:') return;
      this.#reparse(rebuild(p, { username: encUserinfo(L.toUSV(v)) }));
    }
    get password() { return this.#p[3]; }
    set password(v) {
      if (this.#nativeSet('password', v)) return;
      const p = this.#p;
      if (p[5] === '' || p[1] === 'file:') return;
      this.#reparse(rebuild(p, { password: encUserinfo(L.toUSV(v)) }));
    }
    get host() { return this.#p[4]; }
    set host(v) {
      if (this.#nativeSet('host', v)) return;
      const p = this.#p;
      const s = L.toUSV(v);
      if (!p[0].startsWith(p[1] + '//')) return;
      if (s === '' && SPECIAL_SCHEMES.has(p[1])) return;
      const h = s.split(/[/?#\\]/)[0];
      this.#reparse(rebuild(p, { host: h }));
    }
    get hostname() { return this.#p[5]; }
    set hostname(v) {
      if (this.#nativeSet('hostname', v)) return;
      const p = this.#p;
      if (!p[0].startsWith(p[1] + '//')) return;
      const s = L.toUSV(v).split(/[/?#\\:]/)[0];
      if (s === '' && SPECIAL_SCHEMES.has(p[1])) return;
      this.#reparse(rebuild(p, { host: s + (p[6] !== '' ? ':' + p[6] : '') }));
    }
    get port() { return this.#p[6]; }
    set port(v) {
      if (this.#nativeSet('port', v)) return;
      const p = this.#p;
      if (p[5] === '' || p[1] === 'file:') return;
      const s = L.toUSV(v);
      if (s === '') { this.#reparse(rebuild(p, { host: p[5] })); return; }
      const m = /^[0-9]+/.exec(s);
      if (!m) return;
      this.#reparse(rebuild(p, { host: p[5] + ':' + m[0] }));
    }
    get pathname() { return this.#p[7]; }
    set pathname(v) {
      if (this.#nativeSet('pathname', v)) return;
      const p = this.#p;
      if (!p[0].startsWith(p[1] + '//') && !p[7].startsWith('/') && !SPECIAL_SCHEMES.has(p[1])) return; // opaque path
      let s = L.toUSV(v).replace(/\?/g, '%3F').replace(/#/g, '%23');
      if (SPECIAL_SCHEMES.has(p[1]) && !s.startsWith('/') && !s.startsWith('\\')) s = '/' + s;
      this.#reparse(rebuild(p, { pathname: s }));
    }
    get search() { return this.#p[8]; }
    set search(v) {
      if (this.#nativeSet('search', v)) return;
      const p = this.#p;
      let s = L.toUSV(v);
      if (s.startsWith('?')) s = s.slice(1);
      this.#reparse(rebuild(p, { search: s === '' ? '' : '?' + s.replace(/#/g, '%23') }));
      if (this.#sp !== null) L.uspSetList(this.#sp, parseQuery(s));
    }
    get searchParams() {
      if (this.#sp === null) {
        this.#sp = new URLSearchParams(this.#p[8]);
        L.uspLink(this.#sp, this);
      }
      return this.#sp;
    }
    get hash() { return this.#p[9]; }
    set hash(v) {
      if (this.#nativeSet('hash', v)) return;
      const p = this.#p;
      let s = L.toUSV(v);
      if (s.startsWith('#')) s = s.slice(1);
      this.#reparse(rebuild(p, { hash: s === '' ? '' : '#' + s }));
    }
    toString() { return this.#p[0]; }
    toJSON() { return this.#p[0]; }
  }
  L.URL = URL;

  // =======================================================================================
  // TextEncoder / TextDecoder / atob / btoa
  // =======================================================================================
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input = '') {
      return new Uint8Array(N.textEncode(L.toUSV(input)));
    }
    encodeInto(source, destination) {
      if (!(destination instanceof Uint8Array)) throw new TypeError("Failed to execute 'encodeInto' on 'TextEncoder': parameter 2 is not of type 'Uint8Array'.");
      const s = `${source}`;
      let read = 0, written = 0;
      const cap = destination.length;
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        let units = 1;
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
          const d = s.charCodeAt(i + 1);
          if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); units = 2; } else c = 0xfffd;
        } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        const len = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        if (written + len > cap) break;
        if (len === 1) destination[written++] = c;
        else if (len === 2) { destination[written++] = 0xc0 | (c >> 6); destination[written++] = 0x80 | (c & 63); }
        else if (len === 3) { destination[written++] = 0xe0 | (c >> 12); destination[written++] = 0x80 | ((c >> 6) & 63); destination[written++] = 0x80 | (c & 63); }
        else { destination[written++] = 0xf0 | (c >> 18); destination[written++] = 0x80 | ((c >> 12) & 63); destination[written++] = 0x80 | ((c >> 6) & 63); destination[written++] = 0x80 | (c & 63); }
        read += units;
        i += units - 1;
      }
      return { read, written };
    }
  }
  const ENCODING_LABELS = new Map();
  function addLabels(name, labels) { for (const l of labels) ENCODING_LABELS.set(l, name); }
  addLabels('utf-8', ['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf-8', 'utf8', 'x-unicode20utf8']);
  addLabels('utf-16le', ['csunicode', 'iso-10646-ucs-2', 'ucs-2', 'unicode', 'unicodefeff', 'utf-16', 'utf-16le']);
  addLabels('utf-16be', ['unicodefffe', 'utf-16be']);
  addLabels('windows-1252', ['ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252']);
  addLabels('iso-8859-2', ['csisolatin2', 'iso-8859-2', 'iso-ir-101', 'iso8859-2', 'iso88592', 'iso_8859-2', 'iso_8859-2:1987', 'l2', 'latin2']);
  addLabels('iso-8859-15', ['csisolatin9', 'iso-8859-15', 'iso8859-15', 'iso885915', 'iso_8859-15', 'l9']);
  addLabels('windows-1251', ['cp1251', 'windows-1251', 'x-cp1251']);
  addLabels('shift_jis', ['csshiftjis', 'ms932', 'ms_kanji', 'shift-jis', 'shift_jis', 'sjis', 'windows-31j', 'x-sjis']);
  addLabels('euc-jp', ['cseucpkdfmtjapanese', 'euc-jp', 'x-euc-jp']);
  addLabels('gbk', ['chinese', 'csgb2312', 'csiso58gb231280', 'gb2312', 'gb_2312', 'gb_2312-80', 'gbk', 'iso-ir-58', 'x-gbk']);
  addLabels('gb18030', ['gb18030']);
  addLabels('big5', ['big5', 'big5-hkscs', 'cn-big5', 'csbig5', 'x-x-big5']);
  addLabels('euc-kr', ['cseuckr', 'csksc56011987', 'euc-kr', 'iso-ir-149', 'korean', 'ks_c_5601-1987', 'ks_c_5601-1989', 'ksc5601', 'ksc_5601', 'windows-949']);
  addLabels('koi8-r', ['cskoi8r', 'koi', 'koi8', 'koi8-r', 'koi8_r']);
  addLabels('x-user-defined', ['x-user-defined']);
  function resolveEncoding(label) {
    const l = L.stripWS(`${label}`).toLowerCase();
    const n = ENCODING_LABELS.get(l);
    if (n !== undefined) return n;
    try { N.textDecode(new ArrayBuffer(0), l, false); return l; } catch (_) { return null; }
  }
  L.resolveEncoding = resolveEncoding;
  class TextDecoder {
    #enc; #fatal; #ignoreBOM; #pending = null; #bomSeen = false;
    constructor(label = 'utf-8', options) {
      const enc = resolveEncoding(label);
      if (enc === null || enc === 'replacement') throw new RangeError(`Failed to construct 'TextDecoder': The encoding label provided ('${label}') is invalid.`);
      this.#enc = enc;
      this.#fatal = !!(options && options.fatal);
      this.#ignoreBOM = !!(options && options.ignoreBOM);
    }
    get encoding() { return this.#enc; }
    get fatal() { return this.#fatal; }
    get ignoreBOM() { return this.#ignoreBOM; }
    decode(input, options) {
      const stream = !!(options && options.stream);
      let bytes = input === undefined || input === null ? new Uint8Array(0) : toBytes(input);
      if (bytes === null) throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.");
      if (this.#pending !== null) {
        const merged = new Uint8Array(this.#pending.length + bytes.length);
        merged.set(this.#pending);
        merged.set(bytes, this.#pending.length);
        bytes = merged;
        this.#pending = null;
      }
      if (stream && bytes.length) {
        const keep = incompleteTail(bytes, this.#enc);
        if (keep > 0) {
          this.#pending = bytes.slice(bytes.length - keep);
          bytes = bytes.subarray(0, bytes.length - keep);
        }
      }
      let out;
      try {
        out = bytes.length === 0 ? '' : N.textDecode(bytes, this.#enc, this.#fatal);
      } catch (e) {
        this.#pending = null;
        throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The encoded data was not valid.");
      }
      if (!this.#bomSeen && out.length) {
        if (!this.#ignoreBOM && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
        this.#bomSeen = true;
      }
      if (!stream) { this.#bomSeen = false; this.#pending = null; }
      return out;
    }
  }
  function incompleteTail(bytes, enc) {
    const n = bytes.length;
    if (enc === 'utf-16le' || enc === 'utf-16be') return n % 2;
    if (enc !== 'utf-8') return 0;
    for (let k = 1; k <= 3 && k <= n; k++) {
      const b = bytes[n - k];
      if ((b & 0xc0) === 0x80) continue;
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      return need > k ? k : 0;
    }
    return 0;
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_INDEX = new Map(Array.from(B64, (c, i) => [c, i]));
  function btoa(data) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'btoa' on 'Window': 1 argument required, but only 0 present.");
    const s = `${data}`;
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new DOMException("Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range.", 'InvalidCharacterError');
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function atobBytes(data, method) {
    let s = `${data}`.replace(/[\t\n\f\r ]+/g, '');
    if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) {
      throw new DOMException(`Failed to execute '${method}' on 'Window': The string to be decoded is not correctly encoded.`, 'InvalidCharacterError');
    }
    const out = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64_INDEX.get(s[i]);
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
    }
    return out;
  }
  function atob(data) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'atob' on 'Window': 1 argument required, but only 0 present.");
    const bytes = atobBytes(data, 'atob');
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.slice(i, i + 8192));
    return out;
  }
  L.base64Encode = function (u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return btoa(s);
  };
  L.base64Decode = function (s) { return new Uint8Array(atobBytes(s, 'atob')); };

  // =======================================================================================
  // Blob / File / FileList / FileReader
  // =======================================================================================
  const blobURLs = new Map();
  L.blobURLs = blobURLs;
  class Blob {
    #bytes; #type;
    constructor(blobParts, options) {
      const chunks = [];
      let total = 0;
      if (blobParts !== undefined && blobParts !== null) {
        if (typeof blobParts !== 'object' || typeof blobParts[Symbol.iterator] !== 'function') {
          throw new TypeError("Failed to construct 'Blob': The provided value cannot be converted to a sequence.");
        }
        const native = options && options.endings === 'native';
        for (const part of blobParts) {
          let b;
          if (part instanceof Blob) b = part.#bytes;
          else {
            b = toBytes(part);
            if (b === null) {
              let s = L.toUSV(part);
              if (native) s = s.replace(/\r?\n/g, '\n');
              b = utf8Encode(s);
            }
          }
          chunks.push(b);
          total += b.byteLength;
        }
      }
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { all.set(c, off); off += c.byteLength; }
      this.#bytes = all;
      const t = options && options.type !== undefined ? `${options.type}` : '';
      this.#type = /^[ -~]*$/.test(t) ? t.toLowerCase() : '';
    }
    static {
      L.blobBytes = (b) => b.#bytes;
    }
    get size() { return this.#bytes.byteLength; }
    get type() { return this.#type; }
    slice(start, end, contentType) {
      const size = this.#bytes.byteLength;
      let s = start === undefined ? 0 : Math.trunc(Number(start)) || 0;
      let e = end === undefined ? size : Math.trunc(Number(end)) || 0;
      if (s < 0) s = Math.max(size + s, 0); else s = Math.min(s, size);
      if (e < 0) e = Math.max(size + e, 0); else e = Math.min(e, size);
      const b = new Blob([this.#bytes.slice(s, Math.max(s, e))], { type: contentType === undefined ? '' : `${contentType}` });
      return b;
    }
    text() { return L.resolvedPromise(utf8Decode(this.#bytes)); }
    arrayBuffer() { return L.resolvedPromise(copyToArrayBuffer(this.#bytes)); }
    bytes() { return L.resolvedPromise(this.#bytes.slice()); }
    stream() { return L.streamFromBytes(this.#bytes.slice()); }
  }
  L.newBlob = (bytes, type) => new Blob([bytes], { type: type || '' });
  class File extends Blob {
    #name; #lastModified;
    constructor(fileBits, fileName, options) {
      if (arguments.length < 2) throw new TypeError(`Failed to construct 'File': 2 arguments required, but only ${arguments.length} present.`);
      super(fileBits, options);
      this.#name = L.toUSV(fileName);
      this.#lastModified = options && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    }
    get name() { return this.#name; }
    get lastModified() { return this.#lastModified; }
    get lastModifiedDate() { return new Date(this.#lastModified); }
    get webkitRelativePath() { return ''; }
  }
  class FileList {
    #files;
    constructor(token, files) { if (token !== INTERNAL) throw L.illegal(); this.#files = files; }
    static { L.fileListItems = (f) => f.#files; }
    get length() { return this.#files.length; }
    item(i) { const f = this.#files[Number(i) >>> 0]; return f === undefined ? null : f; }
    *[Symbol.iterator]() { yield* this.#files; }
  }
  L.makeIndexed(FileList.prototype, (o, i) => L.fileListItems(o)[i], 16);
  L.createFileList = (files) => new FileList(INTERNAL, files);

  class FileReader extends EventTarget {
    #state = 0; #result = null; #error = null; #token = 0;
    get readyState() { return this.#state; }
    get result() { return this.#result; }
    get error() { return this.#error; }
    #read(blob, kind, encoding, method) {
      if (!(blob instanceof Blob)) throw new TypeError(`Failed to execute '${method}' on 'FileReader': parameter 1 is not of type 'Blob'.`);
      if (this.#state === 1) throw new DOMException(`Failed to execute '${method}' on 'FileReader': The object is already busy reading Blobs.`, 'InvalidStateError');
      this.#state = 1;
      this.#result = null;
      this.#error = null;
      const token = ++this.#token;
      const bytes = L.blobBytes(blob);
      const type = blob.type;
      L.postTask(() => {
        if (token !== this.#token) return;
        L.fire(this, 'loadstart', { loaded: 0, total: bytes.length, lengthComputable: true }, L.ProgressEvent);
        L.postTask(() => {
          if (token !== this.#token) return;
          let r;
          if (kind === 'arraybuffer') r = copyToArrayBuffer(bytes);
          else if (kind === 'binary') { r = ''; for (let i = 0; i < bytes.length; i += 8192) r += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); }
          else if (kind === 'dataurl') r = 'data:' + (type || 'application/octet-stream') + ';base64,' + L.base64Encode(bytes);
          else {
            let enc = encoding !== undefined ? resolveEncoding(encoding) : null;
            if (enc === null) {
              const m = /charset=([^;]+)/i.exec(type);
              enc = (m && resolveEncoding(m[1])) || 'utf-8';
            }
            r = enc === 'utf-8' ? utf8Decode(bytes) : N.textDecode(bytes, enc, false);
            if (r.charCodeAt(0) === 0xfeff) r = r.slice(1);
          }
          this.#state = 2;
          this.#result = r;
          L.fire(this, 'progress', { loaded: bytes.length, total: bytes.length, lengthComputable: true }, L.ProgressEvent);
          L.fire(this, 'load', { loaded: bytes.length, total: bytes.length, lengthComputable: true }, L.ProgressEvent);
          if (this.#state !== 1) L.fire(this, 'loadend', { loaded: bytes.length, total: bytes.length, lengthComputable: true }, L.ProgressEvent);
        });
      });
    }
    readAsArrayBuffer(blob) { this.#read(blob, 'arraybuffer', undefined, 'readAsArrayBuffer'); }
    readAsBinaryString(blob) { this.#read(blob, 'binary', undefined, 'readAsBinaryString'); }
    readAsText(blob, encoding) { this.#read(blob, 'text', encoding, 'readAsText'); }
    readAsDataURL(blob) { this.#read(blob, 'dataurl', undefined, 'readAsDataURL'); }
    abort() {
      if (this.#state === 0 || this.#state === 2) { this.#result = null; return; }
      this.#token++;
      this.#state = 2;
      this.#result = null;
      L.fire(this, 'abort', {}, L.ProgressEvent);
      if (this.#state !== 1) L.fire(this, 'loadend', {}, L.ProgressEvent);
    }
  }
  L.defineConstants([FileReader, FileReader.prototype], { EMPTY: 0, LOADING: 1, DONE: 2 });
  L.defineEventHandlers(FileReader.prototype, ['onloadstart', 'onprogress', 'onload', 'onabort', 'onerror', 'onloadend']);

  // =======================================================================================
  // FormData
  // =======================================================================================
  function toEntryValue(value, filename, argc) {
    if (value instanceof Blob) {
      if (!(value instanceof File) || filename !== undefined) {
        const name = filename !== undefined ? L.toUSV(filename) : value instanceof File ? value.name : 'blob';
        return new File([value], name, { type: value.type, lastModified: value instanceof File ? value.lastModified : undefined });
      }
      return value;
    }
    if (argc > 2) throw new TypeError("Failed to execute 'append' on 'FormData': parameter 2 is not of type 'Blob'.");
    return L.toUSV(value);
  }
  class FormData {
    #entries = [];
    constructor(form, submitter) {
      if (form !== undefined) {
        if (!(form instanceof L.HTMLFormElement)) throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
        if (submitter !== undefined && submitter !== null) {
          if (!L.isSubmitButton(submitter)) throw new TypeError("Failed to construct 'FormData': The specified element is not a submit button.");
          if (L.formOwnerOf(submitter) !== form) throw new DOMException("Failed to construct 'FormData': The specified element is not owned by this form element.", 'NotFoundError');
        }
        this.#entries = constructEntryList(form, submitter || null);
        L.fire(form, 'formdata', { bubbles: true, formData: this }, L.FormDataEvent);
      }
    }
    static { L.formDataEntries = (fd) => fd.#entries; }
    append(name, value, filename) {
      if (arguments.length < 2) throw new TypeError(`Failed to execute 'append' on 'FormData': 2 arguments required, but only ${arguments.length} present.`);
      this.#entries.push([L.toUSV(name), toEntryValue(value, filename, arguments.length)]);
    }
    delete(name) { const n = L.toUSV(name); this.#entries = this.#entries.filter((e) => e[0] !== n); }
    get(name) { const n = L.toUSV(name); const e = this.#entries.find((x) => x[0] === n); return e === undefined ? null : e[1]; }
    getAll(name) { const n = L.toUSV(name); return this.#entries.filter((x) => x[0] === n).map((x) => x[1]); }
    has(name) { const n = L.toUSV(name); return this.#entries.some((x) => x[0] === n); }
    set(name, value, filename) {
      if (arguments.length < 2) throw new TypeError(`Failed to execute 'set' on 'FormData': 2 arguments required, but only ${arguments.length} present.`);
      const n = L.toUSV(name);
      const v = toEntryValue(value, filename, arguments.length);
      const i = this.#entries.findIndex((x) => x[0] === n);
      if (i < 0) this.#entries.push([n, v]);
      else { this.#entries[i] = [n, v]; this.#entries = this.#entries.filter((x, j) => j <= i || x[0] !== n); }
    }
    forEach(cb, thisArg) { for (const e of this.#entries.slice()) Reflect.apply(cb, thisArg, [e[1], e[0], this]); }
    *entries() { for (let i = 0; i < this.#entries.length; i++) yield [this.#entries[i][0], this.#entries[i][1]]; }
    *keys() { for (let i = 0; i < this.#entries.length; i++) yield this.#entries[i][0]; }
    *values() { for (let i = 0; i < this.#entries.length; i++) yield this.#entries[i][1]; }
  }
  FormData.prototype[Symbol.iterator] = FormData.prototype.entries;
  function constructEntryList(form, submitter) {
    const out = [];
    for (const id of L.formControlIds(form).concat(imageButtonIds(form))) {
      const el = wrap(id);
      const ln = L.lnOf(el);
      if (N.closest(id, 'datalist') !== 0) continue;
      if (L.isDisabledFormControl(el)) continue;
      if (ln === 'button' || ln === 'fieldset' || ln === 'object' || ln === 'output') {
        if (ln !== 'button') continue;
        if (el !== submitter) continue;
      }
      let type = '';
      if (ln === 'input') {
        type = L.inputType(el);
        if ((type === 'submit' || type === 'image' || type === 'reset' || type === 'button') && el !== submitter) continue;
        if ((type === 'checkbox' || type === 'radio') && !N.getChecked(id)) continue;
      }
      const name = N.getAttr(id, 'name') || '';
      if (type === 'image') {
        const pfx = name === '' ? '' : name + '.';
        out.push([pfx + 'x', '0'], [pfx + 'y', '0']);
        continue;
      }
      if (name === '') continue;
      if (ln === 'select') {
        for (const o of L.selectedOptionIds(el)) if (!N.hasAttr(o, 'disabled')) out.push([name, L.optionValue(o)]);
      } else if (ln === 'input' && (type === 'checkbox' || type === 'radio')) {
        const v = N.getAttr(id, 'value');
        out.push([name, v === null ? 'on' : v]);
      } else if (ln === 'input' && type === 'file') {
        const files = L.fileListItems(L.fileListOf(el));
        if (files.length === 0) out.push([name, new File([], '', { type: 'application/octet-stream' })]);
        else for (const f of files) out.push([name, f]);
      } else if (ln === 'input' && type === 'hidden' && name.toLowerCase() === '_charset_') {
        out.push([name, 'UTF-8']);
      } else if (ln === 'textarea') {
        out.push([name, N.getValue(id).replace(/\r\n?/g, '\n')]);
      } else {
        out.push([name, el.value]);
      }
      const dirname = N.getAttr(id, 'dirname');
      if (dirname !== null && dirname !== '' && (ln === 'textarea' || (ln === 'input' && ['text', 'search'].includes(type)))) out.push([dirname, 'ltr']);
    }
    return out;
  }
  function imageButtonIds(form) {
    return N.querySelectorAll(idOf(form), 'input[type=image i]').filter((id) => L.formOwnerOf(wrap(id)) === form);
  }
  L.constructEntryList = constructEntryList;
  function multipartEncode(entries) {
    const boundary = '----WebKitFormBoundary' + Array.from(new Uint8Array(N.randomBytes(12)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('').slice(0, 16);
    const parts = [];
    let total = 0;
    const push = (u8) => { parts.push(u8); total += u8.byteLength; };
    const esc = (s) => s.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
    for (const [name, value] of entries) {
      let head = `--${boundary}\r\nContent-Disposition: form-data; name="${esc(name)}"`;
      if (value instanceof Blob) {
        head += `; filename="${esc(value instanceof File ? value.name : 'blob')}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`;
        push(utf8Encode(head));
        push(L.blobBytes(value));
        push(utf8Encode('\r\n'));
      } else {
        head += '\r\n\r\n';
        push(utf8Encode(head + value.replace(/\r(?!\n)|(?<!\r)\n/g, '\r\n') + '\r\n'));
      }
    }
    push(utf8Encode(`--${boundary}--\r\n`));
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.byteLength; }
    return { bytes: all, type: `multipart/form-data; boundary=${boundary}` };
  }
  function multipartDecode(bytes, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    if (!m) throw new TypeError('Failed to fetch');
    const boundary = '--' + (m[1] || m[2]);
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    const fd = new FormData();
    const sections = text.split(boundary);
    for (let i = 1; i < sections.length; i++) {
      let sec = sections[i];
      if (sec.startsWith('--')) break;
      sec = sec.replace(/^\r\n/, '').replace(/\r\n$/, '');
      const sep = sec.indexOf('\r\n\r\n');
      if (sep < 0) continue;
      const headers = sec.slice(0, sep);
      const body = sec.slice(sep + 4);
      const nm = /name="([^"]*)"/i.exec(headers);
      if (!nm) continue;
      const fn = /filename="([^"]*)"/i.exec(headers);
      const ct = /content-type:\s*([^\r\n]+)/i.exec(headers);
      const bodyBytes = Uint8Array.from(body, (c) => c.charCodeAt(0));
      if (fn) fd.append(utf8Decode(Uint8Array.from(nm[1], (c) => c.charCodeAt(0))), new File([bodyBytes], utf8Decode(Uint8Array.from(fn[1], (c) => c.charCodeAt(0))), { type: ct ? ct[1] : '' }));
      else fd.append(utf8Decode(Uint8Array.from(nm[1], (c) => c.charCodeAt(0))), utf8Decode(bodyBytes));
    }
    return fd;
  }

  // =======================================================================================
  // ReadableStream (minimal)
  // =======================================================================================
  class ReadableStreamDefaultController {
    #stream;
    constructor(token, stream) { if (token !== INTERNAL) throw L.illegal(); this.#stream = stream; }
    get desiredSize() { return L.rsDesired(this.#stream); }
    enqueue(chunk) { L.rsEnqueue(this.#stream, chunk); }
    close() { L.rsClose(this.#stream); }
    error(e) { L.rsError(this.#stream, e); }
  }
  class ReadableStream {
    #queue = []; #state = 'readable'; #error; #reader = null; #waiting = []; #source; #controller; #pulling = false; #hwm;
    constructor(underlyingSource, strategy) {
      const src = underlyingSource || {};
      this.#source = src;
      this.#hwm = strategy && strategy.highWaterMark !== undefined ? Number(strategy.highWaterMark) : 1;
      this.#controller = new ReadableStreamDefaultController(INTERNAL, this);
      if (typeof src.start === 'function') {
        try {
          const r = Reflect.apply(src.start, src, [this.#controller]);
          if (r && typeof r.then === 'function') r.then(() => this.#pull(), (e) => L.rsError(this, e));
          else L.microtask(() => this.#pull());
        } catch (e) { L.rsError(this, e); }
      } else {
        L.microtask(() => this.#pull());
      }
    }
    static {
      L.rsEnqueue = (s, chunk) => {
        if (s.#state !== 'readable') throw new TypeError('Cannot enqueue a chunk into a closed or errored stream');
        const w = s.#waiting.shift();
        if (w !== undefined) w.resolve({ value: chunk, done: false });
        else s.#queue.push(chunk);
      };
      L.rsClose = (s) => {
        if (s.#state !== 'readable') return;
        s.#state = 'closed';
        if (s.#queue.length === 0) for (const w of s.#waiting.splice(0)) w.resolve({ value: undefined, done: true });
      };
      L.rsError = (s, e) => {
        if (s.#state !== 'readable') return;
        s.#state = 'errored';
        s.#error = e;
        s.#queue = [];
        for (const w of s.#waiting.splice(0)) w.reject(e);
      };
      L.rsDesired = (s) => (s.#state === 'readable' ? s.#hwm - s.#queue.length : s.#state === 'closed' ? 0 : null);
      L.rsRead = (s) => {
        if (s.#queue.length) {
          const v = s.#queue.shift();
          if (s.#queue.length === 0 && s.#state === 'closed') for (const w of s.#waiting.splice(0)) w.resolve({ value: undefined, done: true });
          s.#pull();
          return L.resolvedPromise({ value: v, done: false });
        }
        if (s.#state === 'closed') return L.resolvedPromise({ value: undefined, done: true });
        if (s.#state === 'errored') return L.rejectedPromise(s.#error);
        const p = L.newPromise((resolve, reject) => s.#waiting.push({ resolve, reject }));
        s.#pull();
        return p;
      };
      L.rsLock = (s, r) => { s.#reader = r; };
      L.rsReader = (s) => s.#reader;
      L.rsCancel = (s, reason) => {
        s.#queue = [];
        L.rsClose(s);
        const c = s.#source.cancel;
        if (typeof c === 'function') { try { return L.resolvedPromise(Reflect.apply(c, s.#source, [reason])).then(() => undefined); } catch (e) { return L.rejectedPromise(e); } }
        return L.resolvedPromise(undefined);
      };
    }
    #pull() {
      if (this.#pulling || this.#state !== 'readable') return;
      const pull = this.#source.pull;
      if (typeof pull !== 'function') return;
      if (this.#queue.length >= this.#hwm && this.#waiting.length === 0) return;
      this.#pulling = true;
      let r;
      try { r = Reflect.apply(pull, this.#source, [this.#controller]); } catch (e) { this.#pulling = false; L.rsError(this, e); return; }
      L.resolvedPromise(r).then(() => {
        this.#pulling = false;
        if (this.#waiting.length > 0 || this.#queue.length < this.#hwm) this.#pull();
      }, (e) => { this.#pulling = false; L.rsError(this, e); });
    }
    get locked() { return this.#reader !== null; }
    cancel(reason) {
      if (this.#reader !== null) return L.rejectedPromise(new TypeError('Cannot cancel a locked stream'));
      return L.rsCancel(this, reason);
    }
    getReader(options) {
      if (options && options.mode === 'byob') throw new TypeError("Failed to execute 'getReader' on 'ReadableStream': BYOB readers are not supported.");
      return new ReadableStreamDefaultReader(this);
    }
    tee() {
      const reader = this.getReader();
      let c1, c2;
      const pullAll = () => reader.read().then(({ value, done }) => {
        if (done) { try { c1.close(); } catch (_) { } try { c2.close(); } catch (_) { } return; }
        try { c1.enqueue(value); } catch (_) { }
        try { c2.enqueue(value); } catch (_) { }
        return pullAll();
      }, (e) => { c1.error(e); c2.error(e); });
      const a = new ReadableStream({ start(c) { c1 = c; } });
      const b = new ReadableStream({ start(c) { c2 = c; } });
      L.microtask(pullAll);
      return [a, b];
    }
    async pipeTo(dest, options) {
      const reader = this.getReader();
      const writer = dest.getWriter();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        if (!(options && options.preventClose)) await writer.close();
      } finally {
        reader.releaseLock();
        writer.releaseLock();
      }
    }
    pipeThrough(transform, options) {
      this.pipeTo(transform.writable, options).catch(() => { });
      return transform.readable;
    }
    values(options) {
      const reader = this.getReader();
      const preventCancel = !!(options && options.preventCancel);
      return {
        next: () => reader.read(),
        return: (v) => { if (!preventCancel) reader.cancel(v); reader.releaseLock(); return L.resolvedPromise({ value: v, done: true }); },
        [Symbol.asyncIterator]() { return this; },
      };
    }
    [Symbol.asyncIterator](options) { return this.values(options); }
    static from(asyncIterable) {
      const it = asyncIterable[Symbol.asyncIterator] ? asyncIterable[Symbol.asyncIterator]() : asyncIterable[Symbol.iterator]();
      return new ReadableStream({
        async pull(c) {
          const { value, done } = await it.next();
          if (done) c.close(); else c.enqueue(value);
        },
      });
    }
  }
  class ReadableStreamDefaultReader {
    #stream;
    constructor(stream) {
      if (!(stream instanceof ReadableStream)) throw new TypeError("Failed to construct 'ReadableStreamDefaultReader': parameter 1 is not of type 'ReadableStream'.");
      if (L.rsReader(stream) !== null) throw new TypeError("Failed to construct 'ReadableStreamDefaultReader': This stream has already been locked for exclusive reading by another reader");
      this.#stream = stream;
      L.rsLock(stream, this);
    }
    read() {
      if (this.#stream === null) return L.rejectedPromise(new TypeError('This readable stream reader has been released and cannot be used to read from its previous owner stream'));
      return L.rsRead(this.#stream);
    }
    releaseLock() { if (this.#stream !== null) { L.rsLock(this.#stream, null); this.#stream = null; } }
    cancel(reason) { return this.#stream === null ? L.resolvedPromise(undefined) : L.rsCancel(this.#stream, reason); }
    get closed() { return L.newPromise(() => { }); }
  }
  class WritableStream {
    #sink; #writer = null;
    constructor(sink) { this.#sink = sink || {}; if (typeof this.#sink.start === 'function') this.#sink.start({ error() { } }); }
    get locked() { return this.#writer !== null; }
    getWriter() {
      const sink = this.#sink;
      const self = this;
      const w = {
        write(chunk) { return L.resolvedPromise(typeof sink.write === 'function' ? sink.write(chunk, {}) : undefined); },
        close() { return L.resolvedPromise(typeof sink.close === 'function' ? sink.close() : undefined); },
        abort(r) { return L.resolvedPromise(typeof sink.abort === 'function' ? sink.abort(r) : undefined); },
        releaseLock() { L.wsSetWriter(self, null); },
        get ready() { return L.resolvedPromise(undefined); },
        get closed() { return L.newPromise(() => { }); },
        get desiredSize() { return 1; },
      };
      this.#writer = w;
      return w;
    }
    close() { return L.resolvedPromise(typeof this.#sink.close === 'function' ? this.#sink.close() : undefined); }
    abort(r) { return L.resolvedPromise(typeof this.#sink.abort === 'function' ? this.#sink.abort(r) : undefined); }
    static { L.wsSetWriter = (s, w) => { s.#writer = w; }; }
  }
  class TransformStream {
    #readable; #writable;
    constructor(transformer) {
      const t = transformer || {};
      let ctrl;
      this.#readable = new ReadableStream({ start(c) { ctrl = c; } });
      const controller = { enqueue: (c) => ctrl.enqueue(c), terminate: () => ctrl.close(), error: (e) => ctrl.error(e), get desiredSize() { return 1; } };
      if (typeof t.start === 'function') t.start(controller);
      this.#writable = new WritableStream({
        write(chunk) { if (typeof t.transform === 'function') return t.transform(chunk, controller); controller.enqueue(chunk); return undefined; },
        close() { const r = typeof t.flush === 'function' ? t.flush(controller) : undefined; return L.resolvedPromise(r).then(() => ctrl.close()); },
      });
    }
    get readable() { return this.#readable; }
    get writable() { return this.#writable; }
  }
  L.streamFromBytes = function (u8) {
    return new ReadableStream({
      start(c) { if (u8.byteLength) c.enqueue(u8); c.close(); },
    });
  };
  async function readAllStream(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const b = toBytes(value) || (typeof value === 'string' ? utf8Encode(value) : null);
      if (b === null) throw new TypeError('Received non-Uint8Array chunk');
      chunks.push(b);
      total += b.byteLength;
    }
    reader.releaseLock();
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    return all;
  }

  // =======================================================================================
  // Headers
  // =======================================================================================
  const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const FORBIDDEN_REQ = new Set(['accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect',
    'host', 'keep-alive', 'origin', 'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via']);
  function forbiddenRequestHeader(n) { return FORBIDDEN_REQ.has(n) || n.startsWith('proxy-') || n.startsWith('sec-'); }
  function normalizeHeaderValue(v) { return `${v}`.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ''); }
  function validateHeader(name, value, method) {
    if (!TOKEN_RE.test(name)) throw new TypeError(`Failed to execute '${method}' on 'Headers': Invalid name`);
    if (/[\0\r\n]/.test(value)) throw new TypeError(`Failed to execute '${method}' on 'Headers': Invalid value`);
  }
  class Headers {
    #list = []; // [lowerName, value, originalName]
    #guard = 'none';
    constructor(init) {
      if (init !== undefined && init !== null) fillHeaders(this, init);
    }
    static {
      L.headersGuard = (h, g) => { h.#guard = g; };
      L.headersGetGuard = (h) => h.#guard;
      L.headersList = (h) => h.#list;
      L.headersSetList = (h, l) => { h.#list = l; };
      L.headersRaw = (h) => h.#list;
    }
    #check(lname) {
      if (this.#guard === 'immutable') throw new TypeError("Failed to execute on 'Headers': Headers are immutable");
      if (this.#guard === 'request' && forbiddenRequestHeader(lname)) return false;
      if (this.#guard === 'response' && (lname === 'set-cookie' || lname === 'set-cookie2')) return false;
      return true;
    }
    append(name, value) {
      const n = `${name}`, v = normalizeHeaderValue(value);
      validateHeader(n, v, 'append');
      const l = n.toLowerCase();
      if (!this.#check(l)) return;
      this.#list.push([l, v, n]);
    }
    delete(name) {
      const n = `${name}`;
      if (!TOKEN_RE.test(n)) throw new TypeError("Failed to execute 'delete' on 'Headers': Invalid name");
      const l = n.toLowerCase();
      if (!this.#check(l)) return;
      this.#list = this.#list.filter((e) => e[0] !== l);
    }
    get(name) {
      const n = `${name}`;
      if (!TOKEN_RE.test(n)) throw new TypeError("Failed to execute 'get' on 'Headers': Invalid name");
      const l = n.toLowerCase();
      const vals = this.#list.filter((e) => e[0] === l).map((e) => e[1]);
      return vals.length === 0 ? null : vals.join(', ');
    }
    getSetCookie() { return this.#list.filter((e) => e[0] === 'set-cookie').map((e) => e[1]); }
    has(name) {
      const n = `${name}`;
      if (!TOKEN_RE.test(n)) throw new TypeError("Failed to execute 'has' on 'Headers': Invalid name");
      const l = n.toLowerCase();
      return this.#list.some((e) => e[0] === l);
    }
    set(name, value) {
      const n = `${name}`, v = normalizeHeaderValue(value);
      validateHeader(n, v, 'set');
      const l = n.toLowerCase();
      if (!this.#check(l)) return;
      const i = this.#list.findIndex((e) => e[0] === l);
      if (i < 0) this.#list.push([l, v, n]);
      else {
        this.#list[i] = [l, v, n];
        this.#list = this.#list.filter((e, j) => j <= i || e[0] !== l);
      }
    }
    #sorted() {
      const names = Array.from(new Set(this.#list.map((e) => e[0]))).sort();
      const out = [];
      for (const n of names) {
        if (n === 'set-cookie') { for (const e of this.#list) if (e[0] === n) out.push([n, e[1]]); }
        else out.push([n, this.#list.filter((e) => e[0] === n).map((e) => e[1]).join(', ')]);
      }
      return out;
    }
    forEach(cb, thisArg) { for (const [k, v] of this.#sorted()) Reflect.apply(cb, thisArg, [v, k, this]); }
    *entries() { yield* this.#sorted(); }
    *keys() { for (const e of this.#sorted()) yield e[0]; }
    *values() { for (const e of this.#sorted()) yield e[1]; }
  }
  Headers.prototype[Symbol.iterator] = Headers.prototype.entries;
  function fillHeaders(h, init) {
    if (init instanceof Headers) {
      for (const e of L.headersList(init)) h.append(e[2], e[1]);
      return;
    }
    if (typeof init !== 'object' && typeof init !== 'function') throw new TypeError("Failed to construct 'Headers': The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'.");
    if (typeof init[Symbol.iterator] === 'function') {
      for (const pair of init) {
        const a = Array.from(pair);
        if (a.length !== 2) throw new TypeError("Failed to construct 'Headers': Invalid value");
        h.append(a[0], a[1]);
      }
      return;
    }
    for (const k of Reflect.ownKeys(init)) {
      if (typeof k !== 'string') continue;
      const d = Reflect.getOwnPropertyDescriptor(init, k);
      if (d && d.enumerable) h.append(k, init[k]);
    }
  }
  function headersFlat(h) {
    const out = [];
    for (const e of L.headersList(h)) out.push(e[2], e[1]);
    return out;
  }
  function headersFromFlat(flat, guard) {
    const h = new Headers();
    if (flat) {
      for (let i = 0; i + 1 < flat.length; i += 2) {
        try { h.append(`${flat[i]}`, `${flat[i + 1]}`); } catch (_) { /* skip invalid */ }
      }
    }
    L.headersGuard(h, guard);
    return h;
  }
  L.Headers = Headers;
  L.headersFlat = headersFlat;
  L.headersFromFlat = headersFromFlat;

  // =======================================================================================
  // Body mixin, Request, Response
  // =======================================================================================
  // Body record: {bytes: Uint8Array|null, stream: ReadableStream|null, used: bool, type: string|null}
  function extractBody(body, keepalive) {
    if (body === null || body === undefined) return null;
    if (typeof body === 'string') return { bytes: utf8Encode(body), stream: null, type: 'text/plain;charset=UTF-8' };
    if (body instanceof URLSearchParams) return { bytes: utf8Encode(body.toString()), stream: null, type: 'application/x-www-form-urlencoded;charset=UTF-8' };
    if (body instanceof FormData) { const m = multipartEncode(L.formDataEntries(body)); return { bytes: m.bytes, stream: null, type: m.type }; }
    if (body instanceof Blob) return { bytes: L.blobBytes(body), stream: null, type: body.type || null };
    const b = toBytes(body);
    if (b !== null) return { bytes: b.slice(), stream: null, type: null };
    if (body instanceof ReadableStream) {
      if (keepalive) throw new TypeError("Failed to construct 'Request': keepalive cannot be set for a request with a ReadableStream body.");
      return { bytes: null, stream: body, type: null };
    }
    return { bytes: utf8Encode(`${body}`), stream: null, type: 'text/plain;charset=UTF-8' };
  }
  L.extractBody = extractBody;
  const bodies = new WeakMap(); // Request/Response -> body record (or null)
  function bodyOf(o) { return bodies.get(o); }
  function consume(o, method) {
    const b = bodies.get(o);
    if (b === undefined) return L.rejectedPromise(new TypeError('Illegal invocation'));
    if (b !== null && b.used) return L.rejectedPromise(new TypeError(`Failed to execute '${method}' on '${o instanceof Request ? 'Request' : 'Response'}': body stream already read`));
    if (b === null) return L.resolvedPromise(new Uint8Array(0));
    if (b.stream !== null && b.stream.locked) return L.rejectedPromise(new TypeError(`Failed to execute '${method}': body stream is locked`));
    b.used = true;
    if (b.bytes !== null) return L.resolvedPromise(b.bytes);
    return readAllStream(b.stream);
  }
  function contentTypeOf(o) {
    const h = o.headers;
    const v = h.get('content-type');
    return v === null ? '' : v;
  }
  const BodyMixin = {
    get body() {
      const b = bodies.get(this);
      if (b === undefined) throw new TypeError('Illegal invocation');
      if (b === null) return null;
      if (b.stream === null) b.stream = L.streamFromBytes(b.bytes);
      return b.stream;
    },
    get bodyUsed() {
      const b = bodies.get(this);
      if (b === undefined) throw new TypeError('Illegal invocation');
      return b !== null && (b.used || (b.stream !== null && b.stream.locked));
    },
    arrayBuffer() { return consume(this, 'arrayBuffer').then((u8) => copyToArrayBuffer(u8)); },
    bytes() { return consume(this, 'bytes').then((u8) => u8.slice()); },
    blob() {
      const type = contentTypeOf(this);
      return consume(this, 'blob').then((u8) => new Blob([u8], { type }));
    },
    text() { return consume(this, 'text').then((u8) => utf8Decode(u8)); },
    json() { return consume(this, 'json').then((u8) => JSON.parse(utf8Decode(u8))); },
    formData() {
      const type = contentTypeOf(this);
      return consume(this, 'formData').then((u8) => {
        const t = type.toLowerCase();
        if (t.startsWith('multipart/form-data')) return multipartDecode(u8, type);
        if (t.startsWith('application/x-www-form-urlencoded')) {
          const fd = new FormData();
          for (const [k, v] of parseQuery(utf8Decode(u8))) fd.append(k, v);
          return fd;
        }
        throw new TypeError("Failed to execute 'formData': Invalid MIME type");
      });
    },
  };

  const METHOD_NORMALIZE = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
  const reqData = new WeakMap();
  function rq(o) { const d = reqData.get(o); if (d === undefined) throw new TypeError('Illegal invocation'); return d; }
  class Request {
    constructor(input, init) {
      if (arguments.length === 0) throw new TypeError("Failed to construct 'Request': 1 argument required, but only 0 present.");
      const opts = init === undefined || init === null ? {} : init;
      let d;
      let inputBody = null;
      if (input instanceof Request) {
        const s = rq(input);
        d = Object.assign({}, s);
        d.headers = null;
        inputBody = bodies.get(input);
        if (inputBody !== null && (inputBody.used)) throw new TypeError("Failed to construct 'Request': Cannot construct a Request with a Request object that has already been used.");
        d.headerInit = input.headers;
      } else {
        const parsed = N.urlParse(L.toUSV(input), L.baseURL());
        if (parsed === null) throw new TypeError(`Failed to construct 'Request': Failed to parse URL from ${input}`);
        if (parsed[2] !== '' || parsed[3] !== '') throw new TypeError(`Failed to construct 'Request': Request cannot be constructed from a URL that includes credentials: ${input}`);
        d = { url: parsed[0], method: 'GET', mode: 'cors', credentials: 'same-origin', cache: 'default', redirect: 'follow',
          referrer: 'about:client', referrerPolicy: '', integrity: '', keepalive: false, destination: '', priority: 'auto', headerInit: null };
      }
      if (opts.method !== undefined) {
        const m = `${opts.method}`;
        if (!TOKEN_RE.test(m)) throw new TypeError(`Failed to construct 'Request': '${m}' is not a valid HTTP method.`);
        const up = m.toUpperCase();
        if (up === 'CONNECT' || up === 'TRACE' || up === 'TRACK') throw new TypeError(`Failed to construct 'Request': '${m}' HTTP method is unsupported.`);
        d.method = METHOD_NORMALIZE.has(up) ? up : m;
      }
      if (opts.mode !== undefined) {
        const m = `${opts.mode}`;
        if (m === 'navigate') throw new TypeError("Failed to construct 'Request': Cannot construct a Request with a RequestInit whose mode member is set as 'navigate'.");
        if (!['same-origin', 'no-cors', 'cors'].includes(m)) throw new TypeError(`Failed to construct 'Request': The provided value '${m}' is not a valid enum value of type RequestMode.`);
        d.mode = m;
      }
      for (const [k, allowed] of [['credentials', ['omit', 'same-origin', 'include']], ['cache', ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached']], ['redirect', ['follow', 'error', 'manual']], ['priority', ['high', 'low', 'auto']]]) {
        if (opts[k] !== undefined) {
          const v = `${opts[k]}`;
          if (!allowed.includes(v)) throw new TypeError(`Failed to construct 'Request': The provided value '${v}' is not a valid enum value.`);
          d[k] = v;
        }
      }
      if (opts.referrer !== undefined) {
        const r = `${opts.referrer}`;
        if (r === '') d.referrer = '';
        else { const p = N.urlParse(r, L.baseURL()); d.referrer = p === null ? 'about:client' : p[0]; }
      }
      if (opts.referrerPolicy !== undefined) d.referrerPolicy = `${opts.referrerPolicy}`;
      if (opts.integrity !== undefined) d.integrity = `${opts.integrity}`;
      if (opts.keepalive !== undefined) d.keepalive = !!opts.keepalive;
      const signal = L.createAbortSignal();
      const src = opts.signal !== undefined ? opts.signal : (input instanceof Request ? input.signal : null);
      if (src !== null && src !== undefined) {
        if (!L.isAbortSignal(src)) throw new TypeError("Failed to construct 'Request': member signal is not of type AbortSignal.");
        if (L.signalAborted(src)) L.signalAbortInternal(signal, L.signalReason(src));
        else L.addAbortAlgorithm(src, () => L.signalAbortInternal(signal, L.signalReason(src)));
      }
      d.signal = signal;
      const headers = new Headers();
      L.headersGuard(headers, d.mode === 'no-cors' ? 'request-no-cors' : 'request');
      const hinit = opts.headers !== undefined ? opts.headers : d.headerInit;
      if (hinit !== null && hinit !== undefined) fillHeaders(headers, hinit);
      L.headersGuard(headers, 'request');
      d.headers = headers;
      let body = inputBody;
      if (opts.body !== undefined) body = extractBody(opts.body, d.keepalive);
      if (body !== null && body !== undefined) {
        if (d.method === 'GET' || d.method === 'HEAD') throw new TypeError("Failed to construct 'Request': Request with GET/HEAD method cannot have body.");
        if (body.type && !headers.has('content-type')) { L.headersGuard(headers, 'none'); headers.append('Content-Type', body.type); L.headersGuard(headers, 'request'); }
        if (input instanceof Request && opts.body === undefined && inputBody !== null) inputBody.used = true;
        body = { bytes: body.bytes, stream: body.stream, used: false, type: body.type };
      } else {
        body = null;
      }
      delete d.headerInit;
      reqData.set(this, d);
      bodies.set(this, body);
    }
    get method() { return rq(this).method; }
    get url() { return rq(this).url; }
    get headers() { return rq(this).headers; }
    get destination() { return rq(this).destination; }
    get referrer() { const r = rq(this).referrer; return r === 'about:client' ? 'about:client' : r; }
    get referrerPolicy() { return rq(this).referrerPolicy; }
    get mode() { return rq(this).mode; }
    get credentials() { return rq(this).credentials; }
    get cache() { return rq(this).cache; }
    get redirect() { return rq(this).redirect; }
    get integrity() { return rq(this).integrity; }
    get keepalive() { return rq(this).keepalive; }
    get signal() { return rq(this).signal; }
    get isHistoryNavigation() { return false; }
    get duplex() { return 'half'; }
    get priority() { return rq(this).priority; }
    clone() {
      const b = bodies.get(this);
      if (b !== null && b.used) throw new TypeError("Failed to execute 'clone' on 'Request': Request body is already used");
      const r = new Request(this, {});
      if (b !== null && b.stream !== null && b.bytes === null) {
        const [s1, s2] = b.stream.tee();
        b.stream = s1;
        bodies.set(r, { bytes: null, stream: s2, used: false, type: b.type });
      } else {
        bodies.set(r, b === null ? null : { bytes: b.bytes, stream: null, used: false, type: b.type });
      }
      return r;
    }
  }
  L.mixin(Request.prototype, BodyMixin);

  const respData = new WeakMap();
  function rs(o) { const d = respData.get(o); if (d === undefined) throw new TypeError('Illegal invocation'); return d; }
  const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
  const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
  class Response {
    constructor(body = null, init) {
      const opts = init === undefined || init === null ? {} : init;
      const status = opts.status === undefined ? 200 : Number(opts.status);
      if (!(status >= 200 && status <= 599) || !Number.isInteger(status)) throw new RangeError(`Failed to construct 'Response': The status provided (${opts.status}) is outside the range [200, 599].`);
      const statusText = opts.statusText === undefined ? '' : `${opts.statusText}`;
      if (/[^\t\x20-\x7e\x80-\xff]/.test(statusText)) throw new TypeError("Failed to construct 'Response': Invalid statusText");
      const headers = new Headers();
      if (opts.headers !== undefined && opts.headers !== null) fillHeaders(headers, opts.headers);
      L.headersGuard(headers, 'response');
      let b = null;
      if (body !== null && body !== undefined) {
        if (NULL_BODY_STATUS.has(status)) throw new TypeError("Failed to construct 'Response': Response with null body status cannot have body");
        const ex = extractBody(body, false);
        b = { bytes: ex.bytes, stream: ex.stream, used: false, type: ex.type };
        if (ex.type && !headers.has('content-type')) { L.headersGuard(headers, 'none'); headers.append('Content-Type', ex.type); L.headersGuard(headers, 'response'); }
      }
      respData.set(this, { type: 'default', url: '', status, statusText, headers, redirected: false });
      bodies.set(this, b);
    }
    static error() {
      const r = new Response(null, { status: 200 });
      const d = rs(r);
      d.type = 'error'; d.status = 0;
      L.headersGuard(d.headers, 'immutable');
      return r;
    }
    static redirect(url, status = 302) {
      const p = N.urlParse(L.toUSV(url), L.baseURL());
      if (p === null) throw new TypeError(`Failed to execute 'redirect' on 'Response': Failed to parse URL from ${url}`);
      const s = Number(status);
      if (![301, 302, 303, 307, 308].includes(s)) throw new RangeError(`Failed to execute 'redirect' on 'Response': Invalid status code`);
      const r = new Response(null, { status: s === 301 || s === 302 || s === 303 || s === 307 || s === 308 ? 200 : s });
      const d = rs(r);
      d.status = s;
      L.headersGuard(d.headers, 'none');
      d.headers.set('Location', p[0]);
      L.headersGuard(d.headers, 'immutable');
      return r;
    }
    static json(data, init) {
      const text = JSON.stringify(data);
      if (text === undefined) throw new TypeError("Failed to execute 'json' on 'Response': The data is not JSON serializable");
      const opts = Object.assign({}, init || {});
      const r = new Response(text, opts);
      const h = rs(r).headers;
      if (!(init && init.headers && new Headers(init.headers).has('content-type'))) {
        L.headersGuard(h, 'none'); h.set('Content-Type', 'application/json'); L.headersGuard(h, 'response');
      }
      return r;
    }
    get type() { return rs(this).type; }
    get url() { return rs(this).url; }
    get redirected() { return rs(this).redirected; }
    get status() { return rs(this).status; }
    get ok() { const s = rs(this).status; return s >= 200 && s <= 299; }
    get statusText() { return rs(this).statusText; }
    get headers() { return rs(this).headers; }
    clone() {
      const b = bodies.get(this);
      if (b !== null && (b.used || (b.stream !== null && b.stream.locked))) throw new TypeError("Failed to execute 'clone' on 'Response': Response body is already used");
      const d = rs(this);
      const r = Object.create(Response.prototype);
      const h = new Headers();
      L.headersSetList(h, L.headersList(d.headers).map((e) => e.slice()));
      L.headersGuard(h, L.headersGetGuard(d.headers));
      respData.set(r, Object.assign({}, d, { headers: h }));
      if (b !== null && b.stream !== null && b.bytes === null) {
        const [s1, s2] = b.stream.tee();
        b.stream = s1;
        bodies.set(r, { bytes: null, stream: s2, used: false, type: b.type });
      } else {
        bodies.set(r, b === null ? null : { bytes: b.bytes, stream: null, used: false, type: b.type });
      }
      return r;
    }
  }
  L.mixin(Response.prototype, BodyMixin);
  function makeResponse(fields, bodyBytes) {
    const r = Object.create(Response.prototype);
    respData.set(r, fields);
    bodies.set(r, bodyBytes === null ? null : { bytes: bodyBytes, stream: null, used: false, type: null });
    return r;
  }
  L.makeResponse = makeResponse;

  // =======================================================================================
  // fetch
  // =======================================================================================
  let nextReqId = 1;
  const pendingFetches = new Map(); // reqId -> fn(status, statusText, finalUrl, headersFlat, body, error)
  // `credentials` ('omit' | 'same-origin' | 'include'), `cache` and `redirect` ('follow' |
  // 'error' | 'manual') are optional trailing arguments of N.fetch (see NATIVE_API.md Additions).
  L.startNativeFetch = function (method, url, flat, body, mode, done, credentials, cache, redirect) {
    const reqId = nextReqId++;
    pendingFetches.set(reqId, done);
    try {
      N.fetch(reqId, method, url, flat, body, mode, credentials || 'same-origin', cache || 'default', redirect || 'follow');
    } catch (e) {
      pendingFetches.delete(reqId);
      const err = e;
      L.microtask(() => done(0, '', url, [], null, err && err.message ? err.message : 'fetch failed'));
    }
    return reqId;
  };
  L.cancelNativeFetch = function (reqId) {
    if (pendingFetches.delete(reqId)) N.abortFetch(reqId);
  };
  L.onFetch = function (reqId, status, statusText, finalUrl, flat, body, error) {
    const done = pendingFetches.get(reqId);
    if (done === undefined) return;
    pendingFetches.delete(reqId);
    done(status, statusText, finalUrl, flat, body, error);
  };
  function originOf(url) { const p = N.urlParse(url, null); return p === null ? 'null' : p[10]; }
  const SAFELISTED_RESPONSE = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
  function stripFragment(u) { const i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }
  function parseDataURL(url) {
    const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(url);
    if (!m) return null;
    let type = m[1].trim() || 'text/plain;charset=US-ASCII';
    if (type.startsWith(';')) type = 'text/plain' + type;
    let bytes;
    if (m[2]) {
      try { bytes = L.base64Decode(decodeURIComponentSafe(m[3])); } catch (_) { return null; }
    } else {
      bytes = percentDecodeBytes(m[3]);
    }
    return { type, bytes };
  }
  function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }
  L.parseDataURL = parseDataURL;
  function fetch(input, init) {
    let request;
    try {
      request = new Request(input, init);
    } catch (e) {
      return L.rejectedPromise(e);
    }
    const d = rq(request);
    const signal = d.signal;
    if (L.signalAborted(signal)) return L.rejectedPromise(L.signalReason(signal));
    return L.newPromise((resolve, reject) => {
      const url = d.url;
      const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
      const fail = () => reject(new TypeError('Failed to fetch'));
      if (scheme === 'blob') {
        const blob = blobURLs.get(stripFragment(url));
        if (blob === undefined || d.method !== 'GET') { fail(); return; }
        const h = headersFromFlat(['Content-Type', blob.type, 'Content-Length', String(blob.size)], 'immutable');
        resolve(makeResponse({ type: 'basic', url, status: 200, statusText: 'OK', headers: h, redirected: false }, L.blobBytes(blob)));
        return;
      }
      if (scheme === 'data') {
        const parsed = parseDataURL(url);
        if (parsed === null) { fail(); return; }
        const h = headersFromFlat(['Content-Type', parsed.type], 'immutable');
        resolve(makeResponse({ type: 'basic', url, status: 200, statusText: 'OK', headers: h, redirected: false }, parsed.bytes));
        return;
      }
      if (scheme === 'about') {
        if (url === 'about:blank') { resolve(makeResponse({ type: 'basic', url, status: 200, statusText: 'OK', headers: headersFromFlat(['Content-Type', 'text/html;charset=utf-8'], 'immutable'), redirected: false }, new Uint8Array(0))); return; }
        fail(); return;
      }
      if (scheme !== 'http' && scheme !== 'https' && scheme !== 'file') { fail(); return; }
      const docOrigin = L.location.origin;
      const sameOrigin = originOf(url) === docOrigin;
      if (d.mode === 'same-origin' && !sameOrigin) { fail(); return; }
      const b = bodies.get(request);
      const bodyP = b === null ? L.resolvedPromise(null) : (b.used = true, b.stream !== null && b.bytes === null ? readAllStream(b.stream) : L.resolvedPromise(b.bytes));
      bodyP.then((bytes) => {
        if (L.signalAborted(signal)) { reject(L.signalReason(signal)); return; }
        const flat = headersFlat(d.headers);
        let finished = false;
        const reqId = L.startNativeFetch(d.method, url, flat, bytes === null ? null : copyToArrayBuffer(bytes), d.mode, (status, statusText, finalUrl, rflat, rbody, error) => {
          finished = true;
          if (error !== null && error !== undefined || status === 0) { reject(new TypeError('Failed to fetch')); return; }
          // Rust does not follow redirects for redirect mode "error"/"manual": the 3xx arrives here
          if (d.redirect === 'error' && REDIRECT_STATUS.has(status)) { reject(new TypeError('Failed to fetch')); return; }
          if (d.redirect === 'manual' && REDIRECT_STATUS.has(status)) {
            // Rust did not follow the redirect: expose an opaque-redirect filtered response
            resolve(makeResponse({ type: 'opaqueredirect', url: stripFragment(url), status: 0, statusText: '', headers: headersFromFlat([], 'immutable'), redirected: false }, null));
            return;
          }
          const fu = stripFragment(`${finalUrl || url}`);
          const redirected = fu !== stripFragment(url);
          if (redirected && d.redirect === 'error') { reject(new TypeError('Failed to fetch')); return; }
          const respSame = originOf(fu) === docOrigin;
          let type = 'basic';
          let fields;
          let bodyBytes = rbody === null || rbody === undefined ? new Uint8Array(0) : new Uint8Array(rbody);
          if (d.method === 'HEAD' || NULL_BODY_STATUS.has(status)) bodyBytes = null;
          if (!respSame && d.mode === 'no-cors') {
            type = 'opaque';
            fields = { type, url: '', status: 0, statusText: '', headers: headersFromFlat([], 'immutable'), redirected: false };
            resolve(makeResponse(fields, null));
            return;
          }
          let hflat = rflat || [];
          if (respSame) {
            const filtered = [];
            for (let i = 0; i + 1 < hflat.length; i += 2) {
              const n = `${hflat[i]}`.toLowerCase();
              if (n !== 'set-cookie' && n !== 'set-cookie2') filtered.push(hflat[i], hflat[i + 1]);
            }
            hflat = filtered;
          } else {
            type = 'cors';
            let exposed = null;
            for (let i = 0; i + 1 < hflat.length; i += 2) if (`${hflat[i]}`.toLowerCase() === 'access-control-expose-headers') exposed = (exposed ? exposed + ',' : '') + hflat[i + 1];
            const exp = new Set((exposed || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
            const all = exp.has('*') && d.credentials !== 'include';
            const filtered = [];
            for (let i = 0; i + 1 < hflat.length; i += 2) {
              const n = `${hflat[i]}`.toLowerCase();
              if (n === 'set-cookie' || n === 'set-cookie2') continue;
              if (SAFELISTED_RESPONSE.has(n) || exp.has(n) || all) filtered.push(hflat[i], hflat[i + 1]);
            }
            hflat = filtered;
          }
          fields = { type, url: fu, status, statusText: `${statusText || ''}`, headers: headersFromFlat(hflat, 'immutable'), redirected };
          resolve(makeResponse(fields, bodyBytes));
        }, d.credentials, d.cache, d.redirect);
        L.addAbortAlgorithm(signal, () => {
          if (finished) return;
          L.cancelNativeFetch(reqId);
          reject(L.signalReason(signal));
        });
      }, reject);
    });
  }

  // =======================================================================================
  // XMLHttpRequest
  // =======================================================================================
  class XMLHttpRequestEventTarget extends EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
  }
  L.defineEventHandlers(XMLHttpRequestEventTarget.prototype, ['onloadstart', 'onprogress', 'onabort', 'onerror', 'onload', 'ontimeout', 'onloadend']);
  class XMLHttpRequestUpload extends XMLHttpRequestEventTarget { }
  const XHR_UNSENT = 0, XHR_OPENED = 1, XHR_HEADERS = 2, XHR_LOADING = 3, XHR_DONE = 4;
  class XMLHttpRequest extends XMLHttpRequestEventTarget {
    #s = {
      state: XHR_UNSENT, method: 'GET', url: '', async: true, headers: [], send: false, timeout: 0, withCredentials: false,
      responseType: '', mime: null, status: 0, statusText: '', responseURL: '', respHeaders: [], bytes: null,
      cache: undefined, reqId: 0, timer: 0, upload: null, error: false, gen: 0,
    };
    constructor() {
      super(INTERNAL);
      this.#s.upload = new XMLHttpRequestUpload(INTERNAL);
    }
    get readyState() { return this.#s.state; }
    get upload() { return this.#s.upload; }
    open(method, url, async = true, username, password) {
      if (arguments.length < 2) throw new TypeError(`Failed to execute 'open' on 'XMLHttpRequest': 2 arguments required, but only ${arguments.length} present.`);
      const m = `${method}`;
      if (!TOKEN_RE.test(m)) throw new DOMException(`Failed to execute 'open' on 'XMLHttpRequest': '${m}' is not a valid HTTP method.`, 'SyntaxError');
      const up = m.toUpperCase();
      if (up === 'CONNECT' || up === 'TRACE' || up === 'TRACK') throw new DOMException(`Failed to execute 'open' on 'XMLHttpRequest': '${m}' HTTP method is unsupported.`, 'SecurityError');
      const parsed = N.urlParse(L.toUSV(url), L.baseURL());
      if (parsed === null) throw new DOMException(`Failed to execute 'open' on 'XMLHttpRequest': Invalid URL`, 'SyntaxError');
      const s = this.#s;
      const isAsync = arguments.length < 3 ? true : !!async;
      if (!isAsync && (s.timeout !== 0 || s.responseType !== '')) throw new DOMException("Failed to execute 'open' on 'XMLHttpRequest': Synchronous requests from a document must not set a response type or timeout.", 'InvalidAccessError');
      this.#terminate();
      s.gen++;
      s.method = METHOD_NORMALIZE.has(up) ? up : m;
      s.url = parsed[0];
      s.async = isAsync;
      s.headers = [];
      s.send = false;
      s.status = 0; s.statusText = ''; s.responseURL = ''; s.respHeaders = []; s.bytes = null; s.cache = undefined; s.error = false;
      if (s.state !== XHR_OPENED) {
        s.state = XHR_OPENED;
        L.fire(this, 'readystatechange', {});
      }
    }
    setRequestHeader(name, value) {
      const s = this.#s;
      if (s.state !== XHR_OPENED || s.send) throw new DOMException("Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
      const n = `${name}`, v = normalizeHeaderValue(value);
      if (!TOKEN_RE.test(n)) throw new DOMException(`Failed to execute 'setRequestHeader' on 'XMLHttpRequest': '${n}' is not a valid HTTP header field name.`, 'SyntaxError');
      if (/[\0\r\n]/.test(v)) throw new DOMException(`Failed to execute 'setRequestHeader' on 'XMLHttpRequest': '${v}' is not a valid HTTP header field value.`, 'SyntaxError');
      const l = n.toLowerCase();
      if (forbiddenRequestHeader(l)) return;
      const e = s.headers.find((h) => h[0].toLowerCase() === l);
      if (e) e[1] = e[1] + ', ' + v; else s.headers.push([n, v]);
    }
    get timeout() { return this.#s.timeout; }
    set timeout(v) {
      const s = this.#s;
      if (!s.async && s.state === XHR_OPENED) throw new DOMException("Failed to set the 'timeout' property on 'XMLHttpRequest': Timeouts cannot be set for synchronous requests made from a document.", 'InvalidAccessError');
      s.timeout = L.toULong(v);
    }
    get withCredentials() { return this.#s.withCredentials; }
    set withCredentials(v) {
      const s = this.#s;
      if ((s.state !== XHR_UNSENT && s.state !== XHR_OPENED) || s.send) throw new DOMException("Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.", 'InvalidStateError');
      s.withCredentials = !!v;
    }
    send(body = null) {
      const s = this.#s;
      if (s.state !== XHR_OPENED || s.send) throw new DOMException("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
      let bytes = null, ctype = null;
      if (s.method !== 'GET' && s.method !== 'HEAD' && body !== null && body !== undefined) {
        if (isNode(body) && typeOf(body) === 9) {
          bytes = utf8Encode(L.xmlSerialize(body, null));
          ctype = L.docState.get(body).contentType === 'text/html' ? 'text/html;charset=UTF-8' : 'application/xml;charset=UTF-8';
        } else {
          const ex = extractBody(body, false);
          if (ex.stream !== null) throw new TypeError("Failed to execute 'send' on 'XMLHttpRequest': streams are not supported");
          bytes = ex.bytes;
          ctype = ex.type;
        }
      }
      const flat = [];
      let hasCT = false;
      for (const [n, v] of s.headers) {
        if (n.toLowerCase() === 'content-type') {
          hasCT = true;
          flat.push(n, typeof body === 'string' || (isNode(body) && typeOf(body) === 9) ? v.replace(/charset=[^;]*/i, 'charset=UTF-8') : v);
        } else flat.push(n, v);
      }
      if (!hasCT && ctype !== null) flat.push('Content-Type', ctype);
      const mode = originOf(s.url) === L.location.origin ? 'same-origin' : 'cors';
      if (!s.async) { this.#sendSync(flat, bytes, mode); return; }
      s.send = true;
      s.error = false;
      const gen = s.gen;
      L.fire(this, 'loadstart', { loaded: 0, total: 0 }, L.ProgressEvent);
      const uploadListeners = bytes !== null && hasUploadListeners(s.upload);
      if (uploadListeners) L.fire(s.upload, 'loadstart', { loaded: 0, total: bytes.length, lengthComputable: true }, L.ProgressEvent);
      if (s.state !== XHR_OPENED || !s.send || gen !== s.gen) return;
      const scheme = s.url.slice(0, s.url.indexOf(':')).toLowerCase();
      if (scheme === 'blob' || scheme === 'data') {
        L.postTask(() => {
          if (gen !== s.gen) return;
          let r = null;
          if (scheme === 'blob') {
            const bl = blobURLs.get(stripFragment(s.url));
            if (bl !== undefined && s.method === 'GET') r = [200, 'OK', s.url, ['Content-Type', bl.type, 'Content-Length', String(bl.size)], copyToArrayBuffer(L.blobBytes(bl)), null];
          } else {
            const p = parseDataURL(s.url);
            if (p !== null) r = [200, 'OK', s.url, ['Content-Type', p.type], copyToArrayBuffer(p.bytes), null];
          }
          if (r === null) r = [0, '', s.url, [], null, 'bad url'];
          this.#complete(gen, uploadListeners, bytes, ...r);
        });
      } else {
        s.reqId = L.startNativeFetch(s.method, s.url, flat, bytes === null ? null : copyToArrayBuffer(bytes), mode,
          (status, statusText, finalUrl, rflat, rbody, error) => this.#complete(gen, uploadListeners, bytes, status, statusText, finalUrl, rflat, rbody, error),
          s.withCredentials ? 'include' : 'same-origin');
      }
      if (s.timeout > 0) {
        s.timer = L.internalTimeout(() => {
          if (gen !== s.gen || !s.send) return;
          this.#terminate();
          this.#requestError('timeout', uploadListeners, bytes);
        }, s.timeout);
      }
    }
    #sendSync(flat, bytes, mode) {
      const s = this.#s;
      if (typeof N.fetchSync !== 'function') {
        throw new DOMException("Failed to execute 'send' on 'XMLHttpRequest': Synchronous XMLHttpRequest is not supported.", 'InvalidAccessError');
      }
      let r;
      try { r = N.fetchSync(s.method, s.url, flat, bytes === null ? null : copyToArrayBuffer(bytes), s.withCredentials ? 'include' : 'same-origin'); } catch (e) { r = [0, '', s.url, [], null, String(e)]; }
      const [status, statusText, finalUrl, rflat, rbody, error] = r;
      if (error !== null && error !== undefined || status === 0) {
        s.state = XHR_DONE;
        s.error = true;
        L.fire(this, 'readystatechange', {});
        throw new DOMException(`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${s.url}'.`, 'NetworkError');
      }
      this.#setResponse(status, statusText, finalUrl, rflat, rbody);
      s.state = XHR_DONE;
      L.fire(this, 'readystatechange', {});
      const len = s.bytes === null ? 0 : s.bytes.length;
      L.fire(this, 'load', { loaded: len, total: len, lengthComputable: true }, L.ProgressEvent);
      L.fire(this, 'loadend', { loaded: len, total: len, lengthComputable: true }, L.ProgressEvent);
    }
    #setResponse(status, statusText, finalUrl, rflat, rbody) {
      const s = this.#s;
      s.status = status;
      s.statusText = `${statusText || ''}`;
      s.responseURL = stripFragment(`${finalUrl || s.url}`);
      const hs = [];
      const f = rflat || [];
      for (let i = 0; i + 1 < f.length; i += 2) hs.push([`${f[i]}`, `${f[i + 1]}`]);
      s.respHeaders = hs;
      s.bytes = rbody === null || rbody === undefined ? new Uint8Array(0) : new Uint8Array(rbody);
      s.cache = undefined;
    }
    #complete(gen, uploadListeners, reqBytes, status, statusText, finalUrl, rflat, rbody, error) {
      const s = this.#s;
      if (gen !== s.gen || !s.send) return;
      if (s.timer) { L.clearInternalTimeout(s.timer); s.timer = 0; }
      if (error !== null && error !== undefined || status === 0) {
        this.#requestError('error', uploadListeners, reqBytes);
        return;
      }
      if (uploadListeners) {
        const n = reqBytes.length;
        L.fire(s.upload, 'progress', { loaded: n, total: n, lengthComputable: true }, L.ProgressEvent);
        L.fire(s.upload, 'load', { loaded: n, total: n, lengthComputable: true }, L.ProgressEvent);
        L.fire(s.upload, 'loadend', { loaded: n, total: n, lengthComputable: true }, L.ProgressEvent);
      }
      this.#setResponse(status, statusText, finalUrl, rflat, rbody);
      s.state = XHR_HEADERS;
      L.fire(this, 'readystatechange', {});
      if (gen !== s.gen) return;
      const len = s.bytes.length;
      const clen = this.getResponseHeader('content-length');
      const computable = clen !== null;
      s.state = XHR_LOADING;
      L.fire(this, 'readystatechange', {});
      if (gen !== s.gen) return;
      L.fire(this, 'progress', { loaded: len, total: computable ? len : 0, lengthComputable: computable }, L.ProgressEvent);
      if (gen !== s.gen) return;
      s.state = XHR_DONE;
      s.send = false;
      L.fire(this, 'readystatechange', {});
      if (gen !== s.gen) return;
      L.fire(this, 'load', { loaded: len, total: computable ? len : 0, lengthComputable: computable }, L.ProgressEvent);
      L.fire(this, 'loadend', { loaded: len, total: computable ? len : 0, lengthComputable: computable }, L.ProgressEvent);
    }
    #requestError(kind, uploadListeners, reqBytes) {
      const s = this.#s;
      s.state = XHR_DONE;
      s.send = false;
      s.error = true;
      s.status = 0; s.statusText = ''; s.respHeaders = []; s.bytes = null; s.cache = undefined;
      L.fire(this, 'readystatechange', {});
      if (uploadListeners) {
        L.fire(s.upload, kind, { loaded: 0, total: 0 }, L.ProgressEvent);
        L.fire(s.upload, 'loadend', { loaded: 0, total: 0 }, L.ProgressEvent);
      }
      L.fire(this, kind, { loaded: 0, total: 0 }, L.ProgressEvent);
      L.fire(this, 'loadend', { loaded: 0, total: 0 }, L.ProgressEvent);
    }
    #terminate() {
      const s = this.#s;
      if (s.reqId) { L.cancelNativeFetch(s.reqId); s.reqId = 0; }
      if (s.timer) { L.clearInternalTimeout(s.timer); s.timer = 0; }
    }
    abort() {
      const s = this.#s;
      this.#terminate();
      s.gen++;
      if ((s.state === XHR_OPENED && s.send) || s.state === XHR_HEADERS || s.state === XHR_LOADING) {
        s.state = XHR_DONE;
        s.send = false;
        s.status = 0; s.statusText = ''; s.respHeaders = []; s.bytes = null; s.cache = undefined;
        L.fire(this, 'readystatechange', {});
        L.fire(this, 'abort', { loaded: 0, total: 0 }, L.ProgressEvent);
        L.fire(this, 'loadend', { loaded: 0, total: 0 }, L.ProgressEvent);
      }
      if (s.state === XHR_DONE) {
        s.state = XHR_UNSENT;
        s.status = 0; s.statusText = ''; s.respHeaders = []; s.bytes = null;
      }
    }
    get responseURL() { return this.#s.responseURL; }
    get status() { return this.#s.status; }
    get statusText() { return this.#s.statusText; }
    getResponseHeader(name) {
      const s = this.#s;
      if (s.state < XHR_HEADERS || s.error) return null;
      const l = `${name}`.toLowerCase();
      if (l === 'set-cookie' || l === 'set-cookie2') return null;
      const vals = s.respHeaders.filter((h) => h[0].toLowerCase() === l).map((h) => h[1]);
      return vals.length ? vals.join(', ') : null;
    }
    getAllResponseHeaders() {
      const s = this.#s;
      if (s.state < XHR_HEADERS || s.error) return '';
      const names = Array.from(new Set(s.respHeaders.map((h) => h[0].toLowerCase()))).filter((n) => n !== 'set-cookie' && n !== 'set-cookie2').sort();
      return names.map((n) => n + ': ' + s.respHeaders.filter((h) => h[0].toLowerCase() === n).map((h) => h[1]).join(', ') + '\r\n').join('');
    }
    overrideMimeType(mime) {
      const s = this.#s;
      if (s.state === XHR_LOADING || s.state === XHR_DONE) throw new DOMException("Failed to execute 'overrideMimeType' on 'XMLHttpRequest': MimeType cannot be overridden when the state is LOADING or DONE.", 'InvalidStateError');
      s.mime = `${mime}`;
    }
    get responseType() { return this.#s.responseType; }
    set responseType(v) {
      const s = this.#s;
      const t = `${v}`;
      if (!['', 'arraybuffer', 'blob', 'document', 'json', 'text'].includes(t)) return;
      if (s.state === XHR_LOADING || s.state === XHR_DONE) throw new DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': The response type cannot be set if the object's state is LOADING or DONE.", 'InvalidStateError');
      if (!s.async && s.state === XHR_OPENED) throw new DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': The response type cannot be changed for synchronous requests made from a document.", 'InvalidAccessError');
      s.responseType = t;
    }
    #mimeType() {
      const s = this.#s;
      if (s.mime !== null) return s.mime;
      const ct = this.getResponseHeader('content-type');
      return ct === null ? 'text/xml' : ct;
    }
    #text() {
      const s = this.#s;
      if (s.bytes === null) return '';
      const mt = this.#mimeType();
      const m = /charset=([^;]+)/i.exec(mt);
      const enc = m ? (resolveEncoding(m[1].replace(/"/g, '')) || 'utf-8') : 'utf-8';
      let t = enc === 'utf-8' ? utf8Decode(s.bytes) : N.textDecode(s.bytes, enc, false);
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      return t;
    }
    get responseText() {
      const s = this.#s;
      if (s.responseType !== '' && s.responseType !== 'text') throw new DOMException(`Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${s.responseType}').`, 'InvalidStateError');
      if (s.state !== XHR_LOADING && s.state !== XHR_DONE) return '';
      return this.#text();
    }
    get responseXML() {
      const s = this.#s;
      if (s.responseType !== '' && s.responseType !== 'document') throw new DOMException(`Failed to read the 'responseXML' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'document' (was '${s.responseType}').`, 'InvalidStateError');
      if (s.state !== XHR_DONE || s.error) return null;
      if (s.cache !== undefined) return s.cache;
      const mt = this.#mimeType().split(';')[0].trim().toLowerCase();
      let doc = null;
      if (mt === 'text/html') { if (s.responseType === 'document') doc = new L.DOMParser().parseFromString(this.#text(), 'text/html'); }
      else if (mt === 'text/xml' || mt === 'application/xml' || mt.endsWith('+xml')) doc = L.parseXMLDocument(this.#text(), mt === 'text/xml' ? 'text/xml' : 'application/xml');
      s.cache = doc;
      return doc;
    }
    get response() {
      const s = this.#s;
      const t = s.responseType;
      if (t === '' || t === 'text') {
        if (s.state !== XHR_LOADING && s.state !== XHR_DONE) return '';
        return this.#text();
      }
      if (s.state !== XHR_DONE || s.error) return null;
      if (s.cache !== undefined) return s.cache;
      let v = null;
      if (t === 'arraybuffer') v = copyToArrayBuffer(s.bytes);
      else if (t === 'blob') v = new Blob([s.bytes], { type: (this.getResponseHeader('content-type') || '').split(';')[0] === '' ? '' : this.#mimeType() });
      else if (t === 'json') { try { v = JSON.parse(utf8Decode(s.bytes)); } catch (_) { v = null; } }
      else if (t === 'document') v = this.responseXML;
      s.cache = v;
      return v;
    }
  }
  function hasUploadListeners(up) {
    for (const t of ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend']) if (L.hasListeners(up, t)) return true;
    return false;
  }
  L.defineConstants([XMLHttpRequest, XMLHttpRequest.prototype], { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 });
  L.defineEventHandlers(XMLHttpRequest.prototype, ['onreadystatechange']);

  // =======================================================================================
  // WebSocket (the connection itself lives in the network process: N.wsOpen/wsSend/wsClose,
  // events come back through hooks.onWebSocket)
  // =======================================================================================
  let nextSocketId = 1;
  const liveSockets = new Map(); // id -> WebSocket (keeps open sockets alive)
  const WS_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  class WebSocket extends EventTarget {
    #id = 0; #url = ''; #origin = ''; #state = 0; #protocol = ''; #extensions = '';
    #buffered = 0; #binaryType = 'blob'; #failed = false;
    constructor(url, protocols) {
      super();
      const fail = (msg, name) => new DOMException(`Failed to construct 'WebSocket': ${msg}`, name || 'SyntaxError');
      if (arguments.length === 0) throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
      const base = L.location ? L.location.href : null;
      const p = N.urlParse(`${url}`, base);
      if (p === null) throw fail(`The URL '${url}' is invalid.`);
      let href = p[0];
      let scheme = href.slice(0, href.indexOf(':')).toLowerCase();
      if (scheme === 'http' || scheme === 'https') { href = (scheme === 'http' ? 'ws' : 'wss') + href.slice(scheme.length); scheme = scheme === 'http' ? 'ws' : 'wss'; }
      if (scheme !== 'ws' && scheme !== 'wss') throw fail(`The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${scheme}' is not allowed.`);
      if (href.includes('#')) throw fail(`The URL contains a fragment identifier ('${href.slice(href.indexOf('#') + 1)}'). Fragment identifiers are not allowed in WebSocket URLs.`);
      if (scheme === 'ws' && L.location && L.location.protocol === 'https:') {
        const host = N.urlParse(href, null);
        const h = host === null ? '' : host[5];
        if (h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]') {
          throw fail(`An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.`, 'SecurityError');
        }
      }
      let list = [];
      if (protocols !== undefined) list = typeof protocols === 'string' ? [protocols] : Array.from(protocols, (x) => `${x}`);
      const seen = new Set();
      for (const proto of list) {
        if (!WS_TOKEN.test(proto)) throw fail(`The subprotocol '${proto}' is invalid.`);
        if (seen.has(proto)) throw fail(`The subprotocol '${proto}' is duplicated.`);
        seen.add(proto);
      }
      this.#url = href;
      this.#origin = (N.urlParse(href, null) || [])[10] || 'null';
      this.#id = nextSocketId++;
      liveSockets.set(this.#id, this);
      let ok = false;
      try { ok = N.wsOpen(this.#id, href, list, L.location ? L.location.origin : 'null'); } catch (_) { ok = false; }
      if (!ok) {
        const id = this.#id;
        L.postTask(() => { L.onWebSocket(id, 'error', 'WebSocket is not supported here'); L.onWebSocket(id, 'close', 1006, '', false); });
      }
    }
    get url() { return this.#url; }
    get readyState() { return this.#state; }
    get bufferedAmount() { return this.#buffered; }
    get protocol() { return this.#protocol; }
    get extensions() { return this.#extensions; }
    get binaryType() { return this.#binaryType; }
    set binaryType(v) { v = `${v}`; if (v === 'blob' || v === 'arraybuffer') this.#binaryType = v; }
    send(data) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'send' on 'WebSocket': 1 argument required, but only 0 present.");
      if (this.#state === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      let payload, size;
      if (data instanceof L.Blob) { const b = L.blobBytes(data); payload = copyToArrayBuffer(b); size = b.byteLength; }
      else {
        const bytes = toBytes(data);
        if (bytes !== null) { payload = copyToArrayBuffer(bytes); size = bytes.byteLength; }
        else { payload = `${data}`; size = utf8Encode(payload).byteLength; }
      }
      this.#buffered += size;
      if (this.#state !== 1) return;
      N.wsSend(this.#id, payload);
    }
    close(code, reason) {
      if (code !== undefined) {
        code = Number(code) & 0xffff;
        if (code !== 1000 && (code < 3000 || code > 4999)) {
          throw new DOMException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, 'InvalidAccessError');
        }
      }
      reason = reason === undefined ? '' : `${reason}`;
      if (utf8Encode(reason).byteLength > 123) {
        throw new DOMException("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", 'SyntaxError');
      }
      if (this.#state >= 2) return;
      if (this.#state === 0) this.#failed = true;
      this.#state = 2;
      N.wsClose(this.#id, code === undefined ? -1 : code, reason);
    }
    static {
      L.onWebSocket = function (id, kind, a, b, c) {
        const ws = liveSockets.get(id);
        if (ws === undefined) return;
        switch (kind) {
          case 'open':
            if (ws.#state !== 0) return;
            ws.#state = 1; ws.#protocol = `${a}`; ws.#extensions = `${b}`;
            L.fire(ws, 'open', {});
            break;
          case 'message': {
            if (ws.#state !== 1) return;
            let data = a;
            if (typeof a !== 'string') data = ws.#binaryType === 'arraybuffer' ? a : new L.Blob([a]);
            L.fire(ws, 'message', { data, origin: ws.#origin }, L.MessageEvent);
            break;
          }
          case 'sent':
            ws.#buffered = Math.max(0, ws.#buffered - Number(a));
            break;
          case 'error':
            ws.#failed = true;
            if (L.console && typeof a === 'string' && a) L.console.error(`WebSocket connection to '${ws.#url}' failed: ${a}`);
            break;
          case 'close': {
            liveSockets.delete(id);
            ws.#state = 3;
            if (ws.#failed || a === 1006) L.fire(ws, 'error', {});
            L.fire(ws, 'close', { wasClean: !!c, code: Number(a), reason: `${b}` }, L.CloseEvent);
            break;
          }
        }
      };
    }
  }
  L.defineConstants([WebSocket, WebSocket.prototype], { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  L.defineEventHandlers(WebSocket.prototype, ['onopen', 'onmessage', 'onerror', 'onclose']);
  L.expose('WebSocket', WebSocket);
  L.WebSocket = WebSocket;

  L.part1 = { setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask, requestAnimationFrame,
    cancelAnimationFrame, requestIdleCallback, cancelIdleCallback, structuredClone, btoa, atob, fetch, randomUUIDRef: null };
  Object.assign(L, { MessagePort, MessageChannel, BroadcastChannel, URLSearchParams, TextEncoder, TextDecoder, Blob, File, FileList,
    FileReader, FormData, ReadableStream, ReadableStreamDefaultReader, ReadableStreamDefaultController, WritableStream,
    TransformStream, Request, Response, XMLHttpRequest, XMLHttpRequestUpload, XMLHttpRequestEventTarget, IdleDeadline });
  for (const [k, v] of Object.entries({ MessagePort, MessageChannel, BroadcastChannel, URL, URLSearchParams, TextEncoder,
    TextDecoder, Blob, File, FileList, FileReader, FormData, ReadableStream, ReadableStreamDefaultReader,
    ReadableStreamDefaultController, WritableStream, TransformStream, Headers, Request, Response, XMLHttpRequest,
    XMLHttpRequestUpload, XMLHttpRequestEventTarget, IdleDeadline })) L.expose(k, v);

  // =======================================================================================
  // crypto
  // =======================================================================================
  function randomUUID() {
    const b = new Uint8Array(N.randomBytes(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  L.randomUUID = randomUUID;
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function padMessage(bytes, lenBytes, bigEndianLen) {
    const l = bytes.length;
    const block = lenBytes === 16 ? 128 : 64;
    const total = Math.ceil((l + 1 + lenBytes) / block) * block;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[l] = 0x80;
    const dv = new DataView(buf.buffer);
    const bits = l * 8;
    dv.setUint32(total - 4, bits >>> 0);
    dv.setUint32(total - 8, Math.floor(bits / 4294967296));
    return dv;
  }
  const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
    0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
    0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(bytes) {
    const dv = padMessage(bytes, 8);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let off = 0; off < dv.byteLength; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }
  function sha1(bytes) {
    const dv = padMessage(bytes, 8);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const W = new Uint32Array(80);
    for (let off = 0; off < dv.byteLength; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 80; i++) { const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16]; W[i] = (x << 1) | (x >>> 31); }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; } else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const t = (((a << 5) | (a >>> 27)) + f + e + k + W[i]) >>> 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const out = new Uint8Array(20);
    const odv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4].forEach((v, i) => odv.setUint32(i * 4, v));
    return out;
  }
  const K512 = ['428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019',
    '923f82a4af194f9b', 'ab1c5ed5da6d8118', 'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
    '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694', 'e49b69c19ef14ad2', 'efbe4786384f25e3',
    '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
    '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725',
    '06ca6351e003826f', '142929670a0e6e70', '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
    '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b', 'a2bfe8a14cf10364', 'a81a664bbc423001',
    'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
    '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb',
    '5b9cca4f7763e373', '682e6ff3d6b2b8a3', '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
    '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b', 'ca273eceea26619c', 'd186b8c721c0c207',
    'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
    '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a',
    '5fcb6fab3ad6faec', '6c44198c4a475817'];
  let K512n = null;
  function sha512(bytes, is384) {
    const M = (1n << 64n) - 1n;
    if (K512n === null) K512n = K512.map((h) => BigInt('0x' + h));
    const rot = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M;
    const H = (is384 ? ['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4']
      : ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179']).map((h) => BigInt('0x' + h));
    const dv = padMessage(bytes, 16);
    const W = new Array(80);
    for (let off = 0; off < dv.byteLength; off += 128) {
      for (let i = 0; i < 16; i++) W[i] = dv.getBigUint64(off + i * 8);
      for (let i = 16; i < 80; i++) {
        const s0 = rot(W[i - 15], 1) ^ rot(W[i - 15], 8) ^ (W[i - 15] >> 7n);
        const s1 = rot(W[i - 2], 19) ^ rot(W[i - 2], 61) ^ (W[i - 2] >> 6n);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) & M;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 80; i++) {
        const t1 = (h + (rot(e, 14) ^ rot(e, 18) ^ rot(e, 41)) + ((e & f) ^ (~e & M & g)) + K512n[i] + W[i]) & M;
        const t2 = ((rot(a, 28) ^ rot(a, 34) ^ rot(a, 39)) + ((a & b) ^ (a & c) ^ (b & c))) & M;
        h = g; g = f; f = e; e = (d + t1) & M; d = c; c = b; b = a; a = (t1 + t2) & M;
      }
      H[0] = (H[0] + a) & M; H[1] = (H[1] + b) & M; H[2] = (H[2] + c) & M; H[3] = (H[3] + d) & M;
      H[4] = (H[4] + e) & M; H[5] = (H[5] + f) & M; H[6] = (H[6] + g) & M; H[7] = (H[7] + h) & M;
    }
    const n = is384 ? 6 : 8;
    const out = new Uint8Array(n * 8);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < n; i++) odv.setBigUint64(i * 8, H[i]);
    return out;
  }
  class SubtleCrypto {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    digest(algorithm, data) {
      const name = `${typeof algorithm === 'object' && algorithm !== null ? algorithm.name : algorithm}`.toUpperCase();
      const bytes = toBytes(data);
      if (bytes === null) return L.rejectedPromise(new TypeError("Failed to execute 'digest' on 'SubtleCrypto': 2nd argument is not of type ArrayBuffer or ArrayBufferView."));
      let out;
      switch (name) {
        case 'SHA-1': out = sha1(bytes); break;
        case 'SHA-256': out = sha256(bytes); break;
        case 'SHA-384': out = sha512(bytes, true); break;
        case 'SHA-512': out = sha512(bytes, false); break;
        default: return L.rejectedPromise(new DOMException('Algorithm: Unrecognized name', 'NotSupportedError'));
      }
      return L.resolvedPromise(out.buffer);
    }
  }
  for (const m of ['encrypt', 'decrypt', 'sign', 'verify', 'generateKey', 'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey']) {
    Object.defineProperty(SubtleCrypto.prototype, m, {
      value: { [m]() { return L.rejectedPromise(new DOMException(`SubtleCrypto.${m} is not supported by this browser`, 'NotSupportedError')); } }[m],
      writable: true, enumerable: true, configurable: true,
    });
  }
  const subtle = new SubtleCrypto(INTERNAL);
  const INT_ARRAYS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'BigInt64Array', 'BigUint64Array'];
  class Crypto {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    getRandomValues(array) {
      if (!ArrayBuffer.isView(array) || !INT_ARRAYS.includes(Object.prototype.toString.call(array).slice(8, -1))) {
        throw new DOMException("Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type '" + (array && array.constructor ? array.constructor.name : typeof array) + "', which is not an integer array type.", 'TypeMismatchError');
      }
      if (array.byteLength > 65536) throw new DOMException(`Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (${array.byteLength}) exceeds the number of bytes of entropy available via this API (65536).`, 'QuotaExceededError');
      if (array.byteLength === 0) return array;
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(new Uint8Array(N.randomBytes(array.byteLength)));
      return array;
    }
    randomUUID() { return randomUUID(); }
    get subtle() { return L.window && L.window.isSecureContext === false ? undefined : subtle; }
  }
  const crypto = new Crypto(INTERNAL);
  L.crypto = crypto;

  // =======================================================================================
  // performance
  // =======================================================================================
  L.milestones = {};
  const perfEntries = []; // marks + measures
  class PerformanceEntry {
    #name; #type; #start; #duration;
    constructor(token, name, type, start, duration) {
      if (token !== INTERNAL) throw L.illegal();
      this.#name = name; this.#type = type; this.#start = start; this.#duration = duration;
    }
    static { L.peInit = (e, name, type, start, duration) => { e.#name = name; e.#type = type; e.#start = start; e.#duration = duration; }; }
    get name() { return this.#name; }
    get entryType() { return this.#type; }
    get startTime() { return this.#start; }
    get duration() { return this.#duration; }
    toJSON() { return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration }; }
  }
  class PerformanceMark extends PerformanceEntry {
    #detail = null;
    constructor(markName, options) {
      if (arguments.length === 0) throw new TypeError("Failed to construct 'PerformanceMark': 1 argument required, but only 0 present.");
      const o = options || {};
      const start = o.startTime !== undefined ? Number(o.startTime) : N.now();
      if (start < 0) throw new TypeError("Failed to construct 'PerformanceMark': 'startTime' cannot be negative.");
      super(INTERNAL, `${markName}`, 'mark', start, 0);
      this.#detail = o.detail === undefined ? null : cloneValue(o.detail);
    }
    get detail() { return this.#detail; }
    toJSON() { return Object.assign(super.toJSON(), { detail: this.#detail }); }
  }
  class PerformanceMeasure extends PerformanceEntry {
    #detail = null;
    constructor(token, name, start, duration, detail) { super(token, name, 'measure', start, duration); this.#detail = detail === undefined ? null : detail; }
    get detail() { return this.#detail; }
  }
  class PerformanceResourceTiming extends PerformanceEntry {
    #d;
    constructor(token, name, type, start, duration, d) { super(token, name, type, start, duration); this.#d = d || {}; }
    static { L.prtData = (e) => e.#d; }
  }
  for (const k of ['initiatorType', 'nextHopProtocol', 'workerStart', 'redirectStart', 'redirectEnd', 'fetchStart', 'domainLookupStart',
    'domainLookupEnd', 'connectStart', 'connectEnd', 'secureConnectionStart', 'requestStart', 'responseStart', 'responseEnd',
    'transferSize', 'encodedBodySize', 'decodedBodySize', 'renderBlockingStatus', 'responseStatus', 'deliveryType']) {
    Object.defineProperty(PerformanceResourceTiming.prototype, k, { get() { const v = L.prtData(this)[k]; return v === undefined ? (typeof v === 'string' ? '' : 0) : v; }, enumerable: true, configurable: true });
  }
  PerformanceResourceTiming.prototype.toJSON = function () { return Object.assign(PerformanceEntry.prototype.toJSON.call(this), L.prtData(this)); };
  class PerformanceNavigationTiming extends PerformanceResourceTiming { }
  for (const k of ['unloadEventStart', 'unloadEventEnd', 'domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd',
    'domComplete', 'loadEventStart', 'loadEventEnd', 'type', 'redirectCount', 'activationStart']) {
    Object.defineProperty(PerformanceNavigationTiming.prototype, k, {
      get() {
        if (k === 'type') return 'navigate';
        if (k === 'redirectCount' || k === 'activationStart' || k === 'unloadEventStart' || k === 'unloadEventEnd') return 0;
        const v = L.milestones[k];
        return v === undefined ? 0 : v;
      },
      enumerable: true, configurable: true,
    });
  }
  Object.defineProperty(PerformanceNavigationTiming.prototype, 'duration', { get() { return L.milestones.loadEventEnd || 0; }, enumerable: true, configurable: true });
  function navigationEntry() {
    return new PerformanceNavigationTiming(INTERNAL, L.documentURL(), 'navigation', 0, 0, {
      initiatorType: 'navigation', nextHopProtocol: 'http/1.1', fetchStart: 0, domainLookupStart: 0, domainLookupEnd: 0,
      connectStart: 0, connectEnd: 0, requestStart: 0, responseStart: L.milestones.responseStart || 0,
      responseEnd: L.milestones.responseEnd || 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0,
      renderBlockingStatus: 'non-blocking', responseStatus: 200, deliveryType: '',
    });
  }
  class PerformanceTiming {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    toJSON() { const o = {}; for (const k of TIMING_KEYS) o[k] = this[k]; return o; }
  }
  const TIMING_KEYS = ['navigationStart', 'unloadEventStart', 'unloadEventEnd', 'redirectStart', 'redirectEnd', 'fetchStart',
    'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'secureConnectionStart', 'requestStart',
    'responseStart', 'responseEnd', 'domLoading', 'domInteractive', 'domContentLoadedEventStart',
    'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd'];
  for (const k of TIMING_KEYS) {
    Object.defineProperty(PerformanceTiming.prototype, k, {
      get() {
        const origin = Math.round(N.timeOrigin());
        if (k === 'navigationStart' || k === 'fetchStart' || k === 'domainLookupStart' || k === 'domainLookupEnd' || k === 'connectStart' || k === 'connectEnd' || k === 'requestStart') return origin;
        if (k === 'unloadEventStart' || k === 'unloadEventEnd' || k === 'redirectStart' || k === 'redirectEnd' || k === 'secureConnectionStart') return 0;
        if (k === 'responseStart' || k === 'responseEnd' || k === 'domLoading') return origin + Math.round(L.milestones.responseEnd || 0);
        const v = L.milestones[k];
        return v === undefined ? 0 : origin + Math.round(v);
      },
      enumerable: true, configurable: true,
    });
  }
  class PerformanceNavigation {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get type() { return 0; }
    get redirectCount() { return 0; }
    toJSON() { return { type: 0, redirectCount: 0 }; }
  }
  L.defineConstants([PerformanceNavigation, PerformanceNavigation.prototype], { TYPE_NAVIGATE: 0, TYPE_RELOAD: 1, TYPE_BACK_FORWARD: 2, TYPE_RESERVED: 255 });
  const perfObservers = new Set();
  function queuePerfEntry(e) {
    for (const o of perfObservers) L.poQueue(o, e);
  }
  class PerformanceObserverEntryList {
    #list;
    constructor(token, list) { if (token !== INTERNAL) throw L.illegal(); this.#list = list; }
    getEntries() { return this.#list.slice(); }
    getEntriesByType(t) { return this.#list.filter((e) => e.entryType === `${t}`); }
    getEntriesByName(n, t) { return this.#list.filter((e) => e.name === `${n}` && (t === undefined || e.entryType === `${t}`)); }
  }
  const SUPPORTED_ENTRY_TYPES = Object.freeze(['mark', 'measure', 'navigation', 'resource']);
  class PerformanceObserver {
    #cb; #types = new Set(); #buffer = []; #queued = false;
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError("Failed to construct 'PerformanceObserver': The callback provided as parameter 1 is not a function.");
      this.#cb = callback;
    }
    static get supportedEntryTypes() { return SUPPORTED_ENTRY_TYPES; }
    static {
      L.poQueue = (o, e) => {
        if (!o.#types.has(e.entryType)) return;
        o.#buffer.push(e);
        if (!o.#queued) {
          o.#queued = true;
          L.postTask(() => {
            o.#queued = false;
            const list = o.#buffer;
            o.#buffer = [];
            if (list.length) { try { Reflect.apply(o.#cb, o, [new PerformanceObserverEntryList(INTERNAL, list), o, { droppedEntriesCount: 0 }]); } catch (e2) { L.reportException(e2); } }
          });
        }
      };
    }
    observe(options) {
      const o = options || {};
      if (o.entryTypes !== undefined && o.type !== undefined) throw new TypeError("Failed to execute 'observe' on 'PerformanceObserver': An observe() call must not include both entryTypes and type arguments.");
      const types = o.entryTypes !== undefined ? Array.from(o.entryTypes, String) : o.type !== undefined ? [`${o.type}`] : null;
      if (types === null) throw new TypeError("Failed to execute 'observe' on 'PerformanceObserver': An observe() call must include either entryTypes or type arguments.");
      for (const t of types) if (SUPPORTED_ENTRY_TYPES.includes(t)) this.#types.add(t);
      perfObservers.add(this);
      if (o.buffered && o.type !== undefined) {
        const existing = performance.getEntriesByType(`${o.type}`);
        for (const e of existing) L.poQueue(this, e);
      }
    }
    disconnect() { perfObservers.delete(this); this.#types.clear(); this.#buffer = []; }
    takeRecords() { const b = this.#buffer; this.#buffer = []; return b; }
  }
  function findMarkTime(name, method) {
    if (typeof name === 'number') return name;
    const s = `${name}`;
    for (let i = perfEntries.length - 1; i >= 0; i--) if (perfEntries[i].entryType === 'mark' && perfEntries[i].name === s) return perfEntries[i].startTime;
    const v = L.milestones[s];
    if (v !== undefined) return v;
    if (TIMING_KEYS.includes(s)) return 0;
    throw new DOMException(`Failed to execute '${method}' on 'Performance': The mark '${s}' does not exist.`, 'SyntaxError');
  }
  const timingObj = new PerformanceTiming(INTERNAL);
  const navigationObj = new PerformanceNavigation(INTERNAL);
  class Performance extends EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    now() { return N.now(); }
    get timeOrigin() { return N.timeOrigin(); }
    get timing() { return timingObj; }
    get navigation() { return navigationObj; }
    get memory() { return { jsHeapSizeLimit: 4294705152, totalJSHeapSize: 20000000, usedJSHeapSize: 15000000 }; }
    get eventCounts() { return new Map(); }
    mark(markName, options) {
      const m = new PerformanceMark(markName, options);
      perfEntries.push(m);
      queuePerfEntry(m);
      return m;
    }
    measure(measureName, startOrOptions, endMark) {
      let start = 0, end = N.now(), detail = null;
      if (startOrOptions !== null && typeof startOrOptions === 'object') {
        const o = startOrOptions;
        if (o.start !== undefined) start = findMarkTime(o.start, 'measure');
        if (o.end !== undefined) end = findMarkTime(o.end, 'measure');
        if (o.duration !== undefined) { if (o.start !== undefined) end = start + Number(o.duration); else start = end - Number(o.duration); }
        if (o.detail !== undefined) detail = cloneValue(o.detail);
      } else {
        if (startOrOptions !== undefined) start = findMarkTime(startOrOptions, 'measure');
        if (endMark !== undefined) end = findMarkTime(endMark, 'measure');
      }
      const m = new PerformanceMeasure(INTERNAL, `${measureName}`, start, end - start, detail);
      perfEntries.push(m);
      queuePerfEntry(m);
      return m;
    }
    clearMarks(name) { removeEntries('mark', name); }
    clearMeasures(name) { removeEntries('measure', name); }
    clearResourceTimings() { }
    setResourceTimingBufferSize() { }
    getEntries() { return [navigationEntry()].concat(perfEntries).sort((a, b) => a.startTime - b.startTime); }
    getEntriesByType(type) {
      const t = `${type}`;
      if (t === 'navigation') return [navigationEntry()];
      return perfEntries.filter((e) => e.entryType === t);
    }
    getEntriesByName(name, type) {
      const n = `${name}`;
      return this.getEntries().filter((e) => e.name === n && (type === undefined || e.entryType === `${type}`));
    }
    toJSON() { return { timeOrigin: this.timeOrigin, timing: timingObj.toJSON(), navigation: navigationObj.toJSON() }; }
  }
  function removeEntries(type, name) {
    for (let i = perfEntries.length - 1; i >= 0; i--) {
      const e = perfEntries[i];
      if (e.entryType === type && (name === undefined || e.name === `${name}`)) perfEntries.splice(i, 1);
    }
  }
  L.defineEventHandlers(Performance.prototype, ['onresourcetimingbufferfull']);
  const performance = new Performance(INTERNAL);
  L.performance = performance;

  // =======================================================================================
  // console
  // =======================================================================================
  const consoleState = { indent: 0, counts: new Map(), timers: new Map() };
  function fnName(f) { try { return f.name || ''; } catch (_) { return ''; } }
  function ctorName(o) {
    try {
      const p = Object.getPrototypeOf(o);
      if (p === null) return '[Object: null prototype]';
      const c = p.constructor;
      return typeof c === 'function' && c.name ? c.name : '';
    } catch (_) { return ''; }
  }
  function quote(s) { return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'"; }
  function inspectNode(n) {
    const t = typeOf(n);
    if (t === 1) {
      const id = idOf(n);
      let s = '<' + L.lnOf(n);
      for (const a of N.attrNames(id)) { const v = N.getAttr(id, a); s += v === '' ? ' ' + a : ` ${a}="${v}"`; }
      return s + '>';
    }
    if (t === 3) return '#text ' + JSON.stringify(N.getText(idOf(n)));
    if (t === 8) return '<!--' + N.getText(idOf(n)) + '-->';
    if (t === 9) return '#document';
    if (t === 11) return '#document-fragment';
    if (t === 10) return '<!DOCTYPE html>';
    return L.nodeNameOf(n);
  }
  function inspect(v, depth, seen, nested) {
    switch (typeof v) {
      case 'string': return nested ? quote(v) : v;
      case 'number': return Object.is(v, -0) ? '-0' : String(v);
      case 'bigint': return v + 'n';
      case 'boolean': return String(v);
      case 'undefined': return 'undefined';
      case 'symbol': return v.toString();
      case 'function': {
        const n = fnName(v);
        let src = '';
        try { src = L.nativeFunctionToString.call(v); } catch (_) { src = ''; }
        if (src.startsWith('class')) return `class ${n || '(anonymous)'}`;
        return `ƒ ${n}()`;
      }
      default: break;
    }
    if (v === null) return 'null';
    if (seen.has(v)) return '[Circular *]';
    try {
      if (isNode(v)) return inspectNode(v);
      if (v === L.window) return 'Window';
      if (v instanceof Error || (typeof v.stack === 'string' && typeof v.message === 'string' && 'name' in v)) return L.errToString(v);
      if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (typeof Promise === 'function' && v instanceof L.Promise) return 'Promise {<pending>}';
      if (depth < 0) return Array.isArray(v) ? `Array(${v.length})` : (ctorName(v) || 'Object') === 'Object' ? '{…}' : `${ctorName(v)}`;
      seen.add(v);
      try {
        if (Array.isArray(v)) {
          const parts = [];
          const n = Math.min(v.length, 100);
          for (let i = 0; i < n; i++) parts.push(i in v ? inspect(v[i], depth - 1, seen, true) : 'empty');
          if (v.length > 100) parts.push(`... ${v.length - 100} more items`);
          return (v.length > 6 || ctorName(v) !== 'Array' ? `${ctorName(v) === 'Array' ? '' : ctorName(v)}(${v.length}) ` : '') + '[' + parts.join(', ') + ']';
        }
        if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
          const parts = Array.from(v.slice(0, 100), (x) => String(x));
          if (v.length > 100) parts.push(`... ${v.length - 100} more items`);
          return `${ctorName(v)}(${v.length}) [${parts.join(', ')}]`;
        }
        if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
        if (v instanceof Map) {
          const parts = [];
          for (const [k, x] of v) parts.push(inspect(k, depth - 1, seen, true) + ' => ' + inspect(x, depth - 1, seen, true));
          return `Map(${v.size}) {${parts.join(', ')}}`;
        }
        if (v instanceof Set) {
          const parts = [];
          for (const x of v) parts.push(inspect(x, depth - 1, seen, true));
          return `Set(${v.size}) {${parts.join(', ')}}`;
        }
        const name = ctorName(v);
        const keys = Object.keys(v);
        const parts = [];
        for (const k of keys.slice(0, 50)) {
          let val;
          try { val = inspect(v[k], depth - 1, seen, true); } catch (_) { val = '[Exception]'; }
          parts.push((/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)) + ': ' + val);
        }
        if (keys.length > 50) parts.push('…');
        const tag = v[Symbol.toStringTag];
        const prefix = name === 'Object' ? '' : (name || (typeof tag === 'string' ? tag : '')) + ' ';
        return prefix + '{' + parts.join(', ') + '}';
      } finally {
        seen.delete(v);
      }
    } catch (_) {
      return '[object]';
    }
  }
  L.inspect = (v) => inspect(v, 2, new Set(), false);
  function formatArgs(args) {
    let out = [];
    let i = 0;
    if (typeof args[0] === 'string' && args[0].indexOf('%') >= 0) {
      const fmt = args[0];
      i = 1;
      let s = '';
      for (let j = 0; j < fmt.length; j++) {
        const c = fmt[j];
        if (c !== '%' || j + 1 >= fmt.length) { s += c; continue; }
        const d = fmt[j + 1];
        if (d === '%') { s += '%'; j++; continue; }
        if ('sdifoOcj'.indexOf(d) < 0) { s += c; continue; }
        j++;
        if (i >= args.length) { s += '%' + d; continue; }
        const a = args[i++];
        switch (d) {
          case 's': s += typeof a === 'string' ? a : typeof a === 'symbol' ? a.toString() : (a !== null && typeof a === 'object' ? inspect(a, 1, new Set(), true) : String(a)); break;
          case 'd': case 'i': s += typeof a === 'symbol' ? 'NaN' : String(d === 'i' || true ? (typeof a === 'bigint' ? a + 'n' : Math.trunc(Number(a))) : Number(a)); break;
          case 'f': s += typeof a === 'symbol' ? 'NaN' : String(Number(a)); break;
          case 'o': case 'O': case 'j': s += inspect(a, d === 'o' ? 4 : 2, new Set(), true); break;
          case 'c': break;
        }
      }
      out.push(s);
    }
    for (; i < args.length; i++) out.push(inspect(args[i], 2, new Set(), false));
    return out.join(' ');
  }
  L.formatArgs = formatArgs;
  function emit(level, args) {
    let msg;
    try { msg = formatArgs(args); } catch (_) { msg = '[unformattable]'; }
    if (consoleState.indent > 0) {
      const pad = '  '.repeat(consoleState.indent);
      msg = pad + msg.replace(/\n/g, '\n' + pad);
    }
    L.log(level, msg);
  }
  const console = {
    log(...a) { emit('log', a); },
    info(...a) { emit('info', a); },
    warn(...a) { emit('warn', a); },
    error(...a) { emit('error', a); },
    debug(...a) { emit('debug', a); },
    trace(...a) {
      let st = '';
      try { throw new Error(); } catch (e) { st = String(e.stack || '').split('\n').slice(2).join('\n'); }
      emit('log', ['Trace' + (a.length ? ': ' + formatArgs(a) : '') + (st ? '\n' + st : '')]);
    },
    dir(o) { emit('log', [inspect(o, 2, new Set(), true)]); },
    dirxml(...a) { emit('log', a); },
    table(data, columns) {
      if (data === null || typeof data !== 'object') { emit('log', [data]); return; }
      const rows = Object.keys(data);
      const colSet = new Set();
      const isPrim = (x) => x === null || typeof x !== 'object';
      let hasValues = false;
      for (const r of rows) {
        const v = data[r];
        if (isPrim(v)) hasValues = true;
        else for (const k of Object.keys(v)) colSet.add(k);
      }
      let cols = columns ? Array.from(columns, String) : Array.from(colSet);
      const header = ['(index)'].concat(cols, hasValues && !columns ? ['Value'] : []);
      const body = rows.map((r) => {
        const v = data[r];
        const line = [r];
        for (const c of cols) line.push(isPrim(v) || !(c in v) ? '' : inspect(v[c], 0, new Set(), true));
        if (hasValues && !columns) line.push(isPrim(v) ? inspect(v, 0, new Set(), true) : '');
        return line;
      });
      const widths = header.map((h, i) => Math.max(h.length, ...body.map((l) => String(l[i]).length)));
      const fmtRow = (l) => '│ ' + l.map((x, i) => String(x).padEnd(widths[i])).join(' │ ') + ' │';
      const sep = (a, b, c) => a + widths.map((w) => '─'.repeat(w + 2)).join(b) + c;
      emit('log', [[sep('┌', '┬', '┐'), fmtRow(header), sep('├', '┼', '┤')].concat(body.map(fmtRow), [sep('└', '┴', '┘')]).join('\n')]);
    },
    group(...a) { if (a.length) emit('log', a); consoleState.indent++; },
    groupCollapsed(...a) { if (a.length) emit('log', a); consoleState.indent++; },
    groupEnd() { if (consoleState.indent > 0) consoleState.indent--; },
    time(label = 'default') {
      const l = `${label}`;
      if (consoleState.timers.has(l)) { emit('warn', [`Timer '${l}' already exists`]); return; }
      consoleState.timers.set(l, N.now());
    },
    timeLog(label = 'default', ...data) {
      const l = `${label}`;
      const t = consoleState.timers.get(l);
      if (t === undefined) { emit('warn', [`Timer '${l}' does not exist`]); return; }
      emit('log', [`${l}: ${(N.now() - t).toFixed(3)} ms`].concat(data));
    },
    timeEnd(label = 'default') {
      const l = `${label}`;
      const t = consoleState.timers.get(l);
      if (t === undefined) { emit('warn', [`Timer '${l}' does not exist`]); return; }
      consoleState.timers.delete(l);
      emit('log', [`${l}: ${(N.now() - t).toFixed(3)} ms`]);
    },
    count(label = 'default') {
      const l = `${label}`;
      const n = (consoleState.counts.get(l) || 0) + 1;
      consoleState.counts.set(l, n);
      emit('log', [`${l}: ${n}`]);
    },
    countReset(label = 'default') { consoleState.counts.set(`${label}`, 0); },
    assert(condition, ...data) {
      if (condition) return;
      if (data.length === 0) emit('error', ['Assertion failed']);
      else if (typeof data[0] === 'string') emit('error', ['Assertion failed: ' + data[0]].concat(data.slice(1)));
      else emit('error', ['Assertion failed:'].concat(data));
    },
    clear() { },
    profile() { }, profileEnd() { }, timeStamp() { },
    context() { return console; },
    createTask() { return { run(f) { return f(); } }; },
  };
  Object.defineProperty(console, Symbol.toStringTag, { value: 'console', configurable: true });
  L.console = console;

  // =======================================================================================
  // navigator
  // =======================================================================================
  let uaCache = null;
  function ua() { if (uaCache === null) uaCache = `${N.userAgent()}`; return uaCache; }
  function chromeVersion() { const m = /Chrome\/(\d+)(?:\.(\d+\.\d+\.\d+))?/.exec(ua()); return m ? [m[1], m[1] + '.' + (m[2] || '0.0.0')] : ['130', '130.0.0.0']; }
  class MimeType {
    #d;
    constructor(token, d) { if (token !== INTERNAL) throw L.illegal(); this.#d = d; }
    get type() { return this.#d.type; }
    get suffixes() { return 'pdf'; }
    get description() { return 'Portable Document Format'; }
    get enabledPlugin() { return this.#d.plugin(); }
  }
  class Plugin {
    #name; #mimes;
    constructor(token, name, mimes) { if (token !== INTERNAL) throw L.illegal(); this.#name = name; this.#mimes = mimes; }
    static { L.pluginMimes = (p) => p.#mimes; }
    get name() { return this.#name; }
    get filename() { return 'internal-pdf-viewer'; }
    get description() { return 'Portable Document Format'; }
    get length() { return this.#mimes.length; }
    item(i) { return this.#mimes[Number(i) >>> 0] || null; }
    namedItem(n) { return this.#mimes.find((m) => m.type === `${n}`) || null; }
  }
  L.makeIndexed(Plugin.prototype, (o, i) => L.pluginMimes(o)[i], 4);
  class PluginArray {
    #list;
    constructor(token, list) { if (token !== INTERNAL) throw L.illegal(); this.#list = list; }
    static { L.pluginList = (o) => o.#list; }
    get length() { return this.#list.length; }
    item(i) { return this.#list[Number(i) >>> 0] || null; }
    namedItem(n) { return this.#list.find((p) => p.name === `${n}`) || null; }
    refresh() { }
    *[Symbol.iterator]() { yield* this.#list; }
  }
  L.makeIndexed(PluginArray.prototype, (o, i) => L.pluginList(o)[i], 8);
  class MimeTypeArray {
    #list;
    constructor(token, list) { if (token !== INTERNAL) throw L.illegal(); this.#list = list; }
    static { L.mimeList = (o) => o.#list; }
    get length() { return this.#list.length; }
    item(i) { return this.#list[Number(i) >>> 0] || null; }
    namedItem(n) { return this.#list.find((m) => m.type === `${n}`) || null; }
    *[Symbol.iterator]() { yield* this.#list; }
  }
  L.makeIndexed(MimeTypeArray.prototype, (o, i) => L.mimeList(o)[i], 4);
  let pluginsObj = null, mimeTypesObj = null;
  function buildPlugins() {
    let first = null;
    const mimes = [];
    const pdf = new MimeType(INTERNAL, { type: 'application/pdf', plugin: () => first });
    const tpdf = new MimeType(INTERNAL, { type: 'text/pdf', plugin: () => first });
    mimes.push(pdf, tpdf);
    const plugins = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF']
      .map((n) => new Plugin(INTERNAL, n, mimes));
    first = plugins[0];
    pluginsObj = new PluginArray(INTERNAL, plugins);
    mimeTypesObj = new MimeTypeArray(INTERNAL, mimes);
  }
  class PermissionStatus extends EventTarget {
    #name; #state;
    constructor(token, name, st) { if (token !== INTERNAL) throw L.illegal(); super(); this.#name = name; this.#state = st; }
    get name() { return this.#name; }
    get state() { return this.#state; }
  }
  L.defineEventHandlers(PermissionStatus.prototype, ['onchange']);
  const PERMISSION_NAMES = ['accelerometer', 'background-fetch', 'background-sync', 'camera', 'clipboard-read', 'clipboard-write',
    'display-capture', 'geolocation', 'gyroscope', 'local-fonts', 'magnetometer', 'microphone', 'midi', 'notifications',
    'payment-handler', 'persistent-storage', 'push', 'screen-wake-lock', 'storage-access', 'top-level-storage-access',
    'window-management', 'idle-detection', 'periodic-background-sync', 'system-wake-lock', 'nfc', 'speaker-selection', 'captured-surface-control', 'keyboard-lock', 'pointer-lock'];
  class Permissions {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    query(desc) {
      if (desc === null || typeof desc !== 'object') return L.rejectedPromise(new TypeError("Failed to execute 'query' on 'Permissions': parameter 1 is not of type 'Object'."));
      const name = `${desc.name}`;
      if (!PERMISSION_NAMES.includes(name)) return L.rejectedPromise(new TypeError(`Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': The provided value '${name}' is not a valid enum value of type PermissionName.`));
      const st = name === 'clipboard-write' ? 'granted' : 'prompt';
      return L.resolvedPromise(new PermissionStatus(INTERNAL, name, st));
    }
  }
  class ClipboardItem {
    #items; #options;
    constructor(items, options) {
      if (items === null || typeof items !== 'object') throw new TypeError("Failed to construct 'ClipboardItem': parameter 1 is not of type 'object'.");
      this.#items = Object.assign({}, items);
      this.#options = options || {};
    }
    get types() { return Object.freeze(Object.keys(this.#items)); }
    get presentationStyle() { return this.#options.presentationStyle || 'unspecified'; }
    getType(type) {
      const t = `${type}`;
      if (!(t in this.#items)) return L.rejectedPromise(new DOMException(`Failed to execute 'getType' on 'ClipboardItem': The type was not found`, 'NotFoundError'));
      return L.resolvedPromise(this.#items[t]).then((v) => (v instanceof Blob ? v : new Blob([`${v}`], { type: t })));
    }
    static supports(type) { return ['text/plain', 'text/html', 'image/png', 'image/svg+xml'].includes(`${type}`); }
  }
  class Clipboard extends EventTarget {
    #text = '';
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    readText() { return L.rejectedPromise(new DOMException('Read permission denied.', 'NotAllowedError')); }
    read() { return L.rejectedPromise(new DOMException('Read permission denied.', 'NotAllowedError')); }
    writeText(data) { this.#text = `${data}`; if (typeof N.clipboardWrite === 'function') { try { N.clipboardWrite(this.#text); } catch (_) { } } return L.resolvedPromise(undefined); }
    write(items) { return L.resolvedPromise(undefined); }
  }
  class NavigatorUAData {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get brands() { const [v] = chromeVersion(); return Object.freeze([Object.freeze({ brand: 'Chromium', version: v }), Object.freeze({ brand: 'Google Chrome', version: v }), Object.freeze({ brand: 'Not?A_Brand', version: '99' })]); }
    get mobile() { return false; }
    get platform() { return 'Windows'; }
    getHighEntropyValues(hints) {
      const [v, full] = chromeVersion();
      const all = {
        brands: this.brands, mobile: false, platform: 'Windows', architecture: 'x86', bitness: '64', model: '',
        platformVersion: '15.0.0', uaFullVersion: full, wow64: false, formFactors: ['Desktop'],
        fullVersionList: Object.freeze([{ brand: 'Chromium', version: full }, { brand: 'Google Chrome', version: full }, { brand: 'Not?A_Brand', version: '99.0.0.0' }]),
      };
      const out = { brands: all.brands, mobile: false, platform: 'Windows' };
      for (const h of Array.from(hints || [], String)) if (h in all) out[h] = all[h];
      void v;
      return L.resolvedPromise(out);
    }
    toJSON() { return { brands: this.brands, mobile: false, platform: 'Windows' }; }
  }
  class NetworkInformation extends EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    get effectiveType() { return '4g'; }
    get rtt() { return 50; }
    get downlink() { return 10; }
    get saveData() { return false; }
  }
  L.defineEventHandlers(NetworkInformation.prototype, ['onchange']);
  class StorageManager {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    estimate() { return L.resolvedPromise({ quota: 299977904946, usage: 0, usageDetails: {} }); }
    persist() { return L.resolvedPromise(false); }
    persisted() { return L.resolvedPromise(false); }
    getDirectory() { return L.rejectedPromise(new DOMException('The operation is not supported.', 'SecurityError')); }
  }
  class GeolocationPositionError {
    #code; #message;
    constructor(token, code, message) { if (token !== INTERNAL) throw L.illegal(); this.#code = code; this.#message = message; }
    get code() { return this.#code; }
    get message() { return this.#message; }
  }
  L.defineConstants([GeolocationPositionError, GeolocationPositionError.prototype], { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  let geoWatch = 0;
  class Geolocation {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    getCurrentPosition(success, error) {
      if (typeof error === 'function') L.postTask(() => L.safeCall(error, undefined, [new GeolocationPositionError(INTERNAL, 1, 'User denied Geolocation')]));
    }
    watchPosition(success, error) {
      this.getCurrentPosition(success, error);
      return ++geoWatch;
    }
    clearWatch() { }
  }
  // navigator.locks (Web Locks): in-page implementation
  class Lock {
    #name; #mode;
    constructor(token, name, mode) { if (token !== INTERNAL) throw L.illegal(); this.#name = name; this.#mode = mode; }
    get name() { return this.#name; }
    get mode() { return this.#mode; }
  }
  const lockState = new Map(); // name -> {held: [{mode}], queue: [req]}
  class LockManager {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    request(name, options, callback) {
      if (callback === undefined) { callback = options; options = {}; }
      const n = `${name}`;
      const mode = options && options.mode === 'shared' ? 'shared' : 'exclusive';
      if (typeof callback !== 'function') return L.rejectedPromise(new TypeError("Failed to execute 'request' on 'LockManager': parameter 2 is not a function."));
      if (n.startsWith('-')) return L.rejectedPromise(new DOMException("Failed to execute 'request' on 'LockManager': Names cannot start with '-'.", 'NotSupportedError'));
      let st = lockState.get(n);
      if (st === undefined) { st = { held: [], queue: [] }; lockState.set(n, st); }
      return L.newPromise((resolve, reject) => {
        const req = { mode, callback, resolve, reject, options: options || {} };
        const grantable = () => st.queue.length === 0 && (st.held.length === 0 || (mode === 'shared' && st.held.every((h) => h.mode === 'shared')));
        if (req.options.ifAvailable && !grantable()) {
          L.microtask(() => { try { resolve(callback(null)); } catch (e) { reject(e); } });
          return;
        }
        if (req.options.signal && L.signalAborted(req.options.signal)) { reject(L.signalReason(req.options.signal)); return; }
        st.queue.push(req);
        processLocks(n);
      });
    }
    query() {
      const held = [], pending = [];
      for (const [name, st] of lockState) {
        for (const h of st.held) held.push({ name, mode: h.mode, clientId: 'main' });
        for (const q of st.queue) pending.push({ name, mode: q.mode, clientId: 'main' });
      }
      return L.resolvedPromise({ held, pending });
    }
  }
  function processLocks(name) {
    const st = lockState.get(name);
    while (st.queue.length) {
      const req = st.queue[0];
      const ok = st.held.length === 0 || (req.mode === 'shared' && st.held.every((h) => h.mode === 'shared'));
      if (!ok) break;
      st.queue.shift();
      const h = { mode: req.mode };
      st.held.push(h);
      L.microtask(() => {
        let r;
        try { r = req.callback(new Lock(INTERNAL, name, req.mode)); } catch (e) { r = L.rejectedPromise(e); }
        L.resolvedPromise(r).then((v) => { release(); req.resolve(v); }, (e) => { release(); req.reject(e); });
      });
      const release = () => {
        const i = st.held.indexOf(h);
        if (i >= 0) st.held.splice(i, 1);
        processLocks(name);
      };
    }
  }
  const navState = {};
  function lazy(key, make) { if (navState[key] === undefined) navState[key] = make(); return navState[key]; }
  class Navigator {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get userAgent() { return ua(); }
    get appVersion() { return ua().replace(/^Mozilla\//, ''); }
    get appName() { return 'Netscape'; }
    get appCodeName() { return 'Mozilla'; }
    get product() { return 'Gecko'; }
    get productSub() { return '20030107'; }
    get vendor() { return 'Google Inc.'; }
    get vendorSub() { return ''; }
    get platform() { return 'Win32'; }
    get oscpu() { return undefined; }
    get language() { return 'de-DE'; }
    get languages() { return lazy('languages', () => Object.freeze(['de-DE', 'de', 'en-US', 'en'])); }
    get onLine() { return true; }
    get cookieEnabled() { return true; }
    get hardwareConcurrency() { return 8; }
    get deviceMemory() { return 8; }
    get maxTouchPoints() { return 0; }
    get webdriver() { return false; }
    get pdfViewerEnabled() { return true; }
    get doNotTrack() { return null; }
    get plugins() { if (pluginsObj === null) buildPlugins(); return pluginsObj; }
    get mimeTypes() { if (mimeTypesObj === null) buildPlugins(); return mimeTypesObj; }
    javaEnabled() { return false; }
    get clipboard() { return lazy('clipboard', () => new Clipboard(INTERNAL)); }
    get permissions() { return lazy('permissions', () => new Permissions(INTERNAL)); }
    get userAgentData() { return lazy('uad', () => new NavigatorUAData(INTERNAL)); }
    get connection() { return lazy('connection', () => new NetworkInformation(INTERNAL)); }
    get storage() { return lazy('storage', () => new StorageManager(INTERNAL)); }
    get geolocation() { return lazy('geolocation', () => new Geolocation(INTERNAL)); }
    get locks() { return lazy('locks', () => new LockManager(INTERNAL)); }
    get mediaDevices() { return undefined; }
    get serviceWorker() { return undefined; }
    sendBeacon(url, data) {
      const p = N.urlParse(L.toUSV(url), L.baseURL());
      if (p === null) throw new TypeError(`Failed to execute 'sendBeacon' on 'Navigator': The URL argument is ill-formed or unsupported.`);
      let bytes = null, type = null;
      if (data !== undefined && data !== null) {
        const ex = extractBody(data, false);
        bytes = ex.bytes; type = ex.type;
      }
      const flat = type ? ['Content-Type', type] : [];
      L.startNativeFetch('POST', p[0], flat, bytes === null ? null : copyToArrayBuffer(bytes), 'no-cors', () => { }, 'include');
      return true;
    }
    registerProtocolHandler() { }
    unregisterProtocolHandler() { }
    getGamepads() { return [null, null, null, null]; }
    vibrate() { return true; }
    getBattery() {
      return L.resolvedPromise(lazy('battery', () => {
        const b = new EventTarget();
        Object.defineProperties(b, { charging: { value: true }, chargingTime: { value: 0 }, dischargingTime: { value: Infinity }, level: { value: 1 } });
        return b;
      }));
    }
  }
  const navigator = new Navigator(INTERNAL);
  L.navigator = navigator;

  // =======================================================================================
  // screen / visualViewport
  // =======================================================================================
  function vp() { L.flushSheets(); return N.viewport(); }
  L.viewport = vp;
  L.scrollX = () => N.viewport()[3];
  L.scrollY = () => N.viewport()[4];
  class ScreenOrientation extends EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    get type() { const v = N.viewport(); return v[5] >= v[6] ? 'landscape-primary' : 'portrait-primary'; }
    get angle() { return 0; }
    lock() { return L.rejectedPromise(new DOMException('screen.orientation.lock() is not available on this device.', 'NotSupportedError')); }
    unlock() { }
  }
  L.defineEventHandlers(ScreenOrientation.prototype, ['onchange']);
  class Screen extends EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    get width() { return N.viewport()[5]; }
    get height() { return N.viewport()[6]; }
    get availWidth() { return N.viewport()[5]; }
    get availHeight() { return N.viewport()[6]; }
    get availLeft() { return 0; }
    get availTop() { return 0; }
    get colorDepth() { return 24; }
    get pixelDepth() { return 24; }
    get isExtended() { return false; }
    get orientation() { return lazy('orientation', () => new ScreenOrientation(INTERNAL)); }
  }
  L.defineEventHandlers(Screen.prototype, ['onchange']);
  const screen = new Screen(INTERNAL);
  L.screen = screen;
  class VisualViewport extends EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    get offsetLeft() { return 0; }
    get offsetTop() { return 0; }
    get pageLeft() { return N.viewport()[3]; }
    get pageTop() { return N.viewport()[4]; }
    get width() { return N.viewport()[0]; }
    get height() { return N.viewport()[1]; }
    get scale() { return 1; }
  }
  L.defineEventHandlers(VisualViewport.prototype, ['onresize', 'onscroll', 'onscrollend']);
  L.visualViewport = new VisualViewport(INTERNAL);

  // =======================================================================================
  // Location / History
  // =======================================================================================
  const locCache = { url: null, p: null };
  function curParts() {
    const u = L.documentURL();
    if (u !== locCache.url) {
      locCache.url = u;
      locCache.p = N.urlParse(u, null) || [u, ':', '', '', '', '', '', '', '', '', 'null'];
    }
    return locCache.p;
  }
  function stripHash(u) { const i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }
  L.lastURL = null;
  // "Scroll to the fragment": the element with that id (or a[name]), or the top for ''/#top.
  function scrollToFragment(url) {
    const i = url.indexOf('#');
    if (i < 0) return;
    const raw = url.slice(i + 1);
    let dec = raw;
    try { dec = decodeURIComponent(raw); } catch (_) { dec = raw; }
    let id = 0;
    try {
      if (dec !== '') {
        id = N.getElementById(dec);
        if (id === 0 && dec !== raw) id = N.getElementById(raw);
        if (id === 0) id = N.querySelector(L.documentId, 'a[name=' + L.cssString(dec) + ']');
      }
      if (id !== 0) N.scrollIntoView(id);
      else if (dec === '' || dec.toLowerCase() === 'top') N.scrollTo(0, 0);
    } catch (_) { /* scrolling is best effort */ }
  }
  function fragmentNavigate(target, replace) {
    const old = L.documentURL();
    N.historyPush(target, !!replace || old === target);
    L.invalidateDocumentURL();
    historyAfterPush(null, !!replace || old === target);
    scrollToFragment(target);
    if (old === target) return;
    L.fire(L.window, 'popstate', { state: null }, L.PopStateEvent);
    L.postTask(() => L.fire(L.window, 'hashchange', { oldURL: old, newURL: target }, L.HashChangeEvent));
  }
  function navigateTo(url, replace, method) {
    const p = N.urlParse(L.toUSV(url), L.baseURL());
    if (p === null) throw new DOMException(`Failed to execute '${method}' on 'Location': '${url}' is not a valid URL.`, 'SyntaxError');
    const target = p[0];
    if (p[1] === 'javascript:') { L.postTask(() => L.runJavascriptURL(target)); return; }
    const cur = L.documentURL();
    if (target.includes('#') && stripHash(target) === stripHash(cur)) { fragmentNavigate(target, replace); return; }
    N.navigate(target, !!replace);
  }
  L.navigateTo = navigateTo;
  class Location {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get href() { return L.documentURL(); }
    set href(v) { navigateTo(`${v}`, false, 'href'); }
    get origin() { return curParts()[10]; }
    get protocol() { return curParts()[1]; }
    set protocol(v) { setLocPart('protocol', v); }
    get host() { return curParts()[4]; }
    set host(v) { setLocPart('host', v); }
    get hostname() { return curParts()[5]; }
    set hostname(v) { setLocPart('hostname', v); }
    get port() { return curParts()[6]; }
    set port(v) { setLocPart('port', v); }
    get pathname() { return curParts()[7]; }
    set pathname(v) { setLocPart('pathname', v); }
    get search() { return curParts()[8]; }
    set search(v) { setLocPart('search', v); }
    get hash() { return curParts()[9]; }
    set hash(v) {
      const u = new URL(L.documentURL());
      let s = `${v}`;
      if (s.startsWith('#')) s = s.slice(1);
      u.hash = s;
      const target = s === '' && !u.href.includes('#') ? u.href + '#' : u.href;
      if (target === L.documentURL()) return;
      fragmentNavigate(target, false);
    }
    assign(url) { navigateTo(`${url}`, false, 'assign'); }
    replace(url) { navigateTo(`${url}`, true, 'replace'); }
    reload() { N.reload(); }
    toString() { return L.documentURL(); }
    get ancestorOrigins() { return lazy('ancestorOrigins', () => L.makeDOMStringList([])); }
  }
  function setLocPart(part, v) {
    const u = new URL(L.documentURL());
    u[part] = v;
    navigateTo(u.href, false, part);
  }
  const location = new Location(INTERNAL);
  L.location = location;
  class DOMStringList {
    #list;
    constructor(token, list) { if (token !== INTERNAL) throw L.illegal(); this.#list = list; }
    static { L.dslItems = (o) => o.#list; }
    get length() { return this.#list.length; }
    item(i) { const v = this.#list[Number(i) >>> 0]; return v === undefined ? null : v; }
    contains(s) { return this.#list.includes(`${s}`); }
    *[Symbol.iterator]() { yield* this.#list; }
  }
  L.makeIndexed(DOMStringList.prototype, (o, i) => L.dslItems(o)[i], 8);
  L.makeDOMStringList = (list) => new DOMStringList(INTERNAL, list);

  // states/urls are keyed by session history index (N.historyIndex()); urls let us notice a
  // new entry created by a Rust-side fragment navigation at an index that had a (pruned) state.
  const hist = { current: null, states: new Map(), urls: new Map(), fallbackIndex: 0, fallbackLength: 1, scroll: 'auto' };
  function pruneHistoryFrom(idx) {
    for (const k of Array.from(hist.states.keys())) if (k >= idx) hist.states.delete(k);
    for (const k of Array.from(hist.urls.keys())) if (k >= idx) hist.urls.delete(k);
  }
  function historyIndex() {
    if (typeof N.historyIndex === 'function') { try { return N.historyIndex(); } catch (_) { /* fall through */ } }
    return hist.fallbackIndex;
  }
  function historyAfterPush(state, replace) {
    if (!replace && typeof N.historyIndex !== 'function') {
      hist.fallbackIndex++;
      hist.fallbackLength = hist.fallbackIndex + 1;
    }
    const idx = historyIndex();
    if (!replace) pruneHistoryFrom(idx + 1);
    hist.states.set(idx, state);
    hist.urls.set(idx, L.documentURL());
    hist.current = state;
  }
  function updateHistory(data, url, replace, method) {
    const state = cloneValue(data);
    let target = L.documentURL();
    if (url !== undefined && url !== null) {
      const p = N.urlParse(L.toUSV(url), L.baseURL());
      const cur = curParts();
      if (p === null || p[10] !== cur[10] || (p[10] === 'null' && p[1] !== cur[1])) {
        throw new DOMException(`Failed to execute '${method}' on 'History': A history state object with URL '${url}' cannot be created in a document with origin '${cur[10]}' and URL '${L.documentURL()}'.`, 'SecurityError');
      }
      target = p[0];
    }
    N.historyPush(target, replace);
    L.invalidateDocumentURL();
    historyAfterPush(state, replace);
  }
  class History {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get length() {
      if (typeof N.historyLength === 'function') { try { return N.historyLength(); } catch (_) { /* ignore */ } }
      return hist.fallbackLength;
    }
    get scrollRestoration() { return hist.scroll; }
    set scrollRestoration(v) { const s = `${v}`; if (s === 'auto' || s === 'manual') hist.scroll = s; }
    get state() { return hist.current; }
    go(delta = 0) {
      const d = L.toLong(delta);
      if (d === 0) { N.reload(); return; }
      N.historyGo(d);
    }
    back() { N.historyGo(-1); }
    forward() { N.historyGo(1); }
    pushState(data, unused, url) { updateHistory(data, url, false, 'pushState'); }
    replaceState(data, unused, url) { updateHistory(data, url, true, 'replaceState'); }
  }
  const history = new History(INTERNAL);
  L.history = history;
  // Rust notifies a same-document history traversal / fragment navigation it performed.
  L.onPopState = function (url, index) {
    const old = L.documentURL();
    L.invalidateDocumentURL();
    const now = L.documentURL();
    if (typeof index === 'number' && typeof N.historyIndex !== 'function') hist.fallbackIndex = index;
    const idx = typeof index === 'number' ? index : historyIndex();
    const known = hist.urls.get(idx);
    if (known !== undefined && known !== now) pruneHistoryFrom(idx); // a new entry replaced this index
    hist.urls.set(idx, now);
    hist.current = hist.states.has(idx) ? hist.states.get(idx) : null;
    L.fire(L.window, 'popstate', { state: hist.current }, L.PopStateEvent);
    if (old !== now && stripHash(old) === stripHash(now)) {
      L.postTask(() => L.fire(L.window, 'hashchange', { oldURL: old, newURL: now }, L.HashChangeEvent));
    }
  };

  // =======================================================================================
  // Storage
  // =======================================================================================
  const storageKind = new WeakMap();
  function sk(o) { const k = storageKind.get(o); if (k === undefined) throw new TypeError('Illegal invocation'); return k; }
  function storageSet(kind, key, value) {
    try { N.storageSet(kind, key, value); } catch (e) {
      const c = L.fromNative(e);
      throw c instanceof DOMException ? c : new DOMException(`Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`, 'QuotaExceededError');
    }
  }
  class Storage {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get length() { return N.storageKeys(sk(this)).length; }
    key(index) { const k = N.storageKeys(sk(this))[Number(index) >>> 0]; return k === undefined ? null : k; }
    getItem(key) { return N.storageGet(sk(this), `${key}`); }
    setItem(key, value) {
      if (arguments.length < 2) throw new TypeError(`Failed to execute 'setItem' on 'Storage': 2 arguments required, but only ${arguments.length} present.`);
      storageSet(sk(this), `${key}`, `${value}`);
    }
    removeItem(key) { N.storageRemove(sk(this), `${key}`); }
    clear() { N.storageClear(sk(this)); }
  }
  const storageHandler = {
    get(t, p, r) {
      if (typeof p === 'string' && !(p in t)) {
        const v = N.storageGet(storageKind.get(t), p);
        return v === null ? undefined : v;
      }
      return Reflect.get(t, p, r);
    },
    set(t, p, v, r) {
      if (typeof p === 'string') { storageSet(storageKind.get(t), p, `${v}`); return true; }
      return Reflect.set(t, p, v, r);
    },
    has(t, p) {
      if (typeof p === 'string' && N.storageGet(storageKind.get(t), p) !== null) return true;
      return Reflect.has(t, p);
    },
    deleteProperty(t, p) {
      if (typeof p === 'string') { N.storageRemove(storageKind.get(t), p); return true; }
      return Reflect.deleteProperty(t, p);
    },
    ownKeys(t) { return N.storageKeys(storageKind.get(t)).concat(Reflect.ownKeys(t)); },
    getOwnPropertyDescriptor(t, p) {
      if (typeof p === 'string' && !(p in t)) {
        const v = N.storageGet(storageKind.get(t), p);
        if (v !== null) return { value: v, writable: true, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(t, p);
    },
    defineProperty(t, p, desc) {
      if (typeof p === 'string' && 'value' in desc) { storageSet(storageKind.get(t), p, `${desc.value}`); return true; }
      return Reflect.defineProperty(t, p, desc);
    },
  };
  function makeStorage(kind) {
    const t = new Storage(INTERNAL);
    storageKind.set(t, kind);
    const p = new Proxy(t, storageHandler);
    storageKind.set(p, kind);
    return p;
  }
  L.localStorage = makeStorage(0);
  L.sessionStorage = makeStorage(1);

  // =======================================================================================
  // matchMedia / MediaQueryList
  // =======================================================================================
  const mqls = [];
  const mqlData = new WeakMap();
  class MediaQueryList extends EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    get media() { return mqlData.get(this).media; }
    get matches() { const d = mqlData.get(this); L.flushSheets(); return evalMQ(d.media); }
    addListener(cb) { if (cb !== null && cb !== undefined) this.addEventListener('change', cb); }
    removeListener(cb) { if (cb !== null && cb !== undefined) this.removeEventListener('change', cb); }
  }
  L.defineEventHandlers(MediaQueryList.prototype, ['onchange']);
  function evalMQ(q) {
    if (q.trim() === '') return true;
    try { return !!N.matchMedia(q); } catch (_) { return false; }
  }
  function matchMedia(query) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'matchMedia' on 'Window': 1 argument required, but only 0 present.");
    const q = `${query}`.trim().replace(/\s+/g, ' ');
    const m = new MediaQueryList(INTERNAL);
    mqlData.set(m, { media: q, last: evalMQ(q) });
    mqls.push(typeof WeakRef === 'function' ? new WeakRef(m) : { deref: () => m });
    return m;
  }
  L.checkMediaQueries = function () {
    for (let i = 0; i < mqls.length; i++) {
      const m = mqls[i].deref();
      if (m === undefined) { mqls.splice(i--, 1); continue; }
      const d = mqlData.get(m);
      const now = evalMQ(d.media);
      if (now !== d.last) {
        d.last = now;
        L.fire(m, 'change', { media: d.media, matches: now }, L.MediaQueryListEvent);
      }
    }
  };

  // =======================================================================================
  // IntersectionObserver / ResizeObserver
  // =======================================================================================
  const ioObservers = new Set();
  const roObservers = new Set();
  L.observersDirty = function () {
    if (ioObservers.size === 0 && roObservers.size === 0) return;
    if (!obsDirty) { obsDirty = true; requestFrame(); }
  };
  function parseMargin(s, method) {
    const parts = `${s}`.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) parts.push('0px');
    if (parts.length > 4) throw new DOMException(`Failed to construct 'IntersectionObserver': ${method} must be specified in pixels or percent.`, 'SyntaxError');
    const vals = parts.map((p) => {
      const m = /^(-?\d*\.?\d+)(px|%)?$/.exec(p);
      if (!m || (m[2] === undefined && Number(m[1]) !== 0)) throw new DOMException(`Failed to construct 'IntersectionObserver': ${method} must be specified in pixels or percent.`, 'SyntaxError');
      return { v: Number(m[1]), pct: m[2] === '%' };
    });
    const [t, r = t, b = t, l = r] = vals;
    return [t, r, b, l];
  }
  function marginString(m) { return m.map((x) => x.v + (x.pct ? '%' : 'px')).join(' '); }
  class IntersectionObserverEntry {
    #d;
    constructor(token, d) { if (token !== INTERNAL) throw L.illegal(); this.#d = d; }
    get time() { return this.#d.time; }
    get rootBounds() { return this.#d.rootBounds; }
    get boundingClientRect() { return this.#d.boundingClientRect; }
    get intersectionRect() { return this.#d.intersectionRect; }
    get isIntersecting() { return this.#d.isIntersecting; }
    get isVisible() { return false; }
    get intersectionRatio() { return this.#d.intersectionRatio; }
    get target() { return this.#d.target; }
  }
  class IntersectionObserver {
    #cb; #root; #margin; #scrollMargin; #thresholds; #targets = new Map(); #records = []; #queued = false;
    constructor(callback, options) {
      if (typeof callback !== 'function') throw new TypeError("Failed to construct 'IntersectionObserver': The callback provided as parameter 1 is not a function.");
      const o = options || {};
      this.#cb = callback;
      const root = o.root === undefined ? null : o.root;
      if (root !== null && !(isNode(root) && (typeOf(root) === 1 || typeOf(root) === 9))) throw new TypeError("Failed to construct 'IntersectionObserver': Failed to read the 'root' property from 'IntersectionObserverInit': The provided value is not of type '(Document or Element)'.");
      this.#root = root;
      this.#margin = parseMargin(o.rootMargin === undefined ? '0px' : o.rootMargin, 'rootMargin');
      this.#scrollMargin = parseMargin(o.scrollMargin === undefined ? '0px' : o.scrollMargin, 'scrollMargin');
      let th = o.threshold === undefined ? [0] : Array.isArray(o.threshold) ? o.threshold.slice() : [o.threshold];
      th = th.map(Number);
      for (const t of th) if (!(t >= 0 && t <= 1)) throw new RangeError("Failed to construct 'IntersectionObserver': Threshold values must be numbers between 0 and 1");
      th.sort((a, b) => a - b);
      if (th.length === 0) th = [0];
      this.#thresholds = Object.freeze(th);
    }
    get root() { return this.#root; }
    get rootMargin() { return marginString(this.#margin); }
    get scrollMargin() { return marginString(this.#scrollMargin); }
    get thresholds() { return this.#thresholds; }
    get delay() { return 0; }
    get trackVisibility() { return false; }
    observe(target) {
      if (!isNode(target) || typeOf(target) !== 1) throw new TypeError("Failed to execute 'observe' on 'IntersectionObserver': parameter 1 is not of type 'Element'.");
      if (this.#targets.has(target)) return;
      this.#targets.set(target, { prevIndex: -1, prevIntersecting: false });
      ioObservers.add(this);
      obsDirty = true;
      requestFrame();
    }
    unobserve(target) {
      this.#targets.delete(target);
      if (this.#targets.size === 0) ioObservers.delete(this);
    }
    disconnect() { this.#targets.clear(); ioObservers.delete(this); }
    takeRecords() { const r = this.#records; this.#records = []; return r; }
    static {
      L.ioCheck = (o, time, vpRect) => {
        let rootRect;
        const root = o.#root;
        if (root === null || root === L.document) rootRect = vpRect;
        else {
          const r = N.getBoundingClientRect(idOf(root));
          const c = N.clientMetrics(idOf(root));
          rootRect = [r[0] + c[0], r[1] + c[1], c[2] || r[2], c[3] || r[3]];
        }
        const m = o.#margin;
        const px = (x, base) => (x.pct ? base * x.v / 100 : x.v);
        const rx = rootRect[0] - px(m[3], rootRect[2]);
        const ry = rootRect[1] - px(m[0], rootRect[3]);
        const rr = rootRect[0] + rootRect[2] + px(m[1], rootRect[2]);
        const rb = rootRect[1] + rootRect[3] + px(m[2], rootRect[3]);
        for (const [target, reg] of o.#targets) {
          const id = idOf(target);
          const t = N.getBoundingClientRect(id);
          let isInt = false, ix = 0, iy = 0, iw = 0, ih = 0;
          const connected = N.isConnected(id) && (root === null || root === L.document || N.contains(idOf(root), id));
          if (connected) {
            const l = Math.max(t[0], rx), tp = Math.max(t[1], ry), r = Math.min(t[0] + t[2], rr), b = Math.min(t[1] + t[3], rb);
            if (r >= l && b >= tp && !(t[2] === 0 && t[3] === 0 && N.getClientRects(id).length === 0)) {
              isInt = true; ix = l; iy = tp; iw = r - l; ih = b - tp;
            }
          }
          const area = t[2] * t[3];
          const ratio = isInt ? (area > 0 ? (iw * ih) / area : 1) : 0;
          const th = o.#thresholds;
          let idx = 0;
          while (idx < th.length && th[idx] <= ratio) idx++;
          if (!isInt) idx = 0;
          if (idx !== reg.prevIndex || isInt !== reg.prevIntersecting) {
            reg.prevIndex = idx;
            reg.prevIntersecting = isInt;
            o.#records.push(new IntersectionObserverEntry(INTERNAL, {
              time, rootBounds: new L.DOMRectReadOnly(rx, ry, rr - rx, rb - ry),
              boundingClientRect: new L.DOMRectReadOnly(t[0], t[1], t[2], t[3]),
              intersectionRect: new L.DOMRectReadOnly(ix, iy, iw, ih),
              isIntersecting: isInt, intersectionRatio: Math.min(1, ratio), target,
            }));
          }
        }
        if (o.#records.length && !o.#queued) {
          o.#queued = true;
          L.postTask(() => {
            o.#queued = false;
            const recs = o.#records;
            o.#records = [];
            if (recs.length) { try { Reflect.apply(o.#cb, o, [recs, o]); } catch (e) { L.reportException(e); } }
          });
        }
      };
    }
  }
  let lastScrollCheck = null;
  function runIntersectionObservers(time, dirty) {
    if (ioObservers.size === 0) return;
    const v = N.viewport();
    const key = v[0] + ',' + v[1] + ',' + v[3] + ',' + v[4];
    if (!dirty && key === lastScrollCheck) return;
    lastScrollCheck = key;
    L.flushSheets();
    const vpRect = [0, 0, v[0], v[1]];
    for (const o of Array.from(ioObservers)) L.ioCheck(o, time, vpRect);
  }
  class ResizeObserverSize {
    #i; #b;
    constructor(token, i, b) { if (token !== INTERNAL) throw L.illegal(); this.#i = i; this.#b = b; }
    get inlineSize() { return this.#i; }
    get blockSize() { return this.#b; }
  }
  class ResizeObserverEntry {
    #d;
    constructor(token, d) { if (token !== INTERNAL) throw L.illegal(); this.#d = d; }
    get target() { return this.#d.target; }
    get contentRect() { return this.#d.contentRect; }
    get borderBoxSize() { return this.#d.borderBoxSize; }
    get contentBoxSize() { return this.#d.contentBoxSize; }
    get devicePixelContentBoxSize() { return this.#d.devicePixelContentBoxSize; }
  }
  function px(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
  class ResizeObserver {
    #cb; #targets = new Map();
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError("Failed to construct 'ResizeObserver': The callback provided as parameter 1 is not a function.");
      this.#cb = callback;
    }
    observe(target, options) {
      if (!isNode(target) || typeOf(target) !== 1) throw new TypeError("Failed to execute 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element'.");
      const box = options && options.box ? `${options.box}` : 'content-box';
      this.#targets.set(target, { box, w: 0, h: 0, first: true });
      roObservers.add(this);
      obsDirty = true;
      requestFrame();
    }
    unobserve(target) { this.#targets.delete(target); if (this.#targets.size === 0) roObservers.delete(this); }
    disconnect() { this.#targets.clear(); roObservers.delete(this); }
    static {
      L.roCheck = (o, dpr) => {
        const entries = [];
        for (const [target, reg] of o.#targets) {
          const id = idOf(target);
          let bw = 0, bh = 0, cw = 0, ch = 0, pl = 0, pt = 0;
          if (N.isConnected(id)) {
            const r = N.getBoundingClientRect(id);
            bw = r[2]; bh = r[3];
            if (bw > 0 || bh > 0) {
              const c = N.clientMetrics(id);
              pl = px(N.computedStyle(id, 'padding-left', ''));
              pt = px(N.computedStyle(id, 'padding-top', ''));
              const pr = px(N.computedStyle(id, 'padding-right', ''));
              const pb = px(N.computedStyle(id, 'padding-bottom', ''));
              cw = Math.max(0, (c[2] || bw) - pl - pr);
              ch = Math.max(0, (c[3] || bh) - pt - pb);
              if (!c[2] && !c[3]) {
                const bl = px(N.computedStyle(id, 'border-left-width', '')), br = px(N.computedStyle(id, 'border-right-width', ''));
                const bt = px(N.computedStyle(id, 'border-top-width', '')), bb = px(N.computedStyle(id, 'border-bottom-width', ''));
                cw = Math.max(0, bw - pl - pr - bl - br);
                ch = Math.max(0, bh - pt - pb - bt - bb);
              }
            }
          }
          const w = reg.box === 'border-box' ? bw : cw;
          const h = reg.box === 'border-box' ? bh : ch;
          if (w !== reg.w || h !== reg.h || (reg.first && (w !== 0 || h !== 0))) {
            reg.first = false;
            reg.w = w; reg.h = h;
            entries.push(new ResizeObserverEntry(INTERNAL, {
              target,
              contentRect: new L.DOMRectReadOnly(pl, pt, cw, ch),
              borderBoxSize: Object.freeze([new ResizeObserverSize(INTERNAL, bw, bh)]),
              contentBoxSize: Object.freeze([new ResizeObserverSize(INTERNAL, cw, ch)]),
              devicePixelContentBoxSize: Object.freeze([new ResizeObserverSize(INTERNAL, Math.round(cw * dpr), Math.round(ch * dpr))]),
            }));
          } else {
            reg.first = false;
          }
        }
        if (entries.length) { try { Reflect.apply(o.#cb, o, [entries, o]); } catch (e) { L.reportException(e); } }
      };
    }
  }
  function runResizeObservers(dirty) {
    if (roObservers.size === 0 || !dirty) return;
    L.flushSheets();
    const dpr = N.viewport()[2] || 1;
    for (const o of Array.from(roObservers)) L.roCheck(o, dpr);
  }

  // =======================================================================================
  // CSS namespace, getComputedStyle
  // =======================================================================================
  function splitTopLevel(s, word) {
    const out = [];
    let depth = 0, start = 0;
    const re = new RegExp('^\\s+' + word + '\\s+', 'i');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && /\s/.test(c)) {
        const m = re.exec(s.slice(i));
        if (m) { out.push(s.slice(start, i)); i += m[0].length - 1; start = i + 1; }
      }
    }
    out.push(s.slice(start));
    return out.map((x) => x.trim());
  }
  function supportsCondition(s) {
    s = s.trim();
    if (s === '') return false;
    if (/^not\s/i.test(s)) return !supportsCondition(s.slice(4));
    const ors = splitTopLevel(s, 'or');
    if (ors.length > 1) return ors.some(supportsCondition);
    const ands = splitTopLevel(s, 'and');
    if (ands.length > 1) return ands.every(supportsCondition);
    let m = /^selector\(([\s\S]*)\)$/i.exec(s);
    if (m) { try { N.querySelector(L.documentId, m[1]); return true; } catch (_) { return false; } }
    if (/^(font-tech|font-format)\(/i.test(s)) return false;
    m = /^\(([\s\S]*)\)$/.exec(s);
    if (m) {
      const inner = m[1].trim();
      const k = inner.indexOf(':');
      if (k > 0 && !/^\(/.test(inner)) {
        const prop = inner.slice(0, k).trim();
        const value = inner.slice(k + 1).trim();
        try { return !!N.cssSupports(prop, value); } catch (_) { return false; }
      }
      return supportsCondition(inner);
    }
    const k = s.indexOf(':');
    if (k > 0) { try { return !!N.cssSupports(s.slice(0, k).trim(), s.slice(k + 1).trim()); } catch (_) { return false; } }
    return false;
  }
  const CSS = {
    supports(a, b) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'supports' on 'CSS': 1 argument required, but only 0 present.");
      if (arguments.length >= 2) { try { return !!N.cssSupports(`${a}`, `${b}`); } catch (_) { return false; } }
      return supportsCondition(`${a}`);
    },
    escape(ident) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'escape' on 'CSS': 1 argument required, but only 0 present.");
      return L.cssEscape(ident);
    },
    registerProperty(definition) {
      if (!definition || typeof definition.name !== 'string' || !definition.name.startsWith('--')) throw new DOMException("Failed to execute 'registerProperty' on 'CSS': The name provided is not a valid custom property name.", 'SyntaxError');
    },
  };
  Object.defineProperty(CSS, Symbol.toStringTag, { value: 'CSS', configurable: true });
  function getComputedStyle(elt, pseudoElt) {
    if (!isNode(elt) || typeOf(elt) !== 1) throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.");
    return L.computedStyle(elt, pseudoElt);
  }

  // =======================================================================================
  // Fonts
  // =======================================================================================
  class FontFace {
    #d;
    constructor(family, source, descriptors) {
      const d = descriptors || {};
      this.#d = {
        family: `${family}`, style: d.style || 'normal', weight: d.weight || 'normal', stretch: d.stretch || 'normal',
        unicodeRange: d.unicodeRange || 'U+0-10FFFF', variant: d.variant || 'normal', featureSettings: d.featureSettings || 'normal',
        variationSettings: d.variationSettings || 'normal', display: d.display || 'auto', ascentOverride: 'normal',
        descentOverride: 'normal', lineGapOverride: 'normal', status: 'unloaded', loaded: null,
      };
      const self = this;
      this.#d.loaded = L.newPromise((resolve) => { self.#d.resolve = resolve; });
      if (typeof source !== 'string') { this.#d.status = 'loaded'; this.#d.resolve(this); }
    }
    static { L.ffData = (f) => f.#d; }
    get status() { return this.#d.status; }
    get loaded() { return this.#d.loaded; }
    load() { const d = this.#d; if (d.status !== 'loaded') { d.status = 'loaded'; d.resolve(this); } return d.loaded; }
  }
  for (const k of ['family', 'style', 'weight', 'stretch', 'unicodeRange', 'variant', 'featureSettings', 'variationSettings', 'display', 'ascentOverride', 'descentOverride', 'lineGapOverride']) {
    Object.defineProperty(FontFace.prototype, k, { get() { return L.ffData(this)[k]; }, set(v) { L.ffData(this)[k] = `${v}`; }, enumerable: true, configurable: true });
  }
  class FontFaceSet extends EventTarget {
    #faces = new Set(); #ready;
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); this.#ready = L.resolvedPromise(this); }
    get ready() { return this.#ready; }
    get status() { return 'loaded'; }
    get size() { return this.#faces.size; }
    check(font, text) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'check' on 'FontFaceSet': 1 argument required, but only 0 present.");
      return true;
    }
    load(font, text) {
      if (arguments.length === 0) return L.rejectedPromise(new TypeError("Failed to execute 'load' on 'FontFaceSet': 1 argument required, but only 0 present."));
      const fam = /(?:\d+(?:px|pt|em|rem|%)\s+)(.+)$/.exec(`${font}`);
      const name = fam ? fam[1].replace(/["']/g, '').trim() : '';
      return L.resolvedPromise(Array.from(this.#faces).filter((f) => f.family.replace(/["']/g, '') === name));
    }
    add(face) { this.#faces.add(face); return this; }
    delete(face) { return this.#faces.delete(face); }
    clear() { this.#faces.clear(); }
    has(face) { return this.#faces.has(face); }
    forEach(cb, thisArg) { for (const f of this.#faces) Reflect.apply(cb, thisArg, [f, f, this]); }
    entries() { return this.#faces.entries(); }
    keys() { return this.#faces.values(); }
    values() { return this.#faces.values(); }
    [Symbol.iterator]() { return this.#faces.values(); }
  }
  L.defineEventHandlers(FontFaceSet.prototype, ['onloading', 'onloadingdone', 'onloadingerror']);
  L.fonts = new FontFaceSet(INTERNAL);

  // =======================================================================================
  // DataTransfer
  // =======================================================================================
  function normalizeFormat(f) {
    const l = `${f}`.toLowerCase();
    if (l === 'text') return 'text/plain';
    if (l === 'url') return 'text/uri-list';
    return l;
  }
  class DataTransferItem {
    #kind; #type; #value;
    constructor(token, kind, type, value) { if (token !== INTERNAL) throw L.illegal(); this.#kind = kind; this.#type = type; this.#value = value; }
    get kind() { return this.#kind; }
    get type() { return this.#type; }
    getAsString(cb) { if (this.#kind === 'string' && typeof cb === 'function') { const v = this.#value; L.postTask(() => cb(v)); } }
    getAsFile() { return this.#kind === 'file' ? this.#value : null; }
    webkitGetAsEntry() { return null; }
  }
  class DataTransferItemList {
    #dt;
    constructor(token, dt) { if (token !== INTERNAL) throw L.illegal(); this.#dt = dt; }
    static { L.dtilOwner = (o) => o.#dt; }
    get length() { return L.dtItems(this.#dt).length; }
    add(data, type) {
      if (data instanceof File) { L.dtAddFile(this.#dt, data); return L.dtItems(this.#dt).slice(-1)[0]; }
      this.#dt.setData(`${type}`, `${data}`);
      return L.dtItems(this.#dt).find((i) => i.type === normalizeFormat(type)) || null;
    }
    remove(index) { L.dtRemove(this.#dt, Number(index) >>> 0); }
    clear() { this.#dt.clearData(); }
  }
  L.makeIndexed(DataTransferItemList.prototype, (o, i) => L.dtItems(L.dtilOwner(o))[i], 8);
  class DataTransfer {
    #data = new Map(); #files = []; #drop = 'none'; #allowed = 'uninitialized'; #items;
    constructor() { this.#items = new DataTransferItemList(INTERNAL, this); }
    static {
      L.dtItems = (dt) => Array.from(dt.#data, ([t, v]) => new DataTransferItem(INTERNAL, 'string', t, v)).concat(dt.#files.map((f) => new DataTransferItem(INTERNAL, 'file', f.type, f)));
      L.dtAddFile = (dt, f) => { dt.#files.push(f); };
      L.dtRemove = (dt, i) => { const keys = Array.from(dt.#data.keys()); if (i < keys.length) dt.#data.delete(keys[i]); else dt.#files.splice(i - keys.length, 1); };
    }
    get dropEffect() { return this.#drop; }
    set dropEffect(v) { const s = `${v}`; if (['none', 'copy', 'link', 'move'].includes(s)) this.#drop = s; }
    get effectAllowed() { return this.#allowed; }
    set effectAllowed(v) { const s = `${v}`; if (['none', 'copy', 'copyLink', 'copyMove', 'link', 'linkMove', 'move', 'all', 'uninitialized'].includes(s)) this.#allowed = s; }
    get items() { return this.#items; }
    get types() { const t = Array.from(this.#data.keys()); if (this.#files.length) t.push('Files'); return Object.freeze(t); }
    get files() { return L.createFileList(this.#files.slice()); }
    getData(format) { const v = this.#data.get(normalizeFormat(format)); return v === undefined ? '' : v; }
    setData(format, data) { this.#data.set(normalizeFormat(format), `${data}`); }
    clearData(format) { if (format === undefined) this.#data.clear(); else this.#data.delete(normalizeFormat(format)); }
    setDragImage() { }
  }

  // =======================================================================================
  // Exports
  // =======================================================================================
  L.windowFunctions = {
    setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask, requestAnimationFrame, cancelAnimationFrame,
    requestIdleCallback, cancelIdleCallback, structuredClone, btoa, atob, fetch, getComputedStyle, matchMedia,
  };
  L.CSS = CSS;
  const exp = {
    Crypto, SubtleCrypto, Performance, PerformanceEntry, PerformanceMark, PerformanceMeasure, PerformanceResourceTiming,
    PerformanceNavigationTiming, PerformanceTiming, PerformanceNavigation, PerformanceObserver, PerformanceObserverEntryList,
    Navigator, MimeType, MimeTypeArray, Plugin, PluginArray, Permissions, PermissionStatus, Clipboard, ClipboardItem,
    NavigatorUAData, NetworkInformation, StorageManager, Geolocation, GeolocationPositionError, LockManager, Lock,
    Screen, ScreenOrientation, VisualViewport, Location, History, DOMStringList, Storage, MediaQueryList,
    IntersectionObserver, IntersectionObserverEntry, ResizeObserver, ResizeObserverEntry, ResizeObserverSize,
    FontFace, FontFaceSet, DataTransfer, DataTransferItem, DataTransferItemList,
  };
  for (const k in exp) L.expose(k, exp[k]);
  Object.assign(L, exp);
})(globalThis.__layer);
