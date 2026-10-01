# 步驟 1：opencode 1.18.34 相容性探測

- 執行日期：2026-10-01（UTC 07:12 至 07:25）
- 被測版本：`opencode-ai@1.15.10`（現行釘版，對照組）、`1.18.34`（候選）、`1.18.0` 與 `1.18.17`（只測上游錯誤路徑，確認行為在整個 1.18 系列一致）
- 被測提交：`da76420`（尚未改任何程式）
- 驗收編號：SCN-004、SCN-006

## 方法

每個樣本以 [step1-cap.sh](./step1-cap.sh) 執行：各版本裝在獨立目錄，`HOME` 與四個 `XDG_*` 指到該版本專用的空目錄，工作目錄是空的暫存資料夾，stdout、stderr、exit code 與耗時分別存檔。沒有使用任何既有的 opencode 登入資料或工作區。

真實上游用免費層模型 `opencode/big-pickle`（不需登入）。免費層無法指定回哪個狀態碼，所以另外用兩個本機假上游：

- [step1-mock-upstream.mjs](./step1-mock-upstream.mjs)：依模型名回指定的 HTTP 錯誤，以 [step1-mock-opencode.json](./step1-mock-opencode.json) 掛成自訂 provider。`n429` 回的是既有測試裡那筆真實 nvidia 429 的 body（`{"status":429,"title":"Too Many Requests"}`）。
- [step1-mock-tool.mjs](./step1-mock-tool.mjs)：回一個讀取工作目錄外檔案的工具呼叫，用來在舊版無法連上免費層的情況下比較權限行為。

假上游本身先經過對照：1.15.10 對假上游的 426 與對真實免費層的 426，exit code、stdout 的事件結構、stderr 的 `"statusCode":426` 都相同（`a-426-old` 對 `f-mock426-old`）。所以假上游在新版上觀察到的差異來自 opencode，而不是假上游。

每個樣本的 exit code、耗時與位元組數在 [step1-samples.txt](./step1-samples.txt)。作為測試 fixture 的原始輸出在 `tests/fixtures/opencode/`。

## 與現有假設的逐項比對

| 假設                                                                      | 1.18.34 的實際行為                                                                                           | 樣本                                               | 結論                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------- |
| `run`、`-c`、`--model`、`--format json`、`--print-logs --log-level ERROR` | 全部仍被接受。`-c` 接回同一個 `sessionID`                                                                    | `b-ok-new`、`d-continue-new`                       | 相符                         |
| 正常回合的事件：`step_start`、`text`、`step_finish`                       | 型別與欄位相同：頂層 `sessionID`、`part.text`、`step_finish` 的 `tokens`／`cost`／`reason`                   | `b-ok-new`                                         | 相符                         |
| `tool_use` 事件的 `part.tool`、`part.state.input`                         | 相同，另有 `state.status`、`state.title`、`state.output`。工具回合的 `step_finish.reason` 是 `tool-calls`    | `c-tool-1.18.34-yolo1`                             | 相符                         |
| 預設格式（不帶 `--format`）的 stdout 是純文字回覆                         | 相同。banner（`> build · 模型`）在 stderr                                                                    | `i-default-ok-new`                                 | 相符                         |
| 上游錯誤時 stdout 有 `error` 事件，含 `error.data.statusCode`             | 結構相同：`error.name` 為 `APIError`，`error.data` 有 `message`、`statusCode`、`isRetryable`、`responseBody` | `f-mock426-new`、`h-mock-s410-new`                 | 相符                         |
| 上游錯誤時 exit 0                                                         | **exit 1**。1.18.0 與 1.18.17 相同                                                                           | `f-mock426-new`、`bisect-426-*`                    | **差異 1**                   |
| `--print-logs` 的 stderr 含 `"statusCode":NNN`                            | **不含**。格式改成 logfmt，只剩 `error.error="AI_APICallError: <上游訊息>"`，不再回吐 request body           | `f-mock426-new`、`g-mock429-new`                   | **差異 2**                   |
| 429 時 stderr 命中 `UPSTREAM_RATE_LIMIT_PATTERN`                          | **0 次命中**。`WARN`、`INFO`、`DEBUG` 三個等級也都沒有狀態碼。opencode 持續退避重試，stdout 全程 0 bytes     | `g-mock429-new`、`g-mock429-new-{WARN,INFO,DEBUG}` | **差異 2**                   |
| 410 時 stderr 命中 `UPSTREAM_MODEL_INVALID_PATTERN`                       | **0 次命中**（stderr 只有 `AI_APICallError: Gone`）。stdout 的 `error` 事件有 `statusCode: 410`              | `h-mock-s410-new`                                  | **差異 3**                   |
| `Model not found` 時 exit 1、stderr 命中失效樣式                          | 相同（命中 2 次）。stdout 另有一個 `error` 事件，`name` 是 `UnknownError`、**沒有 `statusCode`**             | `e-notfound-new`                                   | 相符；事件可能不帶狀態碼     |
| 升級後能接手舊版的資料目錄                                                | 以 1.15.10 建出的資料目錄執行 1.18.34 加 `-c`：exit 0、接回原 session、得到文字回覆                          | `j-migrate-continue`                               | 相符                         |
| 權限行為                                                                  | 兩版相同：讀工作目錄外的檔案都被自動拒絕，`OPENCODE_YOLO=1` 在兩版都沒有作用                                 | `m-perm-*`、`l-perm-*`                             | 無退化（見「範圍外的觀察」） |

`opencode run --help` 的差異在 [step1-run-help-1.15.10-vs-1.18.34.diff](./step1-run-help-1.15.10-vs-1.18.34.diff)。TeleNexus 用到的參數都還在；`--dangerously-skip-permissions` 改名為 `--auto`、`--replay` 與 `--demo` 被移除，TeleNexus 都沒有使用。

### 現有樣式對 1.18.34 stderr 的命中次數

以 `grep -ciE` 套用 `src/core/rate-limit.ts` 的兩個樣式，以及 `opencode.ts` 串流路徑的寬鬆樣式：

| 樣本                          | `UPSTREAM_RATE_LIMIT_PATTERN` | `UPSTREAM_MODEL_INVALID_PATTERN` | 串流的寬鬆樣式 |
| ----------------------------- | ----------------------------- | -------------------------------- | -------------- |
| 429，訊息含 `rate limit`      | 0                             | 0                                | 0              |
| 429，訊息 `Too Many Requests` | 0                             | 0                                | 4              |
| 500                           | 0                             | 0                                | 0              |
| 410                           | 0                             | 0                                | 0              |
| 426                           | 0                             | 0                                | 0              |
| 模型不存在                    | 0                             | 2                                | 0              |

對照組：1.15.10 對同一個假上游的 429，45 秒內 `"statusCode":429` 出現 9 次（`g-mock429-old`）。

## 差異與處理方式

### 差異 1：上游錯誤從 exit 0 變成 exit 1

現有程式在 exit 非 0 時直接丟出 `ProcessError`，不看 stdout。升版後上游錯誤不再靜默，但會變成通用的執行失敗：使用者看不到狀態碼，經 runner 執行時還會被算進斷路器。

處理：步驟 2 的判定同時涵蓋兩種結束方式。exit 0 走正常路徑、exit 非 0 走 `ProcessError` 帶出的 stdout，兩邊都解析 `error` 事件並回傳同一種結構化失敗。fixture 兩種都有：`1.15.10-upstream-426.stdout.jsonl`（真實、exit 0）與 `1.18.34-upstream-426.stdout.jsonl`（exit 1）。

### 差異 2：stderr 不再有狀態碼，429 快速中止會失靈

這是 README 列的最大風險實際發生的樣子。只升釘版不改樣式的話，429 會一路退避到 `OPENCODE_TASK_TIMEOUT_MS`，重演 2026-08-25 的情況。

opencode 在重試期間不輸出任何 stdout 事件，1.18 系列也沒有可以關掉重試的設定（`https://opencode.ai/config.json` 的 schema 沒有任何重試相關的鍵）。唯一即時可見的訊號是 stderr 的這一行：

```text
level=ERROR message="stream error" providerID=… modelID=… small=false agent=build … error.error="AI_APICallError: <上游訊息>"
```

處理：步驟 2 在 `UPSTREAM_RATE_LIMIT_PATTERN` 增加一個認這種行的分支，條件是主代理（`small=false`）的 `stream error`，而且上游訊息含限流字樣。已知的真實字樣有兩種：nvidia 的 `Too Many Requests`（body 沒有 `error.message` 時 opencode 退回 HTTP 狀態文字，`g-mock-n429-new` 重現）與免費層的 `Rate limit exceeded`（`docs/2026-08-16-runtime-resource-handover.md` 記錄的 `FreeUsageLimitError`）。舊格式的分支保留，主機上以舊版 opencode 開發時仍然有效。

這個分支比對的是文字，但範圍限定在 `error.error` 欄位內。新格式不再回吐 request body，這個欄位只有上游的錯誤訊息，所以 `rate-limit.ts` 註解裡「市場數據誤觸」的來源不存在於這個欄位。限定 `small=false` 是因為標題代理用的是另一顆小模型，它被限流不代表主模型不能用。

殘餘風險：上游改用這兩種以外的措辭時，快速中止不會觸發，回合會退避到逾時。它仍然被記為失敗（`failure.kind` 為 `timeout`），不是靜默，只是慢而且分類不準。列為 README 的 TBD-3。

### 差異 3：410 在 stderr 只剩 `Gone`

處理：410 改由 stdout 的 `error` 事件判定（`statusCode: 410`），這本來就是步驟 2 與步驟 3 的設計。健康檢查探針目前不帶 `--format json`，在 1.18.34 上遇到 410 會落到 `unknown`，告警會說「無法確認」而不是「模型已失效」；步驟 3 把探針改成 JSON 格式後解決。stderr 的失效樣式保留給 `Model not found`，那條路徑的事件不帶狀態碼。

## TBD-1 的結論

釘 `opencode-ai@1.18.34`。理由：上面所有樣本都是在這個版本上取得的，釘別的版本等於沒有證據；上游要求的最低版本是 1.18.0，而 1.18.0、1.18.17、1.18.34 在上游錯誤路徑上的行為一致。這個版本發佈於 2026-09-30，距探測不到一天，步驟 5 會以完整映像再驗證一次。

## 範圍外的觀察

`docker-compose.yml` 設定的 `OPENCODE_YOLO=1` 在 1.15.10 與 1.18.34 都沒有作用：讀取工作目錄外的檔案在兩版、有無這個變數的四種組合下都被自動拒絕（`m-perm-*`）。這是既有狀況，升版沒有讓它變好或變壞，不在本 issue 處理。

## 完成判準核對

| 判準                                          | 證據                                                 |
| --------------------------------------------- | ---------------------------------------------------- |
| 正常回合的事件型別與欄位                      | `b-ok-new`、`c-tool-1.18.34-yolo1`                   |
| 上游錯誤回合的 `error` 事件結構與 exit code   | `a-426-old`（真實 426）、`f-mock426-new`、`h-mock-*` |
| 至少取得現行 1.15.10 的 426 樣本              | `a-426-old`，stdout 736 bytes，與事故紀錄的指紋相同  |
| 四組參數仍被接受                              | `b-ok-new`、`d-continue-new`、help 的 diff           |
| `--print-logs` 的 stderr 是否仍含結構化狀態碼 | 不含，見差異 2                                       |
| 有差異的項目都寫明處理方式                    | 差異 1 至 3                                          |
| 樣本以去敏的 fixture 保存                     | `tests/fixtures/opencode/`，已掃描無本機路徑與憑證   |

## 反向自檢（SCN-006 的判準）

「呼叫成功」的判準是 stdout 有 `text` 事件且沒有 `error` 事件。呼叫失敗時兩者都會不同：同一個 prompt、同一顆模型，1.15.10 得到的是單一 `error` 事件、沒有 `text`（`a-426-old`），1.18.34 得到 `text` 事件（`b-ok-new`）。判準在失敗時不會是綠的。
