#!/usr/bin/env bash
# refresh-model-registry.sh — 同步 opencode models 清單與 model-registry.conf
#
# 用法：
#   bash refresh-model-registry.sh [選項]
#
# 選項：
#   --add-new     自動將新模型加入 registry（tier 標為 ?，待人工分級）
#   --dry-run     只顯示 diff，不修改任何檔案
#   --help        顯示此說明
#
# 工作流程：
#   1. 執行 `opencode models` 取得目前平台上的完整模型清單
#   2. 過濾出 nvidia/ 文字/對話模型（排除 embedding、TTS 等）
#   3. 對比 model-registry.conf 中的現有登記
#   4. 顯示：新出現的模型（未登記）、從清單消失的模型（可能 EOL）
#   5. 若帶 --add-new，將新模型附加到 registry 末端待人工處理

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="$SCRIPT_DIR/../references/model-registry.conf"

ADD_NEW=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --add-new)  ADD_NEW=true; shift ;;
    --dry-run)  DRY_RUN=true; shift ;;
    --help)
      cat << 'EOF'
用法：bash refresh-model-registry.sh [選項]

選項：
  --add-new   自動將新模型加入 registry（tier 標為 ?，待人工分級）
  --dry-run   只顯示 diff，不修改任何檔案
  --help      顯示此說明

建議流程：
  1. bash refresh-model-registry.sh          # 查看 diff
  2. bash refresh-model-registry.sh --add-new # 自動補入新模型
  3. 手動編輯 model-registry.conf，設定正確 tier 與 notes
  4. bash assess-models.sh --tier ?          # 評估新模型（如支援 tier 篩選）
EOF
      exit 0 ;;
    *) echo "未知參數：$1（用 --help 查看說明）" >&2; exit 1 ;;
  esac
done

# ── 不可用模型關鍵字（非文字/對話用途）──────────────────
EXCLUDE_PATTERN="embed|rerank|detection|bevformer|cosmos|pali|esm2|esmfold|gliner|safety-guard|bge-m3|flux|nemoretriever|tts|whisper|voicechat|riva-translate|sparsedrive|streampetr|studiovoice|video-detector|usdcode|usdvalidate|qwen-image|magpie|paligemma"

# ── Step 1：從 opencode 取得目前免費模型清單 ─────────────
# 來源一：nvidia/   （opencode models nvidia）
# 來源二：opencode/ （opencode models opencode，平台自有免費模型）
echo "▶ 從 opencode models 取得最新清單..."
if ! raw_nvidia=$(opencode models nvidia 2>&1); then
  echo "❌ 無法執行 opencode models nvidia，請確認 opencode CLI 已安裝並可執行" >&2
  exit 1
fi
if ! raw_opencode=$(opencode models opencode 2>&1); then
  echo "❌ 無法執行 opencode models opencode" >&2
  exit 1
fi

mapfile -t LIVE_MODELS < <(
  {
    echo "$raw_nvidia" \
      | grep "^nvidia/" \
      | grep -viE "$EXCLUDE_PATTERN"
    echo "$raw_opencode" \
      | grep "^opencode/"
  } | sort
)
echo "   取得 ${#LIVE_MODELS[@]} 個免費模型（nvidia/ + opencode/）"

# ── Step 2：從 registry 取得已登記的模型 id ──────────────
# 同時抓取：有效登記行 + 已註解的 EOL/BAD 行（# nvidia/...）
# 確保已知的廢棄模型不被誤報為「新出現」
mapfile -t REGISTERED_IDS < <(
  {
    # 有效登記行（非空、非純註解）
    grep -vE '^\s*#|^\s*$' "$REGISTRY" | cut -d'|' -f1

    # 已知 EOL / BAD 行（格式：# nvidia/xxx|EOL|... 或 # opencode/xxx|EOL|...）
    grep -E '^\s*#\s*(nvidia|opencode)/' "$REGISTRY" \
      | sed 's/^\s*#\s*//' \
      | cut -d'|' -f1
  } \
  | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
  | grep -v '^$' \
  | sort -u
)
echo "   registry 現有 ${#REGISTERED_IDS[@]} 筆登記（含 EOL 記錄）"
echo ""

# ── Step 3：計算 diff ─────────────────────────────────────
NEW_MODELS=()
for m in "${LIVE_MODELS[@]}"; do
  found=false
  for r in "${REGISTERED_IDS[@]}"; do
    [[ "$m" == "$r" ]] && found=true && break
  done
  "$found" || NEW_MODELS+=("$m")
done

MISSING_MODELS=()
for r in "${REGISTERED_IDS[@]}"; do
  found=false
  for m in "${LIVE_MODELS[@]}"; do
    [[ "$r" == "$m" ]] && found=true && break
  done
  "$found" || MISSING_MODELS+=("$r")
done

# ── Step 4：顯示結果 ──────────────────────────────────────
if [[ ${#NEW_MODELS[@]} -eq 0 && ${#MISSING_MODELS[@]} -eq 0 ]]; then
  echo "✅ registry 與 opencode models 完全同步，無差異。"
  exit 0
fi

if [[ ${#NEW_MODELS[@]} -gt 0 ]]; then
  echo "🆕 新出現的模型（共 ${#NEW_MODELS[@]} 個，尚未登記）："
  for m in "${NEW_MODELS[@]}"; do
    echo "   + $m"
  done
  echo ""
fi

if [[ ${#MISSING_MODELS[@]} -gt 0 ]]; then
  echo "⚠️  從 opencode models 消失的模型（共 ${#MISSING_MODELS[@]} 個，可能已 EOL）："
  for m in "${MISSING_MODELS[@]}"; do
    # 顯示目前 registry 中的 tier
    tier=$(grep -E "^${m//\//\\/}\|" "$REGISTRY" | cut -d'|' -f2 || echo "?")
    echo "   - [$tier] $m"
  done
  echo ""
  echo "   建議：在 model-registry.conf 中將上述模型的 tier 改為 EOL 並加上日期註解。"
  echo ""
fi

# ── Step 5：自動補入新模型（--add-new）──────────────────
if $ADD_NEW && [[ ${#NEW_MODELS[@]} -gt 0 ]]; then
  if $DRY_RUN; then
    echo "（dry-run：以下為將附加到 registry 的內容）"
    echo ""
    echo "# ── 待分級（$(date '+%Y-%m-%d') refresh-model-registry.sh 自動加入）──"
    for m in "${NEW_MODELS[@]}"; do
      echo "$m|?|待評估"
    done
  else
    echo "▶ 將 ${#NEW_MODELS[@]} 個新模型附加到 registry..."
    {
      echo ""
      echo "# ── 待分級（$(date '+%Y-%m-%d') refresh-model-registry.sh 自動加入）──"
      for m in "${NEW_MODELS[@]}"; do
        echo "$m|?|待評估"
      done
    } >> "$REGISTRY"
    echo "   ✅ 已附加，請編輯 model-registry.conf 設定正確 tier 與 notes"
    echo "   路徑：$REGISTRY"
  fi
elif [[ ${#NEW_MODELS[@]} -gt 0 ]]; then
  echo "提示：加上 --add-new 可自動將新模型附加到 registry 待人工分級。"
fi
