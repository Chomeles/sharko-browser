#!/bin/sh
# usage: run.sh NAME   (NAME = a repro page without .html); needs /home/user/sharko-has/target/profiling/browser and Playwright.
# Starts the logging static server (req.log records request headers) on 127.0.0.1:8765 if it is not running.
D=$(dirname "$0"); cd "$D"
curl -s http://127.0.0.1:8765/ >/dev/null 2>&1 || (python3 server.py 8765 >/dev/null 2>&1 &) ; sleep 1
echo "--- Sharko"; (cd "$(git rev-parse --show-toplevel)" && NO_PROXY=127.0.0.1,localhost nice -n 10 target/profiling/browser --headless --settle=2000 --timeout=30000 --console --eval='document.title' "http://127.0.0.1:8765/$1.html" 2>&1 | grep '^"\|console.error')
echo "--- Chromium"; NO_PROXY=127.0.0.1,localhost node chr.js "http://127.0.0.1:8765/$1.html" --settle=2000 --eval='document.title' 2>&1 | head -3
