#!/usr/bin/env node
// Run the network-security repro pages in Sharko (and with --chromium in Playwright's Chromium, to prove the expectation).
//   node tools/repros/network-security/run.js [--chromium] [--sharko=PATH] [--verbose] [PAGE.html ...]
// Contract of a page: window.__repro = {issue, expected, actual, pass}; expected = what Chromium does. Starts serve.py (three origins,
// ports 18941-18943) when nothing listens. Prints PASS / FAIL / XFAIL (listed in xfail.txt and failing) / XPASS (listed but passes:
// remove it from xfail.txt). Exit 1 on FAIL or XPASS. Sharko needs NO_PROXY=localhost,127.0.0.1 (set here); Playwright needs
// PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK=1 behind the sandbox proxy (set here).
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, spawnSync } = require('child_process');
const args = process.argv.slice(2), opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const REPO = path.resolve(__dirname, '..', '..', '..'), ORIGIN = 'http://localhost:18941';
const bin = opt('sharko', process.env.SHARKO_BIN || ['target/profiling/browser', 'target/release/browser'].map((p) => path.join(REPO, p)).find((p) => fs.existsSync(p)));
const xfail = new Set(fs.readFileSync(path.join(__dirname, 'xfail.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
let pages = args.filter((a) => !a.startsWith('--')).map((a) => path.basename(a));
if (!pages.length) pages = fs.readdirSync(__dirname).filter((f) => f.endsWith('.html')).sort();
const noProxy = ['localhost', '127.0.0.1', process.env.NO_PROXY].filter(Boolean).join(',');
const up = () => new Promise((r) => http.get(`${ORIGIN}/log?clear=1`, (res) => { res.resume(); r(true); }).on('error', () => r(false)));
const clear = () => new Promise((r) => http.get(`${ORIGIN}/log?clear=1`, (res) => { res.resume(); res.on('end', r); }).on('error', r));
const parse = (out) => { const l = (out || '').split('\n').find((x) => /^["{\[]/.test(x.trim())); if (!l) return null; let v = JSON.parse(l); if (typeof v === 'string') v = JSON.parse(v); return v; };
function sharko(page) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-repro-'));
  const r = spawnSync(bin, ['--headless', `--profile=${profile}`, '--settle=200', '--timeout=25000', '--wait-for=window.__repro', '--eval=JSON.stringify(window.__repro)', `${ORIGIN}/${page}`],
    { encoding: 'utf8', env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy }, timeout: 60000 });
  fs.rmSync(profile, { recursive: true, force: true });
  return parse(r.stdout);
}
async function chromium(pw, page) {
  const b = await pw.chromium.launch({ args: ['--no-sandbox'], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: noProxy } : undefined });
  const p = await (await b.newContext({ locale: 'de-DE' })).newPage();
  await p.goto(`${ORIGIN}/${page}`); await p.waitForFunction('window.__repro', null, { timeout: 25000 }).catch(() => {});
  const v = await p.evaluate(() => window.__repro); await b.close(); return v;
}
const show = (tag, r) => { for (const k of new Set([...Object.keys(r.expected || {}), ...Object.keys(r.actual || {})])) if (JSON.stringify((r.expected || {})[k]) !== JSON.stringify((r.actual || {})[k])) console.log(`        ${k}: expected ${JSON.stringify((r.expected || {})[k])}  ${tag} ${JSON.stringify((r.actual || {})[k])}`); };
(async () => {
  let srv = null;
  if (!(await up())) { srv = spawn('python3', [path.join(__dirname, 'serve.py')], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 700)); }
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  let pw = null;
  if (args.includes('--chromium')) { try { pw = require('playwright'); } catch (_) { pw = require(path.join(spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim(), 'playwright')); } }
  let bad = 0;
  for (const page of pages) {
    if (pw) { await clear(); const c = await chromium(pw, page); if (!(c && c.pass)) { console.log(`!     ${page}: Chromium does not meet its own expectation, fix the page`); if (c) show('Chromium', c); } }
    await clear();
    const r = sharko(page), listed = xfail.has(page), pass = !!(r && r.pass);
    const tag = pass ? (listed ? 'XPASS' : 'PASS') : (listed ? 'XFAIL' : 'FAIL'); if (tag === 'FAIL' || tag === 'XPASS') bad++;
    console.log(`${tag.padEnd(5)} ${page}${r ? '' : '  (no result: the page did not set window.__repro)'}`);
    if (!pass && r && (args.includes('--verbose') || tag === 'FAIL')) show('Sharko', r);
  }
  if (srv) srv.kill();
  process.exit(bad ? 1 : 0);
})();
