# 步驟 3：移除回填與啟動警告（SCN-005、SCN-006）

- 日期：2026-10-27

## 刪除與修改

- 刪除：
  - `src/services/memory-backfill.ts`
  - `src/services/memory-backfill-worker.ts`
  - `src/tools/memory-backfill-cli.ts`
  - `tests/memory-backfill.test.ts`
  - `tests/memory-backfill-worker.test.ts`
- `src/main.ts`：
  - 拿掉 worker 的建立、`start()`，以及 SIGINT／SIGTERM 裡的兩處 `shutdown()`；
  - 在原本 `start()` 的位置呼叫 `warnIfMemoryBackfillConfigured()`。
- `src/services/retired-memory-backfill.ts`（新增）：啟動警告。判定沿用 `parseBool`，和移除前的 worker 相同。
- `src/web/server.ts`：拿掉 `/api/memory-backfill/report` 與 `getRecentMemoryBackfillReports` 的 import，請求會落到既有的 404。
- `src/utils/paths.ts`：拿掉 `resolveMemoryBackfillReportPath`，它只給回填用。
- `package.json`：拿掉 `memory:backfill:dry-run`、`memory:backfill:write`。
- `memory:backfill-summary-metadata` 處理的是 `moltbot.db` 的摘要 metadata，保留。

刪除前的引用清單是用 `grep -rn -E "memory-backfill|MemoryBackfill|MEMORY_BACKFILL_|runMemoryBackfill|getRecentMemoryBackfillReports|resolveMemoryBackfill|resolveMemoryDbPath|BackfillCheckpoint|assessBackfillSource|currentArchiveSource"` 掃 `src tests scripts package.json Dockerfile docker-compose*.yml` 取得的。除了要刪的檔案之外，命中的有：
- `src/main.ts`、`src/web/server.ts`、`package.json`、`src/utils/paths.ts`：本步驟處理；
- `src/services/memory-health.ts`、`tests/memory-health.test.ts`、`src/web/public/app/services/status-service.js`：步驟 4 處理。

`Dockerfile` 與 compose 檔沒有命中。

## 刪除的測試

這兩個檔共 28 個測試，刪除前全部通過（`# tests 28`、`# pass 28`）。它們只驗證被移除的回填行為：
- 候選擷取、dry-run 遙測、CLI 錯誤訊息；
- worker 的排程、逾時、各狀態訊息、遠端警告。

依 verification.md，這屬於「核准的行為已變更」（SCN-005）。

- `tests/memory-backfill.test.ts`（8 個）：`extractCandidatesFromSession` 4 個、`runMemoryBackfillDryRun` 遙測 1 個、issue 0016 AC-4 兩個、issue 0016 第二部分 AC-1 一個。
- `tests/memory-backfill-worker.test.ts`（20 個）：
  - `MemoryBackfillWorker` 的 skip、run、逾時共 3 個；
  - issue 0016 AC-1 等價的狀態表；
  - issue 0016 AC-2 三個；
  - checkpoint 型別防護 1 個；
  - issue 0016 第二部分 AC-2 兩個。

## 紅燈

`src/services/retired-memory-backfill.ts` 先放一個一律回 `false` 的空殼，讓紅燈來自行為不符，而不是模組不存在。

`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/retired-memory-backfill.test.ts`，exit 1：

```text
not ok 1 - issue 0022 SCN-006 MEMORY_BACKFILL_ENABLED=true → 警告一行
  expected: true
  actual: false
not ok 2 - issue 0022 SCN-006 MEMORY_BACKFILL_ENABLED=1（v2.32.0 的 parseBool 也當成開啟） → 警告一行
  expected: true
  actual: false
ok 3 - issue 0022 SCN-006 MEMORY_BACKFILL_ENABLED=false → 不印
ok 4 - issue 0022 SCN-006 MEMORY_BACKFILL_ENABLED=未設定 → 不印
not ok 5 - issue 0022 SCN-005 GET /api/memory-backfill/report 回 404，其他 API 照常
  expected: 404
  actual: 200
# tests 5
# pass 2
# fail 3
```

- 1、2：開著回填卻沒有警告。
- 5：API 還在，回 200。
- 3、4 在空殼下也是綠的，因為空殼本來就不印任何東西。它們要擋的是「沒開也印」的回歸。

SCN-005 的 404 測試另外打 `/api/health` 當對照組，確認 404 不是因為 server 沒起來。

## 綠燈

- 同一命令，exit 0：`# tests 5`、`# pass 5`、`# fail 0`。
- `npm run build`：exit 0。
- 全套 `npm run test`：exit 0，`# tests 577`、`# pass 577`、`# fail 0`，`tests/` 下 72 個測試檔。
  - 和 v2.32.0 的 598 個相比：刪掉 28 個，步驟 2 新增 2 個，本步驟新增 5 個。598 − 28 + 2 + 5 = 577。
- `npm run lint`：exit 0。
- `npx prettier --check`：改到的檔案都通過。

## 突變

| 突變 | 結果 |
|------|------|
| 判定改成 `env.MEMORY_BACKFILL_ENABLED !== 'true'`（只認字串 true） | `not ok 2 - … MEMORY_BACKFILL_ENABLED=1 …`，`# fail 1` |
| 空殼（不警告）／保留 API | 即上面的紅燈 |

突變後已還原。

## 靜態檢查

刪除後，用同一個 `grep -E "memory-backfill|MemoryBackfill|MEMORY_BACKFILL_"` 掃 `src tests scripts package.json`。扣掉步驟 4 的三個檔，剩下的命中都是啟動警告本身：
- `src/main.ts` 的 import 與呼叫；
- `src/services/retired-memory-backfill.ts`；
- `tests/retired-memory-backfill.test.ts`。

另外還有 `src/web/public/app/services/status-service.js:13`，由步驟 4 處理。

`src/main.ts` 已經沒有 `memoryBackfillWorker`，所以服務不會排程或執行回填（SCN-005）。

## 精煉

啟動警告是一個函式，`main.ts` 只多一行呼叫，沒有可再簡化的部分，記為 no-op，沿用上面的綠燈。
