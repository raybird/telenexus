# 審查修正：review-3246b66 的發現

- 日期：2026-10-28
- 來源：[review-3246b66.md](../review-3246b66.md)。判定 PASS，但有 1 項 SHOULD FIX，所以沒有自動合併。

## S1（SHOULD FIX）：非串流額度用完的 runtime issue 與 `failure.message` 仍寫 HTTP 429

- 改動 `src/core/opencode.ts`：
  - 新增 `OPENCODE_QUOTA_EXHAUSTED_REASON`；
  - `ERATELIMIT` 分支遇到額度用完時另建一個 `Error`，runtime issue 與 `failure.message` 都用它；
  - 一般限流的分支保持原樣。
- 測試 `tests/opencode-quota-failfast.test.ts`：額度用完的兩個測試加上斷言——`failure.message` 不含 `429`、`rate-limit`，且含 `quota exhausted`；所有 `opencode:quota-exhausted` 紀錄的訊息都不含 `429`、`rate-limit`。

紅燈（修正前，整檔執行），exit 1：

```text
not ok 1 - issue 0023 SCN-001 non-stream 遇到額度用完，快速失敗並說明原因
ok 2 - issue 0023 SCN-007 non-stream 一般 429 仍回限流訊息與 opencode:rate-limit
not ok 3 - issue 0023 SCN-001 stream 遇到額度用完，快速失敗並說明原因
ok 4 - issue 0023 SCN-007 stream 一般 429 仍回限流訊息與 opencode:rate-limit
# tests 4
# pass 2
# fail 2
```

- 1：`failure.message` 是 `Opencode upstream rate-limited (HTTP 429)…`。
- 3：串流路徑本身的訊息已經正確，單獨跑 `--test-name-pattern="SCN-001 stream"` 是綠的。整檔執行時轉紅，是因為記憶體緩衝裡還有非串流記下的那筆 `opencode:quota-exhausted`（訊息含 429）。所以這題轉紅反映的也是 S1。
- 第一版斷言用 `find()` 只取第一筆紀錄，3 轉紅的原因不對；改成檢查每一筆，上面是改完後的結果。

綠燈：同一命令 `# tests 4`、`# pass 4`。

| 突變 | 結果 |
|------|------|
| F1：`failure.message` 退回 429 那句 | 1 轉紅 |
| F2：runtime issue 退回原本的 `ProcessError` | 1、3 轉紅 |

## N1（NICE TO HAVE）：models:probe 判成額度用完時仍印 `429×N`

- 改動 `scripts/probe-models.mjs`：該輪判成 `quota-exhausted` 時，`rateLimitHits` 記 0。
- 測試 `tests/probe-models-script.test.ts`：表格不含 `429×`，`rateLimitHits` 是 0。修正前轉紅（實際印出 `429×1`），修正後轉綠。
- 突變 F3（額度用完仍計 429 次數）：12 轉紅。

## N5（NICE TO HAVE）：README 寫「SCN-001～008」

改成「SCN-001～007」。

## 沒有處理的項目與理由

- N2：`models:probe` 中止時只 `SIGKILL` 直接的子程序。逾時路徑本來就是這樣，正式映像裡的 opencode 是原生 binary，維持既有做法。
- N3：log 行剛好在 `reached` 之後被切成兩段時，健康檢查的訊息會退回整段輸出。這只影響訊息內容，判定與中止不受影響，實務上也不太會發生。
- N4：`defaultProbe` 中止時呼叫的 `finish(...)` 和隨後 `close` 事件給的結果相同，所以拿掉它測試仍是綠的。保留的理由：子程序的孫程序如果還佔著 stderr 管線，`close` 會晚到；直接 `finish` 不必等它。

## 其他檢查

- `npm run build`、`npm run lint`：exit 0。
- `npx prettier --check`：四個改動檔都通過。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test`：exit 0，`# tests 618`、`# pass 618`、`# fail 0`。新增的是斷言，不是測試，所以測試數不變。
- 每個突變後都還原檔案並以 `cmp` 確認。
