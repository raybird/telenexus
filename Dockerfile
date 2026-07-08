# ==========================================
# Stage 1: Builder (Compilers & Build Tools)
# ==========================================
FROM node:22-slim AS builder

WORKDIR /app

# 安裝建置依賴 (僅在建置階段存在)
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ==========================================
# Stage 2: Runtime (Production Environment)
# ==========================================
FROM node:22-slim

WORKDIR /app

ARG APP_GIT_SHA=unknown
ARG APP_BUILD_TIME=unknown

ENV HOME=/home/node

# 安裝執行時依賴
# 保留 python3 (許多 MCP 需要), curl/jq/bash (工具與除錯)
# make/g++ 供 better-sqlite3 等原生 addon 編譯 (Memoria 需要)
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 python3-venv curl jq bash git unzip \
  make g++ \
  gosu \
  libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libcups2 \
  libxkbcommon0 libasound2 libgbm1 libcairo2 libpango-1.0-0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libatspi2.0-0 \
  fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  && rm -rf /var/lib/apt/lists/*

# Puppeteer settings for Docker. Browser runtime is provided by agent-browser.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Production dependencies only. Builder node_modules includes devDependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Install uv (確保 uvx 可用，這是 MCP 必需的)
# 安裝到 /usr/local/bin，讓非 root 的 node 使用者也能取用 (PATH 已含此目錄)
ENV UV_INSTALL_DIR=/usr/local/bin
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# Install global CLI tools (含 pnpm，Memoria 使用)
RUN npm install -g pnpm opencode-ai@1.15.10 mcp-memory-libsql agent-browser \
  && npm cache clean --force
RUN agent-browser install

# 從 Builder 階段複製編譯好的檔案
COPY --from=builder /app/dist ./dist

# 複製 workspace 和腳本
COPY workspace ./workspace
COPY --from=builder /app/scripts ./scripts
COPY debug-container.sh ./
RUN chmod +x debug-container.sh

ENV NODE_ENV=production
ENV APP_PROJECT_DIR=/app
ENV APP_GIT_SHA=$APP_GIT_SHA
ENV APP_BUILD_TIME=$APP_BUILD_TIME

# ==========================================
# 非 root 執行：以 root 啟動 entrypoint，runtime 依 PUID/PGID 對齊 node 使用者後
# gosu 降權執行。預建映像 (GHCR) 因此可在任意 host 帳號下使用，
# bind mount 寫出的檔案在 host 上即為該帳號所有，不以 root 污染 workspace/data。
# ==========================================
# 預先建立 opencode 全域設定與認證目錄並交給 node 持有；
# 這些路徑掛載 named volume 時會以 node 的 ownership 初始化。
RUN mkdir -p \
      /app/data /app/workspace \
      /home/node/.config/opencode/skills \
      /home/node/.local/share/opencode \
  && chown -R node:node /app /home/node

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
