# Runtime 邊界與安全模型

## 📅 建立日期

2026-02-07

## 1) 設計目標

- 讓 Agent「看得到必要狀態」，但「碰不到高風險原始碼/部署面」。
- 降低誤寫、誤刪、誤操作對主系統的影響範圍。
- 讓開發與部署都能維持可預測的一致性。

## 2) 資料與目錄分層

### A. Control Plane（orchestrator）

- 主要責任：Telegram、Web API、命令處理、記憶注入、排程、資料庫存取、狀態快照。
- 建議掛載：
  - 可寫：`/app/data`
  - 唯讀：設定檔、skills、文件

目前對應實作：

- `src/main.ts`
- `src/core/message-pipeline.ts`
- `src/core/scheduler.ts`
- `src/web/server.ts`
- `src/services/context-snapshots.ts`

### B. Execution Plane（agent-runner）

- 主要責任：執行 Gemini/Opencode CLI 與 summarize/chat 任務。
- 建議掛載：
  - 可寫：`/app/workspace`
  - 可讀：`/app/workspace/context`
  - 不直接依賴：`/app/src`

目前對應實作：

- `src/runner.ts`
- `src/core/agent.ts`
- `src/core/gemini.ts`
- `src/core/opencode.ts`

補充：

- `DynamicAIAgent` 可以優先呼叫 runner，再 fallback 到 local execution
- runner 具備 timeout、成功率統計、audit log、連續失敗熔斷
- Gemini 任務可序列化，避免 CLI 併發時 session 不穩

### C. Context Plane（context snapshot）

- 路徑：`workspace/context/`
- 更新頻率：啟動/重載事件即時更新 + 週期性刷新（預設 60 秒，可用 `CONTEXT_REFRESH_MS` 調整，最小 10 秒）。
- 內容範例：
  - `runtime-status.md`：服務狀態、版本、provider、模型、時間區。
  - `provider-status.md`：目前 provider/model/timezone 設定快照。
  - `scheduler-status.md`：排程清單與最後載入時間。
  - `error-summary.md`：最近 runtime 錯誤摘要（除錯用途）。
  - `runner-status.md`：runner 成功率、平均耗時、最後請求摘要。
  - `runner-audit.log`：runner request JSONL 稽核軌跡。
  - `system-architecture.md`：高層架構與資料流說明。
  - `operations-policy.md`：允許/禁止操作、執行規範。
  - `memory-status.md`：記憶健康度與 backfill 狀態。
  - `memoria-status.md`：Memoria CLI 可用性與最近同步狀態。
  - `prompt-session-status.md`：prompt mode、prompt 長度、memory context 使用量。
  - `memory-intent-status.md`：模型輸出的結構化 memory intent 觀測。

## 3) 權限策略（建議）

- Agent 預設不可寫 `src`、不可直接變更部署檔。
- `workspace` 為唯一可寫區，所有臨時輸出在此生成。
- `skills` 掛載建議唯讀，避免 runtime 被 AI 改寫技能定義。
- 對高風險操作加入白名單（例如僅允許讀取特定 runtime 狀態檔）。

## 4) 目前的實作邊界

- `workspace/context/*.md` 是給 agent 與維護者看的受控觀測面，不等於原始碼掛載。
- Web status 頁與 agent 工作流都以這些快照作為觀測入口。
- `workspace/temp/` 是預期的暫存與檔案輸出區。
- Telegram 自動檔案回傳只允許 `workspace/temp/` 路徑。
- `agent-runner` 負責維持 CLI session continuity；不要把 `telenexus` 容器手動 CLI 狀態誤認為聊天真實狀態。

## 5) Memoria 與長期記憶邊界

- TeleNexus 本身的 SQLite memory 是主對話流程的一級依賴。
- Memoria sync 是背景補強，不可阻塞主聊天。
- `MEMORIA_SYNC_ENABLED=auto` 時，若 CLI 不存在會自動停用。
- 問題應分開判讀：
  - `memory.db` / `moltbot.db` 問題：會直接影響主對話與排程
  - Memoria sync 問題：主要影響跨 session 長期補強，不應拖垮主流程

## 6) 安全基準檢查清單

- [ ] Agent 無法直接寫入 `src`。
- [ ] Agent 僅可在 `workspace` 內產生或修改檔案。
- [ ] 所有排程變更有事件記錄（誰、何時、做了什麼）。
- [ ] 可清楚區分 `exec` 與 `run` 的操作語意，避免誤操作。
- [ ] 生產與開發環境的關鍵 volume 權限一致。
- [ ] `workspace/context/*.md` 可以在不暴露原始碼的前提下提供足夠觀測資訊。
- [ ] runner token 與 Web auth token 不應硬編碼在 repo 內。

## 7) 事件稽核建議

- 記錄項目：`timestamp`, `actor`, `command`, `result`, `target`。
- 最低要求：排程新增/刪除、重載、觸發失敗、CLI timeout、provider 切換。
- 追蹤目的：快速定位「資料已變更但主程序未載入」類事件。

目前已落地的稽核/觀測面包含：

- `runner-audit.log`
- `error-summary.md`
- `prompt-session-status.md`
- `memory-intent-status.md`

## 8) 實務原則

- 可觀測性不等於開放原始碼寫權。
- 先讓 Agent 看摘要與狀態，再按需增補可讀資訊。
- 用流程與邊界保護系統，而不是依賴模型自律。
- 若要人工除錯 session，優先進 `agent-runner`，不要直接在 orchestrator 容器內重建另一條 CLI 脈絡。
