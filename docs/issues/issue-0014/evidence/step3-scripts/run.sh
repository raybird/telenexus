#!/bin/bash
# 用法：S=<repo 之外的暫存目錄> ./run.sh <before|branch>
# before：映像內建的 /app/dist（v2.30.0，即變更前的程式）；branch：以分支編譯出的 $S/dist 覆蓋 /app/dist。
# 只掛複本與腳本，不帶 auth、不發佈 port。
extra=()
[ "$1" = branch ] && extra=(-v "$S/dist:/app/dist:ro")
docker run --rm -i --entrypoint node -u 1000:1000 -e HOME=/home/node -w /app \
  -v "$S/data:/home/node/.local/share/opencode" -v "$S/work:/work" "${extra[@]}" \
  ghcr.io/raybird/telenexus:v2.30.0 /work/e2e.mjs
