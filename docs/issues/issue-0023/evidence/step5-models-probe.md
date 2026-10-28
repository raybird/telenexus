# 步驟 5：models:probe（SCN-004，含 SCN-007 對照）

- 日期：2026-10-28
- 改動：
  - `scripts/probe-models.mjs`：
    - `VERDICTS` 加 `quota-exhausted`（`⛔ 額度用完`），排序在限流之後、下架之前，後面的 order 依序加一；
    - `runCommand()` 加選填的 `abortPattern`，stderr 命中就 `SIGKILL`；
    - `classify()` 最先判額度用完（和 `interpretProbeOutput()` 相同順序）；
    - `probeModel()` 每輪傳入 `QUOTA_EXHAUSTED_PATTERN`。
  - `tests/probe-models-script.test.ts`：假 `opencode` 加 `FAKE_OPENCODE_SLEEP`（`exec sleep`，被 kill 時不會留下佔住管線的子程序），新增 3 個測試。

## 影響分析

- `VERDICTS[...].order` 只用在 `worstVerdict()` 與 `renderTable()` 的排序。腳本的 exit code 只看是不是全部 `ok`，所以重新編號不影響其他判定。
- `runCommand()` 只有 `probeModel()` 一個呼叫者（`opencode models` 的清單另有讀法），新參數是選填的。

## 紅燈（最小實作前）

`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/probe-models-script.test.ts`，exit 1：

```text
ok 1 - SCN-007 上游 426 標示為不可用並列出狀態碼,不是空輸出(1.15.10 exit 0)
ok 2 - SCN-007 上游 426 標示為不可用並列出狀態碼,不是空輸出(1.18.34 exit 1)
ok 3 - SCN-007 表格輸出列出狀態碼與處置方向
ok 4 - SCN-007 410 的 error 事件標示為已下架
ok 5 - SCN-007 未列舉的狀態碼標示為上游錯誤
ok 6 - SCN-007 模型不存在仍由 stderr 判定
ok 7 - SCN-007 認得 opencode 1.18 stderr 裡的限流
ok 8 - SCN-005 正常回合標示為可用,即使回覆文字提到 426 與 error
ok 9 - 限流樣式與 src/core/rate-limit.ts 的那一份完全相同
ok 10 - issue 0023 額度用完的樣式與 src/core/rate-limit.ts 的那一份完全相同
not ok 11 - issue 0023 SCN-004 額度用完時該輪立刻結束，標示為額度用完而不是逾時
not ok 12 - issue 0023 SCN-004 額度用完排在限流之前判定，表格顯示「⛔ 額度用完」
ok 13 - issue 0023 SCN-007 一般 429 仍是限流，不提早中止
# tests 13
# pass 11
# fail 2
```

- 11：`應在幾秒內結束，實際 20029ms`。這一輪等到假 opencode 自己結束，判定是 `rate-limited`。
- 12：判定是 `rate-limited`，表格顯示 `⛔ 429 限流`。
- 13：一般 429 等到 `--timeout 10` 後仍判成限流，是既有行為的對照，所以先綠。

## 綠燈

同一命令，exit 0：`# tests 13`、`# pass 13`。

## 突變

| 突變 | 結果 |
|------|------|
| P1：不中止 | 11 轉紅 |
| P2：`classify()` 不判額度用完 | 11、12 轉紅 |
| P3：額度用完排在限流之後 | 11、12 轉紅 |
| P4：中止樣式改成一般限流 | 13 轉紅 |
| P5：標籤寫錯 | 12 轉紅 |
| P6：腳本副本的樣式和 TypeScript 那份不同 | 10 轉紅 |

每個突變後都還原檔案並以 `cmp` 確認，還原後全綠。

## 其他檢查

- `npm run build`、`npm run lint`：exit 0。
- `node --check scripts/probe-models.mjs`：通過。
- `npx prettier --check`：兩個檔都通過。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test`：exit 0，`# tests 618`、`# pass 618`、`# fail 0`。

## 精煉

中止沿用逾時那條 `child.kill('SIGKILL')`，結果照常由 `close` 回傳，沒有另外一條結束路徑。記為 no-op。
