# Docker 重構遷移紀錄

## 使用方式

- 每完成一個階段就新增一筆紀錄。
- 每筆紀錄至少包含：變更內容、驗證結果、風險、回滾方式。

---

## 2026-02-07 - 初始化遷移紀錄

### 階段

- Phase 0（盤點與規劃）完成。

### 已完成

- 建立重構路線圖：`docs/docker-refactor-roadmap.md`
- 建立邊界與安全模型：`docs/runtime-boundary-and-security.md`
- 建立排程操作手冊：`docs/scheduler-operation-runbook.md`
- 建立本遷移紀錄：`docs/migration-log.md`

### 目前判斷

- 排程失效主因為「新增/通知/載入」流程在 Docker 操作路徑不一致。
- `workspace/src` 與 `/app/src` 的路徑策略與工具沙箱存在結構性衝突。

### 待執行（下一階段）

- Phase 1：
  - 排程入口收斂（以 in-process 指令為主）
  - `scheduler-cli` 錯誤可見性強化
  - 文件加入 `exec` / `run` 操作規範

### 驗證證據

- 需補：Phase 1 實作後的 log 截圖/關鍵字與命令輸出。

### 回滾計畫

- 本階段僅新增文件，無程式行為改動，不需技術回滾。

---

## 2026-02-07 - Phase 1（第一批）

### 階段

- Phase 1（入口收斂與排程穩定化）進行中。

### 已完成

- 強化 `scheduler-cli` 主程序通知可見性：
  - PID 探測改為 `pgrep -af` 並列出候選進程。
  - signal 發送改為逐一 `process.kill(..., 'SIGUSR1')`，失敗逐筆顯示原因。
  - 新增 `reload` 子命令，供維運手動觸發重載通知。
  - 通知失敗時輸出 Docker 操作建議（`exec` 而非 `run`）。
- 更新 README：加入 Docker 排程操作規範與 `reload` 範例。

### 影響檔案

- `src/tools/scheduler-cli.ts`
- `README.md`

### 驗證結果

- `npm run build`：成功（TypeScript 編譯通過）。
- `node dist/tools/scheduler-cli.js --help`：可看到新增的 `reload` 子命令。
- 容器內 `npx tsx src/tools/scheduler-cli.ts reload`：
  - CLI 顯示找到 1 個主程序候選（PID 30）並成功送出 SIGUSR1。
  - 主服務 log 顯示 `Received SIGUSR1`、`Reloading schedules`、`Started job #2/#3`，驗證 reload 生效。

### 回滾計畫

- 回滾 `src/tools/scheduler-cli.ts` 與 README 相關段落即可，不影響資料庫 schema。

---

## 2026-02-07 - Phase 1（第二批）

### 階段

- Phase 1（入口收斂與排程穩定化）持續推進。

### 已完成

- 主程序新增排程健康標記（`scheduler-health.json`）：
  - 啟動完成 (`startup:init`) 與收到 `SIGUSR1` 重載後都會更新。
  - 紀錄 `lastReloadAt`、`lastLoadedScheduleCount`、`trigger`、`pid`。
- `scheduler-cli` 新增健康檢查能力：
  - `health` 子命令可讀取並顯示健康標記內容。
  - `add/remove/reload` 在通知成功後，會等待健康標記更新以驗證重載落地。
- 更新 runbook：加入 `scheduler-cli health` 與驗證流程。

### 影響檔案

- `src/main.ts`
- `src/tools/scheduler-cli.ts`
- `docs/scheduler-operation-runbook.md`

### 驗證結果

- `npm run build`：成功（TypeScript 編譯通過）。
- `node dist/tools/scheduler-cli.js --help`：可看到新增 `health` 子命令。
- 容器內 `npx tsx src/tools/scheduler-cli.ts reload`：
  - 成功找到主程序候選 PID 並送出 SIGUSR1。
  - CLI 顯示 `Reload confirmed` 並回報 `loaded=2`。
- 容器內 `npx tsx src/tools/scheduler-cli.ts health`：成功讀取 `/app/data/scheduler-health.json`，可看到 `Last Reload`、`Loaded Schedules`、`Trigger` 與 `Main PID`。
- `npm run lint`：失敗（專案目前缺少 ESLint v9 的 `eslint.config.*`，為既有配置問題，非本批次新增）。

### 回滾計畫

- 若需回滾，可移除 `src/main.ts` 健康檔案寫入與 `scheduler-cli` 健康檢查邏輯，不影響排程資料 schema。

---

## 2026-02-07 - Tooling Follow-up（先 1 後 2）

### 已完成

- 新增 `eslint.config.js`（ESLint v9 flat config），讓 `npm run lint` 可正常執行。
- 先以低風險遷移策略啟用 TypeScript 推薦規則，並關閉目前專案大量既有噪音規則：
  - `@typescript-eslint/no-explicit-any`: off
  - `@typescript-eslint/no-unused-vars`: warn

### 驗證結果

- `npm run lint`：可執行，結果為 0 error / 2 warning。
- `npm run build`：成功。

### 影響檔案

- `eslint.config.js`

### 回滾計畫

- 刪除 `eslint.config.js` 可退回原狀（但 ESLint v9 將再次無法讀取 `.eslintrc.cjs`）。

---

## 2026-02-07 - Phase 2（Context 邊界重整，第一批）

### 階段

- Phase 2（用 `workspace/context` 取代直接依賴 `src` 暴露）開始執行。

### 已完成

- 主程序新增 `workspace/context` 快照輸出：
  - `runtime-status.md`
  - `scheduler-status.md`
  - `system-architecture.md`
  - `operations-policy.md`
- 快照更新時機：
  - 啟動完成後 (`startup:init`)
  - 收到 `SIGUSR1` 並完成排程重載後
- 系統提示（prompt）改為優先讀取 `workspace/context/`，移除對 `../src` 路徑的引導。
- 移除 Dockerfile 中 `workspace -> dist/src` 的 symlink 建立邏輯。
- 更新驗證腳本與 scheduler skill，改用 `/app/dist/tools/scheduler-cli.js` 路徑。

### 影響檔案

- `src/main.ts`
- `Dockerfile`
- `verify-docker.sh`
- `skills/scheduler/SKILL.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 2 warning。
- 容器內 `ls -la /app/workspace/context`：可看到 4 份快照檔案。
- 容器內 `scheduler-cli reload`：可成功送 signal 並顯示 `Reload confirmed`。

### 回滾計畫

- 回滾 `src/main.ts` 快照輸出邏輯與 Dockerfile symlink 改動。
- 回滾 `verify-docker.sh` 與 skill 路徑調整。

---

## 2026-02-07 - Phase 2（Context 邊界重整，第二批）

### 階段

- Phase 2 持續推進（補強 context 快照資訊密度）。

### 已完成

- `workspace/context` 新增快照內容：
  - `provider-status.md`（provider/model/timezone）
  - `error-summary.md`（最近 runtime 錯誤摘要）
- `runtime-status.md` 新增目前 provider/model 欄位。
- `SIGUSR1` 重載流程加入例外捕捉與錯誤紀錄。
- 訊息處理錯誤會寫入 runtime issue ring buffer，並同步更新 context 快照。
- `verify-docker.sh` 補充檔案存在檢查（runtime/provider/scheduler/error 快照）。

### 影響檔案

- `src/main.ts`
- `verify-docker.sh`
- `docs/runtime-boundary-and-security.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 2 warning。
- 容器內 `ls -la /app/workspace/context`：可看到新增的 `provider-status.md` 與 `error-summary.md`。
- 容器內 `scheduler-cli reload` + `health`：成功顯示 `Reload confirmed` 與最新 `Last Reload`。

### 回滾計畫

- 回滾 `src/main.ts` 中新增的 provider/error snapshot 與 issue buffer。
- 回滾 `verify-docker.sh` 新增檢查段落。

---

## 2026-02-07 - Phase 2（Context 邊界重整，第三批）

### 階段

- Phase 2 穩定化收尾（快照自動刷新）。

### 已完成

- 主程序新增 context 快照週期刷新：
  - 預設每 60 秒更新 `workspace/context/*`
  - 可透過 `CONTEXT_REFRESH_MS` 調整（最小 10 秒）
  - 關機流程會清理 timer，避免殘留背景工作
- 補充邊界文件，明確描述事件更新 + 週期更新策略。
- README Docker 章節同步清理：
  - `scheduler-cli` 範例改為 `node /app/dist/tools/scheduler-cli.js`
  - 新增 `health` 指令範例與 `CONTEXT_REFRESH_MS` 說明

### 影響檔案

- `src/main.ts`
- `docs/runtime-boundary-and-security.md`
- `README.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 2 warning。
- 容器 log 可看到 `Context snapshots auto-refresh every 60000ms`，確認週期刷新啟用。

---

## 2026-02-07 - Phase 3（雙服務骨架，第一批）

### 階段

- Phase 3 啟動：先建立 compose profile 骨架，不改主流程。

### 已完成

- `docker-compose.yml` 新增 `agent-runner` 服務（`phase3` profile）。
- 預設行為不變：未帶 profile 時只啟動 `telenexus`。
- README 補充 `--profile phase3` 啟動方式。
- 新增 `docs/phase3-compose-profile.md` 說明服務定位與後續切流步驟。

### 影響檔案

- `docker-compose.yml`
- `README.md`
- `docs/phase3-compose-profile.md`

### 驗證結果

- `docker compose config`：成功（預設仍只包含 `telenexus` 服務）。
- `docker compose --profile phase3 config`：成功（可展開 `agent-runner` + `telenexus`）。

### 回滾計畫

- 移除 `docker-compose.yml` 中 `agent-runner` 區塊與 README/文件對應段落。

---

## 2026-02-07 - Phase 3（雙服務切流，第二批）

### 階段

- Phase 3 進入「最小可運行 + 排程 canary」階段。

### 已完成

- 新增 `src/runner.ts`：
  - `GET /health`
  - `POST /run`（chat/summarize）
  - 依 `ai-config.yaml` 或請求指定 provider/model 執行 Gemini/Opencode
- `DynamicAIAgent` 新增 runner client 模式：
  - `runnerEndpoint`
  - `preferRunner`
  - `fallbackToLocal`
  - `runnerTimeoutMs`
- `main.ts` 實作小流量切換：
  - 使用者互動訊息維持本地 agent
  - scheduler 可透過 `RUNNER_ENDPOINT + SCHEDULE_USE_RUNNER=true` 走 runner
  - runner 失敗自動 fallback 本地執行
- Compose 與腳本更新：
  - `agent-runner` command 改為 `node dist/runner.js`
  - `docker-compose.override.yml` 新增 `dev:runner`
  - `package.json` 新增 `dev:runner` / `start:runner`

### 影響檔案

- `src/runner.ts`
- `src/core/agent.ts`
- `src/main.ts`
- `docker-compose.yml`
- `docker-compose.override.yml`
- `package.json`
- `README.md`
- `docs/phase3-compose-profile.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 1 warning（既有 warning 在 `scheduler.ts`）。
- `docker compose --profile phase3 up -d --build agent-runner`：成功啟動 `agent-runner`。
- 由 `telenexus` 容器呼叫 `http://agent-runner:8787/health`：回傳 `ok: true`。
- 由 `telenexus` 容器呼叫 `POST /run`（缺少 input）可收到 validation 錯誤，確認 API 路由生效。

### 回滾計畫

- 關閉 `.env`：`SCHEDULE_USE_RUNNER=false` 即可回到全本地執行。
- 移除 `agent-runner` 服務與 `src/runner.ts`、`DynamicAIAgent` runner 路徑可完全退回 Phase 2。

---

## 2026-02-07 - Phase 3（安全補強，第三批）

### 階段

- Phase 3 安全補強（runner token + healthcheck）。

### 已完成

- `DynamicAIAgent` runner client 支援 `runnerToken`，呼叫 `/run` 時帶 `x-runner-token`。
- `runner.ts` 新增 token 驗證：
  - 設定 `RUNNER_SHARED_SECRET` 時，未帶或錯誤 token 會回 `401 Unauthorized`。
- Compose 新增 `RUNNER_SHARED_SECRET` 環境變數傳遞。
- `agent-runner` 新增 container healthcheck（HTTP `/health`）。
- README 與 Phase 3 文件補充 shared secret 設定。

### 影響檔案

- `src/core/agent.ts`
- `src/main.ts`
- `src/runner.ts`
- `docker-compose.yml`
- `README.md`
- `docs/phase3-compose-profile.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 1 warning（既有 warning 在 `scheduler.ts`）。
- 以 `RUNNER_SHARED_SECRET=phase3test RUNNER_ENDPOINT=http://agent-runner:8787 SCHEDULE_USE_RUNNER=true` 啟動 profile：
  - `docker compose --profile phase3 up -d --build telenexus agent-runner` 成功。
  - `agent-runner` 狀態為 `healthy`。
- `/run` 驗證：
  - 未帶 `x-runner-token` 回 `401 Unauthorized`。
  - 帶正確 token 可回 `200` 並返回模型輸出。
- `telenexus` 啟動 log 顯示 `Scheduler execution mode: runner (http://agent-runner:8787)`，確認 canary 切流生效。

### 回滾計畫

- 清空 `.env` 的 `RUNNER_SHARED_SECRET` 可停用 token 驗證。
- 移除 agent/runner token 相關程式段落可完全回到上一批。

---

## 2026-02-07 - Phase 3（審計與可觀測，第四批）

### 階段

- Phase 3 可觀測性補強（runner 審計與 request metadata）。

### 已完成

- `runner.ts` 新增 request 審計：
  - 寫入 `workspace/context/runner-audit.log`（JSONL）
  - 記錄 `requestId`, `timestamp`, `durationMs`, `task`, `provider`, `ok/error`
- `/run` 回應新增 `requestId` 與 `durationMs`。
- `DynamicAIAgent` 於 runner 成功時記錄 `requestId/duration`，利於交叉追蹤。
- `/health` 回應新增 `auditPath`。

### 影響檔案

- `src/runner.ts`
- `src/core/agent.ts`
- `README.md`
- `docs/phase3-compose-profile.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 1 warning（既有 warning 在 `scheduler.ts`）。
- `GET /health`：回傳包含 `auditPath`。
- 帶 token 呼叫 `POST /run`：回 `200`，含 `requestId`、`durationMs`。
- `agent-runner` 內 `workspace/context/runner-audit.log`：可看到 JSONL 審計紀錄（requestId/duration/provider/task）。

### 回滾計畫

- 移除 `runner.ts` 的 audit append 邏輯與 response metadata。
- `DynamicAIAgent` 可移除 runner metadata log，不影響主功能。

---

## 2026-02-07 - Phase 3（聊天比例切流，第五批）

### 階段

- Phase 3 擴充 canary：加入互動訊息比例切流。

### 已完成

- `main.ts` 新增 `CHAT_USE_RUNNER_PERCENT`（0-100）抽樣邏輯：
  - 每則互動訊息決定是否走 runner
  - runner 失敗仍會 fallback 本地
- `runner.ts` 新增 `runner-status.md` 快照：
  - 成功率、平均耗時、最後請求摘要
- runtime context 快照加入 runner 設定顯示（endpoint/scheduler mode/chat percent）。
- Compose 與文件同步補齊 `CHAT_USE_RUNNER_PERCENT` 設定說明。

### 影響檔案

- `src/main.ts`
- `src/runner.ts`
- `docker-compose.yml`
- `README.md`
- `docs/phase3-compose-profile.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 1 warning（既有 warning 在 `scheduler.ts`）。
- 使用 `CHAT_USE_RUNNER_PERCENT=10` 啟動 phase3：
  - `telenexus` log 顯示 `Chat runner canary: 10% via http://agent-runner:8787`。
  - `runtime-status.md` 顯示 runner endpoint / scheduler mode / chat percent。
- runner request 後：
  - `runner-status.md` 會更新 `Total Requests`, `Success Rate`, `Avg Duration`, `Last Request`。
  - `runner-audit.log` 持續追加 JSONL 審計紀錄。

### 回滾計畫

- 設定 `CHAT_USE_RUNNER_PERCENT=0` 可立即關閉聊天切流。
- 移除 `main.ts` 抽樣邏輯與 `runner.ts` 狀態快照可退回上一批。

---

## 2026-02-07 - Phase 3（聊天切流強化，第六批）

### 階段

- 強化聊天切流可控性與可重現性。

### 已完成

- `main.ts` 聊天切流抽樣改為穩定分桶：
  - 以 `userId:messageId` 計算 hash bucket（0-99）
  - 避免純隨機導致重現困難
- 新增 `CHAT_USE_RUNNER_ONLY_USERS` 白名單：
  - 可只對指定 Telegram ID 套用聊天切流
  - 未設定時預設使用 `ALLOWED_USER_ID`（單人使用情境）
- runtime 快照補充 `Chat Runner Whitelist` 欄位。
- README 與 phase3 文件同步補充白名單設定。

### 影響檔案

- `src/main.ts`
- `README.md`
- `docs/phase3-compose-profile.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 1 warning（既有 warning 在 `scheduler.ts`）。
- 以 `CHAT_USE_RUNNER_ONLY_USERS=915354960` 啟動後：
  - `telenexus` log 顯示 `Chat runner whitelist: 915354960`。
  - `runtime-status.md` 顯示 `Chat Runner Whitelist: 915354960`。

### 回滾計畫

- 清空 `CHAT_USE_RUNNER_ONLY_USERS` 並保留 `CHAT_USE_RUNNER_PERCENT` 可回到全使用者切流。
- 設定 `CHAT_USE_RUNNER_PERCENT=0` 可立即關閉聊天切流。

---

## 2026-02-07 - Phase 3（穩定性保護，第七批）

### 階段

- Phase 3 加入 runner 熔斷保護，降低連續故障對主流程影響。

### 已完成

- `DynamicAIAgent` 新增 runner circuit breaker：
  - `RUNNER_FAILURE_THRESHOLD`（預設 3）
  - `RUNNER_COOLDOWN_MS`（預設 60000）
  - 連續失敗達門檻後，cooldown 期間直接 fallback 本地執行
- runtime 快照補充 threshold/cooldown 欄位。
- compose/README/phase3 文件補充新環境變數說明。

### 影響檔案

- `src/core/agent.ts`
- `src/main.ts`
- `docker-compose.yml`
- `README.md`
- `docs/phase3-compose-profile.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 1 warning（既有 warning 在 `scheduler.ts`）。
- 以 `DynamicAIAgent` 模擬 runner 失敗（`fallbackToLocal=false`, threshold=2）驗證：
  - 前兩次呼叫回 `Runner request failed`。
  - 第三次進入熔斷視窗，回 `circuit open (...ms remaining)`。

### 回滾計畫

- 移除 `DynamicAIAgent` circuit breaker 邏輯，可回到單純 runner + fallback。

---

## 2026-02-07 - Phase 3（觀測收斂，第八批）

### 階段

- Phase 3 收斂：補齊環境樣板與短窗指標。

### 已完成

- `runner-status.md` 新增「近 5 分鐘」視窗指標：
  - `Last 5m Requests`
  - `Last 5m Success Rate`
  - `Last 5m Avg Duration (success)`
- 新增 runner 診斷端點 `GET /stats`（回傳記憶體統計 + path 資訊）。
- `dev:runner` 增加 watch ignore：`workspace/context/**`，避免觀測檔更新觸發不必要重啟。
- 補齊 `.env.example`：新增 Phase 3 相關參數（runner/canary/security/circuit/context）。
- `GET /stats` 改為受 `RUNNER_SHARED_SECRET` 保護（與 `/run` 一致）。

### 影響檔案

- `src/runner.ts`
- `package.json`
- `.env.example`
- `docs/phase3-compose-profile.md`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：可執行，0 error / 1 warning（既有 warning 在 `scheduler.ts`）。
- runner 容器內 sequential 驗證（`/stats -> /run -> /stats`）：
  - `total/success` 由 `1 -> 2` 正常累加。
  - `runner-status.md` 顯示 Last 5m 指標與最新 request metadata。

### 回滾計畫

- 移除 `runner.ts` 近 5 分鐘指標與 `/stats` 端點可回到上一批。
- `package.json` 還原 `dev:runner` 命令即可移除 watch ignore。

---

## 2026-02-07 - 例行收尾（文件與Lint）

### 階段

- 低風險收尾：整理環境範本與清掉既有 lint warning。

### 已完成

- 新增 `.env.production.example`（保守生產模板，預設只切排程）。
- README 補充 env 樣板索引（開發版與生產版）。
- 修正 `src/core/scheduler.ts` 未使用 catch 參數，移除既有 lint warning。

### 影響檔案

- `.env.production.example`
- `README.md`
- `src/core/scheduler.ts`

### 驗證結果

- `npm run build`：成功。
- `npm run lint`：成功（0 error / 0 warning）。

### 回滾計畫

- 刪除 `.env.production.example` 並回退 README 與 `scheduler.ts` 單行改動即可。

---

## 2026-02-07 - 上線準備（流程文件）

### 已完成

- 新增 `docs/deployment-cutover-checklist.md`：上線/驗證/灰度/回滾 SOP。
- 新增 `docs/commit-split-plan.md`：建議 3 個 commit 的切分策略（不 push）。

### 影響檔案

- `docs/deployment-cutover-checklist.md`
- `docs/commit-split-plan.md`

### 回滾計畫

- 刪除以上兩份文件即可，不影響執行行為。

---

## 2026-02-11 - Web Local Chat + Dashboard 規劃啟動

### 階段

- 新增雙入口方案（Telegram + 本地 Web）的執行計畫文件。

### 已完成

- 新增 `docs/web-local-chat-dashboard-plan.md`，定義：
  - 目標範圍與現況盤點
  - To-Be 架構
  - Phase 1~4 實作計畫
  - MVP API 草案與安全策略
  - 風險、回滾與 Decision Record
- 確認決策：Web 與 Telegram 採共用使用者識別（`WEB_USER_ID` 預設回退 `ALLOWED_USER_ID`）。

### 影響檔案

- `docs/web-local-chat-dashboard-plan.md`
- `docs/migration-log.md`

### 驗證結果

- 文件層變更，無程式行為改動。
- 計畫內容已對齊現況程式結構（`main.ts`、`memory.ts`、`scheduler.ts`、`runner.ts`）。

### 回滾計畫

- 刪除 `docs/web-local-chat-dashboard-plan.md` 與本節紀錄即可。

---

## 2026-02-11 - Web Console 功能收斂與測試補強

### 階段

- 完成 Web Console 主要功能閉環（SSE、歷史分頁/匯出、排程管理、告警門檻環境化）。
- 補上核心資料層與排程驗證測試。

### 已完成

- Web 功能強化：
  - 新增 `POST /api/chat/stream`（SSE）
  - 新增 `GET /api/memory/history`、`GET /api/memory/export`
  - 新增排程 `PUT /api/schedules/:id` 編輯能力
  - 新增 Dashboard 全域告警條（error / runner）
- 安全與部署：
  - Compose 支援 `WEB_*` 設定與 port 發布
  - 支援 `WEB_TRUST_PRIVATE_NETWORK`
  - 告警門檻改為環境變數：
    - `WEB_ALERT_ERROR_THRESHOLD`
    - `WEB_ALERT_RUNNER_SUCCESS_WARN_THRESHOLD`
- 測試補強：
  - 新增 `tests/memory-manager.test.ts`（驗證記憶分頁）
  - 新增 `tests/scheduler-validation.test.ts`（驗證 cron 檢核與排程更新）
  - 新增 `npm test`（`tsx --test tests/**/*.test.ts`）

### 影響檔案

- `src/web/server.ts`
- `src/main.ts`
- `src/core/memory.ts`
- `src/core/scheduler.ts`
- `docker-compose.yml`
- `.env`
- `.env.example`
- `.env.production.example`
- `README.md`
- `package.json`
- `tests/memory-manager.test.ts`
- `tests/scheduler-validation.test.ts`
- `docs/web-local-chat-dashboard-plan.md`
- `docs/migration-log.md`

### 驗證結果

- `npm run build`：通過
- `npm run lint`：通過
- `docker compose up -d --build`：服務可啟動並提供 `:3030`

### 後續待辦

- 補充 runbook（Web 例外排查與告警調校指引）
- 補充 API 整合測試（含 `/api/chat/stream` 事件流程）

### 回滾計畫

- 先以 `WEB_ENABLED=false` 關閉 Web 功能。
- 若需完整回退，移除本節新增 API 與測試檔並回復 `.env` / Compose 的 `WEB_*` 設定。

---

## 2026-02-11 - Web 前端重構為 Plain Vanilla 多 View

### 階段

- 將單一大頁面重構為 hash-based SPA（`#/chat`、`#/memory`、`#/schedules`、`#/status`）。

### 已完成

- 新增 `src/web/public/index.html` 與模組化前端：
  - `src/web/public/app/main.js`
  - `src/web/public/app/router.js`
  - `src/web/public/app/state.js`
  - `src/web/public/app/api.js`
  - `src/web/public/app/views/chat.js`
  - `src/web/public/app/views/memory.js`
  - `src/web/public/app/views/schedules.js`
  - `src/web/public/app/views/status.js`
- `server.ts` 改為優先提供靜態資源，`index.html` 注入 `window.__APP_CONFIG__`。
- 新增 `scripts/copy-web-assets.mjs`，build 時自動將前端資源複製到 `dist/web/public`。

### 影響檔案

- `src/web/server.ts`
- `src/web/public/index.html`
- `src/web/public/app/*`
- `scripts/copy-web-assets.mjs`
- `package.json`

### 驗證結果

- `npm run build`：通過
- `npm run lint`：通過
- `npm test`：通過
- `docker compose up -d --build`：可正常提供新版前端頁面與路由

### 回滾計畫

- 若需回退，可在 `server.ts` 恢復使用舊版 inline HTML 路徑，並移除 `copy-web-assets` 步驟。

---

## 2026-02-11 - Web 前端第三層重構與整體 UI 美化

### 階段

- 完成前端分層到 services/view/utils，並收斂路由切換體驗與視覺一致性。

### 已完成

- 架構優化：
  - 新增 `src/web/public/app/services/*`（chat/memory/schedules/status）
  - views 改為透過 `ctx.services` 存取資料，不直接呼叫 API
  - 新增 `utils/view.js`，統一 view 事件綁定與 cleanup
- 切頁體驗優化：
  - route 改為 keep-alive（保留 view DOM）
  - 切頁時保留 Chat/Schedule 畫面狀態，降低重繪閃爍
  - 補上 `beforeunload` 釋放流程（timer/listener/view destroy）避免記憶體洩漏
- UI 美化：
  - 套用 Data-Dense dashboard 視覺方向
  - 強化 topbar/menu/card/list/metric 的層次、focus/hover、狀態膠囊
  - 補上 scrollbar-gutter 與最小內容高度，降低寬度跳動

### 影響檔案

- `src/web/public/index.html`
- `src/web/public/app/main.js`
- `src/web/public/app/views/*`
- `src/web/public/app/services/*`
- `src/web/public/app/utils/*`
- `README.md`
- `docs/web-local-chat-dashboard-plan.md`
- `docs/migration-log.md`

### 驗證結果

- `npm run build`：通過
- `npm run lint`：通過
- `npm test`：通過
- `docker compose up -d --build`：通過

### 回滾計畫

- 將 `main.js` 切回非 keep-alive 模式（每次 route mount/unmount）。
- 將 views 改回直接使用 api 層（不經 services）可快速回退。

---

## 2026-02-11 - Phase 3 提升為標準部署

### 階段

- Phase 3 測試完成,移除 profile 機制,雙服務架構成為標準部署方式。

### 已完成

- Docker Compose 配置:
  - 移除 `agent-runner` 的 `profiles: [phase3]` 配置
  - 調整環境變數預設值:`SCHEDULE_USE_RUNNER=true`, `CHAT_USE_RUNNER_PERCENT=100`
- 環境變數範例:
  - 更新 `.env.example` 和 `.env.production.example` 的 RUNNER 預設值和註解
  - 強調雙服務架構為標準配置,不再是實驗性功能
- 文件更新:
  - `README.md` 移除 `--profile phase3` 啟動指令,改為標準 `docker compose up`
  - 將 `docs/phase3-compose-profile.md` 重新命名為 `docs/phase3-migration-history.md` 並標記為歷史文件
  - 更新 `docs/deployment-cutover-checklist.md` 移除 profile 相關指令

### 影響檔案

- `docker-compose.yml`
- `.env.example`
- `.env.production.example`
- `README.md`
- `docs/phase3-migration-history.md` (renamed from `phase3-compose-profile.md`)
- `docs/deployment-cutover-checklist.md`
- `docs/migration-log.md`

### 驗證計畫

- `docker compose config`:確認兩個服務都會被包含
- `docker compose up -d`:確認 `telenexus` 和 `agent-runner` 都正常啟動
- 功能測試:確認 Telegram bot 透過 runner 執行正常
- 審計檔案:確認 `runner-audit.log` 和 `runner-status.md` 正常記錄

### 回滾計畫

- 若需回退,可在 `docker-compose.yml` 中為 `agent-runner` 重新添加 `profiles: [phase3]`
- 調整環境變數預設值回到 `SCHEDULE_USE_RUNNER=false`, `CHAT_USE_RUNNER_PERCENT=0`

---

## 2026-02-12 - Web Chat/Memory 對話閱讀體驗優化（v2.5.2）

### 階段

- 針對 Web Console 的聊天閱讀體驗做一致性收斂（Chat 與 Memory 對齊）。

### 已完成

- Memory 顯示改為對話泡泡樣式（user/model 左右分流）。
- Memory 清單改為主流對話閱讀順序（上舊下新），並在渲染後自動捲到最新。
- Chat 頁面整合 Recent memory：
  - 初次載入自動帶入最近訊息做上下文
  - 提供手動「重載 Recent」
- Chat 與 Memory 採用同一套對話泡泡 UI 元件風格，減少切頁認知成本。
- Memory 頁面收斂為 `Search + History`，避免與 Chat Recent 重複。

### 影響檔案

- `src/web/public/app/views/chat.js`
- `src/web/public/app/views/memory.js`
- `src/web/public/index.html`
- `README.md`
- `docs/migration-log.md`

### 驗證結果

- `npm run build`：通過（`tsc` + `copy-web-assets`）。

### 回滾計畫

- 若需快速回退，可先移除 Chat 的 Recent 自動載入區塊與 `reload` 按鈕。
- 再將 Memory 視圖回復為列表型 `Recent + Search + History` 三段式布局。

---

## 2026-02-12 - Web 記憶同步與版本可觀測補強（v2.5.4 ~ v2.5.5）

### 階段

- 針對「Web Memory 與 Telegram 實際輸出不一致」與「容器版本難以確認」做穩定化補強。

### 已完成

- Web Memory 即時同步：
  - 新增 `GET /api/memory/stream`（SSE: `snapshot` / `update` / `ping`）。
  - Memory 視圖改為訂閱 stream，自動刷新最新歷史。
  - Chat / Memory 切換時觸發 `view:show` 自動重拉資料。
- 快取防呆：
  - Web 靜態資源與 JSON API 加入 `Cache-Control: no-store`，降低舊 JS 快取造成的假象。
- Scheduler 記憶一致性：
  - 追蹤提醒、手動追蹤、每日摘要與相關錯誤訊息均寫入 memory。
  - 讓 Telegram 收到的系統輸出可在 Web Memory 追溯。
- 版本可觀測：
  - 新增 `GET /api/debug/version`，回傳 `version/pid/startedAt/uptime/gitSha/buildTime`。
  - Docker build 支援注入 `APP_GIT_SHA`、`APP_BUILD_TIME`。
- 開發流程優化：
  - 新增 `npm run docker:up:fast` / `docker:up:build` / `docker:up:meta` 三種模式。
  - `docker:up` 預設改為快速模式，避免每次全量重建。

### 後續補強（同日）

- 追蹤分析提示詞加入「證據門檻」：
  - User 訊息為主證據，AI 訊息僅作補充。
  - 僅 AI 出現、未被 User 提及的項目不得列為待辦。
  - 每項輸出要求標註 `evidence` 與 `confidence`。

### 影響檔案

- `src/web/server.ts`
- `src/web/public/app/api.js`
- `src/web/public/app/main.js`
- `src/web/public/app/services/memory-service.js`
- `src/web/public/app/views/chat.js`
- `src/web/public/app/views/memory.js`
- `src/core/scheduler.ts`
- `Dockerfile`
- `docker-compose.yml`
- `package.json`
- `docs/web-console-reference.md`
- `docs/migration-log.md`

### 驗證結果

- `npm run build`：通過。
- `curl http://127.0.0.1:3030/api/memory/stream`：可收到 `snapshot`/`update`。
- `curl http://127.0.0.1:3030/api/debug/version`：可回傳版本與 runtime metadata。

### 回滾計畫

- 若要回退即時同步，可先移除 `memory/stream` 與前端 SSE 訂閱。
- 若要回退版本可觀測，可移除 `api/debug/version` 與 build metadata 注入。
- 若要回退部署腳本分流，可將 `docker:up` 指令還原為單一命令。

---

## 2026-02-27 - Telegram placeholder 輪播覆蓋修正與圖片輸入穩定化（v2.5.22）

### 階段

- 修正 Telegram 在「已送出最終回覆後又跳回等待輪播文字」的競態問題。
- 補齊圖片上傳到 CLI prompt 的穩定流程與參數文件。

### 已完成

- message pipeline 加入 placeholder 輪播的 in-flight 鎖與停止旗標。
- 在送出最終回覆前，先停止輪播並等待最後一次更新完成，避免舊 `editMessage` 晚到覆蓋最終回覆。
- Telegram connector 的 `editMessage` 新增 `retries` 與 `suppressFallbackSend` 控制，供輪播更新使用低風險模式。
- 補充配置文件：Telegram API timeout/retry、圖片大小限制、圖片暫存 TTL。

### 影響檔案

- `src/core/message-pipeline.ts`
- `src/connectors/telegram.ts`
- `src/types/index.ts`
- `docs/configuration-reference.md`
- `docs/migration-log.md`

### 驗證結果

- `npm run build`：通過。
- `npm run lint`：通過。
- 觀測重點：最終回覆送出後，不再被等待輪播字串覆蓋。

### 回滾計畫

- 若需快速回退，可移除 placeholder in-flight 鎖與 `editMessage` 擴充參數，恢復舊版輪播更新流程。

---

## 2026-02-28 - 對話排隊、Prompt 精簡注入與重複回覆抑制（v2.5.26）

### 階段

- 降低 `-r/-c` session 下每回合重複注入長前綴的成本。
- 避免聊天與背景排程同時呼叫 CLI 導致 session 衝突。
- 降低 Telegram timeout 後重送造成的重複回覆風險。

### 已完成

- 新增 `ExecutionQueue`，以 user 為粒度串行化聊天與 scheduler 的 AI 呼叫。
- 聊天在有排隊時會先發出等待提示（含當前來源與前方件數）。
- `buildPrompt` 新增 `full|compact` 模式，預設每 6 則注入一次 full prompt，其餘走 compact。
- scheduler 的 `executeTask/triggerReflection/dailySummary` 改走同一 queue，優先權低於聊天。
- 最終回覆 `sendMessage` 加入 timeout retry 控制，避免 timeout 後重試重送同內容。

### 影響檔案

- `src/core/execution-queue.ts`
- `src/core/message-pipeline.ts`
- `src/core/scheduler.ts`
- `src/main.ts`
- `src/connectors/telegram.ts`
- `src/types/index.ts`
- `docs/configuration-reference.md`
- `docs/migration-log.md`

### 驗證結果

- `npm run build`：通過。
- `npm run lint`：通過。

### 回滾計畫

- 若要回退 queue 行為，可將 scheduler/chat 的 AI 呼叫改回直接 `agent.chat/summarize`。
- 若要回退 prompt 精簡，可固定使用 full prompt。

### 後續一致性修補（v2.5.28）

- 統一 Gemini/Opencode timeout 文案為 `✨ 10分鐘內未完成`。
- Opencode `chat()` 在非 timeout 錯誤改為 throw，與 Gemini 一致。
- scheduler 的重試判斷改為 provider-agnostic，支援 Gemini/Opencode/runner 錯誤格式。

---

## 2026-03-06 - Web Console UI & UX 進化總結

### 階段

- 完成了從傳統列表介面到現代聊天應用的全面重構。

### 已完成

- 視覺系統升級：深淺色主題、Inter 字體、Indigo 配色。
- 組件精緻化：智慧選單圖示、狀態脈衝動畫、氣泡 Entry 動畫。
- 導覽體驗最佳化：
  - 側邊欄日期時光軸（無限滾動）。
  - 對話視窗向上拉取載入（防跳動錨點演算法）。
  - 時光機跳轉功能（自動背景拉取與 Highlight）。

### 相關文件

- [docs/web-console-ux-evolution.md](file:///home/raybird/Documents/RCodes/moltbot-lite/docs/web-console-ux-evolution.md)

### 驗證結果

- 主要開發項目已全數合併並驗證完畢，對話載入與尋回體感流暢。

---

### 2026-03-21: 算力主權化與基礎設施自癒\n- **算力主權**：成功整合 Chrome Gemini Nano，實現《網格中的幽靈》離線流式生成敘事。\n- **基礎設施**：透過 GitHub API 自主建立獨立 Repo 並啟用 Pages，實現實驗室模組的主權解耦。\n- **規訓對焦**：對齊 Chrome 2026 LanguageModel 頂層物件規範，硬化執行地板。

---

## 2026-03-28 - SAR 檢索穩定化與回歸護欄補強

### 階段

- 針對 SAR 文件、anchor 穩定性、budget trimming 與 metadata 治理做保守收斂。

### 已完成

- 文件校準：
  - 新增 `docs/sar-improvement-plan-minimal.md` 作為最小改動版實作路線。
  - 更新 `docs/summary-aware-retrieval-plan.md`，補上目前實作校準與已知差異。
  - 將 `docs/sar-retrieval-spec-v1.md` 標記為早期草案。
  - 在 `docs/sar-validation-report-v2.6.18.md` 明確標示目前 regression 仍偏人工。
- SAR retrieval 穩定化：
  - `src/prompt/builder.ts` 擴大 anchor 候選池，避免 canonical 規則只受近期 summaries 限制。
  - 移除 canonical 的 30 天硬門檻，改由 recency bias 影響排序。
  - 收斂 budget trimming，保留至少 1 筆 anchor 與 4 筆 recent context。
  - 將 `【記憶參考（TeleNexus SAR）】` 外層標題也納入 context 預算。
- metadata 治理一致化：
  - 抽出 `src/core/summary-metadata.ts`，統一 impact/tag inference 規則。
  - `src/core/message-pipeline.ts` 與 `scripts/backfill-summary-metadata.ts` 改共用同一套規則。
- regression 護欄：
  - `tests/prompt-builder.test.ts` 新增 `gemini / web / release / scheduler / alias query` SAR regression fixtures。
  - `tests/summary-metadata.test.ts` 新增 metadata inference 單元測試。

### 影響檔案

- `docs/sar-improvement-plan-minimal.md`
- `docs/summary-aware-retrieval-plan.md`
- `docs/sar-retrieval-spec-v1.md`
- `docs/sar-validation-report-v2.6.18.md`
- `docs/README.md`
- `src/prompt/builder.ts`
- `src/core/summary-metadata.ts`
- `src/core/message-pipeline.ts`
- `scripts/backfill-summary-metadata.ts`
- `tests/prompt-builder.test.ts`
- `tests/summary-metadata.test.ts`

### 驗證結果

- `npm test`：通過
- `npm run build`：通過

### 回滾計畫

- 若需快速回退，可先回退 `src/prompt/builder.ts` 的 anchor candidate / budget trimming 調整。
- 若需回退 metadata 共用化，可將 `src/core/summary-metadata.ts` 改回 pipeline 與 backfill 各自維護，但不建議長期維持雙份規則。

---

## 2026-03-28 - SAR summary/tag ranking 補強

### 階段

- 針對 `searchSummaries(...)` 的命中品質做小幅強化，讓摘要與 tags 比 content-only 命中更有優先權。

### 已完成

- `src/core/memory.ts`：
  - `searchSummaries(...)` 改為合併兩類候選：
    - `messages_fts` 的 content 命中
    - `summary` / `tags` 的 SQL `LIKE` 命中
  - 新增 query tokenization 與應用層 scoring，讓以下訊號優先：
    - summary 精準命中
    - tag 命中
    - 高 impact level
    - 適度 recency
  - 保留原本 FTS 路徑，避免 retrieval 全面改寫。
- `tests/memory-manager.test.ts`：
  - 新增測試驗證 summary/tag 命中應優先於 content-only 命中。
  - 新增測試驗證即使 content FTS 未命中，只要 summary/tag 命中仍可召回。

### 影響檔案

- `src/core/memory.ts`
- `tests/memory-manager.test.ts`

### 驗證結果

- `npm test`：通過
- `npm run build`：通過

### 回滾計畫

- 若需快速回退，可先將 `searchSummaries(...)` 恢復為原本僅依賴 `messages_fts` content match 的版本。
- 若新 ranking 造成命中偏差，再考慮把 scoring 拆成可配置權重，而不是直接移除 summary/tag 候選合併。

---

## 2026-03-28 - SAR retrieval scoring 常數化

### 階段

- 將 `searchSummaries(...)` 的 ranking 權重與候選池參數集中管理，降低後續調參成本。

### 已完成

- `src/core/memory.ts`：
  - 新增 `SUMMARY_SEARCH_CONFIG`，集中管理：
    - token 上限
    - candidate pool 倍數與最小值
    - summary / content / tag 命中分數
    - impact bonus
    - recency window 與 bonus
  - `scoreSummarySearchResult(...)` 改為完全使用集中設定，不再散落 magic numbers。
  - `searchSummaries(...)` 的候選池大小也改由同一組設定控制。
- `tests/memory-manager.test.ts`：
  - 新增測試，固定「較舊但高訊號的 summary/tag 命中，應優先於較新的弱 content-only 命中」。
  - 確保常數化後 ranking 行為維持穩定。

### 影響檔案

- `src/core/memory.ts`
- `tests/memory-manager.test.ts`

### 驗證結果

- `npm test`：通過
- `npm run build`：通過

### 回滾計畫

- 若需快速回退，可先保留 summary/tag ranking 邏輯，只回退 `SUMMARY_SEARCH_CONFIG` 集中化，恢復成內嵌常數版本。
- 若後續需要更細緻治理，可再把 `SUMMARY_SEARCH_CONFIG` 拆成 env/config 驅動，而不是重新把分數寫回函式內。
