#!/usr/bin/env node
// Hand-defined root-cause clusters over the sweep results (see cluster.js for the
// generic tag-based version). Sites are assigned by what Sharko actually shows.
//   node cluster2.js [outDir] > clusters2.json
'use strict';
const fs = require('fs');
const path = require('path');
const outDir = path.resolve(process.argv[2] || 'tools/sitediff/out');
const sum = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
const sites = sum.sites.filter((s) => s.status === 'compared');
const logOf = (s) => { try { return fs.readFileSync(path.join(outDir, s.slug, 'sharko.log'), 'utf8'); } catch (e) { return ''; } };
const probeOf = (s) => { try { return JSON.parse(fs.readFileSync(path.join(outDir, s.slug, 'sharko.json'), 'utf8')).probe || {}; } catch (e) { return {}; } };
const has = (s, tag) => s.issues.some((i) => i.tag === tag);
const ref = (s, why) => ({ slug: s.slug, url: s.url, score: s.score, dir: path.join(outDir, s.slug), why });

const BOT = /access denied|nur einen moment|just a moment|captcha|request has been blocked|are you a robot|verify you are|something has gone wrong.*browser is updated|autorisierten geheimnistr|challenge|pardon our interruption|unusual traffic|bot detection|blocked/i;
const clusters = [];
const taken = new Set();
const take = (s) => taken.add(s.slug);

// 1. Bot walls: Sharko gets a challenge/denied page, Chromium the site.
{
  const list = [];
  for (const s of sites) {
    const p = probeOf(s);
    const head = ((p.title || '') + ' ' + (p.text || '').slice(0, 400));
    const log = logOf(s);
    if (BOT.test(head) || (has(s, 'page-too-short') && (has(s, 'few-elements') || has(s, 'no-text')) && /captcha|challenge|429|403/i.test(log))) {
      list.push(ref(s, head.slice(0, 120)));
      take(s);
    }
  }
  clusters.push({ id: 'bot-walls', title: 'Sharko is served bot walls / access denied pages where Chromium gets the site', sites: list });
}
// 2. Crashes.
clusters.push({ id: 'crash', title: 'Renderer crashes', sites: sites.filter((s) => has(s, 'crash') || has(s, 'hang')).map((s) => { take(s); return ref(s, s.issues.find((i) => i.tag === 'crash' || i.tag === 'hang').detail); }) });
// 3.-6. Error signatures found in the logs.
const byLog = (id, title, re) => {
  const list = [];
  for (const s of sites) {
    const m = re.exec(logOf(s));
    if (m) list.push(ref(s, m[0].slice(0, 160)));
  }
  clusters.push({ id, title, sites: list.sort((a, b) => b.score - a.score) });
};
byLog('dom-notfound', 'NotFoundError: the reference node is not a child of the parent (insertBefore/removeChild)', /NotFoundError: the reference node is not a child of the parent[^\n]*/);
byLog('currentscript', 'document.currentScript is null while a script runs (Next.js InvariantError and similar)', /Expected document\.currentScript to be a <script> element[^\n]*|currentScript[^\n]{0,80}null[^\n]*/);
byLog('malformed-json', 'Sharko-side "malformed JSON response" (a fetch/XHR got an HTML error page that Chromium does not get)', /malformed JSON response[^\n]{0,120}/);
byLog('indexeddb', 'indexedDB errors', /[^\n]{0,80}indexedDB[^\n]{0,120}/i);
// 7. Remaining Sharko-only error signatures with >= 2 sites (API gaps).
{
  const sig = new Map();
  for (const s of sites) {
    if (taken.has(s.slug)) continue;
    for (const e of (s.metrics.errors && s.metrics.errors.sharkoOnly) || []) {
      if (/reference node is not a child|currentScript|malformed JSON|indexedDB/i.test(e.sig)) continue;
      if (!sig.has(e.sig)) sig.set(e.sig, []);
      sig.get(e.sig).push(ref(s, e.sig.slice(0, 160)));
    }
  }
  const multi = [...sig.entries()].filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length);
  const seen = new Map();
  for (const [k, l] of multi) for (const r of l) if (!seen.has(r.slug)) seen.set(r.slug, r);
  clusters.push({ id: 'api-gaps', title: 'Other Sharko-only JS errors seen on 2+ sites (missing/wrong Web APIs)', signatures: multi.map(([k, l]) => ({ sig: k, sites: l.map((r) => r.slug) })), sites: [...seen.values()].slice(0, 12) });
}
// 8. Hidden content shown (text-extra) on pages that otherwise loaded.
clusters.push({ id: 'hidden-content', title: 'Sharko shows text Chromium hides (text-extra)', sites: sites.filter((s) => !taken.has(s.slug) && has(s, 'text-extra') && !has(s, 'load-failed')).map((s) => ref(s, s.issues.find((i) => i.tag === 'text-extra').detail)).sort((a, b) => b.score - a.score) });
// 9. Layout differences on loaded pages.
clusters.push({ id: 'layout', title: 'Layout differs on pages that loaded (layout-shifted, sizes-differ, horizontal-overflow, page-too-tall)', sites: sites.filter((s) => !taken.has(s.slug) && ['layout-shifted', 'sizes-differ', 'horizontal-overflow', 'page-too-tall'].some((t) => has(s, t))).map((s) => ref(s, s.issues.filter((i) => /layout|sizes|overflow|tall/.test(i.tag)).map((i) => i.detail).join(' | '))).sort((a, b) => b.score - a.score) });
// 10. Content missing on loaded pages (text-missing, elements-missing, dom-differs, images-missing) — not bot walls.
clusters.push({ id: 'content-missing', title: 'Content missing on pages that loaded (text-missing, elements-missing, dom-differs, images-missing/broken)', sites: sites.filter((s) => !taken.has(s.slug) && ['text-missing', 'text-mostly-missing', 'elements-missing', 'dom-differs', 'images-missing', 'images-broken', 'images-some-broken', 'few-elements'].some((t) => has(s, t))).map((s) => ref(s, s.issues.filter((i) => /text-|elements|dom-|images|few/.test(i.tag)).map((i) => i.detail).join(' | '))).sort((a, b) => b.score - a.score) });
// 11. scrollHeight / page height on loaded pages.
clusters.push({ id: 'page-height', title: 'page-too-short on pages that loaded (scrollHeight far below Chromium, e.g. scroll-locked body)', sites: sites.filter((s) => !taken.has(s.slug) && has(s, 'page-too-short')).map((s) => ref(s, s.issues.find((i) => i.tag === 'page-too-short').detail)).sort((a, b) => b.score - a.score) });
// 12. Colours.
clusters.push({ id: 'colours', title: 'Colours differ (body-background, backgrounds-differ, text-colors-differ, color-scheme)', sites: sites.filter((s) => ['body-background', 'backgrounds-differ', 'text-colors-differ', 'color-scheme'].some((t) => has(s, t))).map((s) => ref(s, s.issues.filter((i) => /background|colors|scheme/.test(i.tag)).map((i) => i.detail).join(' | '))) });
// 13. Load failures (network) — informational.
clusters.push({ id: 'load-failed', title: 'Navigation failed in Sharko (network/TLS) while Chromium loaded (note: Chromium ignores certificate errors here)', sites: sites.filter((s) => has(s, 'load-failed')).map((s) => ref(s, s.issues.find((i) => i.tag === 'load-failed').detail)) });

process.stdout.write(JSON.stringify({ compared: sites.length, median: sum.median, good: sum.good, clusters }, null, 1));
