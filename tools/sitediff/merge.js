#!/usr/bin/env node
// Combine the summary.json files of sitediff shards (--shard=I/N runs) into one, for
// tools/sitediff/gate.js and for a single report.
//
//   node tools/sitediff/merge.js OUT.json shard1/summary.json shard2/summary.json ...
'use strict';
const fs = require('fs');

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error('usage: node tools/sitediff/merge.js OUT.json summary.json...');
  process.exit(2);
}
const sites = [];
let meta = null;
for (const f of inputs) {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  meta = meta || s.meta;
  sites.push(...s.sites);
}
const compared = sites.filter((s) => s.status === 'compared');
const scores = compared.map((s) => s.score).sort((a, b) => a - b);
const median = scores.length ? scores[Math.floor(scores.length / 2)] : 0;
const good = compared.filter((s) => s.score < 10).length;
const tags = {};
for (const s of compared) for (const i of s.issues) tags[i.tag] = (tags[i.tag] || 0) + 1;
fs.writeFileSync(out, JSON.stringify({ meta: { ...meta, shards: inputs.length }, median, good, tagCount: tags, sites }, null, 1));
console.log(`${compared.length} sites compared (${sites.length - compared.length} skipped), median score ${median}, ${good} under 10`);
console.log('issues: ' + Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t} ${n}`).join(', '));
