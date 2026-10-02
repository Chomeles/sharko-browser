'use strict';
// A <link rel=stylesheet> from another origin hides cssRules (SecurityError) unless it was
// fetched in CORS mode (`crossorigin`), which makes it CORS-same-origin.
const assert = require('assert');
const { createEnv } = require('../harness');

test('cross-origin linked sheet: cssRules readable only with crossorigin', async () => {
  const e = await createEnv({ html: '<head>' +
    '<link rel=stylesheet href="https://cdn.example/a.css">' +
    '<link rel=stylesheet href="https://cdn.example/b.css" crossorigin="anonymous">' +
    '<link rel=stylesheet href="https://cdn.example/c.css" crossorigin>' +
    '</head>' });
  const probe = (i) => e.run(`try { document.styleSheets[${i}].cssRules.length } catch (x) { x.name }`);
  assert.strictEqual(probe(0), 'SecurityError');
  assert.strictEqual(probe(1), 2);
  assert.strictEqual(probe(2), 2);
});
