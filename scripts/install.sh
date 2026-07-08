#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# TeleNexus one-liner installer / upgrader (Docker Compose 部署)
#   安裝: curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash
#   升級: curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash -s -- --upgrade
#
# 機制:
#   - 從 GitHub Release 下載 telenexus-docker-<版本>.tar.gz (只含部署檔) 解到當前目錄
#   - 映像由 CI 預建於 GHCR,啟動只需 docker compose pull,不在本機建置
#   - 使用者狀態 (.env、ai-config.yaml、data/、workspace/) 只在缺少時初始化,永不覆蓋
#   - 升級 = --upgrade:重新下載 bundle 覆蓋部署檔 + pull 新映像 + force-recreate
# ---------------------------------------------------------------------------

REPO="raybird/telenexus"
GITHUB="https://github.com"
API="https://api.github.com/repos"
BUNDLE_PREFIX="telenexus-docker"

# --- helpers ----------------------------------------------------------------

bold()  { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
dim()   { printf '\033[2m%s\033[0m' "$*"; }

abort() { printf '%s\n' "$(red "✗") $*" >&2; exit 1; }
info()  { printf '  %s %s\n' "$(green "✓")" "$*"; }
step()  { printf '\n%s\n' "$(bold "→ $*")"; }

has_docker_compose() {
  docker compose version >/dev/null 2>&1
}

# 就地更新或追加 .env 的鍵值 (沿用 setup.sh 的 upsert 邏輯)
upsert_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

# curl | bash 時 stdin 是腳本本身,互動詢問改讀 /dev/tty;沒有 tty 就用預設值
ask() {
  local prompt="$1" default="$2" reply=""
  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt" reply < /dev/tty || reply=""
  fi
  printf '%s' "${reply:-$default}"
}

# --- argument parsing -------------------------------------------------------

VERSION=""
FORCE=false
DRY_RUN=false
UPGRADE=false

usage() {
  cat <<'USAGE'
Usage: install.sh [--version vX.Y.Z] [--force] [--upgrade] [--dry-run]

Options:
  --version <tag>  安裝指定版本 (預設: latest)
  --force          覆蓋既有部署檔 (docker-compose.yml、skills/ 等;.env 與 ai-config.yaml 永不覆蓋)
  --upgrade        升級捷徑:等同 --force,下載新版部署檔後 pull 新映像重建容器
  --dry-run        只顯示將執行的動作,不寫入檔案、不啟動服務
  --help           顯示說明
USAGE
  exit 0
}

while (($#)); do
  case "$1" in
    --version) VERSION="${2:?missing version}"; shift 2 ;;
    --force)   FORCE=true; shift ;;
    --upgrade) UPGRADE=true; FORCE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help)    usage ;;
    *)         abort "未知選項: $1" ;;
  esac
done

# --- prerequisites -----------------------------------------------------------

for cmd in curl tar grep sed; do
  command -v "$cmd" >/dev/null 2>&1 || abort "需要 $cmd，請先安裝"
done
command -v docker >/dev/null 2>&1 || abort "需要 Docker，請先安裝 Docker"
has_docker_compose || abort "需要 Docker Compose v2（docker compose）"

# --- resolve version --------------------------------------------------------

if [[ -z "$VERSION" ]]; then
  step "查詢最新版本..."
  VERSION="$(curl -fsSL "${API}/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')"
  [[ -n "$VERSION" ]] || abort "無法取得最新版本，請用 --version 指定"
fi
info "版本: ${VERSION}"

BUNDLE="${BUNDLE_PREFIX}-${VERSION}.tar.gz"
BUNDLE_URL="${GITHUB}/${REPO}/releases/download/${VERSION}/${BUNDLE}"

# --- conflict detection -------------------------------------------------------

ensure_no_conflicts() {
  local conflicts=()
  local path
  for path in docker-compose.yml .env.example ai-config.example.yaml AGENTS.md skills scripts/install.sh; do
    if [[ -e "$path" ]]; then
      conflicts+=("$path")
    fi
  done
  if (( ${#conflicts[@]} > 0 )) && ! $FORCE; then
    printf '%s\n' "$(red "✗") 目前目錄已有部署檔案，避免覆蓋：" >&2
    printf '  - %s\n' "${conflicts[@]}" >&2
    abort "升級請用 --upgrade（保留 .env / ai-config.yaml / data / workspace）；或加 --force"
  fi
}

# --- install / upgrade --------------------------------------------------------

step "準備 Docker Compose 部署到 $(pwd)"

if $DRY_RUN; then
  info "dry-run: 會下載 ${BUNDLE_URL}"
  info "dry-run: 會解壓部署檔到 $(pwd)（保留既有 .env 與 ai-config.yaml）"
  info "dry-run: 會執行 docker compose pull && docker compose up -d --force-recreate"
  exit 0
fi

ensure_no_conflicts

step "下載 ${BUNDLE} ..."
TMP_BUNDLE="$(mktemp -t "${BUNDLE_PREFIX}.XXXXXX.tar.gz")"
curl -fsSL "$BUNDLE_URL" -o "$TMP_BUNDLE" || abort "無法下載 bundle: ${BUNDLE_URL}"

step "解壓部署檔案..."
tar -xzf "$TMP_BUNDLE" --strip-components=1
rm -f "$TMP_BUNDLE"
info "部署檔已更新（docker-compose.yml、skills/、AGENTS.md、examples）"

# --- initialize user state (只在缺少時建立,永不覆蓋) --------------------------

if [[ ! -f .env ]]; then
  cp .env.example .env
  upsert_env PUID "$(id -u)"
  upsert_env PGID "$(id -g)"
  info "已建立 .env（PUID/PGID 已對齊目前帳號），請填入 TELEGRAM_TOKEN 等設定"
else
  # 既有 .env 完整保留;僅在缺 PUID/PGID 時補上 (runtime UID 對齊需要)
  grep -qE '^PUID=' .env || upsert_env PUID "$(id -u)"
  grep -qE '^PGID=' .env || upsert_env PGID "$(id -g)"
  info ".env 已存在，保留現有設定"
fi

if [[ ! -f ai-config.yaml ]]; then
  cp ai-config.example.yaml ai-config.yaml
  info "已建立 ai-config.yaml（compose 需要此檔存在才能掛載）"
else
  info "ai-config.yaml 已存在，保留現有設定"
fi

mkdir -p data workspace/context workspace/temp
info "data/ 與 workspace/ 目錄就緒"

# --- start services -----------------------------------------------------------

echo ""
echo "下一步："
echo "  1. 視需求編輯 .env（首次安裝至少填 TELEGRAM_TOKEN、ALLOWED_USER_ID）"
echo "  2. 執行 docker compose pull"
echo "  3. 執行 docker compose up -d --force-recreate"
echo "  4. 首次使用需登入 opencode： docker compose exec telenexus opencode auth login"
echo ""

START_NOW="$(ask "是否現在拉取映像並啟動服務？(y/N): " "n")"
case "$(printf '%s' "$START_NOW" | tr '[:upper:]' '[:lower:]')" in
  y|yes)
    docker compose pull
    docker compose up -d --force-recreate
    ;;
  *)
    info "略過啟動，可稍後執行 docker compose pull && docker compose up -d --force-recreate"
    ;;
esac

# --- done ----------------------------------------------------------------------

cat <<DONE

$(bold '═══════════════════════════════════════')
$(bold "  TeleNexus ${VERSION} 部署完成！")
$(bold '═══════════════════════════════════════')

  部署目錄: $(green "$(pwd)")

  常用指令:
    $(dim 'docker compose ps                                  # 服務狀態')
    $(dim 'docker compose logs -f telenexus                   # 追主服務日誌')
    $(dim 'curl -sf http://localhost:3030/api/health          # 健康檢查')

  升級到新版本:
    $(dim 'curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash -s -- --upgrade')

DONE
