#!/usr/bin/env bash
# issue 0024 步驟 1：建立拋棄式網路與容器，執行 probe.sh，最後全部移除。
# 用法：run-probe.sh <probe-scripts 目錄> <解開的 moli 目錄> <輸出目錄>
set -euo pipefail
SCRIPTS=$1 MOLI_DIR=$2 OUT=$3
IMAGE=${IMAGE:-ghcr.io/raybird/telenexus:v2.37.0}
mkdir -p "$OUT"
cleanup() {
  docker rm -f tn24-fixture tn24-probe >/dev/null 2>&1 || true
  docker network rm tn24-pub tn24-priv >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
# 45.67.89.0/24 不在任何保留網段，用來代表「公開位址」；tn24-priv 用 Docker 預設的 RFC1918 網段。
docker network create --subnet 45.67.89.0/24 tn24-pub >/dev/null
docker network create tn24-priv >/dev/null
docker run -d --name tn24-fixture --network tn24-pub --ip 45.67.89.10 \
  -v "$SCRIPTS":/probe:ro --entrypoint node "$IMAGE" /probe/fixture-server.mjs >/dev/null
docker network connect --alias memoria tn24-priv tn24-fixture
PRIV_IP=$(docker inspect -f '{{(index .NetworkSettings.Networks "tn24-priv").IPAddress}}' tn24-fixture)
docker create --name tn24-probe --init --user 1000:1000 \
  --security-opt no-new-privileges:true --cap-drop ALL --pids-limit 1024 --memory 2g \
  --network tn24-pub \
  -e PUB_IP=45.67.89.10 -e PRIV_IP="$PRIV_IP" -e SVC=memoria \
  -v "$SCRIPTS":/probe:ro -v "$MOLI_DIR":/opt/moli-probe:ro -v "$OUT":/out \
  --entrypoint bash "$IMAGE" /probe/${PROBE:-probe.sh} >/dev/null
docker network connect tn24-priv tn24-probe
docker start -a tn24-probe
echo "PRIV_IP=$PRIV_IP" > "$OUT/env.txt"
