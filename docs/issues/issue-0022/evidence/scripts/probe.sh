#!/bin/sh
# issue 0022 步驟 1:在 telenexus 映像內比較三組 opencode run,看 mcp-memory-libsql 有沒有被啟動。
# 用法(主機):docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v <本目錄>:/scripts:ro \
#   --entrypoint sh <映像> /scripts/probe.sh
set -u
P=/tmp/probe
rm -rf "$P"; mkdir -p "$P"
node /scripts/mock-upstream-ok.mjs >"$P/upstream.log" 2>&1 &
UP=$!
sleep 1

provider='"provider":{"mock":{"npm":"@ai-sdk/openai-compatible","name":"Mock","options":{"baseURL":"http://127.0.0.1:18427/v1","apiKey":"mock"},"models":{"ok":{"name":"ok"}}}}'
legacy_mcp='"mcp":{"mcp-memory-libsql":{"type":"local","command":["node","/scripts/fake-mcp.mjs","libsql"],"enabled":true,"environment":{"MARKER_DIR":"MARKERS"}}}'
disable='{"mcp":{"mcp-memory-libsql":{"enabled":false},"other":{"type":"local","command":["node","/scripts/fake-mcp.mjs","other"],"enabled":true,"environment":{"MARKER_DIR":"MARKERS"}}}}'

# 完整條目:帶 type 與 command,避免新部署出現 "Ignoring MCP config entry without type"
disable_full='{"mcp":{"mcp-memory-libsql":{"type":"local","command":["mcp-memory-libsql"],"enabled":false},"other":{"type":"local","command":["node","/scripts/fake-mcp.mjs","other"],"enabled":true,"environment":{"MARKER_DIR":"MARKERS"}}}}'

run_group() {
  g=$1; legacy=$2; inline=$3
  w="$P/$g/workspace"; m="$P/$g/markers"
  mkdir -p "$w/.opencode" "$m"
  if [ "$legacy" = yes ]; then
    printf '{%s,%s}\n' "$provider" "$(echo "$legacy_mcp" | sed "s#MARKERS#$m#")" >"$w/.opencode/opencode.json"
  else
    printf '{%s}\n' "$provider" >"$w/.opencode/opencode.json"
  fi
  if [ -n "$inline" ]; then
    export OPENCODE_CONFIG_CONTENT="$(echo "$inline" | sed "s#MARKERS#$m#g")"
  else
    unset OPENCODE_CONFIG_CONTENT
  fi
  (cd "$w" && timeout 120 opencode run --format json --print-logs --log-level ERROR --model mock/ok "Reply with exactly: OK" \
    </dev/null >"$P/$g/stdout.jsonl" 2>"$P/$g/stderr.log")
  code=$?
  text=$(grep -o '"text":"[^"]*"' "$P/$g/stdout.jsonl" | head -3 | tr '\n' ' ')
  errors=$(grep -c '"type":"error"' "$P/$g/stdout.jsonl")
  echo "== $g legacy=$legacy inline=$( [ -n "$inline" ] && echo yes || echo no )"
  echo "exit=$code text=[$text] error_events=$errors"
  echo "markers: $(ls "$m" | sed 's/-[0-9]*$//' | sort | uniq -c | tr '\n' ' ')"
  echo "stderr (前 5 行):"; head -5 "$P/$g/stderr.log" | cut -c1-240
}

opencode --version
run_group A yes ""
run_group B yes "$disable"
run_group C no "$disable"
run_group D yes "$disable_full"
run_group E no "$disable_full"
echo "== upstream requests: $(grep -c ' POST ' "$P/upstream.log")"
kill $UP 2>/dev/null
