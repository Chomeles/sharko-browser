#!/usr/bin/env node
// Run one page in Sharko (headless) and in Chromium (Playwright) with the same JS expression and print
// what differs. The expression must return a JSON string (see the repro pages: `window.report()`).
//
//   node tools/repros/layout-css/compare.js tools/repros/layout-css/matrix2.html 'window.report()'
//   node tools/repros/layout-css/compare.js https://example.com/ 'JSON.stringify(document.title)' [--sharko=PATH]
//
// A local file becomes file:///...; `--sharko` defaults to $SHARKO_BIN, target/profiling/browser, target/release/browser.
// Playwright: `npm i -g playwright && npx playwright install chromium` (or $PLAYWRIGHT_MODULE).
'use strict';
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const pos = args.filter((a) => !a.startsWith('--'));
if (pos.length < 2) { console.error('usage: compare.js PAGE-OR-URL "EXPRESSION" [--sharko=PATH] [--settle=MS] [--width=1280 --height=800]'); process.exit(2); }
const REPO = path.resolve(__dirname, '..', '..', '..');
const bin = opt('sharko', process.env.SHARKO_BIN || ['target/profiling/browser', 'target/release/browser'].map((p) => path.join(REPO, p)).find((p) => fs.existsSync(p)));
const settle = opt('settle', '800'), W = +opt('width', '1280'), H = +opt('height', '800');
const url = /^[a-z]+:/.test(pos[0]) ? pos[0] : 'file://' + path.resolve(pos[0]);
const expr = pos[1];
function parse(out) {
  const line = out.split('\n').find((l) => /^["{\[]/.test(l.trim()));
  if (!line) return undefined;
  let v = JSON.parse(line); if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} } return v;
}
function loadPlaywright() {
  const mod = process.env.PLAYWRIGHT_MODULE || 'playwright';
  try { return require(mod); } catch (_) {
    const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    return require(path.join(g, 'playwright'));
  }
}
function diff(a, b, p, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], p ? `${p}.${k}` : k, out);
  } else out.push(`${p}: Sharko ${JSON.stringify(a)}  Chromium ${JSON.stringify(b)}`);
}
(async () => {
  const noProxy = [process.env.NO_PROXY, 'localhost', '127.0.0.1', 'web-platform.test', '.web-platform.test'].filter(Boolean).join(',');
  const r = spawnSync(bin, ['--headless', `--window-size=${W}x${H}`, `--settle=${settle}`, '--timeout=60000', `--eval=${expr}`, url], { encoding: 'utf8', env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy }, maxBuffer: 256 << 20 });
  const sharko = parse(r.stdout || '');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const pw = loadPlaywright();
  const launch = { headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'], proxy: proxy ? { server: proxy, bypass: noProxy } : undefined };
  let b; try { b = await pw.chromium.launch({ ...launch, channel: 'chromium' }); } catch (_) { b = await pw.chromium.launch(launch); }
  const ctx = await b.newContext({ viewport: { width: W, height: H }, ignoreHTTPSErrors: true, locale: 'de-DE' });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(+settle);
  const chrome = parse(String(await page.evaluate(expr)) + '\n') ?? (await page.evaluate(expr));
  await b.close();
  const lines = []; diff(sharko, typeof chrome === 'string' ? (() => { try { return JSON.parse(chrome); } catch (_) { return chrome; } })() : chrome, '', lines);
  console.log(lines.length ? lines.join('\n') : 'identical');
  if (sharko === undefined) console.log('(Sharko printed no JSON line; stderr: ' + (r.stderr || '').split('\n').slice(-3).join(' | ') + ')');
})();
