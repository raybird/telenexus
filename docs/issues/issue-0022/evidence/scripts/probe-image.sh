#!/bin/sh
# issue 0022 步驟 5:在新映像(已不安裝 mcp-memory-libsql)用真正的舊設定比較兩組 opencode run。
# 注入組的 OPENCODE_CONFIG_CONTENT 取自映像內編譯後的 OpencodeAgent.getEnv()。
# npx 有沒有去取得 mcp-memory-libsql,看各組獨立 HOME 下的 npm 快取(~/.npm/_npx)。
# 用法(主機):docker run --rm --user "$(id -u):$(id -g)" -v <本目錄>:/scripts:ro \
#   --entrypoint sh <映像> /scripts/probe-image.sh
set -u
P=/tmp/probe
rm -rf "$P"; mkdir -p "$P"
echo "global mcp-memory-libsql: $(ls -d /usr/local/lib/node_modules/mcp-memory-libsql 2>/dev/null || echo absent)"
node /scripts/mock-upstream-ok.mjs >"$P/upstream.log" 2>&1 &
UP=$!
sleep 1

legacy='{"$schema":"https://opencode.ai/config.json","provider":{"mock":{"npm":"@ai-sdk/openai-compatible","name":"Mock","options":{"baseURL":"http://127.0.0.1:18427/v1","apiKey":"mock"},"models":{"ok":{"name":"ok"}}}},"mcp":{"mcp-memory-libsql":{"type":"local","command":["npx","-y","mcp-memory-libsql"],"enabled":true,"environment":{"LIBSQL_URL":"file:../data/memory.db"}}}}'

injected=$(cd /app && APP_PROJECT_DIR="$P/app" node --input-type=module -e "
import { OpencodeAgent } from '/app/dist/core/opencode.js';
class A extends OpencodeAgent { e() { return this.getEnv(); } }
delete process.env.OPENCODE_CONFIG_CONTENT;
process.stdout.write(new A().e().OPENCODE_CONFIG_CONTENT);
")
echo "injected mcp keys: $(echo "$injected" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log(Object.keys(c.mcp).join(","), JSON.stringify(c.mcp["mcp-memory-libsql"]))})')"

run_group() {
  g=$1; inline=$2
  home="$P/$g/home"; w="$P/$g/workspace"
  mkdir -p "$home" "$w/.opencode" "$P/$g/data" "$P/app/data"
  echo "$legacy" >"$w/.opencode/opencode.json"
  if [ -n "$inline" ]; then export OPENCODE_CONFIG_CONTENT="$inline"; else unset OPENCODE_CONFIG_CONTENT; fi
  (cd "$w" && HOME="$home" APP_PROJECT_DIR="$P/app" timeout 180 opencode run --format json --print-logs --log-level ERROR --model mock/ok "Reply with exactly: OK" \
    </dev/null >"$P/$g/stdout.jsonl" 2>"$P/$g/stderr.log")
  code=$?
  text=$(grep -o '"text":"[^"]*"' "$P/$g/stdout.jsonl" | head -3 | tr '\n' ' ')
  npx_pkg=$(find "$home/.npm/_npx" -maxdepth 3 -type d -name mcp-memory-libsql 2>/dev/null | wc -l)
  echo "== $g inline=$( [ -n "$inline" ] && echo yes || echo no )"
  echo "exit=$code text=[$text] npx_cache_mcp_memory_libsql=$npx_pkg memory_db_created=$( [ -e "$P/$g/data/memory.db" ] && echo yes || echo no )"
  echo "stderr (前 5 行):"; head -5 "$P/$g/stderr.log" | cut -c1-240
}

opencode --version
run_group N ""
run_group I "$injected"
echo "== upstream requests: $(grep -c ' POST ' "$P/upstream.log")"
kill $UP 2>/dev/null
