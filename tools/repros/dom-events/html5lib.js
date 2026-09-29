#!/usr/bin/env node
// html5lib tree-construction conformance of Sharko's two HTML parser paths, measured without the WPT server.
//
//   node tools/repros/dom-events/html5lib.js [--wpt=../wpt] [--verbose] [--only=tests1.dat]
//
// Test data: <wpt>/html/syntax/parsing/resources/*.dat (checked out by the sparse-checkout rule for `resources`).
//  A. "fragment/DOMParser path": DOMParser().parseFromString + innerHTML through crates/script/src/html.rs (FragmentSink).
//  B. "main parser path": every test as a file: URL loaded by the renderer's document parser (blitz-html's DocumentHtmlParser,
//     scripting enabled), then the tree is dumped in html5lib format. A renderer crash is reported as CRASH and the run goes on.
// Tests marked #script-off are only run in A (B runs with scripting on), fragment tests only in A.
// Known artifacts, not bugs: processing-instructions.dat (expects PI nodes, HTML parses them as comments), noscript*.dat
// (expects scripting off). They are counted but shown separately as "core" vs "all".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=').slice(1).join('=');
const wpt = path.resolve(opt('wpt', process.env.WPT_DIR || path.join(REPO, '..', 'wpt')));
const only = opt('only', '');
const verbose = args.includes('--verbose');
const browser = process.env.SHARKO_BIN || ['target/profiling/browser', 'target/release/browser'].map((p) => path.join(REPO, p)).find((p) => fs.existsSync(p));
if (!browser) { console.error('no browser binary: build it or set SHARKO_BIN'); process.exit(2); }
const dir = path.join(wpt, 'html/syntax/parsing/resources');
if (!fs.existsSync(dir)) { console.error(`missing ${dir}: see tools/wpt/README.md (sparse checkout)`); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'html5lib-'));

// ---- parse the .dat files ----
const KEYS = new Set(['data', 'errors', 'new-errors', 'document-fragment', 'script-off', 'script-on', 'document']);
function parseDat(text) {
  const tests = []; let cur = null, sec = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') && KEYS.has(line.slice(1))) {
      sec = line.slice(1);
      if (sec === 'data') { if (cur) tests.push(cur); cur = { data: [], fragment: null, script: null, doc: [] }; }
      continue;
    }
    if (!cur) continue;
    if (sec === 'data') cur.data.push(line);
    else if (sec === 'document-fragment') cur.fragment = line.trim();
    else if (sec === 'script-off') cur.script = 'off';
    else if (sec === 'script-on') cur.script = 'on';
    else if (sec === 'document') cur.doc.push(line);
  }
  if (cur) tests.push(cur);
  return tests.map((t) => {
    const doc = t.doc; while (doc.length && doc[doc.length - 1] === '') doc.pop();
    const data = t.data; if (data.length && data[data.length - 1] === '') data.pop();
    return { data: data.join('\n'), fragment: t.fragment, script: t.script, doc: doc.join('\n') };
  });
}
const all = [];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.dat') && (!only || f === only)).sort()) {
  for (const t of parseDat(fs.readFileSync(path.join(dir, f), 'utf8'))) all.push({ f, ...t });
}

// ---- tree dump in html5lib format (runs inside the page) ----
const DUMP = `function dump(node, depth, out) {
  var NS = { 'http://www.w3.org/2000/svg': 'svg ', 'http://www.w3.org/1998/Math/MathML': 'math ' };
  var pad = '| ' + '  '.repeat(depth);
  for (var c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) {
      out.push(pad + '<' + (NS[c.namespaceURI] || '') + c.localName + '>');
      Array.from(c.attributes).map(function (a) {
        var n = a.name;
        if (a.namespaceURI === 'http://www.w3.org/1999/xlink') n = 'xlink ' + a.localName;
        else if (a.namespaceURI === 'http://www.w3.org/XML/1998/namespace') n = 'xml ' + a.localName;
        else if (a.namespaceURI === 'http://www.w3.org/2000/xmlns/') n = 'xmlns ' + a.localName;
        return [n, a.value];
      }).sort(function (x, y) { return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0; }).forEach(function (p) { out.push(pad + '  ' + p[0] + '="' + p[1] + '"'); });
      if (c.localName === 'template' && c.namespaceURI === 'http://www.w3.org/1999/xhtml') { out.push(pad + '  content'); dump(c.content, depth + 2, out); }
      else dump(c, depth + 1, out);
    } else if (c.nodeType === 3) out.push(pad + '"' + c.data + '"');
    else if (c.nodeType === 8) out.push(pad + '<!-- ' + c.data + ' -->');
    else if (c.nodeType === 10) out.push(pad + '<!DOCTYPE ' + c.name + (c.publicId || c.systemId ? ' "' + c.publicId + '" "' + c.systemId + '"' : '') + '>');
  }
}`;

// ---- A: DOMParser / innerHTML path (one page) ----
const pageA = `<!doctype html><meta charset=utf-8><body><script>
${DUMP}
const TESTS = ${JSON.stringify(all).replace(/<\//g, '<\\/')};
const res = {};
function ctx(spec) {
  let ns = 'http://www.w3.org/1999/xhtml', name = spec;
  if (spec.startsWith('svg ')) { ns = 'http://www.w3.org/2000/svg'; name = spec.slice(4); } else if (spec.startsWith('math ')) { ns = 'http://www.w3.org/1998/Math/MathML'; name = spec.slice(5); }
  return document.createElementNS(ns, name);
}
TESTS.forEach((t, i) => {
  const out = [];
  try {
    if (t.fragment) { const el = ctx(t.fragment); el.innerHTML = t.data; dump(el, 0, out); }
    else dump(new DOMParser().parseFromString(t.data, 'text/html'), 0, out);
  } catch (e) { out.push('ERR ' + e.message); }
  res[i] = out.join('\\n');
});
window.__out = () => JSON.stringify(res); window.__done = true;
</script>`;
fs.writeFileSync(path.join(tmp, 'a.html'), pageA);
const ra = spawnSync(browser, ['--headless', '--settle=300', '--timeout=120000', '--wait-for=window.__done', '--eval=window.__out()', `file://${path.join(tmp, 'a.html')}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
const lineA = (ra.stdout || '').split('\n').find((l) => l.startsWith('"'));
const gotA = lineA ? JSON.parse(JSON.parse(lineA)) : null;
if (!gotA) console.error('path A produced no result:', (ra.stderr || '').split('\n').slice(-3).join(' | '));

// ---- B: main parser path (batch of file: URLs, restarted after a renderer crash) ----
const idxB = []; all.forEach((t, i) => { if (!t.fragment && t.script !== 'off') { fs.writeFileSync(path.join(tmp, `t${i}.html`), t.data); idxB.push(i); } });
const gotB = {}; const crashed = [];
let todo = idxB.slice();
const evalFn = `(function(){${DUMP} var out=[]; dump(document,0,out); return out.join('\\n');})()`;
while (todo.length) {
  const input = todo.map((i) => `file://${path.join(tmp, `t${i}.html`)}\t8000`).join('\n') + '\n';
  const r = spawnSync(browser, ['--headless', '--batch', '--settle=20', '--timeout=8000', '--wait-for=document.readyState==="complete"', `--eval=${evalFn}`], { input, encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = (r.stdout || '').split('\n').filter((l) => l.startsWith('{'));
  lines.forEach((l, k) => { try { gotB[todo[k]] = JSON.parse(JSON.parse(l).evals[0].value); } catch { gotB[todo[k]] = null; } });
  if (lines.length >= todo.length) break;
  crashed.push(todo[lines.length]); todo = todo.slice(lines.length + 1); // the test after the last answered one crashed the renderer
}

// ---- report ----
const ARTIFACT = /^(processing-instructions|noscript01)\.dat$/;
function score(name, got, filter) {
  let tot = 0, pass = 0, coreTot = 0, corePass = 0; const fails = [];
  for (const [i, g] of Object.entries(got)) {
    const t = all[i]; if (!filter(t)) continue;
    const ok = g === t.doc; tot++; if (ok) pass++;
    if (!ARTIFACT.test(t.f)) { coreTot++; if (ok) corePass++; }
    if (!ok) fails.push({ f: t.f, data: t.data, exp: t.doc, got: g });
  }
  console.log(`${name}: ${pass}/${tot} pass (${(100 * pass / tot).toFixed(1)}%), without known-artifact files ${corePass}/${coreTot}`);
  const by = {}; for (const f of fails) by[f.f] = (by[f.f] || 0) + 1;
  console.log('  failing files: ' + Object.entries(by).map(([f, n]) => `${f} ${n}`).join(', '));
  if (verbose) for (const f of fails.filter((x) => !ARTIFACT.test(x.f))) console.log(`  [${f.f}] ${JSON.stringify(f.data).slice(0, 100)}\n    exp: ${JSON.stringify(f.exp).slice(0, 200)}\n    got: ${JSON.stringify(f.got).slice(0, 200)}`);
}
if (gotA) score('A fragment/DOMParser path', gotA, () => true);
score('B main document parser', Object.fromEntries(Object.entries(gotB).filter(([, v]) => v !== null)), () => true);
console.log(`B renderer crashes (not counted above): ${crashed.length}${crashed.length ? ' -> ' + crashed.map((i) => JSON.stringify(all[i].data).slice(0, 40)).join(', ') : ''}`);
console.log(`(scratch files: ${tmp})`);
