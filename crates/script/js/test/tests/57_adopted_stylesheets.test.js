'use strict';
// document/shadowRoot.adoptedStyleSheets: an ObservableArray of constructed CSSStyleSheets
// whose rule text is handed to the native side (N.setAdoptedSheets) in cascade order.
const assert = require('assert');
const { createEnv } = require('../harness');

test('adoptedStyleSheets: observable array semantics and native updates', async () => {
  const e = await createEnv({ html: '<div id="host"></div><style id="st">p { color: red }</style>' });
  e.run(`
    var s1 = new CSSStyleSheet(); s1.replaceSync('p { color: lime }');
    var s2 = new CSSStyleSheet({ media: 'print', baseURL: 'https://cdn.example/x/' }); s2.replaceSync('p { color: blue }');
    var a = document.adoptedStyleSheets;
  `);
  // (JSON round trip: the arrays come from the page's realm.)
  const got = (hostId) => JSON.parse(JSON.stringify(e.mock.adoptedSheets.get(hostId)));
  assert.strictEqual(e.run('a === document.adoptedStyleSheets && Array.isArray(a) && a.length === 0'), true);
  e.run('document.adoptedStyleSheets = [s1]; a.push(s2)');
  assert.strictEqual(e.run('[a.length, a[0] === s1, a[1] === s2, document.styleSheets.length].join()'), '2,true,true,1');
  await e.flush();
  assert.deepStrictEqual(got(0), [
    ['p { color: lime }', null],
    ['@media print {\np { color: blue }\n}', 'https://cdn.example/x/'],
  ]);
  // Mutating an adopted sheet re-applies it; a disabled sheet is left out.
  e.run("s1.insertRule('b { font-weight: bold }', 1); s2.disabled = true");
  await e.flush();
  assert.deepStrictEqual(got(0), [['p { color: lime }\nb { font-weight: bold }', null]]);
  // Validation: only constructed CSSStyleSheets, no holes, no growing through length.
  assert.strictEqual(e.run("try { a.push(document.getElementById('st').sheet); 'no' } catch (x) { x.name }"), 'NotAllowedError');
  assert.strictEqual(e.run("try { a.push('foo'); 'no' } catch (x) { x.constructor.name }"), 'TypeError');
  assert.strictEqual(e.run("try { a[5] = s1; 'no' } catch (x) { x.constructor.name }"), 'RangeError');
  assert.strictEqual(e.run("try { a.length = 9; 'no' } catch (x) { x.constructor.name }"), 'RangeError');
  assert.strictEqual(e.run("try { document.adoptedStyleSheets = 3; 'no' } catch (x) { x.constructor.name }"), 'TypeError');
  assert.strictEqual(e.run('a.length'), 2);
  // pop / splice / delete of the last element shrink the list; the setter replaces it in place.
  e.run('a.pop(); a.splice(0, 1, s2, s1); delete a[1]');
  assert.strictEqual(e.run('[a.length, a[0] === s2].join()'), '1,true');
  e.run('document.adoptedStyleSheets = new Set([s1]); s2.disabled = false');
  await e.flush();
  assert.deepStrictEqual(got(0), [['p { color: lime }\nb { font-weight: bold }', null]]);
  // A setter on Array.prototype never sees the backing list.
  assert.strictEqual(e.run(`
    var backing = null;
    Object.defineProperty(Array.prototype, '1', { configurable: true, set(v) { backing = this; } });
    document.adoptedStyleSheets = [new CSSStyleSheet(), new CSSStyleSheet()];
    a.push(s1);
    delete Array.prototype['1'];
    backing === null && a.length === 3
  `), true);
  // Shadow roots have their own list, applied for their host.
  e.run(`
    var sr = document.getElementById('host').attachShadow({ mode: 'open' });
    sr.adoptedStyleSheets = [s2];
  `);
  await e.flush();
  const hostId = e.id('#host');
  assert.deepStrictEqual(got(hostId), [['@media print {\np { color: blue }\n}', 'https://cdn.example/x/']]);
  assert.strictEqual(e.run('[sr.adoptedStyleSheets.length, sr.styleSheets.length, document.adoptedStyleSheets.length].join()'), '1,0,3');
  assert.strictEqual(e.run("try { new CSSStyleSheet({ baseURL: 'https://test:test/' }); 'no' } catch (x) { x.name }"), 'NotAllowedError');
  assert.deepStrictEqual(e.errors(), []);
});
