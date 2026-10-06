#!/usr/bin/env bash
# 用法: run.sh <標籤> <opencode run 的額外參數...> -- <prompt>
# 在隔離容器內以 node 身分、/app/workspace 為 cwd 執行 opencode run，存下原始事件與摘要。
out="$OUT/$1"; shift
args=(); while [ "$1" != "--" ]; do args+=("$1"); shift; done; shift
docker exec -u node -w /app/workspace i12-probe opencode run --format json --model opencode/big-pickle "${args[@]}" "$*" >"$out.jsonl" 2>"$out.stderr"
code=$?
sid=$(grep -o '"sessionID":"[^"]*"' "$out.jsonl" | sort -u | tr '\n' ' ')
txt=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);let t="";let e="";for(const x of l){try{const j=JSON.parse(x);if(j.type==="text")t+=j.part?.text??"";if(j.type==="error")e=JSON.stringify(j.error).slice(0,200)}catch{}}console.log("text="+JSON.stringify(t.slice(0,120))+(e?" error="+e:""))' "$out.jsonl")
echo "exit=$code sessions=[$sid] $txt lines=$(wc -l <"$out.jsonl") stderr_bytes=$(wc -c <"$out.stderr")"
