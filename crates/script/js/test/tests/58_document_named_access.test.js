'use strict';
// Named access on Document (HTML "dom-document-nameditem"): document.<name> for forms, images,
// embeds, objects and iframes; live, in tree order, real properties win.
const assert = require('assert');
const { createEnv } = require('../harness');

test('document named access: which elements contribute which names', async () => {
  const e = await createEnv({
    html: `<form name="loginForm" id="lf"><input name="q"></form><form id="onlyId"></form>
      <img name="im" id="imId"><img id="imIdOnly"><img id="emptyName" name="">
      <object id="obj"></object><object name="objName"></object><embed name="em"><embed id="emId">
      <iframe name="fr"></iframe><iframe id="frId"></iframe><div id="divId" name="divName"></div>
      <input name="inp"><a name="anchor"></a><applet name="ap"></applet>`,
  });
  const check = (name) => e.run(`typeof document[${JSON.stringify(name)}]`);
  // the case from the report: legacy `document.formName.submit()` (bing's login.live.com)
  assert.strictEqual(e.run("document.loginForm === document.getElementById('lf')"), true);
  assert.strictEqual(e.run("document.loginForm === document.forms.loginForm && 'loginForm' in document"), true);
  // forms, embeds and iframes by name only; objects by name and id; images by name, and by id when named
  for (const n of ['loginForm', 'im', 'imId', 'obj', 'objName', 'em', 'fr']) assert.strictEqual(check(n), 'object', n);
  for (const n of ['onlyId', 'imIdOnly', 'emptyName', 'emId', 'frId', 'divId', 'divName', 'inp', 'anchor', 'ap', 'q', '', 'nope']) assert.strictEqual(check(n), 'undefined', n);
  assert.strictEqual(e.run("document.im === document.imId && document.im === document.images[0]"), true);
  assert.strictEqual(e.run("'onlyId' in document || 'divId' in document"), false);
});

test('document named access: one element, several elements (a live collection), dynamic changes', async () => {
  const e = await createEnv({
    html: '<div id="root"><form name="dup"></form><img name="dup"><img id="mix"><img name="mix"><img name="solo"></div>',
  });
  assert.strictEqual(e.run("document.solo.tagName"), 'IMG');
  // several named elements: an HTMLCollection in tree order, the same object each time, live
  e.run('var c = document.dup');
  assert.strictEqual(e.run("[Object.prototype.toString.call(c), c.length, c[0].tagName, c[1].tagName, c === document.dup].join()"), '[object HTMLCollection],2,FORM,IMG,true');
  e.run("document.getElementById('root').insertAdjacentHTML('afterbegin', '<embed name=dup>')");
  assert.strictEqual(e.run("[c.length, c[0].tagName, document.dup === c].join()"), '3,EMBED,true');
  // an <img id> without a name is no named element, so `mix` names just the second one
  assert.strictEqual(e.run("document.mix === document.getElementsByTagName('img')[1] || document.mix.name"), 'mix');
  // removing elements shrinks the collection, down to one element and then to nothing
  e.run("document.querySelector('embed').remove(); document.forms[0].remove()");
  assert.strictEqual(e.run("document.dup.tagName"), 'IMG');
  e.run("document.querySelector('img[name=dup]').remove()");
  assert.strictEqual(e.run("[typeof document.dup, 'dup' in document].join()"), 'undefined,false');
  // attribute changes
  e.run("var s = document.querySelector('img[name=solo]'); s.name = 'other'");
  assert.strictEqual(e.run("[typeof document.solo, document.other === s].join()"), 'undefined,true');
  e.run("s.id = 'sid'");
  assert.strictEqual(e.run("[document.sid === s, document.other === s].join()"), 'true,true');
  e.run("s.removeAttribute('name')");
  assert.strictEqual(e.run("[typeof document.sid, typeof document.other].join()"), 'undefined,undefined');
});

test('document named access: real properties win, assignment shadows, other documents', async () => {
  const e = await createEnv({
    html: '<form name="body"></form><img name="cookie"><form name="getElementById"></form><form name="nodeType"></form><form name="location"></form><form name="free"></form>',
  });
  // (the specification lets named elements replace built-ins; here they never do)
  assert.strictEqual(e.run("[document.body.tagName, typeof document.cookie, typeof document.getElementById, document.nodeType, document.location === location].join()"), 'BODY,string,function,9,true');
  assert.strictEqual(e.run("[document.free.tagName, 'free' in document, 'body' in document].join()"), 'FORM,true,true');
  assert.strictEqual(e.run("Object.keys(document).includes('free')"), false);
  // setting the name creates an own property, which then wins
  e.run("document.free = 42");
  assert.strictEqual(e.run("document.free"), 42);
  // Document.prototype still reaches Node.prototype, and Symbols, `then` and friends pass through
  assert.strictEqual(e.run("[document instanceof Node, Node.prototype.isPrototypeOf(document), Object.prototype.toString.call(document), document.then, document[Symbol.iterator]].join()"), 'true,true,[object HTMLDocument],,');
  // documents made by script have named access too, scoped to their own tree
  assert.strictEqual(e.run(`
    var d = document.implementation.createHTMLDocument('t'); d.body.innerHTML = '<form name=inner></form>';
    var p = new DOMParser().parseFromString('<img name=parsed>', 'text/html');
    [d.inner === d.forms[0], typeof d.free, p.parsed === p.images[0], typeof document.inner].join()`), 'true,undefined,true,undefined');
});

test('document named access: elements the parser has not reached yet are not named', async () => {
  const e = await createEnv({
    html: '<form name="earlyForm"></form><script>window.a = typeof document.lateForm + typeof document.earlyForm;</script><script>window.b = typeof document.lateForm;</script><form name="lateForm"></form>',
  });
  await e.flush();
  assert.strictEqual(e.run('[a, b, typeof document.lateForm].join()'), 'undefinedobject,undefined,object');
});
