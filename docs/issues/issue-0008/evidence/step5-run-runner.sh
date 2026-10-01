#!/usr/bin/env bash
# 用法: run-runner.sh <容器名> <映像> <暫存目錄>
# 只啟動 agent-runner:不發佈 port、沒有 Telegram token、data/workspace/ai-config 都在暫存目錄,
# 不掛任何 named volume(opencode 的資料留在容器自己的檔案系統,移除容器即消失)。
set -euo pipefail
name="$1"; image="$2"; dir="$3"
mkdir -p "$dir/data" "$dir/workspace"
printf 'provider: opencode\nmodel: opencode/big-pickle\n' > "$dir/ai-config.yaml"
docker run -d --name "$name" \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER --cap-add DAC_OVERRIDE \
  -e TZ=Asia/Taipei -e PUID="$(id -u)" -e PGID="$(id -g)" \
  -e DB_PATH=/app/data/moltbot.db -e DB_DIR=/app/data -e APP_PROJECT_DIR=/app \
  -e RUNNER_SHARED_SECRET="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  -e RUNNER_MODE=standalone -e RUNNER_PORT=8787 \
  -e MEMORIA_SYNC_ENABLED=false -e OPENCODE_YOLO=1 \
  -v "$dir/data:/app/data" -v "$dir/workspace:/app/workspace" \
  -v "$dir/ai-config.yaml:/app/ai-config.yaml:ro" \
  "$image" node dist/runner.js
