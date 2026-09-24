#!/usr/bin/env node
'use strict';
// Test runner for the JS DOM/Web-API layer.
//   node js/test/run.js              run everything
//   node js/test/run.js react        run tests whose file or name matches /react/i
//   VERBOSE=1 node js/test/run.js    print console output of the page
const fs = require('fs');
const path = require('path');

const testsDir = path.join(__dirname, 'tests');
const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const registered = [];
let currentFile = '';
global.test = function test(name, fn, opts) { registered.push({ name, fn, file: currentFile, opts: opts || {} }); };

for (const f of fs.readdirSync(testsDir).filter((x) => x.endsWith('.test.js')).sort()) {
  currentFile = f;
  require(path.join(testsDir, f));
}

(async () => {
  const selected = registered.filter((t) => !filter || filter.test(t.file) || filter.test(t.name));
  let passed = 0, failed = 0;
  const failures = [];
  const started = Date.now();
  let lastFile = '';
  for (const t of selected) {
    if (t.file !== lastFile) { console.log(`\n${t.file}`); lastFile = t.file; }
    const t0 = Date.now();
    try {
      await Promise.race([
        t.fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('test timed out after ' + (t.opts.timeout || 30000) + 'ms')), t.opts.timeout || 30000)),
      ]);
      passed++;
      console.log(`  ✓ ${t.name} (${Date.now() - t0}ms)`);
    } catch (e) {
      failed++;
      failures.push([t, e]);
      console.log(`  ✗ ${t.name}`);
      const lines = String(e && e.stack ? e.stack : e).split('\n');
      const limit = e && e.code === 'ERR_ASSERTION' ? 60 : 8;
      console.log('    ' + lines.slice(0, limit).join('\n    '));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (${selected.length} tests, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const [t, e] of failures) console.log(`  - ${t.file} :: ${t.name}: ${e && e.message ? e.message.split('\n')[0] : e}`);
  }
  process.exit(failed ? 1 : 0);
})();
