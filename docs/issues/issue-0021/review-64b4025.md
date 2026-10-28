# Issue 0021 審查報告：review-64b4025

- **審查日期**：2026-10-28
- Reviewed BASE SHA：0b9004a314ececf89321641bc015eb3e508b0f5b
- Reviewed HEAD SHA：64b4025b2761b701ec074cff6b95c6685a905791
- Reviewed patch-id：19c3c581470d693edea0e08f72d4ab173be3ac09
- **SHA 註記**：BASE 是 `main`，HEAD 是 `fix/pinned-errors-24h`；patch-id 以 `git diff 0b9004a..64b4025 | git patch-id --stable` 計算
- **審查範圍**：`0b9004a..64b4025` 全部 3 個提交（`27b36f7`、`65719f2`、`64b4025`），11 個檔案，+534／−26。範圍涵蓋整個分支，不是局部審查。
- **獨立 reviewer**：Claude Code 隔離 subagent（Opus 5.5），由協調者委派，不是本 issue 的實作者。沒有修改任何程式、測試或文件，唯一寫入的檔案是本報告。
- **交付方式**：不開 PR（README「Gate 豁免紀錄」2026-10-28）。報告存放在本機 `docs/issues/issue-0021/review-64b4025.md`。

## 流程判定

**PASS**

沒有 MUST FIX。AC-1～AC-3 都有真實的紅燈、綠燈與突變證據，reviewer 重跑後結果一致。下列 SHOULD FIX 是測試證據持久力的改善，依 [verification.md](../../agents/verification.md)「證據持久力」與 [review-evidence.md](../../agents/review-evidence.md)「審查強度與流程判定」，不阻擋 PASS。

**提醒協調者**：交付條件是「PASS 且無須修正」才 `git merge --ff-only`。本報告有 2 項 SHOULD FIX（都只改測試），要先補再合併，還是依現狀合併，由協調者或使用者決定。沒有 `需決策` 項目。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

**S-1：AC-2「閒置時不增加 API 請求」的關鍵狀態沒有被測試擋住**（`tests/pinned-status.test.ts`「issue 0021 AC-2 數字沒變的定期更新不編輯訊息」；`src/services/pinned-status.ts` 的 `send()`）

- reviewer 突變 R1：拿掉 `send()` 裡的 `lastErrors = recentErrors;`。9 個測試全綠。
- 這個突變下，錯誤數只要和啟動時不同，之後每一次 `refresh()` 都會送出更新。有過任何事件時，`Last request: Nm ago` 每分鐘都在變，`PinnedStatusManager` 的「文字沒變就不編輯」擋不住，閒置時每分鐘編輯一次訊息。AC-2 要防的就是這個回歸。
- 現有測試在 `errors = 2` 之後只呼叫一次 `refresh()`，所以看不出來。
- 建議：在該測試最後（`errors = 2` 送出之後）再呼叫一次或兩次 `refresh()`，斷言 `updates.length` 仍是 2。也可以在「事件送出數字 X」之後接一次 `refresh()`（數字仍是 X），斷言不送出，同時擋住事件路徑的同類回歸。
- 現有綠燈不是假綠燈：紅燈為真、綠燈由目標行為驅動，只是守門範圍窄。

**S-2：定期更新（計時器）路徑的例外處理沒有測試**（`src/services/pinned-status.ts` 的 `refresh()`；`src/main.ts` 的 `setInterval`）

- reviewer 突變 R2：拿掉 `refresh()` 外層的 `guarded()`。9 個測試全綠。現有的「讀取來源 throw」測試只走事件路徑。
- 這層保護在 AC-3 附近的情境是必要的：資料庫讀不到時，`countRecentErrors()` 回傳 `null`，和上一次的數字不同，於是 `send()` 呼叫 `snapshot()`；`memory.getActiveSchedules()`、`getMessagesPage()` 讀同一個資料庫，很可能一起 throw。`refresh()` 在 `setInterval` 裡執行，`src/` 沒有 `uncaughtException` handler，少了 `guarded()` 就會讓 telenexus 程序崩潰。
- 建議：新增一個測試，讓 `activeSchedules`（或 `recentErrors` 以外的任一來源）在 `refresh()` 時 throw，並讓錯誤數改變以進入 `send()`，斷言 `refresh()` 不 throw、沒有送出更新。
- 目前的程式行為正確，缺的只是回歸保護。

### NICE TO HAVE

**N-1：AC-3 的檢查方式沒有一個端對端測試**（`tests/pinned-status.test.ts`）

AC-3 的檢查方式是「讓查詢 throw，確認訊息內容是 unknown、其他欄位正確，且呼叫端沒有收到例外」。現有測試分成兩段：`countRecentErrors(broken)` 回傳 `null`，以及 `PinnedStatusManager` 收到 `null` 時顯示 `unknown`。兩段的組合很直接，但沒有一個測試從 `startPinnedStatus()` 經由會 throw 的 `countIssuesByScope` 一路到訊息文字。可以補一個：`startPinnedStatus(realManager, { ..., recentErrors: () => countRecentErrors(broken) })`，觸發事件與 `refresh()`，斷言最後的文字含 `Recent errors (24h): unknown`，其他欄位正確。

**N-2：「和 error-summary.md 各 scope 加總相同」只在 scope 不超過 10 個時成立**（`docs/configuration-reference.md` 新增的那一行；`ARCHITECTURE.md` 的 `pinned-status.ts` 條目寫的是「同一個查詢」，正確）

`src/services/context-snapshots.ts` 的「Past 24h by Scope (persisted)」只列 `persistedByScope.slice(0, 10)`。24 小時內超過 10 種 scope 時，`error-summary.md` 上看得到的數字加總會小於釘選訊息。查詢相同、資料相同，差在顯示截斷。可以把措辭改成「同一個查詢（error-summary 只列前 10 個 scope）」。AC-1 原文也有同一句，實作符合「同一份資料、同一個查詢」的意圖，不視為驗收缺口。

**N-3：README「風險與首要驗證」的一句沒有跟著 AC-2 修訂**（`docs/issues/issue-0021/README.md`「風險與首要驗證」第二點）

仍寫「定期更新在文字沒變時不呼叫 Telegram，不增加 API 請求」。AC-2 已改成「只在錯誤數改變時才編輯」，這句是修訂前的錯誤前提。建議結案時一起改。

**N-4：「同一 scope＋訊息 60 秒內只記一列」比實際行為寬鬆**（`docs/configuration-reference.md` 新增的那一行；README「已確認的現況」）

`recordRuntimeIssue()`（`src/utils/errors.ts`）的記憶體去重命中時，會把該筆的時間改成現在，然後直接 return，不發事件、也不呼叫 `IssueStore`。所以去重視窗是滑動的：一個錯誤只要每次間隔都不到 60 秒，持續多久都只寫第一列。reviewer 探針：同一 scope、同一訊息每 30 秒呼叫一次、共 120 次（60 分鐘），`runtime_issues` 最近 24 小時只有 1 列；如果這種狀況持續超過 24 小時，即使錯誤還在發生，計數也會降到 0。

這是既有行為，`error-summary.md` 的 persisted 數字也一樣，和使用者核准的「計列數」（Q2）一致，不在本 issue 範圍內。只建議把文件措辭改成「間隔不到 60 秒的重複只記第一次」。要不要改變計法，可另開 issue。

**N-5：Telegram 編輯失敗後，定期更新不會補送**（`src/services/pinned-status.ts` 的 `send()`）

`send()` 在 `manager.update()` 完成前就更新 `lastErrors`。`PinnedStatusManager.flush()` 編輯失敗只記 warn，`lastRenderedText` 不變；下一次 `refresh()` 看到數字相同就不送，訊息會停在舊的數字，直到下一個事件或數字再次改變。例如閒置時從 1 降到 0 的那次編輯失敗，訊息會一直顯示 1。改動前編輯失敗也不重試，所以不算退步。要處理的話，可以讓 `PinnedStatusManager` 回報 flush 是否成功，或在 `refresh()` 比對「最後一次成功顯示的數字」。

## 規格修訂判斷：AC-2 措辭

- 核准版（`0b9004a`）：「文字沒有改變時不呼叫 Telegram 編輯訊息（沿用現有行為），閒置時不增加 API 請求。」檢查方式：「……數字沒變的定期更新不產生編輯。」
- 目前版：「定期更新只在錯誤數改變時才編輯訊息，閒置時不增加 API 請求。訊息裡的 `Last request: Nm ago` 每分鐘都在變，所以不能靠『整段文字沒變就不編輯』。」檢查方式不變。

**結論：屬於措辭修訂，不需重新核准。**

1. 核准版本身互相矛盾：有過任何請求後，`Last request` 的分鐘數每分鐘都在變，照「文字沒變才不編輯」做，定期更新每分鐘都會編輯，違反同一句的「閒置時不增加 API 請求」。
2. 修訂後的條件和核准版的**檢查方式**（「數字沒變的定期更新不產生編輯」）逐字對應。檢查方式沒動，使用者核准的 Q3「跟著 context 快照定期更新」也沒動。
3. 依 [acceptance.md](../../agents/acceptance.md)「規格修訂的查核」：差異沒有改變條件、動作、結果或必要檢查時，原核准有效，記 Timeline 即可。README Timeline 已記錄。

可觀察的副作用：閒置時 `Last request: Nm ago` 的分鐘數不會跟著定期更新前進。改動前閒置時根本不更新，所以這是既有行為；README「不在範圍內」也寫明其他欄位不改。不構成新的未核准行為。

## Proof of Test

| 驗收 | 可觀察結果摘要 | 規格 | 測試／證據 | 結果 |
|------|----------------|------|------------|------|
| AC-1 | 釘選數字等於 `runtime_issues` 最近 24 小時的列數；超過 20 照實顯示；重開資料庫後不變；超過 24 小時不算；`recordRuntimeIssue()` 觸發的那次更新已包含這一筆 | `64b4025:docs/issues/issue-0021/README.md` AC-1 | `tests/pinned-status.test.ts` 測試 1、2、5、6；[step1](evidence/step1-count-and-unknown.md) 紅燈 4/5、突變 M1～M3；[step2](evidence/step2-wiring-and-refresh.md) 紅燈（測試 6：expected 1、actual 0）、突變 M6 | 通過；reviewer 重跑一致 |
| AC-2 | 錯誤超過 24 小時後，定期更新把訊息改成新數字；數字沒變的定期更新不產生編輯 | `64b4025:docs/issues/issue-0021/README.md` AC-2（措辭修訂見上節） | 測試 7、8；step2 紅燈（7、8）、突變 M7、M8 | 通過；守門範圍窄，見 S-1 |
| AC-3 | 讀不到 `runtime_issues` 時顯示 `unknown`，其他欄位照常，不 throw | `64b4025:docs/issues/issue-0021/README.md` AC-3 | 測試 3、4、9；step1 紅燈（3、4）、突變 M4、M5；step2 突變 M9 | 通過；端對端組合見 N-1，計時器路徑見 S-2 |

豁免項目：無（Gate 豁免只涉及「不開 PR」）。README 沒有 `## 待確認事項` 的未決項。

## 已查核維度

### 需求與範圍

- 原始 GitHub issue #21 的兩個選項中，使用者選了「改成真正的 24 小時計數」（Q1），計列數（Q2）。實作相符。
- 「不在範圍內」：`src/main.ts` 第 264 行 full prompt 的 15 分鐘異常、`context-snapshots.ts` 的 buffered 數字、`/api/metrics`、`memory-health` 都沒有改，`getRecentIssues` 的 import 仍被第 264 行使用。釘選訊息其他欄位與 5 秒節流沒有改。
- `countIssuesByScope()` 只被讀取，沒有改；沒有新增 SQL，沒有 schema 變更。

### 正確性：事件順序（microtask）

- `recordRuntimeIssue()` 的順序是：去重檢查 → push 進緩衝 → `emitEvent('runtime_issue')`（同步呼叫所有 event hook）→ 同步迴圈呼叫所有 issue hook（`IssueStore` 的 `appendRuntimeIssue` 是同步的 SQLite 寫入）。釘選的 event hook 只排一個 microtask，microtask 要等目前這段同步程式（含 issue hook 迴圈）跑完才執行，所以一定看得到剛寫入的那一列。
- 這個推論在所有呼叫路徑都成立，包括在 promise 鏈或其他 microtask 裡呼叫 `recordRuntimeIssue()`：新排的 microtask 永遠排在目前這個之後。前提是 issue hook 保持同步；`IssueStore` 是唯一寫入者，而且同步。
- 記憶體去重命中時直接 return，不發事件、不寫資料庫，計數不變，也不觸發更新，前後一致。`IssueStore` 自己的 fingerprint 去重（訊息前 120 字）擋下寫入時，事件照發，計數不變，更新照送，文字比對後可能不編輯。都不會算錯。
- `IssueStore` 寫入失敗時只記 console.error，該次更新顯示的是不含這一筆的數字，不是 `unknown`。可接受：查詢本身是成功的。
- `startIssueStore(memory)` 在 `main.ts` 第 202 行，早於 `startPinnedStatus()`（第 443 行），用的是同一個 `memory`。
- `request_done`、`request_error`、`schedule_fire` 和 `recordRuntimeIssue` 在同一段同步程式先後發生時，兩個 microtask 都在寫入之後執行，都看得到新的一列。

### 正確性：`lastErrors` 與節流

- `refresh()` 只在數字和 `lastErrors` 不同時呼叫 `send()`；事件路徑每次都送並更新 `lastErrors`。`null` 和 `null` 視為相同，不重複送 `unknown`；數字變 `null`、`null` 變數字都會送。
- `PinnedStatusManager.update()` 在節流中只覆寫 `pendingSnapshot`，計時器到時送最新那份；`send()` 每次都給完整的新快照，不會送出過時的欄位組合。
- `snapshot()` throw 時（見 S-2 的情境），`lastErrors` 不會被更新，下一輪 `refresh()` 會再試，只多一行 warn。
- 編輯失敗不補送，見 N-5。

### 例外處理

- 事件路徑：`queueMicrotask` 裡的 throw 不會被 event-bus 的 try/catch 接住；`guarded()` 接住了。step2 的 M9 證明拿掉它時 test runner 收到 `uncaughtException`。
- `manager.update()` 的 rejection 由 `.catch()` 接住。改動前是 `void pinned.update(...)`，理論上會變成 unhandled rejection；改動後是改善。實際上 `PinnedStatusManager.update()` 內部已經接住 `editMessage` 的錯誤，reviewer 突變 R3（改回 `void manager.update(next)`）全綠，這層是防禦性的，不需要另外測。
- 計時器路徑：`writeContextSnapshotsFn()` 內部逐檔 try/catch，不會 throw，`refresh()` 一定會被呼叫。`refresh()` 本身有 `guarded()`，但沒有測試，見 S-2。
- `createLogger().warn()` 只寫 fd，不會呼叫 `recordRuntimeIssue()`，不會形成事件迴圈。
- `editMessage` 的 parse-mode fallback 會呼叫 `recordRuntimeIssue()`，進而觸發釘選更新；被記憶體去重與 5 秒節流限制，迴圈有界，改動前就存在。

### 初始化失敗

- `startPinnedStatus()` 先 `await manager.initialize()`，成功後才註冊 event hook，和改動前一樣。`initialize()` reject 時，`bootstrap()` 一樣 reject，`contextRefreshTimer` 一樣不會建立（它在釘選之後），由 `bootstrap().catch` 記 Fatal Error。行為和改動前一致。
- `PINNED_STATUS_ENABLED=false` 時 `pinnedStatus` 是 `null`，計時器的 `pinnedStatus?.refresh()` 不做事。

### 跨重啟、24 小時邊界、unknown

- 重啟：測試 2 以新的 `MemoryManager` 重開同一個暫存資料庫，數字仍是 25。
- 邊界：資料含 24 小時內 1 秒與 24 小時外 1 秒各一列；step1 的 M1（25 小時）、M2（23 小時）都轉紅。查詢是 `ts >= now − 24h`，和 `error-summary.md` 相同。
- 定期過期：測試 7 讓唯一的一列變成 24 小時又 1 秒前，`refresh()` 後訊息改成 0，且只多一次編輯。
- unknown：測試 3、4；step1 的 M4、M5 轉紅。限制見 N-1、S-2。

### 效能

- 每個觸發事件多一次 `SELECT scope, COUNT(*) … WHERE ts >= ? GROUP BY scope`，走 `idx_issues_ts`；表只保留 7 天，而且因為去重，列數很少（README 記正式部署 24 小時 30 列）。每次事件原本就會讀 `ai-config.yaml`、查排程與訊息數，相比之下可忽略。
- 每 `CONTEXT_REFRESH_MS`（預設 60 秒）多一次同樣的查詢；只有數字改變時才組完整快照、才可能呼叫 Telegram。閒置時不增加 Telegram 請求。

### 架構邊界

- 新模組 `src/services/pinned-status.ts` 只依賴 `MemoryManager` 的型別、logger 與 event-bus；`PinnedStatusTarget` 只取 `initialize`／`update`，可以用假物件測試。`main.ts` 的接線縮成一次呼叫加計時器一行。
- `src/main.ts` 的兩處接線沒有單元測試，step2「限制」已主動揭露，依 verification.md 不構成缺失。reviewer 以 diff 審閱確認：`startPinnedStatus()` 收到的四個來源和改動前相同，只把 `getRecentIssues().length` 換成 `countRecentErrors(memory)`。

### 測試真偽

- 期望值都來自獨立來源：手算的字面值（25、1、0、2），不是重跑實作的算式。測試 1 另外和 `countIssuesByScope` 加總比對，這一條本身近似同義反覆，但同一測試已先用字面值 25 斷言，不影響有效性。
- AC-1 事件順序測試用真的 `recordRuntimeIssue()`、真的 `IssueStore` 與暫存 SQLite，沒有 mock 掉被驗收的順序。
- reviewer 突變結果（在臨時 worktree 中逐一套用、還原後 `cmp` 確認）：

| 突變 | 結果 |
|------|------|
| R1：`send()` 不更新 `lastErrors` | 全綠（S-1） |
| R2：`refresh()` 不包 `guarded()` | 全綠（S-2） |
| R3：`manager.update()` 不接 rejection | 全綠（防禦性，見「例外處理」） |
| R4：事件不更新 `lastRequestAt` | 測試 6 轉紅 |
| R5：計 scope 數而非列數加總 | 測試 1、2 轉紅（和 step1 M3 一致） |

### 每個提交單獨檢出

在臨時 worktree（主 checkout 同層，結束後已移除）逐一檢出，`node_modules` 以 symlink 共用：

| 提交 | `npx tsc -p . --noEmit` | `npm run test` |
|------|------|------|
| `27b36f7` | exit 0 | 第一次 `# tests 583`、`# fail 1`：`tests/web-streaming.test.ts`「web chat stream emits chunks before done…」失敗；單獨跑該檔 3 次都通過，重跑全套 exit 0、`# tests 583`、`# pass 583`。這個測試和本 issue 無關，判定為既有的時序不穩定，不是本分支造成 |
| `65719f2` | exit 0 | exit 0，`# tests 587`、`# pass 587`、`# fail 0` |
| `64b4025`（主 checkout） | exit 0 | exit 0，`# tests 587`、`# pass 587`、`# fail 0`；`npm run lint` exit 0；變更的 4 個 ts 檔 prettier 通過 |

`tests/` 下 73 個測試檔，和 step2／step3 記錄的數字相同（地雷 L-01）。測試命令一律加 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB`。

### 文件一致性

- `ARCHITECTURE.md`：`main.ts` 接線與 `pinned-status.ts` 條目都和程式一致。
- `CLAUDE.md` Key Modules：一致。
- `docs/configuration-reference.md`：補上原本漏寫的 `request_error`（程式本來就訂閱）、定期更新與只在數字改變時編輯，都正確；措辭精確度見 N-2、N-4。
- README 步驟狀態與證據連結正確；`**狀態**: 實作中` 在合併前合理，結案時由協調者更新。「風險」一句過時，見 N-3。

### 公開 repo 的資訊外洩

`git diff 0b9004a..64b4025` 搜尋家目錄路徑、OS 帳號名、8 位以上數字（Telegram ID）、bot token 格式、`token`、`TELEGRAM`：0 筆命中（地雷 L-10）。

## 邊界與失敗面

| 失敗面 | 輸入／狀態 | 預期 | 覆蓋 | 結論 |
|--------|-----------|------|------|------|
| 事件早於寫入 | `recordRuntimeIssue()` 發出新的一筆 | 這次更新已含這一筆 | 測試 6、M6、R4 | 成立 |
| 記憶體去重命中 | 同 scope、同訊息 60 秒內重複 | 不發事件、不寫入，計數不變 | 程式審閱；reviewer 探針 | 成立；文件措辭見 N-4 |
| DB fingerprint 去重 | 訊息前 120 字相同、後段不同 | 事件照發，計數不變 | 程式審閱 | 成立 |
| 超過 20 | 24 小時內 25 列 | 顯示 25 | 測試 1 | 成立 |
| 重啟 | 重開同一資料庫 | 數字不變 | 測試 2 | 成立 |
| 24 小時邊界 | 內 1 秒、外 1 秒 | 內算、外不算 | 測試 1、M1、M2 | 成立 |
| 閒置過期 | 唯一一列超過 24 小時 | 定期更新改成 0 | 測試 7、M7 | 成立 |
| 閒置不增加請求 | 數字沒變、`Last request` 分鐘數在變 | 不送更新 | 測試 8、M8 | 成立；R1 未被擋，見 S-1 |
| 查詢 throw | `countIssuesByScope` throw | 顯示 unknown、不 throw | 測試 3、4 | 成立；組合見 N-1 |
| 其他來源 throw（事件） | `activeSchedules` throw | 不崩潰、不送 | 測試 9、M9 | 成立 |
| 其他來源 throw（計時器） | 同上，經 `refresh()` | 不崩潰、不送 | 無測試；R2 存活 | 程式正確，缺回歸保護，見 S-2 |
| Telegram 編輯失敗 | `editMessage` reject | 記 warn，不崩潰 | 既有 `PinnedStatusManager` 行為 | 成立；不補送，見 N-5 |
| 初始化失敗 | `sendPlaceholder` reject | 和改動前相同 | 程式審閱 | 一致 |
| 停用 | `PINNED_STATUS_ENABLED=false` | 計時器不呼叫 refresh | 程式審閱 | 成立 |

## 審查時執行的命令

```bash
git diff 0b9004a..64b4025
git diff 0b9004a..64b4025 | git patch-id --stable
git worktree add --detach <臨時目錄> <提交>        # 27b36f7、65719f2、64b4025；結束後 git worktree remove
env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test
env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/pinned-status.test.ts   # 突變 R1～R5
env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/web-streaming.test.ts   # 不穩定測試重跑 ×3
npx tsc -p . --noEmit
npm run lint
npx prettier --check src/main.ts src/services/pinned-status.ts src/services/pinned-status-manager.ts tests/pinned-status.test.ts
gh issue view 21 --repo raybird/telenexus
```

沒有啟動或重啟任何服務，沒有碰正式部署目錄，沒有使用 `git stash`。

---

**Artifact 路徑**：`docs/issues/issue-0021/review-64b4025.md`
