#!/usr/bin/env bash
# ==========================================================================
# TeleNexus 一鍵初始化:讓任何 host 帳號都能無痛跑起來。
#   - 自動偵測 host 的 UID/GID,寫進 .env (PUID/PGID),免手動 chown
#   - 從 .env.example 建立 .env (若不存在)
#   - 建立必要的本地目錄
#   - 提示後續步驟 (填 token、build、opencode 登入)
# Memoria 已改為 npm 安裝的 HTTP 服務,不需要再 clone 任何子 repo。
# ==========================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PUID="$(id -u)"
PGID="$(id -g)"

echo "==> 偵測到 host 身分: UID=${PUID} GID=${PGID}"

# 1) 建立 .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> 已從 .env.example 建立 .env"
else
  echo "==> .env 已存在,保留不覆寫"
fi

# 2) 寫入/更新 PUID/PGID
upsert_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    # 就地更新 (相容 GNU/BSD sed)
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
upsert_env PUID "$PUID"
upsert_env PGID "$PGID"
echo "==> 已將 PUID/PGID 寫入 .env"

# 3) 建立本地目錄 (bind mount 目標)
mkdir -p data workspace/context workspace/temp
echo "==> 已建立 data/ 與 workspace/ 目錄"

# 4) 後續提示
cat <<EOF

────────────────────────────────────────────────────────────
✅ 初始化完成。接下來:

  1. 編輯 .env,至少填入:
       TELEGRAM_TOKEN=<你的 bot token>
       ALLOWED_USER_ID=<你的 Telegram user id>

  2. 建置並啟動 (PUID/PGID 會自動帶入,bind mount 不會有權限問題):
       docker compose up -d --build

  3. 首次需要登入 opencode (CLI agent):
       docker compose exec telenexus opencode auth login

  4. 檢查狀態:
       docker compose ps
       curl -sf http://localhost:\${WEB_PORT:-3030}/api/health
────────────────────────────────────────────────────────────
EOF
