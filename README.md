<p align="center">
  <img src="docs/logo.png" alt="TeleNexus Logo" width="200" />
</p>

# TeleNexus

> 您的私人本地 AI 助理閘道器（Telegram -> Local CLI Agent）

TeleNexus 讓您用 Telegram 控制本機 AI CLI（Gemini / Opencode），並提供排程、記憶、觀測與 runner 架構。

---

## TL;DR（5 分鐘上手）

### 1) 準備環境變數

- 複製 `.env.example`（開發）或 `.env.production.example`（保守上線）
- 最低必要：

```env
TELEGRAM_TOKEN=your_bot_token
ALLOWED_USER_ID=your_telegram_user_id
DB_DIR=./data
```

### 2) 啟動雙服務

```bash
docker compose up -d --build
```

### 3) 確認服務狀態

```bash
docker compose ps
docker compose logs -f telenexus
```

### 4) 打開 Web Console（預設啟用）

- `http://127.0.0.1:3030`

---

## 你會得到什麼

- 單人白名單模型（`ALLOWED_USER_ID`）
- 動態 provider（Gemini / Opencode，`ai-config.yaml` 控制）
- 排程系統（新增、刪除、重載、健康檢查）
- 雙服務標準架構（`telenexus` + `agent-runner`）
- `workspace/context/` 觀測快照（runtime/provider/scheduler/error/runner）
- 內建常用基礎工具（`git`、`unzip`）減少臨時繞道

---

## 最常用操作

### 排程（Docker 內）

```bash
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js list
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js add "每小時報告" "0 * * * *" "請提供簡單市場分析"
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js reload
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js health
```

### Runner 健康檢查

```bash
docker compose exec telenexus node -e "fetch('http://agent-runner:8787/health').then(r=>r.json()).then(console.log)"
```

---

## Session 與 Context（重點）

- 預設聊天流量走 `agent-runner`（`CHAT_USE_RUNNER_PERCENT=100`）
- 一般情況不需手動進容器，系統會自動接續 session
- 若要人工除錯並接續同一條 CLI context，請優先進 `agent-runner`

```bash
# Gemini（接續 session）
docker compose exec agent-runner sh -lc "cd /app/workspace && gemini -r"

# Opencode（接續 session）
docker compose exec agent-runner sh -lc "cd /app/workspace && opencode run -c"
```

補充：

- `/new` 會讓下一則一般對話訊息強制使用新 session（不接續）
- `/send_file 路徑 | 說明` 可把專案目錄內檔案回傳到 Telegram（例如 `/send_file workspace/context/runner-status.md | 最新 runner 狀態`）
- 也可在一般對話要求 AI 直接回傳檔案；AI 會透過 `[[SEND_FILE: workspace/temp/檔名 | 說明]]` 協議觸發附件傳送（自動模式僅允許 `workspace/temp/`）
- 一般對話的記憶檢索由 TeleNexus 在分派前統一注入，與 provider hook 解耦
- passthrough 指令（如 `/compress`）仍維持直通 CLI，不額外包裝 TeleNexus 一般 prompt
- 預設啟用 Memoria 自動同步（auto 模式）：每次成功對話會背景呼叫 `workspace/Memoria/cli sync`
- 在 `telenexus` 容器手動跑 CLI，可能與 runner 的實際執行脈絡不同

Memoria 同步可用環境變數調整：

- `MEMORIA_SYNC_ENABLED=auto|on|off`（預設 `auto`）
- `MEMORIA_HOME`（預設 `/app/workspace/Memoria`）
- `MEMORIA_CLI_PATH`（預設 `$MEMORIA_HOME/cli`）
- `MEMORIA_SYNC_TIMEOUT_MS`（預設 `20000`）
- `MEMORIA_HOOK_QUEUE_ENABLED`（預設 `false`，hook-free 模式）
- `SEND_FILE_STRICT_TEMP_ONLY=true|false`（預設 `false`；設為 `true` 時連 `/send_file` 也僅允許 `workspace/temp/`）
- `MEMORIA_HOOK_QUEUE_FILE`（僅在啟用 hook queue 時使用）
- `MEMORIA_HOOK_FLUSH_SIGNAL`（僅在啟用 hook queue 時使用）
- `MEMORIA_HOOK_QUEUE_POLL_MS`（僅在啟用 hook queue 時使用）
- `TELEGRAM_LAUNCH_RETRY_BASE_MS` / `TELEGRAM_LAUNCH_RETRY_MAX_MS`（Telegram 啟動重試參數）
- `OPENCODE_VERBOSE_STDERR=true`（需要完整 stderr 除錯時再開）

---

## 文件導覽

- 文件入口：`docs/README.md`
- Web Console 詳細說明：`docs/web-console-reference.md`
- 環境變數與 Runner 設定：`docs/configuration-reference.md`
- 排程 runbook：`docs/scheduler-operation-runbook.md`
- 邊界與安全：`docs/runtime-boundary-and-security.md`
- 部署 checklist：`docs/deployment-cutover-checklist.md`
- 遷移紀錄：`docs/migration-log.md`

---

## 本機開發

```bash
npm run dev
npm run dev:runner
npm run build
npm run lint
```

---

## 免責聲明

本專案支援高權限 Agent 操作流程。請務必妥善保護：

- `TELEGRAM_TOKEN`
- `RUNNER_SHARED_SECRET`
- `ALLOWED_USER_ID`
