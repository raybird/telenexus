# 步驟 1：24 小時計數與 unknown（AC-1、AC-3）

- 日期：2026-10-28
- 改動：
  - 新檔 `src/services/pinned-status.ts`：`countRecentErrors()`
  - `src/services/pinned-status-manager.ts`：`PinnedSnapshot.recentErrors` 改成 `number | null`，`renderText()` 在 null 時顯示 `unknown`
  - 新檔 `tests/pinned-status.test.ts`

## 影響分析

- `gitnexus_impact(renderText, upstream)` 回報 HIGH，直接呼叫者 2 個，都是同一個類別的 `initialize` 與 `flush`。d=2、d=3 列出的 `scripts/sync-skills.mjs`、`server.cjs`、`memoria-sync.ts` 信心值都是 0.5，和釘選訊息沒有呼叫關係，是名稱模糊比對的雜訊。
- `grep -rn "renderText\|PinnedSnapshot\|PinnedStatusManager" src tests`：除了類別自身，只有 `src/main.ts` 的一處建立，以及 `tests/pinned-status-manager.test.ts`。
- `countIssuesByScope` 只被讀取、沒有修改；`gitnexus_impact` 回報 LOW，唯一呼叫者是 `writeContextSnapshots`。

## 做法

計數直接用 `countIssuesByScope(now - 24h)` 加總，不另寫 SQL。`error-summary.md` 的「Past 24h by Scope (persisted)」用的也是這個查詢，兩處數字因此一定相同。

## 紅燈（最小實作前）

先放一個永遠回傳 0 的 `countRecentErrors()`，讓測試能載入，失敗的原因才是行為。

`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/pinned-status.test.ts`，exit 1：

```text
not ok 1 - issue 0021 AC-1 計數是 runtime_issues 最近 24 小時的列數，超過 20 照實顯示
not ok 2 - issue 0021 AC-1 重新開啟資料庫後，重啟前 24 小時內的錯誤仍然算在內
not ok 3 - issue 0021 AC-3 讀不到 runtime_issues 時回傳 null，不 throw
not ok 4 - issue 0021 AC-3 計數未知時顯示 unknown，其他欄位照常
ok 5 - issue 0021 AC-1 有數字時照實顯示
# tests 5
# pass 1
# fail 4
```

- 1、2：預期 25，實際 0。
- 3：預期 null，實際 0。
- 4：null 被印成 `Recent errors (24h): null`。
- 5：數字照實顯示是既有行為，所以先綠。這條擋的是之後把數字換掉的回歸。

測試資料：24 小時內 25 列（超過緩衝上限 20），包含一列在 24 小時邊界內 1 秒；24 小時邊界外 1 秒一列；兩天前一列。訊息各不相同，避免被 60 秒去重併掉。

## 綠燈（最小實作後）

`npx tsx --test tests/pinned-status.test.ts tests/pinned-status-manager.test.ts`：`# tests 8`、`# pass 8`、`# fail 0`。既有的 3 個釘選測試照常通過。

## 突變

| 突變 | 結果 |
|------|------|
| M1：窗口改成 25 小時 | 1、2 轉紅（多算邊界外那一列） |
| M2：窗口改成 23 小時 | 1、2 轉紅（少算邊界內那一列） |
| M3：計 scope 數，不計列數 | 1、2 轉紅 |
| M4：讀取失敗回傳 0 | 3 轉紅 |
| M5：未知時顯示 0 | 4 轉紅 |

每個突變後都還原檔案，並以 `cmp` 確認與備份相同，還原後全綠。

## 其他檢查

- `npm run build`：exit 0。
- `npx eslint src/services/pinned-status.ts src/services/pinned-status-manager.ts`：exit 0。
- `npx prettier --check`：三個檔都通過。

## 精煉

新函式只有一個查詢加總與一個 catch，`renderText()` 只改一個運算式，沒有可再簡化的地方，記為 no-op。
