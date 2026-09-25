'use strict';
// Members found missing by tools/api-inventory/compare.js (Sharko vs Chromium).
const assert = require('assert');
const { createEnv } = require('../harness');

test('API surface: iterators, Selection aliases, userActivation, scheduling, serverTiming, MediaError', async () => {
  const e = await createEnv({
    html: '<form id="f"><input name="a"><select id="s"><option>1</option><option>2</option></select></form><div id="d" style="color: red; margin: 0"></div>',
  });
  assert.strictEqual(e.run("[...document.getElementById('f')].map((x) => x.tagName).join()"), 'INPUT,SELECT');
  assert.strictEqual(e.run("[...document.getElementById('s')].map((o) => o.text).join()"), '1,2');
  assert.strictEqual(e.run("[...document.getElementById('d').style][0]"), 'color');
  assert.strictEqual(e.run('typeof CSSKeyframesRule.prototype[Symbol.iterator] + typeof DataTransferItemList.prototype[Symbol.iterator] + typeof Plugin.prototype[Symbol.iterator]'), 'functionfunctionfunction');
  assert.strictEqual(e.run("var sel = getSelection(); sel.selectAllChildren(document.getElementById('d')); [sel.baseNode === sel.anchorNode, sel.extentNode === sel.focusNode, sel.baseOffset, sel.extentOffset].join()"), 'true,true,0,0');
  assert.strictEqual(e.run('[navigator.userActivation instanceof UserActivation, navigator.userActivation.hasBeenActive, navigator.userActivation.isActive].join()'), 'true,false,false');
  assert.strictEqual(e.run('[navigator.scheduling instanceof Scheduling, navigator.scheduling.isInputPending()].join()'), 'true,false');
  assert.strictEqual(e.run("Array.isArray(performance.getEntriesByType('navigation')[0].serverTiming)"), true);
  assert.strictEqual(e.run("typeof Object.getOwnPropertyDescriptor(MediaError.prototype, 'code').get + MediaError.MEDIA_ERR_DECODE"), 'function3');
  assert.strictEqual(e.run('typeof AnimationEffect.prototype.getTiming + typeof AnimationEffect.prototype.getComputedTiming + typeof AnimationEffect.prototype.updateTiming'), 'functionfunctionfunction');
});
