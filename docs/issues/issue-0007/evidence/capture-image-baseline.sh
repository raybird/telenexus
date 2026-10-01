#!/usr/bin/env bash
# 擷取映像的可比對基準:設定、/app 內容、依賴、全域 CLI 與系統套件。
# 重排 Dockerfile 前後各跑一次,兩份輸出 diff 為空才算正式映像等價。
#
# /app/workspace 是建置當下本機工作區的複本,檔名不進版控,這裡只記筆數與彙總雜湊。
# npm 的 log 檔名帶時間戳,每次建置都不同,正規化成 <log> 後計數。
#
# 用法:bash capture-image-baseline.sh <image> > <輸出檔>
set -euo pipefail

image="${1:?usage: capture-image-baseline.sh <image>}"

echo "## config"
docker image inspect "$image" --format '{{json .Config}}' | python3 -c '
import json, sys

config = json.load(sys.stdin)
for key in ("Entrypoint", "Cmd", "WorkingDir", "User"):
    print(f"{key}: {json.dumps(config.get(key))}")
print("Env:")
for entry in sorted(config.get("Env") or []):
    print("  " + entry)
'

# 繞過 entrypoint 以 root 直接讀檔,避免 remap 與 chown 改動被觀察的狀態。
# /home/node 要在任何 npm 指令之前列出:npm 自己會在 ~/.npm/_logs 寫檔。
docker run --rm --entrypoint bash "$image" -c '
set -euo pipefail
export LC_ALL=C

echo
echo "## /home/node (depth 3; npm log names normalized)"
find /home/node -maxdepth 3 -printf "%u:%g %y %p\n" \
  | sed -E "s#(/\.npm/_logs/).+#\1<log>#" | sort -k3 | uniq -c

echo
echo "## /app entries (mode owner type path; node_modules and workspace contents pruned)"
find /app \( -path /app/node_modules -o -path /app/workspace \) -prune -o -printf "%M %u:%g %y %p\n" | sort -k4
find /app/node_modules /app/workspace -maxdepth 0 -printf "%M %u:%g %y %p\n"

echo
echo "## /app file hashes (node_modules and workspace pruned)"
find /app \( -path /app/node_modules -o -path /app/workspace \) -prune -o -type f -print0 \
  | sort -z | xargs -0 sha256sum

echo
echo "## /app/workspace digest"
echo "entries: $(find /app/workspace | wc -l)"
echo "entries sha256: $(find /app/workspace -printf "%M %u:%g %y %p\n" | sort -k4 | sha256sum | cut -d" " -f1)"
echo "contents sha256: $(find /app/workspace -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1)"

echo
echo "## /app dependencies (npm ls --all)"
cd /app && npm ls --all 2>&1

echo
echo "## /app/node_modules/.bin"
ls -1 /app/node_modules/.bin | sort

echo
echo "## global npm packages"
npm ls -g --depth=0 2>&1

echo
echo "## tool versions"
echo "node $(node --version)"
echo "opencode $(opencode --version 2>&1 | head -1)"
echo "uv $(uv --version 2>&1)"
echo "gosu $(gosu --version 2>&1)"

echo
echo "## ownership of runtime paths"
stat -c "%U:%G %a %n" \
  /app /app/data /app/workspace \
  /home/node /home/node/.config/opencode /home/node/.config/opencode/skills \
  /home/node/.local/share/opencode \
  /usr/local/bin/docker-entrypoint.sh /app/debug-container.sh

echo
echo "## entrypoint hash"
sha256sum /usr/local/bin/docker-entrypoint.sh

echo
echo "## system packages"
dpkg-query -W -f "\${Package} \${Version}\n" | sort
'
