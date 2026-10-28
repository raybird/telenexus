# 步驟 2：事件順序與定期更新（AC-1 事件順序、AC-2）

- 日期：2026-10-28
- 改動：
  - `src/services/pinned-status.ts`：新增 `startPinnedStatus()`
  - `src/main.ts`：釘選接線改呼叫 `startPinnedStatus()`，context 快照計時器每輪呼叫 `refresh()`
  - `tests/pinned-status.test.ts`：新增 4 個測試

## 影響分析

- `bootstrap`（`src/main.ts`）：`gitnexus_impact` 回報 LOW，唯一上游是 `main.ts` 檔案本身。
- 被取代的是 `bootstrap` 裡的一段 inline 接線，沒有其他呼叫點：`grep -rn "PinnedStatusManager" src` 只有 `main.ts` 一處建立。
- `main.ts` 仍有一處使用 `getRecentIssues()`：full prompt 的「最近 15 分鐘異常」（第 264 行），不在本 issue 範圍。

## 兩個要處理的行為

1. **事件比寫入資料庫早**：`recordRuntimeIssue()`（`src/utils/errors.ts`）先 `emitEvent('runtime_issue')`，之後才呼叫 `IssueStore` 的 hook 寫進 `runtime_issues`。event-bus 的 hook 是同步呼叫的，在 hook 裡直接計數會少算剛發生的這一筆。
   - 做法：hook 裡用 `queueMicrotask()` 延後到這一輪同步程式跑完再計算，這時 `IssueStore` 已經寫入。
   - microtask 裡的例外不會被 event-bus 的 try/catch 接住，會變成 uncaught exception，讓程序崩潰。所以計算外面包一層 `guarded()`，只記 warn。`manager.update()` 的 rejection 也接住。
2. **`Last request: Nm ago` 每分鐘都在變**：如果定期更新照送整份快照，`PinnedStatusManager` 的「文字沒變就不編輯」擋不住，閒置時每分鐘都會編輯一次訊息。
   - 做法：`refresh()` 只在錯誤數改變時才送出。
   - README AC-2 原本寫「文字沒有改變時不呼叫 Telegram」，那是錯的前提，已依實際機制修正措辭。目標「閒置時不增加 API 請求」與檢查方式不變。

## 紅燈（最小實作前）

空殼照搬 `main.ts` 原本的接線：事件 hook 同步更新，`refresh()` 不做事。

`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/pinned-status.test.ts`，exit 1：

```text
ok 1 - issue 0021 AC-1 計數是 runtime_issues 最近 24 小時的列數，超過 20 照實顯示
ok 2 - issue 0021 AC-1 重新開啟資料庫後，重啟前 24 小時內的錯誤仍然算在內
ok 3 - issue 0021 AC-3 讀不到 runtime_issues 時回傳 null，不 throw
ok 4 - issue 0021 AC-3 計數未知時顯示 unknown，其他欄位照常
ok 5 - issue 0021 AC-1 有數字時照實顯示
not ok 6 - issue 0021 AC-1 新的 runtime issue 觸發的那次更新已經包含這一筆
  expected: 1
  actual: 0
not ok 7 - issue 0021 AC-2 錯誤超過 24 小時後，定期更新把數字改成新的值
not ok 8 - issue 0021 AC-2 數字沒變的定期更新不編輯訊息（Last request 的分鐘數不算）
  expected: 2
  actual: 1
ok 9 - issue 0021 讀取來源 throw 時，事件觸發的更新不讓程序崩潰
# tests 9
# pass 6
# fail 3
```

- 6：用真的 `IssueStore`、`recordRuntimeIssue()` 與暫存資料庫，同步計數拿到 0，就是事件早於寫入的問題。
- 7：錯誤過期後沒有任何更新，訊息停在 1。
- 8：數字改變後的 `refresh()` 沒有送出。
- 9：同步呼叫時 event-bus 會接住例外，所以先綠。這條擋的是改成 microtask 之後的崩潰，由下面的 M9 證明。

## 綠燈（最小實作後）

同一命令，exit 0：`# tests 9`、`# pass 9`、`# fail 0`。

## 突變

| 突變 | 結果 |
|------|------|
| M6：拿掉 `queueMicrotask`，在事件 hook 同步計算 | 6 轉紅 |
| M7：`refresh()` 不做事 | 7、8 轉紅 |
| M8：`refresh()` 不比對數字，每次都送 | 8 轉紅 |
| M9：事件 microtask 不接例外 | test runner 收到 `uncaughtException`（`Error: boom`），整個測試檔判定失敗 |

每個突變後都還原檔案，並以 `cmp` 確認與備份相同，還原後全綠。

## 限制

`main.ts` 的接線（建立 `startPinnedStatus()`、計時器呼叫 `refresh()`）在 `bootstrap()` 裡面，需要 Telegram 連線，單元測試沒有覆蓋。這段只有兩處呼叫，由 `npm run build` 的型別檢查與 diff 審閱確認；行為本身都在 `startPinnedStatus()`，由上面的測試覆蓋。

## 其他檢查

- `npm run build`：exit 0。
- `npm run lint`：exit 0。
- `npx prettier --check src/main.ts src/services/pinned-status.ts tests/pinned-status.test.ts`：通過。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test`：exit 0，`# tests 587`、`# pass 587`、`# fail 0`。`tests/` 下 73 個測試檔，比 v2.33.0 的 72 個多了 `tests/pinned-status.test.ts`；測試數 578 加上本 issue 的 9 個。

## 精煉

- 原本 `main.ts` 的初始化與事件更新各寫一次相同的四個欄位，現在由 `startPinnedStatus()` 的 `snapshot()` 共用，重複消失。
- 事件類型的清單改成模組層的 `Set`。
- `guarded()` 讓事件與計時器兩條路徑共用同一個例外處理，沒有再簡化的空間。
