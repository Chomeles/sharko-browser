# Fix brief: repair one root cause in the engine

You work alone on your own machine and clone. Fix the causes named in your task at engine level and spec-driven, so that every site with that cause is repaired; never a per-site hack (no hostname checks, no special-casing a library).

## Method (in this order)

1. **Reproduce** against Chromium with a minimal page (`node tools/sitediff/run.js <url>`; Chromium runs through Playwright, `channel: 'chromium'`). The sandbox proxy adds noise (bot walls, random 403): judge by the probe/diff, not one screenshot.
2. **Read how a working engine does it** (`docs/REFERENCE-MAP.md`: Ladybird, Servo/Stylo, Chromium, Gecko, plus the spec section) and write the rules and edge cases into the commit message. Ported code needs the attribution described there.
3. **Implement** in our structure, minimal and general. Comments say why, not what.
4. **Test**: an engine/JS-layer test that fails before and passes after; the affected WPT directories; the affected sites through sitediff.
5. **Commit** one root cause per commit, push to your outcome branch.

## Repository map

`crates/script/src` (V8 bindings, DOM natives), `crates/script/js/*.js` (JS layer, embedded at build time; native API spec in `crates/script/js/NATIVE_API.md`, update both sides together), `crates/engine` (renderer, layout/paint integration), `crates/netstack` (HTTP client), `crates/common`, `crates/browser` (headless driver), `vendor/blitz-dom` (DOM + layout: Taffy, Stylo; every local change gets a `PATCH:` comment and a numbered entry in `vendor/README.md`). Read `docs/ARCHITECTURE.md` and `CONTRIBUTING.md` first. Dossiers of already diagnosed causes: `docs/dossiers/`.

## Build and test

```
cargo build --profile profiling -p browser-core -p browser-launcher     # binary: target/profiling/browser
cargo test --profile profiling -p engine --test <name>                   # targeted; each integration test is its own link step (minutes), never run the whole -p engine suite in a loop
cargo test --profile profiling -p script | -p netstack | -p blitz-dom --lib
node crates/script/js/test/run.js                                        # JS layer tests (must pass)
node tools/sitediff/run.js <urls>                                        # Sharko vs Chromium score
target/profiling/browser --headless [--settle=MS] [--console] [--screenshot=F.png] [--eval=JS] [--dump-dom] [--single-process] URL
```

If `tools/dev-setup.sh` exists, run it once (Playwright, WPT checkout, hosts entries). WPT: `node tools/wpt/run.js --batch <dirs>` must report no UNEXPECTED results; record new passes with `--update <dir>` and commit `tools/wpt/expected.json`. If WPT cannot be set up on your machine, say so in the result; the integrator runs it before merging. Use `nice -n 10` for long builds, keep disk use small (delete temp files; never commit `target/` or `tools/sitediff/out/`).

## Commit rules

- Message: imperative summary line (<= 72 chars) ending in ` [skip ci]`, body = why (mechanism, spec section), what the fix does, tests, sites repaired with before/after score.
- Trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: <your session url>`.
- No model names or identifiers anywhere in the repo. Never push tags, open PRs, force-push, rewrite history, or skip/weaken tests to get green. Push only to your outcome branch.

## Time box

About 2 hours per cause. If a fix is not sound by then (tests fail, regressions), revert it cleanly, commit your findings as `docs/dossiers/<cluster>/NOTES-<id>.md` and report what you learned.

## Result

End with a short summary: commits, before/after site scores, tests and WPT delta, follow-ups.
