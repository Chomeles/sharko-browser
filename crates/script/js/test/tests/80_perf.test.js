'use strict';
// Guards against accidentally quadratic hot paths in the layer (generous absolute bounds;
// typical timings on the mock are 5-10x below them).
const assert = require('assert');
const { createEnv } = require('../harness');

function timed(e, code) {
  const t0 = process.hrtime.bigint();
  const r = e.run(code);
  return [r, Number(process.hrtime.bigint() - t0) / 1e6];
}

test('perf: 20k nodes create/append/walk/index/classList/style/attributes/remove', async () => {
  const e = await createEnv();
  const [r, ms] = timed(e, `
    const root = document.createElement('div');
    document.body.appendChild(root);
    for (let i = 0; i < 20000; i++) { const d = document.createElement('div'); d.className = 'c' + (i % 10); root.appendChild(d); }
    let n = 0;
    for (let c = root.firstChild; c; c = c.nextSibling) { c.classList.add('x'); c.style.color = 'red'; c.setAttribute('data-i', '1'); n++; }
    const cn = root.childNodes;
    for (let i = 0; i < cn.length; i++) if (cn[i].nodeType === 1) n++;
    for (let i = 0; i < 1000; i++) n += root.children.length > 0 ? 0 : 1;
    while (root.lastChild) root.removeChild(root.lastChild);
    n + ':' + root.childNodes.length
  `);
  assert.strictEqual(r, '40000:0');
  assert.ok(ms < 4000, `took ${ms.toFixed(0)}ms`);
});

test('perf: listeners, bubbling dispatch, MutationObserver, innerHTML', async () => {
  const e = await createEnv();
  const [r, ms] = timed(e, `
    const root = document.createElement('div');
    document.body.appendChild(root);
    let hits = 0;
    for (let i = 0; i < 5000; i++) { const s = document.createElement('span'); s.addEventListener('ping', () => hits++); root.appendChild(s); }
    window.addEventListener('ping', () => hits++);
    const f = root.firstChild;
    for (let i = 0; i < 5000; i++) f.dispatchEvent(new Event('ping', { bubbles: true }));
    const mo = new MutationObserver(() => {});
    mo.observe(root, { childList: true, subtree: true, attributes: true });
    for (let i = 0; i < 5000; i++) { const s = document.createElement('b'); root.appendChild(s); s.id = 'b' + i; }
    const recs = mo.takeRecords().length;
    root.innerHTML = Array.from({ length: 3000 }, (_, i) => '<p class="r">' + i + '</p>').join('');
    hits + ':' + recs + ':' + root.querySelectorAll('p.r').length
  `);
  assert.strictEqual(r, '10000:10000:3000');
  assert.ok(ms < 4000, `took ${ms.toFixed(0)}ms`);
});
