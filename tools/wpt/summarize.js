#!/usr/bin/env node
// Summarize a `run.js --json=FILE` dump: pass rates per directory and the most common
// failure messages, so the next thing to fix is the one that unlocks the most tests.
//
//   node tools/wpt/summarize.js results.json [--depth=2] [--top=40] [--dir=PREFIX]
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
if (!file) {
  console.error('usage: summarize.js results.json [--depth=2] [--top=40] [--dir=PREFIX]');
  process.exit(2);
}
const depth = parseInt(opt('depth', '2'), 10);
const top = parseInt(opt('top', '40'), 10);
const prefix = opt('dir', '');
let results = JSON.parse(fs.readFileSync(file, 'utf8'));
if (prefix) results = results.filter((r) => r.id.startsWith(prefix));

// Per-directory table.
const dirs = {};
for (const r of results) {
  const key = r.id.split('/').slice(1, 1 + depth).join('/');
  const d = (dirs[key] ||= { tests: 0, ok: 0, error: 0, timeout: 0, crash: 0, sub: 0, pass: 0 });
  d.tests++;
  if (r.status === 'OK') d.ok++;
  else if (r.status === 'TIMEOUT') d.timeout++;
  else if (r.status === 'CRASH') d.crash++;
  else d.error++;
  for (const s of r.subtests) {
    d.sub++;
    if (s.status === 'PASS') d.pass++;
  }
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1).padStart(5) + '%' : '    -');
console.log('directory'.padEnd(40) + ' tests    OK  ERR  T/O CRASH   subtests  pass');
for (const [k, d] of Object.entries(dirs).sort()) {
  console.log(
    `${k.padEnd(40)} ${String(d.tests).padStart(5)} ${String(d.ok).padStart(5)} ${String(d.error).padStart(4)} ${String(d.timeout).padStart(4)} ${String(d.crash).padStart(5)}   ${String(d.pass).padStart(6)}/${String(d.sub).padEnd(6)} ${pct(d.pass, d.sub)}`,
  );
}
const all = Object.values(dirs).reduce((a, d) => {
  for (const k of Object.keys(d)) a[k] = (a[k] || 0) + d[k];
  return a;
}, {});
console.log(
  `${'TOTAL'.padEnd(40)} ${String(all.tests).padStart(5)} ${String(all.ok).padStart(5)} ${String(all.error).padStart(4)} ${String(all.timeout).padStart(4)} ${String(all.crash).padStart(5)}   ${String(all.pass).padStart(6)}/${String(all.sub).padEnd(6)} ${pct(all.pass, all.sub)}`,
);

// Crashes and harness errors first: they hide every subtest behind them.
const crashes = results.filter((r) => r.status === 'CRASH');
if (crashes.length) {
  console.log(`\n== CRASH (${crashes.length})`);
  const byMsg = {};
  for (const r of crashes) {
    const m = (r.message || '').replace(/\s+/g, ' ').replace(/thread '[^']*' /, '').slice(0, 140);
    (byMsg[m] ||= []).push(r.id);
  }
  for (const [m, ids] of Object.entries(byMsg).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${String(ids.length).padStart(4)}  ${m}`);
    for (const id of ids.slice(0, 4)) console.log(`        ${id}`);
  }
}
const errors = results.filter((r) => r.status === 'ERROR' || r.status === 'TIMEOUT');
if (errors.length) {
  console.log(`\n== harness ERROR/TIMEOUT (${errors.length}); most common messages`);
  const byMsg = {};
  for (const r of errors) {
    const m = normalize(r.message || (r.console[0] || '')) || `(${r.status}, no message)`;
    (byMsg[m] ||= []).push(r.id);
  }
  for (const [m, ids] of Object.entries(byMsg).sort((a, b) => b[1].length - a[1].length).slice(0, top)) {
    console.log(`${String(ids.length).padStart(4)}  ${m}`);
    for (const id of ids.slice(0, 3)) console.log(`        ${id}`);
  }
}

// Failing subtests grouped by normalized message.
const byMsg = {};
let failing = 0;
for (const r of results) {
  for (const s of r.subtests) {
    if (s.status === 'PASS') continue;
    failing++;
    const m = normalize(s.message || s.status);
    (byMsg[m] ||= { n: 0, tests: new Set() });
    byMsg[m].n++;
    byMsg[m].tests.add(r.id);
  }
}
console.log(`\n== failing subtests (${failing}); most common messages (count, tests)`);
for (const [m, v] of Object.entries(byMsg).sort((a, b) => b[1].n - a[1].n).slice(0, top)) {
  console.log(`${String(v.n).padStart(5)} ${String(v.tests.size).padStart(4)}  ${m}`);
  for (const id of [...v.tests].slice(0, 2)) console.log(`             ${id}`);
}

/** Collapse a message so the same defect groups across tests. */
function normalize(m) {
  return String(m)
    .replace(/\s+/g, ' ')
    .replace(/^(Uncaught|console\.\w+:)\s*/, '')
    .replace(/(expected|got|but got|value) ("[^"]{0,60}"|'[^']{0,60}'|-?\d+(\.\d+)?|null|undefined|true|false|object "[^"]*"|function "[^"]*")/g, '$1 …')
    .replace(/https?:\/\/[^\s"')]+/g, 'URL')
    .replace(/\b\d{2,}\b/g, 'N')
    .replace(/\[object [A-Za-z]+\]/g, '[object]')
    .slice(0, 150);
}
