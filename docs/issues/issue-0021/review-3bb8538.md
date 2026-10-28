- Reviewed BASE SHA：0b9004a314ececf89321641bc015eb3e508b0f5b
- Reviewed HEAD SHA：3bb85385785551f0a627e550e7c740e8f9a4532f
- Reviewed patch-id：f1aecf14ee7a3f1c2a827e0d3e58d37b602e94e8

# Issue 0021 審查報告：review-3bb8538

- **審查日期**：2026-10-28
- **SHA 註記**：BASE 是 `main`（`0b9004a`），HEAD 是 `fix/pinned-errors-24h`（`3bb8538`）。patch-id 以 `git diff 0b9004a..3bb8538 | git patch-id --stable` 計算。
- **審查範圍**：`0b9004a..3bb8538` 全部 5 個提交（`27b36f7`、`65719f2`、`64b4025`、`37e7595`、`3bb8538`），13 個檔案，+870／−29。這是完整分支審查，不是局部審查。重點是第二輪新增的 `3bb8538`，以及它是否處理好上一輪 [review-64b4025.md](review-64b4025.md) 的發現。
- **獨立 reviewer**：Claude Code 隔離 subagent（Opus 5.5），由協調者委派，不是本 issue 的實作者，也不是上一輪的 reviewer。唯一寫入的檔案是本報告，沒有修改程式、測試或其他文件，沒有 commit。
- **交付方式**：不開 PR（README「Gate 豁免紀錄」2026-10-28）。報告存放在本機 `docs/issues/issue-0021/review-3bb8538.md`。

## 流程判定

**PASS**

沒有 MUST FIX，也沒有 SHOULD FIX。上一輪的 S-1、S-2、N-1～N-4 都處理了，reviewer 自己重做突變後，上一輪存活的兩個突變現在都會轉紅。N-5 不處理的理由成立。AC-1～AC-3 都有有效證據，reviewer 在被審查提交上重跑：全套 exit 0，`# tests 589`、`# pass 589`。

下面兩項 NICE TO HAVE 都不影響行為與驗收，依 [review-evidence.md](../../agents/review-evidence.md)「審查強度與流程判定」不阻擋 PASS。reviewer 認為合併前不必處理。N-2 是 README 的一句話，結案提交時順手改即可。

沒有 `需決策` 項目。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

無。

### NICE TO HAVE

**N-1：兩個測試把事件寫進執行目錄的 `workspace/context/events.jsonl`**（`tests/pinned-status.test.ts`「issue 0021 AC-2 數字沒變的定期更新不編輯訊息」與「issue 0021 讀取來源 throw 時，事件觸發的更新不讓程序崩潰」；`65719f2` 引入）

- 這兩個測試呼叫 `emitEvent('request_done', …)`，但沒有包在 `withTempDb()` 裡，`APP_PROJECT_DIR` 沒有指到暫存目錄。`emitEvent()` 會 append 到 `resolveContextDir()`，也就是 `process.cwd()/workspace/context/events.jsonl`。
- reviewer 實測：在臨時 worktree 刪掉該檔後只跑 `tests/pinned-status.test.ts`，檔案重新出現，內容是兩行 `{"type":"request_done","ok":true}`。
- 影響很小：`workspace/context/` 在 `.gitignore` 裡，`tests/event-projector.test.ts` 本來就這樣做。但在 repo 目錄跑測試時，若同時有 `npm run docker:dev` 掛載同一個 `workspace/`，開發環境的事件流會多出假的 `request_done`。
- 同一檔的 N-1 新測試（「AC-3 查詢 throw 時…」）已經用 `withTempDb()` 隔離，可以照同樣方式把這兩個測試也包起來，或抽一個只設 `APP_PROJECT_DIR` 的 helper。

**N-2：README 概述仍寫「兩處數字因此對得起來」**（`docs/issues/issue-0021/README.md` 第 16 行）

`3bb8538` 已經在 AC-1、`docs/configuration-reference.md` 與 `countRecentErrors` 的註解補上「error-summary 只列前 10 個 scope，超過時畫面加總會比較少」，但概述這一句沒有跟著加。屬於上一輪 N-2 的殘留，不影響驗收。建議結案提交時改成「同一個查詢（error-summary 只列前 10 個 scope）」。

## 上一輪發現的處理核對

| 項目 | `3bb8538` 的處理 | reviewer 核對 | 結論 |
|------|------------------|---------------|------|
| S-1：拿掉 `send()` 的 `lastErrors = recentErrors` 時測試全綠 | 測試 8 在數字改成 2、送出之後，再呼叫兩次 `refresh()`，斷言不重送 | 突變 R1 → 測試 8 轉紅；另做的 R6（`refresh()` 不比對、每次都送）也是 8 轉紅 | 已處理 |
| S-2：計時器路徑的 `guarded()` 沒有測試 | 新增測試 10：錯誤數變成 `null`、`activeSchedules` 同時 throw，`refresh()` 不 throw、不送；來源恢復後補送 `null` | 突變 R2（`refresh()` 不包 `guarded()`）→ 10 轉紅；R3（先記數字再組快照）→ 10 轉紅；R12（`refresh()` 不送 `null`）→ 10 轉紅。測試同時擋住「失敗後不補送」與「不包 guard」兩類回歸 | 已處理，而且比建議的範圍多擋一類 |
| N-1：沒有從 `startPinnedStatus()` 到 `unknown` 的端對端測試 | 新增測試 11：真的 `PinnedStatusManager` 加上會 throw 的 `countRecentErrors`，驗啟動與事件更新的文字 | R4（讀取失敗回 0）→ 3、11 轉紅；R7（`null` 顯示成 0）→ 4、11 轉紅；R11（初始化把 `null` 當 0）→ 只有 11 轉紅，證明它補到了原本沒覆蓋的初始化路徑 | 已處理 |
| N-2：error-summary 只列前 10 個 scope | `docs/configuration-reference.md`、README AC-1、`countRecentErrors` 的註解 | 與 `src/services/context-snapshots.ts` 的 `persistedByScope.slice(0, 10)` 一致 | 已處理；概述一句殘留，見本輪 N-2 |
| N-3：README 風險一節沒跟著 AC-2 改 | 改成「只在錯誤數改變時才編輯訊息，閒置時不增加 Telegram API 請求」 | 和 AC-2 與程式一致 | 已處理 |
| N-4：「60 秒內只記一列」比實際寬鬆 | `docs/configuration-reference.md` 與 README「已確認的現況」改寫成兩層去重，說明視窗會往後移 | 對照 `src/utils/errors.ts`：命中時把 `timestamp` 改成現在、`count += 1`，直接 return，不發事件、不呼叫 issue hook；`IssueStore` 另以 scope＋訊息前 120 字、60 秒去重。措辭正確。「持續反覆的錯誤只算第一次」在記憶體緩衝被 20 個以上的新錯誤擠掉、或服務重啟時會再記一列，屬於少見例外，作為使用者說明的近似可接受 | 已處理 |
| N-5：Telegram 編輯失敗後定期更新不補送 | 不處理，理由：改動前也不重試，補送要另定重試策略 | 見下節 | 理由成立 |

### N-5 不處理的理由

理由成立：

1. 不算退步。改動前閒置時完全不更新，事件路徑的編輯失敗也只記 warn、不重試。改動後事件路徑行為相同，計時器路徑只是多了一個機會，失敗時退回到改動前的狀態：等下一個事件，或等數字再變。
2. `PinnedStatusManager.flush()` 編輯失敗時不更新 `lastRenderedText`，所以之後任何一次更新都會補上正確文字，訊息不會永久卡住。
3. AC-2 規定的是 Telegram 正常時閒置也會下降，沒有涵蓋 Telegram API 失敗。要補送，就得讓 `PinnedStatusManager` 回報成功與否，或另訂重試與退避。這會改到不在本 issue 範圍的 manager 介面與節流（README「不在範圍內」：節流不改）。

殘餘風險：閒置時數字下降的那一次編輯失敗，訊息會停在舊數字，直到下一個事件或數字再變。需要時可另開 issue。

## 規格修訂判斷

依 [acceptance.md](../../agents/acceptance.md)「規格修訂的查核」：Small＋Low 沒有核准 commit，要對照核准原話（README「核准來源」的 Q1～Q4 與 (a)～(c)）。比對基線是 `0b9004a` 的 README。

### AC-2：屬於措辭修訂（同意上一輪判斷）

- 核准版：「文字沒有改變時不呼叫 Telegram 編輯訊息（沿用現有行為），閒置時不增加 API 請求。」目前版：「定期更新只在錯誤數改變時才編輯訊息，閒置時不增加 API 請求。」
- 核准版前後兩句互相矛盾：`Last request: Nm ago` 每分鐘都在變，照字面做，閒置時每分鐘都會編輯。修訂後的條件和核准版沒動過的**檢查方式**（「數字沒變的定期更新不產生編輯」）逐字對應。使用者的 Q3「跟著 context 快照定期更新」也沒動。
- 結論：條件、動作、結果與必要檢查都沒變，原核准有效，Timeline 已記錄。

### AC-1 說明：屬於措辭修訂

- 核准版：「……與同一時間 `error-summary.md`『Past 24h by Scope (persisted)』各 scope 的數字加總相同。」目前版：「……與同一時間 `error-summary.md`『Past 24h by Scope (persisted)』背後的查詢（`countIssuesByScope`）加總相同。那一節只列前 10 個 scope，超過 10 個時畫面上的加總會比較少。」
- 決定釘選數字的主條件沒變：等於 `runtime_issues` 最近 24 小時的列數。檢查方式也沒變：25 列、重開資料庫、`recordRuntimeIssue()`。修訂的是另一個畫面（error-summary）和這個數字的關係描述。核准版那句在 scope 超過 10 個時本來就不成立，除非去改 error-summary 的顯示，而沒有人要求改 error-summary。
- 使用者的核准原話（Q1「改成真的 24h 計數」、Q2「計列數」、(a)～(c)）都沒提到要和 error-summary 畫面逐項相等。修訂沒有碰到使用者選過的任何一項，只是把協調者轉述時寫錯的前提改正。
- 結論：屬於措辭修訂，不需重新核准，Timeline 已記錄。如果使用者其實希望 error-summary 畫面上的加總和釘選數字永遠相等，就要讓 error-summary 列出全部 scope，那是另一個需求，不在本 issue。
- 「已確認的現況」的去重說明不是驗收條件，屬於事實更正。

## Proof of Test

| 驗收 | 可觀察結果摘要 | 規格 | 測試／證據 | 結果 |
|------|----------------|------|------------|------|
| AC-1 | 釘選數字等於 `runtime_issues` 最近 24 小時的列數；超過 20 照實顯示；重開資料庫後不變；超過 24 小時不算；`recordRuntimeIssue()` 觸發的那次更新已含這一筆 | `3bb8538:docs/issues/issue-0021/README.md` AC-1（措辭修訂見上節） | `tests/pinned-status.test.ts` 測試 1、2、5、6；[step1](evidence/step1-count-and-unknown.md)、[step2](evidence/step2-wiring-and-refresh.md) 的紅燈與突變；本報告 R5、R9、R10、R14、R15 | 通過；reviewer 重跑一致 |
| AC-2 | 錯誤超過 24 小時後，定期更新把訊息改成新數字；數字沒變的定期更新不編輯，送出後也不重送 | `3bb8538:docs/issues/issue-0021/README.md` AC-2（措辭修訂見上節） | 測試 7、8；step2 的紅燈與突變 M7、M8；[step4](evidence/step4-review-followup.md) R1；本報告 R1、R6、R9 | 通過；上一輪 S-1 的缺口已補 |
| AC-3 | 讀不到 `runtime_issues` 時從啟動到事件更新都顯示 `unknown`，其他欄位照常，不 throw | `3bb8538:docs/issues/issue-0021/README.md` AC-3 | 測試 3、4、9、10、11；step1 的突變 M4、M5；step4 R2～R4；本報告 R2、R3、R4、R7、R8、R11、R12 | 通過；上一輪 S-2、N-1 的缺口已補 |

豁免項目：無（Gate 豁免只涉及「不開 PR」）。README 沒有 `## 待確認事項` 的未決項。

## 已查核維度

### 需求與範圍

- 與 GitHub #21 的第一個選項相符：從 `runtime_issues` 算，跨重啟正確，計列數（Q2）。
- 「不在範圍內」都沒動：`src/main.ts` 第 264 行 full prompt 的 15 分鐘異常仍讀 `getRecentIssues()`；`context-snapshots.ts`、`/api/metrics`、`memory-health` 沒有改。釘選訊息的其他欄位與 5 秒節流沒有改。
- `countIssuesByScope()` 只被讀取。沒有新增 SQL，沒有 schema 變更。

### 正確性

- **microtask 時序**：`recordRuntimeIssue()` 依序是去重檢查、push、`emitEvent('runtime_issue')`（同步呼叫 event hook，釘選 hook 只排 microtask）、同步呼叫 issue hook（`IssueStore` 同步寫 SQLite）。microtask 在這整段同步程式之後才執行，所以一定看得到新的那一列。從 promise 鏈或其他 microtask 裡呼叫也成立，前提是 issue hook 保持同步。突變 R5（改成同步計算）→ 測試 6 轉紅。
- **計時器與事件交錯**：`refresh()` 由 `setInterval`（macrotask）呼叫，不會插進事件與其 microtask 之間。兩者在同一個節流窗內都送出時，`PinnedStatusManager.update()` 只保留最新的 `pendingSnapshot`；每次 `send()` 都組完整快照，不會送出過時的欄位組合。
- **`lastErrors` 狀態**：只在 `snapshot()` 成功後才記（R3 證明順序被測試釘住），`null` 對 `null` 不重送，數字變成 `null` 與 `null` 變回數字都會送（R12）。
- **例外與 rejection**：事件 microtask 與 `refresh()` 都包在 `guarded()` 裡（R8、R2 轉紅）。`manager.update()` 的 rejection 由 `.catch()` 接住；R16（改回 `void manager.update(next)`）存活，因為 `PinnedStatusManager.update()`／`flush()` 內部已經接住 `editMessage` 的錯誤，這層是防禦性的，上一輪也判定不需另測，reviewer 同意。
- **24 小時邊界**：查詢是 `ts >= now − 24h`，和 error-summary 相同；種子資料內外各差 1 秒，R9（25 小時）→ 1、2、7 轉紅，R10（23 小時）→ 1、2 轉紅。
- **跨重啟**：測試 2 用新的 `MemoryManager` 重開同一個暫存資料庫。
- **unknown 顯示**：`renderText()` 用 `?? 'unknown'`。`0` 照實顯示 `0`，不會被當成未知；`?? ` 而不是 `||`，正確。
- **初始化與停用**：`startPinnedStatus()` 先 `await manager.initialize()` 再註冊 hook，和改動前一樣；`initialize()` reject 時 `bootstrap()` reject，計時器也不會建立，行為同改動前。`PINNED_STATUS_ENABLED=false` 時 `pinnedStatus` 是 `null`，計時器的 `pinnedStatus?.refresh()` 不做事。`startIssueStore(memory)`（`main.ts` 第 202 行）早於 `startPinnedStatus()`（第 443 行），用的是同一個 `memory`。
- **log 量**：資料庫壞掉時，每次事件與每次 `refresh()` 都會記一行 `recent_errors_unavailable` warn，預設每分鐘一行。在這種故障下可接受。

### 測試真偽

- 期望值都是手算的字面值（25、1、0、2、`unknown`、`Active schedules: 2`），不是重跑實作。
- `3bb8538` 的新斷言在原本就正確的程式上是綠的，不是新行為。依 [verification.md](../../agents/verification.md)「證據持久力」，回歸保護以突變證明即可。step4 的 R1～R4 結果和 reviewer 重做的結果逐項一致。
- reviewer 的突變（在臨時 worktree 套用，每個突變後還原並比對內容相同）：

| 突變 | 轉紅的測試 |
|------|-----------|
| R1：`send()` 不記 `lastErrors` | 8 |
| R2：`refresh()` 不包 `guarded()` | 10 |
| R3：`send()` 先記數字再組快照 | 10 |
| R4：`countRecentErrors` 讀取失敗回傳 0 | 3、11 |
| R5：事件同步計算（拿掉 `queueMicrotask`） | 6 |
| R6：`refresh()` 不比對數字、每次都送 | 8 |
| R7：`null` 顯示成 0 | 4、11 |
| R8：事件路徑不包 `guarded()` | test runner 收到 `uncaughtException`，整檔失敗 |
| R9：視窗 25 小時 | 1、2、7 |
| R10：視窗 23 小時 | 1、2 |
| R11：初始化把 `null` 當 0 | 11 |
| R12：`refresh()` 不送 `null` | 10 |
| R13：不訂閱 `request_done` | 8、11 |
| R14：事件不更新 `lastRequestAt` | 6、11 |
| R15：計 scope 數而不是加總列數 | 1、2 |
| R16：`manager.update()` 不接 rejection | 全綠（防禦性，見上） |

### 每個提交

- `27b36f7`、`65719f2`、`64b4025` 已在上一輪逐一檢出驗證（見 review-64b4025「每個提交單獨檢出」）。
- `37e7595` 只新增 `docs/issues/issue-0021/review-64b4025.md`（`--name-status` 為 A），不影響程式。
- `3bb8538`（被審查 HEAD）在臨時 worktree 驗證：`npx tsc -p . --noEmit` exit 0；`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0，`# tests 589`、`# pass 589`、`# fail 0`；`tests/` 下 73 個測試檔，和 step2～step4 記錄的相同（地雷 L-01），589 = 587 + 本輪新增的 2 個；`npm run lint` exit 0；`tests/pinned-status.test.ts` 單獨跑 `# tests 11`、`# pass 11`。
- `npx prettier --check` 對 `src/main.ts`、`src/services/pinned-status.ts`、`src/services/pinned-status-manager.ts`、`tests/pinned-status.test.ts`、`ARCHITECTURE.md` 通過；`docs/configuration-reference.md` 有警告，但只在第 53～60 行的指令表格，`0b9004a` 就已存在，不是本分支改動的行。

### 文件一致性

- `ARCHITECTURE.md`：`main.ts` 以 `startPinnedStatus()` 啟動、計時器每輪檢查；`pinned-status.ts` 條目寫「同一個查詢」，正確；microtask 與「只在錯誤數改變時更新」的描述和程式一致。
- `CLAUDE.md` Key Modules：一致。
- `docs/configuration-reference.md`：補上程式本來就訂閱的 `request_error`；定期更新只在數字改變時編輯；兩層去重與 error-summary 前 10 個 scope 的說明正確；舊版語意（最多 20、不過期、重啟歸零）和 `src/utils/errors.ts` 相符。
- `src/services/pinned-status.ts` 的註解：`countRecentErrors` 與事件順序的說明正確。
- README：步驟 1～4 的狀態與證據連結正確；`**狀態**: 實作中` 在合併前合理，合併後由協調者結案（地雷 L-09）。概述一句見 N-2。

### 公開 repo 的資訊外洩

`git diff 0b9004a..3bb8538` 搜尋 Linux 與 macOS 的家目錄路徑樣式、OS 帳號名、8 位以上數字、bot token 格式（`數字:長字串`）、`token`、`TELEGRAM`、`ghp_`、`glpat`。命中的只有 40 碼 SHA 裡的數字，以及上一輪報告描述這次搜尋的那一句，沒有家目錄路徑、Telegram ID 或 token（地雷 L-10）。本報告也只寫相對路徑。

## 邊界與失敗面

| 失敗面 | 輸入／狀態 | 預期 | 覆蓋 | 結論 |
|--------|-----------|------|------|------|
| 事件早於寫入 | `recordRuntimeIssue()` 發出新的一筆 | 這次更新已含這一筆 | 測試 6；R5、R14 | 成立 |
| 記憶體去重命中 | 同 scope、同訊息、間隔不到 60 秒 | 不發事件、不寫入，計數不變 | 程式審閱 | 成立；文件措辭已修正 |
| 超過 20 | 24 小時內 25 列 | 顯示 25 | 測試 1；R15 | 成立 |
| 重啟 | 重開同一資料庫 | 數字不變 | 測試 2 | 成立 |
| 24 小時邊界 | 內 1 秒、外 1 秒 | 內算、外不算 | 測試 1、2、7；R9、R10 | 成立 |
| 閒置過期 | 唯一一列超過 24 小時 | 定期更新改成 0 | 測試 7 | 成立 |
| 閒置不增加請求 | 數字沒變；送出新數字之後 | 不送、不重送 | 測試 8；R1、R6 | 成立（上一輪 S-1 已補） |
| 查詢 throw | `countIssuesByScope` throw | 啟動與事件都顯示 unknown，不 throw | 測試 3、4、11；R4、R7、R11 | 成立（上一輪 N-1 已補） |
| 其他來源 throw（事件） | `activeSchedules` throw | 不崩潰、不送 | 測試 9；R8 | 成立 |
| 其他來源 throw（計時器） | 錯誤數變成 `null`，`activeSchedules` throw | 不崩潰、不送，恢復後補送 | 測試 10；R2、R3、R12 | 成立（上一輪 S-2 已補） |
| 節流中同時有事件與 refresh | 5 秒內兩次 `send()` | 送最新的完整快照 | 程式審閱（`pendingSnapshot` 覆寫） | 成立 |
| Telegram 編輯失敗 | `editMessage` reject | 記 warn，不崩潰；不補送 | 既有 `PinnedStatusManager` 行為；R16 | 成立；不補送見 N-5 的處理 |
| 初始化失敗 | `sendPlaceholder` reject | 和改動前相同 | 程式審閱 | 一致 |
| 停用 | `PINNED_STATUS_ENABLED=false` | 計時器不呼叫 refresh | 程式審閱 | 成立 |
| 測試的副作用 | 在 repo 目錄跑測試 | 不寫入工作目錄 | reviewer 實測 | 兩個測試會寫入，見 N-1 |

## 審查時執行的命令

```bash
git diff 0b9004a..3bb8538
git diff 0b9004a..3bb8538 | git patch-id --stable
git show 3bb8538
git show --name-status 37e7595
git diff 0b9004a..3bb8538 -- docs/issues/issue-0021/README.md
git worktree add --detach <scratchpad>/wt-3bb8538 3bb8538   # node_modules 以 symlink 共用；結束後 git worktree remove
env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/pinned-status.test.ts tests/pinned-status-manager.test.ts
python3 -I <scratchpad>/mutate.py <worktree>   # 突變 R1～R16：逐一套用、跑 tests/pinned-status.test.ts、從備份還原並比對內容
env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test
find tests -name '*.test.ts' | wc -l
npx tsc -p . --noEmit
npm run lint
npx prettier --check src/main.ts src/services/pinned-status.ts src/services/pinned-status-manager.ts tests/pinned-status.test.ts docs/configuration-reference.md ARCHITECTURE.md
gh issue view 21 --repo raybird/telenexus
```

突變只在臨時 worktree 進行，主 checkout 從頭到尾沒有修改；worktree 已移除，`git worktree list` 只剩主 checkout，`git status` 只有本報告這個新檔。沒有啟動任何服務，沒有碰正式部署目錄，沒有使用 `git stash`。

---

**Artifact 路徑**：`docs/issues/issue-0021/review-3bb8538.md`
