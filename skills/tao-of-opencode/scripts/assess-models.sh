#!/usr/bin/env bash
# assess-models.sh — NVIDIA NIM 模型能力評估工具
#
# 用途：對 model-registry.conf 中的模型執行三維能力測試，
#       輸出 Markdown 報告並附帶角色分配建議。
#
# 用法：
#   bash assess-models.sh [選項]
#
# 選項：
#   --tier S,A,B,C    只測試指定梯隊（逗號分隔，預設全部）
#   --model <id>      只測試單一模型（完整 model id）
#   --timeout <秒>    每次呼叫 timeout（預設 30）
#   --output <路徑>   報告輸出路徑（預設 docs/model-assessment.md）
#   --dry-run         列出將測試的模型，不實際呼叫
#   --help            顯示此說明

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REGISTRY="$SCRIPT_DIR/../references/model-registry.conf"

# 預設值
FILTER_TIERS=""
SINGLE_MODEL=""
TIMEOUT=30
OUTPUT="$REPO_ROOT/docs/model-assessment.md"
DRY_RUN=false

# ── 解析參數 ────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)    FILTER_TIERS="$2"; shift 2 ;;
    --model)   SINGLE_MODEL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --output)  OUTPUT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help)
      cat << 'EOF'
用途：對 model-registry.conf 中的模型執行三維能力測試，
      輸出 Markdown 報告並附帶角色分配建議。

用法：
  bash assess-models.sh [選項]

選項：
  --tier S,A,B,C    只測試指定梯隊（逗號分隔，預設全部）
  --model <id>      只測試單一模型（完整 model id）
  --timeout <秒>    每次呼叫 timeout（預設 30）
  --output <路徑>   報告輸出路徑（預設 docs/model-assessment.md）
  --dry-run         列出將測試的模型，不實際呼叫
  --help            顯示此說明

範例：
  bash assess-models.sh --dry-run
  bash assess-models.sh --tier S,A
  bash assess-models.sh --tier S --timeout 45
  bash assess-models.sh --model nvidia/deepseek-ai/deepseek-v4-pro
  bash assess-models.sh --output /tmp/report.md
EOF
      exit 0 ;;
    *) echo "未知參數：$1（用 --help 查看說明）" >&2; exit 1 ;;
  esac
done

# ── 測試題目 ─────────────────────────────────────────────
# T1：指令遵循（嚴格 JSON 格式）
T1='Reply with ONLY valid JSON, no extra text: {"answer":"yes or no","reason":"one sentence"}\nQ: If all cats are animals and all animals need food, do cats need food?'
T1_EXPECT="yes"

# T2：程式碼生成（直接輸出函式）
T2='Write ONLY a Python function, no markdown fences, no explanation:\ndef first_duplicate(lst: list):\n    """Return the first item appearing more than once, or None."""'
T2_EXPECT="def first_duplicate"

# T3：邏輯推理（無歧義算術）
# John 有 Mary 兩倍蘋果；Mary 有 6 顆；John 給 Mary 4 顆 → John 剩 8 顆
T3='John has twice as many apples as Mary. Mary has 6 apples. John gives 4 apples to Mary. How many apples does John have now? Reply with ONLY a number.'
T3_EXPECT="8"

# ── 工具函式 ─────────────────────────────────────────────
strip_ansi() {
  sed 's/\x1B\[[0-9;]*[mK]//g'
}

# 執行單次測試，回傳 "✅ <摘要>" 或 "❌EOL" 或 "⏱TIMEOUT" 或 "⚠️<摘要>"
run_test() {
  local model="$1" prompt="$2" expect="$3"
  local raw exit_code

  raw=$(printf '%b' "$prompt" | timeout "$TIMEOUT" opencode run --model "$model" 2>&1) || true
  exit_code=$?

  raw=$(echo "$raw" | strip_ansi)

  if [[ $exit_code -eq 124 ]]; then
    echo "⏱TIMEOUT"
    return
  fi

  # 偵測 EOL / 404
  if echo "$raw" | grep -qiE '"Gone"|end of life|410|404 Not Found|no longer available'; then
    echo "❌EOL"
    return
  fi

  # 偵測 API 錯誤（假陽性）
  if echo "$raw" | grep -qiE 'Bad Request|maximum context length|string_type|Error:.*Request'; then
    echo "⚠️API_ERR"
    return
  fi

  # 取出實際內容（過濾 opencode build 行）
  local content
  content=$(echo "$raw" | grep -v "^>" | grep -v "^$" | head -5 | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-60)

  if [[ -z "$(echo "$content" | tr -d '[:space:]')" ]]; then
    echo "⚠️EMPTY"
    return
  fi

  # 品質判斷：是否包含預期關鍵字
  if echo "$raw" | grep -qi "$expect"; then
    echo "✅ $content"
  else
    echo "⚠️ $content"
  fi
}

# 評分（✅=1, 其他=0）
score_result() {
  local r="$1"
  [[ "$r" == ✅* ]] && echo 1 || echo 0
}

# ── 載入模型清單 ──────────────────────────────────────────
load_models() {
  local models=()

  if [[ -n "$SINGLE_MODEL" ]]; then
    models+=("$SINGLE_MODEL|?|手動指定")
  else
    while IFS='|' read -r id tier notes; do
      # 跳過空行與註解
      [[ -z "$id" || "$id" =~ ^# ]] && continue
      # 跳過 EOL / BAD
      [[ "$tier" == "EOL" || "$tier" == "BAD" ]] && continue
      # 梯隊篩選
      if [[ -n "$FILTER_TIERS" ]]; then
        IFS=',' read -ra allowed <<< "$FILTER_TIERS"
        local match=false
        for t in "${allowed[@]}"; do
          [[ "$tier" == "$t" ]] && match=true && break
        done
        "$match" || continue
      fi
      models+=("$id|$tier|$notes")
    done < "$REGISTRY"
  fi

  printf '%s\n' "${models[@]}"
}

# ── 主流程 ────────────────────────────────────────────────
mapfile -t MODEL_LIST < <(load_models)
TOTAL=${#MODEL_LIST[@]}

if [[ $TOTAL -eq 0 ]]; then
  echo "找不到符合條件的模型。" >&2
  exit 1
fi

if $DRY_RUN; then
  echo "── Dry Run：將測試以下 $TOTAL 個模型 ──"
  for entry in "${MODEL_LIST[@]}"; do
    IFS='|' read -r id tier notes <<< "$entry"
    printf "  [%s] %s\n" "$tier" "$id"
  done
  exit 0
fi

echo "開始評估 $TOTAL 個模型（timeout=${TIMEOUT}s）..."
echo "報告輸出：$OUTPUT"
echo ""

# 寫報告標頭
TODAY=$(date '+%Y-%m-%d')
cat > "$OUTPUT" << HEADER
# NVIDIA NIM 模型能力評估報告

> 評估日期：$TODAY
> 測試維度：T1 指令遵循、T2 程式碼生成、T3 邏輯推理
> Timeout 設定：${TIMEOUT}s / 次
>
> **評分說明**
> - ✅ 回應正確且包含預期內容
> - ⚠️ 回應但內容有疑慮（格式錯誤 / 答案偏差）
> - ❌EOL 模型已停用
> - ⏱TIMEOUT 超時無回應
> - ⚠️API_ERR 回應為 API 錯誤（假陽性）

## 測試題目

| # | 維度 | 題目摘要 | 預期答案 |
| :---: | :--- | :--- | :--- |
| T1 | 指令遵循 | 邏輯推論 cats→food，要求嚴格 JSON 格式 | \`{"answer":"yes",...}\` |
| T2 | 程式碼生成 | 實作 \`first_duplicate(lst)\`，僅輸出函式 | 包含 \`def first_duplicate\` |
| T3 | 邏輯推理 | 蘋果算術（多步驟，無歧義） | \`8\` |

## 評估結果

| 模型 | 梯隊 | T1 指令遵循 | T2 程式碼 | T3 推理 | 通過 |
| :--- | :---: | :---: | :---: | :---: | :---: |
HEADER

idx=0
pass_count=0
fail_count=0
eol_count=0

for entry in "${MODEL_LIST[@]}"; do
  IFS='|' read -r model tier notes <<< "$entry"
  short="${model#nvidia/}"
  idx=$((idx + 1))

  printf "[%d/%d] [%s] %s\n" "$idx" "$TOTAL" "$tier" "$short"

  printf "  T1 指令遵循... "
  r1=$(run_test "$model" "$T1" "$T1_EXPECT")
  echo "$r1"

  printf "  T2 程式碼生成... "
  r2=$(run_test "$model" "$T2" "$T2_EXPECT")
  echo "$r2"

  printf "  T3 邏輯推理... "
  r3=$(run_test "$model" "$T3" "$T3_EXPECT")
  echo "$r3"

  s1=$(score_result "$r1")
  s2=$(score_result "$r2")
  s3=$(score_result "$r3")
  score=$((s1 + s2 + s3))

  # 統計
  if [[ "$r1" == "❌EOL" ]]; then
    eol_count=$((eol_count + 1))
  elif [[ $score -eq 3 ]]; then
    pass_count=$((pass_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi

  # 截斷表格欄位
  r1t=$(echo "$r1" | cut -c1-35)
  r2t=$(echo "$r2" | cut -c1-35)
  r3t=$(echo "$r3" | cut -c1-35)

  echo "| \`$short\` | $tier | $r1t | $r2t | $r3t | $score/3 |" >> "$OUTPUT"
  echo ""
done

# 寫摘要區塊
cat >> "$OUTPUT" << SUMMARY

---

## 摘要統計

| 狀態 | 數量 |
| :--- | :---: |
| ✅ 全部通過（3/3） | $pass_count |
| ⚠️ 部分通過（1–2/3） | $fail_count |
| ❌ EOL / 不可用 | $eol_count |
| 合計測試 | $TOTAL |

_評估完成：$(date '+%Y-%m-%d %H:%M:%S')_
SUMMARY

echo ""
echo "============================="
echo "✅ 評估完成"
echo "   全部通過：$pass_count / 部分通過：$fail_count / EOL：$eol_count"
echo "   報告：$OUTPUT"
