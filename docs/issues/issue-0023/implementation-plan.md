# Issue 0023 實作計畫

驗收劇本、風險與首要驗證見 [README.md](README.md)。

## 設計方案

### 判定樣式（SCN-005～007）

`src/core/rate-limit.ts` 新增 `UPSTREAM_QUOTA_EXHAUSTED_PATTERN`，結構和現有 1.18 分支相同，只換最後的措辭：

```text
message="stream error"[^\n]*\bsmall=false\b[^\n]*\berror\.error="AI_APICallError: [^"\n]*usage limit reached   （不分大小寫）
```

- `UPSTREAM_RATE_LIMIT_PATTERN` 的 1.18 分支措辭清單加上 `usage limit reached`。這樣既有的快速失敗（非串流 `abortOnStderr`、串流 `rateLimitPattern`）不必改接線就會中止。
- 新增 `isUpstreamQuotaExhausted(output)`，命中後由呼叫端決定訊息與 scope。
- `countUpstreamRateLimitHits()` 會把額度用完的行也算進去。健康檢查要先判額度用完，再數限流次數（見下）。
- `scripts/probe-models.mjs` 的副本同步修改，`tests/probe-models-script.test.ts` 繼續比對兩份字串；新的樣式也照同樣方式加一份副本與比對。

### 聊天與排程（SCN-001、002）

- 新增共用的額度用完訊息常數，內容涵蓋：免費額度已用完、同帳號的其他免費模型也會被擋、可以等額度恢復／訂閱 OpenCode Go／在 `ai-config.yaml` 換成其他 provider 的模型。不寫 HTTP 429。
- 非串流（`src/core/opencode.ts`）：收到 `ERATELIMIT` 時，用子程序的 stderr 判斷 `isUpstreamQuotaExhausted`。命中就回額度訊息、記錄 `opencode:quota-exhausted`；沒命中照舊。`failure.kind` 一律是 `rate-limit`。
  - 實作時先確認 `ProcessError` 帶得到中止前的 stderr；帶不到就在 `abortOnStderr` 命中時保留觸發的那段文字。
- 串流（`src/core/cli-agent-base.ts`）：`rateLimited` 時同樣依當下累積的 stderr 選訊息與 scope。`CliAgentConfig` 加一個選填的額度設定（樣式＋訊息），不影響其他 provider。
- 排程不改：它拿到的是回覆文字，結果訊息自然變成額度說明。

### 健康檢查（SCN-003）

- `FailureCategory` 加 `quota-exhausted`。所有比對這個型別的 `switch`／`if` 分支要手動找齊（[project.md](../../agents/project.md)：編譯器不檢查漏處理的分支）。
- `defaultProbe()`：stderr 一出現額度用完就 `terminateProcessTree(child)` 並結束，outcome 是 `quota-exhausted`，訊息取上游那句。一般 429 不在這裡中止（SCN-007）。
- `interpretProbeOutput()`：在數限流次數之前先判額度用完，避免它被當成 `rate-limited`。
- 告警文字（`formatAlertMessage` 一類的函式）新增 `quota-exhausted` 分支。
- `failureSignature()`：簽章取自類別與訊息前段；上游訊息固定，所以同一個故障簽章不變，沿用既有提醒間隔。實作時以兩次探測確認。

### models:probe（SCN-004）

- `VERDICTS` 加 `quota-exhausted`，標籤 `⛔ 額度用完`。
- `classify()` 在 `RATE_LIMIT_PATTERN` 之前先判額度用完。
- 每輪執行時 stderr 命中額度用完就中止子程序，不等 `--timeout`。

## 實作步驟

1. ✅ **擷取真實樣本，確認現行樣式不命中**（首要驗證；SCN-005、006）——證據：[evidence/step1-real-sample.md](evidence/step1-real-sample.md)。主代理行約 1.6 秒出現，stdout 沒有事件，現行樣式不命中
   - 做法：在 agent-runner 容器內，以 TeleNexus 的參數 `opencode run --format json --print-logs --log-level ERROR --model opencode/big-pickle "Reply with exactly: OK"`，stdin 接 `/dev/null`（[L-12](../../agents/landmines.md#l-12-opencode-run-在-stdin-沒關時一直等待)），跑約 30 秒後中止。stdout 與 stderr 分開存成 `tests/fixtures/opencode/1.18.34-free-usage-limit.{stdout.jsonl,stderr.txt}`。
   - 不寫入正式資料；這一次呼叫只會被上游拒絕。探測建立的 session 用 `opencode session delete` 刪掉。
   - 完成判準：證據檔記錄主代理行與標題代理行的次數、stdout 有沒有 error 事件，以及現行 `UPSTREAM_RATE_LIMIT_PATTERN` 不命中。樣本若含家目錄路徑等可識別資訊，揭露處理方式（[L-10](../../agents/landmines.md)）。
   - 相依：無（SCN 已於 2026-10-28 核准）；必須在額度恢復前完成（README TBD-1）。
2. ✅ **判定樣式**（SCN-005、006、007）——證據：[evidence/step2-patterns.md](evidence/step2-patterns.md)。紅燈 7/23；綠燈；5 個突變都轉紅
   - 做法：先寫測試，用步驟 1 的樣本、SCN-005 的三種寫法、SCN-006 的三種反例，以及既有的 429 樣本確認失敗，再改 `rate-limit.ts` 與 `probe-models.mjs` 的副本。
   - 完成判準：紅燈、綠燈與突變（拿掉 `small=false` 限定、拿掉 `error.error` 限定、改成區分大小寫）都轉紅。
   - 相依：步驟 1。
3. ✅ **聊天與排程**（SCN-001、002）——證據：[evidence/step3-chat-and-schedule.md](evidence/step3-chat-and-schedule.md)。紅燈 2/4；綠燈；5 個突變都轉紅；全套 `# tests 608`
   - 做法：非串流與串流各寫一個以假 opencode（stderr 輸出步驟 1 樣本後持續等待）驅動的測試，確認約 1 秒內回額度訊息、scope 是 `opencode:quota-exhausted`、`failure.kind` 是 `rate-limit`；既有 429 測試照舊通過。串流測試的 `onEvent` 用 async 延遲回呼（[L-05](../../agents/landmines.md#l-05-串流測試用同步回呼測不到漏行)）。
   - 完成判準：紅燈、綠燈；突變「一律回 429 訊息」會轉紅。
   - 相依：步驟 2。
4. ⏳ **健康檢查**（SCN-003）
   - 做法：`interpretProbeOutput` 的單元測試，加上 `defaultProbe` 以假 opencode 驅動的測試，確認不等到逾時就結束；告警文字與簽章穩定性的測試。
   - 完成判準：紅燈、綠燈；突變「不中止」「類別判成 rate-limited」會轉紅；既有 `RATE_LIMIT_DEGRADED_THRESHOLD` 測試照舊。
   - 相依：步驟 2。
5. ⏳ **models:probe**（SCN-004）
   - 做法：`tests/probe-models-script.test.ts` 加額度用完的判定與中止測試。
   - 完成判準：紅燈、綠燈；`--timeout` 很長時該輪仍很快結束。
   - 相依：步驟 2。
6. ⏳ **文件與交付檢查**
   - 做法：更新 `CLAUDE.md`（Upstream 429 fail-fast、Model health check）、`docs/configuration-reference.md`、`tests/fixtures/opencode/README.md`；執行 `npm run build`、`npm run test`（核對 `# tests` 與測試檔數）、`npm run lint`。
   - 完成判準：全部通過。
   - 相依：步驟 1～5。

## 測試策略

| 層級 | 對象 | 理由 |
|------|------|------|
| 真實樣本 | 步驟 1 | 樣式的期望值必須來自 opencode 1.18.34 對真實上游的輸出（L-03） |
| 單元 | 樣式、`interpretProbeOutput`、告警文字、簽章 | 純函式，邊界案例多 |
| 子程序 | 非串流、串流、`defaultProbe`、`probe-models.mjs` | 快速失敗的價值在「中止子程序」，只有實際 spawn 才驗得到時間 |
