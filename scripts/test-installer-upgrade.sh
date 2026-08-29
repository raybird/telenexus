#!/usr/bin/env bash
set -euo pipefail

# install.sh 安裝/升級路徑的靜態驗證 (全走 --dry-run,不碰網路下載與檔案寫入)

cd "$(dirname "${BASH_SOURCE[0]}")/.."

output="$(bash scripts/install.sh --upgrade --version v2.20.0 --dry-run)"

if [[ "$output" != *"telenexus-docker-v2.20.0.tar.gz"* ]]; then
  echo "FAIL: --upgrade 應使用指定版本的 docker bundle" >&2
  exit 1
fi

if [[ "$output" != *"dry-run: 會下載"* ]]; then
  echo "FAIL: --dry-run 應顯示將下載的 bundle URL" >&2
  exit 1
fi

if [[ "$output" != *"保留既有 .env"* ]]; then
  echo "FAIL: 升級流程必須聲明保留 .env" >&2
  exit 1
fi

if ! grep -q "docker compose pull" scripts/install.sh; then
  echo "FAIL: 安裝流程應以 docker compose pull 取得預建映像 (不在本機 build)" >&2
  exit 1
fi

if ! grep -q "docker compose up -d --force-recreate" scripts/install.sh; then
  echo "FAIL: 升級流程應 force-recreate 換上新映像" >&2
  exit 1
fi

if ! grep -q 'cp .env.example .env' scripts/install.sh; then
  echo "FAIL: 首次安裝應由 .env.example 建立 .env" >&2
  exit 1
fi

if ! grep -q 'START_DEFAULT="y"' scripts/install.sh; then
  echo "FAIL: --upgrade 的預設應為 y —— 使用者打了 --upgrade 就是要升級" >&2
  exit 1
fi

if ! grep -q 'START_DEFAULT="n"' scripts/install.sh; then
  echo "FAIL: 全新安裝的預設應為 n —— 此時 .env 尚未填入 token" >&2
  exit 1
fi

if ! grep -q "容器還跑著舊版映像" scripts/install.sh; then
  echo "FAIL: 升級模式必須在問句前說明容器仍是舊版" >&2
  exit 1
fi

if ! grep -q "服務會短暫中斷" scripts/install.sh; then
  echo "FAIL: 預設為 y 就必須事先告知會重建容器、服務中斷" >&2
  exit 1
fi

if ! grep -q "尚未套用，容器仍是舊版" scripts/install.sh; then
  echo "FAIL: 升級時選擇略過，必須明說升級沒生效,不能靜默帶過" >&2
  exit 1
fi

echo "installer upgrade checks passed"
