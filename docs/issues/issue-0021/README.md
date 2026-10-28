# Issue 0021 - 釘選訊息的「Recent errors (24h)」改成真正的 24 小時計數 (Small)

GitHub：[#21](https://github.com/raybird/telenexus/issues/21)

## 概述

Telegram 釘選狀態訊息有一行 `Recent errors (24h): N`（`src/services/pinned-status-manager.ts` 的 `renderText()`），但 N 不是 24 小時內的錯誤數。`src/main.ts` 傳入的是 `getRecentIssues().length`，也就是 `src/utils/errors.ts` 的記憶體緩衝 `recentIssues`：

- 最多只留 20 筆（`RECENT_ISSUE_LIMIT`），所以 N 最大是 20。
- 同一個 scope、同一則訊息在 60 秒內重複發生，只遞增既有那筆的 `count`，所以 N 計的是條目數，不是發生次數。
- 條目不會隨時間過期：一天前的錯誤只要沒被新錯誤擠掉，就一直算在 N 裡。
- 服務重啟就歸零。

所以這個數字可能高估，也可能低估。2026-10-28 唯讀查正式部署的 `moltbot.db`：過去 24 小時 `runtime_issues` 有 30 列、6 種錯誤，緩衝最多只能顯示 20。

本 issue 改從 SQLite `runtime_issues` 計算 24 小時內的列數。`error-summary.md` 的「Past 24h by Scope (persisted)」用的也是同一個查詢；那一節只列前 10 個 scope，超過 10 個時畫面上的加總會比釘選訊息少。

已確認的現況：
- `runtime_issues` 由 `IssueStore`（`src/services/issue-store.ts`）寫入，保留 7 天。寫入前有兩層去重：
  - 記憶體緩衝：同一個 scope＋訊息在上一次發生後 60 秒內又發生，只遞增 `count`，不呼叫 `IssueStore`。視窗跟著最後一次發生往後移，所以持續反覆、間隔不到 60 秒的錯誤只記第一次（審查 review-64b4025 N-4 實測）。
  - `IssueStore`：同一個 fingerprint（scope＋訊息前 120 字）60 秒內只寫一列。
- 釘選訊息只在 `request_done`、`request_error`、`schedule_fire`、`runtime_issue` 事件時更新，閒置時不會更新。
- `recordRuntimeIssue()` 會先發 `runtime_issue` 事件，再呼叫 `IssueStore` 的 hook 寫入資料庫。在事件 hook 裡同步查 `runtime_issues`，會查不到剛發生的這一筆。

**不在範圍內**：
- 其他讀記憶體緩衝的地方不改：`error-summary.md` 的 buffered 與 15 分鐘數字、`/api/metrics`、full prompt 的「最近 15 分鐘異常」、`memory-health`。它們的標籤或用途和緩衝的語意相符。
- 釘選訊息其他欄位與節流（5 秒）不改。

## 涉及檔案

- `src/services/pinned-status-manager.ts` - `recentErrors` 允許「未知」，未知時顯示 `unknown`
- `src/core/memory.ts` - 視需要新增計算某時間之後 `runtime_issues` 列數的方法（現有 `countIssuesByScope()` 可加總，實作時擇一）
- `src/main.ts` - 釘選訊息改用 24 小時計數；事件觸發時讀到剛寫入的那一筆；隨 context 快照計時器定期更新
- `tests/pinned-status-manager.test.ts`，必要時新增測試檔 - AC-1～AC-3
- `ARCHITECTURE.md`、`CLAUDE.md` 的 Key Modules、`docs/configuration-reference.md` 的 `PINNED_STATUS_ENABLED` - 計數來源與定期更新

## 驗收條件

1. **AC-1：顯示 `runtime_issues` 最近 24 小時的列數**
   - 數字等於 `runtime_issues` 中時間在最近 24 小時內的列數，與同一時間 `error-summary.md`「Past 24h by Scope (persisted)」背後的查詢（`countIssuesByScope`）加總相同。那一節只列前 10 個 scope，超過 10 個時畫面上的加總會比較少。
   - 超過 20 照實顯示；服務重啟後，重啟前 24 小時內的錯誤仍然算在內；超過 24 小時的不算。
   - 新的 runtime issue 觸發的那次更新，計數已經包含這一筆。
   - 檢查方式：以暫存資料庫的單元測試放入 24 小時內 25 列與 24 小時前的列，確認數字是 25；重新開啟同一個資料庫後數字不變；呼叫 `recordRuntimeIssue()` 後，事件觸發的那次更新包含新的一筆。
2. **AC-2：閒置時數字仍會隨時間更新**
   - 釘選訊息跟著 context 快照的計時器（`CONTEXT_REFRESH_MS`，預設 60 秒）重新計算，錯誤超過 24 小時後，即使沒有聊天與排程，數字也會下降。
   - 定期更新只在錯誤數改變時才編輯訊息，閒置時不增加 API 請求。訊息裡的 `Last request: Nm ago` 每分鐘都在變，所以不能靠「整段文字沒變就不編輯」。
   - 檢查方式：單元測試讓錯誤超出 24 小時，觸發定期更新，確認訊息被編輯成新數字；數字沒變的定期更新不產生編輯。
3. **AC-3：讀不到 `runtime_issues` 時顯示 unknown**
   - 顯示 `Recent errors (24h): unknown`；其他欄位照常顯示，釘選訊息照常更新，不 throw。
   - 檢查方式：單元測試讓查詢 throw，確認訊息內容是 `unknown`、其他欄位正確，且呼叫端沒有收到例外。

- **核准日期**: 2026-10-28
- **核准來源**: 使用者 2026-10-28 對話的逐題確認：
  - Q1「改成真的 24h 計數，還是只改標籤」選「改成真的 24h 計數（建議）」（AC-1～AC-3）。
  - Q2「計數單位」選「計列數（建議）」（AC-1）。
  - Q3「閒置時是否定期更新」選「跟著 context 快照定期更新（建議）」（AC-2）。
  - Q4「讀取失敗時顯示什麼」選「顯示 unknown（建議）」（AC-3）。
  - 之後以一則總結確認推導出的行為 (a)～(c)，使用者選「全部照寫核准（建議）」：
    - (a) 新的 runtime issue 觸發的那次更新，計數已經包含這一筆（AC-1）；
    - (b) 超過 20 照實顯示，重啟前 24 小時內的錯誤仍然算（AC-1）；
    - (c) 其他讀記憶體緩衝的地方不改（概述「不在範圍內」）。

## 風險與首要驗證

**風險**: Low — 只改釘選訊息的一個數字。
- 查詢走 `runtime_issues(ts)` 的既有索引，保留 7 天、列數少，每次更新多一次 `COUNT(*)`，成本可忽略。
- 定期更新只在錯誤數改變時才編輯訊息，閒置時不增加 Telegram API 請求。
- 讀取失敗顯示 `unknown`，不影響訊息其他欄位與聊天。

首要驗證是 AC-1 的「事件觸發時包含剛發生的這一筆」：事件先於資料庫寫入，是這次唯一需要處理的順序問題。

## 實作與驗證步驟

1. ✅ **AC-1、AC-3：計數與 unknown**
   - 驗證方式：先寫測試確認失敗，再讓 `PinnedSnapshot.recentErrors` 允許未知、`renderText()` 顯示 `unknown`，並實作 24 小時計數。改 symbol 前跑 `gitnexus_impact`，並以 `grep` 核對呼叫者。
   - 完成判準：AC-1 的計數與重啟、AC-3 都有紅燈與綠燈紀錄；以突變確認 24 小時邊界與 `unknown` 會被測試擋下。
   - 相依：無。驗收條件已於 2026-10-28 核准。
   - 完成證據：[evidence/step1-count-and-unknown.md](evidence/step1-count-and-unknown.md)。空殼上紅燈 4/5；綠燈 8/8（含既有 3 個釘選測試）；5 個突變都轉紅。
2. ✅ **AC-1（事件順序）、AC-2：接線與定期更新**
   - 驗證方式：把 `src/main.ts` 的釘選接線抽成可測的函式，先寫測試確認失敗，再處理事件順序並接上定期更新。
   - 完成判準：「事件觸發的更新包含新的一筆」與 AC-2 都有紅燈與綠燈紀錄；以突變確認拿掉順序處理或定期更新時測試轉紅。
   - 相依：步驟 1。
   - 完成證據：[evidence/step2-wiring-and-refresh.md](evidence/step2-wiring-and-refresh.md)。照搬舊接線的空殼上紅燈 3/9；綠燈 9/9；4 個突變都轉紅；全套 `# tests 587`、`# pass 587`。`main.ts` 的兩處接線沒有單元測試，限制見該檔。
3. ✅ **交付檢查**
   - 驗證方式：更新 `ARCHITECTURE.md`、`CLAUDE.md`、`docs/configuration-reference.md`；執行 `npm run build`、`npm run test`（核對 `# tests` 數與測試檔數相稱）、`npm run lint`。
   - 完成判準：全部通過。
   - 相依：步驟 1、2。
   - 完成證據：[evidence/step3-delivery.md](evidence/step3-delivery.md)。build、lint 通過；`# tests 587`、`# pass 587`。
4. ✅ **審查後續：[review-64b4025.md](review-64b4025.md)**
   - 產出：`tests/pinned-status.test.ts`、`src/services/pinned-status.ts`（註解）、`docs/configuration-reference.md`、README。
   - 驗收：AC-1～AC-3。
   - 相依：步驟 1～3。
   - 完成證據：[evidence/step4-review-followup.md](evidence/step4-review-followup.md)。S-1、S-2、N-1～N-4 已處理，N-5 不處理並記錄理由；審查時全綠的兩個突變現在都會轉紅；`# tests 589`、`# pass 589`。

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-28 | 不開 PR；改由獨立 subagent 在本機審查分支，PASS 且沒有要修的項目時以 `git merge --ff-only` 合併進 `main`，不推送、不發版 | 交付方式選「分支＋本機審查，PASS 後自動合併（建議）」 | 沒有 GitHub 上的 PR 紀錄；審查報告保存在本 issue 目錄 |

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | `tests/pinned-status.test.ts` 有兩個測試呼叫 `emitEvent` 時沒有指向暫存目錄，會在執行目錄的 `workspace/context/events.jsonl` 寫入假的 `request_done`（複審 [review-3bb8538.md](review-3bb8538.md) N-1）。路徑在 gitignore 內，`tests/event-projector.test.ts` 本來也這樣 | 不處理（2026-10-28）：NICE TO HAVE，不影響驗收；只在跑 `docker:dev` 的同時於 repo 目錄跑測試時，開發環境的事件流會多幾筆 | 不影響 AC |
| TBD-2 | Telegram 編輯訊息失敗後，定期更新不補送，訊息停在舊數字，直到下一次數字改變或事件（審查 review-64b4025 N-5） | 不處理（2026-10-28）：改動前也不重試，不算退步；補送需要另訂重試策略 | 不影響 AC |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-28 | 建立；逐題確認 Q1～Q4 與交付方式 | - |
| 2026-10-28 | AC-1～AC-3 核准；記錄不開 PR 的 Gate 豁免 | 使用者 |
| 2026-10-28 | AC-2 措辭修訂：原寫「文字沒有改變時不呼叫 Telegram」，但 `Last request` 的分鐘數每分鐘都在變，改寫成「只在錯誤數改變時才編輯」。目標「閒置時不增加 API 請求」與檢查方式不變 | - |
| 2026-10-28 | 本機獨立審查 review-64b4025：PASS，2 項 SHOULD FIX 與 5 項 NICE TO HAVE；審查判定 AC-2 的修訂屬於措辭修訂 | reviewer |
| 2026-10-28 | 審查後續：補 S-1、S-2、N-1 的測試；N-2、N-4 修正 AC-1 說明與「已確認的現況」的措辭（error-summary 只列前 10 個 scope、去重視窗會往後移），條件與檢查方式不變；N-5 不處理 | - |
| 2026-10-28 | 本機獨立複審 review-3bb8538：PASS，沒有 MUST FIX 與 SHOULD FIX，2 項 NICE TO HAVE（N-2 已在結案時修正，N-1 記為 TBD-1） | reviewer |
| 2026-10-28 | 依使用者事先的指示（審查 PASS 而且沒有要修的項目時自動合併）以 `git merge --ff-only` 合併進 `main`（`2a862da`），未推送、未發版 | 使用者 |

---
**建立日期**: 2026-10-28  
**分級**: Small  
**風險**: Low\
**狀態**: 已完成
