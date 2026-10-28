# 步驟 4：審查後續（[review-64b4025.md](../review-64b4025.md)）

- 日期：2026-10-28
- 改動：`tests/pinned-status.test.ts`（擴充 1 個測試、新增 2 個）、`src/services/pinned-status.ts`（只改註解）、`docs/configuration-reference.md`、README

## 處理結果

| 項目 | 處理 |
|------|------|
| S-1：拿掉 `send()` 的 `lastErrors = recentErrors` 測試仍全綠 | 「AC-2 數字沒變的定期更新不編輯訊息」在數字改成 2 並送出後，再呼叫兩次 `refresh()`，斷言不會重送 |
| S-2：計時器路徑的 `guarded()` 沒有測試 | 新增「定期更新時讀取來源 throw，不讓計時器崩潰也不送更新」，同時驗證來源恢復後，先前沒送出的 null 仍會補送 |
| N-1：沒有從 `startPinnedStatus` 一路驗到 `unknown` 的測試 | 新增「AC-3 查詢 throw 時，釘選訊息從啟動到事件更新都顯示 unknown」，使用真的 `PinnedStatusManager` 與 `countRecentErrors` |
| N-2：error-summary 只列前 10 個 scope | `docs/configuration-reference.md`、README AC-1 的說明、`countRecentErrors` 的註解都寫明「同一個查詢，那一節只列前 10 個」 |
| N-3：README 風險一節沒跟著 AC-2 改 | 改成「只在錯誤數改變時才編輯訊息」 |
| N-4：「60 秒內只記一列」比實際寬鬆 | `docs/configuration-reference.md` 與 README「已確認的現況」改寫成兩層去重：記憶體緩衝的視窗跟著最後一次發生往後移，持續反覆的錯誤只算第一次。計法照使用者 Q2 選的「計列數」，不改 |
| N-5：Telegram 編輯失敗後定期更新不補送 | 不處理。改動前也不重試，不算退步；補送要另外決定重試策略，不在本 issue 範圍 |

## 測試的有效性

S-1、S-2、N-1 補的是回歸保護，程式本來就正確，所以新斷言在現有程式上是綠的。以突變證明它們擋得住：

| 突變 | 結果 |
|------|------|
| R1：拿掉 `send()` 的 `lastErrors = recentErrors`（審查 S-1 的突變） | 8 轉紅；審查時這個突變是全綠 |
| R2：`refresh()` 不包 `guarded()`（審查 S-2 的突變） | 10 轉紅；審查時這個突變是全綠 |
| R3：`send()` 先記住數字、再組快照 | 10 轉紅：快照 throw 時數字已被記住，恢復後不會補送 |
| R4：`countRecentErrors` 讀取失敗回傳 0 | 3、11 轉紅 |

每個突變後都還原檔案，並以 `cmp` 確認與備份相同，還原後 `tests/pinned-status.test.ts` 是 `# tests 11`、`# pass 11`。

## 其他檢查

- `npm run build`：exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test`：exit 0，`# tests 589`、`# pass 589`、`# fail 0`（步驟 3 是 587，加上新增的 2 個測試）。
- `npm run lint`：exit 0。
- `npx prettier --check src/services/pinned-status.ts tests/pinned-status.test.ts`：通過。
