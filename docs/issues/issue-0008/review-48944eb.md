# 審查報告

- 範圍：完整交付範圍（本機流程，未開 PR）；`git diff <BASE> <HEAD>` 共 45 個檔
- Reviewed BASE SHA：`da76420420c49e35eb0020d5fd9ac889da21d761`
- Reviewed HEAD SHA：`48944eb1ba2882b661d88a8e7cea73019447be8d`
- Reviewed patch-id：`8a1f09a5d5f7dd26ec91feccb4bfda2a8bc1b757`（以 `git diff <BASE> <HEAD> | git patch-id --stable` 重算相符）
- 獨立 reviewer：宿主隔離的 subagent（Claude Code，獨立 context），不是本段變更的實作者；沒有採信實作者的結論，判斷來自自行閱讀 diff、規格、證據與自行執行的命令
- Review artifact：`docs/issues/issue-0008/review-48944eb.md`
- 審查日期：2026-10-01
- 風險：High（依 issue README）
- 審查前狀態：`git rev-parse HEAD` 等於上列 HEAD，工作區乾淨

## 問題與風險

### MUST FIX

#### M1. 串流路徑：error 事件與前一個事件落在同一批 stdout 時，上游錯誤會被漏掉，回合被記為成功

- 位置：`src/core/cli-agent-base.ts:262-319`（stdout 的 `data` 處理）、`:284-287`（註解與指派）、`:341-390`（`close` 處理）
- 現象（已親自重現，3 次執行結果相同）：`data` 處理對每一批資料開一個 async 迴圈逐行處理，`close` 處理不等這個迴圈跑完。新增的 `upstreamError` 指派只保證「正在處理的那一行」在它自己的 await 之前被記下；同一批資料裡排在後面的行，要等前面那一行的 `await onEvent(...)` 回來才會被處理。`close` 若在這段等待中觸發，就看不到 error 事件。
- 重現方式：repo 外的一次性腳本，假的 `opencode` 先輸出 `step_start`，0.5 秒後一次輸出兩行（`text` 或 `tool_use`，接著 426 的 `error` 事件）後立即結束；`onEvent` 對 `delta`／`status` 等 50ms（對應 `src/core/telegram-stream-renderer.ts:459-490` 的 Telegram 編輯訊息，那是網路 I/O）。輸入用的都是 `tests/fixtures/opencode/` 的原始行。

  | 同一批 stdout        | exit | 回呼       | 結果                                                                    |
  | -------------------- | ---- | ---------- | ----------------------------------------------------------------------- |
  | `text` + `error`     | 1    | 慢（50ms） | **`failure` 不存在、`deriveRunOutcome().ok === true`、文字只有 `OK`**   |
  | `text` + `error`     | 0    | 慢         | 同上：記為成功，沒有上游錯誤說明                                        |
  | `tool_use` + `error` | 1    | 慢         | 丟出通用的 `Error calling opencode: exit=1`，沒有狀態碼、沒有結構化失敗 |
  | `tool_use` + `error` | 0    | 慢         | 走 `tool_only` 追問，多打一次 opencode                                  |
  | `text` + `error`     | 1    | 同步       | 正確：`upstream-error`、426、文字保留在說明前                           |
  | 只有 `error`         | 0／1 | 慢         | 正確                                                                    |

- 為什麼列為 MUST FIX：核准來源寫的是「把**任何**上游 error 事件都判為失敗回合」。這個情境下 error 事件確實在 stdout 裡，回合卻被記成成功且沒有 runtime issue，正是本 issue 要消除的那一類結果；`:284` 的註解宣稱已處理 `close` 與迴圈的先後問題，實際只處理了一半。`tests/opencode-upstream-error.test.ts:245` 的「已經產出的文字保留在上游錯誤說明之前」用的就是這種輸入形狀，但回呼是同步的（`:118-120`），所以它的綠燈不代表正式環境的 Telegram 串流路徑。
- 影響範圍的校準（請一併考量）：
  - 需要三個條件同時成立：走本地串流（`CHAT_USE_RUNNER_PERCENT` 小於 100，或斷路器開啟後退回本地；runner 的 SSE 回呼是同步的，`src/runner.ts:585-604`，不受影響）、error 事件與前一個 `text`／`tool_use`／`reasoning` 事件被同一次 pipe 讀取帶上來、當下有 Telegram 編輯在進行。
  - 事故本身的形狀（stdout 只有一個 error 事件）不受影響，健康檢查探針走的是另一條路，也不受影響。所以這個洞不會讓 2026-09-17 那種「全面失效卻全綠」重演，影響是單一回合被誤記。
  - 真實的 opencode 會不會把這兩種事件寫在同一批，我沒有辦法驗證（不能執行 opencode）。這是推論不出機率、但確定可重現的邏輯缺陷。
  - 根因是既有設計：同一個競態在修改前就會讓正常回合的文字遺失（我以 `9ed35ff` 的原始碼重現：整個正常回合一次輸出加上慢回呼，會被當成 `tool_only` 而多追問一次）。本次變更沒有引入這個競態，但新功能建立在它上面而沒有完全避開。
- 建議：擇一即可。
  1. 在進入 async 迴圈之前，先同步掃過這一批的所有行，把 `upstreamError`（與 `sessionId`）記下來，再逐行做需要 await 的事。改動最小，只修 error 事件。
  2. 把各批的處理串成一條 promise chain，`close` 處理先 await 它再做判定。這同時修掉既有的文字遺失，但牽動較大，可以另開 issue。
  - 不論採哪一種，補一個「回呼是 async 且有延遲」的回歸測試（`text` + `error`、`tool_use` + `error` 各一），並把 `:284` 的註解改成與實作相符。

### SHOULD FIX

#### S1. 健康檢查的失敗簽章在 opencode 1.18 的 stderr 格式下每次都不同，模型不存在時會每小時推播一次

- 位置：`src/services/model-health-check.ts:105-115`（`failureSignature`）、`:305-307` 與 `:317`（訊息取自 stderr 開頭）
- 現象（已親自驗證）：簽章是「類別 + 訊息前 120 字的雜湊」。沒有狀態碼的路徑（模型不存在、無法歸因）訊息取自 stderr，而 1.18 的 logfmt 每行以 `timestamp=… level=ERROR run=<隨機 id>` 開頭。把 `1.18.34-model-not-found.stderr.txt` 的時間戳與 run id 換掉後再判定一次，簽章從 `model-invalid:-1051607887` 變成 `model-invalid:-1293035801`，`decideAlert()` 在一小時後回 `changed-failure` 而不是壓抑到 6 小時的提醒。`rate-limited` 的訊息含命中次數（5 次與 3 次的簽章不同），也有同樣的效果。
- 我沒有確認的部分：1.15.10 的舊格式是不是也在開頭帶時間戳（repo 裡沒有舊格式的完整樣本）。如果是，這就是既有行為而不是升版造成的退化。不論哪一種，步驟 1 的相容性比對沒有把「簽章依賴 stderr 開頭」列為現有假設之一。
- 連帶：`:102-103` 的註解說沒有狀態碼時維持兩段格式「升級當下狀態檔裡的舊簽章才對得上」。升級同時換了 opencode 版本，stderr 格式整個不同，訊息來源也從 stdout 加 stderr 變成只有 stderr，這個前提不成立；實際效果是升級當下若正在故障中，會多推一次。影響很小，但註解的理由站不住。
- 建議：簽章只取類別與狀態碼，或在取雜湊前去掉 `timestamp=`、`run=` 這類每次都變的欄位；補一個「同一故障、不同時間戳」的測試。

#### S2. `CLAUDE.md` 有三處敘述與實作或證據不符

- `CLAUDE.md:160`（opencode pin）：寫「the event schema, the exit code on upstream errors and the `--print-logs` format have all changed between releases」。步驟 1 的結論是事件型別與欄位**相符**（`evidence/step1-compat-probe.md` 的比對表），變的只有 exit code 與 stderr 格式。
- `CLAUDE.md:152`（Upstream error events）：寫串流與非串流兩條路徑的結果都包含「`opencode_done` carries `upstreamError: true`」。`opencode_done` 只在 `src/core/opencode.ts:367` 發出，串流路徑從頭到尾不發這個事件（我以實驗確認：只有 error 事件的串流回合，收到的 `opencode_done` 是空集合）。結論「不會豁免下一次探測」是對的，但原因是串流根本沒有事件可以餵豁免視窗。
- `CLAUDE.md:158`（Model health check）：寫「410 … 426 … anything else as `upstream-error`」。429 的 error 事件會被 `classifyUpstreamStatus()` 歸為 `rate-limited`（已驗證：`{ category: 'rate-limited', statusCode: 429 }`）。
- 建議：三處照實作改寫。

#### S3. 步驟 5（SCN-006）的證據只有彙整表，沒有保存原始輸出

- 位置：`docs/issues/issue-0008/evidence/step5-image-verification.md`
- 判準與反向自檢本身成立（見下方 SCN-006）。但 `/run` 的回應 JSON、`events.jsonl` 與 `runner-audit.log` 的原始行、建置對照組映像的命令、讀取這些檔案的命令都沒有留下，表格裡的每一格都是實作者轉述。映像與容器已移除，任何人都無法再核對。`docs/agents/verification.md` 對觀測式驗收要求記錄「命令或查詢原文、實際數值」。
- 這是證據持久力的問題，不是假綠燈：不影響本次對 SCN-006 的判定，但建議下次發版前的實地驗證把去敏後的原始輸出一併存檔。

#### S4. 步驟 2、3 的綠燈把「最小實作後」與「精煉後」合併成一筆，而精煉不是 no-op

- 位置：`docs/issues/issue-0008/implementation-plan.md:95`、`:98`、`:105`、`:108`
- `docs/agents/verification.md` 的紅綠重構證據是四段，只有在重構為 no-op 時才能用同一份綠燈。步驟 2 的精煉改了非串流的結構、步驟 3 搬移了 `findUpstreamError()`，兩者都不是 no-op，但只記錄了精煉後的一次綠燈。
- 實作者如實寫明了「同一次執行」，沒有隱瞞。精煉前的狀態沒有提交，這一段已經補不回來；最終狀態我已獨立重跑為綠。列為流程紀錄的缺口，不阻塞。

#### S5. `step4-green.txt` 記錄的命令與輸出對不上

- 位置：`docs/issues/issue-0008/evidence/step4-green.txt:21-24`、`:34-37`
- 記錄的命令是 `node scripts/probe-models.mjs --models opencode/big-pickle`，輸出卻是「預估最長耗時: 120 秒」與「180 秒」。腳本的預設逾時是 240 秒（`scripts/probe-models.mjs:39`，這次沒有改），照記錄的命令應該印 240。實際執行時應該另外帶了 `--timeout`。
- 判定結果（426 對「需升級 opencode」、對照組「可用」）不受影響，但「實際命令」這一欄不精確。建議補上真正的命令列。

### NICE TO HAVE

- **N1. 兩條路徑對「逾時／限流中止」與「error 事件」同時出現時的優先順序不同。** 串流是 error 事件優先（`src/core/cli-agent-base.ts:379` 在 `:392` 之前）；非串流是 `ERATELIMIT`、`ETIMEDOUT` 優先，之後才看 stdout（`src/core/opencode.ts:487-499` 在 `:504` 之前）。opencode 吐出 error 事件後卡住不結束、最後被逾時砍掉時，兩邊會給出不同的失敗種類。沒有測試涵蓋，影響很小。
- **N2. 429 以 error 事件出現時，scope 是 `opencode:upstream-error:429`、`failure.kind` 是 `upstream-error`。** `error-summary.md` 的「Rate-limit Issues (24h)」只篩 `opencode:rate-limit`（`src/services/context-snapshots.ts:135`），這類 429 不會算進去。給使用者的文字仍是限流的說法。
- **N3. `scripts/probe-models.mjs` 的複本守門只涵蓋限流樣式。** `:232-234` 的下架與模型不存在樣式、`verdictForStatus()` 的對應表都沒有對應的一致性測試。另外 `:187` 用 `line.startsWith('{')` 而 TypeScript 端會先 `trim()`：行首有空白時兩邊判定不同（已驗證：TS 判 `client-outdated:426`，腳本判 `error`）。真實輸出沒有行首空白，屬防禦性差異。
- **N4. 限流樣式的新分支。** `rate[ -]?limit` 會命中「rate limiter」（已驗證：`AI_APICallError: internal error in rate limiter service` 會被判為限流）；上游訊息在限流字樣之前含有跳脫引號時不會命中（已驗證），回合會退避到逾時。後者在 TBD-3 的範圍內。
- **N5. `README.md:32` 寫告警「附上狀態碼」。** 只有 error 事件帶狀態碼時才有；模型不存在、探針逾時、持續限流（1.18 上會撞到 120 秒逾時而得到「無法確認」，計畫已揭露）都沒有。
- **N6. `tests/fixtures/opencode/1.15.10-upstream-426.stdout.jsonl` 保留了真實回應的 `cf-ray`、`cf-placement` 標頭。** 不是憑證，敏感度低；fixture README 要求不手改，保留也說得通。提出來讓維護者知情。
- **N7. 範圍外的觀察（都是既有行為，本次沒有改變）。** 本地執行時 `recordPromptSessionTrace` 仍記 `ok: true`（`src/core/message-pipeline.ts:317`）；排程對上游錯誤的回覆不重試，記為 `schedule_done`（`src/core/scheduler-helpers.ts` 的 `assessAiResponse` 不看 `failure`）；上游錯誤說明會被當成模型回覆存進記憶並同步到 Memoria。這些與既有的逾時、限流降級結果一致，驗收劇本沒有涵蓋，建議與 TBD-4 一起評估要不要另開 issue。

## 已查核維度

### 驗收與證據

核准基線：`git diff e8f490c 48944eb -- docs/issues/issue-0008/README.md` 的差異只有涉及檔案補列兩行、核准 commit 回填、待確認事項、Gate 豁免紀錄與狀態欄。Gherkin 區塊一字未改，原核准有效。

紅燈我用另一種方式獨立重現：把 `9ed35ff`、`51c7399`、`4320835` 三個提交各自展開到 repo 外的暫存目錄，放進 HEAD 的最終版測試檔後執行。

| 驗收    | 證據位置                                                                                                                              | 我的查核                                                                                                                                                                                                                                                                                 | 結論                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| SCN-001 | `tests/opencode-upstream-error.test.ts`；`evidence/step2-red.txt`、`step2-green.txt`；`evidence/step5-image-verification.md` 的對照組 | 紅燈重現：`9ed35ff` 上 16 個測試 13 個失敗，失敗原因是 `upstreamError` 為 `undefined`、回合走空輸出追問或丟通用例外，都來自缺少目標行為。綠燈重現：HEAD 16／16。期望值是字面值（426、`APIError`、上游原文）。runner audit 以 `deriveRunOutcome()` 斷言，實際的 audit 行只在步驟 5 觀察到 | 通過（串流的例外情境見 M1）  |
| SCN-002 | 同上，「串流與非串流對同一份輸出的判定一致」兩個測試                                                                                  | 劇本的 Given 是「只含 error 事件的輸出」，這個形狀兩條路徑一致，已重現                                                                                                                                                                                                                   | 通過                         |
| SCN-003 | `tests/model-health-upstream-error.test.ts`；`evidence/step3-red.txt`、`step3-green.txt`                                              | 紅燈重現：`51c7399` 上 11 個測試 7 個失敗，第一個就是 exit 0 的 426 被判為健康。綠燈重現：HEAD 11／11。告警文字經真正的 `startModelHealthCheck()` 產生，斷言含 426、升級提示、不含「下架」                                                                                               | 通過                         |
| SCN-004 | 上述兩個測試檔的 SCN-004 測試；既有的 `tests/opencode-rate-limit-failfast.test.ts`、`tests/model-health-check.test.ts`（未被修改）    | 既有測試檔在這段 diff 裡沒有任何變更，完整測試為綠。1.18 的 429 快速中止紅燈重現（修改前是 8 秒保險絲後得到 `timeout`）。fixture 的限制見「測試真偽」                                                                                                                                    | 通過，殘餘風險見 TBD-3       |
| SCN-005 | 三個測試檔各有一個 SCN-005 測試，fixture 是真實免費層的回覆                                                                           | 回覆文字含 `426`、`error`、`"statusCode":426`、`429`；兩條路徑、探針、腳本都判為成功                                                                                                                                                                                                     | 通過                         |
| SCN-006 | `evidence/step5-image-verification.md`、`step5-run-runner.sh`                                                                         | **沒有獨立重現**。判準（有模型文字、沒有 `failure`、`upstreamError: false`）與反向自檢（對照組只換 opencode 版本，得到 426 與 `ok: false`）成立，判準在失敗時不會是綠的。被測提交 `984c5b0` 到 HEAD 的差異只有 issue 文件。原始輸出未保存，見 S3                                         | 依證據檔判定通過，未獨立驗證 |
| SCN-007 | `tests/probe-models-script.test.ts`；`evidence/step4-red.txt`、`step4-green.txt`（含真實上游實跑）                                    | 紅燈重現：`4320835` 上 9 個測試 7 個失敗，426 被歸為 `empty-output`。綠燈重現：HEAD 9／9。測試實際執行腳本，沒有 mock 判定邏輯。實跑的部分沒有獨立重現，記錄的命令有出入，見 S5                                                                                                          | 通過                         |

### 測試真偽

- 沒有發現假綠燈。三個測試檔都以假的 `opencode` 執行檔吐回 fixture，被替換的是外部相依，不是被驗收的判定邏輯；斷言的期望值是字面值，沒有由被測程式重算。SCN-002 比較兩條路徑的結果，那就是劇本本身，並另外斷言狀態碼的字面值。
- 既有測試沒有被刪除、略過或弱化：`git diff --stat` 在 `tests/` 下只有新增的 3 個測試檔與 fixture。
- 串流測試對 `opencode_done` 的斷言（`tests/opencode-upstream-error.test.ts:217-220`）在只有 error 事件時是對空集合成立，因為串流不發這個事件。它在紅燈時有鑑別力：修改前串流會走 `tool_only` 追問，追問發出的 `opencode_done` 被當成真實成功。不算假綠燈。
- 證據持久力：串流測試的回呼都是同步的，測不到 M1；SCN-004 的時間上限是 5 秒，劇本寫的是約 1 秒。
- fixture 作為獨立真相來源：
  - 12 個 fixture 的位元組數與 `evidence/step1-samples.txt` 逐一相符（已核對），與「原始輸出、不手改」的說法一致。
  - 真實上游擷取的有 5 個：1.15.10 的 426、1.18.34 的模型不存在（stdout 與 stderr）、正常回合、提到 426 的正常回合、工具回合。其餘 7 個來自本機假上游，包括 1.18.34 的 426、410、404 與三份重試中的 stderr。這個區別在 fixture 的 README 表格裡逐檔標明，假上游的原始碼也一併提交，揭露是如實的。
  - 假上游的可信度靠「1.15.10 對假上游與對真實免費層的 426 行為相同」這個對照支撐。對照用的原始輸出沒有提交，我只能核對位元組數，無法重看內容。
  - 需要留意的一點：`1.18.34-upstream-429-retry.stderr.txt` 的上游訊息 `mock: rate limit exceeded` 是實作者在假上游裡自己寫的，樣式再寫成命中它。logfmt 的結構（`small=false`、`error.error=` 的位置）是真實 opencode 的輸出，但「真實免費層在 1.18 上的 429 長什麼樣」沒有樣本。另一份 `Too Many Requests` 是 opencode 對沒有訊息的 body 退回 HTTP 狀態文字，這個行為是真實的。這個限制在 `src/core/rate-limit.ts` 的註解與 TBD-3 都有揭露，不構成缺失。

### 相關失敗面

| 失敗面                             | 輸入／狀態                                                  | 預期                                 | 現有覆蓋                                                     | 判定                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 只有 error 事件，exit 0（1.15）    | 真實 426 fixture                                            | `upstream-error`、426、runtime issue | 兩條路徑都有測試                                             | 正確（已重現，慢回呼下也正確）                                                                                                               |
| 只有 error 事件，exit 1（1.18）    | 假上游 426 fixture                                          | 同上，不變成通用例外                 | 兩條路徑都有測試                                             | 正確                                                                                                                                         |
| error 事件沒有 `statusCode`        | 模型不存在的 fixture                                        | 仍判失敗；探針以 stderr 的原因為準   | 解析、探針、腳本各有測試                                     | 正確                                                                                                                                         |
| exit 非 0 且沒有 error 事件        | 假 opencode 只回 exit 1                                     | 丟例外、不發 `opencode_done`         | 有測試（非串流）                                             | 正確                                                                                                                                         |
| 文字之後接 error 事件              | 兩份 fixture 接起來                                         | 文字保留在說明前，仍判失敗           | 有測試，但回呼是同步的                                       | 非串流正確；串流在慢回呼下**錯誤**，見 M1                                                                                                    |
| 串流：stdout 處理與 `close` 的先後 | 同一批含前一個事件與 error 事件，回呼有延遲                 | error 事件不被漏掉                   | 沒有                                                         | **錯誤**，見 M1                                                                                                                              |
| passthrough 指令                   | 不帶 `--format json`，stdout 是純文字                       | 不把文字當事件解析                   | 沒有測試；程式明確跳過（`src/core/opencode.ts:452`、`:504`） | 符合設計。passthrough 遇到上游錯誤時在 1.18 上是通用例外（非靜默），沒有狀態碼；驗收劇本未涵蓋，屬已知限制                                   |
| 使用者中止                         | `EABORTED`／`externallyAborted`                             | 中止優先，不記為失敗                 | 沒有新測試                                                   | 讀碼確認兩條路徑都是中止優先                                                                                                                 |
| 逾時或限流中止與 error 事件並存    | error 事件後行程卡住                                        | 兩條路徑一致                         | 沒有                                                         | 不一致，影響小，見 N1                                                                                                                        |
| 限流樣式誤觸                       | 500、426、標題代理、模型名含數字、舊格式的市場數據          | 不命中                               | 有測試；我另外測了 15 組                                     | 正確。`rate limiter` 字樣會誤觸，見 N4                                                                                                       |
| 限流樣式漏判                       | 清單外的措辭、訊息含跳脫引號、`AI_RetryError` 開頭          | 退避到逾時並記為逾時失敗             | 沒有（TBD-3 揭露）                                           | 行為與揭露一致，非靜默                                                                                                                       |
| `opencode_done` 的發出與消費       | 非串流 exit 0、exit 非 0 有事件、exit 非 0 無事件；串流     | 假成功不餵豁免視窗                   | 有測試                                                       | 正確。消費端只有 `src/main.ts:385` 與 `src/runner.ts:710`（grep 確認），都經 `isRealSuccessEvent()`。串流不發事件是既有行為，文件見 S2       |
| 健康檢查升級當下                   | 狀態檔是舊的兩段簽章                                        | 狀態機照常運作                       | 沒有                                                         | `readState()` 對格式寬容，最多多推一次。簽章穩定性見 S1                                                                                      |
| 探針遇到持續限流（1.18）           | opencode 重試到 120 秒逾時                                  | 告警                                 | 沒有（計畫已揭露為既有行為）                                 | 得到 `unknown`，告警會發但說「無法確認」。逾時處理這段程式沒有被修改                                                                         |
| 腳本與 TypeScript 的一致性         | 11 組輸入分別餵給兩邊                                       | 判定對應                             | 樣式字串有相等斷言                                           | 主要情況一致。差異：行首空白（N3）；單次限流命中腳本判限流而 TS 要兩次；exit 0 空輸出腳本判 `empty-output` 而 TS 判健康。後兩者是既有差異    |
| 新增的列舉成員                     | `AgentFailureKind`、`FailureCategory`、`UpstreamErrorClass` | 所有分支都處理                       | 不適用                                                       | grep 確認：`src/` 內沒有對 `failure.kind` 的 switch；`buildAlertText()` 處理了全部五個類別；`describeUpstreamError()` 的 switch 四個分支齊全 |
| 正常回合提到 426 與 error          | 真實回覆 fixture                                            | 判為成功                             | 有測試                                                       | 正確                                                                                                                                         |

### 需求、架構、安全、品質

- **需求與範圍**：變更的檔案都在 README「涉及檔案」之內；`src/core/run-outcome.ts`、`docker-compose.yml`、`docker-compose.release.yml`、`.github/workflows/release.yml` 沒有變更（已確認）。`ARCHITECTURE.md` 與 `README.md` 是核准後補列，補列有標日期，理由是 `docs/agents/project.md` 的常青文件對照，合理。沒有新增設定。
- **與設計方案的出入**：三項都有記錄，我認為合理。404 不歸為模型失效，與 `rate-limit.ts` 既有的理由一致；串流的寬鬆限流樣式改成共用嚴格樣式，否則串流在 1.18 上認不得限流；exit 1 的處理來自步驟 1 的實測，計畫以帶日期的 NOTE 保留了被推翻的前提。
- **架構**：`findUpstreamError()` 放在事件解析模組，健康檢查不必依賴 agent 模組；`buildUpstreamErrorResult()` 是兩條路徑的單一出口；狀態碼到分類的對應集中在 `classifyUpstreamStatus()`。沒有過度設計。`UpstreamError` 型別放在 `rate-limit.ts`、由事件解析模組反向匯入，位置有點勉強但不構成問題。
- **重複邏輯**：TypeScript 與 `.mjs` 兩份複本是 `CLAUDE.md` 既有的刻意設計。限流樣式有相等斷言守門，其餘複本沒有，見 N3。
- **文件與實作**：`ARCHITECTURE.md` 的兩處新增與實作相符。`CLAUDE.md` 有三處不符，見 S2。`README.md` 有一處過度概括，見 N5。
- **安全與公開 repo**：掃描所有新增行，沒有本機絕對路徑、使用者名稱、電子郵件、token、Telegram ID 或容器 ID。紅燈輸出以 `<repo>`、`<tmp>` 取代路徑；出現的 IP 只有 `127.0.0.1`；`apiKey` 的值是 `mock`；`RUNNER_SHARED_SECRET` 在腳本裡是執行時隨機產生，沒有寫死的值。真實 fixture 保留了回應標頭，見 N6。
- **不實回報**：沒有發現。可重現的宣稱都核對過：測試數 320、測試檔 49、三個步驟的紅燈失敗數（12／14、7／11、7／9，與證據檔內的計數相符）、`build`／`test`／`lint` 的 exit code、`tests/docker/` 5／5、prettier 檢查、不可觸及的檔案沒有變更、fixture 的位元組數。唯一的出入是 S5 的命令列。

### 豁免、待確認與限制

- **Gate 豁免**：只豁免「建立 PR」，有日期、原話與殘餘風險。獨立審查沒有被豁免，本報告即為該審查。沒有 PR 頁面，Proof of Test 由上面的驗收表承擔。
- **TBD-1**（已解決）：釘 1.18.34 的理由是所有樣本都取自這個版本，合理。這個版本發佈不到一天就被釘住，步驟 5 的實地驗證是唯一的整體證據。
- **TBD-2**（待確認）：正式部署要不要先換模型止血，是營運決定，不影響本次審查。提醒：正式服務在本變更發版並升級之前仍處於失效狀態。
- **TBD-3**（不影響本次交付）：使用者已選定維持現狀。殘餘風險是真實免費層在 1.18 上的 429 措辭沒有樣本；若不在清單內，每個回合會燒滿 `OPENCODE_TASK_TIMEOUT_MS` 才失敗（會被記為逾時，不是靜默）。建議升級後第一次遇到真實 429 時核對 stderr 的實際內容。
- **TBD-4**（不影響本次交付）：健康探針與聊天共用 session 是既有行為，升版沒有改變它，判定合理。它的影響不小，建議盡快另開 issue。
- **我沒有獨立重現的部分**：
  - 步驟 5 的容器實地驗證，包括「容器與映像已移除、正式部署沒有被碰到」的宣稱。我沒有執行任何 docker 指令。
  - 所有需要真實 opencode 或真實上游的觀察：步驟 1 的擷取過程、假上游與真實上游的對照、步驟 4 的實跑。
  - 紅燈當時的測試檔版本。它沒有提交，計畫揭露了紅燈之後的修改；我用最終版測試重跑的紅燈數與揭露的內容相符。
  - 真實 opencode 會不會把 error 事件與前一個事件寫進同一批 stdout（M1 的發生機率）。
  - 1.15.10 的 stderr 是否同樣以時間戳開頭（S1 是不是既有行為）。
- **我實際執行的命令與結果**：

  | 命令                                                                                                                       | 結果                                                          |
  | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
  | `git rev-parse HEAD`、`git status --porcelain`                                                                             | HEAD 相符，工作區乾淨                                         |
  | `git diff <BASE> <HEAD> \| git patch-id --stable`                                                                          | `8a1f09a5…`，相符                                             |
  | `git diff e8f490c 48944eb -- docs/issues/issue-0008/README.md`                                                             | Gherkin 區塊無變更                                            |
  | `git diff --stat <BASE> <HEAD> -- docker-compose.yml docker-compose.release.yml .github src/core/run-outcome.ts`           | 無輸出                                                        |
  | `npm run build`                                                                                                            | exit 0                                                        |
  | `npm run test`                                                                                                             | exit 0；`# tests 320`、`# pass 320`、`# fail 0`；測試檔 49 個 |
  | `npm run lint`                                                                                                             | exit 0                                                        |
  | `npx tsx --test` 三個新測試檔                                                                                              | 36／36                                                        |
  | `npx tsx --test tests/docker/*.test.ts`                                                                                    | 5／5                                                          |
  | `npx prettier --check CLAUDE.md ARCHITECTURE.md README.md docs/issues/issue-0008/*.md`                                     | 通過                                                          |
  | 暫存目錄展開 `9ed35ff`、`51c7399`、`4320835`，放入最終版測試後執行                                                         | 13／16、7／11、7／9 失敗，原因都是缺少目標行為                |
  | 暫存目錄的一次性腳本（串流順序、簽章穩定性、限流樣式 15 組、事件解析邊界、腳本與 TS 的 11 組比對、修改前後的正常回合競態） | 結果寫在 M1、S1、N3、N4 與失敗面表格                          |
  | grep：`opencode_done`、`isRealSuccessEvent`、`failureKind`、`switch (`、`readHealthState`、敏感資訊樣式                    | 結果寫在對應段落                                              |

  審查結束時工作區唯一的變更是新增本報告檔。

## 流程判定

**RETURN TO execute-task**

依 `docs/agents/review-evidence.md`：有一項 MUST FIX（M1，串流路徑在可重現的順序下漏掉 error 事件，回合被記為成功，與核准來源「任何上游 error 事件都判為失敗回合」不符，且沒有測試涵蓋）。

七個驗收劇本以劇本字面的輸入形狀都有有效證據，沒有發現假綠燈或不實回報。M1 修正並補上 async 回呼的回歸測試後需要重新審查；S1 至 S5 與 NICE TO HAVE 不阻塞，可由實作者決定是否一併處理。M1 的發生條件偏窄（見該項的校準），要不要接受這個風險並改列為後續 issue，是使用者可以決定的事，但依現行規範我不能在它存在時給 PASS。
