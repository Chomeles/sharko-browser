#!/usr/bin/env node
// Drive tools/fuzz/dom-mutations.html through the headless binary with many seeds and
// report renderer panics, hangs and JS-layer errors.
//
//   node tools/fuzz/run.js [--seeds=N] [--start=S] [--rounds=R] [--clicks=C] [--jobs=J] [--browser=PATH]
//
// --clicks=C sends C native clicks at pseudo-random positions while the rounds run
// (the headless driver's clicks interleave with the page's timers), which exercises
// hit-testing on a layout that JS just mutated.
//
// A finding prints its seed; reproduce it with
//   browser --headless --console "file://$PWD/tools/fuzz/dom-mutations.html?seed=S&rounds=R"
// (add the same --clicks=C run's `--click=X,Y --click-wait=25` arguments for click findings).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const seeds = parseInt(opt('seeds', '50'), 10);
const start = parseInt(opt('start', '1'), 10);
const rounds = parseInt(opt('rounds', '200'), 10);
const clicks = parseInt(opt('clicks', '0'), 10);
const jobs = Math.max(1, parseInt(opt('jobs', String(Math.max(1, os.cpus().length - 1))), 10));
// Deterministic click positions per seed (the same LCG for every run).
function clickArgs(seed) {
  const out = [];
  let s = (seed * 2654435761) >>> 0;
  for (let i = 0; i < clicks; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const x = (s >>> 16) % 700;
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const y = (s >>> 16) % 400;
    out.push(`--click=${x},${y}`);
  }
  if (out.length) out.push('--click-wait=25');
  return out;
}
const browser =
  opt('browser') ||
  process.env.SHARKO_BIN ||
  [path.join(REPO, 'target/profiling/browser'), path.join(REPO, 'target/release/browser')].find((p) => fs.existsSync(p));
if (!browser || !fs.existsSync(browser)) {
  console.error('browser binary not found; build it or pass --browser=');
  process.exit(2);
}
const page = 'file://' + path.join(__dirname, 'dom-mutations.html');
// Generous: a round is a rAF + a timer, but some rounds trigger big relayouts.
const timeoutMs = 20000 + rounds * 100;

function runSeed(seed) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), `sharko-fuzz-${seed}-`));
    const child = spawn(
      browser,
      [
        '--headless',
        `--profile=${profile}`,
        `--timeout=${timeoutMs}`,
        '--settle=0',
        '--wait-for=window.__fuzz_done',
        '--eval=JSON.stringify(window.__fuzz_done)',
        '--eval=window.__fuzz_progress',
        '--console',
        ...clickArgs(seed),
        `${page}?seed=${seed}&rounds=${rounds}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t0 = Date.now();
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 15000);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      fs.rmSync(profile, { recursive: true, force: true });
      const panic = err.split('\n').filter((l) => /panicked at|renderer crashed|stack overflow|SIGSEGV/.test(l));
      const jsErrors = err.split('\n').filter((l) => /^console\.error/.test(l) && !/missing\.png|Failed to load/.test(l));
      const lines = out.trim().split('\n');
      let done = null;
      try {
        let v = JSON.parse(lines[0]);
        if (typeof v === 'string') v = JSON.parse(v);
        done = v;
      } catch (_) {}
      const progress = lines[1];
      let status = 'ok';
      if (panic.length || code === 3) status = 'PANIC';
      else if (signal === 'SIGKILL' || code === 4) status = 'HANG';
      else if (!done) status = 'NO-RESULT';
      else if (done.errors && done.errors.length) status = 'JS-ERROR';
      resolve({ seed, status, ms: Date.now() - t0, progress, panic: panic.slice(0, 3), jsErrors: jsErrors.slice(0, 3), done, code });
    });
  });
}

(async () => {
  const list = Array.from({ length: seeds }, (_, i) => start + i);
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const seed = list[next++];
      const r = await runSeed(seed);
      results.push(r);
      const tag = r.status === 'ok' ? '.' : `\n${r.status} seed=${r.seed} (round ${r.progress}/${rounds}, ${r.ms} ms)`;
      process.stdout.write(tag);
      for (const l of [...r.panic, ...r.jsErrors, ...((r.done && r.done.errors) || [])]) console.log(`   ${l.slice(0, 300)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, list.length) }, worker));
  const bad = results.filter((r) => r.status !== 'ok');
  console.log(`\n${results.length} seeds × ${rounds} rounds: ${results.length - bad.length} ok, ${bad.length} findings`);
  for (const r of bad.sort((a, b) => a.seed - b.seed)) console.log(`  ${r.status.padEnd(9)} seed=${r.seed}`);
  process.exit(bad.length ? 1 : 0);
})();
