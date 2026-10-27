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
- Status 頁會額外顯示 `memory-status.md`，可用來觀察 archive gap
- `memory-status.md` 與 `GET /api/memory-health` 是同一份報告。`archive.source` 是 `local`（有設定 `MEMORIA_ARCHIVE_DB` / `MEMORIA_HOME`，或預設路徑存在）或 `remote`（官方 Compose 的拆分部署，本服務不讀 memoria 的 volume）；`archive.status` 是 `ok` / `unavailable` / `error`，原因寫在 `archive.detail`。封存沒讀到時，封存統計與 `estimatedGapRecent24h` 是 `null`（markdown 顯示 `unknown`），不是 0
- 本機的運作資料庫（`operational`，`moltbot.db`）也有 `status`（`ok` / `unavailable` 檔案不存在 / `error` 檔案在但讀不了）與 `detail`。不是 `ok` 時，該區塊的數字是 `null`（markdown 顯示 `unknown`），`estimatedGapRecent24h` 也是 `null`。讀不了只寫在報告裡，不記 runtime issue
- 報告只有運作資料庫與封存兩個區塊。`data/memory.db` 的檢索、回填與一致性區塊已隨 issue 0022 移除，`memory.db` 存在時也不讀；`GET /api/memory-backfill/report` 回 404
- `memoria-status.md` 的「Recall Metrics by Version」是聊天召回依 TeleNexus 版本的彙總，資料在 `moltbot.db`，跨重啟累積、保留 30 天；上方的「Recall Telemetry」只有記憶體裡最近 50 筆，重啟就歸零。這一節列出目前版本，以及保留期內最近的前一個版本，用來比較升級前後：
  - `Recalls` 是召回次數，含失敗。它計的是召回，不是訊息：接續的 session 失效、改開新 session 時，同一則訊息會重新組 prompt 而召回兩次。
  - `Hit Rate` 是 Memoria 有回傳結果的比例。
  - `Injected Rate` 是結果實際交給 prompt 組裝的比例：被注入判準丟棄的不算，包括信心低於 `MEMORIA_RECALL_MIN_CONFIDENCE`，以及內容 token 不到 2 個（issue 0019）。
  - `Degraded Rate` 是語意索引退回字面召回的比例。
  - 三個比例的分母都是成功的召回次數，失敗另列。成功少於 20 次時顯示 `unknown` 並附 n，不顯示成 0%；讀取資料庫失敗時顯示 `Status: error` 與原因。
  - 遷移舊記憶的時間點不會自動標出，請以升級後的版本為界比較。
- `workspace/context/` 的各個 snapshot 各自產生、各自寫入：其中一個失敗時它保留上一次的內容，其他照常更新。某個 snapshot 由成功轉為失敗時記一次 `context-snapshot:<檔名>` runtime issue（會出現在 `error-summary.md`），持續失敗不重複記，恢復時 log 印一行「已恢復更新」。這個訊號預設不會推 Telegram 告警：ErrorAlerter 要同一個 scope 在時間窗內累積到門檻（預設 10 分鐘 3 次），而每個 snapshot 每次轉為失敗只記 1 筆。整個 context 目錄寫不進去時（例如權限錯誤），`error-summary.md` 本身也不會更新，要看服務 log 的 `[System] Failed to write context snapshot`，或 `runtime_issues` 資料表

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
