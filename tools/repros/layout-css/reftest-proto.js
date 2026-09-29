#!/usr/bin/env node
// Prototype of a WPT reftest runner (see docs/lanes/layout-css.md, backlog item 1).
//   node reftest-proto.js [--wpt=../wpt] [--browser=target/profiling/browser] [--limit=100] [--sample=N (evenly spread)] [--jobs=2]
//                         [--verbose] css/css-flexbox css/css-position ...
// Needs `./wpt serve` running (tools/wpt/README.md). Screenshots test and reference at 800x600 through
// the headless binary and compares the pixels (fuzzy: <meta name=fuzzy>). Not the final design: no
// batch mode, refs are cached per run, chained references and print reftests are not handled.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const REPO = path.resolve(__dirname, '..', '..', '..');
const wpt = path.resolve(opt('wpt', process.env.WPT_DIR || path.join(REPO, '..', 'wpt')));
const browser = opt('browser', process.env.SHARKO_BIN || path.join(REPO, 'target/profiling/browser'));
const limit = parseInt(opt('limit', '100'), 10), sample = parseInt(opt('sample', '0'), 10), jobs = parseInt(opt('jobs', '2'), 10), verbose = args.includes('--verbose');
const dirs = args.filter((a) => !a.startsWith('--'));
const SUPPORT = new Set(['resources', 'support', 'reference', 'references', 'tools', 'common', 'fonts', 'images', 'media']);

function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SUPPORT.has(e.name) && !e.name.startsWith('.')) walk(p, out); }
    else if (/\.(html?|xht|xhtml)$/.test(e.name) && !/-(ref|notref)\./.test(e.name)) out.push(p);
  }
}
function parseTest(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (/testharness\.js/.test(src)) return null;
  const links = [...src.matchAll(/<link\s+[^>]*rel=["']?(match|mismatch)["']?[^>]*>/gi)].map((m) => {
    const href = (m[0].match(/href=["']?([^"'\s>]+)/i) || [])[1];
    return href && { rel: m[1].toLowerCase(), href };
  }).filter(Boolean);
  if (!links.length) return null;
  const rel = '/' + path.relative(wpt, file).split(path.sep).join('/');
  const fz = (src.match(/<meta\s+name=["']?fuzzy["']?\s+content=["']([^"']+)["']/i) || [])[1];
  let fuzzy = [0, 0];
  if (fz && !fz.includes(':')) {
    const m = fz.match(/(?:maxDifference=)?(\d+)(?:-(\d+))?\s*;\s*(?:totalPixels=)?(\d+)(?:-(\d+))?/);
    if (m) fuzzy = [parseInt(m[2] || m[1], 10), parseInt(m[4] || m[3], 10)];
  }
  const resolve = (h) => h.startsWith('/') ? h : path.posix.normalize(path.posix.join(path.posix.dirname(rel), h));
  return { id: rel, refs: links.map((l) => ({ rel: l.rel, url: resolve(l.href) })), fuzzy, wait: /class=["'][^"']*reftest-wait/.test(src) };
}
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0; if (!bpp) throw new Error('png colour type ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0, b = y ? px[dst - stride + i] : 0, c = i >= bpp && y ? px[dst - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + i] = v & 255;
    }
  }
  return { w, h, bpp, px };
}
function compare(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { diffPixels: Infinity, maxDiff: 255 };
  let n = 0, max = 0;
  for (let i = 0; i < a.w * a.h; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.px[i * a.bpp + c] - b.px[i * b.bpp + c]));
    if (d) { n++; if (d > max) max = d; }
  }
  return { diffPixels: n, maxDiff: max };
}
const noProxy = [process.env.NO_PROXY, 'web-platform.test', '.web-platform.test'].filter(Boolean).join(',');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reftest-'));
const shots = new Map();
function shoot(url, wait) {
  if (shots.has(url)) return shots.get(url);
  const out = path.join(tmp, shots.size + '.png');
  const pr = new Promise((resolve) => {
    const argv = ['--headless', `--profile=${path.join(tmp, 'p' + shots.size)}`, '--window-size=800x600', '--settle=150', '--timeout=15000',
      '--wait-for=!document.documentElement.classList.contains("reftest-wait")', `--screenshot=${out}`, `http://web-platform.test:8000${url}`];
    const c = spawn(browser, argv, { env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy }, stdio: 'ignore', detached: true });
    const t = setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch (_) {} }, 30000);
    c.on('close', () => { clearTimeout(t); try { resolve(decodePng(fs.readFileSync(out))); } catch (e) { resolve(null); } });
  });
  shots.set(url, pr);
  return pr;
}
(async () => {
  const files = []; for (const d of dirs) walk(path.join(wpt, d), files);
  let tests = files.map(parseTest).filter(Boolean);
  const total = tests.length;
  if (sample && sample < tests.length) { const stride = tests.length / sample; tests = Array.from({ length: sample }, (_, i) => tests[Math.floor(i * stride)]); }
  tests = tests.slice(0, limit);
  const res = { pass: 0, fail: 0, error: 0, missingRef: 0 }; const fails = []; const t0 = Date.now(); let next = 0;
  async function worker() {
    while (next < tests.length) {
      const t = tests[next++];
      if (t.refs.some((r) => !fs.existsSync(path.join(wpt, r.url.split('?')[0])))) { res.missingRef++; fails.push(`MISSING-REF ${t.id} (add its directory to the sparse checkout)`); continue; }
      const img = await shoot(t.id, t.wait);
      let ok = null;
      const matches = t.refs.filter((r) => r.rel === 'match'), mism = t.refs.filter((r) => r.rel === 'mismatch');
      let err = !img;
      let anyMatch = !matches.length, allMismatch = true, info = '';
      for (const r of matches) { const ri = await shoot(r.url); if (!ri || !img) { err = true; continue; } const c = compare(img, ri); if (c.maxDiff <= t.fuzzy[0] && c.diffPixels <= t.fuzzy[1]) anyMatch = true; else info = `${c.diffPixels}px max ${c.maxDiff}`; }
      for (const r of mism) { const ri = await shoot(r.url); if (!ri || !img) { err = true; continue; } const c = compare(img, ri); if (c.diffPixels === 0) { allMismatch = false; info = 'identical to mismatch ref'; } }
      if (err) { res.error++; fails.push(`ERROR ${t.id}`); }
      else if (anyMatch && allMismatch) res.pass++; else { res.fail++; fails.push(`FAIL  ${t.id} (${info})`); }
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker));
  console.log(`${dirs.join(' ')}: ${tests.length} of ${total} reftests in ${((Date.now() - t0) / 1000).toFixed(0)} s (${shots.size} screenshots): pass ${res.pass}, fail ${res.fail}, error ${res.error}, reference not checked out ${res.missingRef}`);
  if (verbose) console.log(fails.join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
})();
