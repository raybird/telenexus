# 步驟 2：snapshot 隔離與失敗訊號（AC-3、AC-4）

- **日期**：2026-10-21
- **環境**：同步驟 1。

## 改動前的影響分析

GitNexus 對 `writeContextSnapshots` 回報 0 個呼叫者，這是已知的低報。以 `grep` 核對：
- 實際呼叫點是 `src/main.ts:183`（`writeContextSnapshotsFn`）。
- 這個函式再以 options 傳進 `src/core/message-pipeline.ts` 與 `src/core/message-pipeline-preflight.ts`，每則訊息處理前後各呼叫一次。

函式簽名不變，回傳仍是 `void`，所以呼叫端不必改。

改動前另外查了兩件事：
- event-projector 收到 `runtime_issue` 後，以 `setTimeout` 排下一輪寫入，不會同步重入。**（更正，2026-10-21 審查後：這個說法不對。距上次執行超過節流間隔時，projector 會同步重入一次，見 [step4-review-followup.md](step4-review-followup.md)。）**
- `recordRuntimeIssue()` 會把 60 秒內 scope 與訊息都相同的紀錄合併：只把 `count` 加 1，不觸發 hook，也就不會到 ErrorAlerter。

## 紅燈

在 `tests/context-snapshots.test.ts` 新增 3 個測試，並在步驟 1 完成後的程式上執行：

```
# tests 4
# pass 2
# fail 2
```

- 「其中一個 snapshot throw」：`runtime-status.md 應該要寫入`。`memoria-status` throw 之後，整輪 10 個檔案都沒有寫入。
- 「開始失敗時記一次」：runtime issue 的次數不符，因為舊程式不記 runtime issue。
- 「檢索資料庫不是 SQLite 時 memory-status 照常更新」：在步驟 1 之後已經通過，它依賴步驟 1 的行為。另把 `src/services/memory-health.ts` 換回 `e806c02` 的版本跑一次，三個新測試都失敗，這一個的錯誤是 `ENOENT … memory-status.md`，就是 #18 描述的症狀。跑完換回新版，沒有用 git stash。

## 綠燈

```
# tests 4
# pass 4
# fail 0
```

做法：
- 10 個 snapshot 改成 `[檔名, 產生內容的函式]` 的清單，逐一在各自的 try 裡產生內容並寫入。
- 失敗時照舊 `console.warn`。
- 由成功（或程序啟動後第一次）轉為失敗時，才 `recordRuntimeIssue('context-snapshot:<檔名>', err)`。
- 恢復時印 `[System] Context snapshot <檔名> 已恢復更新`。
- `ai-config.yaml` 只在用到時讀一次，由 `runtime-status` 與 `provider-status` 共用。讀不了時，只有這兩個檔案失敗。
- 目錄的解析與建立也放進每個檔案的 try。`resolveContextDir()` 會呼叫 `process.cwd()`，工作目錄被刪掉時會 throw；舊程式的外層 try 會接住它，新程式也不能讓它傳到 message pipeline。**（更正：這一版還沒處理完。catch 裡的 `recordRuntimeIssue()` 同樣會解析工作目錄而 throw，當時也沒有測試，見 [step4-review-followup.md](step4-review-followup.md)。）**

## 突變檢查

| 突變 | 轉紅的測試 |
|---|---|
| 每次失敗都記 runtime issue | 開始失敗時記一次 |
| 第一個失敗就停下（等同舊行為） | 其中一個 snapshot throw；開始失敗時記一次 |
| 恢復後不清失敗狀態 | 開始失敗時記一次 |

每次只改一處，跑完就還原（`diff` 確認與原檔相同）。
