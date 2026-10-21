# 步驟 3：寫入、備份、紀錄與回滾

- **日期**：2026-10-21
- **對應**：SCN-002、SCN-003、SCN-004 的寫入部分、SCN-005 的分區部分、SCN-006、SCN-009
- **環境**：所有命令都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行；測試只用暫存目錄裡的合成資料庫，結構同步驟 2。

## 紅燈

在步驟 2 的提交 `265369c` 上加入 7 個測試。那時寫入在服務檢查之後就 throw「寫入尚未實作」。

```
npx tsx --test tests/memoria-legacy-scope.test.ts
# tests 21
# pass 14
# fail 7
```

失敗的都是新加的 7 個：5 個收到「寫入尚未實作」；SCN-009 收到的錯誤訊息裡沒有「回滾」；CLI 寫入測試的結束碼是 1。步驟 2 的 14 個維持通過。

## 綠燈

```
npx tsx --test tests/memoria-legacy-scope.test.ts
# tests 21
# pass 21
# fail 0
```

| 測試 | Scenario |
|---|---|
| 寫入後 scope 依分類改寫、summary 重建；`recall_fts` 的 body 跟著 trigger 變成新 summary；這些 session 的 `memory_node_sources` 與 level-2 node 都移除，失去來源的 topic 與 root 一併移除；`events` 全表內容不變；session ID 不變 | SCN-002 |
| 備份檔放在資料庫所在目錄的 `legacy-scope-migration/<時間戳>/`，內容與寫入前相同；遷移紀錄逐筆列出 session ID、原 scope、新 scope、分類依據，並附總數、各分區與人工審閱清單 | SCN-003 |
| 歸屬不明的 session 寫入後整列不變，索引來源還在；仍有來源的 topic 與 root 保留 | SCN-004 |
| 兩位使用者的對話各自分到 `user:u1`、`user:u2`，排程分到 `scheduler:u1` | SCN-005 的分區部分 |
| 連跑兩次 `--write`：第二次遷移 0 筆、沒有備份與紀錄，資料庫檔案的 SHA-256 與目錄清單都和第一次之後相同 | SCN-006 |
| 用 trigger 讓第三筆 UPDATE 失敗：工具以 `LegacyScopeMigrationError` 結束，訊息有「回滾」與原始錯誤，各資料表內容與執行前相同 | SCN-009 |
| CLI `--write` 結束碼 0，輸出已遷移筆數、備份與遷移紀錄的位置 | SCN-003 |

## 突變檢查

每次只改一處，跑完就還原（`diff` 確認與原檔相同）。

| 突變 | 轉紅的測試 |
|---|---|
| 不備份（改成寫一個空檔） | SCN-003 |
| 不刪 `memory_node_sources` | 7 個寫入測試全紅：better-sqlite3 預設開啟外鍵，刪 level-2 node 時被擋下，整批回滾 |
| 不包 transaction | SCN-009 |
| 計畫為空時照樣備份 | SCN-006 |
| 不刪失去來源的 topic | SCN-002 |

commit 前的自我檢查（`events` 雜湊不變、舊分區只剩人工審閱的筆數）在正常資料下不會觸發。這裡原本寫「造不出違反情況」，審查指出不正確：用 trigger 就能觸發。測試已在步驟 6 補上，見 [step6-review-followup.md](step6-review-followup.md)。

## 交付檢查

- `npm run build` exit 0；`dist/tools/memoria-legacy-scope-cli.js` 已產出。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0：`# tests 539`、`# pass 539`、`# fail 0`。比 issue 0016 結束時的 518 多 21 個，就是本 issue 新增的測試數；`tests/` 下 71 個測試檔，`tests/docker/` 的 4 個檔案都出現在輸出中（地雷 L-01）。
- `npm run lint` exit 0。
