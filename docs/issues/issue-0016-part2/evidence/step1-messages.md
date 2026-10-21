# 步驟 1：原因說明與啟動警告（AC-1、AC-2）

- **日期**：2026-10-21
- **影響分析**：
  - `MemoryBackfillWorker.start`：GitNexus 判定 LOW，直接呼叫者只有 `bootstrap`（`src/main.ts:294` 建立 worker）。
  - `judgeBackfillSource`：不在 GitNexus 索引裡（第一部分新增的函式，索引過期）。以 `grep` 核對，呼叫點只有 `assessBackfillSource()` 和 `collectMemoryHealthReport()`。
  - `assessBackfillSource().detail` 會傳到三個地方：worker 每輪的訊息、健康報告的 `backfill.sourceDetail`，以及 `src/services/memory-backfill.ts` 失敗退出的訊息。

## 改動

- `src/services/memory-health.ts`：遠端模式的 `detail` 改成「遠端 Memoria 模式不支援回填：回填只讀本機的 sessions.db（MEMORIA_ARCHIVE_DB 或 MEMORIA_HOME 指向的檔案），請把 MEMORY_BACKFILL_ENABLED 設為 false」。
- `src/services/memory-backfill-worker.ts`：`start()` 在回填開啟、來源是 `remote` 時，印出原本的 `Starting. …` 之後，再用 `console.warn` 印一行不支援。排程照常建立（Q1）。

## 測試

新增 4 個測試：
- `tests/memory-health.test.ts`：遠端模式的 `detail` 符合 AC-1（正式不支援、`sessions.db`、`MEMORY_BACKFILL_ENABLED 設為 false`，不含「目前」），而且和報告的 JSON、markdown 是同一句。
- `tests/memory-backfill.test.ts`：遠端模式失敗退出的訊息符合 AC-1。
- `tests/memory-backfill-worker.test.ts`：
  - 遠端模式開啟回填時，warn 剛好一次；`Starting. … source=remote` 照印；startup 那一輪有跑，而且印 `skipped. remote-unsupported: `。
  - 本機模式開啟、回填沒開時，都沒有 warn；沒開時的輸出只有原本那一行。

```bash
export TMPDIR=$HOME/.cache/memoria-release-tmp
env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/memory-health.test.ts tests/memory-backfill.test.ts tests/memory-backfill-worker.test.ts
```

- **紅**（改程式之前）：exit 1，`# tests 48`、`# pass 45`、`# fail 3`。新增的 4 個裡，3 個因行為失敗：warn 次數 `0 !== 1`，兩個訊息不符合 `/遠端 Memoria 模式不支援回填/`。「本機或沒開時不警告」在改之前本來就成立。
- **綠**：exit 0，`# tests 48`、`# pass 48`、`# fail 0`。
- `npm run build`、`npm run lint`：都是 exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm test`：exit 0，`# tests 598`、`# pass 598`、`# fail 0`（原本 594，加上新增的 4 個）。

## 突變

做法：
- 每次用 `python3` 對單一字串取代一次，取代前先確認那段字串只出現一次；
- 跑上面那 3 個測試檔；
- 從 scratchpad 的備份複製回來；
- 最後以 `diff -q` 確認與備份相同。

| 突變 | 轉紅的測試 |
|---|---|
| M1：還原成舊的說明 | 2 個 AC-1 測試 |
| M2：拿掉警告 | 遠端 AC-2 |
| M3：本機模式也警告 | 本機／沒開 AC-2 |
| M4：警告後 `return`，不建立排程 | 遠端 AC-2 |
| M5：警告改用 `console.log` | 遠端 AC-2 |
