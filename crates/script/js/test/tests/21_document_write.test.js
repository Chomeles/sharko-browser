'use strict';
// document.write / open / close. The written scripts are parser-inserted scripts of the
// (script-created) parser: an external one blocks the ones written after it, whichever
// path the markup took (during parsing, after load, nested in another written script).
const assert = require('assert');
const { createEnv } = require('../harness');

const log = (e) => Array.from(e.run('window.__log || []'));
const routes = () => ({
  'https://example.com/def.js': { body: "window.defGlobal = () => 'OK'; __log.push('def.js')", delay: 30 },
  'https://example.com/fast.js': { body: "__log.push('fast.js')", delay: 1 },
});

test('after load: the inline script written after a written <script src> waits for it (ad iframe pattern)', async () => {
  const e = await createEnv({ html: '<body><p id="old"></p></body>', routes: routes() });
  e.run(String.raw`window.__log = [];
    document.open();
    document.write('<html><body><script src="/def.js"><\/script><script>__log.push("inline:" + (typeof defGlobal === "function" ? defGlobal() : "MISSING") + ":" + document.currentScript.parentNode.tagName)<\/script></body></html>');
    document.close();
    __log.push('close-returned');`);
  assert.deepStrictEqual(log(e), ['close-returned'], 'nothing written runs before the external script is there');
  await e.flush();
  assert.deepStrictEqual(log(e), ['close-returned', 'def.js', 'inline:OK:BODY']);
  assert.strictEqual(e.run('document.getElementById("old")'), null, 'the implicit/explicit open replaced the body content');
});

test('after load: an implicit open by document.write behaves the same', async () => {
  const e = await createEnv({ html: '<body></body>', routes: routes() });
  e.run(String.raw`window.__log = [];
    document.write('<script src="/def.js"><\/script><script>__log.push("inline:" + typeof defGlobal)<\/script><p id="after"></p>');`);
  assert.strictEqual(e.run('!!document.getElementById("after")'), true, 'the markup itself is in the tree at once');
  assert.deepStrictEqual(log(e), []);
  await e.flush();
  assert.deepStrictEqual(log(e), ['def.js', 'inline:function']);
});

test('after load: later writes queue behind the pending written script', async () => {
  const e = await createEnv({ html: '<body></body>', routes: routes() });
  e.run(String.raw`window.__log = [];
    document.write('<script src="/def.js"><\/script>');
    document.write('<script>__log.push("second-write:" + typeof defGlobal)<\/script>');
    document.write('<script src="/fast.js"><\/script><script>__log.push("third-write")<\/script>');
    __log.push('sync-end');`);
  assert.deepStrictEqual(log(e), ['sync-end']);
  await e.flush();
  // fast.js arrives first but the parser is still waiting for def.js
  assert.deepStrictEqual(log(e), ['sync-end', 'def.js', 'second-write:function', 'fast.js', 'third-write']);
  e.run('__log = []; document.write("<script>__log.push(\'idle-parser\')<\\/script>")');
  assert.deepStrictEqual(log(e), ['idle-parser'], 'with nothing pending, a written inline script runs at once');
});

test('after load: a written script that writes inserts the markup after itself and runs its scripts nested', async () => {
  const e = await createEnv({ html: '<body></body>', routes: routes() });
  e.run(String.raw`window.__log = [];
    document.write('<script>__log.push("A"); document.write(\'<b id=nested></b><scr\' + \'ipt src=/def.js></scr\' + \'ipt>\'); __log.push("A-end:" + document.getElementById("nested").previousElementSibling.tagName)<\/script><script>__log.push("B:" + typeof defGlobal)<\/script><i id="tail"></i>');`);
  assert.deepStrictEqual(log(e), ['A', 'A-end:SCRIPT']);
  await e.flush();
  assert.deepStrictEqual(log(e), ['A', 'A-end:SCRIPT', 'def.js', 'B:function']);
  assert.strictEqual(e.run('document.body.children[1].id + document.body.children[3].tagName + document.body.lastElementChild.id'), 'nestedSCRIPTtail');
});

test('after load: an async written script does not block, deferred and module ones wait for document.close()', async () => {
  const e = await createEnv({ html: '<body></body>', routes: routes() });
  e.run(String.raw`window.__log = [];
    document.open();
    document.write('<script defer src="/def.js"><\/script><script async src="/fast.js"><\/script><script type="module">__log.push("module")<\/script><script>__log.push("inline")<\/script>');`);
  assert.deepStrictEqual(log(e), ['inline']);
  await e.flush();
  assert.deepStrictEqual(log(e), ['inline', 'fast.js'], 'async ran, the deferred script waits for the end of the parser');
  e.run('document.close()');
  await e.flush();
  assert.deepStrictEqual(log(e), ['inline', 'fast.js', 'def.js', 'module'], 'in document order');
  // a script-created parser that is still waiting for a blocking script ends after it
  e.run(String.raw`__log = []; document.open(); document.write('<script defer src="/fast.js"><\/script><script src="/def.js"><\/script>'); document.close();`);
  await e.flush();
  assert.deepStrictEqual(log(e), ['def.js', 'fast.js']);
});

test('document.open() drops the written scripts that have not run yet', async () => {
  const e = await createEnv({ html: '<body></body>', routes: routes() });
  e.run(String.raw`window.__log = [];
    document.write('<script src="/def.js"><\/script><script>__log.push("never")<\/script>');
    document.open(); document.write('<i id="fresh"></i><script>__log.push("fresh-inline")<\/script>'); document.close();`);
  await e.flush();
  assert.deepStrictEqual(log(e), ['fresh-inline']);
  assert.strictEqual(e.run('document.body.children.length + document.body.firstElementChild.id'), '2fresh');
});

test('after close(), the next write opens the document again', async () => {
  const e = await createEnv({ html: '<body><p id="old"></p></body>', routes: routes() });
  e.run(`document.open(); document.write('<i id=one></i>'); document.write('<i id=two></i>'); document.close();`);
  assert.strictEqual(e.run('document.body.innerHTML'), '<i id="one"></i><i id="two"></i>');
  e.run(`document.write('<i id=three></i>')`);
  assert.strictEqual(e.run('document.body.innerHTML'), '<i id="three"></i>');
});

test('a written script that fails to load does not stall the ones behind it; load and error events fire', async () => {
  const e = await createEnv({
    html: '<body></body>',
    routes: Object.assign(routes(), { 'https://example.com/gone.js': { status: 404, body: 'nope', delay: 5 } }),
  });
  e.run(String.raw`window.__log = [];
    document.write('<script src="/gone.js" onerror="__log.push(\'error-event\')"><\/script><script src="/fast.js" onload="__log.push(\'load-event:\' + this.src.split(\'/\').pop())"><\/script><script>__log.push("after")<\/script>');`);
  await e.flush();
  assert.deepStrictEqual(log(e), ['error-event', 'fast.js', 'load-event:fast.js', 'after']);
});

test('document.close() inside a written script ends the parser after that script', async () => {
  const e = await createEnv({ html: '<body></body>', routes: routes() });
  e.run(String.raw`window.__log = [];
    document.open();
    document.write('<script>document.close(); __log.push("closed")<\/script><script defer src="/fast.js"><\/script>');
    __log.push('write-returned');`);
  assert.deepStrictEqual(log(e), ['closed', 'write-returned']);
  await e.flush();
  assert.deepStrictEqual(log(e), ['closed', 'write-returned', 'fast.js']);
});

test('document.open() dropping a pending written script does not strand the load event', async () => {
  const e = await createEnv({
    html: '<body><script async src="/a.js"></script></body>',
    routes: {
      'https://example.com/a.js': { body: "window.__log = ['async']", delay: 100 },
      'https://example.com/slow.js': { body: "__log.push('slow.js')", delay: 400 },
    },
    flush: false,
  });
  e.run(String.raw`document.write('<script src="/slow.js"><\/script>');`);
  await e.advance(150); // the async script is done, the written one is still awaited
  assert.strictEqual(e.run('document.readyState'), 'interactive');
  e.run(`addEventListener('load', () => __log.push('load')); document.open(); document.close();`);
  await e.flush();
  assert.deepStrictEqual(log(e), ['async', 'load']);
});

test('during parsing: scripts written by separate write calls keep their order', async () => {
  const e = await createEnv({
    html: String.raw`<body><script>window.__log = [];
      document.write('<script src="/def.js"><\/script>');
      document.write('<script>__log.push("second-write:" + typeof defGlobal)<\/script>');
      __log.push('outer-end');
    </script><script>__log.push('doc-next')</script></body>`,
    routes: routes(),
  });
  assert.deepStrictEqual(log(e), ['outer-end', 'def.js', 'second-write:function', 'doc-next']);
});

test('during parsing: a script written inside a written script runs before the rest of the outer chunk', async () => {
  const e = await createEnv({
    html: String.raw`<body><script>window.__log = [];
      document.write('<script>__log.push("A"); document.write(\'<scr\' + \'ipt src=/def.js></scr\' + \'ipt>\'); __log.push("A-end")<\/script><script>__log.push("B:" + typeof defGlobal)<\/script><script>__log.push("C")<\/script>');
      __log.push('outer-end');
    </script><script>__log.push('doc-next')</script></body>`,
    routes: routes(),
  });
  assert.deepStrictEqual(log(e), ['A', 'A-end', 'outer-end', 'def.js', 'B:function', 'C', 'doc-next']);
});

test('during parsing: a write from a timer task queues behind the written script the parser waits for', async () => {
  const e = await createEnv({
    html: String.raw`<body><script>window.__log = [];
      document.write('<script src="/def.js"><\/script>');
      setTimeout(() => document.write('<script>__log.push("timer-write:" + typeof defGlobal)<\/script>'), 0);
    </script><script src="/fast.js"></script></body>`,
    routes: routes(),
  });
  assert.deepStrictEqual(log(e), ['def.js', 'timer-write:function', 'fast.js']);
});

test('a document without a browsing context never runs the scripts written into it', async () => {
  const e = await createEnv({ html: '<body></body>', routes: routes() });
  e.run(String.raw`window.__log = [];
    var d = document.implementation.createHTMLDocument('t');
    d.write('<b id=x></b><script>__log.push("foreign")<\/script><script src="/def.js"><\/script>');
    window.__foreign = d.body.innerHTML;`);
  await e.flush();
  assert.deepStrictEqual(log(e), []);
  assert.strictEqual(e.run('__foreign').includes('id="x"'), true);
  assert.strictEqual(e.run('document.body.children.length'), 0);
});

test('load waits for a script written after the parser finished', async () => {
  const e = await createEnv({
    html: '<body></body>',
    routes: { 'https://example.com/def.js': { body: "__log.push('def.js')", delay: 200 } },
    beforeLayer: (m) => { m.pendingResources = 1; },
  });
  e.run(String.raw`window.__log = []; addEventListener('load', () => __log.push('load')); document.write('<script src="/def.js"><\/script>');`);
  e.mock.pendingResources = 0;
  e.hook('onResourcesLoaded');
  await e.flush();
  assert.deepStrictEqual(log(e), ['def.js', 'load']);
});

test('a <script> split over two document.write calls runs once, with the whole text (btloader pattern)', async () => {
  const e = await createEnv({ html: '<body><p id="old"></p></body>' });
  e.run(String.raw`window.__log = [];
    document.open();
    document.write('<html><body><script>__log.push("a");\n/*\n * @returns {Promise<void>}');
    __log.push('between');
    document.write('\n */\n__log.push("b")<\/script><p id="after"></p></body></html>');
    document.close();`);
  await e.flush();
  assert.deepStrictEqual(log(e), ['between', 'a', 'b']);
  assert.strictEqual(e.run('!!document.getElementById("after")'), true);
  assert.deepStrictEqual(Array.from(e.run('window.__errors || []')), []);
});

test('document.close() flushes a tail the writes left open', async () => {
  const e = await createEnv({ html: '<body></body>' });
  e.run(String.raw`document.open(); document.write('<p id="x">hi</p><div class="un'); document.close();`);
  await e.flush();
  assert.strictEqual(e.run('document.getElementById("x") !== null'), true);
});
