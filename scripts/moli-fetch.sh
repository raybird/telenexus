#!/usr/bin/env bash
# telenexus-moli-fetch <http(s) 網址>
#
# 2026-11-12（issue 0024）：用 Moli 讀取 JS 渲染後的正文，輸出 Markdown。
# 模型只傳網址；參數、逾時與內網封鎖都固定在這裡，不開放覆寫。
# 結束碼：0 有正文；2 參數不合；3 沒有正文；124 逾時；其他為 Moli 的結束碼
# （1 一般錯誤或內網被封鎖，22 是 HTTP >= 400）。非 0 時由 web-reading 技能改用 Chrome。
set -u

readonly MOLI_BIN=${TELENEXUS_MOLI_BIN:-/opt/telenexus/moli/moli-v1.1.23-x86_64-unknown-linux-gnu/moli}
readonly HARD_TIMEOUT_S=30
readonly KILL_AFTER_S=5
# 背景清理程序最多等多久：硬逾時加 kill-after，再留 5 秒。
readonly CLEANUP_MAX_S=40

fail() { printf 'telenexus-moli-fetch: %s\n' "$1" >&2; exit "$2"; }

if [ "$#" -ne 1 ]; then
  fail '只接受一個 http 或 https 網址' 2
fi
url=$1
shopt -s nocasematch
if [[ ! $url =~ ^https?:// ]]; then
  fail "只接受 http 或 https 網址：$url" 2
fi
shopt -u nocasematch

# Moli 也讀 MOLI_* 環境變數（例如 MOLI_BLOCK_PRIVATE_NETWORKS），不讓它們改變固定參數。
while IFS= read -r name; do unset "$name"; done < <(compgen -e | grep '^MOLI_' || true)

# Moli 沒帶 --profile-dir 時把 cookie、IndexedDB、OPFS 寫在 TMPDIR，被訊號中斷時不會清掉。
root=$(mktemp -d "${TMPDIR:-/tmp}/tnm-XXXXXX") || fail '無法建立暫存目錄' 1
export HOME="$root" TMPDIR="$root"

# --foreground：timeout 預設會自己另開 process group，這樣 wrapper 的 group 被 SIGKILL 時
# Moli 不會跟著結束。Moli 是單一程序，沒有「子程序不受逾時管」的副作用。
timeout --foreground --kill-after="$KILL_AFTER_S" "$HARD_TIMEOUT_S" \
  "$MOLI_BIN" fetch --dump markdown --wait domstable --timeout 10000 --fail \
  --block-private-networks -- "$url" > "$root/out.md" &
moli_pid=$!

# wrapper 與 Moli 一起被 SIGKILL 時 trap 不會執行，所以另起一個不在這個 process group、
# 不持有 stdout／stderr 的清理程序：wrapper 與 timeout 都結束後刪除暫存目錄。
setsid bash -c '
  root=$1 wrapper=$2 moli=$3 max=$4
  for ((i = 0; i < max * 5; i++)); do
    kill -0 "$wrapper" 2>/dev/null || kill -0 "$moli" 2>/dev/null || break
    sleep 0.2
  done
  rm -rf -- "$root"
' cleanup "$root" "$$" "$moli_pid" "$CLEANUP_MAX_S" < /dev/null > /dev/null 2>&1 &

on_signal() {
  kill -TERM "$moli_pid" 2>/dev/null
  wait "$moli_pid" 2>/dev/null
  rm -rf -- "$root"
  exit "$1"
}
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
trap 'on_signal 129' HUP

wait "$moli_pid"
code=$?
trap - TERM INT HUP

if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
  rm -rf -- "$root"
  fail "逾時：超過 ${HARD_TIMEOUT_S} 秒仍未讀完 $url" 124
fi
if [ "$code" -ne 0 ]; then
  rm -rf -- "$root"
  exit "$code"
fi
if ! grep -q '[^[:space:]]' "$root/out.md"; then
  rm -rf -- "$root"
  fail "沒有正文：$url" 3
fi
cat -- "$root/out.md"
rm -rf -- "$root"
