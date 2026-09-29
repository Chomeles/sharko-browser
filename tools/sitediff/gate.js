#!/usr/bin/env node
// Release gate over a sitediff result: no crashes or hangs, and the median site score
// under a limit. Exit status 0 = pass, 1 = fail.
//
//   node tools/sitediff/gate.js [summary.json] [--median=8] [--max-bad=0.05]
//
// summary.json defaults to tools/sitediff/out/summary.json (the file a run writes; the
// Windows smoke workflow uploads its own as the sitediff-windows artifact).
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? parseFloat(a.slice(name.length + 3)) : def;
};
const file = args.find((a) => !a.startsWith('--')) || path.join(__dirname, 'out', 'summary.json');
const maxMedian = opt('median', 8);
const maxBad = opt('max-bad', 0.05);

const sum = JSON.parse(fs.readFileSync(file, 'utf8'));
const sites = sum.sites.filter((s) => s.status === 'compared');
const scores = sites.map((s) => s.score).sort((a, b) => a - b);
const median = scores.length ? scores[Math.floor(scores.length / 2)] : 100;
const crashes = sites.filter((s) => s.issues.some((i) => i.tag === 'crash' || i.tag === 'hang'));
const bad = sites.filter((s) => s.score >= 60);

const checks = [
  [`sites compared: ${sites.length}`, sites.length >= 100],
  [`crashes/hangs: ${crashes.length}${crashes.length ? ' (' + crashes.map((s) => s.slug).join(', ') + ')' : ''}`, crashes.length === 0],
  [`median score ${median} (limit ${maxMedian})`, median <= maxMedian],
  [`sites scoring 60+: ${bad.length}/${sites.length} (limit ${Math.round(maxBad * 100)}%)`, sites.length > 0 && bad.length / sites.length <= maxBad],
];
let ok = true;
for (const [text, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${text}`);
  if (!pass) ok = false;
}
console.log(ok ? 'gate: pass' : 'gate: FAIL');
process.exit(ok ? 0 : 1);
