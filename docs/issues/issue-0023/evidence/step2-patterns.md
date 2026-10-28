# 步驟 2：判定樣式（SCN-005、006、007）

- 日期：2026-10-28
- 改動：
  - `src/core/rate-limit.ts`：新增 `UPSTREAM_QUOTA_EXHAUSTED_PATTERN`、`isUpstreamQuotaExhausted()`；`UPSTREAM_RATE_LIMIT_PATTERN` 的 1.18 分支措辭加上 `usage limit reached`
  - `scripts/probe-models.mjs`：同步兩份副本（`RATE_LIMIT_PATTERN`、新的 `QUOTA_EXHAUSTED_PATTERN`）
  - 新檔 `tests/opencode-quota-exhausted.test.ts`；`tests/probe-models-script.test.ts` 加一個副本比對測試

## 影響分析

- `UPSTREAM_RATE_LIMIT_PATTERN` 的使用點（`grep -rn`）：
  - `src/core/opencode.ts`：非串流的 `abortOnStderr` 與串流設定的 `rateLimitPattern`；
  - `src/core/rate-limit.ts` 的 `countUpstreamRateLimitHits()`，由 `src/services/model-health-check.ts` 使用；
  - `scripts/probe-models.mjs` 的副本。
- 措辭多了一種，所以這些地方遇到額度用完都會當成限流。健康檢查的處理在步驟 4（先判額度用完、再數限流次數）。

## 樣式

```text
message="stream error"[^\n]*\bsmall=false\b[^\n]*\berror\.error="AI_APICallError: [^"\n]*usage limit reached   （i）
```

結構和既有 1.18 分支相同，只換最後的措辭。

## 紅燈（最小實作前）

空殼：`UPSTREAM_QUOTA_EXHAUSTED_PATTERN = /(?!)/i`、`isUpstreamQuotaExhausted()` 永遠回 false，腳本沒有副本。

`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/opencode-quota-exhausted.test.ts tests/probe-models-script.test.ts`，exit 1：

```text
ok 1 - issue 0023 樣本：主代理與標題代理各一行
not ok 2 - issue 0023 SCN-005 真實樣本判定為額度用完，也觸發快速失敗
not ok 3 - issue 0023 SCN-005 認得「Free usage limit reached. Free models wo」
not ok 4 - issue 0023 SCN-005 認得「Usage limit reached」
not ok 5 - issue 0023 SCN-005 認得「Monthly usage limit reached for this pla」
not ok 6 - issue 0023 SCN-005 認得「USAGE LIMIT REACHED」
ok 7 - issue 0023 SCN-006 標題代理（small=true）那一行不判定為額度用完，也不觸發快速失敗
ok 8 - issue 0023 SCN-006 不是 stream error 的 log 行不判定為額度用完，也不觸發快速失敗
ok 9 - issue 0023 SCN-006 error.error 以外的欄位不判定為額度用完，也不觸發快速失敗
ok 10 - issue 0023 SCN-006 正常回合的回覆文字不判定為額度用完，也不觸發快速失敗
ok 11 - issue 0023 SCN-007 一般 429（1.18.34-upstream-429-retry.stderr.txt）仍是限流，不是額度用完
ok 12 - issue 0023 SCN-007 一般 429（1.18.34-upstream-429-retry-status-text.stderr.txt）仍是限流，不是額度用完
not ok 13 - issue 0023 額度用完的樣式只認主代理 stream error 的 error.error 欄位
ok 14 - SCN-007 上游 426 標示為不可用並列出狀態碼,不是空輸出(1.15.10 exit 0)
ok 15 - SCN-007 上游 426 標示為不可用並列出狀態碼,不是空輸出(1.18.34 exit 1)
ok 16 - SCN-007 表格輸出列出狀態碼與處置方向
ok 17 - SCN-007 410 的 error 事件標示為已下架
ok 18 - SCN-007 未列舉的狀態碼標示為上游錯誤
ok 19 - SCN-007 模型不存在仍由 stderr 判定
ok 20 - SCN-007 認得 opencode 1.18 stderr 裡的限流
ok 21 - SCN-005 正常回合標示為可用,即使回覆文字提到 426 與 error
ok 22 - 限流樣式與 src/core/rate-limit.ts 的那一份完全相同
not ok 23 - issue 0023 額度用完的樣式與 src/core/rate-limit.ts 的那一份完全相同
# tests 23
# pass 16
# fail 7
```

- 2～6：真實樣本與 SCN-005 的寫法都沒被認出，快速失敗樣式也不命中。
- 13：樣式沒有限定欄位。23：腳本沒有副本。
- 7～12 先綠：反例（SCN-006）與一般 429（SCN-007）在實作前本來就不會被判成額度用完。它們擋的是樣式寫太寬，由下面的突變證明。

紅燈之後，SCN-006 補了一個反例：「標題代理（`small=true`）回 `AI_APICallError` 的同一句」。只用真實的標題代理行（`AI_RetryError`）擋不住拿掉 `small=false` 的突變。

## 綠燈（最小實作後）

同一組測試加上 `tests/opencode-rate-limit-failfast.test.ts`：`# tests 29`、`# pass 29`。補反例後兩個檔是 `# tests 24`、`# pass 24`。

## 突變（只改 `src/core/rate-limit.ts`）

| 突變 | 結果 |
|------|------|
| Q1：拿掉 `small=false` 限定 | 8（標題代理的 `AI_APICallError`）、14 轉紅 |
| Q2：拿掉 `stream error` 限定 | 9、14 轉紅 |
| Q3：拿掉 `error.error` 欄位限定 | 10 轉紅 |
| Q4：區分大小寫 | 4、6、14 轉紅 |
| Q5：快速失敗樣式不認 `usage limit reached` | 2～6 轉紅 |

腳本副本若各自演化，由 `tests/probe-models-script.test.ts` 的兩個副本比對測試擋下。每個突變後都還原檔案並以 `cmp` 確認，還原後全綠。

## 其他檢查

- `npm run build`：exit 0。
- `npx eslint src/core/rate-limit.ts`：exit 0。
- `npx prettier --check`：四個檔都通過。
- 相關測試（`tests/opencode-*.test.ts`、`tests/model-health-*.test.ts`）：`# tests 166`、`# pass 166`。

## 精煉

新樣式與既有 1.18 分支的前段相同，但兩者是 regex 字面值，而且腳本副本要逐字比對，抽共用片段反而讓比對更難，所以保留兩份字面值。記為 no-op。
