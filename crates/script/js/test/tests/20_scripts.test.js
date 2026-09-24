'use strict';
const assert = require('assert');
const { createEnv } = require('../harness');

const log = (e) => Array.from(e.run('window.__log || []'));

test('parser scripts run in document order; externals fetched in parallel up front', async () => {
  const html = `<!DOCTYPE html><html><head>
    <script>window.__log = ['inline1:' + document.readyState];</script>
    <script src="/slow.js"></script>
    <script>__log.push('inline2')</script>
    <script src="/fast.js"></script>
    <script type="text/template">__log.push('template-type')</script>
    <script nomodule>__log.push('nomodule')</script>
    <script language="javascript">__log.push('language')</script>
    <script type="text/javascript; charset=utf-8">__log.push('params-not-js')</script>
  </head><body><template><script>__log.push('in-template')</script></template></body></html>`;
  const e = await createEnv({
    html,
    routes: {
      'https://example.com/slow.js': { body: "__log.push('slow:' + document.currentScript.src)", delay: 50 },
      'https://example.com/fast.js': { body: "__log.push('fast')", delay: 5 },
    },
    flush: false,
  });
  assert.deepStrictEqual(e.requests.map((r) => r.url), ['https://example.com/slow.js', 'https://example.com/fast.js'], 'both fetches started immediately');
  await e.flush();
  assert.deepStrictEqual(log(e), ['inline1:loading', 'slow:https://example.com/slow.js', 'inline2', 'fast', 'language']);
});

test('defer, async, modules, readyState, DOMContentLoaded and load ordering', async () => {
  const html = `<!DOCTYPE html><html><head>
    <script>
      window.__log = [];
      document.addEventListener('readystatechange', () => __log.push('rs:' + document.readyState));
      document.addEventListener('DOMContentLoaded', (e) => __log.push('DOMContentLoaded:' + document.readyState + ':' + e.bubbles));
      window.addEventListener('DOMContentLoaded', () => __log.push('dcl-window'));
      window.addEventListener('load', (e) => __log.push('load:' + document.readyState + ':' + (e.target === document)));
      window.addEventListener('pageshow', (e) => __log.push('pageshow:' + e.persisted));
    </script>
    <script defer src="/d1.js"></script>
    <script type="module">__log.push('inline-module:' + document.currentScript)</script>
    <script defer src="/d2.js"></script>
    <script async src="/a1.js"></script>
    <script type="module" src="/m1.js"></script>
    <script>__log.push('blocking:' + document.readyState)</script>
  </head><body onload="__log.push('body-onload')"></body></html>`;
  const e = await createEnv({
    html,
    routes: {
      'https://example.com/d1.js': { body: "__log.push('d1:' + document.readyState + ':' + (document.currentScript && document.currentScript.getAttribute('src')))", delay: 30 },
      'https://example.com/d2.js': { body: "__log.push('d2')", delay: 1 },
      'https://example.com/a1.js': { body: "__log.push('async')", delay: 100 },
      'https://example.com/m1.js': "__log.push('m1')",
    },
  });
  assert.deepStrictEqual(log(e), [
    'blocking:loading', 'rs:interactive', 'd1:interactive:/d1.js', 'inline-module:null', 'd2', 'm1',
    'DOMContentLoaded:interactive:true', 'dcl-window', 'async', 'rs:complete', 'load:complete:true', 'body-onload', 'pageshow:false',
  ]);
});

test('microtasks drain between parser-inserted scripts', async () => {
  const e = await createEnv({
    html: `<script>window.__log=[]; Promise.resolve().then(() => __log.push('micro')); setTimeout(() => __log.push('timeout'), 0);</script>
           <script>__log.push('second')</script>`,
  });
  assert.deepStrictEqual(log(e), ['micro', 'second', 'timeout']);
});

test('load waits for pending subresources and dynamic scripts', async () => {
  const e = await createEnv({
    html: `<script>window.__log=[]; addEventListener('load', () => __log.push('load'));
      var s = document.createElement('script'); s.src = '/late.js'; document.head.appendChild(s);</script>`,
    routes: { 'https://example.com/late.js': { body: "__log.push('late')", delay: 200 } },
    beforeLayer: (m) => { m.pendingResources = 1; },
  });
  assert.deepStrictEqual(log(e), ['late']);
  e.mock.pendingResources = 0;
  e.hook('onResourcesLoaded');
  await e.flush();
  assert.deepStrictEqual(log(e), ['late', 'load']);
  assert.strictEqual(e.run('document.readyState'), 'complete');
});

test('dynamic script insertion semantics', async () => {
  const e = await createEnv({
    routes: {
      'https://example.com/ext.js': { body: "__log.push('ext:' + (document.currentScript && document.currentScript.id))", delay: 20 },
      'https://example.com/o1.js': { body: "__log.push('o1')", delay: 40 },
      'https://example.com/o2.js': { body: "__log.push('o2')", delay: 1 },
      'https://example.com/404.js': { status: 404, body: 'nope' },
    },
  });
  e.run(`
    window.__log = [];
    var s = document.createElement('script');
    s.textContent = "__log.push('inline-sync:' + (document.currentScript === s))";
    __log.push('before');
    document.body.appendChild(s);
    __log.push('after');
    document.body.appendChild(s); // already started: must not run again
    s.remove(); document.body.appendChild(s);
  `);
  assert.deepStrictEqual(log(e), ['before', 'inline-sync:true', 'after']);
  e.run(`
    var x = document.createElement('script'); x.id = 'X'; x.src = '/ext.js';
    x.onload = () => __log.push('onload:' + x.async);
    document.head.appendChild(x);
    var bad = document.createElement('script'); bad.src = '/404.js';
    bad.addEventListener('error', () => __log.push('onerror'));
    document.head.appendChild(bad);
    var d = document.createElement('div'); d.innerHTML = '<script>__log.push("innerHTML-script")<\\/script>';
    document.body.appendChild(d);
    document.body.insertAdjacentHTML('beforeend', '<script>__log.push("adjacent")<\\/script>');
    var frag = document.createDocumentFragment(); var fs = document.createElement('script'); fs.text = "__log.push('from-fragment')"; frag.appendChild(document.createElement('p')).appendChild(fs);
    document.body.appendChild(frag);
    var empty = document.createElement('script'); document.body.appendChild(empty); empty.text = "__log.push('late-text')";
    var later = document.createElement('script'); document.body.appendChild(later); later.src = '/o2.js';
    var ctx = document.createRange().createContextualFragment('<script>__log.push("contextual")<\\/script>');
    document.body.appendChild(ctx);
  `);
  assert.deepStrictEqual(log(e), ['before', 'inline-sync:true', 'after', 'from-fragment', 'late-text', 'contextual']);
  await e.flush();
  assert.deepStrictEqual(log(e).slice(6), ['onerror', 'o2', 'ext:X', 'onload:true']);
  e.run(`
    __log = [];
    for (const u of ['/o1.js', '/o2.js']) { const t = document.createElement('script'); t.async = false; t.src = u; document.head.appendChild(t); }
  `);
  await e.flush();
  assert.deepStrictEqual(log(e), ['o1', 'o2'], 'async=false scripts execute in insertion order');
  e.run(`__log = []; var m = document.createElement('script'); m.type = 'module'; m.textContent = "__log.push('dyn-module')"; document.body.appendChild(m); __log.push('after-module-insert');`);
  await e.flush();
  assert.deepStrictEqual(log(e), ['after-module-insert', 'dyn-module']);
});

test('document.write during parsing and after load', async () => {
  const e = await createEnv({
    html: `<body><script>window.__log = [];
      document.write('<p id="w1">written</p><script>__log.push("written-inline:" + !!document.getElementById("w1"))<\\/script>');
      __log.push('after-write:' + document.getElementById('w1').textContent);
      document.write('<script src="/wext.js"><\\/script>');
      document.write('<div id="split" class="c">'); document.write('inside'); document.write('</div>');
      document.writeln('<span id="ln"></span>');
      __log.push('end-of-script');
    </script><script>__log.push('next-parser-script:' + document.getElementById('split').textContent + ':' + (document.getElementById('ln').previousElementSibling.id))</script><p id="tail"></p></body>`,
    routes: { 'https://example.com/wext.js': { body: "__log.push('written-external')", delay: 30 } },
  });
  assert.deepStrictEqual(log(e), ['written-inline:true', 'after-write:written', 'end-of-script', 'written-external', 'next-parser-script:inside:split']);
  assert.strictEqual(e.run("document.getElementById('w1').previousElementSibling.tagName + document.getElementById('tail').previousElementSibling.tagName"), 'SCRIPTSCRIPT');
  e.run("document.write('<h1 id=fresh>replaced</h1>')");
  assert.strictEqual(e.run("document.body.children.length + document.body.firstChild.id"), '1fresh');
  e.run("document.open(); document.write('<i>x</i>'); document.write('<i>y</i>'); document.close();");
  assert.strictEqual(e.run("document.body.innerHTML"), '<i>x</i><i>y</i>');
});

test('script errors are reported and do not stop later scripts; window.onerror', async () => {
  const e = await createEnv({
    html: `<script>window.__log = []; window.onerror = function (msg, src, line, col, err) { __log.push('onerror:' + msg + ':' + src + ':' + line + ':' + (err instanceof TypeError)); return true; };
      addEventListener('error', (ev) => __log.push('error-event:' + (ev instanceof ErrorEvent) + ':' + ev.message));</script>
      <script src="/boom.js"></script>
      <script>__log.push('still-running'); setTimeout(() => { null.x; }, 0);</script>`,
    routes: { 'https://example.com/boom.js': '\n\nundefined.foo();' },
  });
  const l = log(e);
  assert.strictEqual(l[0].startsWith("onerror:Uncaught TypeError: Cannot read properties of undefined (reading 'foo'):https://example.com/boom.js:3:"), true, l[0]);
  assert.strictEqual(l[0].endsWith(':true'), true);
  assert.strictEqual(l[1], "error-event:true:Uncaught TypeError: Cannot read properties of undefined (reading 'foo')");
  assert.strictEqual(l[2], 'still-running');
  assert.strictEqual(l[3].startsWith('onerror:Uncaught TypeError'), true);
  assert.strictEqual(e.errors().length, 1, 'evalScript logged once (mock mirrors Rust); timer error canceled by onerror returning true');
});

test('inline scripts inside innerHTML never run; javascript: hrefs and setTimeout strings', async () => {
  const e = await createEnv({ html: '<a id="a" href="javascript:window.__js=1">x</a>' });
  e.run("document.body.innerHTML += '<script>window.__bad = 1<\\/script>'");
  assert.strictEqual(e.run('typeof window.__bad'), 'undefined');
  e.run("document.getElementById('a').click()");
  assert.strictEqual(e.run('window.__js'), 1);
  e.run("setTimeout('window.__str = 2', 10)");
  await e.flush();
  assert.strictEqual(e.run('window.__str'), 2);
});
