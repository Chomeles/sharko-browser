#!/usr/bin/env node
// Test server for the web-apis repro pages: static files from this directory plus a few API endpoints.
//   node tools/repros/web-apis/serve.js [port=18931]      (also listens on port+1: a second, cross-origin server)
// Pages: http://127.0.0.1:18931/NAME.html ; the cross-origin peer is http://127.0.0.1:18932 (same code, other origin).
// Endpoints (all under /api/):
//   cors?mode=none|star|reflect|creds|preflight   JSON echo; ACAO/ACAC/ACAM/ACAH per mode (OPTIONS answered for `preflight`)
//   log[?clear=1]     every request seen by this server as JSON [{method,url,origin,secFetchMode,acrm,acrh,cookie}]
//   slow?n=3&ms=300   n text chunks, ms apart (chunked)      sse   text/event-stream: 3 events, then closes after 1 s
//   servertiming   text with a Server-Timing header   redirect?to=URL&code=302   wasm   an empty WebAssembly module, wasm-add   one exporting add(i32,i32) (application/wasm)
// `?coi=1` on any static file adds COOP same-origin + COEP require-corp (cross-origin isolation).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), url = require('url');
const base = +(process.argv[2] || 18931);
const log = [];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.vtt': 'text/vtt' };
function handler(req, res) {
  const u = url.parse(req.url, true), h = req.headers;
  if (!u.pathname.startsWith('/api/log')) log.push({ method: req.method, url: req.url, origin: h.origin || null, secFetchMode: h['sec-fetch-mode'] || null, acrm: h['access-control-request-method'] || null, acrh: h['access-control-request-headers'] || null, acceptLanguage: h['accept-language'] || null, cookie: h.cookie || null });
  const send = (code, headers, body) => { res.writeHead(code, headers); res.end(body); };
  if (u.pathname === '/api/log') { if (u.query.clear) log.length = 0; return send(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }, JSON.stringify(log)); }
  if (u.pathname === '/api/cors') {
    const mode = u.query.mode || 'none', hd = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (mode === 'star') hd['access-control-allow-origin'] = '*';
    if (mode === 'reflect' || mode === 'creds' || mode === 'preflight') hd['access-control-allow-origin'] = h.origin || '*';
    if (mode === 'creds') hd['access-control-allow-credentials'] = 'true';
    if (mode === 'preflight' && req.method === 'OPTIONS') { hd['access-control-allow-methods'] = 'GET, POST, PUT, DELETE'; hd['access-control-allow-headers'] = h['access-control-request-headers'] || ''; hd['access-control-max-age'] = '5'; return send(204, hd, ''); }
    if (mode === 'preflight' && u.query.expose) hd['access-control-expose-headers'] = 'x-secret';
    hd['x-secret'] = 'yes';
    return send(200, hd, JSON.stringify({ method: req.method, origin: h.origin || null, custom: h['x-custom'] || null }));
  }
  if (u.pathname === '/api/slow') { const n = +(u.query.n || 3), ms = +(u.query.ms || 300); res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); let i = 0; const t = setInterval(() => { res.write('chunk' + i + '\n'); if (++i >= n) { clearInterval(t); res.end(); } }, ms); return; }
  if (u.pathname === '/api/sse') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' }); let i = 0; res.write('retry: 100\n\n'); const t = setInterval(() => { res.write((i === 1 ? 'event: named\n' : '') + 'id: ' + i + '\ndata: msg' + i + '\n\n'); if (++i >= 3) { clearInterval(t); setTimeout(() => res.end(), 1000); } }, 150); return; }
  if (u.pathname === '/api/redirect') return send(+(u.query.code || 302), { location: u.query.to, 'access-control-allow-origin': '*' }, '');
  if (u.pathname === '/api/servertiming') return send(200, { 'content-type': 'text/plain', 'server-timing': 'db;dur=53.5;desc="x"', 'timing-allow-origin': '*' }, 'ok');
  if (u.pathname === '/api/wasm-add') return send(200, { 'content-type': 'application/wasm' }, Buffer.from('AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=', 'base64'));
  if (u.pathname === '/api/wasm') return send(200, { 'content-type': 'application/wasm', 'access-control-allow-origin': '*' }, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const file = path.join(__dirname, path.normalize(u.pathname === '/' ? '/api-matrix.html' : u.pathname).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) return send(404, { 'content-type': 'text/plain' }, 'not found');
    const hd = { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' };
    if (u.query.coi) { hd['cross-origin-opener-policy'] = 'same-origin'; hd['cross-origin-embedder-policy'] = 'require-corp'; }
    send(200, hd, data);
  });
}
for (const p of [base, base + 1]) http.createServer(handler).listen(p, '127.0.0.1', () => console.log('serving http://127.0.0.1:' + p));
