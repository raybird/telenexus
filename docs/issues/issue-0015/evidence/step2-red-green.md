# 步驟 2：分類、預覽與防護

- **日期**：2026-10-21
- **對應**：SCN-001、SCN-002 的分類部分、SCN-004、SCN-007、SCN-008
- **環境**：所有命令都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行；測試只用暫存目錄裡的合成資料庫。
- **資料庫結構**：`tests/fixtures/memoria/sessions-schema-1.28.1.sql` 從資料副本的 `sqlite_master` 匯出，只有結構，含 `recall_fts` 與它的 trigger。

## 等價證據：`buildSummary` 改成 export

GitNexus `impact`（upstream）回報 HIGH：直接呼叫者 1 個（`MemoriaSyncBridge.enqueueSyncTurn`），影響 1 條流程。`grep` 也只找到 `src/core/memoria-sync.ts:353` 一個呼叫點。這次只在函式前加上 `export`，內容不變。

| | `tests/memoria-sync-payload.test.ts`、`tests/memoria-sync-status.test.ts` |
|---|---|
| 修改前 | `# tests 16`、`# pass 16`、`# fail 0` |
| 修改後 | `# tests 16`、`# pass 16`、`# fail 0` |

## 紅燈

`src/services/memoria-legacy-scope.ts` 先只放會 throw `not implemented` 的空殼，CLI 還不存在。

```
npx tsx --test tests/memoria-legacy-scope.test.ts
# tests 14
# pass 0
# fail 14
```

失敗原因：5 個是 `not implemented`；7 個是 `assert.rejects` 收到的錯誤型別不對（空殼丟的是一般 `Error`，不是 `LegacyScopeMigrationError`）；2 個 CLI 測試是 `ERR_MODULE_NOT_FOUND`。沒有因為建測試資料而失敗的。

## 綠燈

```
npx tsx --test tests/memoria-legacy-scope.test.ts
# tests 14
# pass 14
# fail 0
```

`npx tsc --noEmit -p .` 沒有錯誤；`eslint` 檢查新檔沒有錯誤或警告；`prettier --check` 通過。

| 測試 | Scenario |
|---|---|
| 不加 write 只預覽，資料庫不變也不產生備份（檔案 SHA-256 與目錄清單前後相同） | SCN-001 |
| 預覽時 Memoria 仍在執行也照樣完成 | SCN-001 |
| 只處理指定的舊分區，其他分區不列入 | SCN-001 |
| 依事件記錄的 platform 決定分區（telegram、console、passthrough → `user:`；scheduler → `scheduler:`；不同 user_id 各自分區），summary 等於 `buildSummary()` 的結果 | SCN-002 的分類部分 |
| 8 種歸屬或內容不明的情況都列入人工審閱並附原因 | SCN-004 |
| 連得上 Memoria 時拒絕寫入，資料庫與目錄不變 | SCN-007 |
| 資料庫不存在、缺 `sessions.scope`、資料頁損壞：預覽與寫入都中止，資料庫與目錄不變 | SCN-008 |
| CLI 預覽 `--json` 結束碼 0；資料庫不存在時結束碼非 0，stderr 說明原因 | SCN-001、SCN-008 |

SCN-004 的 8 種情況包含驗收劇本列的五類（缺 `user_id`；platform 缺少或不是 telegram／console／scheduler；沒有 `UserMessage`；有兩筆 `UserMessage`；`ModelMessage` 的 platform 或 user_id 不一致），另外加上實作計畫列的「事件內容無法取出文字」。這一項比驗收劇本更保守，只會讓更多 session 留在原處，不會多搬。

## 突變檢查

每次只改一處，跑完就還原（`diff` 確認與原檔相同）。

| 突變 | 轉紅的測試 |
|---|---|
| 不檢查 `ModelMessage` 與 `UserMessage` 是否一致 | SCN-004 |
| 排程也分到 `user:` | SCN-001、SCN-002、CLI 預覽 |
| 寫入時不做服務檢查 | SCN-007 |
| 不檢查必要欄位 | SCN-008 缺欄位（預覽、寫入） |
| 只要有 `UserMessage` 就接受，不要求剛好一筆 | SCN-004 |

## 限制

- 寫入在這一步只做到服務檢查，之後會 throw「寫入尚未實作」，由步驟 3 完成。
- 損壞資料庫的測試把第 2～5 頁寫成垃圾。實際的損壞形式很多，這裡只確認「SQLite 判定不完整時，工具中止且不改檔」。
