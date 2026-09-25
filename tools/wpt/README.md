# web-platform-tests for Sharko

Spec conformance is measured with [web-platform-tests](https://github.com/web-platform-tests/wpt)
(the suite Chromium, Firefox, WebKit, Servo and Ladybird all run) instead of by
eyeballing websites. `run.js` drives the headless binary through the harness tests
and compares every subtest with `expected.json`, so a change shows up as
"NEW PASS" / "UNEXPECTED" lines, and a regression fails the run.

## One-time setup

```sh
# 1. A sparse checkout next to the repository (about 300 MB for the directories below).
git clone --depth 1 --filter=blob:none --sparse https://github.com/web-platform-tests/wpt.git ../wpt
cd ../wpt
git sparse-checkout set --no-cone /wpt /wpt.py /docs/commands.json resources common tools interfaces \
  fonts css/support dom html/webappapis html/browsers html/dom html/semantics/scripting-1 html/semantics/forms \
  html/infrastructure fetch/api url encoding streams xhr websockets workers custom-elements \
  shadow-dom css/cssom css/cssom-view css/css-grid css/css-flexbox css/css-position \
  css/selectors css/css-values css/css-variables css/css-transitions css/css-animations \
  web-animations FileAPI webstorage IndexedDB console webmessaging eventsource compat cors \
  hr-time performance-timeline resource-timing user-timing

# 2. Host names (web-platform.test and friends). The test CA needs no system install:
#    run.js passes it to the browser as SHARKO_EXTRA_CA (a PEM bundle trusted in
#    addition to the OS store; also handy for corporate proxies).
./wpt make-hosts-file | sudo tee -a /etc/hosts

# 3. The test server (keep it running; it needs Python 3).
./wpt serve --no-h2
```

## Running

```sh
node tools/wpt/run.js                       # the default directories (see DEFAULT_PATHS)
node tools/wpt/run.js dom/nodes url         # some directories
node tools/wpt/run.js --filter=Node-nodeName --verbose dom
node tools/wpt/run.js --update dom/nodes    # accept the current results as expectations
```

`node tools/wpt/summarize.js results.json` (from a `--json=` run) prints pass rates per
directory and the most common failure messages, so the next fix is the one that unlocks
the most tests.

`run.js` finds the binary in `target/profiling` or `target/release` (or `--browser=`,
`$SHARKO_BIN`), the checkout in `../wpt` (or `--wpt=`, `$WPT_DIR`), and runs
`cores - 1` browsers in parallel (`--jobs=`). Each test gets a fresh profile and
15 s (`--timeout=`; tests marked `timeout=long` get 60 s). With `--batch` every worker
keeps one browser open (the headless `--batch` mode) and loads the tests in turn, which
skips the per-test process start; storage then carries over between tests, so use the
default one-process-per-test mode for the committed baseline. `--workers` adds the
`.any.worker.html` variants, `--json=FILE` dumps every result, `--console` shows
the pages' console output.

What runs: every testharness.js test (`.html`, `.any.js` → `.any.html`,
`.window.js` → `.window.html`, with `<meta name=variant>` variants); `.https.` tests
go over https. Reftests (`<link rel=match>`) and manual tests are skipped for now.

## Expectations

`expected.json` lists only what does not pass: a test that is missing is expected to
be `OK` with every subtest `PASS`; a listed test names its harness status and its
non-`PASS` subtests. After fixing something, run the affected directory with
`--update` and commit the smaller file together with the fix. A regression (an
expected `PASS` that fails, or a harness status that gets worse) makes the run exit 1.

How it works: `testharnessreport.js` (this directory) is copied over the WPT stub of
the same name; when a test file completes it stores the results on
`window.__wpt_done`, which the runner polls with `--wait-for=window.__wpt_done` and
reads with `--eval`.

`testdriver-vendor.js` (also copied into the checkout) backs `test_driver.click()`,
`send_keys()` and `Actions` sequences: the page prints a `__sharko_testdriver {...}`
console line, the headless driver performs the input natively (mouse, keys, wheel,
pauses; real hit-testing and focus) and resolves the request through
`__sharko_testdriver_done()`. This works in any headless run, not only under WPT.
