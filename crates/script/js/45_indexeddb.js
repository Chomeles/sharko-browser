// 45_indexeddb.js — IndexedDB (W3C IndexedDB 3.0): IDBFactory, IDBDatabase, IDBObjectStore, IDBIndex,
// IDBTransaction, IDBRequest/IDBOpenDBRequest, IDBCursor/IDBCursorWithValue, IDBKeyRange, IDBRecord,
// IDBVersionChangeEvent.
//
// The databases live in memory, per storage key (the origin), behind the small `backend` object
// below: it hands out the databases of a storage key and is told when a transaction that changed
// one has committed or a database was deleted, so a persistent store can be plugged in without
// touching the algorithms. Everything else (connections, transactions, requests, cursors) is
// transient state of the page.
//
// The algorithms follow the spec text: the connection queue (open/delete one at a time), the
// versionchange/blocked dance, upgrade transactions, transaction scheduling by scope and mode,
// request queues, event order and bubbling (request -> transaction -> connection), key
// conversion/comparison, key paths and generators, index maintenance and cursor iteration.
// Deviations that matter:
//  * The layer has no microtask checkpoint between listeners, and promise wrappers (idb, idb-keyval) issue their next
//    request from a microtask. So a transaction is not deactivated right after an event dispatch but by the timer that
//    was registered before it (see `step`): after the microtasks, before the timers the handlers set.
//  * Requests run one per timer turn (two when a handler set a timer, see `schedule`); a commit takes two more.
//  * Same-origin frames each have their own layer, hence their own in-memory databases.
(function (L) {
  'use strict';
  const DOMException = L.DOMException;
  const EventTarget = L.EventTarget;
  const Event = L.Event;
  const INTERNAL = L.INTERNAL;
  const EV = L.EV;
  const cloneValue = (v) => L.cloneValue(v);

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const later = (fn) => { L.internalTimeout(fn, 0); };
  const illegalInvocation = () => new TypeError('Illegal invocation');
  const domErr = (name, message) => new DOMException(message, name);
  const failedTo = (method, iface) => `Failed to execute '${method}' on '${iface}'`;
  function argsRequired(method, iface, n, got) {
    if (got < n) throw new TypeError(`${failedTo(method, iface)}: ${n} argument${n === 1 ? '' : 's'} required, but only ${got} present.`);
  }
  // [EnforceRange] conversion to an unsigned integer up to `max`.
  function enforceRange(v, max, where, what) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new TypeError(`${where}: Value is not of type '${what}'.`);
    const t = Math.trunc(n);
    if (t < 0 || t > max) throw new TypeError(`${where}: Value is outside the '${what}' value range.`);
    return t === 0 ? 0 : t;
  }
  const MAX_ULONG = 4294967295;
  const MAX_SAFE = Number.MAX_SAFE_INTEGER;
  const toLength = (v) => { const n = Math.trunc(Number(v)); return n > 0 ? Math.min(n, MAX_SAFE) : 0; };

  // ---------------------------------------------------------------------------------------
  // Storage backend
  // ---------------------------------------------------------------------------------------
  // Data model (plain objects, so a persistent backend can serialise them):
  //   DbData:    { version, stores: Map<name, StoreData> }
  //   StoreData: { name, keyPath (null | string | string[]), autoIncrement, nextKey, rows, indexes: Map<name, IndexData>,
  //                maintained: Set<IndexData>, deleted, createdBy }
  //   Row:       { key, pk (== key), value }                 store rows, sorted by key; value is a structured clone
  //   IndexData: { name, keyPath, unique, multiEntry, rows, store, populated, deleted, createdBy }
  //   IndexRow:  { key, pk, rec }                            sorted by (key, pk); rec is the referenced store Row
  // Index rows are derived data: a persistent backend only needs to store the index definitions and
  // rebuild the rows from the store rows.
  // Keys are { t: type, v: value }, see below.
  const memory = new Map(); // storage key -> Map<name, DbData>
  const backend = {
    // The databases of a storage key, as a live Map the engine mutates.
    databases(key) {
      let m = memory.get(key);
      if (m === undefined) { m = new Map(); memory.set(key, m); }
      return m;
    },
    // A transaction that changed database `name` has committed (the data is already in the Map). May throw
    // to make the transaction abort (e.g. QuotaExceededError).
    commit(key, name, data) { },
    // Database `name` has been deleted from the Map.
    drop(key, name) { },
  };
  L.idbBackend = backend;
  function storageKey() { return L.location ? L.location.origin : 'null'; }

  // ---------------------------------------------------------------------------------------
  // Keys (https://w3c.github.io/IndexedDB/#key-construct)
  // ---------------------------------------------------------------------------------------
  // Types in ascending order: number < date < string < binary < array.
  const K_NUMBER = 1, K_DATE = 2, K_STRING = 3, K_BINARY = 4, K_ARRAY = 5;
  const dateValueOf = Date.prototype.valueOf;
  const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
  // Brand checks that also work across realms (frames, workers).
  function dateMs(v) { try { return Reflect.apply(dateValueOf, v, []); } catch (_) { return undefined; } }
  function bufferBytes(v) {
    try {
      if (ArrayBuffer.isView(v)) {
        if (v.buffer.detached === true) return null;
        return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      }
      Reflect.apply(bufferByteLength, v, []);
      if (v.detached === true) return null;
      return new Uint8Array(v).slice();
    } catch (_) {
      return null;
    }
  }
  // Convert a value to a key: a key, or null for "invalid value"/"invalid type". A getter of an
  // array may throw, which propagates. `seen` holds the arrays on the current path.
  function toKey(input, seen) {
    if (typeof input === 'number') return input !== input ? null : { t: K_NUMBER, v: input };
    if (typeof input === 'string') return { t: K_STRING, v: input };
    if (typeof input !== 'object' || input === null) return null;
    const ms = dateMs(input);
    if (ms !== undefined) return ms !== ms ? null : { t: K_DATE, v: ms };
    const bytes = bufferBytes(input);
    if (bytes !== null) return { t: K_BINARY, v: bytes };
    if (!Array.isArray(input)) return null;
    if (seen === undefined) seen = [];
    if (seen.includes(input)) return null;
    seen.push(input);
    const len = toLength(input.length);
    const keys = [];
    let ok = true;
    for (let i = 0; i < len; i++) {
      if (!hasOwn(input, i)) { ok = false; break; }
      const k = toKey(input[i], seen);
      if (k === null) { ok = false; break; }
      keys.push(k);
    }
    seen.pop();
    return ok ? { t: K_ARRAY, v: keys } : null;
  }
  function toKeyOrThrow(v) {
    const k = toKey(v);
    if (k === null) throw domErr('DataError', 'The parameter is not a valid key.');
    return k;
  }
  // Like toKey, but the members of a top-level array that are not keys are dropped, and so are
  // duplicates (multiEntry indexes).
  function toMultiEntryKey(input) {
    if (!Array.isArray(input)) return toKey(input);
    const seen = [input];
    const keys = [];
    const len = toLength(input.length);
    for (let i = 0; i < len; i++) {
      let k = null;
      try { k = toKey(input[i], seen); } catch (_) { k = null; }
      if (k !== null && !keys.some((x) => cmpKeys(x, k) === 0)) keys.push(k);
    }
    return { t: K_ARRAY, v: keys };
  }
  function cmpKeys(a, b) {
    if (a.t !== b.t) return a.t > b.t ? 1 : -1;
    if (a.t === K_ARRAY || a.t === K_BINARY) {
      const x = a.v, y = b.v;
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) {
        const c = a.t === K_ARRAY ? cmpKeys(x[i], y[i]) : (x[i] === y[i] ? 0 : (x[i] > y[i] ? 1 : -1));
        if (c !== 0) return c;
      }
      return x.length === y.length ? 0 : (x.length > y.length ? 1 : -1);
    }
    return a.v === b.v ? 0 : (a.v > b.v ? 1 : -1); // strings compare by UTF-16 code unit, like the spec
  }
  function keyToValue(k) {
    switch (k.t) {
      case K_DATE: return new Date(k.v);
      case K_BINARY: return k.v.slice().buffer;
      case K_ARRAY: return k.v.map(keyToValue);
      default: return k.v;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Key paths (https://w3c.github.io/IndexedDB/#key-path-construct)
  // ---------------------------------------------------------------------------------------
  const IDENTIFIER_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;
  function isValidKeyPath(kp) {
    if (Array.isArray(kp)) return kp.length > 0 && kp.every(isValidKeyPath);
    return kp === '' || kp.split('.').every((id) => IDENTIFIER_RE.test(id));
  }
  // The IDL union (DOMString or sequence<DOMString>): null stays null.
  function toKeyPath(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && typeof v[Symbol.iterator] === 'function') return Array.from(v, (x) => `${x}`);
    return `${v}`;
  }
  const FAILURE = Symbol('failure');
  const isBlob = (v) => v instanceof L.Blob;
  const isFile = (v) => v instanceof L.File;
  // "Evaluate a key path on a value": the value, or FAILURE.
  function evaluateKeyPath(value, kp) {
    if (Array.isArray(kp)) {
      const out = [];
      for (const item of kp) {
        const r = evaluateKeyPath(value, item);
        if (r === FAILURE) return FAILURE;
        out.push(r);
      }
      return out;
    }
    if (kp === '') return value;
    for (const id of kp.split('.')) {
      if (typeof value === 'string' && id === 'length') value = value.length;
      else if (Array.isArray(value) && id === 'length') value = toLength(value.length);
      else if (isBlob(value) && id === 'size') value = value.size;
      else if (isBlob(value) && id === 'type') value = value.type;
      else if (isFile(value) && id === 'name') value = value.name;
      else if (isFile(value) && id === 'lastModified') value = value.lastModified;
      else {
        if (!L.isObj(value) || !hasOwn(value, id)) return FAILURE;
        value = value[id];
        if (value === undefined) return FAILURE;
      }
    }
    return value;
  }
  // "Extract a key from a value using a key path": a key, null (invalid) or FAILURE.
  function extractKey(value, kp, multiEntry) {
    const r = evaluateKeyPath(value, kp);
    if (r === FAILURE) return FAILURE;
    return multiEntry ? toMultiEntryKey(r) : toKey(r);
  }
  // Whether a key could be injected: every existing link of the path is an object.
  function canInjectKey(value, kp) {
    const ids = kp.split('.');
    ids.pop();
    for (const id of ids) {
      if (!L.isObj(value)) return false;
      if (!hasOwn(value, id)) return true;
      value = value[id];
    }
    return L.isObj(value);
  }
  function injectKey(value, kp, key) {
    const ids = kp.split('.');
    const last = ids.pop();
    const define = (o, k, v) => Reflect.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
    for (const id of ids) {
      if (!hasOwn(value, id)) define(value, id, {});
      value = value[id];
    }
    define(value, last, keyToValue(key));
  }

  // ---------------------------------------------------------------------------------------
  // Key ranges
  // ---------------------------------------------------------------------------------------
  // A range is { lo, hi, loOpen, hiOpen } with null for an unbounded side; `null` stands for "all keys".
  function inRange(r, key) {
    if (r.lo !== null) {
      const c = cmpKeys(key, r.lo);
      if (c < 0 || (c === 0 && r.loOpen)) return false;
    }
    if (r.hi !== null) {
      const c = cmpKeys(key, r.hi);
      if (c > 0 || (c === 0 && r.hiOpen)) return false;
    }
    return true;
  }
  let rangeOf;
  class IDBKeyRange {
    #r;
    constructor(token, r) {
      if (token !== INTERNAL) throw L.illegal();
      this.#r = r;
    }
    static {
      rangeOf = (o) => (typeof o === 'object' && o !== null && #r in o ? o.#r : undefined);
    }
    get lower() { const r = this.#r; return r.lo === null ? undefined : keyToValue(r.lo); }
    get upper() { const r = this.#r; return r.hi === null ? undefined : keyToValue(r.hi); }
    get lowerOpen() { return this.#r.loOpen; }
    get upperOpen() { return this.#r.hiOpen; }
    includes(key) {
      argsRequired('includes', 'IDBKeyRange', 1, arguments.length);
      return inRange(this.#r, toKeyOrThrow(key));
    }
    static only(value) {
      argsRequired('only', 'IDBKeyRange', 1, arguments.length);
      const k = toKeyOrThrow(value);
      return new IDBKeyRange(INTERNAL, { lo: k, hi: k, loOpen: false, hiOpen: false });
    }
    static lowerBound(lower, open = false) {
      argsRequired('lowerBound', 'IDBKeyRange', 1, arguments.length);
      return new IDBKeyRange(INTERNAL, { lo: toKeyOrThrow(lower), hi: null, loOpen: !!open, hiOpen: true });
    }
    static upperBound(upper, open = false) {
      argsRequired('upperBound', 'IDBKeyRange', 1, arguments.length);
      return new IDBKeyRange(INTERNAL, { lo: null, hi: toKeyOrThrow(upper), loOpen: true, hiOpen: !!open });
    }
    static bound(lower, upper, lowerOpen = false, upperOpen = false) {
      argsRequired('bound', 'IDBKeyRange', 2, arguments.length);
      const lo = toKeyOrThrow(lower), hi = toKeyOrThrow(upper);
      const c = cmpKeys(lo, hi);
      if (c > 0) throw domErr('DataError', 'The lower key is greater than the upper key.');
      if (c === 0 && (lowerOpen || upperOpen)) throw domErr('DataError', 'The lower key and upper key are equal and one of the bounds is open.');
      return new IDBKeyRange(INTERNAL, { lo, hi, loOpen: !!lowerOpen, hiOpen: !!upperOpen });
    }
  }
  // "Convert a value to a key range": a range record, or null for all keys.
  function toRange(query, nullDisallowed) {
    const r = rangeOf(query);
    if (r !== undefined) return r;
    if (query === undefined || query === null) {
      if (nullDisallowed) throw domErr('DataError', 'The parameter is not a valid key or key range.');
      return null;
    }
    const k = toKeyOrThrow(query);
    return { lo: k, hi: k, loOpen: false, hiOpen: false };
  }

  // ---------------------------------------------------------------------------------------
  // Sorted rows. Store rows are ordered by key, index rows by (key, pk); a probe is a key and an
  // optional pk, and compares equal to every row with that key when the pk is left out.
  // ---------------------------------------------------------------------------------------
  function cmpRow(row, key, pk) {
    const c = cmpKeys(row.key, key);
    return c !== 0 || pk === undefined ? c : cmpKeys(row.pk, pk);
  }
  // First index whose row is >= the probe / > the probe.
  function lowerIdx(rows, key, pk) {
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmpRow(rows[mid], key, pk) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function upperIdx(rows, key, pk) {
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmpRow(rows[mid], key, pk) <= 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  // [start, end) of the rows whose key is in the range.
  function spanOf(rows, range) {
    if (range === null) return [0, rows.length];
    const s = range.lo === null ? 0 : (range.loOpen ? upperIdx(rows, range.lo) : lowerIdx(rows, range.lo));
    const e = range.hi === null ? rows.length : (range.hiOpen ? lowerIdx(rows, range.hi) : upperIdx(rows, range.hi));
    return [s, Math.max(s, e)];
  }
  const valueOfRow = (row) => (row.rec === undefined ? row.value : row.rec.value);
  // The rows in the range in cursor order, at most `limit` of them (0: all). The "unique"
  // directions keep the first row of every key in their own direction.
  function collect(rows, range, dir, limit) {
    const [s, e] = spanOf(rows, range);
    const max = limit === 0 ? Infinity : limit;
    const out = [];
    if (dir === 'next') {
      for (let i = s; i < e && out.length < max; i++) out.push(rows[i]);
    } else if (dir === 'nextunique') {
      for (let i = s; i < e && out.length < max; i++) {
        if (i === s || cmpKeys(rows[i - 1].key, rows[i].key) !== 0) out.push(rows[i]);
      }
    } else if (dir === 'prev') {
      for (let i = e - 1; i >= s && out.length < max; i--) out.push(rows[i]);
    } else {
      let i = e - 1;
      while (i >= s && out.length < max) {
        let j = i;
        while (j > s && cmpKeys(rows[j - 1].key, rows[i].key) === 0) j--;
        out.push(rows[j]);
        i = j - 1;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // Data operations. Every change pushes its inverse onto the transaction's undo log, so that
  // aborting the transaction (or failing one request) can revert it.
  // ---------------------------------------------------------------------------------------
  function rollback(tx, mark) {
    const u = tx.undo;
    while (u.length > mark) u.pop()();
  }
  function rowsInsert(tx, rows, row) {
    rows.splice(upperIdx(rows, row.key, row.pk), 0, row);
    tx.undo.push(() => rows.splice(lowerIdx(rows, row.key, row.pk), 1));
  }
  function rowsRemove(tx, rows, row) {
    const i = lowerIdx(rows, row.key, row.pk);
    if (rows[i] !== row) return;
    rows.splice(i, 1);
    tx.undo.push(() => rows.splice(lowerIdx(rows, row.key, row.pk), 0, row));
  }
  // Put `items` back at `at` without spreading them into a call (which overflows the stack for big arrays).
  function spliceIn(rows, at, items) {
    const tail = rows.splice(at, rows.length - at);
    for (const r of items) rows.push(r);
    for (const r of tail) rows.push(r);
  }
  // The index keys a value yields: none when the key path fails, is invalid or throws.
  function indexKeysOf(idx, value) {
    let k;
    try { k = extractKey(value, idx.keyPath, idx.multiEntry); } catch (_) { return []; }
    if (k === FAILURE || k === null) return [];
    return idx.multiEntry && k.t === K_ARRAY ? k.v : [k];
  }
  function indexAdd(tx, idx, row) {
    if (!idx.populated) return; // the index is filled by its creation request, in order
    const keys = indexKeysOf(idx, row.value);
    if (idx.unique) {
      for (const k of keys) {
        const i = lowerIdx(idx.rows, k);
        if (i < idx.rows.length && cmpKeys(idx.rows[i].key, k) === 0) {
          throw domErr('ConstraintError', `Unable to add key to index '${idx.name}': at least one key does not satisfy the uniqueness requirements.`);
        }
      }
    }
    for (const k of keys) rowsInsert(tx, idx.rows, { key: k, pk: row.key, rec: row });
  }
  function indexRemove(tx, idx, row) {
    if (!idx.populated) return;
    for (const k of indexKeysOf(idx, row.value)) {
      const i = lowerIdx(idx.rows, k, row.key);
      if (idx.rows[i] !== undefined && idx.rows[i].rec === row) rowsRemove(tx, idx.rows, idx.rows[i]);
    }
  }
  function storeRowRemove(tx, store, row) {
    rowsRemove(tx, store.rows, row);
    for (const idx of store.maintained) indexRemove(tx, idx, row);
  }
  // "Delete records from an object store" (range null: clear).
  function storeDelete(tx, store, range) {
    const [s, e] = spanOf(store.rows, range);
    if (e === s) return;
    tx.dirty = true;
    if (e - s <= 8) {
      for (const row of store.rows.slice(s, e)) storeRowRemove(tx, store, row);
      return;
    }
    const removed = store.rows.splice(s, e - s);
    tx.undo.push(() => spliceIn(store.rows, s, removed));
    const gone = new Set(removed);
    for (const idx of store.maintained) {
      const old = idx.rows;
      const kept = old.filter((r) => !gone.has(r.rec));
      if (kept.length === old.length) continue;
      idx.rows = kept;
      tx.undo.push(() => { idx.rows = old; });
    }
  }
  // The generator's current number is exact up to 2^53; above that it is Infinity, which cannot generate keys.
  const MAX_GENERATED = 9007199254740992;
  const nextNumber = (n) => (n >= MAX_GENERATED ? Infinity : n + 1);
  function generateKey(tx, store) {
    const cur = store.nextKey;
    if (cur > MAX_GENERATED) throw domErr('ConstraintError', 'The key generator has reached its maximum value.');
    store.nextKey = nextNumber(cur);
    tx.undo.push(() => { store.nextKey = cur; });
    return { t: K_NUMBER, v: cur };
  }
  function updateKeyGenerator(tx, store, key) {
    if (key.t !== K_NUMBER) return;
    const v = Math.floor(Math.min(key.v, MAX_GENERATED));
    if (v < store.nextKey) return;
    const old = store.nextKey;
    store.nextKey = nextNumber(v);
    tx.undo.push(() => { store.nextKey = old; });
  }
  // "Store a record into an object store"; returns the key. `value` is already a clone.
  function storeRecord(tx, store, value, key, noOverwrite) {
    if (store.autoIncrement) {
      if (key === undefined) {
        key = generateKey(tx, store);
        if (store.keyPath !== null) injectKey(value, store.keyPath, key);
      } else {
        updateKeyGenerator(tx, store, key);
      }
    }
    const i = lowerIdx(store.rows, key);
    const existing = i < store.rows.length && cmpKeys(store.rows[i].key, key) === 0 ? store.rows[i] : null;
    if (existing !== null) {
      if (noOverwrite) throw domErr('ConstraintError', 'Key already exists in the object store.');
      storeRowRemove(tx, store, existing);
    }
    const row = { key, pk: key, value };
    rowsInsert(tx, store.rows, row);
    for (const idx of store.maintained) indexAdd(tx, idx, row);
    tx.dirty = true;
    return key;
  }
  // Fills a new index from the records of its store (the index creation request).
  function indexPopulate(tx, idx) {
    idx.populated = true;
    tx.undo.push(() => { idx.populated = false; });
    for (const row of idx.store.rows) indexAdd(tx, idx, row);
  }
  const readValue = (row) => cloneValue(valueOfRow(row));

  // ---------------------------------------------------------------------------------------
  // Connections, transactions and their scheduling
  // ---------------------------------------------------------------------------------------
  // The transient side of a database: its connections, the live transactions (in creation order),
  // and the connection queue (open and delete requests are processed one at a time).
  const liveDbs = new Map();
  function liveDb(origin, name) {
    const k = `${origin}\u0000${name}`;
    let d = liveDbs.get(k);
    if (d === undefined) {
      d = { origin, name, conns: new Set(), txs: [], upgradeTx: null, queue: [], busy: false, waiters: [] };
      liveDbs.set(k, d);
    }
    return d;
  }
  const dataOf = (db) => backend.databases(db.origin).get(db.name);

  function enqueueConn(db, run) {
    db.queue.push(run);
    pumpQueue(db);
  }
  function pumpQueue(db) {
    if (db.busy || db.queue.length === 0) return;
    db.busy = true;
    const run = db.queue.shift();
    later(() => run(() => { db.busy = false; pumpQueue(db); }));
  }
  // Runs `cb` in a task once all of `conns` are closed.
  function waitClosed(db, conns, cb) {
    if (conns.every((c) => c.closed)) { later(cb); return; }
    db.waiters.push({ conns, cb });
  }
  function checkWaiters(db) {
    const ready = db.waiters.filter((w) => w.conns.every((c) => c.closed));
    if (ready.length === 0) return;
    db.waiters = db.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) later(w.cb);
  }
  // "Close a database connection" (not forced): closed once its transactions are finished.
  function closeConn(conn) {
    conn.closePending = true;
    maybeClosed(conn);
  }
  function maybeClosed(conn) {
    if (!conn.closePending || conn.closed || conn.txs.size > 0) return;
    conn.closed = true;
    const data = dataOf(conn.db); // what a closed connection reports no longer follows the database
    conn.names = data === undefined ? [] : [...data.stores.keys()].sort();
    conn.db.conns.delete(conn);
    checkWaiters(conn.db);
  }

  function overlaps(a, b) {
    if (a.scope === null || b.scope === null) return true; // an upgrade transaction covers the whole database
    for (const s of a.scope) if (b.scope.has(s)) return true;
    return false;
  }
  // The scheduling rules: a transaction waits for the earlier, unfinished ones with an overlapping
  // scope, unless both only read.
  function canStart(tx) {
    for (const t of tx.db.txs) {
      if (t === tx) return true;
      if (overlaps(t, tx) && (tx.mode !== 'readonly' || t.mode !== 'readonly')) return false;
    }
    return true;
  }
  function pumpDb(db) {
    for (const t of db.txs) if (t.state !== 'finished') schedule(t);
  }
  // scope: a Set of StoreData, or null for an upgrade transaction.
  function createTx(conn, mode, scope, durability) {
    const tx = {
      conn, db: conn.db, mode, scope, durability, state: 'active', queue: [], undo: [], error: null, aborted: false,
      handles: new Map(), scheduled: false, seq: 0, hold: false, pendingAbort: null, dirty: false, onFinish: [], openReq: null, oldVersion: 0,
      iface: null,
    };
    tx.iface = new IDBTransaction(INTERNAL, tx);
    conn.db.txs.push(tx);
    conn.txs.add(tx);
    return tx;
  }
  // One timer drives a transaction. A turn that finds it active (a request event was just dispatched, or it was
  // just created) deactivates it. If code has set timers since the turn was scheduled, they are due after this one and
  // must find the transaction inactive, so the work of the next request waits for another turn; otherwise it goes on.
  function schedule(tx) {
    if (tx.scheduled) return;
    tx.scheduled = true;
    later(() => { tx.scheduled = false; step(tx); });
    tx.seq = L.timerSeq();
  }
  function step(tx) {
    if (tx.state === 'finished' || tx.hold) return;
    if (tx.state === 'active') {
      tx.state = 'inactive';
      if (tx.pendingAbort === null && L.timerSeq() !== tx.seq) { schedule(tx); return; }
    }
    if (tx.pendingAbort !== null) {
      const e = tx.pendingAbort;
      tx.pendingAbort = null;
      abortTx(tx, e);
      return;
    }
    if (!canStart(tx)) return; // pumped again when an earlier transaction finishes
    const item = tx.queue.shift();
    if (item === undefined) {
      if (tx.state === 'committing') { commitTx(tx); return; }
      // Nothing left to do: commit, one turn later so that timers set by handlers still see a committing transaction.
      tx.state = 'committing';
      schedule(tx);
      return;
    }
    // Registered before the events below, so that it runs after the microtasks they leave behind (promise
    // continuations may still place requests) and before the timers their handlers set.
    schedule(tx);
    runItem(tx, item);
  }
  function asDomError(e) {
    if (e instanceof DOMException) return e;
    L.report(e);
    return domErr('UnknownError', e && e.message ? `${e.message}` : 'Unknown error');
  }
  const dispatchAt = (path, ev) => { EV.setTrusted(ev, true); return L.dispatchCore(path[0], ev, path); };
  const reqPath = (r) => (r.tx === null ? [r.iface] : [r.iface, r.tx.iface, r.tx.conn.iface]);
  const txPath = (t) => [t.iface, t.conn.iface];
  const THREW = 8, CANCELED = 1;

  // "Asynchronously execute a request" (the queue side): the operation runs later, in order.
  function execute(source, tx, run, req) {
    if (req === undefined) req = newRequest(source, tx);
    req.tx = tx;
    tx.queue.push({ req, run });
    schedule(tx);
    return req;
  }
  function runItem(tx, item) {
    const req = item.req;
    const mark = tx.undo.length;
    let result, error = null;
    try { result = item.run(); } catch (e) { error = asDomError(e); }
    if (error !== null) {
      rollback(tx, mark);
      if (req === null || tx.state === 'committing') {
        // No request to report to (index creation), or a commit() is under way: the transaction fails.
        if (req !== null) tx.queue.unshift(item);
        abortTx(tx, error);
        return;
      }
    }
    if (req === null) return;
    req.done = true;
    req.result = error === null ? result : undefined;
    req.error = error;
    if (tx.state === 'inactive') tx.state = 'active';
    const flags = dispatchAt(reqPath(req), error === null ? new Event('success') : new Event('error', { bubbles: true, cancelable: true }));
    // Left active until the next turn (see step); only the decisions are taken here.
    if (tx.state !== 'active') return;
    if (flags & THREW) tx.pendingAbort = domErr('AbortError', 'An exception was thrown in an event handler.');
    else if (error !== null && !(flags & CANCELED)) tx.pendingAbort = error;
  }
  function commitTx(tx) {
    if (tx.dirty) {
      try { backend.commit(tx.db.origin, tx.db.name, dataOf(tx.db)); } catch (e) { abortTx(tx, asDomError(e)); return; }
    }
    tx.undo.length = 0;
    if (tx.mode === 'versionchange') { tx.db.upgradeTx = null; freezeScope(tx); }
    tx.state = 'finished';
    dispatchAt(txPath(tx), new Event('complete'));
    if (tx.openReq !== null) tx.openReq.tx = null;
    finalizeTx(tx);
  }
  function finalizeTx(tx) {
    const db = tx.db;
    const i = db.txs.indexOf(tx);
    if (i >= 0) db.txs.splice(i, 1);
    tx.conn.txs.delete(tx);
    for (const cb of tx.onFinish.splice(0)) cb();
    pumpDb(db);
    maybeClosed(tx.conn);
  }
  // "Abort a transaction": `error` is null for an explicit abort().
  function abortTx(tx, error) {
    if (tx.state === 'finished') return;
    tx.aborted = true;
    rollback(tx, 0);
    if (tx.mode === 'versionchange') { abortUpgrade(tx); freezeScope(tx); }
    tx.state = 'finished';
    tx.error = error;
    const pending = tx.queue;
    tx.queue = [];
    for (const item of pending) {
      const req = item.req;
      if (req === null) continue;
      later(() => {
        req.done = true;
        req.result = undefined;
        req.error = domErr('AbortError', 'The transaction was aborted, so the request cannot be fulfilled.');
        dispatchAt(reqPath(req), new Event('error', { bubbles: true, cancelable: true }));
      });
    }
    later(() => {
      if (tx.mode === 'versionchange') tx.db.upgradeTx = null;
      dispatchAt(txPath(tx), new Event('abort', { bubbles: true }));
      const r = tx.openReq;
      if (r !== null) {
        r.tx = null;
        r.result = undefined;
        r.error = domErr('AbortError', 'The upgrade transaction was aborted.');
        r.done = false;
      }
      finalizeTx(tx);
    });
  }
  // Once an upgrade transaction is over its scope (objectStoreNames) no longer follows the database.
  function freezeScope(tx) {
    const data = dataOf(tx.db);
    tx.scope = new Set(data === undefined ? [] : data.stores.values());
  }
  // "Abort an upgrade transaction": the undo log has restored the stores and the version.
  function abortUpgrade(tx) {
    const db = tx.db;
    const data = dataOf(db);
    tx.conn.version = data === undefined ? 0 : data.version;
    if (data !== undefined && data.version === 0) backend.databases(db.origin).delete(db.name); // it was new
  }

  function newRequest(source, tx) {
    const r = { iface: null, source, tx, done: false, result: undefined, error: null };
    r.iface = new IDBRequest(INTERNAL, r);
    return r;
  }
  function newOpenRequest() {
    const r = { iface: null, source: null, tx: null, done: false, result: undefined, error: null };
    r.iface = new IDBOpenDBRequest(INTERNAL, r);
    return r;
  }
  function versionEvent(type, req, oldVersion, newVersion) {
    return dispatchAt(reqPath(req), new IDBVersionChangeEvent(type, { oldVersion, newVersion }));
  }

  // ---------------------------------------------------------------------------------------
  // Opening and deleting databases (https://w3c.github.io/IndexedDB/#opening)
  // ---------------------------------------------------------------------------------------
  // Fires versionchange at the connections that are not closing, then calls `after`.
  function fireVersionChange(conns, oldVersion, newVersion, after) {
    const list = conns.filter((c) => !c.closePending);
    if (list.length === 0) { later(after); return; }
    let left = list.length;
    for (const c of list) {
      later(() => {
        // Registered before the event: `after` runs once the microtasks of the handlers are done (one may close the
        // connection from a promise continuation), but before the timers they set.
        if (--left === 0) later(after);
        if (!c.closePending) dispatchAt([c.iface], new IDBVersionChangeEvent('versionchange', { oldVersion, newVersion }));
      });
    }
  }
  function finishOpen(req, done, error, conn) {
    later(() => {
      req.done = true;
      if (error !== null) {
        req.result = undefined;
        req.error = error;
        dispatchAt(reqPath(req), new Event('error', { bubbles: true, cancelable: true }));
      } else {
        req.result = conn.iface;
        req.error = null;
        dispatchAt(reqPath(req), new Event('success'));
      }
    });
    done();
  }
  function runOpen(db, version, req, done) {
    const dbs = backend.databases(db.origin);
    let data = dbs.get(db.name);
    if (version === undefined) version = data === undefined ? 1 : data.version;
    if (data === undefined) {
      data = { version: 0, stores: new Map() };
      dbs.set(db.name, data);
    }
    if (data.version > version) {
      finishOpen(req, done, domErr('VersionError', `The requested version (${version}) is less than the existing version (${data.version}).`));
      return;
    }
    const conn = { db, version, closePending: false, closed: false, names: null, txs: new Set(), iface: null };
    conn.iface = new IDBDatabase(INTERNAL, conn);
    const others = [...db.conns];
    db.conns.add(conn);
    if (data.version === version) { finishOpen(req, done, null, conn); return; }
    const oldVersion = data.version;
    fireVersionChange(others, oldVersion, version, () => {
      if (others.some((c) => !c.closed)) later(() => versionEvent('blocked', req, oldVersion, version));
      waitClosed(db, others, () => upgrade(db, data, conn, version, req, done));
    });
  }
  // "Upgrade a database": an upgrade transaction runs the upgradeneeded handlers.
  function upgrade(db, data, conn, version, req, done) {
    const oldVersion = data.version;
    const tx = createTx(conn, 'versionchange', null, 'default');
    tx.state = 'inactive';
    tx.hold = true; // until upgradeneeded has been dispatched
    tx.openReq = req;
    tx.oldVersion = oldVersion;
    db.upgradeTx = tx;
    data.version = version;
    tx.undo.push(() => { data.version = oldVersion; });
    tx.dirty = true;
    tx.onFinish.push(() => {
      if (tx.aborted) {
        closeConn(conn);
        finishOpen(req, done, domErr('AbortError', 'Version change transaction was aborted in upgradeneeded event handler.'));
      } else if (conn.closePending) {
        finishOpen(req, done, domErr('AbortError', 'The connection was closed.'));
      } else {
        finishOpen(req, done, null, conn);
      }
    });
    later(() => {
      req.result = conn.iface;
      req.tx = tx;
      req.done = true;
      tx.state = 'active';
      tx.hold = false;
      schedule(tx);
      const flags = versionEvent('upgradeneeded', req, oldVersion, version);
      if ((flags & THREW) && tx.state === 'active') tx.pendingAbort = domErr('AbortError', 'An exception was thrown in the upgradeneeded event handler.');
    });
  }
  function runDelete(db, req, done) {
    const dbs = backend.databases(db.origin);
    const data = dbs.get(db.name);
    const finish = (oldVersion) => {
      later(() => {
        req.done = true;
        req.result = undefined;
        dispatchAt([req.iface], new IDBVersionChangeEvent('success', { oldVersion, newVersion: null }));
      });
      done();
    };
    if (data === undefined) { finish(0); return; }
    const open = [...db.conns];
    fireVersionChange(open, data.version, null, () => {
      if (open.some((c) => !c.closed)) later(() => versionEvent('blocked', req, data.version, null));
      waitClosed(db, open, () => {
        const v = data.version;
        dbs.delete(db.name);
        backend.drop(db.origin, db.name);
        finish(v);
      });
    });
  }

  // ---------------------------------------------------------------------------------------
  // Handles and request helpers shared by IDBObjectStore and IDBIndex
  // ---------------------------------------------------------------------------------------
  // An object store handle is { tx, store, index: null, ... }, an index handle { tx, store, index, oh, ... }.
  function storeHandle(tx, store) {
    let h = tx.handles.get(store);
    if (h === undefined) {
      h = { tx, store, index: null, oh: null, name: store.name, iface: null, indexHandles: new Map(), kp: undefined };
      h.iface = new IDBObjectStore(INTERNAL, h);
      tx.handles.set(store, h);
    }
    return h;
  }
  function indexHandle(oh, idx) {
    let h = oh.indexHandles.get(idx);
    if (h === undefined) {
      h = { tx: oh.tx, store: oh.store, index: idx, oh, name: idx.name, iface: null, kp: undefined };
      h.iface = new IDBIndex(INTERNAL, h);
      oh.indexHandles.set(idx, h);
    }
    return h;
  }
  const rowsOf = (h) => (h.index === null ? h.store.rows : h.index.rows);
  // What every request-making method checks first: deleted, inactive, read-only.
  function preflight(h, method, iface, write) {
    const w = failedTo(method, iface);
    if (h.store.deleted || (h.index !== null && h.index.deleted)) {
      throw domErr('InvalidStateError', `${w}: The ${h.index !== null ? 'index or its object store' : 'object store'} has been deleted.`);
    }
    if (h.tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction ${h.tx.state === 'finished' ? 'has finished' : 'is not active'}.`);
    if (write && h.tx.mode === 'readonly') throw domErr('ReadOnlyError', `${w}: The transaction is read-only.`);
  }
  // The value is cloned while the transaction is inactive, so that getters cannot place requests.
  function cloneInTx(tx, value, method) {
    const prev = tx.state;
    tx.state = 'inactive';
    try {
      return cloneValue(value);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'DataCloneError') {
        throw domErr('DataCloneError', e.message.replace(/^Failed to execute 'structuredClone' on 'Window'/, failedTo(method, 'IDBObjectStore')));
      }
      throw e;
    } finally {
      if (tx.state === 'inactive') tx.state = prev;
    }
  }
  const DIRECTIONS = ['next', 'nextunique', 'prev', 'prevunique'];
  function toDirection(v, method, iface) {
    if (v === undefined) return 'next';
    const s = `${v}`;
    if (!DIRECTIONS.includes(s)) throw new TypeError(`${failedTo(method, iface)}: The provided value '${s}' is not a valid enum value of type IDBCursorDirection.`);
    return s;
  }
  const isBag = (v) => typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object Object]';
  const keyPathValue = (h, kp) => {
    if (!Array.isArray(kp)) return kp;
    if (h.kp === undefined) h.kp = kp.slice(); // the same array every time
    return h.kp;
  };

  function opGet(h, method, iface, args, keyOnly) {
    argsRequired(method, iface, 1, args.length);
    preflight(h, method, iface, false);
    const range = toRange(args[0], true);
    return execute(h.iface, h.tx, () => {
      const [s, e] = spanOf(rowsOf(h), range);
      if (s === e) return undefined;
      const row = rowsOf(h)[s];
      return keyOnly ? keyToValue(row.pk) : readValue(row);
    }).iface;
  }
  // getAll / getAllKeys / getAllRecords: (query, count) or an options bag.
  function opGetAll(h, kind, method, iface, args) {
    let query = args[0], count = args[1], dir = 'next';
    if (kind === 'record' || isBag(query)) {
      const o = query === undefined || query === null ? {} : query;
      if (!L.isObj(o)) throw new TypeError(`${failedTo(method, iface)}: The options argument is not an object.`);
      count = o.count;
      dir = toDirection(o.direction, method, iface);
      query = o.query;
    }
    const limit = count === undefined ? 0 : enforceRange(count, MAX_ULONG, failedTo(method, iface), 'unsigned long');
    preflight(h, method, iface, false);
    const range = toRange(query, false);
    return execute(h.iface, h.tx, () => {
      const rows = collect(rowsOf(h), range, dir, limit);
      if (kind === 'key') return rows.map((r) => keyToValue(r.pk));
      if (kind === 'value') return rows.map(readValue);
      return rows.map((r) => new IDBRecord(INTERNAL, keyToValue(r.key), keyToValue(r.pk), readValue(r)));
    }).iface;
  }
  function opCount(h, method, iface, query) {
    preflight(h, method, iface, false);
    const range = toRange(query, false);
    return execute(h.iface, h.tx, () => { const [s, e] = spanOf(rowsOf(h), range); return e - s; }).iface;
  }
  function opOpenCursor(h, method, iface, query, direction, keyOnly) {
    const dir = toDirection(direction, method, iface);
    preflight(h, method, iface, false);
    const range = toRange(query, false);
    const c = {
      iface: null, request: null, source: h, store: h.store, index: h.index, tx: h.tx, direction: dir, range, keyOnly,
      position: undefined, objPos: undefined, key: undefined, pk: undefined, value: undefined, gotValue: false,
      keyVal: undefined, pkVal: undefined,
    };
    c.iface = keyOnly ? new IDBCursor(INTERNAL, c) : new IDBCursorWithValue(INTERNAL, c);
    c.request = execute(h.iface, h.tx, () => (iterate(c, undefined, undefined, 1) ? c.iface : null));
    return c.request.iface;
  }
  // "Iterate a cursor": moves `count` records on, optionally to a key (and primary key).
  function iterate(c, key, primaryKey, count) {
    const rows = c.index !== null ? c.index.rows : c.store.rows;
    const dir = c.direction;
    const fwd = dir === 'next' || dir === 'nextunique';
    const uniq = dir === 'nextunique' || dir === 'prevunique';
    // Index cursors on the plain directions also order equal keys by the primary key.
    const withPk = c.index !== null && !uniq;
    const [s, e] = spanOf(rows, c.range);
    let pos = c.position, osp = c.objPos, found = null;
    for (let n = count; n > 0; n--) {
      found = null;
      if (fwd) {
        let i = s;
        if (key !== undefined) i = Math.max(i, lowerIdx(rows, key, primaryKey));
        if (pos !== undefined) i = Math.max(i, upperIdx(rows, pos, withPk ? osp : undefined));
        if (i < e) found = rows[i];
      } else {
        let j = e;
        if (key !== undefined) j = Math.min(j, upperIdx(rows, key, primaryKey));
        if (pos !== undefined) j = Math.min(j, lowerIdx(rows, pos, withPk ? osp : undefined));
        if (j > s) {
          found = rows[j - 1];
          if (dir === 'prevunique') found = rows[lowerIdx(rows, found.key)]; // the first row of that key
        }
      }
      if (found === null) break;
      pos = found.key;
      osp = found.pk;
    }
    c.keyVal = undefined;
    c.pkVal = undefined;
    if (found === null) {
      c.key = undefined;
      c.pk = undefined;
      c.value = undefined;
      if (c.index !== null) c.objPos = undefined;
      return false;
    }
    c.position = pos;
    c.objPos = osp;
    c.key = found.key;
    c.pk = found.pk;
    c.value = c.keyOnly ? undefined : readValue(found);
    c.gotValue = true;
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // IDBRequest, IDBOpenDBRequest
  // ---------------------------------------------------------------------------------------
  let reqOf;
  class IDBRequest extends EventTarget {
    #r;
    constructor(token, r) {
      if (token !== INTERNAL) throw L.illegal();
      super();
      this.#r = r;
    }
    static { reqOf = (o) => { if (!(typeof o === 'object' && o !== null && #r in o)) throw illegalInvocation(); return o.#r; }; }
    get result() {
      const r = this.#r;
      if (!r.done) throw domErr('InvalidStateError', "Failed to read the 'result' property from 'IDBRequest': The request has not finished.");
      return r.result;
    }
    get error() {
      const r = this.#r;
      if (!r.done) throw domErr('InvalidStateError', "Failed to read the 'error' property from 'IDBRequest': The request has not finished.");
      return r.error;
    }
    get source() { const s = this.#r.source; return s === null ? null : s; }
    get transaction() { const t = this.#r.tx; return t === null ? null : t.iface; }
    get readyState() { return this.#r.done ? 'done' : 'pending'; }
  }
  L.defineEventHandlers(IDBRequest.prototype, ['onsuccess', 'onerror'], (o) => { reqOf(o); return o; });
  class IDBOpenDBRequest extends IDBRequest { }
  L.defineEventHandlers(IDBOpenDBRequest.prototype, ['onblocked', 'onupgradeneeded'], (o) => { reqOf(o); return o; });

  // ---------------------------------------------------------------------------------------
  // IDBVersionChangeEvent
  // ---------------------------------------------------------------------------------------
  class IDBVersionChangeEvent extends Event {
    #old; #new;
    constructor(type, init) {
      super(type, init);
      const d = init === undefined || init === null ? {} : init;
      const w = "Failed to construct 'IDBVersionChangeEvent'";
      this.#old = d.oldVersion === undefined ? 0 : enforceRange(d.oldVersion, MAX_SAFE, w, 'unsigned long long');
      this.#new = d.newVersion === undefined || d.newVersion === null ? null : enforceRange(d.newVersion, MAX_SAFE, w, 'unsigned long long');
    }
    get oldVersion() { return this.#old; }
    get newVersion() { return this.#new; }
    // Chromium's legacy members.
    get dataLoss() { return 'none'; }
    get dataLossMessage() { return ''; }
  }

  // ---------------------------------------------------------------------------------------
  // IDBRecord
  // ---------------------------------------------------------------------------------------
  class IDBRecord {
    #key; #pk; #value;
    constructor(token, key, pk, value) {
      if (token !== INTERNAL) throw L.illegal();
      this.#key = key; this.#pk = pk; this.#value = value;
    }
    get key() { return this.#key; }
    get primaryKey() { return this.#pk; }
    get value() { return this.#value; }
  }

  // ---------------------------------------------------------------------------------------
  // IDBCursor, IDBCursorWithValue
  // ---------------------------------------------------------------------------------------
  let cursorOf;
  class IDBCursor {
    #c;
    constructor(token, c) {
      if (token !== INTERNAL) throw L.illegal();
      this.#c = c;
    }
    static { cursorOf = (o) => { if (!(typeof o === 'object' && o !== null && #c in o)) throw illegalInvocation(); return o.#c; }; }
    get source() { return this.#c.source.iface; }
    get direction() { return this.#c.direction; }
    get key() {
      const c = this.#c;
      if (c.key === undefined) return undefined;
      return c.keyVal !== undefined ? c.keyVal : (c.keyVal = keyToValue(c.key));
    }
    get primaryKey() {
      const c = this.#c;
      if (c.pk === undefined) return undefined;
      return c.pkVal !== undefined ? c.pkVal : (c.pkVal = keyToValue(c.pk));
    }
    get request() { return this.#c.request.iface; }
    advance(count) {
      const w = failedTo('advance', 'IDBCursor');
      argsRequired('advance', 'IDBCursor', 1, arguments.length);
      const n = enforceRange(count, MAX_ULONG, w, 'unsigned long');
      if (n === 0) throw new TypeError(`${w}: A count argument with value 0 (zero) was supplied, must be greater than 0.`);
      const c = this.#c;
      cursorCheck(c, 'advance');
      moveCursor(c, undefined, undefined, n);
    }
    continue(key) {
      const c = this.#c;
      cursorCheck(c, 'continue');
      let k;
      if (key !== undefined) {
        k = toKeyOrThrow(key);
        const cmp = cmpKeys(k, c.position);
        if (c.direction === 'next' || c.direction === 'nextunique' ? cmp <= 0 : cmp >= 0) {
          throw domErr('DataError', `${failedTo('continue', 'IDBCursor')}: The parameter is less than or equal to this cursor's position.`);
        }
      }
      moveCursor(c, k, undefined, 1);
    }
    continuePrimaryKey(key, primaryKey) {
      const w = failedTo('continuePrimaryKey', 'IDBCursor');
      argsRequired('continuePrimaryKey', 'IDBCursor', 2, arguments.length);
      const c = this.#c;
      cursorCheck(c, 'continuePrimaryKey', true);
      const k = toKeyOrThrow(key), pk = toKeyOrThrow(primaryKey);
      const cmp = cmpKeys(k, c.position);
      const next = c.direction === 'next';
      if (next ? cmp < 0 : cmp > 0) throw domErr('DataError', `${w}: The key parameter is ${next ? 'less' : 'greater'} than or equal to this cursor's position.`);
      if (cmp === 0) {
        const pcmp = cmpKeys(pk, c.objPos);
        if (next ? pcmp <= 0 : pcmp >= 0) throw domErr('DataError', `${w}: The key and primary key parameters are ${next ? 'less' : 'greater'} than or equal to this cursor's position.`);
      }
      moveCursor(c, k, pk, 1);
    }
    update(value) {
      const w = failedTo('update', 'IDBCursor');
      argsRequired('update', 'IDBCursor', 1, arguments.length);
      const c = this.#c;
      const tx = c.tx;
      if (tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction ${tx.state === 'finished' ? 'has finished' : 'is not active'}.`);
      if (tx.mode === 'readonly') throw domErr('ReadOnlyError', `${w}: The record may not be updated inside a read-only transaction.`);
      cursorLive(c, w);
      if (c.keyOnly) throw domErr('InvalidStateError', `${w}: The cursor is a key cursor.`);
      const clone = cloneInTx(tx, value, 'update');
      const store = c.store;
      if (store.keyPath !== null) {
        const kpk = extractKey(clone, store.keyPath, false);
        if (kpk === FAILURE || kpk === null || cmpKeys(kpk, c.pk) !== 0) {
          throw domErr('DataError', `${w}: The effective object store of this cursor uses in-line keys and evaluating the key path of the value parameter results in a different value than the cursor's effective key.`);
        }
      }
      const key = c.pk;
      return execute(this, tx, () => keyToValue(storeRecord(tx, store, clone, key, false))).iface;
    }
    delete() {
      const w = failedTo('delete', 'IDBCursor');
      const c = this.#c;
      const tx = c.tx;
      if (tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction ${tx.state === 'finished' ? 'has finished' : 'is not active'}.`);
      if (tx.mode === 'readonly') throw domErr('ReadOnlyError', `${w}: The record may not be deleted inside a read-only transaction.`);
      cursorLive(c, w);
      if (c.keyOnly) throw domErr('InvalidStateError', `${w}: The cursor is a key cursor.`);
      const store = c.store, key = c.pk;
      return execute(this, tx, () => { storeDelete(tx, store, { lo: key, hi: key, loOpen: false, hiOpen: false }); }).iface;
    }
  }
  // Not deleted, and holding a record (not moving, not past the end).
  function cursorLive(c, w) {
    if (c.store.deleted || (c.index !== null && c.index.deleted)) throw domErr('InvalidStateError', `${w}: The cursor's source or effective object store has been deleted.`);
    if (!c.gotValue) throw domErr('InvalidStateError', `${w}: The cursor is being iterated or has iterated past its end.`);
  }
  function cursorCheck(c, method, needsIndex) {
    const w = failedTo(method, 'IDBCursor');
    if (c.tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction ${c.tx.state === 'finished' ? 'has finished' : 'is not active'}.`);
    if (c.store.deleted || (c.index !== null && c.index.deleted)) throw domErr('InvalidStateError', `${w}: The cursor's source or effective object store has been deleted.`);
    if (needsIndex) {
      if (c.index === null) throw domErr('InvalidAccessError', `${w}: The cursor's source is not an index.`);
      if (c.direction !== 'next' && c.direction !== 'prev') throw domErr('InvalidAccessError', `${w}: The cursor's direction is not 'next' or 'prev'.`);
    }
    cursorLive(c, w);
  }
  // Queues the move on the cursor's own request.
  function moveCursor(c, key, primaryKey, count) {
    c.gotValue = false;
    c.request.done = false;
    execute(c.source.iface, c.tx, () => (iterate(c, key, primaryKey, count) ? c.iface : null), c.request);
  }
  class IDBCursorWithValue extends IDBCursor {
    get value() { return cursorOf(this).value; }
  }

  // ---------------------------------------------------------------------------------------
  // IDBIndex
  // ---------------------------------------------------------------------------------------
  let indexOf;
  class IDBIndex {
    #h;
    constructor(token, h) {
      if (token !== INTERNAL) throw L.illegal();
      this.#h = h;
    }
    static { indexOf = (o) => { if (!(typeof o === 'object' && o !== null && #h in o)) throw illegalInvocation(); return o.#h; }; }
    get name() { return this.#h.name; }
    set name(value) {
      const h = this.#h;
      const w = "Failed to set the 'name' property on 'IDBIndex'";
      const name = `${value}`;
      const tx = h.tx, idx = h.index, store = h.store;
      if (tx.mode !== 'versionchange') throw domErr('InvalidStateError', `${w}: The index's transaction is not an upgrade transaction.`);
      if (tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction is not active.`);
      if (idx.deleted || store.deleted) throw domErr('InvalidStateError', `${w}: The index or its object store has been deleted.`);
      if (idx.name === name) return;
      if (store.indexes.has(name)) throw domErr('ConstraintError', `${w}: An index with the specified name already exists.`);
      const old = idx.name;
      store.indexes.delete(old);
      idx.name = name;
      store.indexes.set(name, idx);
      h.name = name;
      tx.dirty = true;
      tx.undo.push(() => { store.indexes.delete(name); idx.name = old; store.indexes.set(old, idx); if (idx.createdBy !== tx) h.name = old; });
    }
    get objectStore() { const h = this.#h; return h.oh.iface; }
    get keyPath() { const h = this.#h; return keyPathValue(h, h.index.keyPath); }
    get multiEntry() { return this.#h.index.multiEntry; }
    get unique() { return this.#h.index.unique; }
    get(query) { return opGet(this.#h, 'get', 'IDBIndex', arguments, false); }
    getKey(query) { return opGet(this.#h, 'getKey', 'IDBIndex', arguments, true); }
    getAll(query, count) { return opGetAll(this.#h, 'value', 'getAll', 'IDBIndex', arguments); }
    getAllKeys(query, count) { return opGetAll(this.#h, 'key', 'getAllKeys', 'IDBIndex', arguments); }
    getAllRecords(options) { return opGetAll(this.#h, 'record', 'getAllRecords', 'IDBIndex', arguments); }
    count(query) { return opCount(this.#h, 'count', 'IDBIndex', query); }
    openCursor(query, direction) { return opOpenCursor(this.#h, 'openCursor', 'IDBIndex', query, direction, false); }
    openKeyCursor(query, direction) { return opOpenCursor(this.#h, 'openKeyCursor', 'IDBIndex', query, direction, true); }
  }

  // ---------------------------------------------------------------------------------------
  // IDBObjectStore
  // ---------------------------------------------------------------------------------------
  let storeOf;
  class IDBObjectStore {
    #h;
    constructor(token, h) {
      if (token !== INTERNAL) throw L.illegal();
      this.#h = h;
    }
    static { storeOf = (o) => { if (!(typeof o === 'object' && o !== null && #h in o)) throw illegalInvocation(); return o.#h; }; }
    get name() { return this.#h.name; }
    set name(value) {
      const h = this.#h;
      const w = "Failed to set the 'name' property on 'IDBObjectStore'";
      const name = `${value}`;
      const tx = h.tx, store = h.store;
      if (store.deleted) throw domErr('InvalidStateError', `${w}: The object store has been deleted.`);
      if (tx.mode !== 'versionchange') throw domErr('InvalidStateError', `${w}: The object store's transaction is not an upgrade transaction.`);
      if (tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction is not active.`);
      if (store.name === name) return;
      const data = dataOf(tx.db);
      if (data.stores.has(name)) throw domErr('ConstraintError', `${w}: An object store with the specified name already exists.`);
      const old = store.name;
      data.stores.delete(old);
      store.name = name;
      data.stores.set(name, store);
      h.name = name;
      tx.dirty = true;
      tx.undo.push(() => { data.stores.delete(name); store.name = old; data.stores.set(old, store); if (store.createdBy !== tx) h.name = old; });
    }
    get keyPath() { const h = this.#h; return keyPathValue(h, h.store.keyPath); }
    get indexNames() { const s = this.#h.store; return L.makeDOMStringList(s.deleted ? [] : [...s.indexes.keys()].sort()); }
    get transaction() { return this.#h.tx.iface; }
    get autoIncrement() { return this.#h.store.autoIncrement; }
    put(value, key) { return addOrPut(this.#h, 'put', arguments, false); }
    add(value, key) { return addOrPut(this.#h, 'add', arguments, true); }
    delete(query) {
      const h = this.#h;
      argsRequired('delete', 'IDBObjectStore', 1, arguments.length);
      preflight(h, 'delete', 'IDBObjectStore', true);
      const range = toRange(query, true);
      return execute(this, h.tx, () => { storeDelete(h.tx, h.store, range); }).iface;
    }
    clear() {
      const h = this.#h;
      preflight(h, 'clear', 'IDBObjectStore', true);
      return execute(this, h.tx, () => { storeDelete(h.tx, h.store, null); }).iface;
    }
    get(query) { return opGet(this.#h, 'get', 'IDBObjectStore', arguments, false); }
    getKey(query) { return opGet(this.#h, 'getKey', 'IDBObjectStore', arguments, true); }
    getAll(query, count) { return opGetAll(this.#h, 'value', 'getAll', 'IDBObjectStore', arguments); }
    getAllKeys(query, count) { return opGetAll(this.#h, 'key', 'getAllKeys', 'IDBObjectStore', arguments); }
    getAllRecords(options) { return opGetAll(this.#h, 'record', 'getAllRecords', 'IDBObjectStore', arguments); }
    count(query) { return opCount(this.#h, 'count', 'IDBObjectStore', query); }
    openCursor(query, direction) { return opOpenCursor(this.#h, 'openCursor', 'IDBObjectStore', query, direction, false); }
    openKeyCursor(query, direction) { return opOpenCursor(this.#h, 'openKeyCursor', 'IDBObjectStore', query, direction, true); }
    index(name) {
      const h = this.#h;
      const w = failedTo('index', 'IDBObjectStore');
      argsRequired('index', 'IDBObjectStore', 1, arguments.length);
      if (h.store.deleted) throw domErr('InvalidStateError', `${w}: The object store has been deleted.`);
      if (h.tx.state === 'finished') throw domErr('InvalidStateError', `${w}: The transaction has finished.`);
      const idx = h.store.indexes.get(`${name}`);
      if (idx === undefined) throw domErr('NotFoundError', `${w}: The specified index was not found.`);
      return indexHandle(h, idx).iface;
    }
    createIndex(name, keyPath, options) {
      const h = this.#h;
      const w = failedTo('createIndex', 'IDBObjectStore');
      argsRequired('createIndex', 'IDBObjectStore', 2, arguments.length);
      name = `${name}`;
      const kp = toKeyPath(keyPath);
      const o = options === undefined || options === null ? {} : options;
      const tx = h.tx, store = h.store;
      if (tx.mode !== 'versionchange') throw domErr('InvalidStateError', `${w}: The database is not running a version change transaction.`);
      if (store.deleted) throw domErr('InvalidStateError', `${w}: The object store has been deleted.`);
      if (tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction is not active.`);
      if (store.indexes.has(name)) throw domErr('ConstraintError', `${w}: An index with the specified name already exists.`);
      if (kp === null || !isValidKeyPath(kp)) throw domErr('SyntaxError', `${w}: The keyPath argument contains an invalid key path.`);
      const unique = !!o.unique, multiEntry = !!o.multiEntry;
      if (multiEntry && Array.isArray(kp)) throw domErr('InvalidAccessError', `${w}: The keyPath argument was an array and the multiEntry option is true.`);
      const idx = { name, keyPath: kp, unique, multiEntry, rows: [], store, populated: false, deleted: false, createdBy: tx };
      store.indexes.set(name, idx);
      store.maintained.add(idx);
      tx.dirty = true;
      tx.undo.push(() => { store.indexes.delete(name); store.maintained.delete(idx); idx.deleted = true; });
      // The index is filled by a request of the transaction, after the ones already queued.
      tx.queue.push({ req: null, run: () => indexPopulate(tx, idx) });
      schedule(tx);
      return indexHandle(h, idx).iface;
    }
    deleteIndex(name) {
      const h = this.#h;
      const w = failedTo('deleteIndex', 'IDBObjectStore');
      argsRequired('deleteIndex', 'IDBObjectStore', 1, arguments.length);
      name = `${name}`;
      const tx = h.tx, store = h.store;
      if (tx.mode !== 'versionchange') throw domErr('InvalidStateError', `${w}: The database is not running a version change transaction.`);
      if (store.deleted) throw domErr('InvalidStateError', `${w}: The object store has been deleted.`);
      if (tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction is not active.`);
      const idx = store.indexes.get(name);
      if (idx === undefined) throw domErr('NotFoundError', `${w}: The specified index was not found.`);
      store.indexes.delete(name);
      idx.deleted = true;
      tx.dirty = true;
      tx.undo.push(() => { store.indexes.set(name, idx); idx.deleted = false; });
      // The index stops being maintained in order: the requests queued before this call still update it.
      tx.queue.push({ req: null, run: () => { store.maintained.delete(idx); tx.undo.push(() => { store.maintained.add(idx); }); } });
      schedule(tx);
    }
  }
  // add() and put().
  function addOrPut(h, method, args, noOverwrite) {
    const w = failedTo(method, 'IDBObjectStore');
    argsRequired(method, 'IDBObjectStore', 1, args.length);
    preflight(h, method, 'IDBObjectStore', true);
    const tx = h.tx, store = h.store;
    const keyGiven = args.length > 1 && args[1] !== undefined;
    if (store.keyPath !== null && keyGiven) throw domErr('DataError', `${w}: The object store uses in-line keys and the key parameter was provided.`);
    if (store.keyPath === null && !store.autoIncrement && !keyGiven) throw domErr('DataError', `${w}: The object store uses out-of-line keys and has no key generator and the key parameter was not provided.`);
    let key;
    if (keyGiven) key = toKeyOrThrow(args[1]);
    const clone = cloneInTx(tx, args[0], method);
    if (store.keyPath !== null) {
      const kpk = extractKey(clone, store.keyPath, false);
      if (kpk === null) throw domErr('DataError', `${w}: Evaluating the object store's key path yielded a value that is not a valid key.`);
      if (kpk !== FAILURE) {
        key = kpk;
      } else {
        if (!store.autoIncrement) throw domErr('DataError', `${w}: Evaluating the object store's key path did not yield a value.`);
        if (!canInjectKey(clone, store.keyPath)) throw domErr('DataError', `${w}: A generated key could not be inserted into the value at the object store's key path.`);
      }
    }
    return execute(h.iface, tx, () => keyToValue(storeRecord(tx, store, clone, key, noOverwrite))).iface;
  }

  // ---------------------------------------------------------------------------------------
  // IDBTransaction
  // ---------------------------------------------------------------------------------------
  let txOf;
  class IDBTransaction extends EventTarget {
    #t;
    constructor(token, t) {
      if (token !== INTERNAL) throw L.illegal();
      super();
      this.#t = t;
    }
    static { txOf = (o) => { if (!(typeof o === 'object' && o !== null && #t in o)) throw illegalInvocation(); return o.#t; }; }
    get objectStoreNames() {
      const t = this.#t;
      const stores = t.scope === null ? (dataOf(t.db) ? dataOf(t.db).stores.values() : []) : t.scope;
      return L.makeDOMStringList(Array.from(stores, (s) => s.name).sort());
    }
    get mode() { return this.#t.mode; }
    get durability() { return this.#t.durability; }
    get db() { return this.#t.conn.iface; }
    get error() { return this.#t.error; }
    objectStore(name) {
      const t = this.#t;
      const w = failedTo('objectStore', 'IDBTransaction');
      argsRequired('objectStore', 'IDBTransaction', 1, arguments.length);
      name = `${name}`;
      if (t.state === 'finished') throw domErr('InvalidStateError', `${w}: The transaction has finished.`);
      let store;
      if (t.scope === null) {
        const data = dataOf(t.db);
        store = data === undefined ? undefined : data.stores.get(name);
      } else {
        for (const s of t.scope) if (s.name === name) { store = s; break; }
      }
      if (store === undefined) throw domErr('NotFoundError', `${w}: The specified object store was not found.`);
      return storeHandle(t, store).iface;
    }
    commit() {
      const t = this.#t;
      if (t.state !== 'active') throw domErr('InvalidStateError', `${failedTo('commit', 'IDBTransaction')}: The transaction is not active.`);
      t.state = 'committing';
      schedule(t);
    }
    abort() {
      const t = this.#t;
      if (t.state === 'committing' || t.state === 'finished') {
        throw domErr('InvalidStateError', `${failedTo('abort', 'IDBTransaction')}: The transaction is already ${t.state === 'finished' ? 'finished' : 'committing'}.`);
      }
      abortTx(t, null);
    }
  }
  L.defineEventHandlers(IDBTransaction.prototype, ['onabort', 'oncomplete', 'onerror'], (o) => { txOf(o); return o; });

  // ---------------------------------------------------------------------------------------
  // IDBDatabase
  // ---------------------------------------------------------------------------------------
  let connOf;
  class IDBDatabase extends EventTarget {
    #c;
    constructor(token, c) {
      if (token !== INTERNAL) throw L.illegal();
      super();
      this.#c = c;
    }
    static { connOf = (o) => { if (!(typeof o === 'object' && o !== null && #c in o)) throw illegalInvocation(); return o.#c; }; }
    get name() { return this.#c.db.name; }
    get version() { return this.#c.version; }
    get objectStoreNames() {
      const c = this.#c;
      if (c.names !== null) return L.makeDOMStringList(c.names.slice());
      const data = dataOf(c.db);
      return L.makeDOMStringList(data === undefined ? [] : [...data.stores.keys()].sort());
    }
    transaction(storeNames, mode = 'readonly', options = {}) {
      const c = this.#c;
      const w = failedTo('transaction', 'IDBDatabase');
      argsRequired('transaction', 'IDBDatabase', 1, arguments.length);
      mode = `${mode}`;
      if (mode !== 'readonly' && mode !== 'readwrite' && mode !== 'versionchange') {
        throw new TypeError(`${w}: The provided value '${mode}' is not a valid enum value of type IDBTransactionMode.`);
      }
      let durability = 'default';
      if (options !== undefined && options !== null && options.durability !== undefined) {
        durability = `${options.durability}`;
        if (durability !== 'default' && durability !== 'strict' && durability !== 'relaxed') {
          throw new TypeError(`${w}: The provided value '${durability}' is not a valid enum value of type IDBTransactionDurability.`);
        }
      }
      const names = typeof storeNames === 'object' && storeNames !== null && typeof storeNames[Symbol.iterator] === 'function'
        ? Array.from(storeNames, (x) => `${x}`) : [`${storeNames}`];
      const up = c.db.upgradeTx;
      if (up !== null && up.conn === c) throw domErr('InvalidStateError', `${w}: A version change transaction is running.`);
      if (c.closePending) throw domErr('InvalidStateError', `${w}: The database connection is closing.`);
      const data = dataOf(c.db);
      const scope = new Set();
      for (const n of names) {
        const store = data === undefined ? undefined : data.stores.get(n);
        if (store === undefined) throw domErr('NotFoundError', `${w}: One of the specified object stores was not found.`);
        scope.add(store);
      }
      if (scope.size === 0) throw domErr('InvalidAccessError', `${w}: The storeNames parameter is empty.`);
      if (mode === 'versionchange') throw new TypeError(`${w}: The mode provided ('versionchange') is not one of 'readonly' or 'readwrite'.`);
      const tx = createTx(c, mode, scope, durability);
      schedule(tx);
      return tx.iface;
    }
    close() { closeConn(this.#c); }
    createObjectStore(name, options) {
      const c = this.#c;
      const w = failedTo('createObjectStore', 'IDBDatabase');
      argsRequired('createObjectStore', 'IDBDatabase', 1, arguments.length);
      name = `${name}`;
      const tx = c.db.upgradeTx;
      if (tx === null || tx.conn !== c) throw domErr('InvalidStateError', `${w}: The database is not running a version change transaction.`);
      if (tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction is not active.`);
      const o = options === undefined || options === null ? {} : options;
      const kp = toKeyPath(o.keyPath);
      if (kp !== null && !isValidKeyPath(kp)) throw domErr('SyntaxError', `${w}: The keyPath option is not a valid key path.`);
      const data = dataOf(c.db);
      if (data.stores.has(name)) throw domErr('ConstraintError', `${w}: An object store with the specified name already exists.`);
      const autoIncrement = !!o.autoIncrement;
      if (autoIncrement && (kp === '' || Array.isArray(kp))) throw domErr('InvalidAccessError', `${w}: The autoIncrement option was set but the keyPath option was empty or an array.`);
      const store = { name, keyPath: kp, autoIncrement, nextKey: 1, rows: [], indexes: new Map(), maintained: new Set(), deleted: false, createdBy: tx };
      data.stores.set(name, store);
      tx.dirty = true;
      tx.undo.push(() => { data.stores.delete(name); store.deleted = true; });
      return storeHandle(tx, store).iface;
    }
    deleteObjectStore(name) {
      const c = this.#c;
      const w = failedTo('deleteObjectStore', 'IDBDatabase');
      argsRequired('deleteObjectStore', 'IDBDatabase', 1, arguments.length);
      name = `${name}`;
      const tx = c.db.upgradeTx;
      if (tx === null || tx.conn !== c) throw domErr('InvalidStateError', `${w}: The database is not running a version change transaction.`);
      if (tx.state !== 'active') throw domErr('TransactionInactiveError', `${w}: The transaction is not active.`);
      const data = dataOf(c.db);
      const store = data.stores.get(name);
      if (store === undefined) throw domErr('NotFoundError', `${w}: The specified object store was not found.`);
      data.stores.delete(name);
      store.deleted = true;
      tx.dirty = true;
      tx.undo.push(() => { data.stores.set(name, store); store.deleted = false; });
    }
  }
  L.defineEventHandlers(IDBDatabase.prototype, ['onabort', 'onclose', 'onerror', 'onversionchange'], (o) => { connOf(o); return o; });

  // ---------------------------------------------------------------------------------------
  // IDBFactory
  // ---------------------------------------------------------------------------------------
  let factoryCheck;
  class IDBFactory {
    #brand;
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    static { factoryCheck = (o) => { if (!(typeof o === 'object' && o !== null && #brand in o)) throw illegalInvocation(); }; }
    open(name, version) {
      factoryCheck(this);
      const w = failedTo('open', 'IDBFactory');
      argsRequired('open', 'IDBFactory', 1, arguments.length);
      name = `${name}`;
      let v;
      if (version !== undefined) {
        v = enforceRange(version, MAX_SAFE, w, 'unsigned long long');
        if (v === 0) throw new TypeError(`${w}: The version provided must not be 0.`);
      }
      const req = newOpenRequest();
      const db = liveDb(storageKey(), name);
      enqueueConn(db, (done) => runOpen(db, v, req, done));
      return req.iface;
    }
    deleteDatabase(name) {
      factoryCheck(this);
      argsRequired('deleteDatabase', 'IDBFactory', 1, arguments.length);
      name = `${name}`;
      const req = newOpenRequest();
      const db = liveDb(storageKey(), name);
      enqueueConn(db, (done) => runDelete(db, req, done));
      return req.iface;
    }
    databases() {
      try { factoryCheck(this); } catch (e) { return L.rejectedPromise(e); }
      const key = storageKey();
      const list = [];
      for (const [name, data] of backend.databases(key)) {
        const up = liveDb(key, name).upgradeTx; // its version change is not committed yet
        const version = up !== null ? up.oldVersion : data.version;
        if (version !== 0) list.push({ name, version });
      }
      return L.newPromise((resolve) => later(() => resolve(list)));
    }
    cmp(first, second) {
      factoryCheck(this);
      argsRequired('cmp', 'IDBFactory', 2, arguments.length);
      return cmpKeys(toKeyOrThrow(first), toKeyOrThrow(second));
    }
  }

  // The IDL argument counts (`length` of the methods), which the parameter lists above do not express:
  // optional arguments are read from `arguments`.
  const setLengths = (target, lengths) => {
    for (const k of Object.keys(lengths)) Object.defineProperty(target[k], 'length', { value: lengths[k], configurable: true });
  };
  for (const C of [IDBFactory, IDBDatabase, IDBObjectStore, IDBIndex, IDBTransaction, IDBRequest, IDBCursor, IDBKeyRange, IDBRecord]) {
    Object.defineProperty(C, 'length', { value: 0, configurable: true }); // the constructors are illegal
  }
  Object.defineProperty(IDBVersionChangeEvent, 'length', { value: 1, configurable: true });
  for (const k of ['only', 'lowerBound', 'upperBound', 'bound']) Object.defineProperty(IDBKeyRange, k, { enumerable: true });
  setLengths(IDBFactory.prototype, { open: 1, deleteDatabase: 1, databases: 0, cmp: 2 });
  setLengths(IDBDatabase.prototype, { transaction: 1, close: 0, createObjectStore: 1, deleteObjectStore: 1 });
  setLengths(IDBObjectStore.prototype, {
    put: 1, add: 1, delete: 1, clear: 0, get: 1, getKey: 1, getAll: 0, getAllKeys: 0, getAllRecords: 0, count: 0, openCursor: 0,
    openKeyCursor: 0, index: 1, createIndex: 2, deleteIndex: 1,
  });
  setLengths(IDBIndex.prototype, { get: 1, getKey: 1, getAll: 0, getAllKeys: 0, getAllRecords: 0, count: 0, openCursor: 0, openKeyCursor: 0 });
  setLengths(IDBCursor.prototype, { advance: 1, continue: 0, continuePrimaryKey: 2, update: 1, delete: 0 });
  setLengths(IDBKeyRange, { only: 1, lowerBound: 1, upperBound: 1, bound: 2 });
  setLengths(IDBTransaction.prototype, { objectStore: 1, commit: 0, abort: 0 });

  const factory = new IDBFactory(INTERNAL);
  L.indexedDB = factory;
  for (const [name, C] of Object.entries({
    IDBFactory, IDBDatabase, IDBObjectStore, IDBIndex, IDBTransaction, IDBRequest, IDBOpenDBRequest, IDBCursor,
    IDBCursorWithValue, IDBKeyRange, IDBVersionChangeEvent, IDBRecord,
  })) L.expose(name, C);
})(globalThis.__layer);
