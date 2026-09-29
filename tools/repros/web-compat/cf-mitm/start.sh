#!/bin/bash
# usage: start.sh LOGDIR PRELUDE.js [PATCH.js]   (run from anywhere; needs ca.pem/ca.key in this directory:
#   openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 -subj "/CN=sharko-mitm" )
D=$(cd "$(dirname "$0")" && pwd)
pkill -f "node $D/proxy.js" 2>/dev/null
sleep 0.5
rm -rf "$1"
PORT=38111 LOGDIR="$1" PRELUDE="$2" PATCH="$3" nohup nice -n 10 node $D/proxy.js > $D/proxy.out 2>&1 &
sleep 1
cat $D/proxy.out
