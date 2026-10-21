# 步驟 1：本機資料庫的狀態與推導值（AC-1、AC-2）

- **日期**：2026-10-21
- **環境**：所有命令都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行；測試只用暫存目錄裡的合成資料庫。

## 改動前的影響分析

| symbol | GitNexus | grep 核對 |
|---|---|---|
| `collectMemoryHealthReport` | LOW；直接呼叫者 `writeContextSnapshots`、`startWebServer`、`memory-health-cli.ts` | 相同，另有 `tests/memory-health.test.ts` |
| `collectConsistencyReport`、`getSqliteCounts` | LOW；只被 `collectMemoryHealthReport` 呼叫 | 相同 |
| `formatMemoryHealthMarkdown` | LOW；只列出 `memory-health-cli.ts` | 漏報：`src/services/context-snapshots.ts` 也呼叫 |

`src/web/public/app/services/status-service.js` 的 `getMemoryHealth()` 沒有呼叫端（#17 已查證），所以 JSON 形狀變化沒有程式要跟著改。

## 紅燈

在 `e806c02` 的程式上，`tests/memory-health.test.ts` 新增 6 個測試：

```
# tests 19
# pass 13
# fail 6
```

| 測試 | 失敗原因 |
|---|---|
| 運作資料庫不存在 | `operational.status` 是 `undefined`，預期 `unavailable` |
| 運作資料庫不是 SQLite 檔 | throw `file is not a database` |
| 運作資料庫缺少資料表 | throw `no such table: messages` |
| 檢索資料庫不是 SQLite 檔 | throw `file is not a database` |
| 檢索資料庫不存在 | `retrieval.status` 是 `undefined` |
| 兩個資料庫都可讀 | `operational.status` 是 `undefined` |

既有的 13 個測試照常通過。

## 綠燈

```
# tests 19
# pass 19
# fail 0
```

做法：
- 新增 `readLocalDb()`：檔案不存在時回 `unavailable`；開檔或查詢 throw 時回 `error` 與錯誤訊息，不 throw。
- 運作資料庫的查詢移到 `readOperationalStats()`，檢索資料庫的計數與觀察掃描合併到 `readRetrievalRows()`，同一個連線只開一次。
- `collectConsistencyReport()` 改為接收讀取結果，不再自己開檔。
- `getSqliteCounts()` 已沒有呼叫者，移除。

`readArchive()`（#17）也有「檔案存在判斷加上 try/catch」的結構。它在不存在時會依來源寫不同的 `detail`（遠端或本機設定路徑），要併進 `readLocalDb()` 就得動 #17 已驗證的行為；效益小，所以不合併。

## 突變檢查

每次只改一處，跑完就還原（`diff` 確認與原檔相同）。

| 突變 | 轉紅的測試 |
|---|---|
| 檢索資料庫不存在時，orphan 檢查沿用封存的判定，而不是 `skipped` | 檢索資料庫不存在 |
| `readLocalDb()` 讀不了時照舊 throw | 運作資料庫不是 SQLite、缺少資料表、檢索資料庫不是 SQLite（3 個） |
| `estimatedGapRecent24h` 不看運作資料庫有沒有讀到 | 運作資料庫不是 SQLite、缺少資料表（2 個） |
