# Issue 0008 實作計畫

驗收劇本、風險與涉及檔案以 [README.md](./README.md) 為準；本檔是任務清單、狀態與證據的唯一來源。

## 現況（2026-10-01 調查）

### 事故

- 一個運行中的 v2.27.3 部署（`opencode-ai@1.15.10`、模型 `opencode/big-pickle`）自 2026-09-17 約 15:00 起，每次呼叫都得到 HTTP 426。訊息先是要求 1.17.0，隔天變成 `OpenCode 1.18.0 or newer is required to use the free tier`。
- 最後一次有文字輸出的回合在 2026-09-17 08:01。到 2026-10-01 14:10 共 545 個失敗回合，以唯讀方式查 `opencode.db` 的 `message.data.error` 得出。
- 同一期間的觀測面：容器 healthy、`provider-status.md` 為 `Model Health: ✅ healthy`、`runner-status.md` 成功率 100%、`error-summary.md` 沒有相關項目、兩個 `model-health-state*.json` 都是 `healthy`。
- `events.jsonl` 的 `opencode_done` 每筆都是 `outputLen: 736`、`upstreamInvalid: false`。輸出長度固定，是 v2.27.2 記錄過的同一種指紋。

### 為什麼沒有被抓到

- `src/core/opencode.ts:430` 以 `hasUpstreamModelInvalid(stderr)` 計算 `upstreamInvalid`。`UPSTREAM_MODEL_INVALID_PATTERN`（`src/core/rate-limit.ts:41`）只認 410、`end of life`、`ProviderModelNotFoundError` 與 `Model not found`。
- `isRealSuccessEvent()`（`src/services/model-health-check.ts:256`）把 `upstreamInvalid !== true` 的 `opencode_done` 都當成真實成功，用來豁免探測。
- `interpretProbeOutput()`（同檔 229 行）在未命中 429 與失效樣式時，只看 exit code。
- `interpretEvent()`（`src/core/opencode-event-parser.ts:93`）處理 `step_start`、`tool_use`、`text`、`reasoning`、`step_finish`，沒有 `error`。

v2.27.3 的 CHANGELOG 記錄了這個缺口，當時決定暫不做結構化 error 解析。這次事故是同一個缺口換了狀態碼。

### 取捨：結構化判定，而不是再補一個狀態碼

把 426 加進樣式是最小改動，但逐一列舉狀態碼已經漏過 410 與 426 兩次，下一個未列舉的狀態碼仍會重演。使用者於 2026-10-01 選定結構化判定：任何上游 `error` 事件都代表這個回合失敗，狀態碼只用來決定分類與訊息。

## 設計方案

具體命名與介面可由 execute-task 依步驟 1 的實測調整，等價的寫法不視為規格變更。

### 事件解析

- `interpretEvent()` 遇到 `type: 'error'` 的事件時，回傳上游錯誤的資訊：狀態碼（整數，可能不存在）、錯誤名稱與訊息。只做解析，不新增可渲染的事件型別。
- 判定只依事件的型別與欄位，不對文字內容做比對。正常回覆裡出現「426」或「error」不會誤觸。

### 回合的失敗判定

- `AgentFailureKind` 新增上游錯誤的種類（暫定 `upstream-error`），`AgentFailure` 帶上狀態碼。
- 串流（`cli-agent-base.ts`）與非串流（`opencode.ts`）兩條路徑都在看到上游錯誤時設定 `failure`，並回傳含狀態碼的友善訊息。現有「沒有任何輸出」的分類只留給真的沒有事件的情況。
- `recordRuntimeIssue('opencode:upstream-error:<statusCode>', ...)`，讓四個觀測面都記到。
- `deriveRunOutcome()` 不用改：它已經把任何 `failure` 轉成 `ok: false`，並且不觸發斷路器。上游錯誤在本地執行一樣會發生，這個語意維持。
- `opencode_done` 帶上「這個回合有上游錯誤」的旗標，`isRealSuccessEvent()` 據此排除。既有的 `upstreamInvalid` 欄位保留，避免動到事件的既有讀者。

### 與既有樣式的分工

- 429 的快速中止靠 stderr 即時比對（`abortOnStderr`），opencode 卡在重試時 stdout 沒有任何事件，這條路維持不變。
- 410 與 model not found 的 stderr 樣式保留作為第二道，因為 `Model not found` 是 exit 1、不一定有 `error` 事件。
- 狀態碼到分類的對應集中在一處：429 為限流、410 與 404 為模型失效、426 為客戶端版本過舊、其餘為一般上游錯誤。

### 健康檢查

- 探針改以 `--format json` 執行並解析事件，有上游錯誤事件即為不健康。分類沿用上面的對應。
- 426 的告警訊息指出要升級 opencode，而不是暗示模型下架。
- 告警簽章包含狀態碼，狀態碼改變時視為新的故障並立即推播。

### scripts/probe-models.mjs

與 TypeScript 端同步：辨識 `error` 事件並依狀態碼標示。這支腳本必須能在沒有原始碼的 release 映像裡執行，所以判定邏輯仍是刻意的複本，兩處一起改。

### 升釘版

`Dockerfile` 的 `opencode-ai@` 改為步驟 1 驗證過的版本。釘版本身維持（映像要可重現），但 `CLAUDE.md` 要寫明上游會抬高最低版本，升釘版是例行維護。

## 測試策略

| 驗收    | 層級                                        | 證據                                                                                          |
| ------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| SCN-001 | 整合測試（以 fixture 驅動 agent）加單元測試 | 紅綠重構證據；斷言使用者訊息、`failure`、runtime issue 與 `opencode_done` 的旗標              |
| SCN-002 | 整合測試                                    | 同一份 fixture 分別走串流與非串流，斷言結果相同                                               |
| SCN-003 | 單元測試（探針判定與狀態機）                | 紅綠重構證據；含「假成功不豁免探測」                                                          |
| SCN-004 | 既有測試加新斷言                            | `opencode-rate-limit-failfast`、`model-health-check` 等既有測試維持綠燈；410 fixture 的新斷言 |
| SCN-005 | 單元測試                                    | 以內容含「426」「error」的正常回合 fixture 斷言不誤判                                         |
| SCN-006 | 實地驗證                                    | 以升版後的映像只啟動 agent-runner，打一次 `/run`；記錄回覆長度與事件型別分布                  |
| SCN-007 | 腳本層測試或實跑                            | 以 fixture 或真實失效模型執行 `probe-models.mjs`，記錄輸出                                    |

fixture 的期望值來自步驟 1 擷取的真實輸出，不由測試重算。

SCN-006 是實地觀測。反向自檢：呼叫失敗時，回覆會是錯誤訊息且事件裡有 `error`，與成功時不同。對照組用現行 1.15.10 的映像打同一個請求，預期得到 426。

## 實作步驟

1. 📝 **新版 opencode 的相容性探測與 fixture**（SCN-004、SCN-006）
   - 產出：候選版本的行為紀錄與去敏的事件 fixture，存於本目錄 `evidence/` 與 `tests/` 的 fixture 位置；TBD-1 的結論。
   - 相依：無。
   - 完成判準：以下每一項都有實際輸出為證，並與現有假設逐項比對：正常回合的事件型別與欄位（`sessionID`、`part.text`、`part.tool`、`step_finish` 的 `tokens`／`cost`／`reason`）；上游錯誤回合的 `error` 事件結構與 exit code（至少取得現行 1.15.10 的 426 樣本）；`-c`、`--model`、`--format json`、`--print-logs --log-level ERROR` 仍被接受；`--print-logs` 的 stderr 是否仍含 `"statusCode":429` 這類結構化欄位。有差異的項目都寫明處理方式。
2. 📝 **事件解析與回合失敗判定**（SCN-001、SCN-002、SCN-005）
   - 產出：`opencode-event-parser.ts`、`agent-result.ts`、`opencode.ts`、`cli-agent-base.ts` 的變更與對應測試。
   - 相依：步驟 1。
   - 完成判準：以步驟 1 的 426 fixture，先取得「回合被記為成功、訊息是沒有任何輸出」的紅燈，再實作至綠燈；串流與非串流對同一份 fixture 的結果相同；內容含「426」「error」的正常回合 fixture 判為成功；`npm run build`、`npm run test`、`npm run lint` 都是 exit 0。
3. 📝 **健康檢查與真實成功的判定**（SCN-003、SCN-004）
   - 產出：`model-health-check.ts` 的變更與測試。
   - 相依：步驟 2。
   - 完成判準：探針對 426 fixture 判為不健康，訊息含狀態碼與升級提示（先紅後綠）；帶上游錯誤旗標的 `opencode_done` 不被 `isRealSuccessEvent()` 採信；429 與 410 的既有測試維持綠燈；狀態碼改變時簽章不同。
4. 📝 **`probe-models.mjs` 同步**（SCN-007）
   - 產出：`scripts/probe-models.mjs` 的變更。
   - 相依：步驟 2（對應表定案）。
   - 完成判準：對上游錯誤的輸出標示不可用並列出狀態碼；`CLAUDE.md` 提到的兩處複本內容一致。
5. 📝 **升釘版並以真實呼叫驗證**（SCN-006）
   - 產出：`Dockerfile` 的釘版變更與實測紀錄。
   - 相依：步驟 1、2。啟動容器屬 `docs/agents/project.md` 列的使用者決定事項，執行前取得同意；只啟動 agent-runner，不連 Telegram。
   - 完成判準：升版後的映像經 `/run` 完成一次真實請求並得到含文字的回覆；對照組（1.15.10）得到 426 且被新的判定記為失敗；`tests/docker/` 的測試為綠。
6. 📝 **文件更新**（SCN-001、SCN-003）
   - 產出：`CLAUDE.md` 的 Observability 段落（Degraded results、Model health check、上游錯誤的判定依據與升釘版是例行維護）；有新增設定時更新 `docs/configuration-reference.md` 與 `.env.example`。
   - 相依：步驟 2、3。
   - 完成判準：文件描述與實作一致；`CLAUDE.md` 中「樣式只認結構化欄位」的敘述已反映 stdout 事件與 stderr 樣式的分工。發版說明（`CHANGELOG.md`）在發版時由維護者處理。

## 風險與首要驗證

見 [README.md](./README.md) 的「風險與首要驗證」。步驟 1 即首要驗證。

次要風險：`interpretEvent()` 由串流與非串流共用，改動會影響每一個回合。GitNexus 的 impact 在這個 repo 會低報呼叫者（見 `docs/agents/project.md`），動手前以 grep 另外確認呼叫點。

## 檢查清單

- [ ] 步驟 1 的探測在改任何程式之前完成
- [ ] fixture 已去敏（無 token、使用者 ID、本機路徑、對話內容）
- [ ] `scripts/probe-models.mjs` 與 TypeScript 端的判定一起改
- [ ] `docker-compose.yml`、`docker-compose.release.yml`、`release.yml` 沒有變更
- [ ] 依 `docs/agents/project.md` 的常青文件對照更新受影響的文件
