'use strict';
// Integration points with the Rust natives beyond the base contract (see NATIVE_API.md,
// "Additions (requested by JS layer)"): template contents, native focus events, onError,
// onPopState, onElementEvent, rejection hooks, fetch credentials/cache/redirect, ...
const assert = require('assert');
const { createEnv } = require('../harness');

const arr = (v) => Array.from(v);
const TPL_PAGE = '<!DOCTYPE html><html><head></head><body><div id="wrap"><template id="tpl"><p class="in-tpl">T<template id="inner"><i class="deep">d</i></template></p></template></div></body></html>';

async function templateChecks(opts, fallback) {
  const e = await createEnv(Object.assign({ html: TPL_PAGE }, opts));
  e.run("var tpl = document.getElementById('tpl')");
  assert.strictEqual(e.run("document.querySelectorAll('.in-tpl, .deep').length + ':' + document.getElementById('inner')"), '0:null',
    'parsed template contents are not part of the document');
  assert.strictEqual(e.run("tpl.content.querySelectorAll('.in-tpl').length + ':' + tpl.childNodes.length + ':' + tpl.content.ownerDocument.nodeType"), '1:0:9');
  assert.strictEqual(e.run("tpl.content.getElementById('inner').content.firstChild.className"), 'deep');
  if (!fallback) {
    // (the JS-only fallback cannot make native serialization see nested template contents)
    assert.strictEqual(e.run('tpl.innerHTML'), '<p class="in-tpl">T<template id="inner"><i class="deep">d</i></template></p>');
    assert.strictEqual(e.run("document.getElementById('wrap').innerHTML"), '<template id="tpl"><p class="in-tpl">T<template id="inner"><i class="deep">d</i></template></p></template>',
      'serialization of ancestors includes template contents');
  }
  e.run("var c = tpl.cloneNode(true); tpl.innerHTML = '<b>new</b>';");
  assert.strictEqual(e.run("c.content.querySelector('.in-tpl').textContent + ':' + tpl.content.firstChild.localName + ':' + tpl.innerHTML"), 'T:b:<b>new</b>');
  e.run("var d = document.createElement('div'); d.innerHTML = '<template><span class=\"x\"></span></template>'; document.body.appendChild(d);");
  assert.strictEqual(e.run("document.querySelectorAll('span.x').length + ':' + d.firstChild.content.childNodes.length"), '0:1', 'innerHTML-created templates are inert');
  e.run("var pd = new DOMParser().parseFromString('<template id=\"pt\"><u>u</u></template><p>x</p>', 'text/html')");
  assert.strictEqual(e.run("pd.querySelectorAll('u').length + ':' + pd.getElementById('pt').content.firstChild.localName"), '0:u');
  e.run("var cf = document.createRange().createContextualFragment('<template><em>e</em></template>')");
  assert.strictEqual(e.run("cf.querySelectorAll('em').length + ':' + cf.firstChild.content.firstChild.localName"), '0:em');
  assert.deepStrictEqual(e.errors(), []);
}

test('template contents: native content fragments (parser puts contents into the fragment)', async () => {
  await templateChecks({}, false);
});
test('template contents: native N.templateContent, contents parsed as children (JS extracts them)', async () => {
  await templateChecks({ legacyTemplates: true }, false);
});
test('template contents: no N.templateContent (JS-side fragments)', async () => {
  await templateChecks({ noTemplateSupport: true }, true);
});

const FOCUS_PAGE = '<!DOCTYPE html><html><head></head><body><input id="txt"><button id="btn">b</button></body></html>';
async function focusSequence(opts) {
  const e = await createEnv(Object.assign({ html: FOCUS_PAGE }, opts));
  e.run(`
    window.__log = [];
    for (const id of ['txt', 'btn']) for (const t of ['focus', 'blur', 'focusin', 'focusout'])
      document.getElementById(id).addEventListener(t, (ev) => __log.push(id + ':' + t + ':' + (ev.relatedTarget ? ev.relatedTarget.id : null) + ':' + ev.isTrusted + ':' + (ev instanceof FocusEvent)));
    document.getElementById('txt').focus();
    document.getElementById('btn').focus();
    document.getElementById('btn').focus();
    document.getElementById('btn').blur();
  `);
  return arr(e.run('__log'));
}

test('focus events: fired once whether N.focus/N.blur dispatch them (Rust) or not', async () => {
  const expected = ['txt:focus:null:true:true', 'txt:focusin:null:true:true', 'txt:blur:btn:true:true', 'txt:focusout:btn:true:true',
    'btn:focus:txt:true:true', 'btn:focusin:txt:true:true', 'btn:blur:null:true:true', 'btn:focusout:null:true:true'];
  assert.deepStrictEqual(await focusSequence({}), expected);
  assert.deepStrictEqual(await focusSequence({ nativeFocusEvents: true }), expected);
});

test('hooks: onError, onUnhandledRejection / onRejectionHandled, onElementEvent, native submit with submitterId', async () => {
  const e = await createEnv({ html: '<!DOCTYPE html><html><head></head><body><form id="f"><button id="b">go</button></form><img id="im" src="/a.png"></body></html>' });
  e.run(`
    window.__h = [];
    window.onerror = (msg, file, line, col, err) => { __h.push(['onerror', msg, file, line, col, err && err.message].join('|')); return true; };
    addEventListener('unhandledrejection', (ev) => { __h.push('unhandled:' + ev.reason + ':' + (ev.promise instanceof Promise) + ':' + ev.cancelable); if (ev.reason === 'quiet') ev.preventDefault(); });
    addEventListener('rejectionhandled', (ev) => __h.push('handled:' + ev.reason));
    var im = document.getElementById('im');
    im.onload = (ev) => __h.push('img-load:' + ev.isTrusted + ':' + im.complete);
    im.addEventListener('error', () => __h.push('img-error'));
    document.getElementById('f').addEventListener('submit', (ev) => { __h.push('submit:' + (ev instanceof SubmitEvent) + ':' + (ev.submitter && ev.submitter.id)); ev.preventDefault(); });
  `);
  const logsBefore = e.logs.length;
  e.run("window.__err = new TypeError('from rust')");
  e.hook('onError', 'Uncaught TypeError: from rust', 'https://example.com/app.js', 12, 5, e.run('__err'));
  assert.deepStrictEqual(arr(e.run('__h')), ['onerror|Uncaught TypeError: from rust|https://example.com/app.js|12|5|from rust']);
  assert.strictEqual(e.logs.length, logsBefore, 'onError does not log again (Rust already did)');
  e.run('__h = []');
  e.hook('onUnhandledRejection', e.run('Promise.reject(1).catch(() => {}) && Promise.resolve()'), 'loud');
  e.hook('onUnhandledRejection', e.run('Promise.resolve()'), 'quiet');
  e.hook('onRejectionHandled', e.run('Promise.resolve()'), 'loud');
  assert.deepStrictEqual(arr(e.run('__h')), ['unhandled:loud:true:true', 'unhandled:quiet:true:true', 'handled:loud']);
  assert.strictEqual(e.errors().filter((m) => m.startsWith('Uncaught (in promise)')).length, 1, 'only the not-prevented rejection is logged');
  e.run('__h = []');
  e.hook('onElementEvent', e.id('#im'), 'load');
  e.hook('onElementEvent', e.id('#im'), 'error');
  const path = e.mock.arr(e.pathOf(e.id('#f')));
  const flags = e.hook('onEvent', 'submit', e.id('#f'), path, { bubbles: true, cancelable: true, submitterId: e.id('#b') });
  assert.deepStrictEqual(arr(e.run('__h')), ['img-load:true:true', 'img-error', 'submit:true:b']);
  assert.strictEqual(flags & 1, 1);
});

test('history: Rust-driven fragment navigation and traversal through onPopState', async () => {
  const e = await createEnv({ url: 'https://example.com/page' });
  const M = e.mock;
  const rustNavigate = (url) => { // what Rust does for a link click to a same-document fragment
    M.url = url;
    M.hist.splice(M.histIndex + 1);
    M.hist.push({ url });
    M.histIndex++;
    M.hooks.onPopState(url, M.histIndex);
  };
  e.run(`
    window.__h = [];
    addEventListener('popstate', (ev) => __h.push('pop:' + JSON.stringify(ev.state) + ':' + location.hash));
    addEventListener('hashchange', (ev) => __h.push('hash:' + ev.oldURL.split('/').pop() + '>' + ev.newURL.split('/').pop()));
    history.pushState({ a: 1 }, '', '#x');
  `);
  rustNavigate('https://example.com/page#y');
  await e.flush();
  assert.deepStrictEqual(arr(e.run('__h')), ['pop:null:#y', 'hash:page#x>page#y']);
  assert.strictEqual(e.run('history.length + ":" + JSON.stringify(history.state)'), '3:null');
  e.run('__h = []; history.back()');
  await e.flush();
  assert.deepStrictEqual(arr(e.run('__h')), ['pop:{"a":1}:#x', 'hash:page#y>page#x']);
  // back again, then a new fragment navigation replaces the forward entries: the stale
  // state stored for that index must not leak into the new entry
  e.run('__h = []; history.back()');
  await e.flush();
  rustNavigate('https://example.com/page#z');
  await e.flush();
  assert.deepStrictEqual(arr(e.run('__h')), ['pop:null:', 'hash:page#x>page', 'pop:null:#z', 'hash:page>page#z']);
  assert.strictEqual(e.run('JSON.stringify(history.state) + ":" + history.length'), 'null:2');
});

test('location.hash / same-document navigation scrolls to the fragment', async () => {
  const e = await createEnv({ html: '<!DOCTYPE html><html><head></head><body><div id="top-x">a</div><a name="named">n</a><h2 id="sec 2">s</h2></body></html>' });
  e.run("location.hash = 'top-x'");
  e.run("location.href = '#named'");
  e.run("location.hash = '#sec%202'");
  assert.deepStrictEqual(e.mock.scrolledIntoView, [e.id('#top-x'), e.id('a[name=named]'), e.id('h2')]);
  e.mock.vp.sy = 300;
  e.run("location.hash = 'top'");
  assert.strictEqual(e.mock.vp.sy, 0, '#top scrolls to the top');
  assert.deepStrictEqual(e.mock.navigations, [], 'same-document navigations never reach N.navigate');
});

test('fetch/XHR/scripts pass credentials, cache and redirect modes to N.fetch; manual redirects', async () => {
  const e = await createEnv({
    html: '<!DOCTYPE html><html><head><script src="/plain.js"></script><script src="https://cdn.example.org/anon.js" crossorigin></script><script src="/cred.js" crossorigin="use-credentials"></script></head><body></body></html>',
    routes: {
      'https://example.com/plain.js': '1', 'https://cdn.example.org/anon.js': { body: '2', headers: { 'Access-Control-Allow-Origin': '*' } }, 'https://example.com/cred.js': '3',
      'https://example.com/moved': { status: 302, statusText: 'Found', headers: { Location: '/elsewhere' }, body: '' },
      'https://example.com/data': { body: 'ok' },
    },
  });
  const byUrl = (u) => e.requests.find((r) => r.url.endsWith(u));
  assert.deepStrictEqual([byUrl('/plain.js').credentials, byUrl('/anon.js').credentials, byUrl('/cred.js').credentials], ['include', 'same-origin', 'include']);
  assert.deepStrictEqual([byUrl('/plain.js').mode, byUrl('/anon.js').mode], ['no-cors', 'cors']);
  e.run(`
    window.__r = [];
    fetch('/data', { credentials: 'omit', cache: 'no-store' }).then((r) => r.text()).then((t) => __r.push('data:' + t));
    fetch('/moved', { redirect: 'manual' }).then((r) => __r.push('manual:' + r.type + ':' + r.status + ':' + r.url + ':' + r.ok));
    fetch('/moved', { redirect: 'error' }).then(() => __r.push('error-mode resolved!'), (err) => __r.push('error-mode:' + err.name));
    var x = new XMLHttpRequest(); x.open('GET', '/data'); x.withCredentials = true; x.send();
    navigator.sendBeacon('/beacon', 'b');
  `);
  await e.flush();
  assert.deepStrictEqual(arr(e.run('__r')).sort(), ['data:ok', 'error-mode:TypeError', 'manual:opaqueredirect:0:https://example.com/moved:false']);
  const data = e.requests.filter((r) => r.url === 'https://example.com/data');
  assert.deepStrictEqual(data.map((r) => [r.credentials, r.cache, r.redirect].join()).sort(), ['include,default,follow', 'omit,no-store,follow']);
  assert.deepStrictEqual([byUrl('/moved').redirect, byUrl('/beacon').credentials], ['manual', 'include']);
  e.run("var sx = new XMLHttpRequest(); sx.open('GET', '/data', false); sx.withCredentials = true; sx.send();");
  assert.strictEqual(e.requests.filter((r) => r.sync).map((r) => r.credentials).join(), 'include');
});

test(':indeterminate is mirrored to the native (N.setIndeterminate); a click clears it', async () => {
  const e = await createEnv({ html: '<!DOCTYPE html><html><head></head><body><input id="cb" type="checkbox"></body></html>' });
  e.run("var cb = document.getElementById('cb'); cb.indeterminate = true;");
  assert.strictEqual(e.run("document.querySelector(':indeterminate') === cb && cb.indeterminate"), true);
  e.click('#cb');
  assert.strictEqual(e.run("cb.indeterminate + ':' + cb.checked + ':' + document.querySelectorAll(':indeterminate').length"), 'false:true:0');
  e.run("cb.indeterminate = true; cb.addEventListener('click', (ev) => ev.preventDefault(), { once: true })");
  e.click('#cb');
  assert.strictEqual(e.run("cb.indeterminate + ':' + cb.checked"), 'true:true', 'a canceled click restores indeterminate');
});

test('doctype: recreated for documents whose native parser drops it (main document, DOMParser, clones)', async () => {
  const e = await createEnv();
  assert.strictEqual(e.run("[document.doctype.name, document.doctype.nodeType, document.firstChild === document.doctype, document.childNodes.length, document.compatMode, document.doctype.nextSibling === document.documentElement].join()"),
    'html,10,true,2,CSS1Compat,true');
  assert.strictEqual(e.run("new XMLSerializer().serializeToString(document.doctype) + ':' + (document.doctype instanceof DocumentType)"), '<!DOCTYPE html>:true');
  const legacy = await createEnv({ html: '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html><head></head><body></body></html>' });
  assert.strictEqual(legacy.run('document.doctype.publicId + "|" + document.doctype.systemId'), '-//W3C//DTD XHTML 1.0 Strict//EN|http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd');
  const quirks = await createEnv({ html: '<html><head></head><body></body></html>' });
  assert.strictEqual(quirks.run('document.doctype + ":" + document.compatMode'), 'null:BackCompat');
  const noNative = await createEnv({ html: '<html><head></head><body></body></html>', disable: ['doctype'] });
  assert.strictEqual(noNative.run('document.doctype.name + ":" + document.compatMode'), 'html:CSS1Compat', 'without N.doctype, <!DOCTYPE html> is assumed');
  assert.strictEqual(e.run(`(() => {
    const p = new DOMParser();
    const a = p.parseFromString('<!-- c --><!doctype HTML SYSTEM "about:legacy-compat"><p>x</p>', 'text/html');
    const b = p.parseFromString('<p>x</p>', 'text/html');
    const c = document.implementation.createHTMLDocument('t');
    const d = document.cloneNode(true), s = document.cloneNode(false);
    const dt = document.implementation.createDocumentType('svg', 'pub', 'sys').cloneNode();
    return [a.doctype.name, a.doctype.systemId, b.doctype, c.doctype.name, c.firstChild.nodeType, c.title,
      d.childNodes.length, d.doctype.name, d.documentElement.localName, d.doctype !== document.doctype, s.childNodes.length,
      dt.nodeType + dt.name + dt.publicId + dt.systemId].join();
  })()`), 'html,about:legacy-compat,,html,10,t,2,html,html,true,0,10svgpubsys');
  assert.deepStrictEqual(e.errors(), []);
});
