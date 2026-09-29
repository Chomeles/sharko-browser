#!/usr/bin/env bash
# Prepare a fresh (root, Linux) cloud container for a Sharko developer session. Idempotent.
#   tools/dev-setup.sh [extra WPT dir ...]     e.g. tools/dev-setup.sh css/css-images svg
# WPT lives in ../wpt (override: WPT_DIR=/path, also honoured by tools/wpt/run.js). Extra dirs are added with `git sparse-checkout add` (lane files list theirs under "WPT dirs").
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WPT="${WPT_DIR:-$REPO/../wpt}"
LOG="${WPT_LOG:-/tmp/wpt-serve.log}"
say() { printf '\n== %s\n' "$*"; }

say "1. Disk space"
df -h "$REPO" "$(dirname "$WPT")" 2>/dev/null | awk '!seen[$0]++'
avail_kb=$(df -Pk "$REPO" | awk 'NR==2{print $4}')
[ "${avail_kb:-0}" -lt 15000000 ] && echo "WARNING: < 15 GB free. A first build needs ~8-12 GB in target/; clean old worktrees' target/ dirs first."

say "2. web-platform-tests sparse checkout at $WPT"
# Base directory list = the one in tools/wpt/README.md (falls back to a short list).
BASE=$(awk '/sparse-checkout set --no-cone/{f=1} f{print} f&&!/\\$/{exit}' "$REPO/tools/wpt/README.md" \
  | sed 's/.*--no-cone//; s/\\$//' | tr -s ' \n' ' ')
[ -z "${BASE// }" ] && BASE="/wpt /wpt.py /docs/commands.json resources common tools interfaces fonts dom html url fetch/api encoding css/cssom css/cssom-view"
if [ -d "$WPT/.git" ]; then
  echo "already present: $WPT (not cloning again)"
else
  git clone --depth 1 --filter=blob:none --sparse https://github.com/web-platform-tests/wpt.git "$WPT" || { echo "clone failed"; exit 1; }
  # shellcheck disable=SC2086
  git -C "$WPT" sparse-checkout set --no-cone $BASE
fi
if [ $# -gt 0 ]; then
  # shellcheck disable=SC2068
  git -C "$WPT" sparse-checkout add $@ && echo "added dirs: $*"
fi
# blobs are fetched lazily; make sure the working tree matches the pattern list
git -C "$WPT" checkout -q 2>&1 | tail -2

say "3. Hosts entries and ./wpt serve"
if grep -q 'web-platform.test' /etc/hosts; then
  echo "hosts entries: already present"
else
  (cd "$WPT" && ./wpt make-hosts-file >> /etc/hosts) && echo "hosts entries: added"
fi
URL=http://web-platform.test:8000/resources/testharness.js
up() { curl -s --noproxy '*' -o /dev/null -f -m 3 "$URL"; }
if up; then
  echo "wpt serve: already running"
else
  (cd "$WPT" && nohup setsid ./wpt serve --no-h2 >"$LOG" 2>&1 < /dev/null &)
  echo "wpt serve: starting (log $LOG)"
  for _ in $(seq 1 60); do up && break; sleep 2; done
  up && echo "wpt serve: up" || { echo "wpt serve: NOT answering after 120 s, see $LOG"; tail -5 "$LOG"; }
fi

say "4. JS layer test deps and Playwright"
if [ -d "$REPO/crates/script/js/test/node_modules" ]; then
  echo "npm deps: already installed"
else
  (cd "$REPO/crates/script/js/test" && npm install --no-audit --no-fund 2>&1 | tail -3)
fi
PWMOD=/opt/node22/lib/node_modules
if [ -d "$PWMOD/playwright" ]; then
  echo "tools/sitediff needs: export NODE_PATH=$PWMOD PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers"
  NODE_PATH=$PWMOD node -e 'require("playwright");console.log("require(\"playwright\") works with that NODE_PATH")' 2>&1 | tail -1
else
  echo "playwright not found at $PWMOD; run: npm i -g playwright"
fi

say "5. Build"
cat <<'B'
  cargo build -j 3 --profile profiling -p browser-core -p browser-launcher
  First build: ~20-40 min on 4 cores (V8 + Stylo + Vello are prebuilt/large); target/ grows to ~8-12 GB.
  Never run two builds in parallel on this machine; keep -j 3. Binary lands in target/profiling/.
B

say "6. Test suites"
cat <<'T'
  JS layer:   node crates/script/js/test/run.js [filter]
  Rust:       cargo test -j 3 --profile profiling -p script -p engine -p blitz-dom -p blitz-paint
  WPT:        node tools/wpt/run.js --batch --jobs=3 dom url        (confirm --update runs WITHOUT --batch)
  sitediff:   NODE_PATH=/opt/node22/lib/node_modules node tools/sitediff/run.js   (see tools/sitediff/README.md)
  All fast:   tools/check.sh [--rust|--all]
T
