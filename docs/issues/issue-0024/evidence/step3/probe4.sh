#!/usr/bin/env bash
# issue 0024 步驟 3：在映像內以真 Moli 執行 telenexus-moli-fetch。
set -u
OUT=${OUT:-/out}; RES="$OUT/results4.jsonl"; : > "$RES"
PUB="http://$PUB_IP:8080"
run() { # run <名稱> <預期字串> <網址>
  local name=$1 tok=$2 url=$3 t0 t1 code
  t0=$(date +%s%3N); telenexus-moli-fetch "$url" > "$OUT/4-$name.stdout" 2> "$OUT/4-$name.stderr"; code=$?; t1=$(date +%s%3N)
  node -e 'const [n,u,e,ms,o,er,tok]=process.argv.slice(1);const fs=require("fs");const so=fs.readFileSync(o,"utf8"),se=fs.readFileSync(er,"utf8");console.log(JSON.stringify({name:n,url:u,exit:+e,ms:+ms,hasToken:tok?so.replace(/\\/g,"").includes(tok):null,stdoutHead:so.slice(0,120),stderrHead:se.slice(0,300)}))' "$name" "$url" "$code" "$((t1-t0))" "$OUT/4-$name.stdout" "$OUT/4-$name.stderr" "$tok" >> "$RES"
}
PORT=8081 node /probe/fixture-server.mjs > /dev/null 2>&1 &
sleep 1
run public-js ISSUE24_JS_BODY_20261112 "$PUB/js"
run public-js-async ISSUE24_JS_ASYNC_BODY_20261112 "$PUB/js-async"
run public-slow-api ISSUE24SLOWAPIBODY "$PUB/js-slow-api"
run public-ticker ISSUE24TICKERBODY "$PUB/ticker"
run public-empty "" "$PUB/empty"
run public-404 "" "$PUB/nope"
run public-shell WAITING "$PUB/shell"
run public-hang "" "$PUB/hang"
run loopback "" "http://127.0.0.1:8081/js"
run localhost "" "http://localhost:8081/js"
run rfc1918 "" "http://$PRIV_IP:8080/js"
run service-name "" "http://$SVC:8080/js"
run metadata "" "http://169.254.169.254/"
run data-url "" "data:text/html,<p>ISSUE24_DATA</p>"
MOLI_BLOCK_PRIVATE_NETWORKS=0 run env-override-loopback "" "http://127.0.0.1:8081/js"
echo "{\"name\":\"tmp-leftovers\",\"entries\":$(find /tmp -maxdepth 1 \( -name 'tnm-*' -o -name 'moli-storage-*' \) | wc -l)}" >> "$RES"
echo "{\"name\":\"moli-procs\",\"n\":$(ps -eo comm | grep -c '^moli$')}" >> "$RES"
echo '{"name":"done"}' >> "$RES"
