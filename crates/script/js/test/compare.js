'use strict';
// Compare a value of Sharko with the one Chromium recorded: pixel-like integers (0..255) may differ by rounding.
const assert = require('assert');
function close(a, b, path) {
  if (typeof b === 'number' && typeof a === 'number') {
    const tol = Number.isInteger(b) && b >= 0 && b <= 255 && Number.isInteger(a) ? 3 : 1e-5;
    assert.ok(Math.abs(a - b) <= tol, `${path}: ${a} differs from Chromium's ${b}`);
  } else if (Array.isArray(b)) {
    assert.ok(Array.isArray(a) && a.length === b.length, `${path}: length ${a && a.length} vs ${b.length}`);
    b.forEach((v, i) => close(a[i], v, `${path}[${i}]`));
  } else if (b !== null && typeof b === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(b)) close(a[k], b[k], `${path}.${k}`);
  } else assert.strictEqual(a, b, path);
}
module.exports = { close };
