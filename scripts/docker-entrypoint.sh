#!/usr/bin/env bash
set -euo pipefail

# ==========================================================================
# TeleNexus 容器 entrypoint — runtime UID/GID 對齊 + 降權執行。
#
# 預建映像 (GHCR) 無法在 build 時用 ARG 對齊 host 帳號，改為啟動時：
#   1. 依 PUID/PGID (預設 1000) remap 內建 node 使用者
#   2. 修正 bind mount 與 named volume 的擁有權
#      (v2.18.0 非 root 化曾因 root 遺留檔弄壞 context 快照與 opencode DB)
#   3. gosu 降權為 node 後執行 CMD (npm start / node dist/runner.js)
#
# 需要的 capabilities: CHOWN, SETUID, SETGID, FOWNER, DAC_OVERRIDE
# (docker-compose.yml 的 cap_add 已列)。非 root 啟動時跳過 remap 直接執行。
# ==========================================================================

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [[ "$(id -u)" != "0" ]]; then
  # 已是非 root (例如使用者自行指定 user:)，無法 remap，直接執行。
  exec "$@"
fi

CURRENT_UID="$(id -u node)"
CURRENT_GID="$(id -g node)"

if [[ "$PGID" != "$CURRENT_GID" ]]; then
  groupmod -o -g "$PGID" node
fi
if [[ "$PUID" != "$CURRENT_UID" ]]; then
  usermod -o -u "$PUID" node
fi
if [[ "$PUID" != "$CURRENT_UID" || "$PGID" != "$CURRENT_GID" ]]; then
  echo "[telenexus] 對齊容器使用者 node → UID=${PUID} GID=${PGID}"
fi

# bind mounts：只動目錄本身與必要子目錄，不遞迴掃整個 workspace
mkdir -p /app/data /app/workspace/context /app/workspace/temp
chown node:node /app/data /app/workspace /app/workspace/context /app/workspace/temp 2>/dev/null || true

# named volumes (opencode 認證與全域設定)：體積小，遞迴修正
for dir in /home/node/.local/share/opencode /home/node/.config/opencode; do
  mkdir -p "$dir"
  chown -R node:node "$dir" 2>/dev/null || true
done
chown node:node /home/node 2>/dev/null || true

exec gosu node "$@"
