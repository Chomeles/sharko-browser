'use strict';
const assert = require('assert');
const { createEnv } = require('../harness');

test('setTimeout ordering, args, this, clearTimeout', async () => {
  const e = await createEnv();
  e.run(`
    window.__log = [];
    setTimeout(() => __log.push('a10'), 10);
    setTimeout((x, y) => __log.push('b0:' + x + y), 0, 'p', 'q');
    setTimeout(() => __log.push('c10'), 10);
    var id = setTimeout(() => __log.push('cleared'), 5);
    clearTimeout(id); clearTimeout(undefined); clearTimeout(null); clearTimeout(123456);
    setTimeout(function () { __log.push('this:' + (this === window)); }, 1);
    __log.push('sync');
  `);
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__log')), ['sync', 'b0:pq', 'this:true', 'a10', 'c10']);
  assert.strictEqual(e.run('typeof setTimeout(() => {}) === "number" && setTimeout(() => {}) > 0'), true);
});

test('setInterval repeats, clearInterval from inside, nested clamping', async () => {
  const e = await createEnv();
  e.run(`
    window.__n = 0;
    var iv = setInterval(() => { if (++__n === 3) clearInterval(iv); }, 10);
    window.__times = [];
    (function nest(level) { __times.push(performance.now()); if (level < 8) setTimeout(() => nest(level + 1), 0); })(0);
  `);
  await e.flush();
  assert.strictEqual(e.run('__n'), 3);
  const t = Array.from(e.run('__times'));
  const deltas = t.slice(1).map((v, i) => v - t[i]);
  assert.deepStrictEqual(deltas, [0, 0, 0, 0, 0, 0, 4, 4], 'setTimeout(0) clamps to 4ms once the nesting level exceeds 5');
});

test('requestAnimationFrame / cancelAnimationFrame / frame timestamps', async () => {
  const e = await createEnv();
  e.run(`
    window.__f = [];
    requestAnimationFrame((ts) => { __f.push('a:' + (typeof ts) ); requestAnimationFrame(() => __f.push('next-frame')); });
    var c = requestAnimationFrame(() => __f.push('cancelled'));
    requestAnimationFrame(() => __f.push('b'));
    cancelAnimationFrame(c);
  `);
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__f')), ['a:number', 'b', 'next-frame']);
});

test('microtasks: queueMicrotask, promise order, error reporting', async () => {
  const e = await createEnv();
  e.run(`
    window.__m = [];
    addEventListener('error', (ev) => __m.push('error:' + ev.error.message));
    Promise.resolve().then(() => __m.push('p1'));
    queueMicrotask(() => __m.push('q1'));
    queueMicrotask(() => { throw new Error('boom'); });
    setTimeout(() => __m.push('timeout'), 0);
    __m.push('sync');
  `);
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__m')), ['sync', 'p1', 'q1', 'error:boom', 'timeout']);
  assert.strictEqual(e.run("(() => { try { queueMicrotask(1) } catch (x) { return x instanceof TypeError } })()"), true);
});

test('MessageChannel / MessagePort / BroadcastChannel ordering', async () => {
  const e = await createEnv();
  e.run(`
    window.__mc = [];
    var ch = new MessageChannel();
    ch.port1.onmessage = (ev) => __mc.push('p1:' + ev.data + ':' + (ev instanceof MessageEvent));
    ch.port2.postMessage('a');
    ch.port2.postMessage('b');
    setTimeout(() => __mc.push('timeout10'), 10);
    var ch2 = new MessageChannel();
    ch2.port2.addEventListener('message', (ev) => __mc.push('p2:' + JSON.stringify(ev.data)));
    ch2.port1.postMessage({ deep: [1, 2] });
    Promise.resolve().then(() => __mc.push('micro'));
    __mc.push('sync');
  `);
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__mc')), ['sync', 'micro', 'p1:a:true', 'p1:b:true', 'timeout10'], 'addEventListener without start() does not deliver');
  e.run("__mc = []; ch2.port2.start()");
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__mc')), ['p2:{"deep":[1,2]}']);
  e.run(`
    __mc = [];
    var b1 = new BroadcastChannel('x'), b2 = new BroadcastChannel('x'), b3 = new BroadcastChannel('y');
    b2.onmessage = (ev) => __mc.push('b2:' + ev.data);
    b1.onmessage = () => __mc.push('self!');
    b3.onmessage = () => __mc.push('other-name!');
    b1.postMessage('hi');
  `);
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__mc')), ['b2:hi']);
  // React-scheduler-like loop: repeatedly post to itself until work is done
  e.run(`
    window.__work = 0;
    var sch = new MessageChannel();
    sch.port1.onmessage = () => { __work++; if (__work < 50) sch.port2.postMessage(null); };
    sch.port2.postMessage(null);
  `);
  await e.flush();
  assert.strictEqual(e.run('__work'), 50);
});

test('requestIdleCallback and AbortSignal.timeout', async () => {
  const e = await createEnv();
  e.run(`
    window.__i = [];
    requestIdleCallback((d) => __i.push(typeof d.timeRemaining() + ':' + d.didTimeout + ':' + (d.timeRemaining() > 0)));
    var cid = requestIdleCallback(() => __i.push('cancelled'));
    cancelIdleCallback(cid);
    var s = AbortSignal.timeout(50);
    s.addEventListener('abort', () => __i.push('abort:' + s.reason.name));
  `);
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__i')), ['number:false:true', 'abort:TimeoutError']);
  assert.strictEqual(e.run("AbortSignal.abort().aborted && AbortSignal.abort().reason.name === 'AbortError'"), true);
  assert.strictEqual(e.run("var ac1 = new AbortController(), ac2 = new AbortController(); var any = AbortSignal.any([ac1.signal, ac2.signal]); ac2.abort('r2'); any.aborted + ':' + any.reason"), 'true:r2');
  assert.strictEqual(e.run("(() => { try { AbortSignal.abort('x').throwIfAborted() } catch (err) { return err } })()"), 'x');
});
