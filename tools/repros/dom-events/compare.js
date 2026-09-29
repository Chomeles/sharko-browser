#!/usr/bin/env node
// Acceptance check for the dom-events lane: run repro pages in Sharko (headless)
// and compare window.__out() with the stored Chromium values.
//
//   node tools/repros/dom-events/compare.js                  all pages that have a .expected.json
//   node tools/repros/dom-events/compare.js iframe-initial-document      one page (name without .html)
//   node tools/repros/dom-events/compare.js --verbose        print expected/actual of every differing key
//   node tools/repros/dom-events/compare.js --update-expected  (re)write .expected.json from real Chromium
//                                                                     (needs Playwright + its Chromium, see tools/sitediff/README.md)
//
// A page sets window.__done = true when its probes finished and defines window.__out() that
// returns JSON.stringify of an object of probe results. Exit status 1 if any key differs.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const REPO = path.resolve(DIR, '..', '..', '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const update = args.includes('--update-expected');
const names = args.filter((a) => !a.startsWith('--')).map((a) => a.replace(/\.html$/, ''));
const browser = process.env.SHARKO_BIN
  || ['target/profiling/browser', 'target/release/browser'].map((p) => path.join(REPO, p)).find((p) => fs.existsSync(p));
if (!browser && !update) { console.error('no browser binary: build it or set SHARKO_BIN'); process.exit(2); }

const pages = (names.length ? names : fs.readdirSync(DIR).filter((f) => f.endsWith('.expected.json')).map((f) => f.replace(/\.expected\.json$/, '')))
  .filter((n) => fs.existsSync(path.join(DIR, `${n}.html`)));

function runSharko(page) {
  const r = spawnSync(browser, ['--headless', '--settle=300', '--timeout=30000', '--wait-for=window.__done',
    '--eval=window.__out()', `file://${path.join(DIR, page + '.html')}`], { encoding: 'utf8', timeout: 90000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('"'));
  if (!line) throw new Error(`no result from Sharko for ${page}: ${(r.stderr || '').split('\n').slice(-3).join(' | ')}`);
  return JSON.parse(JSON.parse(line));
}

async function runChromium(page) {
  let pw;
  try { pw = require('playwright'); } catch (e) { pw = require(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'playwright')); }
  const b = await pw.chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(`file://${path.join(DIR, page + '.html')}`);
  await p.waitForFunction('window.__done === true', null, { timeout: 30000 });
  const v = await p.evaluate('window.__out()');
  await b.close();
  return JSON.parse(v);
}

(async () => {
  let bad = 0, total = 0, matched = 0;
  for (const page of pages) {
    if (update) {
      fs.writeFileSync(path.join(DIR, `${page}.expected.json`), JSON.stringify(await runChromium(page), null, 1) + '\n');
      console.log(`${page}: expected values written`);
      continue;
    }
    const exp = JSON.parse(fs.readFileSync(path.join(DIR, `${page}.expected.json`), 'utf8'));
    let got;
    try { got = runSharko(page); } catch (e) { console.log(`${page}: ERROR ${e.message}`); bad++; continue; }
    const keys = [...new Set([...Object.keys(exp), ...Object.keys(got)])].sort();
    const diff = keys.filter((k) => JSON.stringify(exp[k]) !== JSON.stringify(got[k]));
    total += keys.length; matched += keys.length - diff.length;
    console.log(`${page}: ${keys.length - diff.length}/${keys.length} probes match Chromium${diff.length ? ' | differ: ' + diff.join(', ') : ''}`);
    if (verbose) for (const k of diff) console.log(`  ${k}\n    chromium: ${JSON.stringify(exp[k])}\n    sharko:   ${JSON.stringify(got[k])}`);
    if (diff.length) bad++;
  }
  if (!update && pages.length > 1) console.log(`TOTAL: ${matched}/${total} probes match Chromium`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
