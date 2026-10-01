#!/usr/bin/env bash
# 用法: cap.sh <樣本名> <opencode 版本> <工作子目錄> <逾時秒數> -- <opencode 參數...>
# 以隔離的 HOME / XDG 執行,stdout、stderr、exit code 與耗時分別存檔。
set -u
S="$(cd "$(dirname "$0")" && pwd)"
name="$1"; ver="$2"; sub="$3"; tmo="$4"; shift 5
home="$S/home-$ver"; work="$S/work/$sub"; out="$S/out"
mkdir -p "$home" "$work" "$out"
start=$(date +%s.%N)
( cd "$work" && env -i PATH="$S/oc-$ver/node_modules/.bin:/usr/bin:/bin" HOME="$home" \
    XDG_DATA_HOME="$home/.local/share" XDG_CONFIG_HOME="$home/.config" \
    XDG_CACHE_HOME="$home/.cache" XDG_STATE_HOME="$home/.local/state" ${CAP_ENV:-} \
    timeout --signal=KILL "$tmo" opencode "$@" >"$out/$name.stdout" 2>"$out/$name.stderr" </dev/null )
code=$?
end=$(date +%s.%N)
printf 'name=%s version=%s exit=%s seconds=%.1f stdout_bytes=%s stderr_bytes=%s\n' \
  "$name" "$ver" "$code" "$(echo "$end - $start" | bc)" \
  "$(stat -c %s "$out/$name.stdout")" "$(stat -c %s "$out/$name.stderr")" | tee "$out/$name.meta"
