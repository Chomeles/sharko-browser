'use strict';
// Live ranges: boundary points follow DOM mutations (DOM Standard "live range" steps).
const assert = require('assert');
const { createEnv } = require('../harness');

test('live ranges: character data, insert/remove, splitText, normalize, innerHTML', async () => {
  const e = await createEnv({ html: '<div id="d"><p id="p">hello world</p><span id="s">x</span></div>' });
  e.run(`
    var p = document.getElementById('p'), t = p.firstChild, d = document.getElementById('d');
    var r = document.createRange(); r.setStart(t, 6); r.setEnd(t, 11);   // "world"
    var sel = getSelection(); sel.selectAllChildren(d);                    // (d,0)-(d,2)
  `);
  const bp = () => e.run("[r.startContainer === t, r.startOffset, r.endContainer === t, r.endOffset].join()");
  // insertData before the range shifts both offsets; deleteData inside clamps to the deletion point
  e.run("t.insertData(0, 'ab')");
  assert.strictEqual(bp(), 'true,8,true,13');
  e.run("t.deleteData(9, 2)"); // removes 'or' → end clamps
  assert.strictEqual(bp(), 'true,8,true,11');
  e.run("t.replaceData(0, 2, '')");
  assert.strictEqual(bp(), 'true,6,true,9');
  assert.strictEqual(e.run('r.toString()'), 'wld');
  // splitText moves the part after the split into the new node
  e.run("var t2 = t.splitText(7)");
  assert.strictEqual(e.run("[r.startContainer === t, r.startOffset, r.endContainer === t2, r.endOffset].join()"), 'true,6,true,2');
  assert.strictEqual(e.run("[sel.anchorNode === d, sel.anchorOffset, sel.focusOffset].join()"), 'true,0,2');
  // normalize merges t2 back and moves the end boundary
  e.run('p.normalize()');
  assert.strictEqual(bp(), 'true,6,true,9');
  // inserting a node before p shifts the selection's end offset; removing p collapses ranges inside it
  e.run("d.insertBefore(document.createElement('b'), p)");
  assert.strictEqual(e.run('[sel.anchorOffset, sel.focusOffset].join()'), '0,3');
  e.run('p.remove()');
  assert.strictEqual(e.run("[r.startContainer === d, r.startOffset, r.endContainer === d, r.endOffset, sel.focusOffset].join()"), 'true,1,true,1,2');
  // innerHTML replaces all children: ranges in the parent collapse to (parent, 0)
  e.run("r.setStart(d, 1); r.setEnd(d, 2); d.innerHTML = '<i>y</i>'");
  assert.strictEqual(e.run("[r.startContainer === d, r.startOffset, r.endOffset, sel.anchorOffset, sel.focusOffset].join()"), 'true,0,0,0,0');
  // a range in a detached subtree is unaffected by unrelated mutations
  e.run("var det = document.createElement('div'); det.textContent = 'zz'; var r2 = document.createRange(); r2.selectNodeContents(det.firstChild); d.appendChild(document.createTextNode('q'))");
  assert.strictEqual(e.run('[r2.startOffset, r2.endOffset].join()'), '0,2');
});
