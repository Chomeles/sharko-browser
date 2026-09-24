'use strict';
// Custom elements, the shadow DOM approximation, forms and constraint validation.
const assert = require('assert');
const { createEnv } = require('../harness');

const arr = (v) => Array.from(v);

const CE_PAGE = '<!DOCTYPE html><html><head></head><body><x-a id="a1" foo="1"></x-a><div id="d"><x-a id="a2"></x-a></div>' +
  '<template id="t"><x-a id="intpl"></x-a></template></body></html>';
const CE_CLASS = `
  window.__ce = [];
  class XA extends HTMLElement {
    static get observedAttributes() { return ['foo', 'bar']; }
    constructor() { super(); __ce.push('ctor:' + (this.id || '(new)')); }
    connectedCallback() { __ce.push('connected:' + this.id + ':' + this.isConnected); }
    disconnectedCallback() { __ce.push('disconnected:' + this.id); }
    attributeChangedCallback(n, o, v) { __ce.push('attr:' + this.id + ':' + n + ':' + o + ':' + v); }
  }
  window.XA = XA;
`;

test('custom elements: upgrade on define (document order, not template contents), whenDefined', async () => {
  const e = await createEnv({ html: CE_PAGE });
  e.run(CE_CLASS + `
    customElements.whenDefined('x-a').then((c) => __ce.push('whenDefined:' + (c === XA)));
    __ce.push('before:' + (document.getElementById('a1') instanceof XA));
    customElements.define('x-a', XA);
    __ce.push('after:' + (document.getElementById('a1') instanceof XA) + ':' + (customElements.get('x-a') === XA) + ':' + customElements.getName(XA));
  `);
  await e.flush();
  assert.deepStrictEqual(arr(e.run('__ce')), ['before:false', 'ctor:a1', 'attr:a1:foo:null:1', 'connected:a1:true',
    'ctor:a2', 'connected:a2:true', 'after:true:true:x-a', 'whenDefined:true']);
  assert.strictEqual(e.run("document.querySelectorAll('x-a').length"), 2, 'template contents are not in the document');
  assert.strictEqual(e.run("document.getElementById('t').content.firstChild instanceof XA"), false, 'template contents are not upgraded');
  assert.strictEqual(e.run("customElements.get('x-nope') === undefined && customElements.getName(class {}) === null"), true);
  assert.deepStrictEqual(e.errors(), []);
});

test('custom elements: createElement/new, attributeChangedCallback, connected/disconnected, innerHTML', async () => {
  const e = await createEnv({ html: CE_PAGE });
  e.run(CE_CLASS + "customElements.define('x-a', XA); __ce = [];");
  e.run(`
    var el = document.createElement('x-a');
    el.id = 'c1';
    el.setAttribute('foo', 'x');
    el.setAttribute('bar', 'y');
    el.setAttribute('baz', 'z');
    document.body.appendChild(el);
    el.setAttribute('foo', 'x2');
    el.removeAttribute('bar');
    document.getElementById('d').appendChild(el);
    el.remove();
    var n2 = new XA();
    __ce.push(n2.localName + ':' + (n2 instanceof HTMLElement) + ':' + n2.isConnected);
  `);
  assert.deepStrictEqual(arr(e.run('__ce')), ['ctor:(new)', 'attr:c1:foo:null:x', 'attr:c1:bar:null:y', 'connected:c1:true',
    'attr:c1:foo:x:x2', 'attr:c1:bar:y:null', 'disconnected:c1', 'connected:c1:true', 'disconnected:c1', 'ctor:(new)', 'x-a:true:false']);
  e.run(`
    __ce = [];
    var host = document.createElement('div');
    host.innerHTML = '<x-a id="h1" foo="v"></x-a>';
    __ce.push('inner:' + (host.firstChild instanceof XA));
    document.body.appendChild(host);
  `);
  assert.deepStrictEqual(arr(e.run('__ce')), ['ctor:h1', 'attr:h1:foo:null:v', 'inner:true', 'connected:h1:true'],
    'fragment-parsed custom elements are upgraded at the end of innerHTML (not only when connected)');
  assert.strictEqual(e.run("(() => { try { new HTMLElement(); } catch (x) { return x instanceof TypeError; } })()"), true);
  assert.strictEqual(e.run("(() => { try { new HTMLDivElement(); } catch (x) { return x instanceof TypeError; } })()"), true);
  assert.deepStrictEqual(e.errors(), []);
});

test('custom elements: constructor errors, invalid definitions, customized built-ins', async () => {
  const e = await createEnv();
  e.run(`
    window.__errs = [];
    addEventListener('error', (ev) => __errs.push(ev.error && ev.error.message));
    class Bad extends HTMLElement { constructor() { super(); throw new Error('ctor boom'); } }
    customElements.define('x-bad', Bad);
    var holder = document.createElement('div');
    holder.innerHTML = '<x-bad></x-bad>';
    document.body.appendChild(holder);
    __errs.push(holder.firstChild instanceof Bad, holder.firstChild.localName);
    var b2 = document.createElement('x-bad');
    __errs.push(b2 instanceof HTMLUnknownElement, b2.localName);
  `);
  assert.deepStrictEqual(arr(e.run('__errs')), ['ctor boom', false, 'x-bad', 'ctor boom', true, 'x-bad']);
  assert.strictEqual(e.errors().filter((m) => m.includes('ctor boom')).length, 2, 'reported to the console too');
  assert.strictEqual(e.run(`(() => {
    const out = [];
    const tryIt = (f) => { try { f(); out.push('ok'); } catch (x) { out.push(x.name); } };
    tryIt(() => customElements.define('nodash', class extends HTMLElement {}));
    tryIt(() => customElements.define('x-bad', class extends HTMLElement {}));
    tryIt(() => customElements.define('x-bad2', Bad));
    tryIt(() => customElements.define('x-arrow', () => {}));
    tryIt(() => customElements.define('x-ext', class extends HTMLElement {}, { extends: 'x-other' }));
    return out.join();
  })()`), 'SyntaxError,NotSupportedError,NotSupportedError,TypeError,NotSupportedError');
  // customized built-in elements
  e.run(`
    class FancyButton extends HTMLButtonElement {
      constructor() { super(); this.dataset.fancy = '1'; }
      connectedCallback() { this.textContent = 'fancy'; }
    }
    customElements.define('fancy-button', FancyButton, { extends: 'button' });
    window.FancyButton = FancyButton;
    var fb = document.createElement('button', { is: 'fancy-button' });
    var fb2 = new FancyButton();
    document.body.insertAdjacentHTML('beforeend', '<button id="parsed" is="fancy-button"></button>');
  `);
  assert.strictEqual(e.run("fb instanceof FancyButton && fb instanceof HTMLButtonElement && fb.localName + ':' + fb.dataset.fancy + ':' + fb.outerHTML"),
    'button:1:<button is="fancy-button" data-fancy="1"></button>');
  assert.strictEqual(e.run("fb2 instanceof FancyButton && fb2.localName === 'button' && fb2.getAttribute('is')"), 'fancy-button');
  assert.strictEqual(e.run("var p = document.getElementById('parsed'); (p instanceof FancyButton) + ':' + p.textContent"), 'true:fancy');
  assert.strictEqual(e.run("(() => { class W extends HTMLDivElement {} customElements.define('wrong-base', W, { extends: 'button' }); try { new W(); } catch (x) { return x instanceof TypeError; } })()"), true);
});

test('shadow DOM approximation: attachShadow, modes, slots, custom element with shadow root', async () => {
  const e = await createEnv();
  e.run(`
    class XShadow extends HTMLElement {
      constructor() {
        super();
        this._root = this.attachShadow({ mode: 'open' });
        this._root.innerHTML = '<b>shadow</b><slot></slot><slot name="n">fallback</slot>';
      }
    }
    customElements.define('x-shadow', XShadow);
    document.body.insertAdjacentHTML('beforeend', '<x-shadow id="s1">light<i slot="n">named</i></x-shadow>');
    var s1 = document.getElementById('s1');
  `);
  assert.strictEqual(e.run("s1.shadowRoot === s1._root && s1.shadowRoot.host === s1 && s1.shadowRoot.mode"), 'open');
  assert.strictEqual(e.run("s1.shadowRoot instanceof ShadowRoot && s1.shadowRoot instanceof DocumentFragment && s1.shadowRoot.nodeType"), 11);
  // the rendered (native) tree is the composed tree: shadow content with slotted light nodes
  assert.strictEqual(e.html('#s1'), '<b>shadow</b><slot>light</slot><slot name="n"><i slot="n">named</i></slot>');
  assert.strictEqual(e.run("s1.shadowRoot.querySelector('b').textContent + ':' + (typeof s1.shadowRoot.getElementById)"), 'shadow:function');
  // light DOM insertion after the shadow root has content is distributed into the slot
  e.run("var extra = document.createElement('u'); extra.slot = 'n'; extra.textContent = 'more'; s1.appendChild(extra);");
  assert.strictEqual(e.html('#s1'), '<b>shadow</b><slot>light</slot><slot name="n"><i slot="n">named</i><u slot="n">more</u></slot>');
  assert.strictEqual(e.run("extra.parentNode !== null && s1.contains(extra)"), true);
  e.run("var cl = document.createElement('div'); var csr = cl.attachShadow({ mode: 'closed' });");
  assert.strictEqual(e.run("cl.shadowRoot === null && csr instanceof ShadowRoot && csr.mode === 'closed' && csr.host === cl"), true);
  assert.strictEqual(e.run(`(() => { const out = [];
    for (const f of [() => cl.attachShadow({ mode: 'open' }), () => document.createElement('img').attachShadow({ mode: 'open' }), () => document.createElement('div').attachShadow({ mode: 'x' })]) {
      try { f(); out.push('ok'); } catch (x) { out.push(x.name); }
    }
    return out.join(); })()`), 'NotSupportedError,NotSupportedError,TypeError');
  assert.deepStrictEqual(e.errors(), []);
});

const FORM_PAGE = `<!DOCTYPE html><html><head></head><body>
<form id="f" action="/go" method="post">
  <label id="lq" for="q">Q</label><input id="q" name="q" required>
  <input id="em" name="em" type="email" value="bad">
  <input id="num" name="num" type="number" min="2" max="10" step="2" value="3">
  <input id="pat" name="pat" pattern="[a-z]+" value="abc">
  <input id="dis" name="dis" disabled required>
  <input id="hid" type="hidden" name="h" value="hv">
  <select id="s" name="s"><option value="a">A</option><option value="b" selected>B</option><optgroup><option>C</option></optgroup></select>
  <select id="m" name="m" multiple><option value="1" selected>1</option><option value="2">2</option><option value="3" selected>3</option></select>
  <textarea id="ta" name="ta">init</textarea>
  <input id="cb" type="checkbox" name="cb" value="yes" checked>
  <button id="sb" name="act" value="save">Save</button>
  <button id="bb" type="button">B</button>
</form>
<input id="outside" form="f" name="out" value="o">
</body></html>`;

test('constraint validation: validity states, invalid events, checkValidity/reportValidity, requestSubmit', async () => {
  const e = await createEnv({ html: FORM_PAGE });
  e.run(`
    window.__inv = [];
    document.addEventListener('invalid', (ev) => __inv.push(ev.target.id + ':' + ev.cancelable + ':' + ev.bubbles), true);
    document.getElementById('f').addEventListener('submit', (ev) => __inv.push('submit:' + (ev.submitter ? ev.submitter.id : null)));
    var q = document.getElementById('q'), f = document.getElementById('f');
  `);
  assert.deepStrictEqual(arr(e.run("[q.willValidate, q.checkValidity(), q.validity.valueMissing, q.validity.valid, q.validationMessage.length > 0]")), [true, false, true, false, true]);
  assert.deepStrictEqual(arr(e.run('__inv')), ['q:true:false']);
  assert.deepStrictEqual(arr(e.run("var em = document.getElementById('em'); [em.validity.typeMismatch, em.checkValidity()]")), [true, false]);
  assert.deepStrictEqual(arr(e.run(`var num = document.getElementById('num');
    [num.validity.stepMismatch, num.valueAsNumber, (num.value = '12', num.validity.rangeOverflow), (num.value = '1', num.validity.rangeUnderflow), (num.value = 'x', num.value), (num.value = '4', num.checkValidity())]`)),
  [true, 3, true, true, '', true]);
  assert.deepStrictEqual(arr(e.run("var pat = document.getElementById('pat'); [pat.checkValidity(), (pat.value = 'ABC', pat.validity.patternMismatch)]")), [true, true]);
  assert.deepStrictEqual(arr(e.run("[document.getElementById('dis').willValidate, document.getElementById('dis').checkValidity(), document.getElementById('hid').willValidate]")), [false, true, false]);
  assert.deepStrictEqual(arr(e.run("q.setCustomValidity('nope'); [q.validity.customError, q.validationMessage, (q.setCustomValidity(''), q.validity.customError)]")), [true, 'nope', false]);
  e.run('__inv = []');
  assert.deepStrictEqual(arr(e.run('[f.checkValidity(), f.reportValidity()]')), [false, false]);
  assert.deepStrictEqual(arr(e.run('__inv')), ['q:true:false', 'em:true:false', 'pat:true:false', 'q:true:false', 'em:true:false', 'pat:true:false']);
  e.run('__inv = []; f.requestSubmit();');
  assert.deepStrictEqual(arr(e.run('__inv')), ['q:true:false', 'em:true:false', 'pat:true:false'], 'invalid form: invalid events, no submit');
  assert.strictEqual(e.mock.submissions.length, 0);
  e.run("q.value = 'x'; document.getElementById('em').value = 'a@b.c'; document.getElementById('pat').value = 'ok'; __inv = []; f.requestSubmit(document.getElementById('sb'));");
  assert.deepStrictEqual(arr(e.run('__inv')), ['submit:sb']);
  assert.deepStrictEqual(e.mock.submissions, [[e.id('#f'), e.id('#sb')]]);
  assert.strictEqual(e.run("(() => { try { f.requestSubmit(document.getElementById('bb')); } catch (x) { return x.name; } })()"), 'TypeError');
  e.run('__inv = []; f.submit();');
  assert.deepStrictEqual(arr(e.run('__inv')), [], 'form.submit() fires no submit event');
  assert.strictEqual(e.mock.submissions.length, 2);
  e.run("f.noValidate = true; q.value = ''; __inv = []; f.requestSubmit();");
  assert.deepStrictEqual(arr(e.run('__inv')), ['submit:null'], 'novalidate skips validation');
  assert.deepStrictEqual(e.errors(), []);
});

test('form controls: elements/named access, select & options, textarea, defaults, labels, FormData, reset', async () => {
  const e = await createEnv({ html: FORM_PAGE });
  e.run("var f = document.getElementById('f'), q = document.getElementById('q'), s = document.getElementById('s'), m = document.getElementById('m'), ta = document.getElementById('ta'), cb = document.getElementById('cb');");
  assert.deepStrictEqual(arr(e.run("[f.elements.length, f.length, f.elements.q === q, f.q === q, f.elements.namedItem('out').id, f.out.id, document.getElementById('outside').form === f, f.elements[0].id, f.elements instanceof HTMLFormControlsCollection]")),
    [13, 13, true, true, 'outside', 'outside', true, 'q', true]);
  assert.deepStrictEqual(arr(e.run("[s.selectedIndex, s.value, s.options.length, s.length, s.options[2].text, (s.value = 'a', s.selectedIndex), s.selectedOptions.length, s.type, (s.selectedIndex = 2, s.value), s[1].value]")),
    [1, 'b', 3, 3, 'C', 0, 1, 'select-one', 'C', 'b']);
  assert.deepStrictEqual(arr(e.run("s.add(new Option('D', 'd', false, true)); var r1 = [s.length, s.value, s.selectedIndex, s.options[3].selected]; s.remove(0); r1.concat([s.length, s.options[0].value, s.value, s.selectedIndex])")),
    [4, 'd', 3, true, 3, 'b', 'd', 2], 'an inserted option with selectedness true becomes selected; removal keeps the selected option');
  assert.deepStrictEqual(arr(e.run("[m.type, m.selectedIndex, m.value, Array.from(m.selectedOptions, o => o.value).join(), (m.options[1].selected = true, Array.from(m.selectedOptions, o => o.value).join()), (m.selectedIndex = 1, Array.from(m.selectedOptions, o => o.value).join())]")),
    ['select-multiple', 0, '1', '1,3', '1,2,3', '2']);
  assert.deepStrictEqual(arr(e.run("[ta.value, ta.defaultValue, (ta.value = 'typed', ta.defaultValue), ta.textLength, ta.type, (ta.defaultValue = 'd2', ta.value)]")),
    ['init', 'init', 'init', 5, 'textarea', 'typed']);
  assert.deepStrictEqual(arr(e.run("var i = document.createElement('input'); i.value = 'v'; [i.defaultValue, i.getAttribute('value'), (i.defaultValue = 'dv', i.value), i.type, (i.type = 'bogus', i.type), i.getAttribute('type')]")),
    ['', null, 'v', 'text', 'text', 'bogus']);
  assert.deepStrictEqual(arr(e.run("[cb.checked, cb.defaultChecked, (cb.checked = false, cb.defaultChecked), cb.hasAttribute('checked'), (cb.defaultChecked = false, cb.checked)]")),
    [true, true, true, true, false]);
  assert.deepStrictEqual(arr(e.run("[document.getElementById('lq').control === q, q.labels.length, q.labels[0].id, document.getElementById('lq').form === f, document.getElementById('lq').htmlFor]")),
    [true, 1, 'lq', true, 'q']);
  e.run("q.value = 'x'; document.getElementById('em').value = 'a@b.c'; document.getElementById('num').value = '4'; document.getElementById('pat').value = 'ok'; ta.value = 'typed'; m.selectedIndex = 1;");
  assert.strictEqual(e.run("Array.from(new FormData(f, document.getElementById('sb')).entries(), ([k, v]) => k + '=' + v).join('&')"),
    'q=x&em=a@b.c&num=4&pat=ok&h=hv&s=d&m=2&ta=typed&act=save&out=o');
  assert.deepStrictEqual(arr(e.run("s.selectedIndex = 0; f.reset(); [q.value, ta.value, s.value, cb.checked, m.value, document.getElementById('num').value]")),
    ['', 'd2', 'b', false, '1', '3']);
  assert.strictEqual(e.run("document.querySelector('#s option:checked').value + ':' + document.querySelectorAll('#m option:checked').length"), 'b:2',
    ':checked reflects live selectedness');
  assert.deepStrictEqual(e.errors(), []);
});

test('declarative shadow DOM: attached at parse, slots filled, reused by attachShadow', async () => {
  const html = '<!DOCTYPE html><html><head></head><body>' +
    '<my-card id="c"><template shadowrootmode="open"><style>p{color:red}</style><p id="sp">shadow</p>' +
    '<my-inner><template shadowrootmode="open"><b>inner</b></template></my-inner><slot></slot></template>' +
    '<span id="light">light</span></my-card>' +
    '<div id="closed"><template shadowrootmode="closed"><i>c</i></template></div>' +
    '<template id="plain"><p>not shadow</p></template></body></html>';
  const e = await createEnv({ html });
  assert.strictEqual(e.run(`
    var c = document.getElementById('c'), sr = c.shadowRoot;
    [sr !== null, sr instanceof ShadowRoot, sr.mode, !!sr.querySelector('#sp'),
     c.querySelector('template') === null, document.querySelector('my-inner').shadowRoot !== null,
     document.getElementById('closed').shadowRoot === null, document.getElementById('plain').content.childNodes.length,
     !!sr.querySelector('slot') && sr.querySelector('slot').contains(document.getElementById('light'))].join(',')
  `), 'true,true,open,true,true,true,true,1,true');
  // Hosts are reported to the native side (style scoping).
  assert.strictEqual(e.mock.shadowHosts.size, 3);
  assert.ok(e.mock.shadowHosts.has(e.node('#c').id));
  assert.strictEqual(e.run(`
    var again = c.attachShadow({ mode: 'open' });
    var r = [again === sr, sr.querySelector('#sp') === null];
    try { c.attachShadow({ mode: 'open' }); r.push('no-throw'); } catch (err) { r.push(err.name); }
    r.join(',');
  `), 'true,true,NotSupportedError');
});

test('custom elements report :defined to the native side on upgrade and construction', async () => {
  const e = await createEnv({ html: CE_PAGE });
  e.run(CE_CLASS + "customElements.define('x-a', XA); window.__n = new XA();");
  assert.ok(e.mock.definedIds.has(e.id('#a1')));
  assert.ok(e.mock.definedIds.has(e.id('#a2')));
  assert.strictEqual(e.mock.definedIds.size, 3); // a1, a2 and the constructed one (not the template's)
});
