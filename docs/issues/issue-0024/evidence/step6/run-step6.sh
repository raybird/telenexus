#!/usr/bin/env bash
# issue 0024 步驟 6：建立拋棄式網路與 fixture，每個情境起一個全新的 agent-runner 容器，
# 經 POST /run 送一則讀取請求，用 /proc 採樣器與 fixture 請求紀錄觀察，最後全部移除。
# 只建立、停止本腳本具名的 tn24s6-* 容器與網路。
# 用法：run-step6.sh <輸出目錄> <情境...>；情境 control 只跑觀測器的正負對照，不呼叫模型。
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$DIR/../../../../.." && pwd)
OUT=$1; shift
IMAGE=${IMAGE:-telenexus:issue24}
PUB=45.67.89.10
mkdir -p "$OUT"
cleanup() {
  for n in $(docker ps -a --format '{{.Names}}' | grep '^tn24s6-' || true); do docker rm -f "$n" >/dev/null; done
  docker network rm tn24s6-pub tn24s6-priv >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
# 模型用正式部署 ai-config.yaml 的預設值（免費層、不需憑證）；其餘設定照範例檔。
{ cat "$REPO/ai-config.example.yaml"; echo 'model: opencode/big-pickle'; } > "$OUT/ai-config.yaml"
docker network create --subnet 45.67.89.0/24 tn24s6-pub >/dev/null
docker network create tn24s6-priv >/dev/null
docker run -d --name tn24s6-fixture --network tn24s6-pub --ip "$PUB" --user 1000:1000 \
  -v "$DIR":/probe:ro -v "$OUT":/out --entrypoint node "$IMAGE" /probe/fixture6.mjs >/dev/null
docker network connect tn24s6-priv tn24s6-fixture
PRIV=$(docker inspect -f '{{(index .NetworkSettings.Networks "tn24s6-priv").IPAddress}}' tn24s6-fixture)
echo "PRIV=$PRIV" > "$OUT/env.txt"
url_of() { case $1 in s3d) echo "http://$PRIV:8080/s3d/page" ;; *) echo "http://$PUB:8080/$1/page" ;; esac; }

for c in "$@"; do
  name=tn24s6-runner-$c
  # 與正式部署相同，workspace 是 bind mount（overlay 上的目錄改名會 EXDEV）。內容是 git 追蹤的
  # workspace/，再放入 v2.37.0 出貨的舊版 web-reading，讓容器啟動時走一次雜湊相符才換新（SCN-008）。
  ws="$OUT/$c-workspace"; rm -rf "$ws"; mkdir -p "$ws"
  git -C "$REPO" archive HEAD workspace | tar -x -C "$ws" --strip-components=1
  mkdir -p "$ws/.opencode/skills/web-reading"
  cp "$REPO/tests/fixtures/legacy-web-reading/SKILL.md" "$ws/.opencode/skills/web-reading/SKILL.md"
  docker run -d --name "$name" --init --user 1000:1000 \
    --security-opt no-new-privileges:true --cap-drop ALL --pids-limit 1024 --memory 2g \
    --network tn24s6-pub \
    -e TZ=Asia/Taipei -e APP_PROJECT_DIR=/app -e DB_PATH=/app/data/moltbot.db -e DB_DIR=/app/data \
    -e RUNNER_MODE=standalone -e RUNNER_PORT=8787 \
    -e MEMORIA_SYNC_ENABLED=false -e MEMORIA_HOOK_QUEUE_ENABLED=false \
    -e OPENCODE_YOLO=1 -e OPENCODE_SKILLS_DIRS=/app/workspace/.opencode/skills,/home/node/.config/opencode/skills \
    -v "$OUT/ai-config.yaml":/app/ai-config.yaml:ro -v "$REPO/skills":/app/skills:ro \
    -v "$ws":/app/workspace -v "$REPO/AGENTS.md":/app/workspace/AGENTS.md:ro -v "$DIR":/probe:ro -v "$OUT":/out \
    --entrypoint bash "$IMAGE" -c "node scripts/sync-skills.mjs > /out/$c-sync.log 2>&1 && exec node dist/runner.js > /out/$c-runner.log 2>&1" >/dev/null
  docker network connect tn24s6-priv "$name"
  for _ in $(seq 60); do
    docker exec "$name" node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break
    sleep 1
  done
  docker exec -d "$name" bash -c "echo \$\$ > /out/$c-sampler.pid; exec node /probe/sampler.mjs /out/$c-proc.jsonl"
  sleep 1
  if [ "$c" = control ]; then
    docker exec "$name" bash /probe/control.sh "$PUB" > "$OUT/control-steps.jsonl" 2>&1 || true
  else
    mode=normal; [ "$c" = s5 ] && mode=cancel
    docker exec -w /app "$name" node /probe/client.mjs "$mode" "$(url_of "$c")" "${PROMPT_MODE:-raw}" > "$OUT/$c-client.json" || true
  fi
  # SCN-005 的收尾窗口是 wrapper 啟動後 45 秒；wrapper 一定在回合結束前啟動，所以等到結束後 45 秒。
  sleep 45
  docker exec "$name" bash -c "kill -TERM \$(cat /out/$c-sampler.pid)"
  sleep 1
  if [ "$c" != control ]; then
    docker exec -w /app/workspace "$name" opencode session list --format json > "$OUT/$c-sessions.json" 2>/dev/null || true
    sid=$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((s[0]||{}).id||"")}catch{}' "$OUT/$c-sessions.json")
    [ -n "$sid" ] && docker exec -w /app/workspace "$name" opencode export "$sid" > "$OUT/$c-session.json" 2>/dev/null || true
  fi
  docker inspect -f '{{.Image}}' "$name" > "$OUT/$c-image.txt"
  { sha256sum "$ws/.opencode/skills/web-reading/SKILL.md" | cut -c1-64; ls "$ws/.opencode/retired-skills" 2>/dev/null; } > "$OUT/$c-skill.txt"
  docker rm -f "$name" >/dev/null
  echo "done $c"
done
