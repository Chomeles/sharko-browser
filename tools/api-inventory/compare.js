#!/usr/bin/env node
// Diff the Web API surface of Sharko against Chromium.
//
//   node tools/api-inventory/compare.js [--out=DIR] [--sharko=dump.json] [--chromium=dump.json]
//
// Runs tools/api-inventory/inventory.html in both browsers (Chromium through Playwright,
// which must be installed: `npm i -g playwright` or an existing install found via
// $PLAYWRIGHT_MODULE) and prints what Sharko lacks: globals, interface members,
// members of well-known objects and CSS properties. Dumps are written to --out
// (default: tools/api-inventory/out, git-ignored) and can be reused with --sharko= /
// --chromium= to skip a browser.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const outDir = path.resolve(opt('out', path.join(__dirname, 'out')));
fs.mkdirSync(outDir, { recursive: true });
const page = 'file://' + path.join(__dirname, 'inventory.html');

function dumpSharko() {
  const browser =
    process.env.SHARKO_BIN ||
    [path.join(REPO, 'target/profiling/browser'), path.join(REPO, 'target/release/browser')].find((p) => fs.existsSync(p));
  if (!browser) throw new Error('browser binary not found; build it or set SHARKO_BIN');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sharko-inv-'));
  const r = spawnSync(
    browser,
    ['--headless', `--profile=${profile}`, '--settle=0', '--wait-for=window.__api', '--eval=JSON.stringify(window.__api)', page],
    { encoding: 'utf8', timeout: 60000 },
  );
  fs.rmSync(profile, { recursive: true, force: true });
  const line = r.stdout.split('\n').find((l) => l.startsWith('"') || l.startsWith('{'));
  if (!line) throw new Error(`no inventory from Sharko:\n${r.stderr}`);
  let v = JSON.parse(line);
  if (typeof v === 'string') v = JSON.parse(v);
  return v;
}

async function dumpChromium() {
  const mod = process.env.PLAYWRIGHT_MODULE || 'playwright';
  let chromium;
  try {
    ({ chromium } = require(mod));
  } catch (e) {
    throw new Error(`Playwright not found (${mod}); npm i -g playwright or set PLAYWRIGHT_MODULE`);
  }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(page, { waitUntil: 'load' });
  const v = await p.evaluate(() => window.__api);
  await b.close();
  return v;
}

function diffMembers(a, b) {
  // members in b (Chromium) that a (Sharko) lacks
  return Object.keys(b || {}).filter((k) => !(a || {})[k]);
}

(async () => {
  let sharko = opt('sharko') ? JSON.parse(fs.readFileSync(opt('sharko'), 'utf8')) : null;
  let chromium = opt('chromium') ? JSON.parse(fs.readFileSync(opt('chromium'), 'utf8')) : null;
  if (!sharko) {
    sharko = dumpSharko();
    fs.writeFileSync(path.join(outDir, 'sharko.json'), JSON.stringify(sharko, null, 1));
  }
  if (!chromium) {
    chromium = await dumpChromium();
    fs.writeFileSync(path.join(outDir, 'chromium.json'), JSON.stringify(chromium, null, 1));
  }

  const missingGlobals = Object.keys(chromium.globals).filter((g) => !(g in sharko.globals));
  const byType = {};
  for (const g of missingGlobals) (byType[chromium.globals[g]] ||= []).push(g);
  console.log(`# Globals: Sharko ${Object.keys(sharko.globals).length}, Chromium ${Object.keys(chromium.globals).length}, missing ${missingGlobals.length}`);
  for (const [t, names] of Object.entries(byType)) {
    console.log(`\n## missing ${t} (${names.length})`);
    console.log(names.join(' '));
  }

  const shared = Object.keys(chromium.interfaces).filter((i) => sharko.interfaces[i]);
  const partial = [];
  for (const i of shared) {
    const s = sharko.interfaces[i];
    // Everything Sharko's interface has, own or inherited along its prototype chain.
    const withInherited = (kind) => {
      const out = Object.assign({}, s[kind]);
      for (const base of s.chain || []) {
        const b = sharko.interfaces[base];
        if (b) for (const k of Object.keys(b[kind])) if (!(k in out)) out[k] = 'inherited';
      }
      return out;
    };
    const proto = diffMembers(withInherited('proto'), chromium.interfaces[i].proto);
    const stat = diffMembers(withInherited('static'), chromium.interfaces[i].static);
    if (proto.length || stat.length) partial.push({ i, proto, stat, total: Object.keys(chromium.interfaces[i].proto).length });
  }
  partial.sort((a, b) => b.proto.length + b.stat.length - (a.proto.length + a.stat.length));
  console.log(`\n# Interfaces present in both: ${shared.length}; with missing members: ${partial.length}`);
  for (const p of partial) {
    const parts = [];
    if (p.proto.length) parts.push(`${p.proto.length}/${p.total} proto: ${p.proto.join(' ')}`);
    if (p.stat.length) parts.push(`static: ${p.stat.join(' ')}`);
    console.log(`- ${p.i}: ${parts.join(' | ')}`);
  }

  console.log('\n# Well-known objects');
  for (const name of Object.keys(chromium.instances)) {
    const c = chromium.instances[name];
    const s = sharko.instances[name];
    if (typeof c !== 'object') continue;
    if (typeof s !== 'object') {
      console.log(`- ${name}: ${s} in Sharko (${Object.keys(c).length} members in Chromium)`);
      continue;
    }
    const miss = diffMembers(s, c);
    if (miss.length) console.log(`- ${name}: missing ${miss.length}/${Object.keys(c).length}: ${miss.join(' ')}`);
  }

  const cssMissing = chromium.cssProperties.filter((p) => !sharko.cssProperties.includes(p));
  console.log(`\n# CSS properties: Sharko ${sharko.cssProperties.length}, Chromium ${chromium.cssProperties.length}, missing ${cssMissing.length}`);
  console.log(cssMissing.join(' '));
})().catch((e) => {
  console.error(e.message || e);
  process.exit(2);
});
