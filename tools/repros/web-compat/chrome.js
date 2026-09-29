#!/usr/bin/env node
// Headless Chromium (Playwright) configured for this environment (MITM proxy, bot-wall
// avoidance, Sharko's User-Agent, 1280x800). For comparing against Sharko's headless mode.
//
//   node chrome.js URL [--eval=JS]... [--screenshot=FILE.png] [--settle=MS] [--dark]
//                      [--console] [--headers] [--dump-dom] [--wait-for=JS] [--ua=STRING]
//
// --eval prints JSON.stringify of the result (async expressions are awaited);
// --console prints the page's console + uncaught errors; --headers prints the request
// headers of every request (method, url, headers) as JSON lines to stderr.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const all = (n) => args.filter((x) => x.startsWith(`--${n}=`)).map((x) => x.slice(n.length + 3));
const flag = (n) => args.includes(`--${n}`);
const url = args.find((a) => !a.startsWith('--'));
if (!url) { console.error('usage: node chrome.js URL [options]'); process.exit(2); }
const UA = opt('ua', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
(async () => {
  const proxy = process.env.HTTPS_PROXY;
  const b = await chromium.launch({
    headless: true, channel: 'chromium',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors', '--disable-features=UseMLKEM,PostQuantumKyber,EncryptedClientHello'],
    proxy: proxy ? { server: proxy, bypass: process.env.NO_PROXY || 'localhost,127.0.0.1' } : undefined,
  });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, locale: 'de-DE', userAgent: UA, colorScheme: flag('dark') ? 'dark' : 'light' });
  const p = await ctx.newPage();
  if (flag('console')) {
    p.on('console', (m) => console.error(`console.${m.type()}: ${m.text()}`));
    p.on('pageerror', (e) => console.error(`console.error: Uncaught ${e.message}`));
  }
  if (flag('headers')) p.on('request', (r) => console.error(JSON.stringify({ method: r.method(), url: r.url(), type: r.resourceType(), headers: r.headers() })));
  const timeout = parseInt(opt('timeout', '30000'), 10);
  try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout }); } catch (e) { console.error('[chrome] navigation: ' + e.message.split('\n')[0]); }
  try { await p.waitForLoadState('load', { timeout }); } catch (e) { console.error('[chrome] load timeout (continuing)'); }
  await p.waitForTimeout(parseInt(opt('settle', '2000'), 10));
  if (opt('wait-for')) { try { await p.waitForFunction(opt('wait-for'), null, { timeout }); } catch (e) { console.error('[chrome] wait-for timeout'); } }
  for (const src of all('eval')) {
    try { const v = await p.evaluate(`(async () => (${src}))()`); console.log(JSON.stringify(v)); }
    catch (e) { console.log('Error: ' + e.message.split('\n')[0]); }
  }
  if (flag('dump-dom')) console.log(await p.content());
  if (opt('screenshot')) await p.screenshot({ path: path.resolve(opt('screenshot')) });
  console.error(`[chrome] ${p.url()} title=${JSON.stringify(await p.title())}`);
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
