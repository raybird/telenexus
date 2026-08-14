# ==========================================================================
# Memoria 記憶服務 — 直接由 npm 安裝官方套件,不依賴任何 source checkout。
# 資料 (MEMORIA_HOME=/data) 走容器的 named volume,與主程式碼/host 帳號完全隔離。
# ==========================================================================
FROM node:22-slim

# 釘死確切版本:浮動 range 會讓同一個 TeleNexus tag 在不同時間建出不同的 Memoria
# (v2.22.0 映像實測是 1.20.0,不是當時的 latest),升級一律改這行。
# better-sqlite3 帶 prebuilt binary,免裝編譯器。
RUN npm install -g @raybird.chen/memoria@1.27.1

ENV HOME=/home/node \
    MEMORIA_HOME=/data \
    MEMORIA_PORT=3917 \
    TZ=Asia/Taipei

# 非 root 執行:沿用 node 映像內建的 node 使用者 (UID 1000),與主服務一致。
# 資料只在 named volume (/data),沒有 host bind mount,不需要 PUID/PGID 對齊。
RUN mkdir -p /data && chown -R node:node /data /home/node
USER node

EXPOSE 3917

# serve 啟動時 initDatabase() 會自動建表並向後相容升級既有 DB。
CMD ["memoria", "serve"]
