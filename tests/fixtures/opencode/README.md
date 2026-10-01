# opencode 輸出樣本

2026-10-01 擷取的原始輸出，檔名開頭是 opencode 版本。擷取方式與每個樣本的 exit code 見 `docs/issues/issue-0008/evidence/step1-compat-probe.md`。

內容不要手改：測試的期望值來自這些真實輸出。opencode 升版後事件格式有變時，重新擷取並換檔。

| 檔案                                                  | 來源                           | exit   | 內容                                                                  |
| ----------------------------------------------------- | ------------------------------ | ------ | --------------------------------------------------------------------- |
| `1.15.10-upstream-426.stdout.jsonl`                   | 真實免費層                     | 0      | 單一 `error` 事件，`statusCode` 426                                   |
| `1.18.34-upstream-426.stdout.jsonl`、`.stderr.txt`    | 本機假上游                     | 1      | 同上；stderr 是 1.18 的 logfmt，沒有狀態碼                            |
| `1.18.34-upstream-410.stdout.jsonl`                   | 本機假上游                     | 1      | 單一 `error` 事件，`statusCode` 410                                   |
| `1.18.34-model-not-found.stdout.jsonl`、`.stderr.txt` | 真實（不存在的模型名）         | 1      | `error` 事件沒有 `statusCode`；stderr 有 `ProviderModelNotFoundError` |
| `1.18.34-ok.stdout.jsonl`                             | 真實免費層                     | 0      | 正常回合：`step_start`、`text`、`step_finish`                         |
| `1.18.34-ok-mentions-426.stdout.jsonl`                | 真實免費層                     | 0      | 正常回合，回覆文字裡有 `426`、`error`、`"statusCode":426`、`429`      |
| `1.18.34-tool-use.stdout.jsonl`                       | 真實免費層                     | 0      | 含一次 `bash` 工具呼叫的回合                                          |
| `1.18.34-upstream-429-retry.stderr.txt`               | 本機假上游                     | 被中止 | 重試中的 stderr，上游訊息含 `rate limit`                              |
| `1.18.34-upstream-429-retry-status-text.stderr.txt`   | 本機假上游（真實 nvidia body） | 被中止 | 重試中的 stderr，上游訊息是 `Too Many Requests`                       |
| `1.18.34-upstream-500-retry.stderr.txt`               | 本機假上游                     | 被中止 | 重試中的 stderr，500                                                  |

429 與 500 的樣本裡，模型名是 `s429`、`n429`、`s500`。這是假上游用來決定回哪個狀態碼的名稱，判定樣式不該因為模型名裡的數字而命中。
