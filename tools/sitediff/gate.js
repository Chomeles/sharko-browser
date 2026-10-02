#!/usr/bin/env node
// Release gate over a sitediff result: no crashes or hangs, and the median site score
// under a limit. Exit status 0 = pass, 1 = fail.
//
//   node tools/sitediff/gate.js [summary.json] [--median=8] [--max-bad=0.05] [--baseline=previous-summary.json]
//
// With --baseline the sites whose score moved by 15 or more against the previous run are
// listed (informational, they do not change the exit status): the per-site trend.
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
const baselineArg = args.find((a) => a.startsWith('--baseline='));

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
// Per-site numbers in the log, so two runs can be compared site by site (the artifacts need a login).
console.log('sites >= 60: ' + bad.sort((a, b) => b.score - a.score).map((s) => `${s.slug}(${s.score})`).join(' '));
console.log('SCORES ' + JSON.stringify(Object.fromEntries(sites.map((s) => [s.slug, s.score]))));
if (baselineArg) {
  try {
    const before = JSON.parse(fs.readFileSync(baselineArg.slice('--baseline='.length), 'utf8'));
    const old = new Map(before.sites.filter((x) => x.status === 'compared').map((x) => [x.slug, x.score]));
    const moved = sites.filter((x) => old.has(x.slug) && Math.abs(x.score - old.get(x.slug)) >= 15);
    const fmt = (list) => list.map((x) => `${x.slug}(${old.get(x.slug)}->${x.score})`).join(' ') || 'none';
    console.log('worse than the previous run by 15+: ' + fmt(moved.filter((x) => x.score > old.get(x.slug)).sort((a, b) => (b.score - old.get(b.slug)) - (a.score - old.get(a.slug)))));
    console.log('better than the previous run by 15+: ' + fmt(moved.filter((x) => x.score < old.get(x.slug)).sort((a, b) => (old.get(b.slug) - b.score) - (old.get(a.slug) - a.score))));
  } catch (e) {
    console.log('no baseline: ' + e.message);
  }
}
console.log(ok ? 'gate: pass' : 'gate: FAIL');
process.exit(ok ? 0 : 1);
