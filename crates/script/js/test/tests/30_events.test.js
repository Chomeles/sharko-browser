'use strict';
const assert = require('assert');
const { createEnv } = require('../harness');

const HTML = `<!DOCTYPE html><html><body><div id="outer"><button id="btn">Go <span id="inner">!</span></button>
  <a id="cancel" href="/x" onclick="window.__inline = [this.id, event.type, typeof id, title]; return false" title="T">x</a>
  <form id="f" action="/submit"><label id="lab" for="cb">Check</label><input type="checkbox" id="cb" name="cb">
    <label id="lab2">Wrapped <input type="radio" name="r" value="1" id="r1"></label><input type="radio" name="r" value="2" id="r2" checked>
    <input id="txt" name="q" value="v"><button id="sub" type="submit">Send</button></form></div></body></html>`;

test('capture/target/bubble order incl. document and window; composedPath; phases', async () => {
  const e = await createEnv({ html: HTML });
  e.run(`
    window.__log = [];
    const L = (name) => (ev) => __log.push(name + ':' + ev.eventPhase + ':' + (ev.currentTarget === window ? 'win' : ev.currentTarget.nodeName || ev.currentTarget.id));
    window.addEventListener('click', L('win-c'), true);
    document.addEventListener('click', L('doc-c'), true);
    document.getElementById('outer').addEventListener('click', L('outer-c'), { capture: true });
    document.getElementById('btn').addEventListener('click', L('btn-bubble'));
    document.getElementById('btn').addEventListener('click', L('btn-capture'), true);
    document.getElementById('outer').addEventListener('click', L('outer-b'));
    document.addEventListener('click', L('doc-b'));
    window.addEventListener('click', (ev) => { __log.push('win-b:' + ev.eventPhase + ':' + ev.target.id + ':' + ev.composedPath().length + ':' + ev.isTrusted + ':' + (window.event === ev)); });
  `);
  const flags = e.click('#btn');
  assert.strictEqual(flags & 3, 0);
  assert.deepStrictEqual(Array.from(e.run('__log')), [
    'win-c:1:win', 'doc-c:1:#document', 'outer-c:1:DIV', 'btn-capture:2:BUTTON', 'btn-bubble:2:BUTTON',
    'outer-b:3:DIV', 'doc-b:3:#document', 'win-b:3:btn:6:true:true',
  ]);
  assert.strictEqual(e.run('window.event'), undefined);
  e.run("__log = []; document.getElementById('inner').dispatchEvent(new Event('click', { bubbles: false }))");
  assert.deepStrictEqual(Array.from(e.run('__log')), ['win-c:1:win', 'doc-c:1:#document', 'outer-c:1:DIV', 'btn-capture:1:BUTTON']);
});

test('once, passive, signal, handleEvent, duplicates, removal', async () => {
  const e = await createEnv({ html: HTML });
  e.run(`
    window.__log = [];
    var b = document.getElementById('btn');
    var f = () => __log.push('dup');
    b.addEventListener('x', f); b.addEventListener('x', f); b.addEventListener('x', f, true);
    b.addEventListener('x', () => __log.push('once'), { once: true });
    b.addEventListener('x', (ev) => { ev.preventDefault(); __log.push('passive:' + ev.defaultPrevented); }, { passive: true });
    var ac = new AbortController();
    b.addEventListener('x', () => __log.push('signal'), { signal: ac.signal });
    b.addEventListener('x', { handleEvent(ev) { __log.push('handleEvent:' + (this !== b)); } });
    b.addEventListener('x', null);
    var r1 = b.dispatchEvent(new Event('x', { cancelable: true }));
    ac.abort();
    b.removeEventListener('x', f, true);
    var r2 = b.dispatchEvent(new Event('x', { cancelable: true }));
  `);
  assert.deepStrictEqual(Array.from(e.run('__log')), [
    'dup', 'dup', 'once', 'passive:false', 'signal', 'handleEvent:true', 'dup', 'passive:false', 'handleEvent:true',
  ]);
  assert.strictEqual(e.run('r1 && r2'), true);
  assert.strictEqual(e.run("(() => { try { b.addEventListener('x', 5) } catch (err) { return err instanceof TypeError } })()"), true);
  e.run("var ac2 = AbortController ? new AbortController() : null; ac2.abort('why'); b.addEventListener('y', () => __log.push('never'), { signal: ac2.signal }); b.dispatchEvent(new Event('y'))");
  assert.strictEqual(e.run("__log.includes('never') + ':' + ac2.signal.reason + ':' + ac2.signal.aborted"), 'false:why:true');
  assert.strictEqual(e.run("var tw = 0; addEventListener('wheel', (ev) => { ev.preventDefault(); tw = ev.defaultPrevented; }); dispatchEvent(new WheelEvent('wheel', { cancelable: true })); tw"), false, 'wheel on window is passive by default');
});

test('stopPropagation, stopImmediatePropagation, cancelBubble, preventDefault flags', async () => {
  const e = await createEnv({ html: HTML });
  e.run(`
    window.__log = [];
    var btn = document.getElementById('btn');
    btn.addEventListener('click', (ev) => { __log.push('a'); ev.stopImmediatePropagation(); });
    btn.addEventListener('click', () => __log.push('b'));
    document.getElementById('outer').addEventListener('click', () => __log.push('outer'));
  `);
  assert.strictEqual(e.click('#btn') & 2, 2);
  assert.deepStrictEqual(Array.from(e.run('__log')), ['a']);
  e.run(`__log = []; document.getElementById('inner').addEventListener('click', (ev) => { ev.cancelBubble = true; ev.preventDefault(); __log.push('inner:' + ev.defaultPrevented + ':' + ev.returnValue); });`);
  const flags = e.click('#inner');
  assert.strictEqual(flags & 3, 3);
  assert.deepStrictEqual(Array.from(e.run('__log')), ['inner:true:false']);
  e.run("var ev = document.createEvent('Event'); ev.initEvent('custom', true, true); var ok = document.body.dispatchEvent(ev);");
  assert.strictEqual(e.run('ok && ev.type === "custom" && ev.bubbles && ev.eventPhase === 0 && ev.target === document.body && ev.srcElement === document.body && ev.composedPath().length === 0'), true);
});

test('inline on* attributes and IDL handlers', async () => {
  const e = await createEnv({ html: HTML });
  const flags = e.click('#cancel');
  assert.strictEqual(flags & 1, 1, 'return false cancels');
  assert.deepStrictEqual(Array.from(e.run('__inline')), ['cancel', 'click', 'string', 'T'], 'this, event, with-scope (element props)');
  assert.strictEqual(e.run("typeof document.getElementById('cancel').onclick"), 'function');
  e.run(`
    window.__log = [];
    var b = document.getElementById('btn');
    b.addEventListener('click', () => __log.push('listener1'));
    b.onclick = () => __log.push('idl');
    b.addEventListener('click', () => __log.push('listener2'));
    b.onclick = function (ev) { __log.push('idl2:' + (this === b)); };
    b.click();
    b.onclick = null;
    b.click();
    b.setAttribute('onclick', "__log.push('attr:' + event.isTrusted)");
    b.click();
    b.removeAttribute('onclick');
    b.click();
  `);
  assert.deepStrictEqual(Array.from(e.run('__log')), ['listener1', 'idl2:true', 'listener2', 'listener1', 'listener2', 'listener1', 'listener2', 'attr:false', 'listener1', 'listener2']);
  e.run("var d = document.createElement('div'); d.setAttribute('onclick', 'return 1 +'); window.__errs = 0; addEventListener('error', () => __errs++); d.click(); var h = d.onclick;");
  assert.strictEqual(e.run('__errs + ":" + h'), '1:null', 'syntax errors in handlers are reported');
  e.run("document.body.innerHTML += '<i id=ih onmouseover=\"window.__mo = event.clientX\">x</i>'");
  e.event('mouseover', '#ih', { bubbles: true, cancelable: true, clientX: 42 });
  assert.strictEqual(e.run('window.__mo'), 42);
  e.run("window.onmessage = (ev) => { window.__msg = ev.data + ':' + ev.origin + ':' + (ev.source === window); }; postMessage({v: 7}, '*'); ");
  await e.flush();
  assert.strictEqual(e.run('window.__msg'), '[object Object]:https://example.com:true');
  e.run("document.body.onload = () => { window.__bodyonload = 1; }");
  assert.strictEqual(e.run('typeof window.onload'), 'function', 'body.onload reflects window.onload');
});

test('event classes, init dictionaries, native event construction', async () => {
  const e = await createEnv({ html: HTML });
  assert.strictEqual(e.run("[PointerEvent, MouseEvent, UIEvent, Event].every(C => new PointerEvent('pointerdown') instanceof C)"), true);
  assert.strictEqual(e.run("var m = new MouseEvent('click', { clientX: 3, clientY: 4, button: 2, buttons: 2, ctrlKey: true, relatedTarget: document.body, bubbles: true }); [m.clientX, m.y, m.button, m.buttons, m.ctrlKey, m.getModifierState('Control'), m.relatedTarget === document.body, m.which, m.bubbles, m.cancelable, m.detail].join()"), '3,4,2,2,true,true,true,3,true,false,0');
  assert.strictEqual(e.run("var k = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', shiftKey: true, repeat: true }); [k.key, k.code, k.shiftKey, k.repeat, k.keyCode, k.location].join()"), 'a,KeyA,true,true,0,0');
  assert.strictEqual(e.run("[new WheelEvent('wheel', { deltaY: 100, deltaMode: 1 }).deltaY, WheelEvent.DOM_DELTA_LINE, new FocusEvent('focus', { relatedTarget: document.body }).relatedTarget === document.body, new InputEvent('input', { data: 'x', inputType: 'insertText' }).inputType, new CustomEvent('c', { detail: { a: 1 } }).detail.a, new ErrorEvent('error', { message: 'm', lineno: 5 }).lineno, new ProgressEvent('progress', { loaded: 5, total: 10, lengthComputable: true }).loaded, new MessageEvent('message', { data: 1, origin: 'o' }).origin, new PopStateEvent('popstate', { state: 's' }).state, new HashChangeEvent('hashchange', { newURL: 'n' }).newURL, new SubmitEvent('submit', { submitter: null }).submitter, new TouchEvent('touchstart').touches.length, new PointerEvent('pointerup', { pointerType: 'pen', pressure: 0.5 }).pointerType].join()"), '100,1,true,insertText,1,5,5,o,s,n,,0,pen');
  assert.strictEqual(e.run("(() => { try { new Event() } catch (x) { return x instanceof TypeError } })()"), true);
  assert.strictEqual(e.run("class MyEv extends Event { constructor() { super('my', { bubbles: true }); this.extra = 1; } }; var me = new MyEv(); me.type + me.bubbles + me.extra + (me instanceof Event)"), 'mytrue1true');
  assert.strictEqual(e.run("class Emitter extends EventTarget { fire() { return this.dispatchEvent(new CustomEvent('go', { detail: 9 })); } }; var em = new Emitter(); var got; em.addEventListener('go', (ev) => { got = ev.detail + ':' + (ev.target === em); }); em.fire(); got"), '9:true');
  e.run(`window.__k = []; addEventListener('keydown', (ev) => __k.push(ev.key, ev.code, ev.keyCode, ev.which, ev instanceof KeyboardEvent, ev.isTrusted)); addEventListener('keypress', (ev) => __k.push(ev.charCode))`);
  e.event('keydown', '#txt', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
  e.event('keydown', '#txt', { key: 'b', code: 'KeyB', bubbles: true, cancelable: true });
  e.event('keypress', '#txt', { key: 'b', code: 'KeyB', bubbles: true, cancelable: true });
  assert.deepStrictEqual(Array.from(e.run('__k')), ['Enter', 'Enter', 13, 13, true, true, 'b', 'KeyB', 66, 66, true, true, 98]);
  e.run("window.__t = []; document.getElementById('btn').addEventListener('mousedown', (ev) => __t.push(ev.target.id, ev.offsetX, ev.pageX, ev.relatedTarget && ev.relatedTarget.id))");
  const textId = e.node('#btn').children[0];
  e.mock.hooks.onEvent('mousedown', textId, e.mock.arr(e.pathOf(textId)), { clientX: 7, pageX: 70, offsetX: 1, relatedTargetId: e.id('#outer') });
  assert.deepStrictEqual(Array.from(e.run('__t')), ['btn', 1, 70, 'outer'], 'text node target is retargeted to its parent element');
  e.run("window.__enter = []; document.getElementById('outer').addEventListener('mouseenter', (ev) => __enter.push(ev.target.id)); document.body.addEventListener('mouseenter', () => __enter.push('body'))");
  e.event('mouseenter', '#outer', {});
  assert.deepStrictEqual(Array.from(e.run('__enter')), ['outer'], 'mouseenter does not bubble by default');
});

test('click activation: checkbox, radio, label, submit button, reset; flag 4', async () => {
  const e = await createEnv({ html: HTML });
  e.run(`
    window.__log = [];
    var cb = document.getElementById('cb');
    cb.addEventListener('click', (ev) => __log.push('click:' + cb.checked));
    cb.addEventListener('input', () => __log.push('input:' + cb.checked));
    cb.addEventListener('change', () => __log.push('change:' + cb.checked));
  `);
  const flags = e.click('#cb');
  assert.strictEqual(flags & 4, 4, 'JS performed the activation');
  assert.deepStrictEqual(Array.from(e.run('__log')), ['click:true', 'input:true', 'change:true']);
  e.run("__log = []; cb.addEventListener('click', (ev) => ev.preventDefault(), { once: true });");
  e.click('#cb');
  assert.deepStrictEqual(Array.from(e.run('__log')), ['click:false']);
  assert.strictEqual(e.run('cb.checked'), true, 'canceled click restores state');
  e.run('__log = []');
  e.click('#lab');
  assert.deepStrictEqual(Array.from(e.run('__log')), ['click:false', 'input:false', 'change:false'], 'label forwards click to control');
  e.run("__log = []; document.getElementById('r1').addEventListener('change', () => __log.push('r1:' + document.getElementById('r1').checked + document.getElementById('r2').checked))");
  e.click('#lab2');
  assert.deepStrictEqual(Array.from(e.run('__log')), ['r1:truefalse'], 'radio group exclusivity');
  e.run("document.getElementById('f').addEventListener('submit', (ev) => { __log.push('submit:' + (ev.submitter && ev.submitter.id) + ':' + (ev instanceof SubmitEvent)); })");
  e.click('#sub');
  assert.deepStrictEqual(e.mock.submissions, [[e.id('#f'), e.id('#sub')]]);
  e.run("document.getElementById('f').addEventListener('submit', (ev) => ev.preventDefault())");
  e.click('#sub');
  assert.strictEqual(e.mock.submissions.length, 1, 'preventDefault on submit stops submission');
  e.run('document.getElementById("sub").click()');
  assert.strictEqual(e.mock.submissions.length, 1);
  assert.strictEqual(e.run("__log.filter(x => x.startsWith('submit')).join()"), 'submit:sub:true,submit:sub:true,submit:sub:true');
  // links: native -> Rust follows (no flag 4), synthetic -> N.runDefaultAction
  e.run("var a = document.createElement('a'); a.href = '/next'; a.id = 'nx'; document.body.appendChild(a);");
  assert.strictEqual(e.click('#nx') & 4, 0);
  e.run('a.click()');
  assert.deepStrictEqual(e.mock.defaultActions, [[e.id('#nx'), 'click']]);
  e.run("document.getElementById('txt').value = 'changed'; document.getElementById('f').reset()");
  assert.strictEqual(e.run("document.getElementById('txt').value + document.getElementById('r2').checked + cb.checked"), 'vtruefalse');
});

test('focus management and implicit submission', async () => {
  const e = await createEnv({ html: HTML });
  e.run(`
    window.__log = [];
    for (const id of ['txt', 'btn']) for (const t of ['focus', 'blur', 'focusin', 'focusout']) document.getElementById(id).addEventListener(t, (ev) => __log.push(id + ':' + t + ':' + (ev.relatedTarget ? ev.relatedTarget.id : null)));
    document.getElementById('txt').focus();
    var a1 = document.activeElement.id;
    document.getElementById('btn').focus();
    document.getElementById('btn').blur();
  `);
  assert.deepStrictEqual(Array.from(e.run('__log')), ['txt:focus:null', 'txt:focusin:null', 'txt:blur:btn', 'txt:focusout:btn', 'btn:focus:txt', 'btn:focusin:txt', 'btn:blur:null', 'btn:focusout:null']);
  assert.strictEqual(e.run('a1 + document.activeElement.localName'), 'txtbody');
  e.run("document.getElementById('f').addEventListener('submit', () => __log.push('submit'))");
  const flags = e.event('keydown', '#txt', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
  assert.strictEqual(flags & 4, 4);
  assert.strictEqual(e.mock.submissions.length, 1);
  assert.strictEqual(e.run("__log[__log.length - 1]"), 'submit');
});

test('listener exceptions are reported and do not stop dispatch', async () => {
  const e = await createEnv({ html: HTML });
  e.run(`
    window.__log = [];
    addEventListener('error', (ev) => __log.push('reported:' + ev.error.message));
    document.body.addEventListener('ping', () => { throw new Error('bad listener'); });
    document.body.addEventListener('ping', () => __log.push('second'));
    document.body.dispatchEvent(new Event('ping'));
  `);
  assert.deepStrictEqual(Array.from(e.run('__log')), ['reported:bad listener', 'second']);
  assert.strictEqual(e.errors().some((m) => m.includes('bad listener')), true, 'logged via N.log');
});
