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
RUN npm install
COPY . .
RUN npm run build

# ==========================================
# Stage 2: Runtime (Production Environment)
# ==========================================
FROM node:22-slim

WORKDIR /app

ARG APP_GIT_SHA=unknown
ARG APP_BUILD_TIME=unknown

# 安裝執行時依賴
# 保留 python3 (許多 MCP 需要), curl/jq/bash (工具與除錯), chromium (Puppeteer)
# make/g++ 供 better-sqlite3 等原生 addon 編譯 (Memoria 需要)
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 python3-venv curl jq bash git unzip \
  make g++ \
  chromium \
  fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  && rm -rf /var/lib/apt/lists/*

# Puppeteer settings for Docker
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install uv (確保 uvx 可用，這是 MCP 必需的)
# 安裝到 /usr/local/bin，讓非 root 的 node 使用者也能取用 (PATH 已含此目錄)
ENV UV_INSTALL_DIR=/usr/local/bin
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# Install global CLI tools (含 pnpm，Memoria 使用)
RUN npm install -g pnpm opencode-ai@1.15.10 mcp-memory-libsql agent-browser
RUN agent-browser install

# 從 Builder 階段複製編譯好的檔案
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
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
# 非 root 執行：使用 node 映像內建的 node 使用者 (UID/GID = 1000)
# 與 host 的 raybird (1000) 對齊，bind mount 寫出的檔案在 host 上即為 raybird:raybird，
# 不再以 root 污染 host workspace/data。
# ==========================================
ENV HOME=/home/node
# 預先建立 opencode 全域設定與認證目錄並交給 node 持有；
# 這些路徑掛載 named volume 時會以 node 的 ownership 初始化。
RUN mkdir -p \
      /app/data /app/workspace \
      /home/node/.config/opencode/skills \
      /home/node/.local/share/opencode \
  && chown -R node:node /app /home/node
USER node

CMD ["npm", "start"]
