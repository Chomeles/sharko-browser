'use strict';
const assert = require('assert');
const { createEnv } = require('../harness');

test('layer loads and hides internals', async () => {
  const env = await createEnv();
  assert.strictEqual(env.run('typeof __native'), 'undefined');
  assert.strictEqual(env.run('typeof __layer'), 'undefined');
  assert.strictEqual(env.run('document.title'), 'Test');
  assert.strictEqual(env.run('document.body instanceof HTMLBodyElement'), true);
  assert.deepStrictEqual(env.errors(), []);
});

test('layer load is snapshot-safe (only allowed natives, no clock/random, no globalThis-keyed collections)', async () => {
  const env = await createEnv({ checkSnapshot: true });
  assert.deepStrictEqual(env.mock.loadViolations, []);
  // page-specific values are computed lazily after load
  assert.strictEqual(env.run('typeof document.referrer'), 'string');
  assert.ok(/^\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d$/.test(env.run('document.lastModified')));
  assert.deepStrictEqual(env.errors(), []);
});
