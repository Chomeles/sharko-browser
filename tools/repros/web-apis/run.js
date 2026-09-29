#!/usr/bin/env node
// Run the web-apis repro pages (contract: window.__repro = {issue, expected, actual, pass}; expected = what Chromium gives).
//   node tools/repros/web-apis/run.js [--chromium] [--sharko=PATH] [--verbose] [PAGE.html ...]
// Starts serve.js when nothing listens on :18931. Prints PASS / FAIL / XFAIL (listed in xfail.txt, fails) / XPASS (listed but passes:
// remove it from xfail.txt) per page; --chromium also runs Playwright's Chromium (needs `npm i -g playwright`) and reports pages whose
// expectation Chromium itself does not meet. Exit 1 on FAIL or XPASS.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), { spawn, spawnSync } = require('child_process');
const args = process.argv.slice(2), opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const REPO = path.resolve(__dirname, '..', '..', '..'), PORT = 18931, ORIGIN = `http://127.0.0.1:${PORT}`;
const bin = opt('sharko', process.env.SHARKO_BIN || ['target/profiling/browser', 'target/release/browser'].map((p) => path.join(REPO, p)).find((p) => fs.existsSync(p)));
const xfail = new Set(fs.readFileSync(path.join(__dirname, 'xfail.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
let pages = args.filter((a) => !a.startsWith('--')).map((a) => path.basename(a));
if (!pages.length) pages = fs.readdirSync(__dirname).filter((f) => f.endsWith('.html') && /__repro|repro\.js/.test(fs.readFileSync(path.join(__dirname, f), 'utf8'))).sort();
const up = () => new Promise((r) => http.get(`${ORIGIN}/api/log`, (res) => { res.resume(); r(true); }).on('error', () => r(false)));
const noProxy = ['localhost', '127.0.0.1', process.env.NO_PROXY].filter(Boolean).join(',');
const parse = (out) => { const l = (out || '').split('\n').find((x) => /^["{\[]/.test(x.trim())); if (!l) return null; let v = JSON.parse(l); if (typeof v === 'string') v = JSON.parse(v); return v; };
function sharko(page) {
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wa-repro-'));
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
(async () => {
  let srv = null;
  if (!(await up())) { srv = spawn('node', [path.join(__dirname, 'serve.js'), String(PORT)], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 500)); }
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  let pw = null; if (args.includes('--chromium')) { try { pw = require('playwright'); } catch (_) { pw = require(path.join(spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim(), 'playwright')); } }
  let bad = 0;
  for (const page of pages) {
    const r = sharko(page), listed = xfail.has(page), pass = !!(r && r.pass);
    const tag = pass ? (listed ? 'XPASS' : 'PASS') : (listed ? 'XFAIL' : 'FAIL'); if (tag === 'FAIL' || tag === 'XPASS') bad++;
    console.log(`${tag.padEnd(5)} ${page}${r ? '' : '  (no result: the page did not set window.__repro)'}`);
    if (!pass && (args.includes('--verbose') || tag === 'FAIL') && r) for (const k of Object.keys(r.expected || {})) if (JSON.stringify(r.expected[k]) !== JSON.stringify((r.actual || {})[k])) console.log(`        ${k}: expected ${JSON.stringify(r.expected[k])}  got ${JSON.stringify((r.actual || {})[k])}`);
    if (pw) { const c = await chromium(pw, page); if (!(c && c.pass)) { console.log(`      ! Chromium does not meet the expectation of ${page}: fix the page`); if (c) for (const k of Object.keys(c.expected || {})) if (JSON.stringify(c.expected[k]) !== JSON.stringify((c.actual || {})[k])) console.log(`        ${k}: expected ${JSON.stringify(c.expected[k])}  Chromium ${JSON.stringify((c.actual || {})[k])}`); } }
  }
  if (srv) srv.kill();
  process.exit(bad ? 1 : 0);
})();
