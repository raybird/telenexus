## 架構概覽

TeleNexus 目前是一套本地 AI control plane，而不是單純的 Telegram bot。

系統主要由四層組成：

- 互動層：Telegram Bot、Web Console
- 協調層：訊息管線、命令路由、記憶注入、排程
- 執行層：本地 provider 執行與 `agent-runner`
- 觀測層：`workspace/context/` 狀態快照、runner audit、memory intent / prompt telemetry、**錯誤事件持久化 (`runtime_issues` 表) 與 Telegram 主動告警**

## 核心模組

### 入口與協調

- `src/main.ts`
  - 啟動 Telegram connector、MemoryManager、Scheduler、MemoriaSyncBridge、Web server
  - 建立聊天 prompt builder
  - 決定 chat / scheduler 是否改走 runner
- `src/core/message-pipeline.ts`
  - 一般聊天主流程
  - 處理 queue、thinking placeholder、附件合併、prompt 準備、AI 回覆正規化、記憶落盤
- `src/core/command-router.ts`
  - 處理 `/new`、排程類指令、檔案回傳等命令流
- `src/core/message-pipeline-preflight.ts`
  - 命令前置處理、queue 提示、active agent 選擇

### Provider 與執行層

- `src/core/agent.ts`
  - `DynamicAIAgent` 會在每次請求時讀取 `ai-config.yaml`
  - 依設定選擇 Gemini 或 Opencode
  - 可優先走 runner，並在 runner 失敗時 fallback 到本地執行
  - 內建 runner circuit breaker、passthrough command 改寫
- `src/core/gemini.ts`
  - 封裝 Gemini CLI 呼叫
- `src/core/opencode.ts`
  - 封裝 Opencode CLI 呼叫
- `src/runner.ts`
  - `agent-runner` HTTP 服務
  - 接收 `/run` 任務，實際執行 chat / summarize
  - 維護 runner audit 與 runner status

### 記憶與長期脈絡

- `src/core/memory.ts`
  - SQLite 訊息儲存、history、summary、search、schedule source of truth
- `src/prompt/builder.ts`
  - 建立 full / compact prompt
  - 組 recent history、SAR anchors、semantic summaries
- `src/core/prompt-build.ts`
  - 決定 full / compact / minimal prompt 模式
  - 控制 compact prompt 是否注入 memory context
- `src/core/memoria-sync.ts`
  - 對話成功後背景同步 Memoria CLI
  - 提供 hook queue 與 hook-free 模式
- `src/services/memory-backfill-worker.ts`
  - 針對 sessions archive 做 backfill / dry-run 掃描

### 排程與 Web

- `src/core/scheduler.ts`
  - 管理使用者 schedule、系統排程、silence reflection
  - 排程輸出同樣會寫入記憶並可 enqueue Memoria sync
- `src/web/server.ts`
  - 提供 chat、memory、schedule、status API
  - 提供 SSE stream 與靜態 Web Console
- `src/web/public/app/*`
  - 純 vanilla JS 的前端頁面與資料服務

### 可觀測性

- `src/services/context-snapshots.ts`
  - 定期寫出 runtime/provider/scheduler/error/memory/memoria/prompt session 快照
- `src/services/prompt-session-telemetry.ts`
  - 記錄 prompt 長度、memory 注入量、prompt mode
- `src/services/memory-intent-telemetry.ts`
  - 記錄模型輸出的 `[[MEMORY_INTENT:...]]` 結構化觀測
- `src/services/issue-store.ts`
  - 將 `recordRuntimeIssue` 事件寫入 SQLite `runtime_issues` 表（7 天保留、每 6h 清理）
  - 提供 `Past 24h by Scope` 與 `Rate-limit Issues (24h)` 給 `error-summary.md`
- `src/services/error-alerter.ts`
  - 滑動視窗統計 per scope 錯誤頻率，超過閾值即推 Telegram 給 `ALLOWED_USER_ID`
  - 環境變數：`ERROR_ALERT_THRESHOLD` / `ERROR_ALERT_WINDOW_MS` / `ERROR_ALERT_COOLDOWN_MS`

## 主要資料流

### 1. 一般聊天

1. 使用者從 Telegram 或 Web Console 發送訊息
2. 訊息被轉成 `UnifiedMessage`
3. `CommandRouter` 先處理命令型輸入；未命中才進一般聊天
4. `message-pipeline` 寫入 user message，決定 prompt mode
5. `buildPrompt` 視情況注入 memory context 與 Memoria capability hint
6. `DynamicAIAgent` 依 `ai-config.yaml` 選 provider，並決定走 runner 或 local
7. 回覆經正規化後送回 connector，並持久化到記憶
8. 成功回合可觸發 memory intent telemetry、prompt session telemetry、Memoria sync

### 2. 排程任務

1. `Scheduler` 從 SQLite 載入啟用中的 schedules
2. Cron 觸發後組裝排程 prompt
3. 任務透過同一個 `AIAgent` 介面執行，可配置為 local 或 runner
4. 輸出送到 connector，並同步寫入 memory / Memoria

### 3. Web Console

1. 使用者從 `#/chat`、`#/memory`、`#/schedules`、`#/status` 操作
2. 前端呼叫 `src/web/server.ts` 提供的 `/api/*`
3. Web chat 走與 Telegram 相同的 message pipeline
4. Status 頁直接讀取 `workspace/context/*.md` 的結構化快照

## Prompt 與記憶策略

目前 prompt 並不是每輪都塞完整上下文，而是依訊息型態切換：

- `full`
  - 週期性注入完整 prompt 與 memory context
- `compact`
  - 後續對話的輕量 prompt
  - 只有在問題明顯需要歷史規則、決策、設定時才注入 memory context
- `minimal`
  - 短 follow-up，避免不必要膨脹
- `passthrough`
  - slash command 直接傳遞給底層 CLI，不包裝 TeleNexus prompt

長期記憶則由兩段組成：

- TeleNexus 自己的 SQLite memory / SAR retrieval
- 可選的 Memoria CLI 背景同步與長期補強

## Runner 模式

目前實作支援 chat 與 scheduler 分開決定是否走 runner：

- `CHAT_USE_RUNNER_PERCENT`
  - 控制聊天有多少比例改走 runner
- `CHAT_USE_RUNNER_ONLY_USERS`
  - 控制聊天 runner 白名單
- `SCHEDULE_USE_RUNNER`
  - 控制排程是否固定走 runner

`DynamicAIAgent` 在 runner 模式下具備：

- HTTP `/run` 呼叫
- timeout 控制
- 連續失敗計數與 cooldown
- 失敗後 fallback 到 local
- `/compress` 與 `/compact` 在 Gemini / Opencode 間的 passthrough 轉換

## Context Snapshot

目前真正提供給 agent 與維護者看的系統狀態，不是直接暴露 `src/`，而是由 orchestrator 寫出這些檔案：

- `workspace/context/runtime-status.md`
- `workspace/context/provider-status.md`
- `workspace/context/scheduler-status.md`
- `workspace/context/error-summary.md`
- `workspace/context/memory-status.md`
- `workspace/context/memoria-status.md`
- `workspace/context/prompt-session-status.md`
- `workspace/context/memory-intent-status.md`
- `workspace/context/runner-status.md`
- `workspace/context/runner-audit.log`

## 擴充建議

- 新增 provider：實作 `AIAgent` 介面並接入 `DynamicAIAgent`
- 新增命令：擴充 `CommandRouter`
- 新增 Web 視圖：在 `src/web/public/app/views/` 與對應 service 擴充
- 新增記憶治理規則：優先補 `summary metadata`、SAR ranking、backfill 驗證

## 文件對照

- 專案首頁與定位：`README.md`
- 配置與 runner/session：`docs/configuration-reference.md`
- Web Console：`docs/web-console-reference.md`
- 記憶系統與 SAR：`docs/summary-aware-retrieval-plan.md`
- runtime 邊界：`docs/runtime-boundary-and-security.md`
