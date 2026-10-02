'use strict';
// A shadow host's children are its light tree (slotted or not), not the shadow content.
const assert = require('assert');
const { createEnv } = require('../harness');

test('shadow host: light children, slots, assignedNodes', async () => {
  const e = await createEnv({ html: '<body></body>' });
  const r = e.run(`
    class X extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot><slot name=a>fb</slot>'; } }
    customElements.define('x-x', X);
    const t = document.createElement('template');
    t.innerHTML = '<x-x><div>x</div><b slot=a>y</b>t</x-x>';
    const x = document.importNode(t.content, true).firstChild;
    const o = [x.childNodes.length, x.firstChild.tagName, x.children.length, x.textContent, x.hasChildNodes()];
    document.body.appendChild(x);
    const d = x.firstChild;
    o.push(d.assignedSlot.tagName, d.parentNode === x, d.nextSibling.tagName);
    const s = x.shadowRoot.querySelector('slot');
    o.push(s.assignedNodes().length, s.assignedNodes()[0].tagName);
    x.appendChild(document.createElement('i'));
    o.push(x.childNodes.length, x.lastChild.tagName);
    d.remove();
    o.push(x.childNodes.length);
    o.join();
  `);
  assert.strictEqual(r, '3,DIV,2,xyt,true,SLOT,true,B,2,DIV,4,I,3');
});

test('innerHTML/outerHTML of a shadow host serialize the light tree, also for nested hosts', async () => {
  const e = await createEnv({ html: '<body><div id=h><b>light</b>text</div><section id=wrap><p>a</p><div id=h2><i>l2</i></div></section></body>' });
  const r = e.run(`
    const h = document.getElementById('h');
    h.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot><u>shadow</u>';
    const h2 = document.getElementById('h2');
    h2.attachShadow({ mode: 'open' }).replaceChildren(document.createComment(''));
    [h.innerHTML, h.outerHTML, h.shadowRoot.innerHTML,
     document.getElementById('wrap').innerHTML, h2.outerHTML,
     document.createElement('div').innerHTML].join('|');
  `);
  assert.strictEqual(r,
    '<b>light</b>text|<div id="h"><b>light</b>text</div>|<slot><b>light</b>text</slot><u>shadow</u>|' +
    '<p>a</p><div id="h2"><i>l2</i></div>|<div id="h2"><i>l2</i></div>|');
});
