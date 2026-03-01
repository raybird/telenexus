# Scheduler 操作手冊（Docker 版）

## 📅 建立日期

2026-02-07

## 1) 目標

- 確保排程新增/刪除/查詢在 Docker 環境行為一致。
- 避免「資料庫已更新，但主程序未載入」的常見陷阱。

## 2) 核心原則

- 產品主路徑：優先使用 Telegram 指令（`/add_schedule`、`/remove_schedule`、`/list_schedules`）。
- 維運工具路徑：`scheduler-cli` 僅做維護/除錯。
- 容器操作規則：
  - `docker compose exec telenexus ...`：進入既有主程序容器（推薦）。
  - `docker compose run --rm telenexus ...`：一次性新容器（不保證可通知既有主程序）。

## 3) 日常操作

### 3.1 查詢排程

```bash
docker compose exec telenexus node dist/tools/scheduler-cli.js list
```

### 3.1b 查詢排程健康標記

```bash
docker compose exec telenexus node dist/tools/scheduler-cli.js health
```

### 3.2 新增排程（維運用）

```bash
docker compose exec telenexus node dist/tools/scheduler-cli.js add "每小時報告" "0 * * * *" "請提供簡單市場分析"
```

### 3.3 刪除排程（維運用）

```bash
docker compose exec telenexus node dist/tools/scheduler-cli.js remove 3
```

### 3.4 更新排程（維運用）

```bash
docker compose exec telenexus node dist/tools/scheduler-cli.js update 3 "每小時市場報告" "0 * * * *" "請提供最新市場分析重點"
```

建議操作順序：

1. 先 `list` 確認 ID。
2. 執行 `update`（一次更新 name/cron/prompt）。
3. 觀察 `health` 與 log 確認 reload 生效。

## 4) 新增後的驗證步驟（必做）

1. 查詢 DB/清單：確認排程存在且啟用。
2. 看主服務 log：確認有 reload 與 job 掛載訊息。
3. 用 `scheduler-cli health` 確認 `Last Reload` 已更新。
4. 到下一個觸發點：確認收到排程推送。

若是「更新」操作，請額外確認：

- 舊 cron 時間點不再觸發。
- 新 cron 時間點正常觸發。
- 更新瞬間若剛好命中舊觸發窗，可能會多跑一次舊任務（短暫 race，非長期疊加）。

建議關鍵 log 關鍵字：

- `Received SIGUSR1`
- `Reloading schedules from database`
- `Started job #<id>`
- `Triggered: "<name>"`

## 5) 常見故障與排除

### 症狀 A：排程在 list 看得到，但不會觸發

可能原因：

- 排程由 `docker compose run` 新容器寫入 DB，未成功通知主程序 reload。

處理方式：

- 先改用 Telegram 指令重建，或使用 `exec` 在既有容器操作。
- 必要時重啟主服務，讓啟動流程重新載入所有 active schedules。

### 症狀 B：顯示 warning `Could not notify main process`

可能原因：

- PID 探測不到主程序或 signal 發送失敗。

處理方式：

- 在既有容器內執行 `pgrep -af "dist/main.js|tsx.*src/main.ts"`。
- 確認主程序存在後，再以 `exec` 重試 CLI 操作。

### 症狀 C：時間到了仍沒收到訊息

可能原因：

- cron/時區設定、AI provider timeout、429 容量限制、Telegram 發送失敗。

處理方式：

- 依序檢查 timezone、provider 狀態、log 中 timeout/429、Telegram error。

### 症狀 D：聊天正常，但排程常被判定失敗（或反過來）

處理方式：先產生執行對照報表，再看細節 logs。

```bash
# 最近 24 小時（預設也會寫入 workspace/context/execution-compare.md）
npm run report:compare:24h

# 自訂時間窗
npm run report:compare -- --since "2026-02-28T20:00:00+08:00" --until "2026-02-28T21:00:00+08:00"
```

報表會整理：

- chat/scheduler 觸發量與 runner 成功/失敗統計
- provider/model 分佈（含 scheduler/chat 近似拆分）
- runner-audit 的 task/provider/model 組合與 errorType
- 可疑 provider/model 配對（例如 `opencode + gemini-*`）

## 6) 風險控制

- 不建議在生產流程依賴 `scheduler-cli + signal` 當唯一刷新機制。
- 建議保留「啟動即全量載入 active schedules」作為保底。
- 建議新增排程後做自動健康檢查（是否成功掛載 job）。

## 7) 建議後續改進

- 在 `scheduler-cli` 中輸出更明確的錯誤細節（PID、signal errno）。
- 在 orchestrator 提供內部 `reload` API（不靠 OS signal）。
- 增加「排程操作審計事件」與告警。
