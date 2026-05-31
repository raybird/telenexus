#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  sync-superpowers.sh <upstream_commit> [--dry-run] [--repo <repo_url>]

Examples:
  sync-superpowers.sh a98c5dfc9de0df5318f4980d91d24780a566ee60 --dry-run
  sync-superpowers.sh v4.2.0 --repo https://github.com/obra/superpowers.git
USAGE
}

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
DEST_DIR="$SKILL_DIR/references/superpowers"

UPSTREAM_REPO="https://github.com/obra/superpowers.git"
DRY_RUN=0
UPSTREAM_REF=""

while (($#)); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --repo)
      if (($# < 2)); then
        echo "Error: --repo requires a value." >&2
        usage
        exit 1
      fi
      UPSTREAM_REPO="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$UPSTREAM_REF" ]]; then
        UPSTREAM_REF="$1"
        shift
      else
        echo "Error: unexpected argument '$1'." >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$UPSTREAM_REF" ]]; then
  echo "Error: missing <upstream_commit>." >&2
  usage
  exit 1
fi

SELECTED_SKILLS=(
  "brainstorming"
  "writing-plans"
  "executing-plans"
  "test-driven-development"
  "systematic-debugging"
  "verification-before-completion"
  "requesting-code-review"
  "receiving-code-review"
  # orchestrator 自用的調度技能（宿主有原生 subagent 時適用）
  "subagent-driven-development"
  "dispatching-parallel-agents"
)

TMP_DIR="$(mktemp -d /tmp/tao-superpowers-sync.XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

UPSTREAM_DIR="$TMP_DIR/upstream"
STAGE_DIR="$TMP_DIR/superpowers"

mkdir -p "$UPSTREAM_DIR"

git -C "$UPSTREAM_DIR" init -q
git -C "$UPSTREAM_DIR" remote add origin "$UPSTREAM_REPO"
git -C "$UPSTREAM_DIR" fetch --depth 1 origin "$UPSTREAM_REF" >/dev/null
git -C "$UPSTREAM_DIR" checkout -q FETCH_HEAD

RESOLVED_COMMIT="$(git -C "$UPSTREAM_DIR" rev-parse HEAD)"
IMPORT_DATE="$(date +%F)"

mkdir -p "$STAGE_DIR"

for skill in "${SELECTED_SKILLS[@]}"; do
  # 佈局偵測：v5+ 上游把技能放在 skills/<skill>/；v4 及更早為 <skill>/。
  if [[ -f "$UPSTREAM_DIR/skills/$skill/SKILL.md" ]]; then
    src="$UPSTREAM_DIR/skills/$skill"
  else
    src="$UPSTREAM_DIR/$skill"
  fi
  dst="$STAGE_DIR/$skill"

  if [[ ! -f "$src/SKILL.md" ]]; then
    echo "Error: missing expected skill file: $src/SKILL.md" >&2
    exit 1
  fi

  cp -a "$src" "$dst"
done

cat > "$STAGE_DIR/SOURCE.md" <<EOF2
## Source Attribution

This directory contains localized copies of selected skills from \`obra/superpowers\`.

- Upstream repository: ${UPSTREAM_REPO%.git}
- Upstream license: MIT
- Source commit: \`${RESOLVED_COMMIT}\`
- Imported on: ${IMPORT_DATE}

Per upstream MIT license terms, copyright and permission notices remain in
the upstream project license.
EOF2

for skill in "${SELECTED_SKILLS[@]}"; do
  if [[ ! -f "$STAGE_DIR/$skill/SKILL.md" ]]; then
    echo "Error: staged skill is incomplete: $skill" >&2
    exit 1
  fi
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Upstream: $UPSTREAM_REPO"
  echo "[dry-run] Ref: $UPSTREAM_REF"
  echo "[dry-run] Resolved commit: $RESOLVED_COMMIT"

  if [[ ! -d "$DEST_DIR" ]]; then
    echo "[dry-run] Destination does not exist and will be created: $DEST_DIR"
  else
    echo "[dry-run] Diff preview (destination vs staged):"
    if diff -ruN "$DEST_DIR" "$STAGE_DIR"; then
      echo "[dry-run] No differences."
    fi
  fi

  exit 0
fi

mkdir -p "$(dirname "$DEST_DIR")"

BACKUP_DIR=""
if [[ -d "$DEST_DIR" ]]; then
  BACKUP_DIR="$(dirname "$DEST_DIR")/superpowers.backup.$(date +%Y%m%d%H%M%S)"
  mv "$DEST_DIR" "$BACKUP_DIR"
fi

if ! mv "$STAGE_DIR" "$DEST_DIR"; then
  if [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]]; then
    mv "$BACKUP_DIR" "$DEST_DIR"
  fi
  echo "Error: failed to install synced superpowers." >&2
  exit 1
fi

if rg -n "skills/superpowers" "$REPO_ROOT" --hidden -g '!.git' >/dev/null 2>&1; then
  echo "Error: found legacy path references 'skills/superpowers' in repository." >&2
  exit 1
fi

echo "Sync completed."
echo "- Installed to: $DEST_DIR"
echo "- Source commit: $RESOLVED_COMMIT"
if [[ -n "$BACKUP_DIR" ]]; then
  echo "- Backup created: $BACKUP_DIR"
fi
