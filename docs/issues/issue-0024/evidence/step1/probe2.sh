#!/usr/bin/env bash
# issue 0024 步驟 1 第二輪：等待策略、檔案系統寫入、連不上的公開位址。
set -u
M=${MOLI:-/opt/moli-probe/moli-v1.1.23-x86_64-unknown-linux-gnu/moli}
OUT=${OUT:-/out}; RES="$OUT/results2.jsonl"; : > "$RES"
PUB="http://$PUB_IP:8080"
run() { # run <名稱> <預期字串> <指令...>；比對前先去掉 Markdown 的反斜線跳脫
  local name=$1 tok=$2; shift 2; local t0 t1 code
  t0=$(date +%s%3N); "$@" > "$OUT/2-$name.stdout" 2> "$OUT/2-$name.stderr"; code=$?; t1=$(date +%s%3N)
  node -e 'const [n,c,e,ms,o,er,tok]=process.argv.slice(1);const fs=require("fs");const so=fs.readFileSync(o,"utf8"),se=fs.readFileSync(er,"utf8");console.log(JSON.stringify({name:n,cmd:c,exit:+e,ms:+ms,hasToken:tok?so.replace(/\\/g,"").includes(tok):null,stdoutHead:so.slice(0,200),stderrHead:se.slice(0,300)}))' "$name" "$*" "$code" "$((t1-t0))" "$OUT/2-$name.stdout" "$OUT/2-$name.stderr" "$tok" >> "$RES"
}
snap() { find / -xdev \( -path /proc -o -path /sys -o -path /out -o -path /dev -o -path /probe -o -path /opt/moli-probe \) -prune -o -printf '%p\t%s\t%T@\n' 2>/dev/null | sort > "$OUT/snap-$1.txt"; }

export HOME=/tmp/probe-home TMPDIR=/tmp/probe-tmp
unset XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR
mkdir -p "$HOME" "$TMPDIR"
for w in done load networkidle domstable; do
  run "js-async-$w" ISSUE24_JS_ASYNC_BODY_20261112 "$M" fetch --dump markdown --wait "$w" --block-private-networks "$PUB/js-async"
  run "js-late-$w" ISSUE24LATEBODY "$M" fetch --dump markdown --wait "$w" --block-private-networks "$PUB/js-late"
  run "js-slow-api-$w" ISSUE24SLOWAPIBODY "$M" fetch --dump markdown --wait "$w" --block-private-networks "$PUB/js-slow-api"
done
run "js-networkidle" ISSUE24_JS_BODY_20261112 "$M" fetch --dump markdown --wait networkidle --block-private-networks "$PUB/js"
run "static-networkidle" ISSUE24_HTTP_BODY_20261112 "$M" fetch --dump markdown --wait networkidle --block-private-networks "$PUB/static"

snap before
run idb ISSUE24IDBBODY "$M" fetch --dump markdown --wait networkidle --block-private-networks "$PUB/idb"
run js-module-fs ISSUE24_JS_MODULE_BODY_20261112 "$M" fetch --dump markdown --wait networkidle --block-private-networks "$PUB/js-module"
run https-example-fs "Example Domain" "$M" fetch --dump markdown --wait networkidle --block-private-networks "https://example.com/"
snap after
diff "$OUT/snap-before.txt" "$OUT/snap-after.txt" > "$OUT/snap-diff.txt"
echo "{\"name\":\"fs-diff-lines\",\"n\":$(wc -l < "$OUT/snap-diff.txt")}" >> "$RES"

# 連不上的公開位址（同網段沒有這台主機）
run unreachable-public "" "$M" fetch --dump markdown --wait networkidle --block-private-networks "http://45.67.89.99:8080/js"
echo '{"name":"done"}' >> "$RES"
