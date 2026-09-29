'use strict';
// IndexedDB (45_indexeddb.js): keys, key ranges, stores, indexes, cursors, transactions, versioning,
// events, and the usage patterns of idb / idb-keyval / raw callers.
const assert = require('assert');
const { createEnv } = require('../harness');

// Helpers available to the page code of every test.
const PRELUDE = `
  window.rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  window.txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res('complete'); tx.onabort = () => rej(tx.error || new DOMException('aborted', 'AbortError')); });
  window.openDb = (name, version, upgrade) => new Promise((res, rej) => {
    const r = indexedDB.open(name, version);
    if (upgrade) r.onupgradeneeded = (ev) => upgrade(r.result, ev, r.transaction);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  window.errName = async (p) => { try { await p; return 'no error'; } catch (e) { return e && e.name; } };
  window.thrown = (fn) => { try { fn(); return 'no error'; } catch (e) { return e && e.name; } };
  window.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

// Runs async page code (in a fresh page unless `e` is given); its return value comes back through JSON.
async function page(code, e) {
  if (e === undefined) { e = await createEnv(); e.run(PRELUDE); }
  e.run(`window.__r = undefined; window.__e = undefined; window.__done = false;
    (async () => { ${code} })().then((v) => { window.__r = JSON.stringify(v === undefined ? null : v); window.__done = true; },
      (err) => { window.__e = String(err && err.stack ? err.stack : err); window.__done = true; });`);
  await e.flush();
  const err = e.run('window.__e');
  if (err !== undefined) throw new Error('page code failed: ' + err);
  assert.strictEqual(e.run('window.__done'), true, 'page code did not finish (a request or transaction stalled)');
  return JSON.parse(e.run('window.__r'));
}

test('IndexedDB: exposure, interface objects, illegal constructors', async () => {
  const r = await page(`
    const desc = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    const names = ['IDBFactory', 'IDBDatabase', 'IDBObjectStore', 'IDBIndex', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest',
      'IDBCursor', 'IDBCursorWithValue', 'IDBKeyRange', 'IDBVersionChangeEvent', 'IDBRecord'];
    return {
      type: typeof indexedDB, isFactory: indexedDB instanceof IDBFactory, tag: Object.prototype.toString.call(indexedDB),
      accessor: typeof desc.get + ',' + desc.enumerable, same: indexedDB === window.indexedDB, inSelf: 'indexedDB' in self,
      globals: names.map((n) => typeof window[n]).join(),
      illegal: ['IDBFactory', 'IDBDatabase', 'IDBObjectStore', 'IDBIndex', 'IDBTransaction', 'IDBRequest', 'IDBCursor', 'IDBKeyRange'].map((n) => thrown(() => new window[n]())).join(),
      inherit: [IDBOpenDBRequest.prototype instanceof IDBRequest, IDBCursorWithValue.prototype instanceof IDBCursor,
        IDBDatabase.prototype instanceof EventTarget, IDBTransaction.prototype instanceof EventTarget, IDBVersionChangeEvent.prototype instanceof Event].join(),
      evt: (() => { const v = new IDBVersionChangeEvent('x', { oldVersion: 3, newVersion: null }); return [v.type, v.oldVersion, v.newVersion, v.bubbles, v instanceof Event].join(); })(),
      evt2: (() => { const v = new IDBVersionChangeEvent('y'); return [v.oldVersion, v.newVersion].join(); })(),
      lengths: [IDBFactory.length, IDBRequest.length, IDBVersionChangeEvent.length, indexedDB.open.length, indexedDB.cmp.length, IDBObjectStore.prototype.put.length, IDBObjectStore.prototype.getAll.length,
        IDBObjectStore.prototype.createIndex.length, IDBCursor.prototype.continue.length, IDBCursor.prototype.continuePrimaryKey.length, IDBKeyRange.bound.length, IDBDatabase.prototype.transaction.length].join(),
      statics: ['only', 'lowerBound', 'upperBound', 'bound'].map((k) => Object.getOwnPropertyDescriptor(IDBKeyRange, k).enumerable).join(),
      wrongThis: [thrown(() => indexedDB.open.call({}, 'x')), thrown(() => IDBObjectStore.prototype.get.call({}, 1)), thrown(() => Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess').get.call(IDBRequest.prototype)),
        thrown(() => Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result').get.call(null)), thrown(() => IDBKeyRange.prototype.includes.call({}, 1))].join(),
      members: {
        factory: Object.getOwnPropertyNames(IDBFactory.prototype).sort().join(),
        db: Object.getOwnPropertyNames(IDBDatabase.prototype).sort().join(),
        store: Object.getOwnPropertyNames(IDBObjectStore.prototype).sort().join(),
        index: Object.getOwnPropertyNames(IDBIndex.prototype).sort().join(),
        tx: Object.getOwnPropertyNames(IDBTransaction.prototype).sort().join(),
        req: Object.getOwnPropertyNames(IDBRequest.prototype).sort().join(),
        cursor: Object.getOwnPropertyNames(IDBCursor.prototype).sort().join(),
        range: Object.getOwnPropertyNames(IDBKeyRange).sort().join() + '|' + Object.getOwnPropertyNames(IDBKeyRange.prototype).sort().join(),
      },
    };
  `);
  assert.strictEqual(r.type, 'object');
  assert.strictEqual(r.isFactory, true);
  assert.strictEqual(r.tag, '[object IDBFactory]');
  assert.strictEqual(r.accessor, 'function,true');
  assert.strictEqual(r.same, true);
  assert.strictEqual(r.inSelf, true);
  assert.strictEqual(r.globals, Array(12).fill('function').join());
  assert.strictEqual(r.illegal, Array(8).fill('TypeError').join());
  assert.strictEqual(r.inherit, 'true,true,true,true,true');
  assert.strictEqual(r.evt, 'x,3,,false,true');
  assert.strictEqual(r.evt2, '0,');
  assert.strictEqual(r.lengths, '0,0,1,1,2,1,0,2,0,2,2,1');
  assert.strictEqual(r.statics, 'true,true,true,true');
  assert.strictEqual(r.wrongThis, 'TypeError,TypeError,TypeError,TypeError,TypeError');
  assert.strictEqual(r.members.factory, 'cmp,constructor,databases,deleteDatabase,open');
  assert.strictEqual(r.members.db, 'close,constructor,createObjectStore,deleteObjectStore,name,objectStoreNames,onabort,onclose,onerror,onversionchange,transaction,version');
  assert.strictEqual(r.members.store, 'add,autoIncrement,clear,constructor,count,createIndex,delete,deleteIndex,get,getAll,getAllKeys,getAllRecords,getKey,index,indexNames,keyPath,name,openCursor,openKeyCursor,put,transaction');
  assert.strictEqual(r.members.index, 'constructor,count,get,getAll,getAllKeys,getAllRecords,getKey,keyPath,multiEntry,name,objectStore,openCursor,openKeyCursor,unique');
  assert.strictEqual(r.members.tx, 'abort,commit,constructor,db,durability,error,mode,objectStore,objectStoreNames,onabort,oncomplete,onerror');
  assert.strictEqual(r.members.req, 'constructor,error,onerror,onsuccess,readyState,result,source,transaction');
  assert.strictEqual(r.members.cursor, 'advance,constructor,continue,continuePrimaryKey,delete,direction,key,primaryKey,request,source,update');
  assert.strictEqual(r.members.range, 'bound,length,lowerBound,name,only,prototype,upperBound|constructor,includes,lower,lowerOpen,upper,upperOpen');
});

test('IndexedDB: key ordering, validity and cmp()', async () => {
  const r = await page(`
    const cmp = (a, b) => indexedDB.cmp(a, b);
    const ordered = [-Infinity, -1, -0, 0, 1.5, Infinity, new Date(-5), new Date(0), new Date(1e12), '', 'a', 'aa', 'b', '\\ud800', '\\uffff',
      new Uint8Array([]).buffer, new Uint8Array([0]).buffer, new Uint8Array([0, 1]).buffer, new Uint8Array([1]),
      [], [1], [1, 'a'], [1, 'b'], [2], ['a', [1, 2]], [[]], [[1]]];
    let bad = [];
    for (let i = 0; i < ordered.length; i++) for (let j = 0; j < ordered.length; j++) {
      const c = cmp(ordered[i], ordered[j]);
      const want = i < j ? -1 : i > j ? 1 : 0;
      // -0 and 0 are equal keys
      if (c !== want && !((i === 2 && j === 3) || (i === 3 && j === 2))) bad.push(i + ':' + j + '=' + c);
    }
    const invalid = [NaN, undefined, null, true, {}, Symbol('s'), 10n, new Date(NaN), [NaN], [{}], () => 1, [,1], /x/];
    const circular = []; circular.push(circular);
    invalid.push(circular);
    return {
      bad,
      eq: [cmp(-0, 0), cmp(new Date(5), new Date(5)), cmp([1, [2]], [1, [2]]), cmp(new Uint8Array([1, 2]), new Uint8Array([1, 2]).buffer)].join(),
      views: cmp(new Uint8Array([1, 2, 3]).subarray(1), new Uint8Array([2, 3]).buffer),
      invalid: invalid.map((v) => thrown(() => cmp(v, 1))).join(),
      args: thrown(() => indexedDB.cmp(1)),
      same: thrown(() => { const a = []; cmp([a, a], [a, a]); }),
    };
  `);
  assert.deepStrictEqual(r.bad, []);
  assert.strictEqual(r.eq, '0,0,0,0');
  assert.strictEqual(r.views, 0);
  assert.strictEqual(r.invalid, Array(14).fill('DataError').join());
  assert.strictEqual(r.args, 'TypeError');
  assert.strictEqual(r.same, 'no error', 'the same array twice is not a cycle');
});

test('IndexedDB: IDBKeyRange', async () => {
  const r = await page(`
    const d = (r) => [r.lower, r.upper, r.lowerOpen, r.upperOpen].join();
    const k = IDBKeyRange;
    return {
      only: d(k.only(3)), lb: d(k.lowerBound(2)), lbo: d(k.lowerBound(2, true)), ub: d(k.upperBound('z')), ubo: d(k.upperBound('z', true)),
      bound: d(k.bound(1, 5)), boundo: d(k.bound(1, 5, true, false)),
      includes: [k.bound(1, 5).includes(1), k.bound(1, 5, true).includes(1), k.bound(1, 5).includes(5.1), k.lowerBound('a').includes('b'),
        k.lowerBound('a').includes(3), k.only([1, 2]).includes([1, 2]), k.upperBound(new Date(10)).includes(new Date(9))].join(),
      errors: [thrown(() => k.only({})), thrown(() => k.bound(5, 1)), thrown(() => k.bound(1, 1, true, false)), thrown(() => k.bound(1, 1, false, true)),
        thrown(() => k.bound(1)), thrown(() => k.lowerBound()), thrown(() => k.upperBound(NaN)), thrown(() => k.only(1).includes({})),
        thrown(() => k.bound(1, 1))].join(),
      types: [typeof k.only(1).lower, typeof k.lowerBound(1).upper, k.only(new Date(7)).lower instanceof Date, k.only([1]).lower instanceof Array].join(),
      tag: Object.prototype.toString.call(k.only(1)), instance: k.only(1) instanceof IDBKeyRange,
    };
  `);
  assert.strictEqual(r.only, '3,3,false,false');
  assert.strictEqual(r.lb, '2,,false,true');
  assert.strictEqual(r.lbo, '2,,true,true');
  assert.strictEqual(r.ub, ',z,true,false');
  assert.strictEqual(r.ubo, ',z,true,true');
  assert.strictEqual(r.bound, '1,5,false,false');
  assert.strictEqual(r.boundo, '1,5,true,false');
  assert.strictEqual(r.includes, 'true,false,false,true,false,true,true');
  assert.strictEqual(r.errors, 'DataError,DataError,DataError,DataError,TypeError,TypeError,DataError,DataError,no error');
  assert.strictEqual(r.types, 'number,undefined,true,true');
  assert.strictEqual(r.tag, '[object IDBKeyRange]');
  assert.strictEqual(r.instance, true);
});

test('IndexedDB: open, upgrade, put/get/delete/count/clear, structured clones', async () => {
  const r = await page(`
    const log = [];
    const req = indexedDB.open('db1');
    log.push('readyState:' + req.readyState, 'result:' + thrown(() => req.result), 'error:' + thrown(() => req.error), 'source:' + req.source, 'tx:' + req.transaction);
    req.onupgradeneeded = (ev) => {
      log.push('upgradeneeded:' + ev.oldVersion + '>' + ev.newVersion + ':' + (ev instanceof IDBVersionChangeEvent) + ':' + ev.target.readyState + ':' + ev.target.transaction.mode);
      const db = req.result;
      const s = db.createObjectStore('kv');
      log.push('store:' + s.name + ':' + s.keyPath + ':' + s.autoIncrement + ':' + (s.transaction === req.transaction) + ':' + s.indexNames.length);
    };
    const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    log.push('open:' + db.name + ':' + db.version + ':' + req.readyState + ':' + (req.transaction === null) + ':' + (db instanceof IDBDatabase));
    const tx = db.transaction('kv', 'readwrite');
    const s = tx.objectStore('kv');
    const original = { when: new Date(0), list: [1, 2, { deep: true }], m: new Map([[1, 'one']]), s: 'str', n: null, u: undefined, nested: { x: 1 } };
    const putKey = await rq(s.put(original, 'k1'));
    original.nested.x = 99; original.list.push('later');
    const got = await rq(s.get('k1'));
    const got2 = await rq(s.get('k1'));
    log.push('putKey:' + putKey,
      'clone:' + [got.when instanceof Date, got.when.getTime(), got.m instanceof Map, got.m.get(1), got.list.length, got.list[2].deep, got.nested.x, got.s, got.n, 'u' in got].join(),
      'fresh:' + (got !== got2 && got.nested !== got2.nested));
    await rq(s.put('two', 'k2')); await rq(s.put(3, 'k3')); await rq(s.add([4], 'k4'));
    log.push('count:' + await rq(s.count()), 'countRange:' + await rq(s.count(IDBKeyRange.bound('k2', 'k3'))), 'countKey:' + await rq(s.count('k2')));
    log.push('missing:' + await rq(s.get('nope')), 'getKey:' + await rq(s.getKey('k3')), 'getKeyMissing:' + await rq(s.getKey('zz')), 'getRange:' + await rq(s.get(IDBKeyRange.lowerBound('k2', true))));
    log.push('delete:' + await rq(s.delete('k2')), 'afterDelete:' + await rq(s.get('k2')), 'deleteRange:' + await rq(s.delete(IDBKeyRange.lowerBound('k3'))), 'count2:' + await rq(s.count()));
    log.push('clear:' + await rq(s.clear()), 'count3:' + await rq(s.count()));
    log.push('tx:' + await txDone(tx));
    db.close();
    return log;
  `);
  assert.deepStrictEqual(r, [
    'readyState:pending',
    'result:InvalidStateError', 'error:InvalidStateError', 'source:null', 'tx:null',
    'upgradeneeded:0>1:true:done:versionchange',
    'store:kv:null:false:true:0',
    'open:db1:1:done:true:true',
    'putKey:k1',
    'clone:true,0,true,one,3,true,1,str,,true',
    'fresh:true',
    'count:4', 'countRange:2', 'countKey:1',
    'missing:undefined', 'getKey:k3', 'getKeyMissing:undefined', 'getRange:3',
    'delete:undefined', 'afterDelete:undefined', 'deleteRange:undefined', 'count2:1',
    'clear:undefined', 'count3:0',
    'tx:complete',
  ]);
});

test('IndexedDB: data survives close/reopen, aborted changes do not', async () => {
  const r = await page(`
    let db = await openDb('persist', 1, (d) => { d.createObjectStore('s'); });
    let tx = db.transaction('s', 'readwrite');
    tx.objectStore('s').put('kept', 1);
    await txDone(tx);
    tx = db.transaction('s', 'readwrite');
    tx.objectStore('s').put('lost', 2);
    tx.objectStore('s').put('changed', 1);
    tx.abort();
    const abortErr = await errName(txDone(tx));
    db.close();
    db = await openDb('persist');
    const all = await rq(db.transaction('s').objectStore('s').getAll());
    const keys = await rq(db.transaction('s').objectStore('s').getAllKeys());
    const other = await openDb('persist-other', 1, (d) => { d.createObjectStore('s'); });
    const otherCount = await rq(other.transaction('s').objectStore('s').count());
    return { abortErr, all, keys, version: db.version, otherCount, dbs: (await indexedDB.databases()).map((x) => x.name + '@' + x.version).sort() };
  `);
  assert.deepStrictEqual(r, { abortErr: 'AbortError', all: ['kept'], keys: [1], version: 1, otherCount: 0, dbs: ['persist-other@1', 'persist@1'] });
});

test('IndexedDB: key generators, in-line keys and key paths', async () => {
  const r = await page(`
    const db = await openDb('keys', 1, (d) => {
      d.createObjectStore('gen', { autoIncrement: true });
      d.createObjectStore('inline', { keyPath: 'id' });
      d.createObjectStore('inlineGen', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('nested', { keyPath: 'a.b.c', autoIncrement: true });
      d.createObjectStore('multi', { keyPath: ['x', 'y'] });
      d.createObjectStore('len', { keyPath: 'list.length' });
      d.createObjectStore('self', { keyPath: '' });
      d.createObjectStore('plain');
    });
    const out = {};
    const tx = db.transaction(db.objectStoreNames, 'readwrite');
    const st = (n) => tx.objectStore(n);
    out.gen = [await rq(st('gen').add('a')), await rq(st('gen').add('b')), await rq(st('gen').put('c', 10)), await rq(st('gen').add('d')), await rq(st('gen').put('e', 'str')), await rq(st('gen').add('f')), await rq(st('gen').put('g', 3.7)), await rq(st('gen').add('h')), await rq(st('gen').put('i', -5)), await rq(st('gen').add('j'))];
    out.genDate = await rq(st('gen').put('date', new Date(5))); out.genArr = await rq(st('gen').put('arr', [1]));
    out.inline = await rq(st('inline').put({ id: 'x', v: 1 }));
    out.inlineObjKey = await rq(st('inline').put({ id: [1, 2] })); out.inlineDate = (await rq(st('inline').put({ id: new Date(9) }))).getTime();
    const ig = [];
    ig.push(await rq(st('inlineGen').add({ v: 'a' })), await rq(st('inlineGen').add({ id: 7, v: 'b' })), await rq(st('inlineGen').add({ v: 'c' })));
    out.ig = ig; out.igStored = await rq(st('inlineGen').getAll());
    out.nested = await rq(st('nested').add({ other: 1 })); out.nestedStored = await rq(st('nested').get(1));
    out.nested2 = await rq(st('nested').add({ a: { keep: true } })); out.nested2Stored = await rq(st('nested').get(2));
    out.multi = await rq(st('multi').put({ x: 1, y: 'k' })); out.multiGet = await rq(st('multi').get([1, 'k']));
    out.len = await rq(st('len').put({ list: [1, 2, 3] })); out.self = await rq(st('self').put('plain'));
    out.errors = {
      inlineKeyGiven: thrown(() => st('inline').put({ id: 1 }, 1)),
      outOfLineNoKey: thrown(() => st('plain').put(1)),
      noPath: thrown(() => st('inline').put({ other: 1 })),
      badKeyValue: thrown(() => st('inline').put({ id: {} })),
      badKey: thrown(() => st('gen').put(1, {})),
      cantInject: thrown(() => st('nested').add({ a: 1 })),
      multiMissing: thrown(() => st('multi').put({ x: 1 })),
      cloneFn: thrown(() => st('gen').put({ f() {} })),
      cloneSym: thrown(() => st('gen').put(Symbol('s'))),
      argsMissing: thrown(() => st('gen').put()),
      getNoArgs: thrown(() => st('gen').get()),
      deleteNull: thrown(() => st('gen').delete(null)),
      deleteNone: thrown(() => st('gen').delete()),
    };
    // the transaction is still usable after synchronous errors
    out.stillActive = await rq(st('gen').count());
    await txDone(tx);
    // limits of the generator
    const tx2 = db.transaction('gen', 'readwrite');
    const big = tx2.objectStore('gen');
    await rq(big.put('max', 2 ** 53));
    const r1 = big.add('over'); r1.onerror = (ev) => { ev.preventDefault(); };
    out.overflow = await new Promise((res) => { r1.onerror = (ev) => { ev.preventDefault(); res(r1.error.name); }; });
    await txDone(tx2);
    return out;
  `);
  assert.deepStrictEqual(r.gen, [1, 2, 10, 11, 'str', 12, 3.7, 13, -5, 14]);
  assert.strictEqual(r.genDate, '1970-01-01T00:00:00.005Z');
  assert.deepStrictEqual(r.genArr, [1]);
  assert.strictEqual(r.inline, 'x');
  assert.deepStrictEqual(r.inlineObjKey, [1, 2]);
  assert.strictEqual(r.inlineDate, 9);
  assert.deepStrictEqual(r.ig, [1, 7, 8]);
  assert.deepStrictEqual(r.igStored, [{ v: 'a', id: 1 }, { id: 7, v: 'b' }, { v: 'c', id: 8 }]);
  assert.strictEqual(r.nested, 1);
  assert.deepStrictEqual(r.nestedStored, { other: 1, a: { b: { c: 1 } } });
  assert.strictEqual(r.nested2, 2);
  assert.deepStrictEqual(r.nested2Stored, { a: { keep: true, b: { c: 2 } } });
  assert.deepStrictEqual(r.multi, [1, 'k']);
  assert.deepStrictEqual(r.multiGet, { x: 1, y: 'k' });
  assert.strictEqual(r.len, 3);
  assert.strictEqual(r.self, 'plain');
  assert.deepStrictEqual(r.errors, {
    inlineKeyGiven: 'DataError', outOfLineNoKey: 'DataError', noPath: 'DataError', badKeyValue: 'DataError', badKey: 'DataError',
    cantInject: 'DataError', multiMissing: 'DataError', cloneFn: 'DataCloneError', cloneSym: 'DataCloneError', argsMissing: 'TypeError',
    getNoArgs: 'TypeError', deleteNull: 'DataError', deleteNone: 'TypeError',
  });
  assert.strictEqual(r.stillActive, 12);
  assert.strictEqual(r.overflow, 'ConstraintError');
});

test('IndexedDB: a failed add keeps the key generator; add() on an existing key fails', async () => {
  const r = await page(`
    const db = await openDb('gen2', 1, (d, ev, tx) => {
      const s = d.createObjectStore('s', { keyPath: 'id', autoIncrement: true });
      s.createIndex('u', 'name', { unique: true });
    });
    const tx = db.transaction('s', 'readwrite');
    const s = tx.objectStore('s');
    const out = [];
    out.push(await rq(s.add({ name: 'a' })));
    const dup = s.add({ name: 'a' });
    out.push(await new Promise((res) => { dup.onerror = (ev) => { ev.preventDefault(); res(dup.error.name + ':' + (dup.result === undefined)); }; }));
    out.push(await rq(s.add({ name: 'b' })));
    const exists = s.add({ id: 1, name: 'zzz' });
    out.push(await new Promise((res) => { exists.onerror = (ev) => { ev.preventDefault(); res(exists.error.name); }; }));
    out.push(await rq(s.put({ id: 1, name: 'renamed' })));
    out.push(JSON.stringify(await rq(s.getAll())));
    await txDone(tx);
    return out;
  `);
  assert.deepStrictEqual(r, [1, 'ConstraintError:true', 2, 'ConstraintError', 1, '[{"id":1,"name":"renamed"},{"name":"b","id":2}]']);
});

test('IndexedDB: key path validation', async () => {
  const r = await page(`
    const db = await openDb('kp', 1, (d) => {
      const errs = {};
      const t = (name, fn) => { errs[name] = thrown(fn); };
      t('empty', () => d.createObjectStore('a', { keyPath: '' }));
      t('dotted', () => d.createObjectStore('b', { keyPath: 'a.b.c' }));
      t('dollar', () => d.createObjectStore('c', { keyPath: '$x._y1' }));
      t('unicode', () => d.createObjectStore('d', { keyPath: 'ünï' }));
      t('reserved', () => d.createObjectStore('e', { keyPath: 'class' }));
      t('digit', () => d.createObjectStore('f', { keyPath: '1a' }));
      t('space', () => d.createObjectStore('g', { keyPath: 'a b' }));
      t('emptyPart', () => d.createObjectStore('h', { keyPath: 'a..b' }));
      t('trailingDot', () => d.createObjectStore('i', { keyPath: 'a.' }));
      t('emptyArray', () => d.createObjectStore('j', { keyPath: [] }));
      t('array', () => d.createObjectStore('k', { keyPath: ['a', 'b.c'] }));
      t('badArray', () => d.createObjectStore('l', { keyPath: ['a', 'b c'] }));
      t('genEmpty', () => d.createObjectStore('m', { keyPath: '', autoIncrement: true }));
      t('genArray', () => d.createObjectStore('n', { keyPath: ['a'], autoIncrement: true }));
      t('dup', () => d.createObjectStore('b'));
      t('nullPath', () => d.createObjectStore('o', { keyPath: null }));
      t('undefPath', () => d.createObjectStore('p', { keyPath: undefined }));
      t('stringified', () => d.createObjectStore('q', { keyPath: { toString() { return 'abc'; } } }));
      t('noArgs', () => d.createObjectStore());
      const s = d.createObjectStore('r');
      t('idxEmptyArray', () => s.createIndex('i1', []));
      t('idxBad', () => s.createIndex('i2', 'a b'));
      t('idxMultiArray', () => s.createIndex('i3', ['a'], { multiEntry: true }));
      t('idxOk', () => s.createIndex('i4', ['a', 'b']));
      t('idxDup', () => s.createIndex('i4', 'a'));
      t('idxMissingArg', () => s.createIndex('i5'));
      window.errs = errs;
    });
    const tx = db.transaction(['k', 'q', 'o', 'p'], 'readonly');
    return { errs: window.errs, k: tx.objectStore('k').keyPath, q: tx.objectStore('q').keyPath, o: tx.objectStore('o').keyPath, p: tx.objectStore('p').keyPath,
      sameArray: tx.objectStore('k').keyPath === tx.objectStore('k').keyPath, names: Array.from(db.objectStoreNames) };
  `);
  assert.deepStrictEqual(r.errs, {
    empty: 'no error', dotted: 'no error', dollar: 'no error', unicode: 'no error', reserved: 'no error', digit: 'SyntaxError', space: 'SyntaxError',
    emptyPart: 'SyntaxError', trailingDot: 'SyntaxError', emptyArray: 'SyntaxError', array: 'no error', badArray: 'SyntaxError',
    genEmpty: 'InvalidAccessError', genArray: 'InvalidAccessError', dup: 'ConstraintError', nullPath: 'no error', undefPath: 'no error',
    stringified: 'no error', noArgs: 'TypeError', idxEmptyArray: 'SyntaxError', idxBad: 'SyntaxError', idxMultiArray: 'InvalidAccessError',
    idxOk: 'no error', idxDup: 'ConstraintError', idxMissingArg: 'TypeError',
  });
  assert.deepStrictEqual(r.k, ['a', 'b.c']);
  assert.strictEqual(r.q, 'abc');
  assert.strictEqual(r.o, null);
  assert.strictEqual(r.p, null);
  assert.strictEqual(r.sameArray, true);
});

test('IndexedDB: indexes (unique, multiEntry, array key paths, ordering) and their retrieval', async () => {
  const r = await page(`
    const db = await openDb('idx', 1, (d, ev, upTx) => {
      const s = d.createObjectStore('people', { keyPath: 'id' });
      s.put({ id: 1, name: 'bob', tags: ['a', 'b'], age: 30 });
      s.put({ id: 2, name: 'alice', tags: ['b'], age: 25 });
      // created after data: populated from the existing records
      s.createIndex('byName', 'name');
      s.createIndex('byAge', 'age');
      s.createIndex('byTag', 'tags', { multiEntry: true });
      s.createIndex('byPair', ['name', 'age']);
      s.createIndex('uniqName', 'name', { unique: true });
      s.createIndex('missing', 'nothere');
      window.upgradeIdx = [s.indexNames.length, Array.from(s.indexNames).join()];
    });
    const tx = db.transaction('people', 'readwrite');
    const s = tx.objectStore('people');
    const out = {};
    await rq(s.put({ id: 3, name: 'carol', tags: ['c', 'a', 'a', {}, 5], age: 30 }));
    await rq(s.put({ id: 4, name: 'dave', tags: 'z', age: 'old' }));
    await rq(s.put({ id: 5, tags: [] }));
    const i = (n) => s.index(n);
    out.names = await rq(i('byName').getAllKeys());
    out.nameVals = (await rq(i('byName').getAll())).map((x) => x.name);
    out.age = await rq(i('byAge').getAllKeys());
    out.tagA = await rq(i('byTag').getAllKeys('a'));
    out.tags = await rq(i('byTag').getAllKeys());
    out.tagKeys = [];
    await new Promise((res) => { const c = i('byTag').openKeyCursor(); c.onsuccess = () => { const k = c.result; if (!k) return res(); out.tagKeys.push(JSON.stringify(k.key) + '>' + k.primaryKey); k.continue(); }; });
    out.pair = await rq(i('byPair').getAllKeys(IDBKeyRange.bound(['a', 0], ['bob', 99])));
    out.get = (await rq(i('byName').get('alice'))).id;
    out.getKey = await rq(i('byName').getKey('bob'));
    out.getRange = await rq(i('byAge').getKey(IDBKeyRange.lowerBound(26)));
    out.count = [await rq(i('byName').count()), await rq(i('byTag').count('b')), await rq(i('byAge').count(30)), await rq(i('missing').count())];
    out.meta = ['byTag', 'uniqName', 'byPair'].map((n) => { const x = i(n); return [x.name, JSON.stringify(x.keyPath), x.unique, x.multiEntry, x.objectStore === s].join(); });
    out.sameHandle = i('byName') === i('byName');
    // unique violation: the request fails, the transaction aborts
    const dup = s.put({ id: 9, name: 'alice' });
    out.dup = await new Promise((res) => { dup.onerror = () => res(dup.error.name); });
    out.txErr = await errName(txDone(tx));
    // after the abort nothing of the transaction is visible
    const tx2 = db.transaction('people');
    out.after = await rq(tx2.objectStore('people').getAllKeys());
    out.upgradeIdx = window.upgradeIdx;
    return out;
  `);
  assert.deepStrictEqual(r.names, [2, 1, 3, 4]);
  assert.deepStrictEqual(r.nameVals, ['alice', 'bob', 'carol', 'dave']);
  assert.deepStrictEqual(r.age, [2, 1, 3, 4]);
  assert.deepStrictEqual(r.tagA, [1, 3]);
  assert.deepStrictEqual(r.tags, [3, 1, 3, 1, 2, 3, 4]);
  assert.deepStrictEqual(r.tagKeys, ['5>3', '"a">1', '"a">3', '"b">1', '"b">2', '"c">3', '"z">4']);
  assert.deepStrictEqual(r.pair, [2, 1]);
  assert.strictEqual(r.get, 2);
  assert.strictEqual(r.getKey, 1);
  assert.strictEqual(r.getRange, 1);
  assert.deepStrictEqual(r.count, [4, 2, 2, 0]);
  assert.deepStrictEqual(r.meta, ['byTag,"tags",false,true,true', 'uniqName,"name",true,false,true', 'byPair,["name","age"],false,false,true']);
  assert.strictEqual(r.sameHandle, true);
  assert.strictEqual(r.dup, 'ConstraintError');
  assert.strictEqual(r.txErr, 'ConstraintError');
  assert.deepStrictEqual(r.after, [1, 2]);
  assert.deepStrictEqual(r.upgradeIdx, [6, 'byAge,byName,byPair,byTag,missing,uniqName']);
});

test('IndexedDB: cursors on stores in all directions, ranges, advance/continue, key cursors', async () => {
  const r = await page(`
    const db = await openDb('cur', 1, (d) => {
      const s = d.createObjectStore('s');
      for (const k of [5, 1, 3, 2, 4, 'a', 'b']) s.put('v' + k, k);
    });
    const walk = (src, range, dir, step) => new Promise((res, rej) => {
      const out = [];
      const q = src.openCursor(range, dir);
      q.onsuccess = () => {
        const c = q.result;
        if (!c) return res(out);
        out.push(c.key + '=' + c.value);
        if (step) step(c); else c.continue();
      };
      q.onerror = () => rej(q.error);
    });
    const s = () => db.transaction('s').objectStore('s');
    const out = {};
    out.next = await walk(s(), null, 'next');
    out.prev = await walk(s(), undefined, 'prev');
    out.nextunique = await walk(s(), null, 'nextunique');
    out.prevunique = await walk(s(), null, 'prevunique');
    out.range = await walk(s(), IDBKeyRange.bound(2, 4), 'next');
    out.rangeOpen = await walk(s(), IDBKeyRange.bound(2, 4, true, true), 'prev');
    out.only = await walk(s(), 3, 'next');
    out.lower = await walk(s(), IDBKeyRange.lowerBound('a'), 'next');
    out.empty = await walk(s(), IDBKeyRange.bound(10, 20), 'next');
    out.advance = await walk(s(), null, 'next', (c) => c.advance(2));
    out.advancePrev = await walk(s(), null, 'prev', (c) => c.advance(3));
    out.continueKey = await walk(s(), null, 'next', (c) => c.continue(c.key === 1 ? 4 : undefined));
    out.continueKeyPrev = await walk(s(), null, 'prev', (c) => c.continue(c.key === 'b' ? 3 : undefined));
    const kc = s().openKeyCursor();
    out.keyCursor = await new Promise((res) => { const q = kc; const ks = []; q.onsuccess = () => { const c = q.result; if (!c) return res(ks); ks.push([c.key, c.primaryKey, 'value' in c, c instanceof IDBCursor, c instanceof IDBCursorWithValue, c.direction].join(':')); c.continue(); }; });
    const first = s().openCursor();
    out.cursorMeta = await new Promise((res) => { first.onsuccess = () => { const c = first.result; res([c instanceof IDBCursorWithValue, c.request === first, c.source instanceof IDBObjectStore, c.direction, c.key, c.primaryKey, first.readyState].join()); }; });
    // the same cursor object is reused for every step and result is null at the end
    out.reuse = await new Promise((res) => { const q = s().openCursor(); let first = null, same = true, n = 0; q.onsuccess = () => { const c = q.result; if (!c) return res([same, n, q.result, q.readyState].join()); if (first === null) first = c; same = same && c === first; n++; c.continue(); }; });
    // key/primaryKey after the end
    out.errors = {};
    const t = db.transaction('s', 'readwrite');
    const os = t.objectStore('s');
    await new Promise((res) => { const q = os.openCursor(); let once = false; q.onsuccess = () => {
      const c = q.result;
      if (once) { if (!c || c.key === 2) res(); return; }
      once = true;
      out.errors.zeroAdvance = thrown(() => c.advance(0));
      out.errors.negAdvance = thrown(() => c.advance(-1));
      out.errors.advanceNoArg = thrown(() => c.advance());
      out.errors.badContinue = thrown(() => c.continue({}));
      out.errors.backContinue = thrown(() => c.continue(1));
      out.errors.sameContinue = thrown(() => c.continue(c.key));
      out.errors.pk = thrown(() => c.continuePrimaryKey(1, 1));
      c.continue();
      out.errors.double = thrown(() => c.continue());
      out.errors.doubleAdvance = thrown(() => c.advance(1));
      out.errors.updateWhileMoving = thrown(() => c.update('x'));
      out.errors.deleteWhileMoving = thrown(() => c.delete());
    }; });
    out.errors.badDirection = thrown(() => os.openCursor(null, 'sideways'));
    out.errors.badRange = thrown(() => os.openCursor({}));
    out.errors.keyCursorUpdate = await new Promise((res) => { const q = os.openKeyCursor(); q.onsuccess = () => { res([thrown(() => q.result.update(1)), thrown(() => q.result.delete())].join()); }; });
    await txDone(t);
    out.inactive = await new Promise((res) => { const q = s().openCursor(); let c0; q.onsuccess = () => { c0 = q.result; res(); }; }).then(() => 'ok');
    return out;
  `);
  assert.deepStrictEqual(r.next, ['1=v1', '2=v2', '3=v3', '4=v4', '5=v5', 'a=va', 'b=vb']);
  assert.deepStrictEqual(r.prev, ['b=vb', 'a=va', '5=v5', '4=v4', '3=v3', '2=v2', '1=v1']);
  assert.deepStrictEqual(r.nextunique, r.next);
  assert.deepStrictEqual(r.prevunique, r.prev);
  assert.deepStrictEqual(r.range, ['2=v2', '3=v3', '4=v4']);
  assert.deepStrictEqual(r.rangeOpen, ['3=v3']);
  assert.deepStrictEqual(r.only, ['3=v3']);
  assert.deepStrictEqual(r.lower, ['a=va', 'b=vb']);
  assert.deepStrictEqual(r.empty, []);
  assert.deepStrictEqual(r.advance, ['1=v1', '3=v3', '5=v5', 'b=vb']);
  assert.deepStrictEqual(r.advancePrev, ['b=vb', '4=v4', '1=v1']);
  assert.deepStrictEqual(r.continueKey, ['1=v1', '4=v4', '5=v5', 'a=va', 'b=vb']);
  assert.deepStrictEqual(r.continueKeyPrev, ['b=vb', '3=v3', '2=v2', '1=v1']);
  assert.deepStrictEqual(r.keyCursor, ['1:1:false:true:false:next', '2:2:false:true:false:next', '3:3:false:true:false:next', '4:4:false:true:false:next', '5:5:false:true:false:next', 'a:a:false:true:false:next', 'b:b:false:true:false:next']);
  assert.strictEqual(r.cursorMeta, 'true,true,true,next,1,1,done');
  assert.strictEqual(r.reuse, 'true,7,,done');
  assert.deepStrictEqual(r.errors, {
    zeroAdvance: 'TypeError', negAdvance: 'TypeError', advanceNoArg: 'TypeError', badContinue: 'DataError', backContinue: 'DataError',
    sameContinue: 'DataError', pk: 'InvalidAccessError', double: 'InvalidStateError', doubleAdvance: 'InvalidStateError',
    updateWhileMoving: 'InvalidStateError', deleteWhileMoving: 'InvalidStateError', badDirection: 'TypeError', badRange: 'DataError',
    keyCursorUpdate: 'InvalidStateError,InvalidStateError',
  });
});

test('IndexedDB: index cursors: nextunique/prevunique, continuePrimaryKey, update/delete through cursors', async () => {
  const r = await page(`
    const db = await openDb('icur', 1, (d) => {
      const s = d.createObjectStore('s', { keyPath: 'id' });
      s.createIndex('g', 'g');
      [[1, 'b'], [2, 'a'], [3, 'b'], [4, 'a'], [5, 'c'], [6, 'b']].forEach(([id, g]) => s.put({ id, g }));
    });
    const walk = (src, range, dir, fmt) => new Promise((res) => {
      const out = [];
      const q = src.openCursor(range, dir);
      q.onsuccess = () => { const c = q.result; if (!c) return res(out); out.push(fmt(c)); c.continue(); };
    });
    const idx = () => db.transaction('s').objectStore('s').index('g');
    const f = (c) => c.key + c.primaryKey;
    const out = {};
    out.next = await walk(idx(), null, 'next', f);
    out.prev = await walk(idx(), null, 'prev', f);
    out.nextunique = await walk(idx(), null, 'nextunique', f);
    out.prevunique = await walk(idx(), null, 'prevunique', f);
    out.rangeB = await walk(idx(), 'b', 'prev', f);
    out.rangeAB = await walk(idx(), IDBKeyRange.bound('a', 'b'), 'next', (c) => f(c) + ':' + c.value.id);
    // continuePrimaryKey
    out.cpk = await new Promise((res) => { const seen = []; const q = idx().openCursor(); let jumped = false; q.onsuccess = () => { const c = q.result; if (!c) return res(seen); seen.push(f(c)); if (!jumped) { jumped = true; c.continuePrimaryKey('b', 3); } else c.continue(); }; });
    out.cpkPrev = await new Promise((res) => { const seen = []; const q = idx().openCursor(null, 'prev'); let jumped = false; q.onsuccess = () => { const c = q.result; if (!c) return res(seen); seen.push(f(c)); if (!jumped) { jumped = true; c.continuePrimaryKey('b', 3); } else c.continue(); }; });
    out.cpkErrors = await new Promise((res) => { const q = idx().openCursor(); q.onsuccess = () => { const c = q.result; res([thrown(() => c.continuePrimaryKey('a', 1)), thrown(() => c.continuePrimaryKey({}, 1)), thrown(() => c.continuePrimaryKey('a')), thrown(() => c.continuePrimaryKey('a', 5)), thrown(() => c.continuePrimaryKey('b', 1))].join()); }; });
    const nu = await new Promise((res) => { const q = idx().openCursor(null, 'nextunique'); q.onsuccess = () => res(thrown(() => q.result.continuePrimaryKey('b', 1))); });
    out.cpkUnique = nu;
    // update and delete through a cursor
    const tx = db.transaction('s', 'readwrite');
    const s = tx.objectStore('s');
    await new Promise((res) => { const q = s.index('g').openCursor('b'); q.onsuccess = () => {
      const c = q.result; if (!c) return res();
      if (c.primaryKey === 1) { const u = c.update({ id: 1, g: 'b', touched: true }); u.onsuccess = () => { out.updateResult = u.result; }; }
      if (c.primaryKey === 3) { const d = c.delete(); d.onsuccess = () => { out.deleteResult = d.result === undefined; }; }
      c.continue();
    }; });
    out.updateBadKey = await new Promise((res) => { const q = s.openCursor(); q.onsuccess = () => { res(thrown(() => q.result.update({ id: 99, g: 'x' }))); }; });
    out.updateNoPath = await new Promise((res) => { const q = s.openCursor(); q.onsuccess = () => { res(thrown(() => q.result.update({ g: 'x' }))); }; });
    out.all = await rq(s.getAll());
    // updating through a cursor can move the record in the index
    await new Promise((res) => { const q = s.index('g').openCursor('c'); q.onsuccess = () => { const c = q.result; if (!c) return res(); c.update({ id: 5, g: 'a' }); c.continue(); }; });
    out.moved = await rq(s.index('g').getAllKeys('a'));
    await txDone(tx);
    return out;
  `);
  assert.deepStrictEqual(r.next, ['a2', 'a4', 'b1', 'b3', 'b6', 'c5']);
  assert.deepStrictEqual(r.prev, ['c5', 'b6', 'b3', 'b1', 'a4', 'a2']);
  assert.deepStrictEqual(r.nextunique, ['a2', 'b1', 'c5']);
  assert.deepStrictEqual(r.prevunique, ['c5', 'b1', 'a2'], 'prevunique yields the first record of each key');
  assert.deepStrictEqual(r.rangeB, ['b6', 'b3', 'b1']);
  assert.deepStrictEqual(r.rangeAB, ['a2:2', 'a4:4', 'b1:1', 'b3:3', 'b6:6']);
  assert.deepStrictEqual(r.cpk, ['a2', 'b3', 'b6', 'c5']);
  assert.deepStrictEqual(r.cpkPrev, ['c5', 'b3', 'b1', 'a4', 'a2']);
  assert.strictEqual(r.cpkErrors, 'DataError,DataError,TypeError,no error,InvalidStateError');
  assert.strictEqual(r.cpkUnique, 'InvalidAccessError');
  assert.strictEqual(r.updateResult, 1);
  assert.strictEqual(r.deleteResult, true);
  assert.strictEqual(r.updateBadKey, 'DataError');
  assert.strictEqual(r.updateNoPath, 'DataError');
  assert.deepStrictEqual(r.all, [{ id: 1, g: 'b', touched: true }, { id: 2, g: 'a' }, { id: 4, g: 'a' }, { id: 5, g: 'c' }, { id: 6, g: 'b' }]);
  assert.deepStrictEqual(r.moved, [2, 4, 5]);
});

test('IndexedDB: getAll / getAllKeys / getAllRecords with counts, ranges and options', async () => {
  const r = await page(`
    const db = await openDb('all', 1, (d) => {
      const s = d.createObjectStore('s');
      for (let i = 1; i <= 6; i++) s.put({ n: i }, i);
      const i2 = d.createObjectStore('u', { keyPath: 'id' });
      i2.createIndex('g', 'g');
      [[1, 'x'], [2, 'y'], [3, 'x'], [4, 'y'], [5, 'x']].forEach(([id, g]) => i2.put({ id, g }));
    });
    const tx = db.transaction(['s', 'u']);
    const s = tx.objectStore('s'), g = tx.objectStore('u').index('g');
    const out = {};
    out.all = (await rq(s.getAll())).map((x) => x.n);
    out.count2 = (await rq(s.getAll(null, 2))).map((x) => x.n);
    out.range = (await rq(s.getAll(IDBKeyRange.bound(2, 5), 3))).map((x) => x.n);
    out.keys = await rq(s.getAllKeys(IDBKeyRange.lowerBound(4)));
    out.zero = (await rq(s.getAll(undefined, 0))).length;
    out.single = (await rq(s.getAll(3))).map((x) => x.n);
    out.opts = (await rq(s.getAll({ query: IDBKeyRange.lowerBound(2), count: 2 }))).map((x) => x.n);
    out.optsPrev = (await rq(s.getAll({ direction: 'prev', count: 2 }))).map((x) => x.n);
    out.optsKeysPrev = await rq(s.getAllKeys({ direction: 'prev' }));
    out.records = (await rq(s.getAllRecords({ count: 2, query: IDBKeyRange.lowerBound(5) }))).map((r) => [r.key, r.primaryKey, r.value.n, r.constructor.name].join());
    out.idxAll = (await rq(g.getAllKeys())).join();
    out.idxCount = (await rq(g.getAllKeys('x', 2))).join();
    out.idxUnique = (await rq(g.getAllKeys({ direction: 'nextunique' }))).join();
    out.idxPrevUnique = (await rq(g.getAllKeys({ direction: 'prevunique' }))).join();
    out.idxPrev = (await rq(g.getAll({ direction: 'prev' }))).map((x) => x.id).join();
    out.idxRecords = (await rq(g.getAllRecords({ query: 'y' }))).map((r) => [r.key, r.primaryKey, r.value.id].join(':')).join();
    out.errors = [thrown(() => s.getAll(null, -1)), thrown(() => s.getAll(null, 2 ** 32)), thrown(() => s.getAll({ direction: 'up' })), thrown(() => s.getAll([{}])), thrown(() => s.getAllRecords(3))].join();
    return out;
  `);
  assert.deepStrictEqual(r.all, [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(r.count2, [1, 2]);
  assert.deepStrictEqual(r.range, [2, 3, 4]);
  assert.deepStrictEqual(r.keys, [4, 5, 6]);
  assert.strictEqual(r.zero, 6);
  assert.deepStrictEqual(r.single, [3]);
  assert.deepStrictEqual(r.opts, [2, 3]);
  assert.deepStrictEqual(r.optsPrev, [6, 5]);
  assert.deepStrictEqual(r.optsKeysPrev, [6, 5, 4, 3, 2, 1]);
  assert.deepStrictEqual(r.records, ['5,5,5,IDBRecord', '6,6,6,IDBRecord']);
  assert.strictEqual(r.idxAll, '1,3,5,2,4');
  assert.strictEqual(r.idxCount, '1,3');
  assert.strictEqual(r.idxUnique, '1,2');
  assert.strictEqual(r.idxPrevUnique, '2,1');
  assert.strictEqual(r.idxPrev, '4,2,5,3,1');
  assert.strictEqual(r.idxRecords, 'y:2:2,y:4:4');
  assert.strictEqual(r.errors, 'TypeError,TypeError,TypeError,DataError,TypeError');
});

test('IndexedDB: transaction lifetime: auto-commit, inactive after the task, active in microtasks and handlers', async () => {
  const r = await page(`
    const db = await openDb('life', 1, (d) => { d.createObjectStore('s'); d.createObjectStore('t'); });
    const log = [];
    const out = {};
    // 1. an empty transaction completes on its own
    let tx = db.transaction('s');
    log.push('created:' + tx.mode + ':' + tx.durability + ':' + (tx.db === db) + ':' + tx.error + ':' + Array.from(tx.objectStoreNames));
    await txDone(tx);
    // 2. inactive once the creating task is over
    tx = db.transaction('s', 'readwrite');
    const early = tx.objectStore('s');
    const done = txDone(tx);
    await sleep(0);
    out.timer = thrown(() => early.put(1, 1));
    out.timerFinished = await done;
    // 3. still usable synchronously and across microtasks (promise continuations) of a request handler
    tx = db.transaction('s', 'readwrite');
    const s = tx.objectStore('s');
    await rq(s.put('a', 1));
    await Promise.resolve();
    await null;
    await rq(s.put('b', 2));
    out.chained = (await rq(s.getAll())).join();
    await txDone(tx);
    // 4. but not from a timer set by a handler
    tx = db.transaction('s', 'readwrite');
    const s4 = tx.objectStore('s');
    const r1 = s4.get(1);
    out.fromTimer = await new Promise((res) => { r1.onsuccess = () => setTimeout(() => res(thrown(() => s4.get(1))), 0); });
    // 5. event order for several requests in one transaction
    tx = db.transaction('s', 'readwrite');
    const s5 = tx.objectStore('s');
    tx.addEventListener('complete', () => log.push('complete'));
    const a = s5.put('x', 10); a.onsuccess = () => log.push('a:' + a.readyState);
    const b = s5.put('y', 11); b.onsuccess = () => { log.push('b'); const c = s5.get(10); c.onsuccess = () => log.push('c:' + c.result); };
    log.push('sync-end');
    await txDone(tx);
    out.log = log;
    // 6. no request placed after completing
    out.afterComplete = [thrown(() => tx.objectStore('s')), thrown(() => s5.get(1)), thrown(() => s5.index('x')), thrown(() => tx.abort()), thrown(() => tx.commit())].join();
    // 7. read-only transactions
    tx = db.transaction('s');
    out.readonly = [thrown(() => tx.objectStore('s').put(1, 1)), thrown(() => tx.objectStore('s').add(1, 1)), thrown(() => tx.objectStore('s').delete(1)), thrown(() => tx.objectStore('s').clear()),
      thrown(() => tx.objectStore('s').createIndex('i', 'x')), thrown(() => db.createObjectStore('z')), thrown(() => tx.objectStore('t'))].join();
    await txDone(tx);
    // 8. argument validation
    out.args = [thrown(() => db.transaction('nope')), thrown(() => db.transaction([])), thrown(() => db.transaction('s', 'bogus')), thrown(() => db.transaction('s', 'versionchange')),
      thrown(() => db.transaction('s', 'readonly', { durability: 'bogus' })), thrown(() => db.transaction()), thrown(() => db.transaction(['s', 's', 't'], 'readwrite')),
      db.transaction(['t', 's', 't']).objectStoreNames.length, Array.from(db.transaction(['t', 's']).objectStoreNames).join('|'), db.transaction(db.objectStoreNames).objectStoreNames.length,
      db.transaction('s', 'readonly', { durability: 'strict' }).durability, thrown(() => db.transaction('s').objectStore('t'))].join();
    return out;
  `);
  assert.strictEqual(r.timer, 'TransactionInactiveError');
  assert.strictEqual(r.timerFinished, 'complete');
  assert.strictEqual(r.chained, 'a,b');
  assert.strictEqual(r.fromTimer, 'TransactionInactiveError');
  assert.deepStrictEqual(r.log, ['created:readonly:default:true:null:s', 'sync-end', 'a:done', 'b', 'c:x', 'complete']);
  assert.strictEqual(r.afterComplete, 'InvalidStateError,TransactionInactiveError,InvalidStateError,InvalidStateError,InvalidStateError');
  assert.strictEqual(r.readonly, 'ReadOnlyError,ReadOnlyError,ReadOnlyError,ReadOnlyError,InvalidStateError,InvalidStateError,NotFoundError');
  assert.strictEqual(r.args, 'NotFoundError,InvalidAccessError,TypeError,TypeError,TypeError,TypeError,no error,2,s|t,2,strict,NotFoundError');
});

test('IndexedDB: abort(), error events (bubbling, preventDefault) and exceptions in handlers', async () => {
  const r = await page(`
    const db = await openDb('abort', 1, (d) => { d.createObjectStore('s'); });
    const out = {};
    const events = [];
    db.onabort = (e) => events.push('db.abort:' + e.target.constructor.name);
    db.onerror = (e) => events.push('db.error:' + e.target.constructor.name + ':' + e.bubbles + ':' + e.cancelable + ':' + e.eventPhase);
    // explicit abort: pending requests fail with AbortError, then abort event (bubbling to the db), changes reverted
    let tx = db.transaction('s', 'readwrite');
    let s = tx.objectStore('s');
    tx.onabort = () => events.push('tx.abort:' + tx.error);
    tx.oncomplete = () => events.push('complete?!');
    tx.onerror = () => events.push('tx.error');
    const p1 = s.put('kept?', 'k');
    p1.onerror = (e) => events.push('p1.error:' + p1.error.name + ':' + e.target.readyState);
    p1.onsuccess = () => events.push('p1.success?!');
    tx.abort();
    events.push('aborted-sync:' + thrown(() => s.put(1, 2)) + ':' + thrown(() => tx.abort()));
    await sleep(5);
    out.explicit = events.splice(0);
    out.afterAbort = await rq(db.transaction('s').objectStore('s').count());
    // an unhandled failing request aborts the transaction with the request's error
    tx = db.transaction('s', 'readwrite'); s = tx.objectStore('s');
    tx.onabort = () => events.push('tx.abort:' + tx.error.name);
    tx.onerror = (e) => events.push('tx.error:' + e.target.error.name + ':' + e.currentTarget.constructor.name);
    await rq(s.add('one', 1));
    const bad = s.add('dup', 1);
    bad.onerror = () => events.push('bad.error');
    const after = s.put('queued', 2);
    after.onerror = () => events.push('after.error:' + after.error.name);
    await sleep(5);
    out.unhandled = events.splice(0);
    out.txError = tx.error.name;
    out.unhandledData = await rq(db.transaction('s').objectStore('s').getAll());
    // preventDefault keeps the transaction alive
    tx = db.transaction('s', 'readwrite'); s = tx.objectStore('s');
    await rq(s.add('one', 1));
    const bad2 = s.add('dup', 1);
    bad2.onerror = (e) => { e.preventDefault(); events.push('prevented'); };
    await rq(s.put('two', 2));
    out.prevented = [(await txDone(tx)), events.splice(0).join(), tx.error];
    // a handler on the transaction or db can also prevent it, and stopPropagation stops bubbling
    tx = db.transaction('s', 'readwrite'); s = tx.objectStore('s');
    tx.onerror = (e) => { e.preventDefault(); events.push('tx-prevented'); e.stopPropagation(); };
    s.add('dup', 1);
    out.txPrevented = [await txDone(tx), events.splice(0).join()];
    // an exception in a success handler aborts with AbortError
    tx = db.transaction('s', 'readwrite'); s = tx.objectStore('s');
    const ok = s.put('boom', 5);
    ok.onsuccess = () => { throw new Error('handler failed'); };
    out.thrownSuccess = await errName(txDone(tx));
    out.thrownError = tx.error.name;
    // an exception in an error handler aborts too, even if the event was prevented
    tx = db.transaction('s', 'readwrite'); s = tx.objectStore('s');
    const bad3 = s.add('dup', 1);
    bad3.onerror = (e) => { e.preventDefault(); throw new Error('again'); };
    out.thrownInError = await errName(txDone(tx));
    out.thrownInErrorName = tx.error.name;
    return out;
  `);
  assert.deepStrictEqual(r.explicit, [
    'aborted-sync:TransactionInactiveError:InvalidStateError',
    'p1.error:AbortError:done', 'tx.error', 'db.error:IDBRequest:true:true:3', // the request's error bubbles: request, transaction, database
    'tx.abort:null', 'db.abort:IDBTransaction',
  ]);
  assert.strictEqual(r.afterAbort, 0);
  assert.deepStrictEqual(r.unhandled, [
    'bad.error', 'tx.error:ConstraintError:IDBTransaction', 'db.error:IDBRequest:true:true:3',
    'after.error:AbortError', 'tx.error:AbortError:IDBTransaction', 'db.error:IDBRequest:true:true:3',
    'tx.abort:ConstraintError', 'db.abort:IDBTransaction',
  ]);
  assert.strictEqual(r.txError, 'ConstraintError');
  assert.deepStrictEqual(r.prevented, ['complete', 'prevented,db.error:IDBRequest:true:true:3', null]);
  assert.deepStrictEqual(r.txPrevented, ['complete', 'tx-prevented']);
  assert.strictEqual(r.thrownSuccess, 'AbortError');
  assert.strictEqual(r.thrownError, 'AbortError');
  assert.strictEqual(r.thrownInError, 'AbortError');
  assert.deepStrictEqual(r.unhandledData, []);
});

test('IndexedDB: versions: versionchange, blocked, queueing of opens, VersionError, databases()', async () => {
  const r = await page(`
    const ev = [];
    const out = {};
    const db1 = await openDb('v', 1, (d) => { d.createObjectStore('s'); });
    db1.onversionchange = (e) => { ev.push('vc:' + e.oldVersion + '>' + e.newVersion + ':' + (e instanceof IDBVersionChangeEvent) + ':' + (e.target === db1)); db1.close(); };
    const db2 = await new Promise((res, rej) => {
      const r = indexedDB.open('v', 2);
      r.onblocked = () => ev.push('blocked?!');
      r.onupgradeneeded = (e) => ev.push('upgrade:' + e.oldVersion + '>' + e.newVersion + ':' + Array.from(r.result.objectStoreNames));
      r.onsuccess = () => { ev.push('success:' + r.result.version); res(r.result); };
      r.onerror = () => rej(r.error);
    });
    out.closedConnection = [thrown(() => db1.transaction('s')), db1.version, db1.name];
    out.closeInVersionChange = ev.splice(0);
    // no close: blocked fires, and the upgrade waits until the old connection closes
    db2.onversionchange = (e) => ev.push('vc2:' + e.oldVersion + '>' + e.newVersion);
    const db3 = await new Promise((res, rej) => {
      const r = indexedDB.open('v', 3);
      r.onblocked = (e) => { ev.push('blocked:' + e.oldVersion + '>' + e.newVersion + ':' + (e.target === r) + ':' + (e instanceof IDBVersionChangeEvent)); setTimeout(() => { ev.push('closing'); db2.close(); }, 5); };
      r.onupgradeneeded = (e) => ev.push('upgrade:' + e.oldVersion + '>' + e.newVersion);
      r.onsuccess = () => { ev.push('success:' + r.result.version); res(r.result); };
      r.onerror = () => rej(r.error);
    });
    out.blocked = ev.splice(0);
    // two opens queue up: the second sees the first's result and opens without upgrade
    const order = [];
    const ra = indexedDB.open('q', 5), rb = indexedDB.open('q', 5), rc = indexedDB.open('q', 4), rd = indexedDB.open('q');
    ra.onupgradeneeded = () => order.push('a:upgrade');
    ra.onsuccess = () => order.push('a:success:' + ra.result.version);
    rb.onupgradeneeded = () => order.push('b:upgrade?!');
    rb.onsuccess = () => order.push('b:success:' + rb.result.version);
    rc.onerror = (e) => { order.push('c:error:' + rc.error.name + ':' + rc.readyState + ':' + e.bubbles + ':' + e.cancelable); e.preventDefault(); };
    rd.onsuccess = () => order.push('d:success:' + rd.result.version);
    await sleep(10);
    out.queue = order;
    out.versionError = [thrown(() => rc.result), rc.result, rc.error.name].join();
    out.badVersions = [thrown(() => indexedDB.open('x', 0)), thrown(() => indexedDB.open('x', -1)), thrown(() => indexedDB.open('x', NaN)), thrown(() => indexedDB.open('x', 2 ** 53)), thrown(() => indexedDB.open()),
      thrown(() => indexedDB.deleteDatabase()), thrown(() => indexedDB.open('x', 1.9)), thrown(() => indexedDB.open('x', '2')), thrown(() => indexedDB.open('x', null))].join();
    await sleep(20);
    out.fractional = (await indexedDB.databases()).filter((x) => x.name === 'x').map((x) => x.name + '@' + x.version);
    out.dbs = (await indexedDB.databases()).map((x) => x.name + '@' + x.version).sort();
    // new default version is 1; existing version is kept when omitted
    out.defaults = [(await openDb('fresh')).version, (await openDb('q')).version];
    return out;
  `);
  assert.deepStrictEqual(r.closedConnection, ['InvalidStateError', 1, 'v']);
  assert.deepStrictEqual(r.closeInVersionChange, ['vc:1>2:true:true', 'upgrade:1>2:s', 'success:2']);
  assert.deepStrictEqual(r.blocked, ['vc2:2>3', 'blocked:2>3:true:true', 'closing', 'upgrade:2>3', 'success:3']);
  assert.deepStrictEqual(r.queue, ['a:upgrade', 'a:success:5', 'b:success:5', 'c:error:VersionError:done:true:true', 'd:success:5']);
  assert.strictEqual(r.versionError, 'no error,,VersionError');
  assert.strictEqual(r.badVersions, 'TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,no error,no error,TypeError');
  assert.deepStrictEqual(r.fractional, ['x@1'], 'a fractional version is truncated; the second open stays blocked by the first connection');
  assert.deepStrictEqual(r.defaults, [1, 5]);
});

test('IndexedDB: deleteDatabase: versionchange, blocked, success event, data gone', async () => {
  const r = await page(`
    const ev = [];
    const out = {};
    let db = await openDb('del', 3, (d) => { d.createObjectStore('s').put('x', 1); });
    // deleting a database that does not exist succeeds with oldVersion 0
    out.missing = await new Promise((res) => { const r = indexedDB.deleteDatabase('nothing'); r.onsuccess = (e) => res([e.type, e.oldVersion, e.newVersion, r.result, r.readyState, e instanceof IDBVersionChangeEvent, r instanceof IDBOpenDBRequest].join()); });
    db.onversionchange = (e) => { ev.push('vc:' + e.oldVersion + '>' + e.newVersion); };
    const r = indexedDB.deleteDatabase('del');
    r.onblocked = (e) => { ev.push('blocked:' + e.oldVersion + '>' + e.newVersion); setTimeout(() => { ev.push('close'); db.close(); }, 3); };
    r.onsuccess = (e) => ev.push('success:' + e.oldVersion + '>' + e.newVersion + ':' + r.result);
    r.onerror = () => ev.push('error?!');
    await sleep(20);
    out.events = ev.splice(0);
    out.dbs = (await indexedDB.databases()).length;
    // a new database of the same name starts from scratch
    let upgraded = null;
    db = await openDb('del', undefined, (d, e) => { upgraded = e.oldVersion; d.createObjectStore('s'); });
    const counting = db.transaction('s');
    const counted = await rq(counting.objectStore('s').count());
    await txDone(counting);
    out.fresh = [upgraded, db.version, counted];
    // closing in versionchange lets the delete proceed without blocked
    db.onversionchange = () => { ev.push('vc-close'); db.close(); };
    const r2 = indexedDB.deleteDatabase('del');
    r2.onblocked = () => ev.push('blocked?!');
    await new Promise((res) => { r2.onsuccess = () => { ev.push('deleted'); res(); }; });
    out.events2 = ev.splice(0);
    // an open queued behind a delete runs after it and creates a fresh database
    const rd = indexedDB.deleteDatabase('del');
    const ro = indexedDB.open('del');
    const order = [];
    rd.onsuccess = () => order.push('delete');
    ro.onupgradeneeded = () => order.push('upgrade');
    ro.onsuccess = () => { order.push('open'); };
    await sleep(10);
    out.order = order;
    return out;
  `);
  assert.strictEqual(r.missing, 'success,0,,,done,true,true');
  assert.deepStrictEqual(r.events, ['vc:3>null', 'blocked:3>null', 'close', 'success:3>null:undefined']);
  assert.strictEqual(r.dbs, 0);
  assert.deepStrictEqual(r.fresh, [0, 1, 0]);
  assert.deepStrictEqual(r.events2, ['vc-close', 'deleted']);
  assert.deepStrictEqual(r.order, ['delete', 'upgrade', 'open']);
});

test('IndexedDB: upgrade transactions: abort, exceptions, close(), restrictions, reverting stores and versions', async () => {
  const r = await page(`
    const out = {};
    const ev = [];
    // abort() in upgradeneeded of a new database: error event AbortError, no database left, request state
    let req = indexedDB.open('up1', 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore('s');
      s.put(1, 1);
      req.transaction.onabort = () => ev.push('tx.abort:' + req.transaction.error + ':' + req.readyState + ':' + req.result.constructor.name);
      req.transaction.abort();
      ev.push('sync:' + thrown(() => s.put(2, 2)) + ':' + thrown(() => req.result.createObjectStore('t')));
    };
    req.onsuccess = () => ev.push('success?!');
    await new Promise((res) => { req.onerror = (e) => { ev.push('error:' + req.error.name + ':' + req.readyState + ':' + req.result + ':' + req.transaction); e.preventDefault(); res(); }; });
    out.abortNew = ev.splice(0);
    out.afterAbortNew = (await indexedDB.databases()).length;
    // ...so the next open is an upgrade from version 0 again
    out.again = await new Promise((res) => { const r = indexedDB.open('up1', 1); r.onupgradeneeded = (e) => { res(e.oldVersion + '>' + e.newVersion); }; r.onsuccess = () => {}; });
    // abort of an upgrade of an existing database restores version and stores
    await sleep(5);
    let db = await openDb('up2', 1, (d) => { d.createObjectStore('keep').createIndex('i', 'x'); d.createObjectStore('drop'); });
    db.close();
    req = indexedDB.open('up2', 2);
    req.onupgradeneeded = () => {
      const d = req.result, tx = req.transaction;
      d.deleteObjectStore('drop');
      d.createObjectStore('added');
      tx.objectStore('keep').deleteIndex('i');
      tx.objectStore('keep').createIndex('j', 'y');
      tx.objectStore('keep').name = 'renamed';
      ev.push('inside:' + Array.from(d.objectStoreNames) + ':' + d.version + ':' + Array.from(tx.objectStoreNames));
      tx.abort();
      ev.push('after:' + Array.from(d.objectStoreNames) + ':' + d.version);
    };
    await new Promise((res) => { req.onerror = (e) => { e.preventDefault(); ev.push('error:' + req.error.name); res(); }; });
    out.abortExisting = ev.splice(0);
    db = await openDb('up2');
    const t = db.transaction(['keep', 'drop']);
    out.restored = [db.version, Array.from(db.objectStoreNames).join(), Array.from(t.objectStore('keep').indexNames).join(), t.objectStore('keep').name];
    db.close();
    // exception in upgradeneeded aborts with AbortError
    req = indexedDB.open('up3', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('s'); req.transaction.onabort = () => ev.push('tx.abort:' + req.transaction.error.name); throw new Error('upgrade failed'); };
    await new Promise((res) => { req.onerror = (e) => { e.preventDefault(); ev.push('error:' + req.error.name); res(); }; });
    out.thrown = ev.splice(0);
    // close() inside upgradeneeded: the transaction completes, the open fails with AbortError
    req = indexedDB.open('up4', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('s'); req.transaction.oncomplete = () => ev.push('tx.complete'); req.result.close(); };
    req.onsuccess = () => ev.push('success?!');
    await new Promise((res) => { req.onerror = (e) => { e.preventDefault(); ev.push('error:' + req.error.name); res(); }; });
    out.closed = ev.splice(0);
    // restrictions
    out.restrictions = await new Promise((res) => {
      const r = indexedDB.open('up5', 1);
      let d, s;
      r.onupgradeneeded = () => {
        d = r.result; s = d.createObjectStore('s');
        r.transaction.oncomplete = () => {
          res([thrown(() => d.transaction('s')), thrown(() => d.createObjectStore('t')), thrown(() => d.deleteObjectStore('s')), thrown(() => s.createIndex('i', 'x')), thrown(() => s.deleteIndex('i')),
            thrown(() => { s.name = 'z'; })].join());
        };
        out.duringUpgrade = [thrown(() => d.transaction('s')), thrown(() => d.deleteObjectStore('nope')), thrown(() => d.createObjectStore('s')), thrown(() => s.deleteIndex('nope')), thrown(() => s.index('nope'))].join();
      };
      r.onsuccess = () => {};
    });
    out.sameAfterUpgrade = await new Promise((res) => { const r = indexedDB.open('up5'); r.onsuccess = () => res([thrown(() => r.result.createObjectStore('s2')), r.transaction].join()); });
    // createObjectStore from a timer inside the upgrade handler: the transaction is inactive
    out.inactive = await new Promise((res) => {
      const r = indexedDB.open('up6', 1);
      r.onupgradeneeded = () => { const d = r.result; setTimeout(() => res(thrown(() => d.createObjectStore('late'))), 0); };
      r.onsuccess = () => {};
    });
    return out;
  `);
  assert.deepStrictEqual(r.abortNew, [
    'sync:InvalidStateError:TransactionInactiveError', // the store created by the aborted transaction counts as deleted
    'tx.abort:null:done:IDBDatabase', 'error:AbortError:done:undefined:null',
  ]);
  assert.strictEqual(r.afterAbortNew, 0, 'the database that the aborted upgrade would have created does not exist');
  assert.strictEqual(r.again, '0>1');
  assert.deepStrictEqual(r.abortExisting, ['inside:added,renamed:2:added,renamed', 'after:drop,keep:1', 'error:AbortError']);
  assert.deepStrictEqual(r.restored, [1, 'drop,keep', 'i', 'keep']);
  assert.deepStrictEqual(r.thrown, ['tx.abort:AbortError', 'error:AbortError']);
  assert.deepStrictEqual(r.closed, ['tx.complete', 'error:AbortError']);
  assert.strictEqual(r.duringUpgrade, 'InvalidStateError,NotFoundError,ConstraintError,NotFoundError,NotFoundError');
  assert.strictEqual(r.restrictions, 'no error,InvalidStateError,InvalidStateError,TransactionInactiveError,TransactionInactiveError,TransactionInactiveError');
  assert.strictEqual(r.sameAfterUpgrade, 'InvalidStateError,');
  assert.strictEqual(r.inactive, 'TransactionInactiveError');
});

test('IndexedDB: transaction scheduling: read/write exclusion by scope, concurrent readers, commit()', async () => {
  const r = await page(`
    const db = await openDb('sched', 1, (d) => { d.createObjectStore('a'); d.createObjectStore('b'); });
    const log = [];
    const out = {};
    // a writer created first: later transactions on the same store see its changes and wait for its completion
    const w = db.transaction('a', 'readwrite');
    const r1 = db.transaction('a', 'readonly');
    const r2 = db.transaction('a', 'readonly');
    const w2 = db.transaction('a', 'readwrite');
    const other = db.transaction('b', 'readwrite');
    for (const [n, t] of [['w', w], ['r1', r1], ['r2', r2], ['w2', w2], ['other', other]]) t.addEventListener('complete', () => log.push('complete:' + n));
    const wput = w.objectStore('a').put('written', 1);
    wput.onsuccess = () => log.push('w.put');
    const g1 = r1.objectStore('a').get(1); g1.onsuccess = () => log.push('r1.get:' + g1.result);
    const g2 = r2.objectStore('a').get(1); g2.onsuccess = () => log.push('r2.get:' + g2.result);
    const w2get = w2.objectStore('a').get(1); w2get.onsuccess = () => { log.push('w2.get:' + w2get.result); w2.objectStore('a').put('second', 1); };
    const og = other.objectStore('b').put('b', 1); og.onsuccess = () => log.push('other.put');
    await Promise.all([w, r1, r2, w2, other].map(txDone));
    out.log = log;
    out.final = await rq(db.transaction('a').objectStore('a').get(1));
    // readers created before a writer do not see its changes, and block it
    const l = [];
    const rd = db.transaction('a'); const wr = db.transaction('a', 'readwrite');
    const rdGet = rd.objectStore('a').get(1);
    wr.objectStore('a').put('newer', 1).onsuccess = () => l.push('write');
    rdGet.onsuccess = () => { l.push('read:' + rdGet.result); };
    await txDone(wr);
    out.reader = l;
    // commit(): pending requests finish, no new ones are accepted, then complete
    const tx = db.transaction('a', 'readwrite');
    const s = tx.objectStore('a');
    const evs = [];
    tx.addEventListener('complete', () => evs.push('complete'));
    const p = s.put('c', 5); p.onsuccess = () => evs.push('put:' + (s === tx.objectStore('a')));
    tx.commit();
    evs.push('after-commit:' + thrown(() => s.put('x', 6)) + ':' + thrown(() => tx.commit()) + ':' + thrown(() => tx.abort()));
    await sleep(5);
    out.commit = evs;
    out.committed = await rq(db.transaction('a').objectStore('a').get(5));
    // a failing request in a committing transaction aborts it whatever the handlers do
    const tx2 = db.transaction('a', 'readwrite');
    const s2 = tx2.objectStore('a');
    const evs2 = [];
    tx2.onabort = () => evs2.push('abort:' + tx2.error.name);
    tx2.oncomplete = () => evs2.push('complete?!');
    s2.put('ok', 7);
    const bad = s2.add('dup', 5);
    bad.onerror = (e) => { evs2.push('error:' + bad.error.name); e.preventDefault(); };
    tx2.commit();
    await sleep(5);
    out.commitFail = evs2;
    out.notWritten = await rq(db.transaction('a').objectStore('a').get(7));
    return out;
  `);
  // The writer runs first and finishes before the readers start; the readers run together; the second writer
  // waits for both; the transaction on the other store is independent.
  const at = (x) => r.log.indexOf(x);
  const order = ['w.put', 'complete:w', 'r1.get:written', 'complete:r1', 'w2.get:written', 'complete:w2'];
  assert.ok(order.every((x, k) => at(x) >= 0 && (k === 0 || at(order[k - 1]) < at(x))), r.log.join());
  assert.ok(at('complete:w') < at('r2.get:written') && at('r2.get:written') < at('complete:r2') && at('complete:r1') < at('w2.get:written') && at('complete:r2') < at('w2.get:written'), r.log.join());
  assert.ok(at('other.put') >= 0 && at('complete:other') > at('other.put'));
  assert.strictEqual(r.final, 'second');
  assert.deepStrictEqual(r.reader, ['read:second', 'write']);
  assert.deepStrictEqual(r.commit, ['after-commit:TransactionInactiveError:InvalidStateError:InvalidStateError', 'put:true', 'complete']);
  assert.strictEqual(r.committed, 'c');
  assert.deepStrictEqual(r.commitFail, ['error:AbortError', 'abort:ConstraintError'], 'the failed request is aborted with the rest; preventDefault cannot save a committing transaction');
  assert.strictEqual(r.notWritten, undefined);
});

test('IndexedDB: renaming and deleting stores and indexes, sorted name lists', async () => {
  const r = await page(`
    const out = {};
    const db = await openDb('names', 1, (d, ev, tx) => {
      const z = d.createObjectStore('z'); const a = d.createObjectStore('a'); const m = d.createObjectStore('B');
      z.createIndex('y', 'y'); z.createIndex('c', 'c'); z.createIndex('X', 'x');
      out.sorted = [Array.from(d.objectStoreNames).join(), Array.from(tx.objectStoreNames).join(), Array.from(z.indexNames).join(), d.objectStoreNames instanceof DOMStringList, d.objectStoreNames.length,
        d.objectStoreNames.contains('a'), d.objectStoreNames.contains('nope'), d.objectStoreNames.item(0), d.objectStoreNames.item(9), d.objectStoreNames[1]];
      a.put('kept', 1);
      // rename
      a.name = 'a2';
      z.index('c').name = 'c2';
      out.renamed = [a.name, Array.from(d.objectStoreNames).join(), thrown(() => tx.objectStore('a')), tx.objectStore('a2') === a, Array.from(z.indexNames).join(), z.index('c2').name, thrown(() => z.index('c'))];
      out.renameErrors = [thrown(() => { a.name = 'z'; }), thrown(() => { a.name = 'a2'; }), thrown(() => { z.index('c2').name = 'y'; })].join();
      // delete
      d.deleteObjectStore('B');
      out.deleted = [Array.from(d.objectStoreNames).join(), thrown(() => m.put(1, 1)), thrown(() => m.get(1)), thrown(() => m.index('i')), thrown(() => m.createIndex('i', 'x')), Array.from(m.indexNames).length, thrown(() => tx.objectStore('B'))].join();
      z.deleteIndex('X');
      out.idxDeleted = [Array.from(z.indexNames).join(), thrown(() => z.index('X'))];
      const ix = z.index('y');
      z.deleteIndex('y');
      out.idxHandle = [thrown(() => ix.get(1)), thrown(() => ix.count()), thrown(() => ix.openCursor())].join();
    });
    const tx = db.transaction('a2');
    out.after = [Array.from(db.objectStoreNames).join(), await rq(tx.objectStore('a2').get(1)), tx.objectStore('a2').name, thrown(() => db.transaction('a'))];
    // handle names stay after the transaction finished, and an object store handle is per transaction
    const t1 = db.transaction('a2'), t2 = db.transaction('a2');
    out.handles = [t1.objectStore('a2') === t1.objectStore('a2'), t1.objectStore('a2') === t2.objectStore('a2'), t1.objectStore('a2').transaction === t1].join();
    return out;
  `);
  assert.deepStrictEqual(r.sorted, ['B,a,z', 'B,a,z', 'X,c,y', true, 3, true, false, 'B', null, 'a']);
  assert.deepStrictEqual(r.renamed, ['a2', 'B,a2,z', 'NotFoundError', true, 'X,c2,y', 'c2', 'NotFoundError']);
  assert.strictEqual(r.renameErrors, 'ConstraintError,no error,ConstraintError');
  assert.strictEqual(r.deleted, 'a2,z,InvalidStateError,InvalidStateError,InvalidStateError,InvalidStateError,0,NotFoundError');
  assert.deepStrictEqual(r.idxDeleted, ['c2,y', 'NotFoundError']);
  assert.strictEqual(r.idxHandle, 'InvalidStateError,InvalidStateError,InvalidStateError');
  assert.deepStrictEqual(r.after, ['a2,z', 'kept', 'a2', 'NotFoundError']);
  assert.strictEqual(r.handles, 'true,false,true');
});

test('IndexedDB: values: structured clone details, typed arrays, blobs, getters, undefined', async () => {
  const r = await page(`
    const db = await openDb('vals', 1, (d) => { d.createObjectStore('s'); d.createObjectStore('k', { keyPath: 'id' }); });
    const out = {};
    const tx = db.transaction(['s', 'k'], 'readwrite');
    const s = tx.objectStore('s');
    const cyc = { name: 'cyc' }; cyc.self = cyc;
    await rq(s.put(cyc, 'cyc'));
    const c = await rq(s.get('cyc'));
    out.cyclic = c.self === c && c.name;
    await rq(s.put(new Uint8Array([1, 2, 3]), 'u8'));
    await rq(s.put(new Uint8Array([7, 8, 9]).buffer, 'ab'));
    await rq(s.put(new Float64Array([1.5, 2.5]), 'f64'));
    await rq(s.put(undefined, 'undef'));
    await rq(s.put(null, 'null'));
    await rq(s.put(new Set([1, 2]), 'set'));
    await rq(s.put(/re/gi, 're'));
    await rq(s.put(new Error('oops'), 'err'));
    await rq(s.put([1, , 3], 'sparse'));
    out.u8 = Array.from(await rq(s.get('u8'))).join() + ':' + Object.prototype.toString.call(await rq(s.get('u8')));
    out.ab = Array.from(new Uint8Array(await rq(s.get('ab')))).join();
    out.f64 = Array.from(await rq(s.get('f64'))).join();
    out.undef = [await rq(s.get('undef')), await rq(s.count('undef')), (await rq(s.getAllKeys())).includes('undef')].join();
    out.nul = await rq(s.get('null'));
    out.set = Array.from(await rq(s.get('set'))).join();
    out.re = String(await rq(s.get('re')));
    out.err = (await rq(s.get('err'))).message;
    out.sparse = JSON.stringify(await rq(s.get('sparse')));
    // getters run during the clone, with the transaction inactive
    let getterResult;
    const withGetter = { get x() { getterResult = thrown(() => s.put(1, 'inner')); return 7; } };
    await rq(s.put(withGetter, 'getter'));
    out.getter = [getterResult, JSON.stringify(await rq(s.get('getter')))];
    // a throwing getter fails put() with what it threw, and leaves the transaction active
    out.throwing = [thrown(() => s.put({ get bad() { throw new RangeError('nope'); } }, 'bad')), await rq(s.count())].join();
    // keys taken from values
    await rq(tx.objectStore('k').put({ id: new Date(3) }));
    await rq(tx.objectStore('k').put({ id: new Uint8Array([1, 2]) }));
    await rq(tx.objectStore('k').put({ id: 'str' }));
    await rq(tx.objectStore('k').put({ id: 5 }));
    await rq(tx.objectStore('k').put({ id: ['a', 1] }));
    out.keyOrder = (await rq(tx.objectStore('k').getAllKeys())).map((k) => Object.prototype.toString.call(k).slice(8, -1)).join();
    out.blobLike = await rq(tx.objectStore('k').put({ id: 'blob', size: new Blob(['abc']).size }));
    await txDone(tx);
    return out;
  `);
  assert.strictEqual(r.cyclic, 'cyc');
  assert.strictEqual(r.u8, '1,2,3:[object Uint8Array]');
  assert.strictEqual(r.ab, '7,8,9');
  assert.strictEqual(r.f64, '1.5,2.5');
  assert.strictEqual(r.undef, ',1,true', 'undefined is a storable value');
  assert.strictEqual(r.nul, null);
  assert.strictEqual(r.set, '1,2');
  assert.strictEqual(r.re, '/re/gi');
  assert.strictEqual(r.err, 'oops');
  assert.strictEqual(r.sparse, '[1,null,3]');
  assert.deepStrictEqual(r.getter, ['TransactionInactiveError', '{"x":7}']);
  assert.strictEqual(r.throwing, 'RangeError,11');
  assert.strictEqual(r.keyOrder, 'Number,Date,String,ArrayBuffer,Array');
  assert.strictEqual(r.blobLike, 'blob');
});

test('IndexedDB: idb-keyval (as bundled by bsky.app) and idb-style promise wrappers', async () => {
  const r = await page(`
    // idb-keyval, verbatim from the bsky.app bundle
    function t(t){return new Promise((n,u)=>{t.oncomplete=t.onsuccess=()=>n(t.result),t.onabort=t.onerror=()=>u(t.error)})}
    function createStore(n,u){let o;const c=()=>{if(o)return o;const c=indexedDB.open(n);return c.onupgradeneeded=()=>c.result.createObjectStore(u),o=t(c),o.then(t=>{t.onclose=()=>o=void 0},()=>{}),o};return(t,n)=>c().then(o=>n(o.transaction(u,t).objectStore(u)))}
    const store = createStore('react-query-cache', 'react-query-cache');
    const set = (k, v) => store('readwrite', (s) => (s.put(v, k), t(s.transaction)));
    const get = (k) => store('readonly', (s) => t(s.get(k)));
    const del = (k) => store('readwrite', (s) => (s.delete(k), t(s.transaction)));
    const keys = () => store('readonly', (s) => t(s.getAllKeys()));
    const out = {};
    await set('REACT_QUERY_OFFLINE_CACHE', JSON.stringify({ timestamp: 1, clientState: { a: 1 } }));
    await set('other', { n: 1 });
    out.get = JSON.parse(await get('REACT_QUERY_OFFLINE_CACHE')).clientState;
    out.keys = await keys();
    await del('REACT_QUERY_OFFLINE_CACHE');
    out.afterDelete = await get('REACT_QUERY_OFFLINE_CACHE');
    // parallel calls share the one connection and their transactions queue up
    await Promise.all([set('p1', 1), set('p2', 2), set('p3', 3), get('p1')]);
    out.parallel = await keys();
    // idb: instanceof checks on the interface objects, and wrapping requests in promises
    const proxyable = [IDBDatabase, IDBObjectStore, IDBIndex, IDBCursor, IDBTransaction];
    const advance = [IDBCursor.prototype.advance, IDBCursor.prototype.continue, IDBCursor.prototype.continuePrimaryKey];
    const promisify = (rq) => new Promise((res, rej) => { rq.addEventListener('success', () => res(rq.result)); rq.addEventListener('error', () => rej(rq.error)); });
    const openReq = indexedDB.open('WebAppRealtimeSignalDB', 1);
    openReq.addEventListener('upgradeneeded', () => { openReq.result.createObjectStore('userSignalData', { keyPath: 'key' }).createIndex('byTime', 'lastAccessed'); });
    const db = await promisify(openReq);
    const tx = db.transaction('userSignalData', 'readwrite');
    const st = tx.objectStore('userSignalData');
    await promisify(st.put({ key: 'u1', lastAccessed: 2 })); await promisify(st.put({ key: 'u2', lastAccessed: 1 }));
    const ix = st.index('byTime');
    const byIdx = await promisify(ix.getAll());
    const walked = [];
    await new Promise((res, rej) => { const c = st.openCursor(null, 'prev'); c.onsuccess = () => { const cur = c.result; if (!cur) return res(); walked.push(cur.key); cur.continue(); }; c.onerror = () => rej(c.error); });
    await new Promise((res) => { tx.addEventListener('complete', res); });
    out.idb = {
      txIsTransaction: tx instanceof IDBTransaction, reqIsRequest: openReq instanceof IDBRequest, proxyable: proxyable.length, advance: advance.every((f) => typeof f === 'function'),
      indexOrder: byIdx.map((x) => x.key), cursorPrev: walked, count: await promisify(db.transaction('userSignalData').objectStore('userSignalData').count()),
      unwrap: [st instanceof IDBObjectStore, ix instanceof IDBIndex, db instanceof IDBDatabase].join(),
    };
    db.close();
    // a raw wrapper in the style of xham.live / Convert: open in a Promise, get/set records
    const raw = await new Promise((res, rej) => {
      const q = indexedDB.open('convert', 1);
      q.onupgradeneeded = () => { q.result.createObjectStore('bucketing'); };
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    const w = raw.transaction('bucketing', 'readwrite').objectStore('bucketing');
    w.put({ variation: 'v1' }, 'exp1');
    out.raw = await new Promise((res) => { const g = raw.transaction('bucketing').objectStore('bucketing').get('exp1'); g.onsuccess = () => res(g.result); });
    return out;
  `);
  assert.deepStrictEqual(r.get, { a: 1 });
  assert.deepStrictEqual(r.keys, ['REACT_QUERY_OFFLINE_CACHE', 'other']);
  assert.strictEqual(r.afterDelete, undefined);
  assert.deepStrictEqual(r.parallel, ['other', 'p1', 'p2', 'p3']);
  assert.deepStrictEqual(r.idb, {
    txIsTransaction: true, reqIsRequest: true, proxyable: 5, advance: true, indexOrder: ['u2', 'u1'], cursorPrev: ['u2', 'u1'], count: 2, unwrap: 'true,true,true',
  });
  assert.deepStrictEqual(r.raw, { variation: 'v1' });
});

test('IndexedDB: available in dedicated workers, on the same databases as the page', async () => {
  const e = await createEnv({
    routes: {
      'https://example.com/w.js': { body: `
        const open = (name, version, upgrade) => new Promise((res, rej) => { const r = indexedDB.open(name, version); r.onupgradeneeded = () => upgrade(r.result); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        onmessage = async (ev) => {
          const db = await open('shared', 1, (d) => d.createObjectStore('s'));
          const tx = db.transaction('s', 'readwrite');
          tx.objectStore('s').put({ from: 'worker', when: new Date(7) }, 'w');
          await new Promise((res) => { tx.oncomplete = res; });
          const seen = await new Promise((res) => { const g = db.transaction('s').objectStore('s').get('page'); g.onsuccess = () => res(g.result); });
          postMessage({ type: typeof indexedDB, inSelf: 'indexedDB' in self, range: typeof IDBKeyRange, cursor: typeof IDBCursor, factory: indexedDB instanceof IDBFactory,
            cmp: indexedDB.cmp(1, 2), range2: IDBKeyRange.bound(1, 3).includes(2), seen });
        };` },
    },
  });
  e.run(PRELUDE);
  const r = await page(`
    const db = await openDb('shared', 1, (d) => { d.createObjectStore('s').put('written-by-page', 'page'); });
    const w = new Worker('/w.js');
    const msg = await new Promise((res, rej) => { w.onmessage = (ev) => res(ev.data); w.onerror = (ev) => rej(new Error(ev.message)); w.postMessage('go'); });
    const fromWorker = await rq(db.transaction('s').objectStore('s').get('w'));
    return { msg, fromWorker: [fromWorker.from, fromWorker.when.getTime()] };
  `, e);
  assert.deepStrictEqual(r.msg, { type: 'object', inSelf: true, range: 'function', cursor: 'function', factory: true, cmp: -1, range2: true, seen: 'written-by-page' });
  assert.deepStrictEqual(r.fromWorker, ['worker', 7]);
});

test('IndexedDB: event dispatch details (capture, targets, phases, trusted, handlers)', async () => {
  const r = await page(`
    const db = await openDb('evt', 1, (d) => { d.createObjectStore('s'); });
    const out = {};
    const log = [];
    const tx = db.transaction('s', 'readwrite');
    const s = tx.objectStore('s');
    const note = (who) => (e) => log.push(who + ':' + e.type + ':' + e.target.constructor.name + ':' + e.currentTarget.constructor.name + ':' + e.eventPhase + ':' + e.isTrusted + ':' + e.bubbles);
    db.addEventListener('success', note('db-capture'), true);
    tx.addEventListener('success', note('tx-capture'), true);
    tx.addEventListener('success', note('tx-bubble'));
    const req = s.put(1, 1);
    req.addEventListener('success', note('req'));
    req.onsuccess = note('onsuccess');
    const dup = s.add(2, 1);
    dup.addEventListener('error', note('dup'));
    tx.addEventListener('error', (e) => { log.push('tx-error-bubble:' + e.eventPhase + ':' + (e.composedPath().map((x) => x.constructor.name).join('>'))); e.preventDefault(); });
    tx.addEventListener('complete', note('complete'));
    db.addEventListener('complete', note('db-complete?!'));
    await txDone(tx);
    out.log = log.slice();
    // handler properties reflect what was set; null clears
    const r2 = db.transaction('s').objectStore('s').get(1);
    const f = () => {};
    r2.onsuccess = f; r2.onerror = f;
    out.handlers = [r2.onsuccess === f, r2.onerror === f, String((r2.onsuccess = null, r2.onsuccess)), typeof db.onversionchange, String(db.onabort), IDBOpenDBRequest.prototype.hasOwnProperty('onblocked'), 'onupgradeneeded' in indexedDB.open('evt2')].join();
    // events are IDB events with the right constructors
    out.ctor = await new Promise((res) => { const r = db.transaction('s').objectStore('s').get(1); r.onsuccess = (e) => res([e.constructor.name, e.cancelable, typeof e.timeStamp].join()); });
    // dispatching an event by hand at a request works and does not touch the transaction
    const r3 = db.transaction('s').objectStore('s').count();
    out.manual = await new Promise((res) => { r3.addEventListener('custom', (e) => res(e.type + ':' + e.target.readyState)); r3.dispatchEvent(new Event('custom')); });
    return out;
  `);
  assert.deepStrictEqual(r.log, [
    'db-capture:success:IDBRequest:IDBDatabase:1:true:false',
    'tx-capture:success:IDBRequest:IDBTransaction:1:true:false',
    'req:success:IDBRequest:IDBRequest:2:true:false',
    'onsuccess:success:IDBRequest:IDBRequest:2:true:false',
    'dup:error:IDBRequest:IDBRequest:2:true:true',
    'tx-error-bubble:3:IDBRequest>IDBTransaction>IDBDatabase',
    'complete:complete:IDBTransaction:IDBTransaction:2:true:false',
  ]);
  assert.strictEqual(r.handlers, 'true,true,null,object,null,true,true');
  assert.strictEqual(r.ctor, 'Event,false,number');
  assert.strictEqual(r.manual, 'custom:pending');
});

test('IndexedDB: many records: bulk writes, index maintenance, range reads and cursors stay fast', async () => {
  const t0 = Date.now();
  const r = await page(`
    const N = 5000;
    const db = await openDb('bulk', 1, (d) => {
      const s = d.createObjectStore('s', { keyPath: 'id' });
      s.createIndex('mod', 'mod');
      s.createIndex('tags', 'tags', { multiEntry: true });
    });
    let tx = db.transaction('s', 'readwrite');
    let s = tx.objectStore('s');
    for (let i = 0; i < N; i++) s.put({ id: (i * 7919) % N, mod: i % 10, tags: ['t' + (i % 3), 'u' + (i % 5)], payload: 'x'.repeat(20) });
    await txDone(tx);
    const out = {};
    s = db.transaction('s').objectStore('s');
    out.count = await rq(s.count());
    out.idxCount = await rq(s.index('mod').count(3));
    out.tagCount = await rq(s.index('tags').count('t1'));
    out.range = (await rq(s.getAll(IDBKeyRange.bound(100, 109)))).map((x) => x.id).join();
    let n = 0, last = -1, sorted = true;
    await new Promise((res) => { const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) return res(); if (cur.key <= last) sorted = false; last = cur.key; n++; cur.continue(); }; });
    out.cursor = [n, sorted];
    // overwrite and delete everything through the store with indexes in place
    tx = db.transaction('s', 'readwrite'); s = tx.objectStore('s');
    for (let i = 0; i < N; i += 2) s.put({ id: i, mod: 99, tags: [], payload: 'y' });
    s.delete(IDBKeyRange.bound(0, 999));
    await txDone(tx);
    s = db.transaction('s').objectStore('s');
    out.after = [await rq(s.count()), await rq(s.index('mod').count(99)), await rq(s.index('tags').count('t1'))];
    tx = db.transaction('s', 'readwrite'); s = tx.objectStore('s');
    s.clear();
    await txDone(tx);
    out.cleared = [await rq(db.transaction('s').objectStore('s').count()), await rq(db.transaction('s').objectStore('s').index('tags').count())];
    return out;
  `);
  assert.strictEqual(r.count, 5000);
  assert.strictEqual(r.idxCount, 500);
  assert.strictEqual(r.tagCount, 1667);
  assert.strictEqual(r.range, '100,101,102,103,104,105,106,107,108,109');
  assert.deepStrictEqual(r.cursor, [5000, true]);
  assert.deepStrictEqual(r.after, [4000, 2000, 670], 'overwritten records drop their old index entries');
  assert.deepStrictEqual(r.cleared, [0, 0]);
  assert.ok(Date.now() - t0 < 8000, 'took ' + (Date.now() - t0) + 'ms');
});

test('IndexedDB: details from web-platform-tests: databases() snapshot, promise closes, FIFO queue, frozen names, index requests, generator limit', async () => {
  const r = await page(`
    const out = {};
    const ev = [];
    // databases() does not see an upgrade that is still running
    const dbA = await openDb('A', 1, (d) => { d.createObjectStore('s'); });
    let listed;
    const dbB = await openDb('B', 1, () => { listed = indexedDB.databases(); });
    out.snapshot = (await listed).map((x) => x.name + '@' + x.version).join();
    out.snapshotAfter = (await indexedDB.databases()).map((x) => x.name + '@' + x.version).sort().join();
    // a handler that closes the connection from a promise continuation avoids the blocked event
    dbA.onversionchange = () => Promise.resolve().then(() => dbA.close());
    await new Promise((res) => { const r = indexedDB.open('A', 2); r.onblocked = () => ev.push('blocked?!'); r.onsuccess = () => { ev.push('upgraded'); r.result.close(); res(); }; });
    out.promiseClose = ev.splice(0).join();
    // but one that closes from a timer does not: blocked fires first. open and delete requests run in order
    dbB.onversionchange = () => ev.push('vc');
    const order = [];
    const open = (token, version) => { const r = indexedDB.open('B', version); r.onblocked = () => order.push(token + ' blocked'); r.onsuccess = () => { order.push(token + ' success'); r.result.onversionchange = () => { order.push(token + ' versionchange'); setTimeout(() => r.result.close(), 0); }; }; };
    const del = (token) => { const r = indexedDB.deleteDatabase('B'); r.onblocked = () => order.push(token + ' blocked'); r.onsuccess = () => order.push(token + ' success'); };
    open('open1', 2); del('delete1'); open('open2', 3); del('delete2');
    dbB.close();
    await sleep(50);
    out.fifo = order;
    // names of a closed connection and of a finished upgrade transaction do not follow later upgrades
    let firstTx;
    const c1 = await openDb('C', 1, (d, e, tx) => { d.createObjectStore('s1'); d.createObjectStore('s2'); firstTx = tx; });
    c1.close();
    const c2 = await openDb('C', 2, (d) => { d.createObjectStore('s3'); });
    out.frozen = [Array.from(c1.objectStoreNames).join(), Array.from(firstTx.objectStoreNames).join(), Array.from(c2.objectStoreNames).join(), Object.prototype.hasOwnProperty.call(c2.objectStoreNames, 0), Object.keys(c2.objectStoreNames).join()];
    c2.close();
    // createIndex/deleteIndex are requests of the upgrade transaction, in order
    const events = [];
    await new Promise((res) => {
      const r = indexedDB.open('D', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('s');
        const a1 = s.add({ animal: 'Unicorn' }, 1); a1.onsuccess = () => events.push('add1.success');
        s.createIndex('i', 'animal', { unique: true });
        const a2 = s.add({ animal: 'Unicorn' }, 2); a2.onerror = (e) => { events.push('add2.' + a2.error.name); e.preventDefault(); e.stopPropagation(); };
        s.deleteIndex('i');
        events.push('indexNames:' + s.indexNames.length);
        const a3 = s.add({ animal: 'Unicorn' }, 3); a3.onsuccess = () => events.push('add3.success');
        r.transaction.oncomplete = () => events.push('complete');
      };
      r.onsuccess = () => { r.result.close(); res(); };
    });
    out.indexRequests = events;
    // renames survive an abort on the handles of stores and indexes created by the transaction
    out.renameAbort = await new Promise((res) => {
      const r = indexedDB.open('E', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('made'); const i = s.createIndex('idx', 'x');
        s.name = 'renamed'; i.name = 'idx2';
        r.transaction.abort();
        res([s.name, i.name, Array.from(r.result.objectStoreNames).length].join());
      };
      r.onerror = (e) => e.preventDefault();
    });
    // the generator stops at 2^53
    const dbF = await openDb('F', 1, (d) => { d.createObjectStore('s', { autoIncrement: true }); });
    const t = dbF.transaction('s', 'readwrite');
    const s = t.objectStore('s');
    const res1 = [await rq(s.put('x', 2 ** 53))];
    const over = s.put('y');
    res1.push(await new Promise((res) => { over.onerror = (e) => { e.preventDefault(); res(over.error.name); }; }));
    res1.push(await rq(s.put('z', 5)));
    out.generator = res1;
    return out;
  `);
  assert.strictEqual(r.snapshot, 'A@1');
  assert.strictEqual(r.snapshotAfter, 'A@1,B@1');
  assert.strictEqual(r.promiseClose, 'upgraded');
  assert.deepStrictEqual(r.fifo, ['open1 success', 'open1 versionchange', 'delete1 blocked', 'delete1 success', 'open2 success', 'open2 versionchange', 'delete2 blocked', 'delete2 success']);
  assert.deepStrictEqual(r.frozen, ['s1,s2', 's1,s2', 's1,s2,s3', true, '0,1,2']);
  assert.deepStrictEqual(r.indexRequests, ['indexNames:0', 'add1.success', 'add2.ConstraintError', 'add3.success', 'complete']);
  assert.strictEqual(r.renameAbort, 'renamed,idx2,0');
  assert.deepStrictEqual(r.generator, [9007199254740992, 'ConstraintError', 5]);
});
