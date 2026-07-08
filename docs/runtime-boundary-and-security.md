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
- Memoria 自 v2.19 起改為**獨立 HTTP 服務**：以 npm `@raybird.chen/memoria` 在 image build 期安裝,資料落在 `memoria_data` named volume,telenexus 為純 client。
- recall 與 sync **都走 HTTP**(`MEMORIA_ENDPOINT`):recall = `POST /v1/recall`、sync = `POST /v1/remember`。telenexus 容器內**不再有 Memoria 原始碼或 CLI**,也不再共享資料目錄,從根本消除過去 recall/sync 兩條路徑的資料 split-brain。
- sync 是背景補強,不可阻塞主聊天;hook-queue 保留為**離線重試緩衝**,memoria 服務短暫不可達時 payload 留存待重灌,不丟記憶。
- `MEMORIA_SYNC_ENABLED=auto` 時,只要設了 `MEMORIA_ENDPOINT`(compose 內預設指向 memoria 服務)即啟用;不可達不停用,交由 queue 重試。
- 問題應分開判讀：
  - `memory.db` / `moltbot.db` 問題：會直接影響主對話與排程
  - Memoria 服務問題：主要影響跨 session 長期補強,不應拖垮主流程

## 6) 安全基準檢查清單

- [ ] Agent 無法直接寫入 `src`。
- [ ] Agent 僅可在 `workspace` 內產生或修改檔案。
- [ ] 所有排程變更有事件記錄（誰、何時、做了什麼）。
- [ ] 可清楚區分 `exec` 與 `run` 的操作語意，避免誤操作。
- [ ] 生產與開發環境的關鍵 volume 權限一致。
- [ ] `workspace/context/*.md` 可以在不暴露原始碼的前提下提供足夠觀測資訊。
- [ ] runner token 與 Web auth token 不應硬編碼在 repo 內。
- [ ] 容器以非 root（UID 1000）執行，不以 root 污染 host bind mount（見 §9）。
- [ ] opencode 認證/設定走容器內 named volume，不讀寫 host 帳號家目錄（見 §9）。

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

## 9) 容器執行身分與帳號隔離（v2.18.0）

目標：讓執行 AI（opencode）的容器**碰不到 host 帳號**、不以 root 污染 host 檔案，並把 runtime 鎖在 workspace。

### 執行身分

- 三個服務（`telenexus` / `agent-runner` / `memoria`）皆以 `node:22-slim` 內建的 **`node` 使用者（UID/GID = 1000）** 執行，刻意對齊 host 的部署帳號（1000）。
- bind mount（`./data`、`./workspace`、`./workspace/Memoria`）寫出的檔案在 host 上即為部署帳號擁有，**不再產生 root-owned 污染**。
- `Dockerfile` 結尾 `USER node` + `HOME=/home/node`；`uv` 改裝 `/usr/local/bin` 讓非 root 也能用 `uvx`（MCP 需要）。

### opencode 認證/設定隔離

- 認證：named volume `opencode_auth` 掛 `/home/node/.local/share/opencode`，**不讀 host `~/.local/share/opencode`**。
- 全域設定：named volume `opencode_config` 掛 `/home/node/.config/opencode`，**持久化**「agent 內部安裝的 skill」與全域設定，重建不消失。
- builtin skills 由 `scripts/sync-skills.mjs` 依 `OPENCODE_SKILLS_DIRS` 同步到兩處：專案層 `/app/workspace/.opencode/skills`（保證載入）+ 全域層 `/home/node/.config/opencode/skills`（seed 持久化）。

### 其他放行旗標

- `OPENCODE_YOLO` 預設 `1`（全自動放行），可在 `.env` 設 `0` 收緊。
- 非 root 下 chromium 必須 `--no-sandbox`；專案不直接啟動瀏覽器（走全域 `agent-browser`），透過 `AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage` 套用。

### 首次切換到非 root 的一次性遷移

1. host 既有 root 檔案改 owner：`sudo chown -R 1000:1000 data workspace`。
2. opencode 認證 volume 改 owner（否則 `auth.json` 600/root → node 讀不到、需重登）：
   `docker run --rm -v <project>_opencode_auth:/v alpine chown -R 1000:1000 /v`

### 可攜性:PUID/PGID（v2.19 build args → v2.21 runtime entrypoint）

- `PUID`/`PGID` 改為 **runtime 環境變數**(預設 1000):容器以 root 啟動 `scripts/docker-entrypoint.sh`,先 `usermod`/`groupmod` remap 內建 `node` 使用者、修正 bind mount 頂層與 opencode named volume 的擁有權,再以 `gosu` 降權執行。改為 runtime 的原因是 GHCR 預建映像無法在 build 時對齊 host 帳號。
- `./setup.sh`(原始碼安裝)與 `scripts/install.sh`(一鍵安裝)都會自動以 `id -u` / `id -g` 填入 `.env`,讓非 1000 的 host 帳號也能無痛跑 bind mount,**免手動 chown**。
- `memoria` 不做 remap:資料只在 named volume,無 host UID 問題,維持 build 時的 `USER node` + `read_only`。

### Tier 2 容器硬化（v2.19）

- 三服務皆加 `security_opt: [no-new-privileges:true]` 與 `cap_drop: [ALL]`;`telenexus`/`agent-runner` 另 `cap_add` entrypoint UID 對齊所需的最小集合(`CHOWN`/`SETUID`/`SETGID`/`FOWNER`/`DAC_OVERRIDE`——`gosu` 是降權不是提權,與 no-new-privileges 相容)。`memoria` 維持 cap_drop ALL 無 cap_add。
- `memoria` 服務可寫面僅 `/data` volume,已上完整 `read_only: true` + `tmpfs: [/tmp]`。
- `telenexus` / `agent-runner` 的 `read_only` 仍待可寫路徑稽核(opencode/uvx/npm cache、context 快照寫入點等)後再逐一開白名單,目前未啟用。

### dev/prod 模式說明

- `docker-compose.override.yml` 會被預設 `docker compose up` 合併，把 `telenexus`/`agent-runner` 切到 dev（`npm run dev` + tsx watch + 唯讀掛載 `./src`）。
- 安全硬化（非 root、volume 隔離）在 dev/prod 兩模式**一致生效**，因為共用同一個映像；要測 production 路徑用 `docker compose -f docker-compose.yml ...`。
