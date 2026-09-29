#!/usr/bin/env node
// Turn tools/sitediff/out/summary.json into root-cause candidate clusters for the
// diagnose agents: crashes grouped by panic message, Sharko-only errors grouped by the
// API they name, and issue tags with their worst sites and evidence.
//
//   node cluster.js [outDir] [maxClusters] > clusters.json
'use strict';
const fs = require('fs');
const path = require('path');
const outDir = path.resolve(process.argv[2] || 'tools/sitediff/out');
const max = parseInt(process.argv[3] || '14', 10);
const sum = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
const sites = sum.sites.filter((s) => s.status === 'compared');

const clusters = [];
const siteRef = (s) => ({ slug: s.slug, url: s.url, score: s.score, dir: path.join(outDir, s.slug) });

// 1. Crashes / hangs, grouped by the panic message in sharko.log.
const crashGroups = new Map();
for (const s of sites) {
  const t = s.issues.find((i) => i.tag === 'crash' || i.tag === 'hang');
  if (!t) continue;
  let key = t.tag;
  let msg = '';
  try {
    const log = fs.readFileSync(path.join(outDir, s.slug, 'sharko.log'), 'utf8');
    const m = /panicked at ([^\n]+)\n([^\n]*)/.exec(log) || /(thread '[^']+' panicked[^\n]*)\n?([^\n]*)/.exec(log);
    if (m) {
      msg = (m[1] + ' ' + m[2]).trim();
      key = t.tag + ':' + m[1].replace(/:\d+:\d+/, '').trim();
    } else {
      const sig = /SIG[A-Z]+|stack overflow|out of memory|Aborted/.exec(log);
      if (sig) {
        msg = sig[0];
        key = t.tag + ':' + sig[0];
      }
    }
  } catch (e) {}
  if (!crashGroups.has(key)) crashGroups.set(key, { key, msg, sites: [] });
  crashGroups.get(key).sites.push(siteRef(s));
}
for (const g of crashGroups.values()) {
  clusters.push({
    id: 'crash-' + clusters.length,
    kind: 'crash',
    title: `Sharko ${g.key.startsWith('hang') ? 'hangs' : 'crashes'}: ${g.msg || g.key}`,
    priority: 100 * g.sites.length,
    sites: g.sites,
    evidence: [g.msg].filter(Boolean),
  });
}

// 2. Sharko-only errors grouped by the API name in the message, else by signature.
const errGroups = new Map();
for (const s of sites) {
  const so = (s.metrics.errors && s.metrics.errors.sharkoOnly) || [];
  const seen = new Set();
  for (const e of so) {
    const key = e.hints && e.hints.length ? 'api:' + e.hints[0] : 'sig:' + e.sig;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!errGroups.has(key)) errGroups.set(key, { key, sites: [], examples: new Set() });
    const g = errGroups.get(key);
    g.sites.push(siteRef(s));
    if (g.examples.size < 4) g.examples.add(e.sig);
  }
}
for (const g of [...errGroups.values()].sort((a, b) => b.sites.length - a.sites.length)) {
  if (g.sites.length < 2) continue;
  clusters.push({
    id: 'err-' + clusters.length,
    kind: 'js-error',
    title: `Sharko-only error on ${g.sites.length} sites: ${g.key.replace(/^(api|sig):/, '')}`,
    priority: 6 * g.sites.length,
    sites: g.sites.sort((a, b) => b.score - a.score),
    evidence: [...g.examples],
  });
}

// 3. Issue tags (rendering/behaviour differences) with their worst sites.
const TAGS = {
  'blank-screenshot': 60,
  'load-failed': 50,
  'no-text': 50,
  'text-mostly-missing': 30,
  'body-background': 30,
  'backgrounds-differ': 20,
  'text-colors-differ': 15,
  'color-scheme': 20,
  'page-too-short': 20,
  'page-too-tall': 15,
  'stylesheets-missing': 25,
  'dom-differs': 20,
  'images-broken': 20,
  'images-missing': 10,
  'layout-shifted': 15,
  'sizes-differ': 12,
  'text-missing': 12,
  'text-extra': 10,
  'few-elements': 15,
  'horizontal-overflow': 10,
  'font-sizes-differ': 6,
  'display-differs': 6,
  'elements-missing': 8,
  'probe-error': 15,
  'different-url': 15,
  'load-timeout': 8,
  'looks-different': 5,
};
const tagGroups = new Map();
for (const s of sites) {
  for (const i of s.issues) {
    if (!(i.tag in TAGS)) continue;
    if (!tagGroups.has(i.tag)) tagGroups.set(i.tag, []);
    tagGroups.get(i.tag).push({ ...siteRef(s), detail: i.detail });
  }
}
for (const [tag, list] of tagGroups) {
  list.sort((a, b) => b.score - a.score);
  clusters.push({
    id: 'tag-' + tag,
    kind: 'difference',
    tag,
    title: `${tag} on ${list.length} sites`,
    priority: TAGS[tag] * Math.min(list.length, 25),
    sites: list.map(({ detail, ...r }) => r),
    evidence: list.slice(0, 10).map((x) => `${x.slug}: ${x.detail}`),
  });
}

clusters.sort((a, b) => b.priority - a.priority);
const picked = clusters.slice(0, max).map((c) => ({ ...c, sites: c.sites.slice(0, 8), totalSites: c.sites.length }));
process.stdout.write(JSON.stringify({ compared: sites.length, median: sum.median, good: sum.good, clusters: picked, dropped: clusters.slice(max).map((c) => `${c.id} (${c.sites.length} sites, prio ${c.priority})`) }, null, 1));
