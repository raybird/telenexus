# 步驟 1：逐筆保存（AC-1）

- **日期**：2026-10-21
- **環境**：所有命令都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行；資料庫用暫存目錄的 `DB_PATH`，Memoria 用測試內的假 HTTP 服務。

## 改動前的影響分析

| symbol | GitNexus | grep 核對 |
|---|---|---|
| `MemoriaRecallClient.recallWithMeta` | LOW，0 個呼叫者 | 漏報：實際呼叫點是 `src/main.ts` 的 `buildPromptFn`，這也是 Memoria 召回唯一的呼叫點 |
| `recordMemoriaRecallTrace` | LOW；呼叫者 `recallWithMeta` | 相同；`tests/` 沒有直接呼叫 |
| `formatMemoriaStatusMarkdown` | LOW；呼叫者 `writeContextSnapshots` | 相同 |

`MemoriaRecallTrace` 新增三個必填欄位（`scopeKind`、`droppedLowConfidence`、`injected`）。建構這個型別的地方只有 `memoria-recall.ts` 的兩處，`tsc --noEmit` 通過。

## 紅燈

新增 `tests/recall-metrics.test.ts` 的 9 個測試。第一次執行時 `src/services/recall-metrics-store.ts` 還不存在，整個檔案載入失敗，證明不了什麼。所以先放一個什麼都不做的 `startRecallMetricsStore()` 空殼，再執行一次：

```
# tests 9
# pass 0
# fail 9
```

- 5 個召回情況的測試，以及「不存問句」：`no such table: memoria_recall_events`。
- 「重新開啟資料庫」：`summarizeMemoriaRecallByVersion is not a function`。
- 「清掉超過 30 天」：`appendMemoriaRecallEvent is not a function`。
- 「寫入失敗」：沒有印出 warn。

## 綠燈

```
npx tsx --test tests/recall-metrics.test.ts tests/memoria-recall-outcome.test.ts tests/memoria-recall-threshold.test.ts tests/memory-manager.test.ts
# tests 40
# pass 40
# fail 0
```

做法：
- `MemoryManager` 新增 `memoria_recall_events` 表，以及 `appendMemoriaRecallEvent()`、`purgeOldMemoriaRecallEvents()`、`summarizeMemoriaRecallByVersion()`。
- `memoria-recall-telemetry.ts` 新增 `addMemoriaRecallTraceHook()`。`recordMemoriaRecallTrace()` 記下軌跡後通知 hook；hook throw 時吞掉，因為這在聊天的路徑上。
- `recallWithMeta()` 在軌跡裡加上：
  - `scopeKind`：`user:<id>` 只留 `user`；
  - `droppedLowConfidence`；
  - `injected`：沒被丟棄，而且交給 prompt 組裝的 snippet 至少一筆。
- 新的 `recall-metrics-store.ts` 仿照 `issue-store.ts`：
  - 訂閱 hook 寫進資料庫，寫入失敗只印 `[recall-metrics]` 開頭的 warn；
  - 啟動時清理一次，之後每 6 小時清理；保留 30 天。

## 突變檢查

每次只改一處，跑完就還原（`diff` 確認與原檔相同）。

| 突變 | 轉紅的測試 |
|---|---|
| M1：`injected` 不看信心門檻 | 信心低於門檻而丟棄 |
| M2：失敗的召回不寫 | HTTP 失敗 |
| M3：啟動時不清理 | 啟動時清掉超過 30 天的資料 |
| M4：寫入失敗時記 runtime issue | 寫入失敗不影響召回 |

M4 第一次突變沒有轉紅：加進去的 `recordRuntimeIssue()` 沒有 import，執行到時 throw `ReferenceError`，又被 hook 層吞掉，所以根本沒有記到。補上 import 後重跑，這個測試轉紅（runtime issue 次數預期 2、實際 3）。以補上 import 的這次為準。
