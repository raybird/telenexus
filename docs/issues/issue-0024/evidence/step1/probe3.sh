#!/usr/bin/env bash
# issue 0024 步驟 1 第三輪：一直變動的頁面要等多久、被中斷時 TMPDIR 的殘留。
set -u
M=${MOLI:-/opt/moli-probe/moli-v1.1.23-x86_64-unknown-linux-gnu/moli}
OUT=${OUT:-/out}; RES="$OUT/results3.jsonl"; : > "$RES"
PUB="http://$PUB_IP:8080"
export HOME=/tmp/probe-home
mkdir -p "$HOME"
for w in domstable networkidle; do
  t0=$(date +%s%3N); "$M" fetch --dump markdown --wait "$w" --block-private-networks "$PUB/ticker" > "$OUT/3-ticker-$w.stdout" 2> "$OUT/3-ticker-$w.stderr"; c=$?; t1=$(date +%s%3N)
  echo "{\"name\":\"ticker-$w\",\"exit\":$c,\"ms\":$((t1-t0)),\"hasToken\":$(grep -q ISSUE24TICKERBODY "$OUT/3-ticker-$w.stdout" && echo true || echo false)}" >> "$RES"
done
for sig in TERM KILL; do
  export TMPDIR=/tmp/probe-tmp-$sig; mkdir -p "$TMPDIR"
  "$M" fetch --dump markdown --wait domstable --block-private-networks "$PUB/idb-hold" > /dev/null 2>&1 &
  pid=$!; sleep 3
  during=$(find "$TMPDIR" -mindepth 1 | wc -l)
  kill -$sig $pid; wait $pid; c=$?; sleep 1
  after=$(find "$TMPDIR" -mindepth 1 | wc -l)
  echo "{\"name\":\"interrupt-$sig\",\"exit\":$c,\"tmpEntriesDuring\":$during,\"tmpEntriesAfter\":$after,\"after\":$(find "$TMPDIR" -mindepth 1 -printf '%P %s\n' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(d.split("\n").filter(Boolean))))')}" >> "$RES"
done
echo '{"name":"done"}' >> "$RES"
