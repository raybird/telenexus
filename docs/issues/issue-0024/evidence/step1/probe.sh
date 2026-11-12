#!/usr/bin/env bash
# issue 0024 步驟 1：在現行映像內，以 node 使用者探測釘版 Moli 的行為。
# 必要環境變數：PUB_IP（非保留網段上的 fixture）、PRIV_IP（RFC1918 上的同一個 fixture）、SVC（容器網路服務名稱）。
set -u
M=${MOLI:-/opt/moli-probe/moli-v1.1.23-x86_64-unknown-linux-gnu/moli}
OUT=${OUT:-/out}
RES="$OUT/results.jsonl"
: > "$RES"
FLAGS=(--dump markdown --wait done --block-private-networks)

json() { node -e 'const [n,c,e,ms,o,er,tok]=process.argv.slice(1);const fs=require("fs");const so=fs.readFileSync(o,"utf8"),se=fs.readFileSync(er,"utf8");console.log(JSON.stringify({name:n,cmd:c,exit:Number(e),ms:Number(ms),stdoutBytes:Buffer.byteLength(so),stdoutTrimmedEmpty:so.trim()==="",hasToken:tok?so.includes(tok):null,token:tok||null,stdoutHead:so.slice(0,300),stderrHead:se.slice(0,400)}))' "$@"; }

# run <名稱> <預期字串或空> <指令...>
run() {
  local name=$1 tok=$2; shift 2
  local t0 t1 code
  t0=$(date +%s%3N)
  "$@" > "$OUT/$name.stdout" 2> "$OUT/$name.stderr"; code=$?
  t1=$(date +%s%3N)
  json "$name" "$*" "$code" "$((t1 - t0))" "$OUT/$name.stdout" "$OUT/$name.stderr" "$tok" >> "$RES"
}

procs() { # 列出 moli 程序與 zombie
  local label=$1
  node -e '
const fs=require("fs");const rows=[];
for (const p of fs.readdirSync("/proc").filter(n=>/^\d+$/.test(n))) {
  try { const s=fs.readFileSync(`/proc/${p}/stat`,"utf8"); const comm=s.slice(s.indexOf("(")+1,s.lastIndexOf(")")); const st=s.slice(s.lastIndexOf(")")+2).split(" ")[0];
        if (comm.includes("moli")||st==="Z") rows.push({pid:+p,comm,state:st}); } catch {}
}
console.log(JSON.stringify({name:"procs:"+process.argv[1],rows}))' "$label" >> "$RES"
}

# 檔案系統：只開放一個全新的 HOME/TMPDIR，看 fetch 之後誰被寫入。
export HOME=/tmp/probe-home TMPDIR=/tmp/probe-tmp
unset XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR
mkdir -p "$HOME" "$TMPDIR"
touch /tmp/probe-marker; sleep 1

PUB="http://$PUB_IP:8080"
run version "" "$M" --version
run static ISSUE24_HTTP_BODY_20261112 "$M" fetch "${FLAGS[@]}" "$PUB/static"
run js ISSUE24_JS_BODY_20261112 "$M" fetch "${FLAGS[@]}" "$PUB/js"
run js-async ISSUE24_JS_ASYNC_BODY_20261112 "$M" fetch "${FLAGS[@]}" "$PUB/js-async"
run js-module ISSUE24_JS_MODULE_BODY_20261112 "$M" fetch "${FLAGS[@]}" "$PUB/js-module"
run shell WAITING "$M" fetch "${FLAGS[@]}" "$PUB/shell"
run empty "" "$M" fetch "${FLAGS[@]}" "$PUB/empty"
run notfound "" "$M" fetch "${FLAGS[@]}" "$PUB/nope"
run js-dashdash ISSUE24_JS_BODY_20261112 "$M" fetch "${FLAGS[@]}" -- "$PUB/js"

# 檔案系統差異（到這裡為止的 fetch 都已結束）
{ printf '{"name":"fs-after-fetches","newer":'; find / -xdev -newer /tmp/probe-marker \( -path /proc -o -path /sys -o -path /out -o -path /dev \) -prune -o -print 2>/dev/null | grep -v -E '^/tmp/probe-marker$' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(d.split("\n").filter(Boolean))))'; echo '}'; } >> "$RES"

# 內網封鎖：loopback 上起同一個 fixture 當負對照
PORT=8081 node /probe/fixture-server.mjs > /dev/null 2>&1 &
LOCAL_FIXTURE=$!
sleep 1
run block-loopback "" "$M" fetch "${FLAGS[@]}" "http://127.0.0.1:8081/js"
run noblock-loopback ISSUE24_JS_BODY_20261112 "$M" fetch --dump markdown --wait done "http://127.0.0.1:8081/js"
run block-localhost-name "" "$M" fetch "${FLAGS[@]}" "http://localhost:8081/js"
run block-rfc1918 "" "$M" fetch "${FLAGS[@]}" "http://$PRIV_IP:8080/js"
run noblock-rfc1918 ISSUE24_JS_BODY_20261112 "$M" fetch --dump markdown --wait done "http://$PRIV_IP:8080/js"
run block-service-name "" "$M" fetch "${FLAGS[@]}" "http://$SVC:8080/js"
run block-10net "" "$M" fetch "${FLAGS[@]}" "http://10.255.255.1/"
run block-metadata "" "$M" fetch "${FLAGS[@]}" "http://169.254.169.254/"
run block-ipv6-loopback "" "$M" fetch "${FLAGS[@]}" "http://[::1]:8081/js"
kill $LOCAL_FIXTURE

# scheme：wrapper 會先擋，這裡只記錄 Moli 自己的行為
run scheme-file "" "$M" fetch "${FLAGS[@]}" "file:///etc/hostname"
run scheme-data "" "$M" fetch "${FLAGS[@]}" "data:text/html,<p>ISSUE24_DATA</p>"

# 真實 HTTPS（TLS 與 CA）
run https-example "Example Domain" "$M" fetch "${FLAGS[@]}" "https://example.com/"

# 逾時：外層 timeout 30 秒，--kill-after 5 秒
run timeout-hang "" timeout --kill-after=5 30 "$M" fetch "${FLAGS[@]}" "$PUB/hang"
procs after-timeout-hang
run timeout-hang-js "" timeout --kill-after=5 30 "$M" fetch "${FLAGS[@]}" "$PUB/hang-js"
procs after-timeout-hang-js

# SIGTERM：Moli 收到 TERM 後多久結束
"$M" fetch "${FLAGS[@]}" "$PUB/hang" > /dev/null 2>&1 &
PID=$!
sleep 2
T0=$(date +%s%3N); kill -TERM $PID; wait $PID; CODE=$?; T1=$(date +%s%3N)
echo "{\"name\":\"sigterm\",\"exit\":$CODE,\"msAfterTerm\":$((T1 - T0))}" >> "$RES"
procs after-sigterm
sleep 2
procs after-sigterm-2s
echo '{"name":"done"}' >> "$RES"
