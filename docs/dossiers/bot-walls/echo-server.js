#!/usr/bin/env node
// Echo server: logs the raw header list (in wire order) of every request to a JSONL file.
// Usage: node echo-server.js PORT LOGFILE
'use strict';
const http = require('http');
const fs = require('fs');
const port = parseInt(process.argv[2] || '8787', 10);
const logfile = process.argv[3] || '/dev/stderr';
const tag = () => new Date().toISOString();

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>echo</title>
<link rel="stylesheet" href="/style.css">
<script src="/script.js"></script>
</head><body>
<h1>echo</h1>
<img src="/img.png" alt="">
<iframe src="/frame.html" width="100" height="50"></iframe>
<video src="/video.mp4" muted width="10" height="10"></video>
<script>
document.cookie = "jsc=1; path=/";
(async () => {
  const r = [];
  try { await fetch('/fetch-omit', {credentials: 'omit'}); r.push('fetch-omit'); } catch (e) { r.push('fetch-omit:' + e); }
  try { await fetch('/fetch-same', {credentials: 'same-origin'}); r.push('fetch-same'); } catch (e) { r.push('fetch-same:' + e); }
  try { await fetch('/fetch-include', {credentials: 'include'}); r.push('fetch-include'); } catch (e) { r.push('fetch-include:' + e); }
  try { await fetch('/fetch-post', {method: 'POST', body: 'a=1', headers: {'Content-Type': 'text/plain'}}); r.push('fetch-post'); } catch (e) { r.push('fetch-post:' + e); }
  try { await fetch('/fetch-json', {method: 'POST', body: '{}', headers: {'Content-Type': 'application/json', 'X-Custom': 'y'}}); r.push('fetch-json'); } catch (e) { r.push('fetch-json:' + e); }
  try { await fetch('http://127.0.0.1:${port}/fetch-cross', {mode: 'cors'}); r.push('fetch-cross'); } catch (e) { r.push('fetch-cross:' + e); }
  try { await fetch('http://127.0.0.1:${port}/fetch-cross-cred', {mode: 'cors', credentials: 'include'}); r.push('fetch-cross-cred'); } catch (e) { r.push('fetch-cross-cred:' + e); }
  await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/xhr'); x.onloadend = res; x.send(); });
  await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:${port}/xhr-cross'); x.withCredentials = true; x.onloadend = res; x.send(); });
  r.push('xhr');
  try { await fetch('/redirect-me'); r.push('redirect'); } catch (e) { r.push('redirect:' + e); }
  const f = new FontFace('EchoFont', 'url(/font.woff2)'); try { await f.load(); } catch (e) {}
  r.push('font');
  window.__done = r;
  document.title = 'done ' + r.length;
})();
</script>
</body></html>`;

const frame = `<!doctype html><html><head><title>frame</title></head><body>frame<script>fetch('/frame-fetch');</script></body></html>`;

const srv = http.createServer((req, res) => {
  const entry = {
    t: tag(),
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    rawHeaders: req.rawHeaders,
  };
  fs.appendFileSync(logfile, JSON.stringify(entry) + '\n');
  const cors = () => {
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-custom');
    }
  };
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.setHeader('Set-Cookie', ['sid=abc; Path=/; HttpOnly', 'pref=de; Path=/']);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page);
  } else if (u === '/frame.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(frame);
  } else if (u === '/style.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end('h1{color:red;background:url(/css-img.png)} @font-face{font-family:CssFont;src:url(/css-font.woff2)} h1{font-family:CssFont}');
  } else if (u === '/script.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end('window.__script = 1;');
  } else if (u === '/redirect-me') {
    res.statusCode = 302;
    res.setHeader('Location', '/redirected');
    res.end();
  } else if (u.endsWith('.png')) {
    res.setHeader('Content-Type', 'image/png');
    // 1x1 transparent PNG
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  } else if (req.method === 'OPTIONS') {
    cors();
    res.statusCode = 204;
    res.end();
  } else {
    cors();
    res.setHeader('Content-Type', 'text/plain');
    res.end('ok');
  }
});
srv.listen(port, '0.0.0.0', () => console.log(`echo server on ${port}, log ${logfile}`));
