# 步驟 3：聊天與排程（SCN-001、002，含 SCN-007 對照）

- 日期：2026-10-28
- 改動：
  - `src/core/opencode.ts`：新增 `OPENCODE_QUOTA_EXHAUSTED_MESSAGE`。非串流收到 `ERATELIMIT` 時，用 `ProcessError.stderr`（`abortOnStderr` 中止時帶著觸發的 stderr）判斷是不是額度用完，決定訊息與 scope。`CliAgentConfig` 帶 `quotaExhausted` 設定。
  - `src/core/cli-agent-base.ts`：`CliAgentConfig` 加選填的 `quotaExhausted`。串流路徑中止後，依當下累積的 stderr 選訊息與 scope。
  - 新檔 `tests/opencode-quota-failfast.test.ts`

## 影響分析

- `CliAgentConfig` 只有 `OpencodeAgent` 實作（`grep -rn "CliAgentConfig" src`），新欄位是選填的。
- `ERATELIMIT` 的處理只在 `OpencodeAgent` 的非串流路徑一處。摘要路徑（`summarize`）同樣用 `OPENCODE_RATE_LIMIT_ABORT` 中止，但它不回覆使用者也不記 runtime issue，所以不改。
- `failure.kind` 仍是 `rate-limit`，所以 `deriveRunOutcome()`（runner-audit 的 `ok`）與 `DynamicAIAgent` 的斷路器都不變（Q1）。

## 測試做法

用假的 `opencode` 放在 PATH 最前面：先把步驟 1 的真實 stderr 寫出，再睡 20 秒，模擬 opencode 背景重試、stdout 空白。`OPENCODE_TASK_TIMEOUT_MS=8000` 當保險絲。串流的 `onEvent` 是延遲 30ms 的 async 回呼（L-05）。

每種模式都有兩個測試：
- **額度用完**：4 秒內結束；訊息含「免費額度已用完」「其他免費模型」「OpenCode Go」「provider」，不含 `429`；`failure.kind` 是 `rate-limit`；`deriveRunOutcome().ok` 是 false；新增的 runtime issue 是 `opencode:quota-exhausted`，沒有 `opencode:rate-limit`。
- **一般 429（SCN-007）**：沿用 `HTTP 429` 訊息與 `opencode:rate-limit`。

## 紅燈

步驟 2 之後，額度用完已經會快速中止，但訊息與 scope 還是 429 的。

`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/opencode-quota-failfast.test.ts`，exit 1：

```text
not ok 1 - issue 0023 SCN-001 non-stream 遇到額度用完，快速失敗並說明原因
ok 2 - issue 0023 SCN-007 non-stream 一般 429 仍回限流訊息與 opencode:rate-limit
not ok 3 - issue 0023 SCN-001 stream 遇到額度用完，快速失敗並說明原因
ok 4 - issue 0023 SCN-007 stream 一般 429 仍回限流訊息與 opencode:rate-limit
# tests 4
# pass 2
# fail 2
```

1 的失敗訊息：`The input did not match the regular expression /免費額度已用完/. Input: '⏳ Opencode 上游配額已達上限 (HTTP 429)…'`。2、4 是既有行為的對照，先綠。

## 綠燈

同一命令，exit 0：`# tests 4`、`# pass 4`。

## 突變

| 突變 | 結果 |
|------|------|
| R1：非串流一律當限流（不看 stderr） | 1 轉紅 |
| R2：串流一律當限流 | 3 轉紅 |
| R3：`OpencodeAgent` 不帶 `quotaExhausted` 設定 | 3 轉紅 |
| R4：非串流訊息對，但 scope 一律 `opencode:rate-limit` | 1 轉紅 |
| R5：串流訊息對，但 scope 一律 `rate-limit` | 3 轉紅 |

每個突變後都還原檔案並以 `cmp` 確認，還原後全綠。R4 第一次用字串取代時沒有套用（prettier 把那行拆成多行，腳本因為比對不到而中止），改用行號取代後重跑，上表是重跑的結果。

## SCN-002（排程）的覆蓋

排程經 `Scheduler.executeTask()` 呼叫 agent 的 `chat()`，拿到的是回覆文字。限流這類降級結果會正常 resolve，排程把文字當結果送到 Telegram（README「已確認的現況」，使用者核准的 (b)）。所以排程看到的就是上面非串流測試驗證的訊息，而且 4 秒內結束，不會撞到 `SCHEDULE_TASK_TIMEOUT_MS`、不會記成 `scheduler:task-timeout`。排程這一層沒有改，沒有另寫測試。

## 其他檢查

- `npm run build`、`npm run lint`：exit 0。
- `npx prettier --check`：三個檔都通過。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test`：exit 0，`# tests 608`、`# pass 608`、`# fail 0`。

## 精煉

兩條路徑各自判斷一次額度用完，是因為非串流拿得到的是 `ProcessError.stderr`，串流拿得到的是自己累積的 `stderr`，兩者的結果組法也不同，沒有可合併的重複。記為 no-op。
