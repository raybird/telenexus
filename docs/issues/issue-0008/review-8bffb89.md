# 審查報告（第二輪）

- 範圍：完整交付範圍 `BASE..HEAD`（本機流程，未開 PR），共 69 個檔；不是只看增量
- 輪次：第二輪。第一輪報告在 `docs/issues/issue-0008/review-48944eb.md`，判定 RETURN TO execute-task（M1）
- Reviewed BASE SHA：`da76420420c49e35eb0020d5fd9ac889da21d761`
- Reviewed HEAD SHA：`8bffb89aa8a40b88fc04471217348dc20b87a340`
- Reviewed patch-id：`ad0deda1d1001b21d063ae9b8afb128cfdaf97a1`（以 `git diff <BASE> <HEAD> | git patch-id --stable` 重算相符）
- 增量：`48944eb..8bffb89` 三個提交。`8d5bf86` 只新增第一輪報告（與我寫出的檔案雜湊相同，未被修改）；`ab110b2` 是修正；`8bffb89` 只有 issue 文件與證據
- 獨立 reviewer：宿主隔離的 subagent（Claude Code，獨立 context），不是本段變更的實作者，與第一輪是同一個 reviewer；判斷來自自行閱讀 diff、規格、證據與自行執行的命令
- Review artifact：`docs/issues/issue-0008/review-8bffb89.md`
- 審查日期：2026-10-01
- 風險：High（依 issue README）
- 審查前狀態：`git rev-parse HEAD` 等於上列 HEAD，工作區乾淨

## 問題與風險

### MUST FIX

無。

第一輪的 M1（串流路徑在回呼有延遲時漏掉同批到達的 error 事件）已修正，我以第一輪的重現腳本與另外 13 個情境對 HEAD 重跑確認，細節在「M1 的複驗」。

### SHOULD FIX

#### S1. `close` 等處理鏈的那一段沒有上限，回呼卡住時回合永遠不結束，逾時與使用者中止都救不回來

- 位置：`src/core/cli-agent-base.ts:349-360`（`close` 先把 `settled` 設為 `true`、清掉逾時計時器，再 `await lineProcessing`）、`:318-327`（處理鏈的 `catch`）
- 這是修正本身帶來的新行為。三個現象都已親自重現，並與修正前（`48944eb` 的原始碼）對照：

  | 情境                                                         | 修正前                     | HEAD                                                      |
  | ------------------------------------------------------------ | -------------------------- | --------------------------------------------------------- |
  | `delta` 回呼永不返回，行程正常結束                           | 回合結束，回覆 `OK`        | **永遠不結束**（4 秒內未返回）                            |
  | `delta` 回呼永不返回，行程卡住，逾時設 1.5 秒                | 1.5 秒後回 `timeout`       | **永遠不結束**：逾時有砍掉行程，但 `close` 卡在等處理鏈   |
  | `delta` 回呼永不返回，300ms 後使用者中止                     | 302ms 回「已被使用者中止」 | **永遠不結束**                                            |
  | 20 行 `text`、回呼各 100ms，150ms 後使用者中止               | 152ms 返回                 | 2126ms 返回；中止之後仍把剩下 19 個 `delta` 送給回呼      |
  | 回呼延遲 50ms 後丟例外，`text` 與 `error` 同批、行程立即結束 | 記為成功，文字 `OK`        | 相同：例外被吞掉、同批後面的 error 事件沒被處理，記為成功 |

- 校準（請一併考量，這是我沒有把它列為 MUST FIX 的理由）：
  - 前三列需要回呼**永不返回**。正式環境的三種回呼都不會：runner 的 SSE 寫出（`src/runner.ts:585-604`）與 Web Console 的 `streamResponse`（`src/web/server.ts:1946`）是同步的；Telegram 渲染器的每一次 API 呼叫都經過 `callTelegram()` 的 `withTimeout()`（`src/connectors/telegram.ts:13`、`:682-696`，預設 15 秒），而且渲染器把所有例外都接住。這是讀碼得到的推論，不是實測。
  - 所以在正式環境，這個行為表現為「延後」而不是「卡死」：收尾最多被排隊中的 Telegram 呼叫拖住。渲染器連續失敗達上限後會停用串流，之後的事件立即返回。
  - 最後一列（回呼丟例外）與修正前結果相同，不是退化；同樣需要回呼自己出錯。回呼在 `close` 之前丟例外時回合會被 reject，在 `close` 等待期間丟例外則被吞掉，兩者不一致。
- 為什麼仍然值得修：修正前，`OPENCODE_TASK_TIMEOUT_MS` 與使用者中止是「不論回呼怎樣都能結束回合」的最後防線；現在這條防線依賴所有回呼都會返回。串流回合在每位使用者的序列佇列裡執行，一旦卡住，該使用者之後的訊息都排在後面。這個取捨沒有出現在計畫步驟 7 或程式註解裡。
- 建議：等處理鏈時加上限（例如與一個短計時器 race，逾時就以目前已處理的狀態判定並記一筆 runtime issue）；使用者中止與逾時這兩條路徑可以不等鏈、或先讓鏈停止送出後續事件；把 `settled = true` 移到 `await` 之後，或讓 `catch` 把例外留給 `close` 處理。補「回呼不返回」與「回呼丟例外」的測試。若決定不改，至少在註解與 `CLAUDE.md` 寫明這個前提。

#### S2. 失敗簽章對 `rate-limited` 仍然不穩定，第一輪 S1 提過的這一半沒有處理，也沒有記為不處理

- 位置：`src/services/model-health-check.ts:304`（訊息含命中次數）、`:104-110`（正規化）
- 已親自驗證：限流命中 5 次與 3 次的簽章不同（訊息是「被上游限流 N 次」，`VOLATILE_LOG_FIELDS` 不處理數字）。重試次數每次探測都可能不同，「能回應但持續被節流」的模型仍會被當成新故障重複推播。
- 這是既有行為（訊息格式不是本 issue 加的），影響限於降級狀態。計畫步驟 7 對 S1 的說明只提到時間戳與 run id，讀起來像是整項已處理。
- 建議：簽章對 `rate-limited` 不取訊息，或在 TBD-5 補記。

### NICE TO HAVE

- **N1. 正規化後取前 120 字，會把同類別的不同故障併成同一個簽章。**（`src/services/model-health-check.ts:63`、`:110`）已驗證兩個例子：兩個不同的不存在模型名簽章相同（120 字剛好停在 `Model not found:` 之前）；`unknown` 類別下 stderr 只差上游訊息的兩行簽章相同（`error.error` 欄位從第 101 字才開始）。後果是同類別內故障性質改變時不會立即再推播，要等 6 小時的提醒，提醒文字會是新的錯誤。有狀態碼的路徑不受影響，類別改變仍會立即推播。修正前這 120 字全是時間戳與 run id，現在至少由訊息種類決定，是改善；建議改成取 `error`／`cause` 欄位或放寬長度。
- **N2. 限流字樣收緊後，CamelCase 寫法不再命中。**（`src/core/rate-limit.ts:30`、`scripts/probe-models.mjs:209`）`rate[ -]?limit(?:ed|s|ing)?\b` 排除了 `rate limiter`（已驗證），但 `RateLimitError`、`RateLimitExceeded` 也因為 `\b` 而不再命中（已驗證；收緊前會命中）。`rate_limit_exceeded` 前後都不命中。兩種方向都沒有真實樣本，屬 TBD-3 的範圍。可以考慮改成 `rate[ -]?limit(?!er)`。
- **N3. `evidence/step5-verify.sh:10` 呼叫的是 `run-runner.sh`，提交進來的檔名是 `step5-run-runner.sh`。** 腳本照現在的樣子無法直接執行；`step5-image-verification.md` 寫的是它呼叫 `step5-run-runner.sh`。另外腳本會複製 `error-summary.md`，兩個輸出目錄裡都沒有這個檔，文件的檔案清單也沒列，應該是當時不存在。
- **N4. 紀錄的小缺口。** README 的「重構步驟概要」（`docs/issues/issue-0008/README.md:123-132`）仍只列六個步驟；計畫步驟 7 沒有記錄精煉階段或 no-op；N6 列為沒有採納但沒寫理由。
- **N5. 新測試的涵蓋面。** 四個回呼延遲的測試都是「整個輸出一次送出」的形狀，沒有涵蓋跨批次、半行、尾行（我另外測過，結果正確）；簽章測試只變動 `timestamp` 與 `run`；舊格式的樣本是手寫的（格式本身我用步驟 5 對照組 `container.log` 裡的真實 1.15.10 行確認過相符）。屬證據持久力。
- **N6. 沿用第一輪、已記入 TBD-5 的項目**：兩條路徑在逾時／限流中止與 error 事件並存時優先順序不同；429 以 error 事件出現時不計入 Rate-limit Issues；本地路徑的 `ok: true`、排程記為 `schedule_done`、錯誤說明存進記憶。我維持第一輪的評估，都不需要升為 MUST FIX。

## 已查核維度

### M1 的複驗

修法：`src/core/cli-agent-base.ts:266-327` 把各批 stdout 接成一條依序執行的 promise chain，`:360` 的 `close` 先等它。

第一輪表格的每一列對 HEAD 重跑（同一份重現腳本）：

| 同一批 stdout        | exit | 回呼       | 第一輪結果                    | HEAD                                                            |
| -------------------- | ---- | ---------- | ----------------------------- | --------------------------------------------------------------- |
| `text` + `error`     | 1    | 慢（50ms） | 記為成功、沒有說明            | `upstream-error`、426、文字保留在說明前                         |
| `text` + `error`     | 0    | 慢         | 記為成功、沒有說明            | 同上                                                            |
| `tool_use` + `error` | 1    | 慢         | 通用的 `exit=1` 例外          | `upstream-error`、426                                           |
| `tool_use` + `error` | 0    | 慢         | 走 `tool_only` 追問、多打一次 | `upstream-error`、426，沒有追問                                 |
| `text` + `error`     | 1    | 同步       | 正確                          | 正確                                                            |
| 只有 `error`         | 0／1 | 慢         | 正確                          | 正確                                                            |
| 正常回合一次送出     | 0    | 慢         | 被當成空輸出、多打一次        | 文字 `OK`、只執行一次、事件順序 `start,status,delta,usage,done` |

另外以可控時序的假 `opencode`（repo 外）測了修法自己可能帶來的問題，並與 `48944eb` 對照：

| 情境                                           | 修正前                         | HEAD                                | 判定                    |
| ---------------------------------------------- | ------------------------------ | ----------------------------------- | ----------------------- |
| 回呼在 `close` 之前丟例外                      | reject                         | reject                              | 不變                    |
| `start` 回呼丟例外，之後還有輸出               | reject                         | reject                              | 不變                    |
| 回呼在 `close` 等待期間丟例外                  | 例外被吞、記為成功             | 相同                                | 非退化，見 S1           |
| 回呼永不返回（正常結束、逾時、使用者中止三種） | 都會結束                       | 都不結束                            | **退化**，見 S1         |
| 使用者中止，佇列裡還有慢回呼                   | 立即返回                       | 等佇列跑完才返回                    | 延後，見 S1             |
| 逾時，先前有慢回呼                             | `timeout`                      | `timeout`                           | 不變                    |
| 限流中止，stdout 已有 `text`                   | `rate-limit`                   | `rate-limit`                        | 不變（多等回呼 0.2 秒） |
| exit 1、有 `text`、沒有 error 事件             | 通用例外（文字因競態還沒累計） | 以既有文字回覆、沒有 `failure`      | 見下方說明              |
| exit 1、只有 `tool_use`、沒有 error 事件       | 通用例外                       | 通用例外                            | 不變                    |
| 跨批順序：A 的回呼 300ms，B、C 隨後到達        | `ABC`                          | `ABC`，事件順序也是 A、B、C         | 正確                    |
| error 事件被切成兩批（半行）                   | 判出 426，但前面的文字遺失     | 判出 426，文字保留                  | 改善                    |
| error 事件是沒有換行的尾行                     | 判出 426，文字遺失             | 判出 426，文字保留                  | 改善                    |
| 300 行 `text`、回呼各 5ms                      | 文字遺失、多追問一次           | 文字完整、只執行一次（多花 1.5 秒） | 改善                    |
| `tool_only`（只有工具事件、exit 0）            | 追問一次                       | 追問一次                            | 不變                    |

兩次執行都沒有 unhandled rejection。

「exit 1、有文字、沒有 error 事件」那一列：`:430` 的既有分支本來就是「exit 非 0 但有文字就以文字回覆」，修正前因為競態而常常走不到，現在會穩定走到。這是既有設計變得確定，不是新行為；上游錯誤有 error 事件，會先被 `:390` 攔下。

既有串流測試的假設：`tests/dynamic-agent-opencode-stream.test.ts`、`tests/message-pipeline.test.ts`、`tests/cli-agent-run-finished.test.ts`、`tests/web-streaming.test.ts`、`tests/dynamic-agent-runner-stream.test.ts` 在整段 `BASE..HEAD` 都沒有被修改，完整測試為綠。

### 驗收與證據

核准基線：`git diff e8f490c 8bffb89 -- docs/issues/issue-0008/README.md` 的差異是涉及檔案補列、核准 commit 回填、待確認事項（新增 TBD-5）、Gate 豁免紀錄、Timeline 與狀態欄。Gherkin 區塊一字未改，原核准有效。

紅燈的重現方式：把修改前的提交展開到 repo 外的暫存目錄，放進 HEAD 的最終版測試檔後執行。第一輪做了 `9ed35ff`、`51c7399`、`4320835`；這一輪做了 `48944eb`（等同退回修正前的 `src/`）。

| 驗收    | 證據位置                                                                                                                                                                                | 我的查核                                                                                                                                                                                                                                                        | 結論                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| SCN-001 | `tests/opencode-upstream-error.test.ts`（含 `:274`、`:300`、`:322` 的回呼延遲測試）；`evidence/step2-red.txt`、`step2-green.txt`、`return1-red.txt`、`return1-green.txt`；步驟 5 對照組 | 第一輪：`9ed35ff` 上 13／16 失敗，原因是缺少目標行為。本輪：`48944eb` 上新增的 4 個延遲測試全部失敗（漏掉事件、通用例外、走空輸出追問），HEAD 全綠。期望值是字面值。runner audit 的實際內容在步驟 5 的原始檔可以看到 `ok:false`、`failureKind:"upstream-error"` | 通過                         |
| SCN-002 | 同上，「串流與非串流對同一份輸出的判定一致」兩個測試                                                                                                                                    | 兩條路徑對只含 error 事件的輸出結果相同，已重現；步驟 5 對照組的 `/run` 與 `/run/stream` 原始回應也是同樣的 `failure`                                                                                                                                           | 通過                         |
| SCN-003 | `tests/model-health-upstream-error.test.ts`；`evidence/step3-red.txt`、`step3-green.txt`                                                                                                | 第一輪：`51c7399` 上 7／11 失敗。HEAD 12／12。步驟 5 對照組的狀態檔是 `failing`、簽章 `client-outdated:426:160781252`，與正規化前相同                                                                                                                           | 通過                         |
| SCN-004 | 上述兩個測試檔的 SCN-004 測試；既有的 `tests/opencode-rate-limit-failfast.test.ts`、`tests/model-health-check.test.ts`（未被修改）                                                      | 既有測試檔沒有變更，完整測試為綠。收緊後的限流字樣仍命中兩份 429 fixture；`rate limiter` 的斷言在 `48944eb` 上失敗、HEAD 通過                                                                                                                                   | 通過，殘餘風險見 TBD-3、N2   |
| SCN-005 | 三個測試檔各有一個 SCN-005 測試，fixture 是真實免費層的回覆                                                                                                                             | 兩條路徑、探針、腳本都判為成功；另有「回呼延遲時正常回合不被當成空輸出」                                                                                                                                                                                        | 通過                         |
| SCN-006 | `evidence/step5-image-verification.md`、`evidence/step5-ab110b2/`、`step5-verify.sh`                                                                                                    | **沒有獨立重現**。這一輪有原始檔，彙整表逐格核對相符、原始檔之間自洽，見下一節。被測提交 `ab110b2` 到 HEAD 的差異只有 issue 文件與證據                                                                                                                          | 依原始檔判定通過，未獨立執行 |
| SCN-007 | `tests/probe-models-script.test.ts`；`evidence/step4-red.txt`、`step4-green.txt`                                                                                                        | 第一輪：`4320835` 上 7／9 失敗。HEAD 9／9。兩處限流樣式的字串相等斷言通過；腳本端補了 `trim()`，行首空白的差異已消失（已驗證）                                                                                                                                  | 通過                         |

### 步驟 5 重驗的原始檔核對

我沒有執行任何 docker 指令，以下是對提交進來的原始檔做的核對。

彙整表六列：

| 彙整表的項目                     | 原始檔                                                                                                                                                                               | 相符 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `/run` 的 `output`               | `new/run-response.json`：`PONG-0008`、沒有 `failure`、事件 `step_start,text,step_finish`。`control/run-response.json`：426 說明、`failure.kind = upstream-error`、`statusCode = 426` | 是   |
| `/run/stream` 的事件             | `new/…sse`：`start,status,delta,usage,done,result`。`control/…sse`：`start,done,result`                                                                                              | 是   |
| `runner-audit.log`（兩筆）       | 新映像兩筆 `ok:true`；對照組兩筆 `ok:false`、`failureKind:"upstream-error"`                                                                                                          | 是   |
| `opencode_done`（非串流）        | 新映像 `outputLen:931`、`upstreamError:false`；對照組 `outputLen:736`、`upstreamError:true`、`statusCode:426`                                                                        | 是   |
| `runner-status.md`               | 2 次、100.0%；2 次、0.0%                                                                                                                                                             | 是   |
| `model-health-state.runner.json` | `healthy`；`failing`、`client-outdated:426:160781252`                                                                                                                                | 是   |

自洽性：

- requestId：每組的兩個 requestId 在 `container.log`、`events.jsonl`、`runner-audit.log`、回應檔與 `runner-status.md` 的 Last Request 之間一致。
- 時間與耗時：`events.jsonl` 的起迄時間差與 `durationMs` 相符（新映像 4755、9589；對照組 1779、1898，誤差 1 至 2 毫秒）；audit 的 `timestamp` 等於 `runner_request_start` 的時間；`runner-status.md` 的平均耗時 7172ms 等於 (4755+9589)/2；時間落在 UTC 08:20:43 至 08:21:13，與文件寫的區間相符。
- 啟動探針：狀態檔的 `since` 落在容器啟動的同一秒，第一個請求在它之後 7 秒與 3 秒才發出，與 `meta.txt` 的等待秒數相符。
- 串流不發 `opencode_done`：兩組的 `events.jsonl` 在串流請求那一段都沒有 `opencode_start`／`opencode_done`，與程式一致。
- runtime issue：對照組只有一筆 `opencode:upstream-error:426`，串流那一次沒有第二筆，與 60 秒內同 scope 同訊息只累加次數的行為一致；`container.log` 兩次都有 `upstream_error` 的警告。
- 對照組 SSE 的 `result` 與 `/run` 回應最外層是 `"ok":true`。這是傳輸層的欄位，設計上不隨降級結果改變（`src/core/run-outcome.ts` 的註解），失敗寫在 `structured.failure` 與 audit，不是矛盾。
- 第一次驗證留下的四份原始回應也看過：`OKOKOKOK` 那一份有四組 `step_start,text,step_finish`，與文件對並行干擾的描述相符；對照組那一份是 426 的 `failure`。文件如實寫明那一次的 events、audit 與狀態檔已刪除，表格裡那幾列沒有原始檔可對照。

限制：runner 的 SSE 回呼是同步的，所以這次真實 opencode 的串流執行走的是修正後的處理鏈，但沒有「真實 opencode 加上慢回呼」的組合；那個組合只有假 `opencode` 的證據。

敏感內容：對照組 `container.log` 有一段 2000 字的 stderr，內容是 opencode 的系統提示開頭與上游 URL，沒有憑證。其餘是隨機的 requestId、session id 與容器內路徑（`/app/…`）。沒有發現不該公開的內容。

### 測試真偽

- 沒有發現假綠燈。新增測試的被測對象仍是真正的 `OpencodeAgent`，被替換的只有外部的 `opencode` 執行檔；期望值是字面值。
- 四個回呼延遲的測試：在 `48944eb` 的原始碼上全部失敗，原因分別是走了空輸出追問、丟出 `Error calling opencode: exit=1`、事件順序不符，都是缺少目標行為。exit 0 那兩個測試靠「不該走空輸出追問」這條斷言才分得出修正前後（修正前追問那一次也會判出 426），測試裡有註解說明，斷言有鑑別力。
- 簽章穩定性測試（S1 的修正先寫程式才補測試）：實作者以「還原修正後測試失敗」代替時間序上的紅燈。我的判斷是足夠。`docs/agents/verification.md` 要的是紅燈來自缺少目標行為；我把最終版測試放到修正前的原始碼上執行，它失敗，失敗內容是兩次探測算出不同的簽章（`model-invalid:-5999969` 對 `-1051607887`），這與先紅後綠能證明的事情相同。順序上的偏離有如實揭露。測試的期望是「相同」這個性質，不是由被測程式重算的值；另有一條「不同故障簽章不同」的反向斷言。
- 限流字樣的測試：「常見變形」那一個在收緊前後都會過，它是防退化用的；有鑑別力的是 `rate limiter` 那條斷言，在 `48944eb` 上失敗。
- `return1-red.txt` 與 `return1-green.txt` 的測試數、失敗數與我重跑的結果相符（修正前 4 個延遲測試失敗；HEAD 三個測試檔 42／42）。
- fixture 的結論與第一輪相同：5 個來自真實上游、7 個來自本機假上游，逐檔標明；位元組數與 `step1-samples.txt` 相符；這一輪沒有變動 fixture。

### 相關失敗面

| 失敗面                             | 輸入／狀態                                                       | 預期                                 | 現有覆蓋                        | 判定                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------- | ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------- |
| 只有 error 事件，exit 0（1.15）    | 真實 426 fixture                                                 | `upstream-error`、426、runtime issue | 兩條路徑都有測試；步驟 5 對照組 | 正確                                                                                  |
| 只有 error 事件，exit 1（1.18）    | 假上游 426 fixture                                               | 同上，不變成通用例外                 | 兩條路徑都有測試                | 正確                                                                                  |
| error 事件沒有 `statusCode`        | 模型不存在的 fixture                                             | 仍判失敗；探針以 stderr 的原因為準   | 解析、探針、腳本各有測試        | 正確                                                                                  |
| exit 非 0 且沒有 error 事件        | 假 opencode 只回 exit 1                                          | 丟例外、不發 `opencode_done`         | 有測試（非串流）                | 正確                                                                                  |
| 文字或工具事件之後接 error 事件    | 兩份 fixture 接起來，回呼同步與延遲                              | 文字保留在說明前，仍判失敗           | 同步與延遲都有測試              | 正確（第一輪的 M1，已修正）                                                           |
| 串流：stdout 處理與 `close` 的先後 | 同批、跨批、半行、尾行，回呼有延遲                               | 所有行都在判定前處理完               | 同批有測試；其餘我另外測過      | 正確                                                                                  |
| 串流：回呼不返回或丟例外           | 回呼永不 resolve；回呼在 `close` 等待期間 reject                 | 回合仍能結束；例外不被靜默吞掉       | 沒有                            | 不返回時卡死（退化）；例外被吞（與修正前相同）。正式環境的回呼推論不可達，見 S1       |
| 使用者中止                         | `EABORTED`／`externallyAborted`                                  | 中止優先，不記為失敗                 | 沒有新測試                      | 結果正確；串流要等排隊中的回呼跑完才返回，見 S1                                       |
| 逾時、限流中止                     | 先前有輸出與慢回呼                                               | `timeout`／`rate-limit`              | 限流中止有測試                  | 正確                                                                                  |
| 逾時或限流中止與 error 事件並存    | error 事件後行程卡住                                             | 兩條路徑一致                         | 沒有                            | 不一致，影響小，已記入 TBD-5                                                          |
| passthrough 指令                   | 不帶 `--format json`                                             | 不把文字當事件解析                   | 沒有測試；程式明確跳過          | 符合設計；遇到上游錯誤在 1.18 上是通用例外，非靜默                                    |
| 限流樣式誤觸                       | 500、426、標題代理、模型名含數字、舊格式市場數據、`rate limiter` | 不命中                               | 有測試                          | 正確                                                                                  |
| 限流樣式漏判                       | 清單外的措辭、跳脫引號、CamelCase                                | 退避到逾時並記為逾時失敗             | 沒有（TBD-3 揭露）              | 行為與揭露一致，非靜默；CamelCase 是這次收緊新增的漏判，見 N2                         |
| `opencode_done` 的發出與消費       | 非串流三種結束方式；串流                                         | 假成功不餵豁免視窗                   | 有測試；步驟 5 原始檔           | 正確。消費端只有 `src/main.ts:385` 與 `src/runner.ts:710`                             |
| 健康檢查簽章                       | 同一故障不同時間；不同故障                                       | 同者相同、異者不同                   | 有測試（時間戳與 run id）       | 時間戳與 run id 已穩定。`rate-limited` 仍不穩定（S2）；同類別的不同故障可能被併（N1） |
| 健康檢查升級當下                   | 狀態檔是舊簽章                                                   | 狀態機照常運作                       | 沒有                            | `readState()` 對格式寬容，最多多推一次                                                |
| 探針遇到持續限流（1.18）           | opencode 重試到 120 秒逾時                                       | 告警                                 | 沒有（計畫已揭露為既有行為）    | 得到 `unknown`，告警會發但說「無法確認」                                              |
| 腳本與 TypeScript 的一致性         | 11 組輸入分別餵給兩邊                                            | 判定對應                             | 限流樣式有相等斷言              | 主要情況一致，行首空白的差異已消失。單次限流命中與 exit 0 空輸出的差異是既有的        |
| 新增的列舉成員                     | `AgentFailureKind`、`FailureCategory`、`UpstreamErrorClass`      | 所有分支都處理                       | 不適用                          | 這一輪沒有新增成員；第一輪的 grep 結論不變                                            |
| 正常回合提到 426 與 error          | 真實回覆 fixture                                                 | 判為成功                             | 有測試                          | 正確                                                                                  |

### 第一輪各項的處理

| 項目           | 處理                                 | 我的查核                                                                                                                                          |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1             | 處理鏈加 `close` 等待                | 已修正，見上                                                                                                                                      |
| S1             | `VOLATILE_LOG_FIELDS` 正規化         | 時間戳、run id、ref 不同時簽章相同，一小時後的判定是 `none`（已驗證）；真實的 1.15.10 行首格式也穩定。`rate-limited` 沒處理（本輪 S2），併合見 N1 |
| S2             | `CLAUDE.md:152`、`:158`、`:160` 改寫 | 三處都與實作相符；`:150` 新增的處理鏈敘述也相符                                                                                                   |
| S3             | 以 `ab110b2` 重驗並保存原始輸出      | 見「步驟 5 重驗的原始檔核對」                                                                                                                     |
| S4             | 維持原紀錄                           | 如實；精煉前的狀態補不回來                                                                                                                        |
| S5             | `step4-green.txt` 補上 `--timeout`   | 更正後的命令與輸出的 120／180 秒一致，並註明是事後更正、輸出未動                                                                                  |
| N3             | 腳本端解析前先 `trim()`              | 已驗證。下架與模型不存在樣式的一致性測試仍然沒有                                                                                                  |
| N4             | 限流字樣收緊                         | 兩處複本一致（相等斷言通過）；副作用見 N2                                                                                                         |
| N5             | `README.md:32` 改寫                  | 與實作相符                                                                                                                                        |
| N1、N2、N6、N7 | 沒有採納；N1、N2、N7 記入 TBD-5      | 紀錄如實。N1、N2 影響小，N7 是既有行為且劇本未涵蓋，不採納站得住；N6 沒寫理由，但保留原始標頭與「fixture 不手改」一致。沒有一項需要升為 MUST FIX  |

### 需求、架構、安全、品質

- **需求與範圍**：變更的檔案仍都在 README「涉及檔案」之內（程式與常青文件共 11 個，其餘是 `tests/` 與 issue 自己的文件）；`src/core/run-outcome.ts`、`docker-compose.yml`、`docker-compose.release.yml`、`.github/workflows/release.yml` 沒有變更。沒有新增設定。
- **新行為**：處理鏈改變了每一個本地串流回合的時序（事件嚴格依序、判定等所有回呼跑完）。它是修正 M1 所必需，計畫步驟 7 有寫明影響範圍，但沒有寫出 S1 的取捨。
- **架構**：修法侷限在 `runStreamChat()` 內，沒有改變介面。簽章正規化是 `failureSignature()` 內的一個常數。沒有過度設計。
- **重複邏輯**：兩處限流樣式仍有相等斷言守門。
- **文件與實作**：`CLAUDE.md` 四處、`README.md` 一處與實作相符。`ARCHITECTURE.md` 這一輪沒有變動，內容仍然正確。
- **安全與公開 repo**：對整段 `BASE..HEAD` 的新增行重新掃描，沒有本機絕對路徑、使用者名稱、電子郵件、token 或 Telegram ID。`step5-verify.sh` 以環境變數名稱引用 runner 的密鑰，沒有值。
- **不實回報**：沒有發現。核對過的宣稱：測試數 326、測試檔 49、三個測試檔 42／42、修正前 4 個延遲測試失敗、反向檢查的失敗項、`ab110b2` 之後只有 issue 文件與證據、步驟 5 彙整表的每一格。

### 豁免、待確認與限制

- **Gate 豁免**：只豁免「建立 PR」，獨立審查沒有被豁免。Proof of Test 由上面的驗收表承擔。
- **TBD-1 至 TBD-4**：與第一輪的評估相同。TBD-2 仍待確認，是營運決定，不影響審查。TBD-3 的殘餘風險不變。TBD-4 建議盡快另開 issue。
- **TBD-5**：把第一輪 N1、N2、N7 的五項記為不影響本次交付，理由如實，狀態合理。
- **Timeline**：新增第一輪退回的紀錄，內容正確。
- **我沒有獨立重現的部分**：
  - 步驟 5 的容器實地驗證與「容器與映像已移除」的宣稱。我沒有執行任何 docker 指令，只核對了原始檔。
  - 需要真實 opencode 或真實上游的觀察（步驟 1、步驟 4 的實跑）。
  - `step4-green.txt` 更正後的命令是否就是當時實際執行的命令；我只能確認它與輸出一致。
  - 真實 opencode 會不會把 error 事件與前一個事件寫進同一批。修正後這一點已不影響結果。
  - 真實免費層在 1.18 上的 429 措辭（TBD-3）。
  - 正式環境的回呼不會卡住或丟例外：這是讀 `src/connectors/telegram.ts`、`src/core/telegram-stream-renderer.ts`、`src/runner.ts`、`src/web/server.ts` 得到的推論，沒有實測。
- **我實際執行的命令與結果**：

  | 命令                                                                                                             | 結果                                                          |
  | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
  | `git rev-parse HEAD`、`git status --porcelain`                                                                   | HEAD 相符，工作區乾淨                                         |
  | `git diff <BASE> <HEAD> \| git patch-id --stable`                                                                | `ad0deda1…`，相符                                             |
  | `git diff e8f490c 8bffb89 -- docs/issues/issue-0008/README.md`                                                   | Gherkin 區塊無變更                                            |
  | `git diff --stat <BASE> <HEAD> -- docker-compose.yml docker-compose.release.yml .github src/core/run-outcome.ts` | 無輸出                                                        |
  | 比對 `8d5bf86` 內的第一輪報告與我寫出的檔案                                                                      | 雜湊相同                                                      |
  | `npm run build`                                                                                                  | exit 0                                                        |
  | `npm run test`                                                                                                   | exit 0；`# tests 326`、`# pass 326`、`# fail 0`；測試檔 49 個 |
  | `npm run lint`                                                                                                   | exit 0                                                        |
  | `npx tsx --test` 三個測試檔                                                                                      | 42／42                                                        |
  | `npx tsx --test tests/docker/*.test.ts`                                                                          | 5／5                                                          |
  | `npx prettier --check`（三份常青文件、issue 文件與證據的 md）                                                    | 通過                                                          |
  | 暫存目錄展開 `48944eb`，放入最終版測試後執行三個測試檔                                                           | 6／42 失敗：4 個延遲測試、簽章穩定性、`rate limiter` 斷言     |
  | 第一輪的兩份重現腳本對 HEAD 重跑                                                                                 | 每一列都正確                                                  |
  | 新寫的時序腳本（13 個情境）分別對 HEAD 與 `48944eb` 執行，另加「回呼不返回加使用者中止」                         | 結果寫在「M1 的複驗」與 S1                                    |
  | 簽章與限流字樣的腳本（8 組簽章情境、16 種措辭）、腳本與 TS 的 11 組比對                                          | 結果寫在 S2、N1、N2 與失敗面表格                              |
  | 以 Python 讀取五份原始回應 JSON、人工比對 `events.jsonl`／audit／狀態檔                                          | 結果寫在「步驟 5 重驗的原始檔核對」                           |

  審查結束時工作區唯一的變更是新增本報告檔。

## 流程判定

**PASS**

依 `docs/agents/review-evidence.md`：獨立審查完成、報告已保存、沒有 MUST FIX；SCN-001 至 SCN-007 都有有效證據，其中 SCN-006 是依提交的原始檔判定、沒有獨立執行；已辨識的失敗面都有結論。

S1 與 S2 不阻塞，但 S1 值得在合併後盡快處理或明確記為接受的取捨：它是這次修正引入的、單元層級可重現的退化，我判斷正式環境走不到，而這個判斷來自讀碼。若使用者認為「逾時與中止必須無條件能結束回合」是不可退讓的性質，可以把 S1 當成 MUST FIX 再退回一次；依我對現行規範與實際可達性的判斷，它屬於建議層級。

本報告綁定 HEAD `8bffb89`。之後若只新增這一份報告的提交，判定仍有效；其他任何新提交都需要重新審查。
