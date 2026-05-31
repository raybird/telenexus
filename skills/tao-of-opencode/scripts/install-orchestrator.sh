#!/usr/bin/env bash
# install-orchestrator.sh — 模式 B（Persistent）安裝：把 orchestrator 根身份
#                            冪等寫進宿主 AGENTS.md 的受管區塊。
#
# 設計依據：docs/orchestrator-identity-and-portable-install.md（第 5、6 節）。
# 行為仿 GitNexus `gitnexus analyze`：以 marker 包夾的受管區塊維護，具三性質——
#   冪等（重跑結果一致）、非破壞（標記外內容不動）、人機共存（憲法與工具區塊並存）。
#
# 用法：
#   bash install-orchestrator.sh [選項]
#
# 選項：
#   --target <path>        受管區塊寫入的宿主 AGENTS.md（預設 $PWD/AGENTS.md）
#   --skill-ref <path>     區塊內角色卡連結的路徑前綴
#                          （預設 skills/tao-of-opencode/references）
#   --position append|prepend
#                          首次寫入無標記檔時，區塊放檔尾(append，預設)或檔頭(prepend)。
#                          僅在目標尚無受管區塊時生效；已有標記則就地替換、不挪位置。
#                          Codex 等「越後面優先」宿主若要專案規則覆寫本協議，用 prepend。
#   --remove               移除受管區塊（卸載），標記外內容保留
#   --check                唯讀檢查受管區塊狀態（不寫檔、不建備份）。
#                          exit 0=最新、1=過時、2=未安裝或目標不存在。
#                          不可與 --remove / --dry-run 併用。
#   --dry-run              預覽 diff，不寫檔
#   -h, --help             顯示說明
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  install-orchestrator.sh [--target <path>] [--skill-ref <path>]
                          [--position append|prepend] [--remove] [--dry-run]
  install-orchestrator.sh --check [--target <path>] [--skill-ref <path>]

Examples:
  # 預覽將寫入 ./AGENTS.md 的內容
  install-orchestrator.sh --dry-run

  # 寫入指定宿主的 AGENTS.md（如 TeleNexus 的 workspace/AGENTS.md）
  install-orchestrator.sh --target workspace/AGENTS.md

  # 首次寫入時把區塊放檔頭（讓宿主後續內容可覆寫本協議）
  install-orchestrator.sh --target AGENTS.md --position prepend

  # 移除受管區塊
  install-orchestrator.sh --target workspace/AGENTS.md --remove

  # 唯讀檢查狀態（exit 0=最新、1=過時、2=未安裝）
  install-orchestrator.sh --target workspace/AGENTS.md --check
USAGE
}

fail() { printf '%s: %s\n' "$1" "$2" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"

START="<!-- tao:start -->"
END="<!-- tao:end -->"

TARGET="$PWD/AGENTS.md"
SKILL_REF=""   # 空 = 未顯式指定 → 用 skill 名稱式 ROLE_CARD_HINT
POSITION="append"
DRY_RUN=0
REMOVE=0
CHECK=0

while (($#)); do
  case "$1" in
    --target)
      (($# < 2)) && { echo "Error: --target requires a value." >&2; usage; exit 1; }
      TARGET="$2"
      shift 2
      ;;
    --skill-ref)
      (($# < 2)) && { echo "Error: --skill-ref requires a value." >&2; usage; exit 1; }
      SKILL_REF="$2"
      shift 2
      ;;
    --position)
      (($# < 2)) && { echo "Error: --position requires a value." >&2; usage; exit 1; }
      case "$2" in
        append|prepend) POSITION="$2" ;;
        *) echo "Error: --position 只接受 append 或 prepend。" >&2; usage; exit 1 ;;
      esac
      shift 2
      ;;
    --remove)
      REMOVE=1
      shift
      ;;
    --check)
      CHECK=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unexpected argument '$1'." >&2
      usage
      exit 1
      ;;
  esac
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tao-install.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

BLOCK_FILE="$TMP_DIR/block.md"
CANDIDATE="$TMP_DIR/candidate.md"

# 角色卡引用：預設用 skill 名稱式（可攜、不含檔案路徑）；--skill-ref 覆寫成路徑式。
if [[ -n "$SKILL_REF" ]]; then
  ROLE_CARD_HINT="詳細角色卡見 ${SKILL_REF}/<role>.md。"
else
  ROLE_CARD_HINT="詳細角色卡見已連結的 \`tao-of-opencode\` skill 的 \`references/<role>.md\`（Explorer / Oracle / Librarian / Fixer / Designer）。"
fi

# 受管區塊內容（heredoc 硬寫；僅 ${ROLE_CARD_HINT} 由上方計算注入）。
# 刻意只放「名冊摘要 + 調度準則」，全文角色卡永遠留在 skills/，避免宿主憲法肥大。
cat > "$BLOCK_FILE" <<EOF
${START}
# Tao of Coding — Orchestrator 協議

你是本工作環境的 **orchestrator（統籌者）**。理解使用者請求、維持專案秩序，
並調度合適的子代理完成任務。${ROLE_CARD_HINT}

## 角色班底
- **Explorer** — 結構洞察：快速掃描專案結構、理解檔案關聯與依賴。
- **Oracle** — 架構專家：重構、決策分析、技術取捨。
- **Librarian** — 文件專家：撰寫文件、翻譯、API 註解。
- **Fixer** — 實作專家：實作、修復、單元測試、語法修正。
- **Designer** — 設計專家：UI/UX 與前端體驗。

## 調度準則
- 簡單、單步任務 → 直接回答，不召集團隊。
- 複雜或多步驟工作 → 依任務性質選用對應角色與技能再執行。
- 複雜工作優先用宿主原生 subagent 委派對應角色；無原生機制則 in-context 切換。
- 同時涉及「策略」與「實作」→ 先由 Oracle 定義方案，再交 Fixer 執行。
- 以「追查根因」為主 → 優先 systematic-debugging，不得先給修補方案。
- 明示「先規劃再做」→ 優先 writing-plans，再進入 executing-plans。
- 接近交付節點（commit/PR/完成宣告）→ 強制補上 verification-before-completion。
- 多步驟任務需先回報「路由角色 + 將使用的技能/工具」再動手。
${END}
EOF

has_markers() {
  [[ -f "$TARGET" ]] && grep -qF "$START" "$TARGET" && grep -qF "$END" "$TARGET"
}

# 以新區塊替換第一組 START..END（含標記），標記外一字不動。
replace_block() {
  awk -v startm="$START" -v endm="$END" -v blockfile="$BLOCK_FILE" '
    BEGIN { inblk = 0; done = 0 }
    {
      if (!done && index($0, startm)) {
        while ((getline line < blockfile) > 0) print line
        close(blockfile)
        inblk = 1; done = 1
        next
      }
      if (inblk) {
        if (index($0, endm)) inblk = 0
        next
      }
      print
    }
  ' "$TARGET" > "$CANDIDATE"
}

# 刪除第一組 START..END（含標記），其餘保留。
strip_block() {
  awk -v startm="$START" -v endm="$END" '
    BEGIN { inblk = 0; done = 0 }
    {
      if (!done && index($0, startm)) { inblk = 1; done = 1; next }
      if (inblk) { if (index($0, endm)) inblk = 0; next }
      print
    }
  ' "$TARGET" > "$CANDIDATE"
}

# 在現檔尾部補一空行後 append 受管區塊。
append_block() {
  cp "$TARGET" "$CANDIDATE"
  # 確保結尾有換行
  if [[ -s "$CANDIDATE" && -n "$(tail -c1 "$CANDIDATE")" ]]; then
    printf '\n' >> "$CANDIDATE"
  fi
  printf '\n' >> "$CANDIDATE"
  cat "$BLOCK_FILE" >> "$CANDIDATE"
}

# 在檔頭放受管區塊、空一行後接原有內容。
prepend_block() {
  cat "$BLOCK_FILE" > "$CANDIDATE"
  printf '\n' >> "$CANDIDATE"
  cat "$TARGET" >> "$CANDIDATE"
}

# ── --check：唯讀狀態檢查（絕不寫檔、不建備份）────────────────────
if [[ "$CHECK" -eq 1 ]]; then
  if [[ "$REMOVE" -eq 1 || "$DRY_RUN" -eq 1 ]]; then
    fail "E_FLAG_CONFLICT" "--check 不可與 --remove / --dry-run 併用。"
  fi
  if [[ ! -f "$TARGET" ]]; then
    echo "未安裝（目標不存在）：$TARGET"
    exit 2
  fi
  if ! has_markers; then
    echo "未安裝（無受管區塊）：$TARGET"
    exit 2
  fi
  replace_block
  if cmp -s "$CANDIDATE" "$TARGET"; then
    echo "最新：$TARGET"
    exit 0
  fi
  echo "過時：$TARGET"
  exit 1
fi

# ── 組出 CANDIDATE ───────────────────────────────────────────────
if [[ "$REMOVE" -eq 1 ]]; then
  if ! has_markers; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "[dry-run] Target: $TARGET"
      echo "[dry-run] 無受管區塊，無需移除。"
      exit 0
    fi
    echo "目標無受管區塊，無需移除：$TARGET"
    exit 0
  fi
  strip_block
else
  if [[ ! -f "$TARGET" ]]; then
    cp "$BLOCK_FILE" "$CANDIDATE"
  elif has_markers; then
    replace_block
  elif [[ "$POSITION" == "prepend" ]]; then
    prepend_block
  else
    append_block
  fi
fi

# ── 無變更偵測（真冪等）──────────────────────────────────────────
if [[ -f "$TARGET" ]] && cmp -s "$CANDIDATE" "$TARGET"; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] Target: $TARGET"
    echo "[dry-run] Already up to date — 無變更。"
  else
    echo "Already up to date — 無變更：$TARGET"
  fi
  exit 0
fi

# ── dry-run：印 diff 後結束 ──────────────────────────────────────
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Target: $TARGET"
  echo "[dry-run] Skill ref: $SKILL_REF"
  echo "[dry-run] Diff preview (現檔 → 套用後):"
  diff -u "${TARGET:-/dev/null}" "$CANDIDATE" 2>/dev/null || true
  if [[ ! -f "$TARGET" ]]; then
    echo "[dry-run] 目標不存在，將建立：$TARGET"
  fi
  exit 0
fi

# ── 寫入：備份 → 原子覆蓋 ────────────────────────────────────────
TARGET_DIR="$(dirname "$TARGET")"
[[ -d "$TARGET_DIR" ]] || mkdir -p "$TARGET_DIR"

BACKUP=""
if [[ -f "$TARGET" ]]; then
  BACKUP="$TARGET.tao.backup.$(date +%Y%m%d%H%M%S)"
  cp -a "$TARGET" "$BACKUP"
fi

if ! mv "$CANDIDATE" "$TARGET"; then
  [[ -n "$BACKUP" && -f "$BACKUP" ]] && mv "$BACKUP" "$TARGET"
  fail "E_WRITE_FAILED" "無法寫入 $TARGET"
fi

if [[ "$REMOVE" -eq 1 ]]; then
  echo "受管區塊已移除：$TARGET"
else
  echo "受管區塊已寫入：$TARGET"
fi
[[ -n "$BACKUP" ]] && echo "- 備份：$BACKUP"
exit 0
