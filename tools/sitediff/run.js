#!/usr/bin/env node
// Load real sites in Sharko and in Chromium and diff the results — visible text, element
// boxes and styles, images, page height, screenshots and console errors — to find what
// Sharko gets wrong, and to rank the causes by how many sites they break.
//
//   node tools/sitediff/run.js [options] [URL ...]
//
// Without URLs the curated list in tools/sitediff/sites.txt is used; --random adds
// domains drawn from the Tranco top list, so the sample is not only sites we know.
//
// Options:
//   --sites=FILE       URL list, one per line, # comments (default tools/sitediff/sites.txt)
//   --random=N         add N random domains from the Tranco top --top (default 5000) list
//                      (downloaded to --out on first use); --seed=S makes the draw repeatable
//   --filter=REGEX     only sites whose URL matches
//   --out=DIR          results (default tools/sitediff/out; git-ignored)
//   --jobs=N           sites in parallel (default 3)
//   --settle=MS        wait after `load` before probing (default 3000)
//   --timeout=MS       load timeout (default 30000)
//   --dark             prefers-color-scheme: dark in both browsers
//   --browser=PATH     Sharko binary (default $SHARKO_BIN, target/profiling or target/release)
//   --refresh          re-run Chromium even when a reference from an earlier run exists
//   --compare-only     only recompute the diffs/report from the existing results
//   --list             print the resolved site list and exit
//
// Output: out/<site>/{chromium,sharko}.{json,png}, out/<site>/sharko.log (console),
// out/<site>/diff.json, plus out/summary.json and out/report.md ranking the sites by how
// far Sharko is from Chromium and listing the Sharko-only errors across all sites.
// Chromium results are cached (they are the reference); Sharko is re-run every time, so
// after a fix `node tools/sitediff/run.js` shows what it changed.
//
// Needs Playwright (`npm i -g playwright`, or $PLAYWRIGHT_MODULE) with its Chromium.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { source: PROBE } = require('./probe.js');

const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const flag = (name) => args.includes(`--${name}`);
const urlArgs = args.filter((a) => !a.startsWith('--'));

const outDir = path.resolve(opt('out', path.join(__dirname, 'out')));
const jobs = Math.max(1, parseInt(opt('jobs', '3'), 10));
const settle = parseInt(opt('settle', '3000'), 10);
const timeout = parseInt(opt('timeout', '30000'), 10);
const dark = flag('dark');
const filter = opt('filter') ? new RegExp(opt('filter')) : null;
const WIDTH = 1280;
const HEIGHT = 800;
// Same UA as Sharko (common::USER_AGENT) so both get the same markup.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const browserBin =
  opt('browser') ||
  process.env.SHARKO_BIN ||
  [path.join(REPO, 'target/profiling/browser'), path.join(REPO, 'target/release/browser')].find((p) => fs.existsSync(p));

fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------- sites

function readSites(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
}

// Domains from the Tranco list that are not web sites (CDNs, ad tech, APIs, mail).
const INFRA =
  /(^|\.)(cdn|api|static|img|images|assets|edge|mail|smtp|ns\d?|dns|ntp|track|stats|pixel|ads?|adserver|analytics|metrics|telemetry|update|download)\.|cdn|akamai|cloudfront|cloudflare|fastly|edgekey|edgesuite|akadns|amazonaws|azure|windows\.net|office|live\.com|msn\.com|microsoft|apple\.com|icloud|googleapis|gstatic|googleusercontent|googlevideo|ggpht|ytimg|doubleclick|googlesyndication|google-analytics|googletagmanager|gvt\d|1e100|fbcdn|facebook\.net|licdn|twimg|tiktokcdn|ttvnw|scdn\.co|sentry|newrelic|nr-data|omtrdc|demdex|adobedtm|criteo|rubiconproject|pubmatic|casalemedia|openx|adnxs|taboola|outbrain|scorecardresearch|quantserve|hotjar|mixpanel|segment\.(io|com)|onetrust|cookielaw|trustarc|jsdelivr|unpkg|bootstrapcdn|typekit|fontawesome|gravatar|wp\.com|w\.org|mozilla\.net|digicert|letsencrypt|globalsign|sectigo|godaddy|arpa|root-servers|in-addr|dropbox\.com|zoom\.us|slack\.com|whatsapp|snapchat|tiktok\.com|instagram|facebook\.com|twitter\.com|x\.com|netflix|spotify|apple-dns|windowsupdate|xboxlive|playstation|nintendo|steampowered|ea\.com|riotgames|epicgames|discord|telegram|signal\.org|adjust\.com|appsflyer|branch\.io|onesignal|pusher|intercom|zendesk|hubspot|salesforce|force\.com|marketo|pardot|mailchimp|sendgrid|mailgun|sparkpost|amazonses|paypal|stripe\.com|braintree|adyen|klarna|shopify\.com|myshopify|bigcommerce|squarespace|wixsite|weebly|blogspot|wordpress\.com|tumblr|medium\.com|ampproject|archive\.org|gov$|mil$|edu$|\.(ru|cn|ir|kp|by|su)$/i;

function randomSites(n, top, seed) {
  const csv = path.join(outDir, 'tranco-top-1m.csv');
  if (!fs.existsSync(csv)) {
    const zip = path.join(outDir, 'tranco.zip');
    console.error('downloading the Tranco list ...');
    const r = spawnSync('curl', ['-sSL', '-o', zip, 'https://tranco-list.eu/top-1m.csv.zip'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('could not download https://tranco-list.eu/top-1m.csv.zip');
    const u = spawnSync('unzip', ['-o', '-q', zip, '-d', outDir]);
    if (u.status !== 0) throw new Error('unzip failed');
    fs.renameSync(path.join(outDir, 'top-1m.csv'), csv);
    fs.unlinkSync(zip);
  }
  const lines = fs.readFileSync(csv, 'utf8').split('\n', top + 1).slice(0, top);
  const domains = lines.map((l) => l.split(',')[1]).filter((d) => d && !INFRA.test(d));
  // Seeded PRNG (mulberry32) so a run can be repeated with --seed.
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked = new Set();
  while (picked.size < Math.min(n, domains.length)) picked.add(domains[Math.floor(rnd() * domains.length)]);
  return [...picked].map((d) => `https://${d}/`);
}

function resolveSites() {
  let sites = urlArgs.length ? urlArgs : readSites(opt('sites', path.join(__dirname, 'sites.txt')));
  if (opt('random')) {
    sites = sites.concat(randomSites(parseInt(opt('random'), 10), parseInt(opt('top', '5000'), 10), parseInt(opt('seed', '1'), 10)));
  }
  sites = [...new Set(sites)];
  if (filter) sites = sites.filter((u) => filter.test(u));
  return sites;
}

function slugOf(url) {
  const u = new URL(url);
  const p = (u.hostname.replace(/^www\./, '') + u.pathname + u.search).replace(/[^A-Za-z0-9.-]+/g, '_').replace(/_+$/, '');
  return p.slice(0, 80);
}

// ---------------------------------------------------------------------------- Chromium

let playwright = null;
function loadPlaywright() {
  const mod = process.env.PLAYWRIGHT_MODULE || 'playwright';
  try {
    return require(mod);
  } catch (e) {
    // A global install (npm i -g playwright) is not on the require path.
    const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    try {
      return require(path.join(g, 'playwright'));
    } catch (e2) {
      throw new Error(`Playwright not found (${mod}); npm i -g playwright or set PLAYWRIGHT_MODULE`);
    }
  }
}

async function launchChromium() {
  playwright = loadPlaywright();
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const launch = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--ignore-certificate-errors',
      // Post-quantum key agreement splits the ClientHello; some MITM proxies then fail
      // the handshake (net::ERR_TOO_MANY_RETRIES on random resources).
      '--disable-features=UseMLKEM,PostQuantumKyber,EncryptedClientHello',
    ],
  };
  // The full Chromium (new headless) when installed: the headless shell trips bot walls.
  try {
    return await playwright.chromium.launch({ ...launch, channel: 'chromium', proxy: proxyOpt(proxy) });
  } catch (e) {
    return await playwright.chromium.launch({ ...launch, proxy: proxyOpt(proxy) });
  }
}
function proxyOpt(proxy) {
  return proxy ? { server: proxy, bypass: process.env.NO_PROXY || 'localhost,127.0.0.1' } : undefined;
}

const BLOCKED = /nur einen moment|just a moment|attention required|access denied|verify you are|are you a robot|captcha|pardon our interruption|bot detection|zugriff verweigert|403 forbidden|request blocked/i;

async function runChromium(browser, url, dir) {
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    ignoreHTTPSErrors: true,
    locale: 'de-DE',
    userAgent: USER_AGENT,
    colorScheme: dark ? 'dark' : 'light',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('Uncaught ' + String(e.message || e).split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().split('\n')[0]);
  });
  const res = { url, engine: 'chromium', status: 'ok' };
  const t0 = Date.now();
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    res.http = r ? r.status() : null;
  } catch (e) {
    res.status = 'failed';
    res.error = String(e.message || e).split('\n')[0];
    await ctx.close();
    return res;
  }
  // Like Sharko's headless mode: give `load` a while, then carry on with what there is
  // (ad and tracking requests keep some pages from ever reaching `load`).
  try {
    await page.waitForLoadState('load', { timeout });
    res.loadMs = Date.now() - t0;
  } catch (e) {
    res.loadTimeout = true;
  }
  await page.waitForTimeout(settle);
  try {
    res.probe = await page.evaluate(PROBE);
  } catch (e) {
    res.status = 'failed';
    res.error = 'probe: ' + String(e.message || e).split('\n')[0];
  }
  res.errors = errors.slice(0, 200);
  if (res.probe && (BLOCKED.test(res.probe.title) || [403, 429, 503].includes(res.http))) {
    res.status = 'blocked';
  }
  if (res.probe && res.probe.doc && res.probe.doc.scrollH <= 1 && res.probe.text === '') res.status = 'empty';
  try {
    await page.screenshot({ path: path.join(dir, 'chromium.png'), timeout: 15000 });
  } catch (e) {
    res.screenshotError = String(e.message || e).split('\n')[0];
  }
  await ctx.close();
  return res;
}

// ---------------------------------------------------------------------------- Sharko

function runSharko(url, dir) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sharko-sitediff-'));
    const png = path.join(dir, 'sharko.png');
    const argv = [
      '--headless',
      `--profile=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      `--timeout=${timeout}`,
      `--settle=${settle}`,
      '--console',
      `--screenshot=${png}`,
      `--eval=JSON.stringify(${PROBE})`,
      url,
    ];
    const env = { ...process.env };
    if (dark) env.SHARKO_DARK = '1';
    else delete env.SHARKO_DARK;
    const t0 = Date.now();
    const child = spawn(browserBin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      if (stderr.length < 4_000_000) stderr += d;
    });
    let killed = false;
    const killer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeout + settle + 30000);
    child.on('close', (code) => {
      clearTimeout(killer);
      fs.rmSync(profile, { recursive: true, force: true });
      const res = { url, engine: 'sharko', status: 'ok', exit: code, ms: Date.now() - t0 };
      const console_ = [];
      for (const line of stderr.split('\n')) {
        const m = /^console\.(\w+): ([\s\S]*)$/.exec(line);
        if (m) console_.push({ level: m[1], text: m[2] });
      }
      res.errors = console_.filter((c) => c.level === 'error').map((c) => c.text.split('\n')[0]).slice(0, 200);
      res.consoleCount = console_.length;
      const headless = stderr.split('\n').filter((l) => l.startsWith('[headless]'));
      res.headless = headless;
      const tm = /first frame ([^|]+)\| DOMContentLoaded ([^|]+)\| load ([^|]+)\|/.exec(headless.join('\n'));
      if (tm) res.timings = { firstFrame: tm[1].trim(), dcl: tm[2].trim(), load: tm[3].trim() };
      if (killed) res.status = 'hang';
      else if (code === 3 || /renderer crashed/.test(stderr)) res.status = 'crash';
      else if (code === 2) res.status = 'failed';
      else if (/navigation failed/.test(stderr)) {
        res.status = 'failed';
        res.error = (/navigation failed: (.*)/.exec(stderr) || [])[1];
      } else if (/load timeout/.test(stderr)) res.status = 'timeout';
      const line = stdout.split('\n').find((l) => l.startsWith('"') || l.startsWith('{'));
      if (line) {
        try {
          let v = JSON.parse(line);
          if (typeof v === 'string') v = JSON.parse(v);
          res.probe = v;
        } catch (e) {
          res.probeError = 'unparsable probe result';
        }
      } else {
        const err = stdout.split('\n').find((l) => l.startsWith('Error:'));
        if (err) res.probeError = err;
      }
      fs.writeFileSync(path.join(dir, 'sharko.log'), stderr);
      resolve(res);
    });
  });
}

// ---------------------------------------------------------------------------- compare

function words(text) {
  const m = (text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]+/gu) || [];
  return new Set(m.filter((w) => w.length >= 3));
}

function parseColor(c) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(c || '');
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}
function luminance(c) {
  const p = parseColor(c);
  if (!p || p.a < 0.5) return null;
  return (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b) / 255;
}
function lumClass(c) {
  const l = luminance(c);
  return l === null ? null : l < 0.3 ? 'dark' : l > 0.7 ? 'light' : 'mid';
}

// Strip the volatile parts of an error message so the same bug on two sites matches.
function signature(msg) {
  return msg
    .replace(/https?:\/\/[^\s)'"]+/g, 'URL')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'HEX')
    .replace(/\d+/g, 'N')
    .replace(/'[^']{40,}'/g, "'…'")
    .slice(0, 160);
}

const API_RE = [
  /(?:^|\W)([\w.$]+) is not a function/,
  /(?:^|\W)([\w$]+) is not defined/,
  /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '([\w$]+)'\)/,
  /(?:^|\W)([\w.$]+) is not a constructor/,
  /Failed to execute '([\w$]+)' on '([\w$]+)'/,
  /Illegal (?:invocation|constructor)/,
];
function apiHints(msg) {
  const hints = [];
  for (const re of API_RE) {
    const m = re.exec(msg);
    if (m) hints.push(m.slice(1).filter(Boolean).join(' on ') || m[0]);
  }
  return hints;
}

// The reference itself can be incomplete (a stylesheet that never arrived, an ad wall):
// Chromium sees far fewer CSS rules than Sharko although it could read as many sheets.
function referenceSuspect(c, s) {
  const cs = c && c.probe && c.probe.stylesheets;
  const ss = s && s.probe && s.probe.stylesheets;
  return !!(cs && ss && cs.links > 0 && ss.readable >= cs.readable && cs.rules * 3 < ss.rules && ss.rules > 200);
}

function compare(c, s) {
  const d = { url: (c && c.url) || (s && s.url), issues: [], metrics: {} };
  const add = (tag, weight, detail) => d.issues.push({ tag, weight: +weight.toFixed(2), detail });

  if (!c || c.status !== 'ok') {
    d.status = 'skipped';
    d.reason = c ? `chromium ${c.status}${c.error ? ': ' + c.error : ''}` : 'no chromium result';
    return d;
  }
  if (referenceSuspect(c, s)) {
    d.status = 'skipped';
    d.reason = `chromium reference incomplete (${c.probe.stylesheets.rules} CSS rules vs ${s.probe.stylesheets.rules} in Sharko)`;
    return d;
  }
  d.status = 'compared';
  d.metrics.chromiumLoadMs = c.loadMs;
  d.metrics.sharkoMs = s.ms;
  d.metrics.sharkoTimings = s.timings;
  if (s.status === 'crash') add('crash', 100, 'renderer crashed');
  else if (s.status === 'hang') add('hang', 100, 'no result within the time limit');
  else if (s.status === 'failed') add('load-failed', 100, s.error || 'navigation failed');
  else if (s.status === 'timeout') add('load-timeout', 15, 'load event did not fire in time');

  const cp = c.probe;
  const sp = s.probe;
  if (!sp) {
    if (!d.issues.length || s.status === 'timeout') add('probe-missing', 60, s.probeError || 'no probe result from Sharko');
    d.score = Math.min(100, d.issues.reduce((a, i) => a + i.weight, 0));
    return d;
  }
  if (sp.probeErrors && sp.probeErrors.length) add('probe-error', 20, sp.probeErrors.join('; ').slice(0, 300));

  // Navigation
  const host = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch (e) {
      return u;
    }
  };
  if (cp.href && sp.href && host(cp.href) !== host(sp.href)) add('different-url', 30, `${cp.href} vs ${sp.href}`);
  if (cp.title && sp.title !== cp.title) {
    d.metrics.title = { chromium: cp.title, sharko: sp.title };
    if (!sp.title) add('no-title', 5, 'document.title empty in Sharko');
  }

  // Text
  const cw = words(cp.text);
  const sw = words(sp.text);
  let missing = 0;
  const missingWords = [];
  for (const w of cw) {
    if (!sw.has(w)) {
      missing++;
      if (missingWords.length < 25) missingWords.push(w);
    }
  }
  let extra = 0;
  const extraWords = [];
  for (const w of sw) {
    if (!cw.has(w)) {
      extra++;
      if (extraWords.length < 25) extraWords.push(w);
    }
  }
  d.metrics.text = {
    chromiumWords: cw.size,
    sharkoWords: sw.size,
    missing: cw.size ? +(missing / cw.size).toFixed(3) : 0,
    extra: sw.size ? +(extra / sw.size).toFixed(3) : 0,
    missingSample: missingWords,
    extraSample: extraWords,
  };
  if (cw.size >= 20 && sw.size === 0) add('no-text', 80, 'Sharko renders no text');
  else if (cw.size >= 20 && d.metrics.text.missing > 0.5) add('text-mostly-missing', 40, `${Math.round(d.metrics.text.missing * 100)}% of the words missing: ${missingWords.slice(0, 8).join(' ')}`);
  else if (cw.size >= 20 && d.metrics.text.missing > 0.2) add('text-missing', 15, `${Math.round(d.metrics.text.missing * 100)}% of the words missing: ${missingWords.slice(0, 8).join(' ')}`);
  if (sw.size >= 20 && d.metrics.text.extra > 0.3 && sw.size > cw.size * 1.3) add('text-extra', 12, `${Math.round(d.metrics.text.extra * 100)}% extra words (hidden content shown?): ${extraWords.slice(0, 8).join(' ')}`);

  // Page height
  if (cp.doc && sp.doc) {
    const ratio = cp.doc.scrollH ? sp.doc.scrollH / cp.doc.scrollH : 1;
    d.metrics.height = { chromium: cp.doc.scrollH, sharko: sp.doc.scrollH, ratio: +ratio.toFixed(2) };
    d.metrics.elements = { chromium: cp.doc.elements, sharko: sp.doc.elements };
    if (cp.doc.scrollH > 900 && ratio < 0.4) add('page-too-short', 25, `${sp.doc.scrollH}px vs ${cp.doc.scrollH}px`);
    else if (cp.doc.scrollH > 900 && ratio > 2.5) add('page-too-tall', 15, `${sp.doc.scrollH}px vs ${cp.doc.scrollH}px`);
    if (sp.doc.scrollW > WIDTH * 1.2 && cp.doc.scrollW <= WIDTH * 1.05) add('horizontal-overflow', 10, `scrollWidth ${sp.doc.scrollW}px`);
    const cb = lumClass(cp.doc.bodyBg === 'rgba(0, 0, 0, 0)' ? cp.doc.htmlBg : cp.doc.bodyBg);
    const sb = lumClass(sp.doc.bodyBg === 'rgba(0, 0, 0, 0)' ? sp.doc.htmlBg : sp.doc.bodyBg);
    if (cb && sb && cb !== sb && cb !== 'mid' && sb !== 'mid') add('body-background', 30, `body background ${sp.doc.bodyBg} vs ${cp.doc.bodyBg}`);
    if (cp.doc.elements > 50 && sp.doc.elements < cp.doc.elements * 0.4) add('few-elements', 20, `${sp.doc.elements} elements vs ${cp.doc.elements}`);
    if (cp.dark !== sp.dark) add('color-scheme', 20, `prefers-color-scheme dark: ${sp.dark} vs ${cp.dark}`);
  }

  // Images
  if (cp.images && sp.images) {
    d.metrics.images = { chromium: cp.images, sharko: sp.images };
    const cBroken = cp.images.total ? cp.images.broken / cp.images.total : 0;
    const sBroken = sp.images.total ? sp.images.broken / sp.images.total : 0;
    if (sp.images.total >= 3 && sBroken > cBroken + 0.3) add('images-broken', 20, `${sp.images.broken}/${sp.images.total} images broken (Chromium ${cp.images.broken}/${cp.images.total}): ${(sp.images.visibleBroken || []).slice(0, 3).join(' ')}`);
    else if (sp.images.total >= 3 && sBroken > cBroken + 0.1) add('images-some-broken', 8, `${sp.images.broken}/${sp.images.total} images broken`);
    if (cp.images.total >= 5 && sp.images.total < cp.images.total * 0.4) add('images-missing', 10, `${sp.images.total} <img> vs ${cp.images.total}`);
  }

  // Stylesheets
  if (cp.stylesheets && sp.stylesheets) {
    d.metrics.stylesheets = { chromium: cp.stylesheets, sharko: sp.stylesheets };
    if (cp.stylesheets.rules > 100 && sp.stylesheets.rules < cp.stylesheets.rules * 0.3) add('stylesheets-missing', 25, `${sp.stylesheets.rules} CSS rules readable vs ${cp.stylesheets.rules}`);
  }

  // Elements: match by key.
  if (cp.elements && sp.elements) {
    const smap = new Map(sp.elements.map((e) => [e.k, e]));
    const cmap = new Map(cp.elements.map((e) => [e.k, e]));
    let matched = 0;
    let moved = 0;
    let resized = 0;
    let bgMismatch = 0;
    let colorMismatch = 0;
    let fontMismatch = 0;
    let displayMismatch = 0;
    const examples = { moved: [], resized: [], bg: [], color: [], font: [], display: [] };
    const ex = (list, item) => list.length < 6 && list.push(item);
    for (const ce of cp.elements) {
      const se = smap.get(ce.k);
      if (!se) continue;
      matched++;
      const [cx, cy, cwid, chei] = ce.r;
      const [sx, sy, swid, shei] = se.r;
      const tol = 24;
      if (Math.abs(cx - sx) > tol || Math.abs(cy - sy) > Math.max(tol, cy * 0.15)) {
        moved++;
        ex(examples.moved, `${ce.k} at ${sx},${sy} (Chromium ${cx},${cy})`);
      }
      const wr = cwid ? swid / cwid : 1;
      const hr = chei ? shei / chei : 1;
      if ((wr < 0.66 || wr > 1.5) && Math.abs(swid - cwid) > tol) {
        resized++;
        ex(examples.resized, `${ce.k} ${swid}×${shei} (Chromium ${cwid}×${chei})`);
      } else if ((hr < 0.5 || hr > 2) && Math.abs(shei - chei) > tol * 2) {
        resized++;
        ex(examples.resized, `${ce.k} ${swid}×${shei} (Chromium ${cwid}×${chei})`);
      }
      const cb = lumClass(ce.bg);
      const sb = lumClass(se.bg);
      if (cb && sb && cb !== sb && cb !== 'mid' && sb !== 'mid') {
        bgMismatch++;
        ex(examples.bg, `${ce.k} ${se.bg} (Chromium ${ce.bg})`);
      }
      const cc = lumClass(ce.c);
      const sc = lumClass(se.c);
      if (cc && sc && cc !== sc && cc !== 'mid' && sc !== 'mid') {
        colorMismatch++;
        ex(examples.color, `${ce.k} ${se.c} (Chromium ${ce.c})`);
      }
      if (ce.fs && se.fs && (se.fs / ce.fs < 0.75 || se.fs / ce.fs > 1.34)) {
        fontMismatch++;
        ex(examples.font, `${ce.k} ${se.fs}px (Chromium ${ce.fs}px)`);
      }
      if ((ce.d === 'none') !== (se.d === 'none') || ce.d !== se.d && /flex|grid|table/.test(ce.d + se.d) && !(ce.d.includes('flex') && se.d.includes('flex'))) {
        displayMismatch++;
        ex(examples.display, `${ce.k} display ${se.d} (Chromium ${ce.d})`);
      }
    }
    let onlyChromium = 0;
    const onlyC = [];
    for (const ce of cp.elements) if (!smap.has(ce.k)) (onlyChromium++, onlyC.length < 8 && onlyC.push(ce.k + (ce.x ? ` "${ce.x}"` : '')));
    let onlySharko = 0;
    const onlyS = [];
    for (const se of sp.elements) if (!cmap.has(se.k)) (onlySharko++, onlyS.length < 8 && onlyS.push(se.k + (se.x ? ` "${se.x}"` : '')));
    const n = cp.elements.length || 1;
    d.metrics.layout = {
      chromiumElements: cp.elements.length,
      sharkoElements: sp.elements.length,
      matched,
      onlyChromium,
      onlySharko,
      moved,
      resized,
      bgMismatch,
      colorMismatch,
      fontMismatch,
      displayMismatch,
      examples,
      onlyChromiumSample: onlyC,
      onlySharkoSample: onlyS,
    };
    if (cp.elements.length >= 10) {
      if (matched / n < 0.5) add('dom-differs', 25, `only ${matched}/${cp.elements.length} of Chromium's visible elements found in Sharko (e.g. ${onlyC.slice(0, 3).join(', ')})`);
      else if (onlyChromium / n > 0.25) add('elements-missing', 12, `${onlyChromium} visible elements missing (e.g. ${onlyC.slice(0, 3).join(', ')})`);
      if (matched >= 10) {
        if (moved / matched > 0.5) add('layout-shifted', 20, `${moved}/${matched} elements at a different position, e.g. ${examples.moved[0]}`);
        else if (moved / matched > 0.2) add('layout-partly-shifted', 8, `${moved}/${matched} elements at a different position, e.g. ${examples.moved[0]}`);
        if (resized / matched > 0.3) add('sizes-differ', 15, `${resized}/${matched} elements with a very different size, e.g. ${examples.resized[0]}`);
        else if (resized / matched > 0.1) add('sizes-partly-differ', 6, `${resized}/${matched} elements with a very different size, e.g. ${examples.resized[0]}`);
        if (bgMismatch / matched > 0.1) add('backgrounds-differ', 15, `${bgMismatch}/${matched} elements dark/light background swapped, e.g. ${examples.bg[0]}`);
        if (colorMismatch / matched > 0.1) add('text-colors-differ', 10, `${colorMismatch}/${matched} elements dark/light text swapped, e.g. ${examples.color[0]}`);
        if (fontMismatch / matched > 0.15) add('font-sizes-differ', 8, `${fontMismatch}/${matched} elements with a different font size, e.g. ${examples.font[0]}`);
        if (displayMismatch / matched > 0.1) add('display-differs', 8, `${displayMismatch}/${matched} elements with a different display, e.g. ${examples.display[0]}`);
      }
    }
  }

  // Errors: signatures Sharko reports that Chromium does not.
  const csigs = new Set((c.errors || []).map(signature));
  const counts = new Map();
  for (const e of s.errors || []) {
    const sig = signature(e);
    if (csigs.has(sig)) continue;
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  const sharkoOnly = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([sig, n]) => ({ sig, n, hints: apiHints(sig) }));
  d.metrics.errors = { chromium: (c.errors || []).length, sharko: (s.errors || []).length, sharkoOnly: sharkoOnly.slice(0, 20) };
  if (sharkoOnly.length) add('js-errors', Math.min(20, 3 + sharkoOnly.length * 2), `${sharkoOnly.length} error signature(s) only in Sharko, e.g. ${sharkoOnly[0].sig}`);

  d.score = Math.min(100, d.issues.reduce((a, i) => a + i.weight, 0));
  return d;
}

// Pixel comparison of the two screenshots, done in Chromium (no image library needed):
// both downscaled to 160×100 grayscale, mean absolute difference and the share of
// clearly different pixels; also whether the Sharko screenshot is (nearly) blank.
async function pixelDiffs(browser, sites) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const out = {};
  for (const { slug, dir } of sites) {
    const a = path.join(dir, 'chromium.png');
    const b = path.join(dir, 'sharko.png');
    if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
    const da = 'data:image/png;base64,' + fs.readFileSync(a).toString('base64');
    const db = 'data:image/png;base64,' + fs.readFileSync(b).toString('base64');
    try {
      out[slug] = await page.evaluate(
        async ([da, db]) => {
          const load = (src) =>
            new Promise((res, rej) => {
              const im = new Image();
              im.onload = () => res(im);
              im.onerror = rej;
              im.src = src;
            });
          const [ia, ib] = await Promise.all([load(da), load(db)]);
          const W = 160;
          const H = 100;
          const gray = (im) => {
            const c = document.createElement('canvas');
            c.width = W;
            c.height = H;
            const g = c.getContext('2d');
            g.drawImage(im, 0, 0, W, H);
            const d = g.getImageData(0, 0, W, H).data;
            const v = new Float32Array(W * H);
            for (let i = 0; i < W * H; i++) v[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) * (d[i * 4 + 3] / 255) + (255 - d[i * 4 + 3]);
            return v;
          };
          const ga = gray(ia);
          const gb = gray(ib);
          let sum = 0;
          let big = 0;
          let mb = 0;
          for (let i = 0; i < W * H; i++) {
            const dd = Math.abs(ga[i] - gb[i]);
            sum += dd;
            if (dd > 48) big++;
            mb += gb[i];
          }
          mb /= W * H;
          let varb = 0;
          for (let i = 0; i < W * H; i++) varb += (gb[i] - mb) ** 2;
          return { mean: +(sum / (W * H) / 255).toFixed(3), different: +(big / (W * H)).toFixed(3), sharkoStd: +Math.sqrt(varb / (W * H)).toFixed(1) };
        },
        [da, db],
      );
    } catch (e) {
      out[slug] = { error: String(e.message || e).split('\n')[0] };
    }
  }
  await ctx.close();
  return out;
}

// ---------------------------------------------------------------------------- report

function writeReport(results, meta) {
  const compared = results.filter((r) => r.diff.status === 'compared');
  const skipped = results.filter((r) => r.diff.status !== 'compared');
  const tagCount = new Map();
  const sigSites = new Map();
  const hintSites = new Map();
  for (const r of compared) {
    for (const i of r.diff.issues) tagCount.set(i.tag, (tagCount.get(i.tag) || 0) + 1);
    const so = (r.diff.metrics.errors && r.diff.metrics.errors.sharkoOnly) || [];
    for (const e of so) {
      if (!sigSites.has(e.sig)) sigSites.set(e.sig, []);
      sigSites.get(e.sig).push(r.slug);
      for (const h of e.hints) {
        if (!hintSites.has(h)) hintSites.set(h, new Set());
        hintSites.get(h).add(r.slug);
      }
    }
  }
  const bySites = (m) => [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const scores = compared.map((r) => r.diff.score).sort((a, b) => a - b);
  const median = scores.length ? scores[Math.floor(scores.length / 2)] : 0;
  const good = compared.filter((r) => r.diff.score < 10).length;

  const L = [];
  L.push(`# Sharko vs Chromium — ${compared.length} sites compared (${skipped.length} skipped)`);
  L.push('');
  L.push(`Generated ${meta.generated}; settle ${meta.settle} ms, ${WIDTH}×${HEIGHT}${meta.dark ? ', dark' : ''}. Score 0 = like Chromium, 100 = unusable. Median ${median}, ${good}/${compared.length} sites under 10.`);
  L.push('');
  L.push('## Issues by number of sites');
  L.push('');
  L.push('| issue | sites |');
  L.push('|---|---:|');
  for (const [tag, n] of [...tagCount.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${tag} | ${n} |`);
  L.push('');
  L.push('## Sharko-only errors by number of sites');
  L.push('');
  const hints = [...hintSites.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 40);
  if (hints.length) {
    L.push('Likely missing/wrong APIs (from the messages):');
    L.push('');
    for (const [h, s] of hints) L.push(`- \`${h}\` — ${s.size} site(s): ${[...s].slice(0, 6).join(', ')}`);
    L.push('');
  }
  for (const [sig, s] of bySites(sigSites).slice(0, 60)) L.push(`- ${s.length}× \`${sig}\` (${s.slice(0, 5).join(', ')})`);
  L.push('');
  L.push('## Sites, worst first');
  L.push('');
  L.push('| site | score | issues | text missing | height S/C | px diff | Sharko errors |');
  L.push('|---|---:|---|---:|---:|---:|---:|');
  for (const r of compared.sort((a, b) => b.diff.score - a.diff.score)) {
    const m = r.diff.metrics;
    L.push(
      `| [${r.slug}](${r.url}) | ${r.diff.score} | ${r.diff.issues.map((i) => i.tag).join(', ')} | ${m.text ? Math.round(m.text.missing * 100) + '%' : ''} | ${m.height ? m.height.ratio : ''} | ${m.pixels ? Math.round(m.pixels.different * 100) + '%' : ''} | ${m.errors ? m.errors.sharkoOnly.length : ''} |`,
    );
  }
  L.push('');
  L.push('## Details');
  L.push('');
  for (const r of compared) {
    if (!r.diff.issues.length) continue;
    L.push(`### ${r.slug} — ${r.diff.score}`);
    L.push('');
    L.push(`${r.url} · out/${r.slug}/`);
    for (const i of r.diff.issues) L.push(`- **${i.tag}** (${i.weight}): ${i.detail}`);
    L.push('');
  }
  if (skipped.length) {
    L.push('## Skipped');
    L.push('');
    for (const r of skipped) L.push(`- ${r.url}: ${r.diff.reason}`);
    L.push('');
  }
  fs.writeFileSync(path.join(outDir, 'report.md'), L.join('\n'));
  return { median, good, tagCount: Object.fromEntries(tagCount), hints: hints.map(([h, s]) => ({ hint: h, sites: [...s] })), signatures: bySites(sigSites).slice(0, 100).map(([sig, s]) => ({ sig, sites: s })) };
}

// ---------------------------------------------------------------------------- main

async function pool(items, n, f) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await f(items[k], k);
      }
    }),
  );
  return out;
}

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);

(async () => {
  const sites = resolveSites().map((url) => ({ url, slug: slugOf(url), dir: path.join(outDir, slugOf(url)) }));
  if (flag('list')) {
    for (const s of sites) console.log(s.url);
    return;
  }
  if (!sites.length) {
    console.error('no sites');
    process.exit(2);
  }
  const compareOnly = flag('compare-only');
  if (!compareOnly && (!browserBin || !fs.existsSync(browserBin))) {
    console.error(`browser binary not found (${browserBin}); build it or pass --browser=`);
    process.exit(2);
  }
  for (const s of sites) fs.mkdirSync(s.dir, { recursive: true });

  const t0 = Date.now();
  let browser = null;
  if (!compareOnly) {
    browser = await launchChromium();
    let done = 0;
    await pool(sites, jobs, async (s) => {
      const cFile = path.join(s.dir, 'chromium.json');
      let c = flag('refresh') ? null : readJson(cFile);
      if (!c || c.status !== 'ok') {
        const attempt = () => runChromium(browser, s.url, s.dir).catch((e) => ({ url: s.url, engine: 'chromium', status: 'failed', error: String(e.message || e).split('\n')[0] }));
        c = await attempt();
        // One retry: transient network/proxy failures should not cost a site.
        if (c.status === 'failed') c = await attempt();
        fs.writeFileSync(cFile, JSON.stringify(c, null, 1));
      }
      let sh = null;
      if (c.status === 'ok') {
        sh = await runSharko(s.url, s.dir);
        if (referenceSuspect(c, sh)) {
          // Load Chromium's side again before believing Sharko has more CSS than it.
          const again = await runChromium(browser, s.url, s.dir).catch(() => null);
          if (again && again.status === 'ok') {
            c = again;
            fs.writeFileSync(cFile, JSON.stringify(c, null, 1));
          }
        }
        fs.writeFileSync(path.join(s.dir, 'sharko.json'), JSON.stringify(sh, null, 1));
      }
      done++;
      const d = compare(c, sh || {});
      console.error(`[${done}/${sites.length}] ${s.slug}: ${d.status === 'compared' ? `score ${d.score}${d.issues.length ? ' (' + d.issues.map((i) => i.tag).join(', ') + ')' : ''}` : d.reason}`);
    });
  } else {
    browser = await launchChromium().catch(() => null);
  }

  // Compare (again, with the pixel diff) and report.
  const px = browser ? await pixelDiffs(browser, sites) : {};
  if (browser) await browser.close();
  const results = [];
  for (const s of sites) {
    const c = readJson(path.join(s.dir, 'chromium.json'));
    const sh = readJson(path.join(s.dir, 'sharko.json')) || {};
    const d = compare(c, sh);
    if (d.status === 'compared' && px[s.slug] && !px[s.slug].error) {
      d.metrics.pixels = px[s.slug];
      if (px[s.slug].sharkoStd < 6 && sh.probe && sh.probe.text && sh.probe.text.length > 200) {
        d.issues.push({ tag: 'blank-screenshot', weight: 60, detail: 'the Sharko screenshot is (nearly) uniform although the page has text' });
      } else if (px[s.slug].different > 0.6) {
        d.issues.push({ tag: 'looks-different', weight: 10, detail: `${Math.round(px[s.slug].different * 100)}% of the (downscaled) pixels differ clearly` });
      }
      d.score = Math.min(100, d.issues.reduce((a, i) => a + i.weight, 0));
    }
    fs.writeFileSync(path.join(s.dir, 'diff.json'), JSON.stringify(d, null, 1));
    results.push({ url: s.url, slug: s.slug, diff: d });
  }
  const meta = { generated: new Date().toISOString(), settle, timeout, dark, jobs, browser: browserBin, seconds: Math.round((Date.now() - t0) / 1000) };
  const agg = writeReport(results, meta);
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        meta,
        ...agg,
        sites: results.map((r) => ({ url: r.url, slug: r.slug, status: r.diff.status, reason: r.diff.reason, score: r.diff.score, issues: r.diff.issues, metrics: r.diff.metrics })),
      },
      null,
      1,
    ),
  );
  const compared = results.filter((r) => r.diff.status === 'compared');
  console.error(`\n${compared.length} sites compared in ${meta.seconds}s: median score ${agg.median}, ${agg.good}/${compared.length} under 10 → ${path.relative(process.cwd(), path.join(outDir, 'report.md'))}`);
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(2);
});
