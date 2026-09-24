'use strict';
// harness.js — creates a fresh vm context per test with the mock native installed and the
// JS layer loaded, plus a fake event loop (timers, frames, network, native hooks).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { MockNative } = require('./mock_native');

const JS_DIR = path.join(__dirname, '..');
const LAYER_FILES = ['00_prelude.js', '10_events.js', '20_dom.js', '30_html.js', '40_webapi.js', '90_bootstrap.js'];
const layerSources = LAYER_FILES.map((f) => [f, fs.readFileSync(path.join(JS_DIR, f), 'utf8')]);
const compiled = layerSources.map(([f, src]) => [f, new vm.Script(src, { filename: path.join(JS_DIR, f) })]);

const DEFAULT_HTML = '<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>';

function tick() { return new Promise((r) => setImmediate(r)); }

class Env {
  constructor(mock) {
    this.mock = mock;
    this.ctx = mock.ctx;
    this.window = vm.runInContext('globalThis', this.ctx);
  }
  get hooks() { return this.mock.hooks; }
  get logs() { return this.mock.logs; }
  errors() { return this.mock.logs.filter((l) => l[0] === 'error').map((l) => l[1]); }
  get requests() { return this.mock.requests; }
  run(code, filename) { return vm.runInContext(code, this.ctx, { filename: filename || 'test.js' }); }
  script(file, filename) { return this.run(fs.readFileSync(file, 'utf8'), filename || file); }
  hook(name, ...args) { return this.mock.hooks[name](...args); }
  node(sel) {
    if (typeof sel === 'number') return this.mock.n(sel);
    const CSSselect = require('css-select');
    const r = CSSselect.selectOne(sel, this.mock.n(this.mock.docId), this.mock.selOpts());
    if (!r) throw new Error('mock node not found: ' + sel);
    return r;
  }
  id(sel) { return typeof sel === 'number' ? sel : this.node(sel).id; }
  text(sel) { return this.mock.textOf(this.node(sel)); }
  html(sel) { return this.mock.serializeChildren(this.id(sel)); }
  pathOf(id) {
    const out = [];
    for (let x = id; x; x = this.mock.n(x).parent) out.push(x);
    return out;
  }
  async tick() { await tick(); await tick(); }
  async runEvent(e) {
    const M = this.mock;
    switch (e.kind) {
      case 'timer': M.hooks.onTimer(e.timerId); break;
      case 'fetch': {
        const r = M.responseParts(e.spec, e.url);
        M.hooks.onFetch(e.reqId, r.status, r.statusText, r.finalUrl, M.arr(r.flat), r.body === null ? null : M.ab(r.body), r.error);
        break;
      }
      case 'hook': M.hooks[e.name](...e.args); break;
      case 'task': e.fn(); break;
      default: throw new Error('unknown event ' + e.kind);
    }
  }
  // Run the fake event loop until idle (or until `ms` of fake time elapsed).
  async flush(ms = 60000) {
    const M = this.mock;
    const limit = M.clock + ms;
    await this.tick();
    for (let i = 0; i < 200000; i++) {
      const e = M.nextEvent();
      const frameDue = M.frameRequested ? Math.max(M.clock, M.lastFrame + 16) : Infinity;
      if (!e && frameDue === Infinity) break;
      const due = Math.min(e ? e.due : Infinity, frameDue);
      if (due > limit) break;
      if (due > M.clock) M.clock = due;
      if (e && e.due <= frameDue) {
        M.events.splice(M.events.indexOf(e), 1);
        await this.runEvent(e);
      } else {
        M.frameRequested = false;
        M.lastFrame = M.clock;
        M.hooks.onFrame(M.clock);
      }
      await this.tick();
    }
    return this;
  }
  async advance(ms) {
    const target = this.mock.clock + ms;
    await this.flush(ms);
    if (this.mock.clock < target) this.mock.clock = target;
    return this;
  }
  // Native (trusted) event through hooks.onEvent, like Rust would deliver it.
  event(type, target, init = {}) {
    const id = this.id(target);
    return this.mock.hooks.onEvent(type, id, this.mock.arr(this.pathOf(id)), init);
  }
  click(target, init = {}) {
    return this.event('click', target, Object.assign({ bubbles: true, cancelable: true, composed: true, clientX: 5, clientY: 5, screenX: 5, screenY: 5, pageX: 5, pageY: 5, button: 0, buttons: 0, detail: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }, init));
  }
}

// Rust snapshots the V8 context right after the layer has run (see NATIVE_API.md, "Startup
// snapshot"). While loading, the layer may only call these natives, must not read the clock or
// Math.random, and must not keep globalThis as a key of a Map/Set/WeakMap/WeakSet.
const SNAPSHOT_SAFE_NATIVES = new Set(['documentId', 'setHooks', 'log', 'urlParse', 'urlSet', 'textEncode',
  'textDecode', 'structuredClone', 'cssSupports', 'compileFunction']);
let gcFn = null;
function getGC() {
  if (gcFn === null) {
    require('v8').setFlagsFromString('--expose_gc');
    gcFn = vm.runInNewContext('gc');
  }
  return gcFn;
}
function instrumentLoad(g, nat) {
  const violations = [];
  const globalKeyed = [];
  let loading = true;
  const origNat = {};
  for (const k of Object.keys(nat)) {
    const f = nat[k];
    if (typeof f !== 'function') continue;
    origNat[k] = f;
    nat[k] = function (...a) {
      if (loading && !SNAPSHOT_SAFE_NATIVES.has(k)) violations.push('native N.' + k + '()');
      return f.apply(this, a);
    };
  }
  const D = g.Date, Mth = g.Math;
  const origNow = D.now, origRandom = Mth.random;
  D.now = function now() { if (loading) violations.push('Date.now()'); return origNow.call(D); };
  Mth.random = function random() { if (loading) violations.push('Math.random()'); return origRandom.call(Mth); };
  const protos = [[g.Map.prototype, 'set'], [g.WeakMap.prototype, 'set'], [g.Set.prototype, 'add'], [g.WeakSet.prototype, 'add']];
  const origs = protos.map(([p, k]) => p[k]);
  protos.forEach(([p, k], i) => {
    const f = origs[i];
    p[k] = { [k](key, v) { if (loading && key === g) globalKeyed.push([new WeakRef(this), new Error().stack.split('\n')[2]]); return f.call(this, key, v); } }[k];
  });
  return async () => {
    loading = false;
    for (const k of Object.keys(origNat)) nat[k] = origNat[k];
    D.now = origNow; Mth.random = origRandom;
    protos.forEach(([p, k], i) => { p[k] = origs[i]; });
    await tick();
    getGC()();
    for (const [ref, where] of globalKeyed) if (ref.deref() !== undefined) violations.push('globalThis kept as a Map/Set key (' + (where || '').trim() + ')');
    return violations;
  };
}

// MOCK_OPTS='{"nativeFocusEvents":true}' runs every test with extra mock options.
const EXTRA_OPTS = process.env.MOCK_OPTS ? JSON.parse(process.env.MOCK_OPTS) : null;

async function createEnv(opts = {}) {
  if (EXTRA_OPTS !== null) opts = Object.assign({}, EXTRA_OPTS, opts);
  const mock = new MockNative(opts);
  const g = vm.runInContext('globalThis', mock.ctx);
  const nat = mock.build();
  const finishLoad = opts.checkSnapshot ? instrumentLoad(g, nat) : null;
  Object.defineProperty(g, '__native', { value: nat, writable: true, enumerable: false, configurable: true });
  if (opts.beforeLayer) opts.beforeLayer(mock);
  for (const [, script] of compiled) script.runInContext(mock.ctx);
  if (finishLoad) mock.loadViolations = await finishLoad();
  const env = new Env(mock);
  mock.loadDocument(opts.html === undefined ? DEFAULT_HTML : opts.html);
  if (opts.parse !== false) {
    mock.hooks.onDocumentParsed();
    if (opts.flush !== false) await env.flush(opts.flushMs === undefined ? 60000 : opts.flushMs);
  }
  return env;
}

module.exports = { createEnv, Env, LAYER_FILES, JS_DIR, tick };
