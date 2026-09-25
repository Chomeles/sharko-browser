#!/usr/bin/env node
// Run web-platform-tests (testharness.js tests) against Sharko's headless binary and
// compare the results with tools/wpt/expected.json.
//
//   node tools/wpt/run.js [options] [path ...]
//
// Paths are directories or files relative to the WPT checkout (default: the
// DEFAULT_PATHS below). Requires a running `./wpt serve` in the checkout (see
// tools/wpt/README.md).
//
// Options:
//   --wpt=DIR          WPT checkout (default: $WPT_DIR or ../wpt)
//   --browser=PATH     browser binary (default: $SHARKO_BIN, target/profiling/browser or
//                      target/release/browser)
//   --jobs=N           parallel browsers (default: cores - 1)
//   --batch            each worker keeps one browser in --batch mode and loads the tests
//                      in turn (much faster than a process per test; storage is not
//                      reset between tests)
//   --timeout=MS       per-test budget (default 15000; tests marked timeout=long get 4x)
//   --filter=REGEX     only run tests whose id matches
//   --workers          also run the `.any.worker.html` / `.worker.html` variants
//   --update           rewrite the expectations for the tests that ran
//   --expected=FILE    expectations file (default tools/wpt/expected.json)
//   --json=FILE        write every result to FILE
//   --list             print the test ids and exit
//   --verbose          print every subtest
//   --console          pass the page's console output through
//
// Exit status: 0 = no regressions, 1 = regressions (unexpected results), 2 = setup error.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_PATHS = [
  'dom', 'html/webappapis', 'html/dom', 'html/browsers/windows', 'html/browsers/history',
  'html/infrastructure', 'html/semantics/scripting-1', 'html/semantics/forms',
  'fetch/api', 'url', 'encoding', 'xhr', 'FileAPI', 'webstorage', 'console',
  'webmessaging', 'custom-elements', 'shadow-dom', 'streams', 'hr-time', 'user-timing',
  'performance-timeline', 'compat', 'web-animations', 'css/cssom', 'css/cssom-view',
  'websockets', 'workers', 'eventsource', 'IndexedDB', 'cors',
];
// Directories that hold support files, never tests.
const SUPPORT_DIRS = new Set(['resources', 'support', 'tools', 'common', 'fonts', 'images', 'media']);

const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const flag = (name) => args.includes(`--${name}`);
const paths = args.filter((a) => !a.startsWith('--'));

const wptDir = path.resolve(opt('wpt', process.env.WPT_DIR || path.join(REPO, '..', 'wpt')));
const browser = opt(
  'browser',
  process.env.SHARKO_BIN ||
    [path.join(REPO, 'target/profiling/browser'), path.join(REPO, 'target/release/browser')].find(
      (p) => fs.existsSync(p),
    ),
);
const jobs = Math.max(1, parseInt(opt('jobs', String(Math.max(1, os.cpus().length - 1))), 10));
const baseTimeout = parseInt(opt('timeout', '15000'), 10);
const filter = opt('filter') ? new RegExp(opt('filter')) : null;
const expectedFile = path.resolve(opt('expected', path.join(__dirname, 'expected.json')));
const verbose = flag('verbose');

if (!browser || !fs.existsSync(browser)) {
  console.error(`browser binary not found (${browser}); build it or pass --browser=`);
  process.exit(2);
}
if (!fs.existsSync(path.join(wptDir, 'resources', 'testharness.js'))) {
  console.error(`no WPT checkout at ${wptDir} (pass --wpt= or set WPT_DIR)`);
  process.exit(2);
}

// Install the vendor hooks. WPT ships stubs; we always overwrite them so a fresh
// checkout works too.
for (const name of ['testharnessreport.js', 'testdriver-vendor.js']) {
  const hook = path.join(__dirname, name);
  const hookTarget = path.join(wptDir, 'resources', name);
  if (fs.readFileSync(hook, 'utf8') !== fs.readFileSync(hookTarget, 'utf8')) {
    fs.copyFileSync(hook, hookTarget);
  }
}

// ---- enumeration --------------------------------------------------------------

/** One runnable test: id is the URL path (+ query for variants). */
function enumerate(rel) {
  const abs = path.join(wptDir, rel);
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SUPPORT_DIRS.has(ent.name)) walk(full);
      } else {
        out.push(...testsForFile(full));
      }
    }
  };
  if (!fs.existsSync(abs)) {
    console.error(`no such path in WPT checkout: ${rel}`);
    process.exit(2);
  }
  if (fs.statSync(abs).isDirectory()) walk(abs);
  else out.push(...testsForFile(abs));
  return out;
}

function testsForFile(file) {
  const rel = '/' + path.relative(wptDir, file).split(path.sep).join('/');
  const name = path.basename(file);
  const parts = rel.split('/');
  if (parts.slice(1, -1).some((p) => SUPPORT_DIRS.has(p))) return [];
  if (/-(ref|notref|manual)\.(x?html?|xht)$/.test(name) || /\.(h2|serviceworker|sharedworker)\./.test(name)) {
    return [];
  }
  let urls = [];
  let src = null;
  if (name.endsWith('.any.js')) {
    src = fs.readFileSync(file, 'utf8');
    const globals = (src.match(/^\/\/ META: global=(.*)$/m) || [, 'window,dedicatedworker'])[1];
    const g = globals.split(',').map((s) => s.trim());
    const wantsWindow = g.includes('window') || g.includes('!worker') || (!g.some((x) => x === 'worker' || x === 'dedicatedworker') && !g.includes('!window'));
    if (wantsWindow || g.includes('!worker')) urls.push(rel.replace(/\.any\.js$/, '.any.html'));
    if (flag('workers') && (g.includes('worker') || g.includes('dedicatedworker'))) {
      urls.push(rel.replace(/\.any\.js$/, '.any.worker.html'));
    }
  } else if (name.endsWith('.window.js')) {
    src = fs.readFileSync(file, 'utf8');
    urls.push(rel.replace(/\.window\.js$/, '.window.html'));
  } else if (name.endsWith('.worker.js')) {
    if (!flag('workers')) return [];
    src = fs.readFileSync(file, 'utf8');
    urls.push(rel.replace(/\.worker\.js$/, '.worker.html'));
  } else if (/\.(html|htm|xhtml|xht)$/.test(name)) {
    src = fs.readFileSync(file, 'utf8');
    if (!/testharness\.js/.test(src)) return []; // reftest, support or manual test
    if (/<meta\s+name=["']?flags["']?\s+content=["']?[^"'>]*\bdom\b/.test(src)) return [];
    urls.push(rel);
  } else {
    return [];
  }
  const long =
    /<meta\s+name=["']?timeout["']?\s+content=["']?long/.test(src) || /^\/\/ META: timeout=long/m.test(src);
  const variants = [];
  for (const m of src.matchAll(/<meta\s+name=["']?variant["']?\s+content=["']([^"']*)["']/g)) variants.push(m[1]);
  for (const m of src.matchAll(/^\/\/ META: variant=(.*)$/gm)) variants.push(m[1].trim());
  const https = /\.https\./.test(name);
  const host = /\.www\./.test(name) ? 'www.web-platform.test' : 'web-platform.test';
  const out = [];
  for (const u of urls) {
    for (const v of variants.length ? variants : ['']) {
      out.push({ id: u + v, url: `${https ? 'https' : 'http'}://${host}:${https ? 8443 : 8000}${u}${v}`, long });
    }
  }
  return out;
}

let tests = [];
for (const p of paths.length ? paths : DEFAULT_PATHS) tests.push(...enumerate(p));
if (filter) tests = tests.filter((t) => filter.test(t.id));
if (flag('list')) {
  for (const t of tests) console.log(t.id);
  process.exit(0);
}
if (!tests.length) {
  console.error('no tests found');
  process.exit(2);
}

// ---- running ------------------------------------------------------------------

const noProxy = [process.env.NO_PROXY || process.env.no_proxy, 'web-platform.test', '.web-platform.test']
  .filter(Boolean)
  .join(',');
// The test server's CA (for the .https. tests), trusted in addition to the OS store.
const wptCa = path.join(wptDir, 'tools', 'certs', 'cacert.pem');
const browserEnv = {
  ...process.env,
  NO_PROXY: noProxy,
  no_proxy: noProxy,
  SHARKO_EXTRA_CA: [process.env.SHARKO_EXTRA_CA, fs.existsSync(wptCa) ? wptCa : null].filter(Boolean).join(path.delimiter),
};

/** SIGKILL a browser and its process group (renderer and network processes). */
function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { child.kill('SIGKILL'); } catch (_) {}
}

function runOne(test, n) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), `sharko-wpt-${process.pid}-${n}-`));
    const timeout = test.long ? baseTimeout * 4 : baseTimeout;
    const argv = [
      '--headless',
      `--profile=${profile}`,
      `--timeout=${timeout}`,
      '--settle=0',
      '--wait-for=window.__wpt_done',
      '--eval=JSON.stringify(window.__wpt_done)',
      '--console',
      test.url,
    ];
    const t0 = Date.now();
    // Own process group, so a timeout kill also takes the renderer/network children.
    const child = spawn(browser, argv, {
      env: browserEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const killer = setTimeout(() => killGroup(child), timeout + 10000);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      fs.rmSync(profile, { recursive: true, force: true });
      const ms = Date.now() - t0;
      const panic = stderr.split('\n').find((l) => /panicked at|\[headless\] renderer crashed/.test(l));
      let result = null;
      const line = stdout.split('\n').find((l) => l.startsWith('"') || l.startsWith('{'));
      if (line) {
        try {
          let v = JSON.parse(line);
          if (typeof v === 'string') v = JSON.parse(v);
          if (v && typeof v === 'object' && v.subtests) result = v;
        } catch (_) {}
      }
      let status;
      if (panic || code === 3 || signal === 'SIGKILL') {
        status = panic || code === 3 ? 'CRASH' : 'TIMEOUT';
      } else if (result) {
        status = result.status;
      } else if (code === 4 || /wait-for timeout/.test(stderr)) {
        status = 'TIMEOUT';
      } else {
        status = 'ERROR';
      }
      const message =
        panic ||
        (result && result.message) ||
        (status === 'ERROR' ? (stderr.split('\n').find((l) => /navigation failed|Error:/.test(l)) || `exit ${code}`) : null);
      const consoleLines = stderr.split('\n').filter((l) => /^console\.(error|warn)/.test(l));
      resolve({
        id: test.id,
        status,
        message,
        subtests: result ? result.subtests : [],
        ms,
        console: consoleLines.slice(0, 20),
        stdout: flag('console') ? stderr : undefined,
      });
    });
  });
}

/** A worker's long-lived `--batch` browser: one JSON result line per URL written to it. */
class BatchBrowser {
  constructor(n) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), `sharko-wpt-${process.pid}-b${n}-`));
    this.child = spawn(
      browser,
      ['--headless', '--batch', `--profile=${this.profile}`, '--settle=0', '--wait-for=window.__wpt_done', '--eval=JSON.stringify(window.__wpt_done)', 'about:blank'],
      { env: browserEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    );
    this.stderr = '';
    this.buf = '';
    this.pending = null; // {resolve} of the URL in flight
    this.child.stderr.on('data', (d) => {
      this.stderr += d;
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-10000);
    });
    this.child.stdout.on('data', (d) => {
      this.buf += d;
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (this.pending && line.startsWith('{')) {
          const p = this.pending;
          this.pending = null;
          p.resolve(line);
        }
      }
    });
    this.exited = new Promise((r) => this.child.on('close', (code, signal) => r({ code, signal })));
    this.child.on('close', () => {
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.resolve(null);
      }
      fs.rmSync(this.profile, { recursive: true, force: true });
    });
  }
  /** Resolves with the JSON line, or null on crash/timeout (the browser is then dead). */
  run(test, timeout) {
    return new Promise((resolve) => {
      const killer = setTimeout(() => killGroup(this.child), timeout + 10000);
      this.pending = { resolve: (line) => { clearTimeout(killer); resolve(line); } };
      this.stderr = '';
      this.child.stdin.write(`${test.url}\t${timeout}\n`);
    });
  }
  close() {
    try { this.child.stdin.end(); } catch (_) {}
    setTimeout(() => killGroup(this.child), 3000).unref();
  }
}

function batchResult(test, line, stderr, ms) {
  const panic = stderr.split('\n').find((l) => /panicked at|renderer crashed/.test(l));
  let r = null;
  try { r = line ? JSON.parse(line) : null; } catch (_) {}
  if (!r || r.crash || panic) {
    return { id: test.id, status: line ? 'CRASH' : 'TIMEOUT', message: panic || (r && r.crash ? 'renderer crashed' : 'no result (browser killed)'), subtests: [], ms, console: [] };
  }
  let result = null;
  const ev = r.evals && r.evals[0];
  if (ev && ev.ok) {
    try {
      let v = JSON.parse(ev.value);
      if (typeof v === 'string') v = JSON.parse(v);
      if (v && typeof v === 'object' && v.subtests) result = v;
    } catch (_) {}
  }
  let status;
  if (result) status = result.status;
  else if (r.load.startsWith('failed')) status = 'ERROR';
  else if (r.load === 'timeout' || r.wait === 'timeout') status = 'TIMEOUT';
  else status = 'ERROR';
  const consoleLines = (r.console || []).filter((l) => /^(error|warn)/.test(l)).map((l) => 'console.' + l);
  return {
    id: test.id,
    status,
    message: (result && result.message) || (status === 'ERROR' ? r.load : null),
    subtests: result ? result.subtests : [],
    ms: r.ms || ms,
    console: consoleLines.slice(0, 20),
    stdout: flag('console') ? consoleLines.join('\n') : undefined,
  };
}

async function runAll() {
  const results = new Array(tests.length);
  let next = 0;
  let done = 0;
  const t0 = Date.now();
  const batch = flag('batch');
  const worker = async (w) => {
    let bb = null;
    while (next < tests.length) {
      const i = next++;
      if (batch) {
        if (!bb) bb = new BatchBrowser(w);
        const timeout = tests[i].long ? baseTimeout * 4 : baseTimeout;
        const t1 = Date.now();
        const line = await bb.run(tests[i], timeout);
        results[i] = batchResult(tests[i], line, bb.stderr, Date.now() - t1);
        if (line === null || results[i].status === 'CRASH') {
          bb.close();
          await bb.exited;
          bb = null;
        }
      } else {
        results[i] = await runOne(tests[i], i);
      }
      done++;
      if (!verbose && process.stderr.isTTY) {
        process.stderr.write(`\r${done}/${tests.length} ${tests[i].id.slice(0, 70).padEnd(70)}`);
      } else if (!verbose && done % 50 === 0) {
        process.stderr.write(`${done}/${tests.length} after ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
      }
      if (verbose) printResult(results[i]);
    }
    if (bb) {
      bb.close();
      await bb.exited;
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tests.length) }, (_, w) => worker(w)));
  if (!verbose && process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(90) + '\r');
  return { results, ms: Date.now() - t0 };
}

function printResult(r) {
  console.log(`${r.status.padEnd(8)} ${r.id} (${r.ms} ms)${r.message ? ' — ' + r.message.split('\n')[0] : ''}`);
  for (const s of r.subtests) {
    console.log(`    ${s.status.padEnd(8)} ${s.name}${s.message && s.status !== 'PASS' ? ' — ' + s.message.split('\n')[0] : ''}`);
  }
  if (r.stdout) console.log(r.stdout.split('\n').map((l) => '    | ' + l).join('\n'));
}

// ---- expectations -------------------------------------------------------------
//
// expected.json maps a test id to { status, subtests: { name: status } } and only
// lists what does NOT pass: a missing test is expected to be OK with every subtest
// PASS; a listed test only names its non-PASS subtests.

function loadExpected() {
  try {
    return JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function entryFor(r) {
  const subtests = {};
  for (const s of r.subtests) if (s.status !== 'PASS') subtests[s.name] = s.status;
  if (r.status === 'OK' && !Object.keys(subtests).length) return null;
  const e = { status: r.status };
  if (Object.keys(subtests).length) e.subtests = subtests;
  return e;
}

function compare(results, expected) {
  const regressions = [];
  const improvements = [];
  for (const r of results) {
    const exp = expected[r.id] || { status: 'OK', subtests: {} };
    const expSub = exp.subtests || {};
    if (r.status !== exp.status) {
      (r.status === 'OK' ? improvements : regressions).push(`${r.id}: ${exp.status} → ${r.status}`);
    }
    const seen = new Set();
    for (const s of r.subtests) {
      seen.add(s.name);
      const want = expSub[s.name] || 'PASS';
      if (s.status === want) continue;
      const line = `${r.id} [${s.name}]: ${want} → ${s.status}`;
      if (s.status === 'PASS') improvements.push(line);
      else if (want === 'PASS') regressions.push(line);
      // FAIL ↔ TIMEOUT etc.: neither a regression nor an improvement.
    }
    for (const name of Object.keys(expSub)) {
      if (!seen.has(name) && r.status === 'OK') regressions.push(`${r.id} [${name}]: expected ${expSub[name]} but the subtest did not run`);
    }
  }
  return { regressions, improvements };
}

(async () => {
  console.error(`${tests.length} tests, ${jobs} jobs, ${browser}`);
  const { results, ms } = await runAll();
  const expected = loadExpected();
  const { regressions, improvements } = compare(results, expected);

  const ok = results.filter((r) => r.status === 'OK').length;
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const subs = results.flatMap((r) => r.subtests);
  const subPass = subs.filter((s) => s.status === 'PASS').length;
  console.log(
    `\n${results.length} tests in ${(ms / 1000).toFixed(1)} s: ${Object.entries(byStatus)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')} | subtests ${subPass}/${subs.length} pass (${subs.length ? ((100 * subPass) / subs.length).toFixed(1) : 0}%)`,
  );
  const crashes = results.filter((r) => r.status === 'CRASH');
  if (crashes.length) {
    console.log(`\nCRASH (${crashes.length}):`);
    for (const r of crashes) console.log(`  ${r.id}: ${(r.message || '').split('\n')[0]}`);
  }
  if (improvements.length) {
    console.log(`\nNEW PASS (${improvements.length}):`);
    for (const l of improvements.slice(0, 200)) console.log(`  ${l}`);
    if (improvements.length > 200) console.log(`  … ${improvements.length - 200} more`);
  }
  if (regressions.length) {
    console.log(`\nUNEXPECTED (${regressions.length}):`);
    for (const l of regressions.slice(0, 200)) console.log(`  ${l}`);
    if (regressions.length > 200) console.log(`  … ${regressions.length - 200} more`);
  }
  if (!improvements.length && !regressions.length) console.log('\nno changes against expectations');

  if (opt('json')) {
    fs.writeFileSync(opt('json'), JSON.stringify(results, null, 1));
  }
  if (flag('update')) {
    for (const r of results) {
      const e = entryFor(r);
      if (e) expected[r.id] = e;
      else delete expected[r.id];
    }
    const sorted = Object.fromEntries(Object.keys(expected).sort().map((k) => [k, expected[k]]));
    fs.writeFileSync(expectedFile, JSON.stringify(sorted, null, 1) + '\n');
    console.log(`\nupdated ${path.relative(process.cwd(), expectedFile)} (${Object.keys(sorted).length} entries)`);
    process.exit(0);
  }
  process.exit(regressions.length ? 1 : 0);
})();
