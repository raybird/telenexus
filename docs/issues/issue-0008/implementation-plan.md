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

> NOTE（2026-10-01，步驟 1 的實測推翻了上面兩點的前提，細節見 [evidence/step1-compat-probe.md](./evidence/step1-compat-probe.md)）
>
> - opencode 1.18 在上游錯誤時以 exit 1 結束（1.15 是 exit 0），stdout 的 `error` 事件結構不變。判定要同時涵蓋兩種結束方式：exit 非 0 時從 `ProcessError` 帶出的 stdout 解析事件。
> - 1.18 的 `--print-logs` 改成 logfmt，stderr 不再有 `"statusCode":NNN`，也不再回吐 request body。429 的快速中止因此不能「維持不變」：`UPSTREAM_RATE_LIMIT_PATTERN` 要增加一個分支，認主代理（`small=false`）的 `stream error` 行裡、`error.error` 欄位內的限流字樣。舊格式的分支保留。
> - 410 在 1.18 的 stderr 只剩 `Gone`，改由 `error` 事件的 `statusCode` 判定。stderr 的失效樣式只剩 `Model not found` 這條路在用，它的 `error` 事件不帶狀態碼。
> - `error` 事件可能沒有 `statusCode`（`UnknownError`）。沒有狀態碼的錯誤事件一樣判為失敗，分類為一般上游錯誤。

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

1. ✅ **新版 opencode 的相容性探測與 fixture**（SCN-004、SCN-006）
   - 證據（2026-10-01，被測提交 `da76420`）：[evidence/step1-compat-probe.md](./evidence/step1-compat-probe.md)，樣本清單在 [evidence/step1-samples.txt](./evidence/step1-samples.txt)，fixture 在 `tests/fixtures/opencode/`。結論：參數與事件格式相容；三項差異（exit code、stderr 格式、410 的 stderr）的處理方式併入步驟 2 至 4；TBD-1 定為 1.18.34。
   - 產出：候選版本的行為紀錄與去敏的事件 fixture，存於本目錄 `evidence/` 與 `tests/` 的 fixture 位置；TBD-1 的結論。
   - 相依：無。
   - 完成判準：以下每一項都有實際輸出為證，並與現有假設逐項比對：正常回合的事件型別與欄位（`sessionID`、`part.text`、`part.tool`、`step_finish` 的 `tokens`／`cost`／`reason`）；上游錯誤回合的 `error` 事件結構與 exit code（至少取得現行 1.15.10 的 426 樣本）；`-c`、`--model`、`--format json`、`--print-logs --log-level ERROR` 仍被接受；`--print-logs` 的 stderr 是否仍含 `"statusCode":429` 這類結構化欄位。有差異的項目都寫明處理方式。
2. ✅ **事件解析與回合失敗判定**（SCN-001、SCN-002、SCN-004、SCN-005）
   - 證據（2026-10-01）：紅燈 [evidence/step2-red.txt](./evidence/step2-red.txt)（被測提交 `9ed35ff`，14 個測試 12 個失敗；非串流的 426 回合沒有 `failure`、串流丟出通用例外或走空輸出追問、429 的 stderr 等到 8 秒保險絲才以逾時結束）。綠燈 [evidence/step2-green.txt](./evidence/step2-green.txt)（最小實作與精煉後同一次執行：新測試 16／16、`npm run test` 300／300 共 47 個檔、`build` 與 `lint` exit 0）。
   - 單迴圈合併：`tests/opencode-upstream-error.test.ts` 以假的 `opencode` 執行檔吐回 fixture，讓真正的 `OpencodeAgent` 走完串流與非串流兩條路徑，同一層就涵蓋了解析、失敗判定、runtime issue 與 `opencode_done`；`interpretEvent` 另有兩個單元測試。runner 的 audit 以 `deriveRunOutcome()` 的結果斷言，沒有啟動 runner 的 HTTP 服務。
   - 紅燈之後對測試的修改：runtime issue 的觀察方式從 issue hook 改成比對累計次數（同一個 scope 與訊息在 60 秒內重複時不再呼叫 hook，連續測試會漏看）；另外新增兩個測試（已產出的文字保留在說明之前、exit 1 且沒有 error 事件時仍丟出例外且不發 `opencode_done`）。斷言的期望值沒有放寬。
   - 精煉：非串流原本用一個帶布林旗標的輔助函式同時處理兩條結束路徑，改成「找事件」與「發事件」兩個步驟由呼叫點組合；精煉後重跑的就是上面的綠燈。
   - 與設計方案的出入：404 沒有歸為模型失效，理由見 `src/core/rate-limit.ts` 的 `classifyUpstreamStatus()`（非對話類模型打錯端點也回 404，說成下架會講錯原因）。404 的回合一樣判為失敗，只是說明文字用一般上游錯誤。串流路徑原本自帶的寬鬆限流樣式改成與非串流共用 `UPSTREAM_RATE_LIMIT_PATTERN`，否則串流在 1.18 上認不得 `Rate limit exceeded`。
   - 產出：`opencode-event-parser.ts`、`agent-result.ts`、`opencode.ts`、`cli-agent-base.ts`、`rate-limit.ts` 的變更與對應測試。
   - 相依：步驟 1。
   - 完成判準：以步驟 1 的 426 fixture，先取得「回合被記為成功、訊息是沒有任何輸出」的紅燈，再實作至綠燈；串流與非串流對同一份 fixture 的結果相同；內容含「426」「error」的正常回合 fixture 判為成功；`npm run build`、`npm run test`、`npm run lint` 都是 exit 0。
   - 步驟 1 追加（SCN-001、SCN-004）：exit 1 的 426 fixture（1.18 的行為）與 exit 0 的得到相同結果；限流樣式命中 1.18 的兩份 429 stderr fixture（先紅後綠），不命中 500 與 426 的 stderr fixture，也不因模型名裡的數字命中。
3. ✅ **健康檢查與真實成功的判定**（SCN-003、SCN-004）
   - 證據（2026-10-01）：紅燈 [evidence/step3-red.txt](./evidence/step3-red.txt)（被測提交 `51c7399`，11 個測試 7 個失敗；第 1 個就是事故本身：exit 0 的 426 被探針判為健康）。綠燈 [evidence/step3-green.txt](./evidence/step3-green.txt)（新測試加上既有的健康檢查與 429 測試共 69／69、`npm run test` 311／311 共 48 個檔、`build` 與 `lint` exit 0）。
   - 單迴圈合併：`tests/model-health-upstream-error.test.ts` 以 fixture 驅動 `interpretProbeOutput()`，再經 `startModelHealthCheck()` 斷言推播文字與狀態檔；`defaultProbe()` 另以假的 `opencode` 執行檔確認它帶 `--format json`。探針判定、狀態機與告警文字在同一層就能觀察，沒有另一層整合責任。
   - 紅燈時已是綠的 4 個測試是既有行為的保護網：「帶上游錯誤的 `opencode_done` 不豁免探測」在步驟 2 已實作；模型不存在、限流次數、正常回合三項是 SCN-004 與 SCN-005 的不退化斷言。
   - 精煉：`findUpstreamError()` 從 `opencode.ts` 移到 `opencode-event-parser.ts`，健康檢查不必為了解析事件而依賴整個 agent 模組；移動後重跑的就是上面的綠燈。
   - 沒有處理的既有行為：持續限流時 opencode 會重試到探針的 120 秒逾時，結果是 `unknown`（「無法確認」）而不是限流。兩個 opencode 版本都是如此，告警仍會發出，不在本 issue 範圍。
   - 產出：`model-health-check.ts` 的變更與測試。
   - 相依：步驟 2。
   - 完成判準：探針對 426 fixture 判為不健康，訊息含狀態碼與升級提示（先紅後綠）；帶上游錯誤旗標的 `opencode_done` 不被 `isRealSuccessEvent()` 採信；429 與 410 的既有測試維持綠燈；狀態碼改變時簽章不同。
4. ✅ **`probe-models.mjs` 同步**（SCN-007）
   - 證據（2026-10-01）：紅燈 [evidence/step4-red.txt](./evidence/step4-red.txt)（被測提交 `4320835`，9 個測試 7 個失敗；exit 0 的 426 被歸為 `empty-output`，正是驗收劇本要排除的結果）。綠燈與實跑 [evidence/step4-green.txt](./evidence/step4-green.txt)：腳本層測試 9／9；以真實上游實跑，opencode 1.15.10 得到「需升級 opencode、上游回 HTTP 426」且腳本 exit 1，對照組 1.18.34 得到「可用」且 exit 0；`npm run test` 320／320 共 49 個檔、`build` 與 `lint` exit 0。
   - 單迴圈合併：腳本一載入就執行 `main()`、沒有可匯入的函式，`tests/probe-models-script.test.ts` 直接執行腳本並放一支吐回 fixture 的假 `opencode`，判定與輸出都在這一層觀察。
   - 複本一致：測試從腳本原始碼取出 `RATE_LIMIT_PATTERN` 的字串，與 `UPSTREAM_RATE_LIMIT_PATTERN.source` 比對相等。下架樣式移除了腳本裡殘留的裸 `Gone`（TypeScript 端在 v2.27.3 已移除），兩邊現在認同一組訊號；410 改由 error 事件判定，不受影響。
   - 精煉：no-op。新增的是一個事件擷取函式與一張對應表，沒有可以再簡化而不損可讀性的地方，沿用同一份綠燈。
   - 產出：`scripts/probe-models.mjs` 的變更。
   - 相依：步驟 2（對應表定案）。
   - 完成判準：對上游錯誤的輸出標示不可用並列出狀態碼；`CLAUDE.md` 提到的兩處複本內容一致（含步驟 2 更新後的限流樣式）。
5. ✅ **升釘版並以真實呼叫驗證**（SCN-006）
   - 證據（2026-10-01，被測提交 `984c5b0`）：[evidence/step5-image-verification.md](./evidence/step5-image-verification.md)。以升版後的映像只啟動 agent-runner，`/run` 得到模型的文字回覆、沒有 `failure`、`opencode_done` 的 `upstreamError` 為 `false`、audit 為 `ok: true`。對照組（同一份程式加 opencode 1.15.10）得到 426，被記為 `upstream-error`、audit `ok: false`、成功率 0.0%、健康檢查 `failing`（`client-outdated:426`）。`npx tsx --test tests/docker/*.test.ts` 5／5、`npm run test` 320／320。
   - 觀測式驗收的反向自檢與判準寫在證據檔；對照組就是「失敗時判準會呈現什麼」的實測。
   - 使用者於 2026-10-01 同意以隔離方式建置映像並啟動 agent-runner；驗證後容器與映像都已移除，正式部署沒有被碰到。
   - 驗證過程另外觀察到健康探針與聊天共用 opencode session，新舊版行為相同，不屬於本 issue，見 README 的 TBD-4。
   - 產出：`Dockerfile` 的釘版變更與實測紀錄。
   - 相依：步驟 1、2。啟動容器屬 `docs/agents/project.md` 列的使用者決定事項，執行前取得同意；只啟動 agent-runner，不連 Telegram。
   - 完成判準：升版後的映像經 `/run` 完成一次真實請求並得到含文字的回覆；對照組（1.15.10）得到 426 且被新的判定記為失敗；`tests/docker/` 的測試為綠。
6. ✅ **文件更新**（SCN-001、SCN-003）
   - 證據（2026-10-01）：純文件變更，沒有可執行行為，以靜態檢查替代：`npx prettier --check CLAUDE.md ARCHITECTURE.md README.md` 通過；逐段對照實作——`CLAUDE.md` 的 Key Modules 兩列、Empty output handling、新增的 Upstream error events、Degraded results（`upstream-error`）、Upstream 429 fail-fast（兩代格式的分工與未涵蓋的措辭）、Model health check（`--format json` 與 `client-outdated`）、新增的 opencode pin。文中的版本敘述只寫實測過的版本（1.15.10、1.18.0、1.18.17、1.18.34）。
   - 依 `docs/agents/project.md` 的常青文件對照另外更新了 `ARCHITECTURE.md`（事件解析與 agent 基底的職責）與 `README.md`（主動告警的範圍、上游錯誤如實回報）。沒有新增設定，`docs/configuration-reference.md` 與 `.env.example` 不需要改。
   - 產出：`CLAUDE.md` 的 Observability 段落（Degraded results、Model health check、上游錯誤的判定依據與升釘版是例行維護）；有新增設定時更新 `docs/configuration-reference.md` 與 `.env.example`。
   - 相依：步驟 2、3。
   - 完成判準：文件描述與實作一致；`CLAUDE.md` 中「樣式只認結構化欄位」的敘述已反映 stdout 事件與 stderr 樣式的分工。發版說明（`CHANGELOG.md`）在發版時由維護者處理。

## 風險與首要驗證

見 [README.md](./README.md) 的「風險與首要驗證」。步驟 1 即首要驗證。

次要風險：`interpretEvent()` 由串流與非串流共用，改動會影響每一個回合。GitNexus 的 impact 在這個 repo 會低報呼叫者（見 `docs/agents/project.md`），動手前以 grep 另外確認呼叫點。

## 檢查清單

- [x] 步驟 1 的探測在改任何程式之前完成
- [x] fixture 已去敏（無 token、使用者 ID、本機路徑、對話內容）
- [x] `scripts/probe-models.mjs` 與 TypeScript 端的判定一起改
- [ ] `docker-compose.yml`、`docker-compose.release.yml`、`release.yml` 沒有變更
- [x] 依 `docs/agents/project.md` 的常青文件對照更新受影響的文件
