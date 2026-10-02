#!/usr/bin/env node
// Group a sitediff summary by cause instead of by site: which error signature, which
// issue, which missing stylesheet hits how many sites. That list is the order of work;
// a lane takes the biggest cluster, not the worst site.
//
//   node tools/sitediff/causes.js [summary.json] [--top=25]
//
// Bot-walled sites (tag `bot-wall`) are left out: they show the wall, not the engine.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || path.join(__dirname, 'out', 'summary.json');
const topArg = args.find((a) => a.startsWith('--top='));
const top = topArg ? parseInt(topArg.slice(6), 10) : 25;

const sum = JSON.parse(fs.readFileSync(file, 'utf8'));
const sites = sum.sites.filter((s) => s.status === 'compared' && !s.issues.some((i) => i.tag === 'bot-wall'));
const site = (s) => `${s.slug}(${s.score})`;

// Error signatures only in Sharko, with numbers, URLs and quoted names folded so one
// cause reads as one line.
const fold = (sig) =>
  sig
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/'[^']{0,60}'/g, "'_'")
    .replace(/"[^"]{0,60}"/g, '"_"')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'HEX')
    .replace(/\d+/g, 'N')
    .slice(0, 120);
const errors = new Map();
for (const s of sites) {
  for (const e of (s.metrics && s.metrics.errors && s.metrics.errors.sharkoOnly) || []) {
    if (!/[a-z]{3}/i.test(e.sig)) continue; // numbers or symbols only: no cause to read
    const key = fold(e.sig);
    const v = errors.get(key) || { sites: [], example: e.sig };
    if (!v.sites.includes(site(s))) v.sites.push(site(s));
    errors.set(key, v);
  }
}
console.log(`== Sharko-only error signatures by site count (${sites.length} rendering sites) ==`);
for (const [key, v] of [...errors].sort((a, b) => b[1].sites.length - a[1].sites.length).slice(0, top)) {
  console.log(`${String(v.sites.length).padStart(3)}  ${key}`);
  console.log(`      ${v.sites.slice(0, 12).join(' ')}${v.sites.length > 12 ? ' …' : ''}`);
}

// Issue tags: sites and total weight (= how much score they cost over the sweep).
const tags = new Map();
for (const s of sites) {
  for (const i of s.issues) {
    if (i.tag === 'bot-wall') continue;
    const v = tags.get(i.tag) || { n: 0, weight: 0, sites: [] };
    v.n++;
    v.weight += i.weight;
    v.sites.push(`${site(s)}:${i.weight}`);
    tags.set(i.tag, v);
  }
}
console.log('\n== issue tags by total weight (sites:weight) ==');
for (const [tag, v] of [...tags].sort((a, b) => b[1].weight - a[1].weight)) {
  v.sites.sort((a, b) => parseInt(b.split(':').pop(), 10) - parseInt(a.split(':').pop(), 10));
  console.log(`${tag.padEnd(24)} n=${String(v.n).padStart(3)} w=${String(Math.round(v.weight)).padStart(5)}  ${v.sites.slice(0, 10).join(' ')}${v.sites.length > 10 ? ' …' : ''}`);
}

// Stylesheets Sharko could not read or parse: a whole sheet lost is one cause for many
// sites (CORS, a parse failure, a loading path).
const css = sites
  .filter((s) => s.metrics && s.metrics.stylesheets && s.issues.some((i) => i.tag === 'stylesheets-missing'))
  .sort((a, b) => b.metrics.stylesheets.chromium.rules - a.metrics.stylesheets.chromium.rules);
if (css.length) {
  console.log('\n== stylesheets-missing: Sharko readable sheets/rules vs Chromium ==');
  for (const s of css) {
    const c = s.metrics.stylesheets.chromium;
    const k = s.metrics.stylesheets.sharko;
    console.log(`${site(s).padEnd(44)} sharko ${k.readable}/${k.total} sheets, ${k.rules} rules | chromium ${c.readable}/${c.total} sheets, ${c.rules} rules`);
  }
}

// Time to the load event: Sharko's own timing against Chromium's on the same page, the
// biggest ratio first (wall time `sharkoMs` includes process start, settle and screenshot).
const ms = (v) => (typeof v === 'string' ? parseFloat(v) : NaN);
const slow = sites
  .map((s) => ({ s, load: ms(s.metrics && s.metrics.sharkoTimings && s.metrics.sharkoTimings.load), ref: s.metrics && s.metrics.chromiumLoadMs }))
  .filter((x) => x.load > 0 && x.ref > 0)
  .sort((a, b) => b.load / b.ref - a.load / a.ref)
  .slice(0, 15);
if (slow.length) {
  console.log('\n== slowest load events relative to Chromium (ms) ==');
  for (const { s, load, ref } of slow) {
    const t = s.metrics.sharkoTimings || {};
    console.log(`${site(s).padEnd(44)} load ${load} (first frame ${t.firstFrame || '-'}, dcl ${t.dcl || '-'}) chromium ${ref}  ${(load / ref).toFixed(1)}x`);
  }
  const never = sites.filter((s) => s.metrics && s.metrics.sharkoTimings && !(ms(s.metrics.sharkoTimings.load) > 0));
  if (never.length) console.log('no load event within the time limit: ' + never.map(site).join(' '));
}
