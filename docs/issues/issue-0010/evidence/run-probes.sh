#!/usr/bin/env bash
# 2026-10-04：僅建立 issue10 唯一命名的拋棄式探測容器，不掛正式資料。
set -eu
probe_dir="$(cd "$(dirname "$0")" && pwd)"
base='ghcr.io/raybird/telenexus@sha256:4fd13c3bbdcc1e6f2dd8cb37cbbdaae3a8c48287928d59c63fa36db2630d8236'
common=(--detach --network none --cap-drop ALL --security-opt no-new-privileges --user node --mount "type=bind,src=$probe_dir,dst=/probe,readonly" --entrypoint node)
case "${1:?control 或 mcp}" in
  control)
    docker run "${common[@]}" --name issue10-no-init-control-20261004 --memory 256m --pids-limit 64 "$base" /probe/orphan-control.mjs
    docker run "${common[@]}" --init --name issue10-init-control-20261004 --memory 256m --pids-limit 64 "$base" /probe/orphan-control.mjs
    ;;
  mcp)
    docker build --tag issue10-mcp-probe:20261004 --file "$probe_dir/Dockerfile.probe" "$probe_dir"
    mode="${2:?eof、kill、stopped-chrome、kill-mcp、client-eof 或 kill-launcher-stopped}"
    name="${3:?明確 issue10 容器名}"
    case "$name" in issue10-*-20261004) ;; *) exit 2 ;; esac
    options=()
    if [ "${ISSUE10_NO_SANDBOX:-0}" = 1 ]; then options+=(--env ISSUE10_NO_SANDBOX=1); fi
    if [ "${ISSUE10_LAUNCHER:-0}" = 1 ]; then options+=(--env ISSUE10_LAUNCHER=1); fi
    docker run "${common[@]}" --init --name "$name" --memory 2g --pids-limit 1024 "${options[@]}" issue10-mcp-probe:20261004 /probe/mcp-contract.mjs "$mode"
    ;;
  *) exit 2 ;;
esac
