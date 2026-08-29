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

if ! grep -q "請按 y" scripts/install.sh; then
  echo "FAIL: 啟動問句必須明說要按 y（預設是否，答錯等於白升級）" >&2
  exit 1
fi

if ! grep -q "升級尚未生效" scripts/install.sh; then
  echo "FAIL: 升級模式必須在問句前警告『容器還跑著舊映像』" >&2
  exit 1
fi

if ! grep -q "尚未套用，容器仍是舊版" scripts/install.sh; then
  echo "FAIL: 升級時選擇略過，必須明說升級沒生效,不能靜默帶過" >&2
  exit 1
fi

echo "installer upgrade checks passed"
