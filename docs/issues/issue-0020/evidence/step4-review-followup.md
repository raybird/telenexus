# 步驟 4：審查後續

- **日期**：2026-10-21
- **對應**：[review-ed4c001.md](../review-ed4c001.md) 的 SHOULD FIX 1～3、NICE TO HAVE 1～7
- **環境**：所有命令都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行。審查時 `/tmp` 的配額曾經滿過（errno -122），這一輪的 `TMPDIR` 都指到家目錄 cache 下的 ext4 暫存目錄。

## 處理結果

| 審查項目 | 處理 |
|---|---|
| SHOULD FIX 1：排序改成依版本號，測試仍然全過 | 補一個降版測試：2.29.0 升到 2.31.0、再降回 2.30.1。確認彙總依最後一筆的時間排列，目前版本是 2.29.0 時，前一版挑的是 2.30.1，不是版本號最大的 2.31.0。程式本身沒錯，所以這個測試在修正前也是綠燈，以突變 M11 證明它有效。 |
| SHOULD FIX 2（需決策）：第一個提交單獨檢出時測試載入失敗 | 使用者選「重整分支歷史」（README D-1）。從 main 重建，見下方「歷史重整」。 |
| SHOULD FIX 3：`ARCHITECTURE.md`、`CLAUDE.md` 沒登記新模組 | 兩處都在 `issue-store` 旁邊補上 `recall-metrics-store.ts` 與 `memoria_recall_events`。 |
| NICE 1：scope 沒有冒號時會寫入整串 | 改成記 `other`；沒帶 scope 時仍是 `none`。補測試；舊程式上這個測試失敗（寫入了 `secret-user-42`），突變 M12 也會轉紅。 |
| NICE 2：trace hook 的 catch 不留痕跡 | catch 裡印 `[memoria-recall] trace hook failed:` 的 warn，仍不影響聊天。 |
| NICE 4：「30 天」寫在兩處 | `recall-metrics-store.ts` 匯出 `RECALL_METRICS_RETENTION_DAYS`，`memoria-status.md` 的說明行改用它。 |
| NICE 5：README「涉及檔案」寫「每日清理」 | 改成「啟動時與每 6 小時清理」，和 AC-1 一致。 |
| NICE 6：`Recalls` 計的是召回次數 | `docs/web-console-reference.md` 補上一句：改開新 session 時，同一則訊息會召回兩次。 |
| NICE 7：`readAppVersion()` 沒有直接測試 | 補一個測試，比對 `package.json` 的 version。 |
| NICE 3：每 6 小時的清理沒有測試 | 不處理。間隔只是 `setInterval` 的常數，和 `issue-store.ts` 相同；要測就得注入計時器，效益小。啟動時那一次的清理有測試。 |

## 歷史重整

先保留原本的 HEAD：`backup/issue-0020-ed4c001` 指向 `95ac16a`，就是 `ed4c001` 加上審查報告。然後從 main（`6b6eb1d`）重建：

| 提交 | 內容 | 單獨檢出時的全套測試 |
|---|---|---|
| `7fe83b3` | 步驟 1 的程式；`readAppVersion()` 搬到 utils（`main.ts` 已用到它）；測試檔只含步驟 1 的 9 個測試 | `# tests 567`、`# pass 567` |
| `7819017` | 步驟 2 的程式與完整測試檔 | `# tests 574`、`# pass 574` |
| `7d3b69c` | 證據與文件 | 只改文件 |
| `caccb14` | 原本的審查報告 review-ed4c001.md | 只改文件 |

`git diff ed4c001 7d3b69c` 與 `git diff 95ac16a caccb14` 都沒有差異，所以重建後的內容和審查時完全相同，只是切分不同。審查報告裡的 SHA 指向備份分支上的提交。

## 綠燈與突變

```
npx tsx --test tests/recall-metrics.test.ts
# tests 19
# pass 19
# fail 0
```

| 突變 | 轉紅的測試 |
|---|---|
| M11：彙總改成 `ORDER BY version DESC` | 降版時依最後一筆的時間挑前一版；scope 不是 prefix:id 格式（這個測試同時檢查寫入順序） |
| M12：沒有冒號時寫入整串 | scope 不是 prefix:id 格式 |

每次只改一處，跑完就還原（`diff` 確認與原檔相同）。

第一次寫 scope 測試時，測試本身寫錯了：`recallOnce()` 的 scope 參數有預設值 `user:u1`，傳 `undefined` 會用到預設值。改成直接呼叫 client。

## 交付檢查（提交前的工作區）

- `npm run build` exit 0。
- `npm run test` exit 0：`# tests 577`、`# pass 577`、`# fail 0`。比步驟 3 多 3 個，就是本步驟新增的測試數。`tests/docker/` 的 4 個檔案都有跑到。
- `npm run lint` exit 0；異動的 TypeScript 檔都通過 `prettier --check`。
