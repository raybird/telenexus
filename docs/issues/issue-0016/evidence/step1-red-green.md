# 步驟 1：共用判定、worker、健康報告與 CLI 訊息（AC-1～AC-4）

- **日期**：2026-10-20
- **對應**：AC-1、AC-2、AC-3、AC-4
- **環境**：分支 `fix/issue-0016-backfill-source-state`，基準 `e7064e9`，工作區未提交；Node.js v22.20.0、tsx v4.21.0。測試一律以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行，測試內的 helper 也會清掉這兩個變數，再指向暫存目錄。
- **測試**：`tests/memory-health.test.ts` 新增 2 個（AC-1 六種狀態、AC-3）；`tests/memory-backfill-worker.test.ts` 新增 13 個（AC-1 等價 10 個、AC-2 3 個），既有 3 個改用新的注入選項 `assessArchiveSource`；`tests/memory-backfill.test.ts` 新增 2 個（AC-4）。

## 0. 改動前的影響分析

- `gitnexus_impact`（upstream）：`defaultHasPendingArchiveSessions` LOW、0 個呼叫者；`runMemoryBackfill` LOW，直接呼叫者只有 `memory-backfill-cli.ts`；`MemoryBackfillWorker` LOW，回報 0 個呼叫者。
- `grep -rn` 核對：`MemoryBackfillWorker` 另有 `src/main.ts:291`，impact 漏報（與 project.md「GitNexus impact 會低報呼叫者」一致），以 grep 為準。那裡只傳 `onAfterRun`，不受注入選項改名影響；`hasPendingArchiveSessions` 只出現在 worker 本身與其測試。`collectMemoryHealthReport`／`formatMemoryHealthMarkdown` 的呼叫端與 issue 0017 相同（`src/web/server.ts:2017`、`src/services/context-snapshots.ts:159`、`src/tools/memory-health-cli.ts`），JSON 只新增欄位。

## 1. 紅燈

命令：`npx tsx --test tests/memory-health.test.ts tests/memory-backfill-worker.test.ts tests/memory-backfill.test.ts`，exit 1，`# tests 24`、`# pass 17`、`# fail 7`。

| 測試 | 失敗原因 |
|---|---|
| `tests/memory-health.test.ts`（整個檔案） | `SyntaxError: ... does not provide an export named 'assessBackfillSource'`，AC-1、AC-3 的測試都跑不起來 |
| 既有「skips run when no new archive sessions exist」 | 舊程式不認 `assessArchiveSource`，改用預設判定，回填被執行（`1 !== 0`） |
| AC-2 各狀態的原因 | `remote-unsupported` 時回填被執行；舊程式也沒有印原因 |
| AC-2 讀取失敗 | 回填被執行（`1 !== 0`），沒有記 runtime issue |
| AC-2 遠端模式預設判定 | 啟動訊息是 `Starting. mode=dry-run intervalMs=60000 startupDelayMs=60000`，沒有 `source=` |
| AC-4 遠端模式 | 訊息是 `sessions.db not found: <tmp>/data/memoria-archive/.memory/sessions.db`，沒有說明是遠端 |
| AC-4 設定的路徑不存在 | 訊息是 `sessions.db not found: <tmp>/missing/sessions.db`，沒有寫明設定來源 |

> 既有測試在舊程式上不認新選項，於是用預設判定唯讀開啟了 `MEMORIA_HOME` 指向的主機封存。回填是注入的假函式，沒有寫入任何東西；之後的執行都加上 `env -u`，新程式上的測試也都走注入或暫存環境。

### AC-1 等價：舊程式上的基準

10 個等價測試只注入 `runBackfill`，用預設判定決定要不要執行，所以能在舊程式上原樣執行。它們在上面的紅燈中全部通過。之後 fixture 補上 `events` 表（見下方「已知差異」），再以 `git stash push -- src/services/memory-health.ts` 暫存新判定，在舊程式上重跑：

```text
env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test --test-name-pattern="等價" tests/memory-backfill-worker.test.ts
# tests 10
# pass 10
# fail 0
```

`git stash pop` 後以 `cmp` 確認新判定還原無誤。所以這 10 個案例的預期值（遠端、路徑不存在、空封存、有或沒有 checkpoint、時間相同、checkpoint 前後有空白、checkpoint 較新、有較新的 session）就是舊版 `defaultHasPendingArchiveSessions()` 的行為。

## 2. 最小實作後全綠

- `src/services/memory-health.ts`：新增 `judgeBackfillSource()`，以 issue 0017 的 `readArchive()` 結果與 checkpoint 判定六種狀態；匯出 `assessBackfillSource()` 給 worker 與 CLI 使用。健康報告的 backfill 區塊新增 `sourceState`、`sourceDetail`，markdown 加兩行。
- `src/services/memory-backfill-worker.ts`：移除 `defaultHasPendingArchiveSessions()` 與重複的 `readCheckpoint()`；注入選項改為 `assessArchiveSource`。`error` 狀態 throw，交給原本的 catch 記 runtime issue 並呼叫 `onAfterRun`；`up-to-date` 印原本的 `no new archive sessions`；其他沒執行的狀態印 `skipped. <state>: <原因>`。啟動訊息加上 `source=`。
- `src/services/memory-backfill.ts`：封存檔不存在時，錯誤訊息改成 `memory backfill: <判定的原因>`。仍在 `try` 之前 throw，所以和原本一樣不記 runtime issue、不寫 checkpoint。

命令同上，exit 0，`# tests 36`、`# pass 36`、`# fail 0`。`npx tsc --noEmit -p .` 無輸出。

### 突變檢查

把 `judgeBackfillSource()` 的 `archive.lastSessionAt > checkpointTimestamp` 暫時改成 `>=`：worker 測試 `# pass 14`、`# fail 2`，失敗的是「最新 session 與 checkpoint 相同」與「checkpoint 前後有空白但時間相同」兩個等價案例。還原後 `git diff --stat` 與突變前相同。

### 已知差異

`readArchive()` 會一併查 `events` 表，舊判定只查 `sessions`。封存有 `sessions` 但缺 `events` 表時，舊版判定 `pending` 並啟動回填，回填在讀 `events` 時失敗；新版直接判定 `error`。兩者最後都記 `memory-backfill:worker` runtime issue，差別只是少啟動一次回填子行程。Memoria 的 schema 一定有 `events` 表，所以等價測試的 fixture 改成同時建兩張表。

## 3. 精煉

code-simplify：worker 少了一份重複的封存讀取與 checkpoint 解析，判定只剩一處。沒有其他實質改善，不再修改。`npx prettier --check` 對 6 個修改的檔案皆通過。
