#!/bin/bash
# usage: runm.sh URL OUTPREFIX [extra browser args...]   (repo root = cwd; proxy started with start.sh)
D=$(cd "$(dirname "$0")" && pwd)
U=$1; O=$2; shift 2
HTTPS_PROXY=http://127.0.0.1:38111 https_proxy=http://127.0.0.1:38111 SHARKO_EXTRA_CA=$D/ca.pem nice -n 10 target/profiling/browser --headless --console --settle=12000 --timeout=45000 --eval='JSON.stringify({t:document.title,c:document.cookie})' "$@" "$U" > $O.out 2> $O.err
