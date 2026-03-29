# Web Console Reference

## 入口與路由

- URL：`http://127.0.0.1:3030`
- Hash routes：`#/chat`、`#/memory`、`#/schedules`、`#/status`

## 主要 UX 行為

- Chat 會自動載入 Recent memory 作為上下文
- Chat 與 Memory 採一致對話泡泡樣式（上舊下新）
- Memory 頁面聚焦 `Search + History`（Recent 已整合進 Chat）

## Web 相關環境變數

```env
WEB_ENABLED=true
WEB_BIND=127.0.0.1
WEB_PORT=3030

# 若設定，/api/* 需帶 Authorization: Bearer <token>
WEB_AUTH_TOKEN=

# true 時：來自內網/private IP 的請求可略過 token 驗證
WEB_TRUST_PRIVATE_NETWORK=false

# Dashboard 告警門檻（error count >= N 顯示紅色告警）
WEB_ALERT_ERROR_THRESHOLD=1

# Runner 成功率低於此值 (%) 顯示橘色告警
WEB_ALERT_RUNNER_SUCCESS_WARN_THRESHOLD=80

# 未設定時預設回退 ALLOWED_USER_ID（與 Telegram 共用記憶與排程）
WEB_USER_ID=
```

## API 清單

- `GET /api/health`
- `GET /api/debug/version`（回傳目前容器版本與啟動時間，供除錯）
- `POST /api/chat`
- `POST /api/chat/stream`（SSE: `start` / `status` / `chunk` / `done` / `error`）
- `GET /api/memory/stats`
- `GET /api/memory-health`
- `GET /api/memory-backfill/report`
- `GET /api/memory/recent`
- `GET /api/memory/stream`（SSE: `snapshot` / `update` / `ping`）
- `GET /api/memory/search`
- `GET /api/memory/history?offset=0&limit=20`
- `GET /api/memory/export?format=json|csv`
- `GET /api/schedules`
- `POST /api/schedules`
- `PUT /api/schedules/:id`
- `DELETE /api/schedules/:id`
- `POST /api/schedules/toggle`
- `POST /api/schedules/reload`
- `POST /api/reflect`
- `GET /api/status`

補充：

- cron 採 5 欄位（`minute hour day month weekday`）
- 若啟用 `WEB_AUTH_TOKEN`，前端匯出 URL 會附帶 token 參數
- Status 頁會額外顯示 `memory-status.md`，可用來觀察 archive gap 與 backfill 指標
- Status 頁也會顯示最近幾輪 backfill run 摘要，方便直接抽查候選品質

## 前端實作摘要（Plain Vanilla）

- 純 HTML/CSS/JavaScript（無建置框架）
- ES6 Modules
- keep-alive route：保留 view DOM 與狀態，降低切頁閃爍

主要目錄：

```text
src/web/public/app/
├── main.js          # 啟動與路由
├── services/        # 資料存取層
├── views/           # 頁面渲染與互動
└── utils/           # 共用工具
```

## Build Metadata（可選）

若希望 `/api/debug/version` 回傳實際 git SHA 與 build time，可在 build 時注入：

```bash
APP_GIT_SHA=$(git rev-parse --short HEAD) \
APP_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
docker compose up -d --build
```

或直接使用已自動化腳本（依情境分流）：

```bash
# 日常最快（不 build）
npm run docker:up

# 有程式碼變更需要重建 telenexus
npm run docker:up:build

# 需要 /api/debug/version 帶入 gitSha/buildTime
npm run docker:up:meta
```

相容別名：`npm run docker:up:telenexus`（等同 `docker:up:meta`）。
