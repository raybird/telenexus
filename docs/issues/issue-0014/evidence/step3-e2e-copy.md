# 步驟 3：在資料庫複本上跑一輪清理（AC-1 外迴圈）

- **日期**：2026-10-18
- **對應**：AC-1
- **環境**：`ghcr.io/raybird/telenexus:v2.30.0`（opencode 1.18.34）的拋棄式容器，只掛複本與腳本，不帶 auth、不發佈 port。
- **程式**：
  - 變更前：映像內建的 `/app/dist`。`git diff v2.30.0 main -- src` 為空，所以它就是 `main` 的程式。
  - 本版：分支 `fix/issue-0014-wal-truncate` 在 `b1c79e8` 以 `npm run build` 編出的 `dist/`，以唯讀方式掛載覆蓋 `/app/dist`。
- **複本**：兩次各自從同一份備份（正式部署 2026-10-18 升級前停機時打包的 opencode 資料 volume，排除 `auth.json`）重新解壓，放在 repo 之外。解壓後都先以 [step1-scripts/wal.cjs](step1-scripts/wal.cjs) `free 0.2` 刪除最舊的 300 個頂層 session，可回收頁數都是 11,641／55,882（20.8%），兩次的起點相同。複本在驗證後刪除。
- **腳本**：[step3-scripts/e2e.mjs](step3-scripts/e2e.mjs) 以 [step3-scripts/run.sh](step3-scripts/run.sh) 執行。腳本匯入 `/app/dist` 的 `runRetentionOnce` 與 `createOpencodeRetentionDeps`，用真實的 opencode CLI 跑一輪（`isIdle` 固定為 true），並包住 `vacuum` dep，在 VACUUM 完成的當下量一次檔案大小。

## 結果

| | 變更前（紅燈） | 本版（綠燈） |
|---|---|---|
| 該輪 | 刪除 100、失敗 0、`reclaim=reclaimed` | 刪除 100、失敗 0、`reclaim=reclaimed`、`walTruncate=truncated` |
| 回收前：主檔／WAL | 228,892,672／0 | 228,892,672／0 |
| VACUUM 後：主檔／WAL | 167,055,360／168,034,232 | 167,055,360／168,034,232 |
| 該輪結束：主檔／WAL | 167,055,360／**168,034,232** | 167,055,360／**0** |
| 該輪結束的合計 | 335,089,592（比回收前多 106 MB） | 167,055,360（比回收前少 62 MB） |

runner 的 log 行（本版）：`[opencode-retention] INFO run candidates=100 deleted=100 failed=0 reclaim=reclaimed walTruncate=truncated durationMs=75224`。

- 紅燈的原因就是要修的問題：VACUUM 後 WAL 和主檔一樣大，該輪結束時仍然沒縮。
- 綠燈：同樣的起點、同樣的 VACUUM 結果，本版在同一輪截斷 WAL，結束時合計小於回收前，log 記了截斷完成。
- 反向自檢：截斷沒有作用時，「該輪結束」的 WAL 會和紅燈一欄一樣約 168 MB，合計也會大於回收前。判準在兩種情況下的數值不同。
