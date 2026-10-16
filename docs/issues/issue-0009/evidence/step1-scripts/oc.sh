#!/bin/bash
# 拋棄式容器：只掛資料庫複本，不帶 auth、不發佈 port、不碰任何運行中的部署。
# 用法：S=<repo 之外的暫存目錄> ./oc.sh <entrypoint> [args...]
# $S/data 放 opencode.db 複本與 storage/，$S/work 放本目錄的腳本。
docker run --rm -i --entrypoint "$1" -u 1000:1000 -e HOME=/home/node -w /app \
  -v "$S/data:/home/node/.local/share/opencode" -v "$S/work:/work" \
  ghcr.io/raybird/telenexus:v2.29.0 "${@:2}"
