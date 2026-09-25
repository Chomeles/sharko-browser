#!/usr/bin/env bash
# Local pre-push check: the fast suites that catch most regressions.
#
#   tools/check.sh            JS-layer tests, DOM fuzzer (8 seeds), quick WPT subset
#   tools/check.sh --rust     ... plus `cargo test` for the script/DOM/engine crates
#   tools/check.sh --all      ... plus the full WPT default set
#
# Needs a built binary (target/profiling or target/release) and, for the WPT part, a
# running `./wpt serve` in the checkout (see tools/wpt/README.md; skipped when the
# server is not reachable).
set -u
cd "$(dirname "$0")/.."
status=0
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { status=1; printf '\033[31mFAILED: %s\033[0m\n' "$1"; }

step "JS layer tests"
node crates/script/js/test/run.js || fail "JS layer tests"

if [[ " $* " == *" --rust "* || " $* " == *" --all "* ]]; then
  step "cargo test (script, blitz-dom, engine)"
  cargo test -j 3 --profile profiling --no-fail-fast -p script -p blitz-dom -p engine || fail "cargo test"
fi

step "DOM mutation fuzzer"
node tools/fuzz/run.js --seeds=8 --rounds=100 --clicks=20 || fail "fuzzer"

if curl -s --noproxy '*' -o /dev/null http://web-platform.test:8000/resources/testharness.js; then
  if [[ " $* " == *" --all "* ]]; then
    step "web-platform-tests (default set)"
    node tools/wpt/run.js || fail "WPT"
  else
    step "web-platform-tests (quick subset)"
    node tools/wpt/run.js --batch dom/nodes dom/events dom/traversal dom/ranges dom/lists url encoding css/cssom-view || fail "WPT quick subset"
  fi
else
  echo "(wpt serve not running; skipping web-platform-tests)"
fi

if [[ $status -eq 0 ]]; then printf '\n\033[32mall checks passed\033[0m\n'; fi
exit $status
