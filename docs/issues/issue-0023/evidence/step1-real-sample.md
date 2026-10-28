# 步驟 1：擷取真實樣本，確認現行樣式不命中（首要驗證）

- 日期：2026-10-28（擷取時間 04:14:34 UTC，免費額度仍處於用完狀態）
- 環境：正式部署的 agent-runner 容器（`ghcr.io/raybird/telenexus:v2.32.0`），opencode 1.18.34
- 樣本：[`tests/fixtures/opencode/1.18.34-free-usage-limit.stderr.txt`](../../../../tests/fixtures/opencode/1.18.34-free-usage-limit.stderr.txt)

## 命令

在容器內 `/tmp` 執行，參數和 TeleNexus 相同，stdin 接 `/dev/null`（L-12），30 秒後由 `timeout` 中止：

```bash
timeout 30 opencode run --format json --print-logs --log-level ERROR \
  --model opencode/big-pickle "Reply with exactly: OK" </dev/null >/tmp/q.stdout 2>/tmp/q.stderr
```

結果：`exit=124`（被 `timeout` 中止），經過 30 秒，stdout 0 bytes，stderr 780 bytes。

收尾：
- 用 `opencode session delete` 刪掉這次建立的 session，`opencode session list` 確認已不存在；
- 刪掉容器內的 `/tmp/q.*`。

這次呼叫被上游拒絕，沒有寫入任何正式資料。

## 樣本內容

stderr 共兩行：

| 時間（相對開始） | 代理 | `error.error` |
|------------------|------|---------------|
| 約 1.6 秒 | 主代理（`small=false agent=build`） | `AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go` |
| 約 8.5 秒 | 標題代理（`small=true agent=title`） | `AI_RetryError: Failed after 3 attempts. Last error: Free usage limit reached. …` |

- 主代理那一行的格式和正式部署 `opencode.log` 裡的行相同：`message="stream error"`、`small=false`、`error.error="AI_APICallError: …"`。所以設計方案的比對位置成立。
- 主代理第一次被拒後，之後 28 秒 stderr 沒有任何新行：opencode 在背景退避重試，不再印出來。所以要在第一行就中止；等第二行沒有意義。
- **stdout 完全是空的，沒有 `error` 事件**：結構化的 `findUpstreamError()` 路徑抓不到，只能靠 stderr 樣式。沒有另存 stdout 樣本，因為 0 bytes。
- 樣本裡沒有家目錄路徑或帳號資訊；`run`、`session.id` 是這次探測的隨機值，session 已刪除。

## 現行樣式

```text
current pattern matches: false
main lines: 1 title lines: 1
```

（`npx tsx -e` 讀樣本，測試 `src/core/rate-limit.ts` 的 `UPSTREAM_RATE_LIMIT_PATTERN`。）

現行樣式不命中，和正式部署的症狀一致：不會快速失敗，回合跑到逾時。

## 結論

首要驗證成立：真實輸出就是 log 裡的那一行，主代理的行在約 1.6 秒出現，stdout 沒有事件。之後的步驟以這份樣本為期望值。README 的 TBD-1 解除。
