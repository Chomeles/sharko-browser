'use strict';
// Playwright tracer: logs requests/responses/failures with sizes, saves challenge bodies.
const fs = require('fs');
const { chromium } = require('playwright');
const url = process.argv[2];
const settle = parseInt(process.argv[3] || '15000', 10);
const initFile = process.argv[4];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
(async () => {
  const proxy = process.env.HTTPS_PROXY;
  const b = await chromium.launch({ headless: true, channel: 'chromium',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors', '--disable-features=UseMLKEM,PostQuantumKyber,EncryptedClientHello'],
    proxy: proxy ? { server: proxy, bypass: process.env.NO_PROXY || 'localhost,127.0.0.1' } : undefined });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, locale: 'de-DE', userAgent: UA });
  if (initFile) await ctx.addInitScript({ content: fs.readFileSync(initFile, 'utf8') });
  const p = await ctx.newPage();
  let n = 0;
  p.on('console', (m) => { const t = m.text(); if (t.startsWith('@@')) console.log(t); else console.error('console.' + m.type() + ': ' + t.slice(0, 300)); });
  p.on('pageerror', (e) => console.error('pageerror: ' + e.message));
  p.on('requestfailed', (r) => console.error('REQFAILED ' + r.url().slice(0, 140) + ' ' + (r.failure() || {}).errorText));
  p.on('request', (r) => { if (r.method() === 'POST') console.error('POST ' + r.url().replace(/([A-Za-z0-9_.:-]{30})[A-Za-z0-9_.:-]{20,}/g, '$1…').slice(0, 200) + ' body=' + (r.postData() || '').length); });
  p.on('response', async (r) => {
    const u = r.url();
    try {
      const body = await r.body();
      console.error('RESP ' + r.status() + ' ' + body.length + ' ' + u.replace(/([A-Za-z0-9_.:-]{30})[A-Za-z0-9_.:-]{20,}/g, '$1…').slice(0, 170));
      if (/challenge-platform|turnstile/.test(u)) fs.writeFileSync((process.env.DLDIR||'dl')+'/' + (n++) + '_' + r.request().method() + '_' + u.replace(/[^A-Za-z0-9]/g, '_').slice(-60), body);
    } catch (e) {}
  });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.error('nav ' + e.message.split('\n')[0]));
  await p.waitForTimeout(settle);
  console.error('TITLE ' + await p.title() + ' cookie=' + await p.evaluate('document.cookie'));
  for (const f of p.frames()) console.error('FRAME ' + f.url().slice(0, 120));
  await b.close();
})();
