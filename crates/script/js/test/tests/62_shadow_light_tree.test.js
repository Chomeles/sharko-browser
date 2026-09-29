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
