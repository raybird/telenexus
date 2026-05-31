# ==========================================================================
# Memoria 記憶服務 — 直接由 npm 安裝官方套件,不依賴任何 source checkout。
# 資料 (MEMORIA_HOME=/data) 走容器的 named volume,與主程式碼/host 帳號完全隔離。
# ==========================================================================
FROM node:22-slim

# 追 1.x minor line;升級主版本需手動改這裡。better-sqlite3 帶 prebuilt binary,免裝編譯器。
RUN npm install -g @raybird.chen/memoria@^1.11

ENV HOME=/home/node \
    MEMORIA_HOME=/data \
    MEMORIA_PORT=3917 \
    TZ=Asia/Taipei

# 可攜性:允許用 PUID/PGID 對齊任意 host 帳號 (預設 1000),與主服務一致。
ARG PUID=1000
ARG PGID=1000
RUN if [ "$PGID" != "1000" ]; then groupmod -g "$PGID" node; fi \
  && if [ "$PUID" != "1000" ]; then usermod -u "$PUID" -g "$PGID" node; fi

# 非 root 執行:沿用 node 映像內建的 node 使用者,與主服務一致。
RUN mkdir -p /data && chown -R node:node /data /home/node
USER node

EXPOSE 3917

# serve 啟動時 initDatabase() 會自動建表並向後相容升級既有 DB。
CMD ["memoria", "serve"]
