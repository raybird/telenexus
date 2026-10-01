#!/usr/bin/env bash
# 用法: verify.sh <標籤> <映像> <工作目錄> <輸出目錄>
# 啟動隔離的 agent-runner,等啟動時的健康探針結束後,各打一次 /run 與 /run/stream,
# 把原始回應與 runner 寫出的狀態檔收進輸出目錄,最後移除容器。
# (執行當時 step5-run-runner.sh 的檔名是 run-runner.sh;提交後改成現在的檔名,內容相同。)
set -uo pipefail
label="$1"; image="$2"; work="$3"; out="$4"
here="$(cd "$(dirname "$0")" && pwd)"
name="tn0008-$label"
mkdir -p "$out"; rm -rf "$work"
"$here/step5-run-runner.sh" "$name" "$image" "$work" >/dev/null
post() { docker exec "$name" sh -c "curl -s -m 170 -X POST http://localhost:8787$1 -H 'Content-Type: application/json' -H \"x-runner-token: \$RUNNER_SHARED_SECRET\" -d '{\"task\":\"chat\",\"input\":\"Reply with exactly: PONG-0008\"}'"; }
{
  echo "image=$image"
  echo "opencode_version=$(docker exec "$name" opencode --version)"
  for i in $(seq 1 30); do code=$(docker exec "$name" sh -c 'curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/health' 2>/dev/null); [ "$code" = 200 ] && break; sleep 1; done
  echo "health_http=$code after_seconds=$i"
  # 等啟動時的健康探針寫出狀態檔,避免探針與請求同時進行(見 TBD-4)。
  for i in $(seq 1 90); do [ -f "$work/data/model-health-state.runner.json" ] && break; sleep 1; done
  echo "startup_probe_finished_after_seconds=$i"
} > "$out/meta.txt"
post /run > "$out/run-response.json"
post /run/stream > "$out/run-stream-response.sse"
sleep 2
cp "$work/data/model-health-state.runner.json" "$out/" 2>/dev/null
for f in events.jsonl runner-audit.log runner-status.md error-summary.md; do cp "$work/workspace/context/$f" "$out/" 2>/dev/null; done
docker logs "$name" > "$out/container.log" 2>&1
docker rm -f "$name" >/dev/null
rm -rf "$work"
