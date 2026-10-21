# 步驟 2：彙總與呈現（AC-2～AC-4）

- **日期**：2026-10-21
- **環境**：同步驟 1。

## 紅燈

在 `tests/recall-metrics.test.ts` 新增 6 個測試。先在 `memoria-status.ts` 放一個回傳空字串的 `formatRecallMetricsByVersionMarkdown()` 空殼：

```
# tests 15
# pass 10
# fail 5
```

- 失敗的 5 個：前一版的挑選、成功 19 次、成功 20 次、沒有資料、讀取失敗。
- 「依版本彙總」在紅燈時已經通過：彙總查詢 `summarizeMemoriaRecallByVersion()` 在步驟 1 就寫了，「重新開啟資料庫」用到它。這個測試改用突變 M7、M8 證明有效。

## 綠燈

```
npx tsx --test tests/recall-metrics.test.ts
# tests 16
# pass 16
# fail 0
```

做法：
- `formatMemoriaStatusMarkdown()` 新增選用的 `recallMetrics`，內容是目前版本與讀取函式。有傳時，在 Recall Telemetry 後面加上「Recall Metrics by Version」。既有內容一行都沒改：`git diff` 刪掉的只有函式簽名與最後一個元素。
- 讀取函式 throw 時，這一節顯示 `Status: error` 與原因，不往外 throw。
- 前一版：彙總已依最後一筆的時間由新到舊排列，取第一個不是目前版本的。
- 成功次數少於 20 時，三個比例顯示 `unknown（樣本不足，n=…）`。
- `writeContextSnapshots()` 傳入 `readAppVersion()` 與 `memory.summarizeMemoriaRecallByVersion()`。
- `readAppVersion()` 從 `src/web/server.ts` 搬到 `src/utils/app-version.ts`，讓 Web Console、snapshot 與 `main.ts` 共用；只讀一次就快取。
- `main.ts` 在 `startIssueStore()` 之後啟動 store。

第 16 個測試是串接測試：真的 `MemoryManager` 裡放 20 筆，跑 `writeContextSnapshots()`，確認 `memoria-status.md` 有這一節與正確的比例。

## 突變檢查

| 突變 | 轉紅的測試 |
|---|---|
| M5：門檻改成 `<=` | 成功 20 次時顯示比例 |
| M6：前一版挑最舊的 | 列出目前版本與最近的前一個版本 |
| M7：成功次數用 `COUNT(*)`，含失敗 | 依版本彙總 |
| M8：降級不計 | 依版本彙總 |
| M9：讀取失敗時 throw | 讀取資料庫失敗時該節標示失敗 |
| M10：比例的分母改成含失敗 | 成功 20 次時顯示比例 |
| context-snapshots 不傳 `recallMetrics` | 串接測試 |

每次只改一處，跑完就還原（`diff` 確認與原檔相同）。
