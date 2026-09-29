'use strict';
// MessagePorts and ArrayBuffers in the transfer list of postMessage, within a realm and across the
// documents (realms) of a page: window.postMessage to a cross-origin frame, ports that travel over
// ports, and same-origin frames reached through their real windows.
const assert = require('assert');
const { createEnv, frameGroup, flushAll } = require('../harness');

const arr = (x) => Array.from(x);

// A page (https://a.example/) with an <iframe id=f>, and the frame's document at `frameUrl`.
async function pageWithFrame(frameUrl = 'https://b.example/') {
  const group = frameGroup();
  const page = await createEnv({ url: 'https://a.example/', html: '<iframe id="f"></iframe>', frame: { path: [], group } });
  const frame = await createEnv({ url: frameUrl, frame: { path: [page.id('#f')], group } });
  return { page, frame, all: [page, frame] };
}

test('ports transferred to a cross-origin frame arrive as event.ports and stay connected', async () => {
  const { page, frame, all } = await pageWithFrame();
  frame.run(`
    window.__f = [];
    addEventListener('message', (ev) => {
      __f.push([ev.data, ev.origin, ev.ports.length, Object.isFrozen(ev.ports), ev.ports[0] instanceof MessagePort, ev.source === parent].join('|'));
      const p = ev.ports[0];
      p.onmessage = (m) => { __f.push('port:' + m.data + ':' + m.ports.length); p.postMessage('pong:' + m.data); };
      p.postMessage('hello-from-frame');
    });
  `);
  page.run(`
    window.__p = [];
    var ch = new MessageChannel();
    ch.port1.onmessage = (ev) => __p.push('got:' + ev.data);
    ch.port1.postMessage('queued-before-transfer');
    document.getElementById('f').contentWindow.postMessage('hi', '*', [ch.port2]);
    ch.port1.postMessage('sent-after-transfer');
  `);
  await flushAll(all);
  // messages posted before and after the transfer arrive in order
  assert.deepStrictEqual(arr(frame.run('__f')), ['hi|https://a.example|1|true|true|true', 'port:queued-before-transfer:0', 'port:sent-after-transfer:0']);
  assert.deepStrictEqual(arr(page.run('__p')), ['got:hello-from-frame', 'got:pong:queued-before-transfer', 'got:pong:sent-after-transfer']);
  page.run("ch.port1.postMessage('ping')");
  await flushAll(all);
  assert.strictEqual(frame.run('__f').length, 4);
  assert.strictEqual(page.run('__p[3]'), 'got:pong:ping');
});

test('a transferred port is detached in the sender; a message without ports goes as it is', async () => {
  const { page, frame, all } = await pageWithFrame();
  page.run(`
    var ch = new MessageChannel();
    window.__r = [];
    ch.port2.onmessage = () => __r.push('port2 still delivers!');
    document.getElementById('f').contentWindow.postMessage({ plain: 1 }, '*');
    document.getElementById('f').contentWindow.postMessage('with', '*', [ch.port2]);
    ch.port2.postMessage('to-detached');
    try { document.getElementById('f').contentWindow.postMessage('again', '*', [ch.port2]); } catch (e) { __r.push(e.name); }
    ch.port2.close();
  `);
  assert.strictEqual(JSON.stringify(page.mock.posted[0].message), '{"plain":1}', 'no envelope without ports');
  assert.deepStrictEqual(arr(page.run('__r')), ['DataCloneError']);
  frame.run("window.__g = []; addEventListener('message', (ev) => __g.push(JSON.stringify(ev.data) + ev.ports.length))");
  await flushAll(all);
  assert.deepStrictEqual(arr(frame.run('__g')), ['{"plain":1}0', '"with"1']);
  assert.deepStrictEqual(arr(page.run('__r')), ['DataCloneError']);
});

test('a frame hands a port to its cross-origin parent, replies travel both ways', async () => {
  const { page, frame, all } = await pageWithFrame();
  page.run(`
    window.__p = [];
    addEventListener('message', (ev) => {
      __p.push(ev.data.tag + ':' + ev.ports.length + ':' + (ev.data.port === ev.ports[0]));
      ev.ports[0].onmessage = (m) => { __p.push('parent got ' + m.data); ev.ports[0].postMessage('ack ' + m.data); };
    });
  `);
  frame.run(`
    window.__f = [];
    var ch = new MessageChannel();
    ch.port1.onmessage = (m) => __f.push(m.data);
    // the port is also inside the message: it arrives there as the same object as in ports
    parent.postMessage({ tag: 'offer', port: ch.port2 }, '*', [ch.port2]);
    ch.port1.postMessage('one');
    ch.port1.postMessage('two');
  `);
  await flushAll(all);
  assert.deepStrictEqual(arr(page.run('__p')), ['offer:1:true', 'parent got one', 'parent got two']);
  assert.deepStrictEqual(arr(frame.run('__f')), ['ack one', 'ack two']);
});

test('ports in the transfer list of a port message, also from another channel', async () => {
  const { page, frame, all } = await pageWithFrame();
  frame.run(`
    window.__f = [];
    addEventListener('message', (ev) => {
      ev.ports[0].onmessage = (m) => {
        const inner = m.ports[0];
        __f.push('inner ports:' + m.ports.length + ' data.p:' + (m.data.p === inner) + ' frozen:' + Object.isFrozen(m.ports));
        inner.onmessage = (x) => { __f.push('inner got ' + x.data); inner.postMessage('inner reply'); };
        inner.postMessage('from frame via inner');
      };
    });
  `);
  page.run(`
    window.__p = [];
    var outer = new MessageChannel(), inner = new MessageChannel();
    inner.port1.onmessage = (m) => { __p.push(m.data); if (m.data === 'from frame via inner') inner.port1.postMessage('to frame'); };
    document.getElementById('f').contentWindow.postMessage('go', '*', [outer.port2]);
    outer.port1.postMessage({ p: inner.port2 }, [inner.port2]);
  `);
  await flushAll(all);
  assert.deepStrictEqual(arr(frame.run('__f')), ['inner ports:1 data.p:true frozen:true', 'inner got to frame']);
  assert.deepStrictEqual(arr(page.run('__p')), ['from frame via inner', 'inner reply']);
});

test('a port can go back and forth: the channel keeps working through the realm it left', async () => {
  const { page, frame, all } = await pageWithFrame();
  // page -> frame -> page: the frame returns the port it got
  frame.run("addEventListener('message', (ev) => parent.postMessage('back', '*', ev.ports))");
  page.run(`
    window.__p = [];
    var ch = new MessageChannel();
    ch.port1.onmessage = (m) => __p.push('port1:' + m.data);
    addEventListener('message', (ev) => {
      window.__back = ev.ports[0];
      __back.onmessage = (m) => { __p.push('back:' + m.data); __back.postMessage('reply ' + m.data); };
    });
    document.getElementById('f').contentWindow.postMessage('take', '*', [ch.port2]);
  `);
  await flushAll(all);
  assert.strictEqual(page.run('__back instanceof MessagePort && __back !== ch.port2'), true);
  page.run("ch.port1.postMessage('a'); ch.port1.postMessage('b');");
  await flushAll(all);
  assert.deepStrictEqual(arr(page.run('__p')), ['back:a', 'back:b', 'port1:reply a', 'port1:reply b']);
});

test('a failed postMessage does not detach its ports; targetOrigin mismatch drops message and ports', async () => {
  const { page, frame, all } = await pageWithFrame();
  frame.run("window.__g = []; addEventListener('message', (ev) => __g.push(ev.data + ev.ports.length))");
  page.run(`
    window.__r = [];
    var ch = new MessageChannel();
    ch.port1.onmessage = (m) => __r.push(m.data);
    var w = document.getElementById('f').contentWindow;
    try { w.postMessage(() => 1, '*', [ch.port2]); } catch (e) { __r.push(e.name); }
    try { ch.port1.postMessage('x', [ch.port1]); } catch (e) { __r.push('self:' + e.name); }
    try { w.postMessage('dup', '*', [ch.port2, ch.port2]); } catch (e) { __r.push('dup:' + e.name); }
    ch.port2.postMessage('still-here');
    w.postMessage('nope', 'https://elsewhere.example', [ch.port2]);
  `);
  await flushAll(all);
  assert.deepStrictEqual(arr(page.run('__r')), ['DataCloneError', 'self:DataCloneError', 'dup:DataCloneError', 'still-here']);
  assert.deepStrictEqual(arr(frame.run('__g')), []);
  // the port was transferred though the message was dropped: what is posted to it goes nowhere
  page.run("ch.port1.postMessage('lost')");
  await flushAll(all);
  assert.deepStrictEqual(arr(frame.run('__g')), []);
  assert.deepStrictEqual(page.errors(), []);
  assert.deepStrictEqual(frame.errors(), []);
});

test('ports inside the message: as a property, in a Map, as the message itself; same realm keeps identity', async () => {
  const { page, frame, all } = await pageWithFrame();
  frame.run(`
    window.__f = [];
    addEventListener('message', (ev) => {
      const [a, b] = ev.ports;
      const d = ev.data;
      __f.push([d.deep.list[1] === a, d.map.get('k') === b, d.map.get('other') === 1, d.same === d.deep].join());
      a.onmessage = () => a.postMessage('a ok');
      b.onmessage = () => b.postMessage('b ok');
      a.postMessage('start');
    });
  `);
  page.run(`
    window.__p = [];
    var c1 = new MessageChannel(), c2 = new MessageChannel();
    c1.port1.onmessage = (m) => { __p.push('c1:' + m.data); if (m.data === 'start') { c1.port1.postMessage('x'); c2.port1.postMessage('y'); } else if (m.data === 'a ok') { } };
    c2.port1.onmessage = (m) => __p.push('c2:' + m.data);
    var deep = { list: [0, c1.port2] };
    document.getElementById('f').contentWindow.postMessage({ deep: deep, same: deep, map: new Map([['other', 1], ['k', c2.port2]]) }, '*', [c1.port2, c2.port2]);
  `);
  await flushAll(all);
  assert.deepStrictEqual(arr(frame.run('__f')), ['true,true,true,true']);
  assert.deepStrictEqual(arr(page.run('__p')), ['c1:start', 'c1:a ok', 'c2:b ok']);
  // within one realm the port object itself is what arrives, also as the whole message
  page.run(`
    window.__l = [];
    var c3 = new MessageChannel(), c4 = new MessageChannel();
    c3.port2.onmessage = (m) => __l.push([m.data === m.ports[0], m.ports[0] === c4.port2, Object.isFrozen(m.ports)].join());
    c3.port1.postMessage(c4.port2, [c4.port2]);
    c3.port1.postMessage({ p: c4.port2 }, { transfer: [c4.port2] });
  `);
  await flushAll(all);
  assert.deepStrictEqual(arr(page.run('__l')), ['true,true,true', 'false,true,true']);
});

test('same-origin frames: ports travelling over a port, inside the message and back', async () => {
  const { page, frame, all } = await pageWithFrame('https://a.example/frame.html');
  frame.run(`
    window.__f = [];
    addEventListener('message', (ev) => {
      ev.ports[0].onmessage = (m) => {
        const inner = m.data.inner;
        __f.push('frame: ' + (inner === m.ports[0]) + ' ' + (inner instanceof MessagePort));
        inner.onmessage = (x) => inner.postMessage('echo ' + x.data + (x.ports.length ? ' with port' : ''));
        // and a port made here goes back through the channel
        const mine = new MessageChannel();
        mine.port1.onmessage = (x) => __f.push('mine ' + x.data);
        ev.ports[0].postMessage({ mine: mine.port2 }, [mine.port2]);
      };
    });
  `);
  page.run(`
    window.__p = [];
    var outer = new MessageChannel(), inner = new MessageChannel();
    inner.port1.onmessage = (m) => __p.push(m.data);
    outer.port1.onmessage = (m) => { __p.push('back ' + (m.data.mine === m.ports[0])); m.ports[0].postMessage('hello mine'); };
    document.getElementById('f').contentWindow.postMessage('go', '*', [outer.port2]);
    outer.port1.postMessage({ inner: inner.port2 }, [inner.port2]);
    inner.port1.postMessage('one');
    inner.port1.postMessage('two', [new MessageChannel().port1]);
  `);
  await flushAll(all);
  assert.deepStrictEqual(arr(frame.run('__f')), ['frame: true true', 'mine hello mine']);
  assert.deepStrictEqual(arr(page.run('__p')), ['back true', 'echo one', 'echo two with port']);
});

test('closing a transferred port ends the channel for both sides', async () => {
  const { page, frame, all } = await pageWithFrame();
  frame.run("addEventListener('message', (ev) => { window.__port = ev.ports[0]; __port.onmessage = (m) => __port.postMessage('echo ' + m.data); })");
  page.run(`
    window.__p = [];
    var ch = new MessageChannel();
    ch.port1.onmessage = (m) => __p.push(m.data);
    document.getElementById('f').contentWindow.postMessage('x', '*', [ch.port2]);
    ch.port1.postMessage('1');
  `);
  await flushAll(all);
  assert.deepStrictEqual(arr(page.run('__p')), ['echo 1']);
  const sent = () => page.mock.posted.length + frame.mock.posted.length;
  frame.run('__port.close()');
  await flushAll(all);
  const n = sent();
  page.run("ch.port1.postMessage('2')");
  await flushAll(all);
  assert.strictEqual(sent(), n, 'nothing is sent to a closed port');
  assert.deepStrictEqual(arr(page.run('__p')), ['echo 1']);
  frame.run("__port.postMessage('3')");
  await flushAll(all);
  assert.strictEqual(sent(), n, 'nor from it');
});

test('ArrayBuffers in the transfer list are detached in the sender', async () => {
  const { page, frame, all } = await pageWithFrame();
  frame.run("window.__g = []; addEventListener('message', (ev) => __g.push(new Uint8Array(ev.data).join()))");
  page.run(`
    window.__r = [];
    var a = new Uint8Array([1, 2, 3]).buffer, b = new Uint8Array([4, 5]).buffer, c = new Uint8Array([6]).buffer, d = new Uint8Array([7]).buffer;
    var ch = new MessageChannel();
    ch.port2.onmessage = (m) => __r.push('port:' + new Uint8Array(m.data).join());
    addEventListener('message', (m) => __r.push('self:' + new Uint8Array(m.data).join()));
    document.getElementById('f').contentWindow.postMessage(a, '*', [a]);
    postMessage(b, '*', [b]);
    ch.port1.postMessage(c, [c]);
    postMessage(d, { targetOrigin: '*', transfer: [d] });
    window.__lens = [a.byteLength, b.byteLength, c.byteLength, d.byteLength].join();
    try { postMessage(a, '*', [a]); } catch (e) { __r.push('window:' + e.name); }
    try { new MessageChannel().port1.postMessage(1, [a]); } catch (e) { __r.push('port:' + e.name); }
  `);
  await flushAll(all);
  assert.strictEqual(page.run('__lens'), '0,0,0,0');
  assert.deepStrictEqual(arr(frame.run('__g')), ['1,2,3']);
  assert.deepStrictEqual(arr(page.run('__r')).sort(), ['port:6', 'port:DataCloneError', 'self:4,5', 'self:7', 'window:DataCloneError']);
});

test('same-origin frames: ports cross through the real window and keep working', async () => {
  const { page, frame, all } = await pageWithFrame('https://a.example/frame.html');
  assert.strictEqual(page.run("document.getElementById('f').contentWindow === window"), false);
  frame.run(`
    window.__f = [];
    addEventListener('message', (ev) => {
      const p = ev.ports[0];
      __f.push('frame got ' + ev.data + ' ports:' + ev.ports.length + ' own:' + (p instanceof MessagePort) + ' src:' + (ev.source === parent));
      p.onmessage = (m) => { __f.push('frame port:' + m.data); p.postMessage('pong ' + m.data); };
      // a port of its own goes up to the page
      const mine = new MessageChannel();
      mine.port1.onmessage = (m) => __f.push('mine:' + m.data);
      parent.postMessage('up', '*', [mine.port2]);
    });
  `);
  page.run(`
    window.__p = [];
    var ch = new MessageChannel();
    ch.port1.onmessage = (m) => __p.push('page port:' + m.data);
    addEventListener('message', (ev) => { __p.push('page got ' + ev.data + ' ports:' + ev.ports.length + ' own:' + (ev.ports[0] instanceof MessagePort)); ev.ports[0].postMessage('hello page'); });
    ch.port1.postMessage('queued');
    document.getElementById('f').contentWindow.postMessage('down', '*', [ch.port2]);
    ch.port1.postMessage('later');
  `);
  await flushAll(all);
  assert.deepStrictEqual(arr(frame.run('__f')), ['frame got down ports:1 own:true src:true', 'frame port:queued', 'frame port:later', 'mine:hello page']);
  assert.deepStrictEqual(arr(page.run('__p')).sort(), ['page got up ports:1 own:true', 'page port:pong later', 'page port:pong queued']);
});

test('port envelopes are only honored from the frame the port was handed to', async () => {
  const group = frameGroup();
  const page = await createEnv({ url: 'https://a.example/', html: '<iframe id="f"></iframe><iframe id="g"></iframe>', frame: { path: [], group } });
  const f = await createEnv({ url: 'https://b.example/', frame: { path: [page.id('#f')], group } });
  const g = await createEnv({ url: 'https://c.example/', frame: { path: [page.id('#g')], group } });
  const all = [page, f, g];
  f.run("addEventListener('message', (ev) => { window.__port = ev.ports[0]; })");
  page.run(`
    window.__p = [];
    var ch = new MessageChannel();
    ch.port1.onmessage = (m) => __p.push(m.data);
    addEventListener('message', (ev) => __p.push('window message!'));
    document.getElementById('f').contentWindow.postMessage('x', '*', [ch.port2]);
  `);
  await flushAll(all);
  f.run("__port.postMessage('legit')");
  await flushAll(all);
  assert.deepStrictEqual(arr(page.run('__p')), ['legit']);
  // the envelope that carried it, replayed by another frame or made up: dropped without a trace
  const sent = f.mock.posted[f.mock.posted.length - 1].message;
  assert.strictEqual(sent['\u0001sharko:port'], 'm');
  g.run(`parent.postMessage(${JSON.stringify(sent)}, '*'); parent.postMessage({ '\u0001sharko:port': 'm', id: 'nope', data: 1, ports: [] }, '*')`);
  await flushAll(all);
  assert.deepStrictEqual(arr(page.run('__p')), ['legit']);
  // and by the right frame it is honored again
  f.run(`parent.postMessage(${JSON.stringify(sent)}, '*')`);
  await flushAll(all);
  assert.deepStrictEqual(arr(page.run('__p')), ['legit', 'legit']);
});
