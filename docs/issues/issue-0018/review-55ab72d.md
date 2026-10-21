# 審查報告
- 範圍：審查後續（6446a2d..55ab72d），完整交付範圍 0b030f0..55ab72d（本機獨立審查，未開 PR）
- Reviewed BASE SHA：6446a2d4c902a8c1e55820c31c874b9f945232d9（上次審查的 HEAD；完整交付範圍的 BASE 是 0b030f0f54514fd52e01d9fb7c118088af4f1189）
- Reviewed HEAD SHA：55ab72d7610487b74a27b236c9df07bad2ae8c4e
- Reviewed patch-id：
  - 後續範圍 `git diff -a 6446a2d 55ab72d | git patch-id --stable`：d12a42bf63afa846ae68d98cce130f1284da89af（重算，與協調者一致）
  - 完整範圍 `git diff -a 0b030f0 55ab72d | git patch-id --stable`：e6ed6854a1781304c723d4b549632067fcc3e6f7（重算，與協調者一致）
- 審查日期：2026-10-21
- 獨立 reviewer：Claude（Opus 5.5），以獨立 subagent 執行，不是 issue 0018 的實作者
- Review artifact：docs/issues/issue-0018/review-55ab72d.md

範圍內的 3 個提交：
- `1b7fb57`：只新增 `review-6446a2d.md`。`git diff --name-status 6446a2d 1b7fb57` 只有一行 `A`，之後的提交也沒有修改它。
- `b042094`：程式與測試。
- `55ab72d`：文件與證據。

## 問題與風險

### MUST FIX
無。

### SHOULD FIX

1. **文件把「釘選訊息的錯誤計數」列為看得到失敗的地方，但它在穩定運作後通常不會變**
   - 位置：`docs/web-console-reference.md:70`；計數來源在 `src/main.ts:442`、`:450`，標籤在 `src/services/pinned-status-manager.ts:100`
   - 問題：
     - 釘選訊息的數字是 `getRecentIssues().length`，也就是記憶體緩衝的筆數，不是 count 總和，也沒有時間窗。
     - 緩衝上限是 20 筆（`src/utils/errors.ts:14`），而且只依筆數淘汰，不會過期。
     - 程序跑一段時間、累積過 20 筆不同的 issue 之後，這個數字會固定在 20。之後 snapshot 轉為失敗、新增 10 筆，它也不會變。
     - 標籤寫 `Recent errors (24h)`，也和實際語意不符；不過這是既有問題，不在本 issue 範圍。
   - 影響：D-1 決定靠文件告訴維運者「目錄寫不進去時去哪裡看」。這三個地方裡，釘選訊息的計數是最不可靠的，讀者可能看到 20 沒變就以為沒事。
   - 建議：
     - 從清單拿掉這一項，或加註「緩衝未滿 20 筆時才會變動」。
     - 服務 log 與 `runtime_issues` 資料表這兩項是正確的。`runtime_issues` 在 `data/` 的 `moltbot.db`，不受 context 目錄權限影響。
     - `24h` 標籤可以另開 issue。

2. **README 步驟 4 的摘要誇大了紅燈**
   - 位置：`docs/issues/issue-0018/README.md:130`；證據在 `docs/issues/issue-0018/evidence/step4-review-followup.md:22-28`
   - 問題：
     - README 寫「補上的測試在修正前是紅燈」。但證據自己說明，3 個新測試裡只有「工作目錄被刪掉」在修正前是紅燈。「目錄無法建立」與「接上 event-projector」守的是既有行為，在修正前的程式上是綠燈，是靠突變 Mc 與 Ma 證明有效。
     - 證據的紅燈段寫「補上的測試先在 `6446a2d` 的程式上執行」也不精確。HEAD 的測試檔匯入 `clearContextSnapshotFailures`，在 `6446a2d` 上連載入都會失敗；我實測得到 `SyntaxError … does not provide an export named 'clearContextSnapshotFailures'`。下一列的紅燈要先在 `6446a2d` 補上這個 export 才會出現。
   - 證據表格內容本身是誠實的，交代了隔離問題與兩個本來就是綠燈的測試，所以這不算不實回報，只是摘要沒有對上。
   - 建議：
     - README 改成「1 個新測試在修正前是紅燈，另外 2 個守既有行為，以突變證明有效」。
     - 證據的紅燈段改成「`6446a2d` 加上 `clearContextSnapshotFailures()`」。

3. **D-1 的狀態值不在流程定義的集合裡**
   - 位置：`docs/issues/issue-0018/README.md:97`
   - 問題：`docs/AGENTS.md`「待確認事項」規定狀態只能是 `待確認`、`已解決`、`不影響本次交付`，後兩者要寫結論、理由與日期。D-1 寫的是「已決定（2026-10-21）」。dev-cycle 的懸置掃描可能把它當成未知狀態列出來。
   - 建議：改成 `已解決`，內容維持原樣（結論、日期與理由都已經有了）。

### NICE TO HAVE

1. **「目錄無法建立」測試的計數方式容易受緩衝淘汰影響**
   - 位置：`tests/context-snapshots.test.ts:251-274`
   - 這個測試以 `getRecentIssues()` 前後差計數。目前前面只累積 2 筆，加上 10 筆是 12 筆，不到 20 筆上限，結果是確定的。
   - 但之後只要在它前面多加幾個會記 issue 的測試，就會淘汰掉同 scope 的舊筆，算出負數或 0。同檔的 projector 測試已經因為這個原因改用 `addIssueHook` 計數，建議這裡也改用 hook。

2. **證據紅燈表第一列漏寫一個失敗**
   - 位置：`evidence/step4-review-followup.md:26`
   - 我重現「`6446a2d` 加上 export，但 `clearContextSnapshotFailures()` 不做事」的情況：「目錄無法建立」與「接上 event-projector」兩個測試都失敗，「工作目錄被刪掉」通過，與證據描述的隔離現象相符。
   - 證據只寫到第一個測試失敗，沒有寫 projector 那一個。可以補上，但不影響結論。

NICE TO HAVE 1、3、4（前次報告）不處理的理由我核對過：
- NICE 3 若合併成目錄層級的一筆，確實要改 AC-4 核准的 scope。
- NICE 4 的欄位是既有的報告欄位。
- NICE 1 本來就是可選項。

三項理由都可以接受。

## 已查核維度

### 前次 SHOULD FIX 的處理

| 項目 | 處理 | 驗證 | 結論 |
|---|---|---|---|
| SF1：工作目錄被刪掉時 throw 給呼叫端；目錄失敗沒有測試 | `src/services/context-snapshots.ts:236-241` 把 `recordRuntimeIssue()` 包在 try 裡；新增 `tests/context-snapshots.test.ts:251-274`（目錄是一般檔案）與 `:276-299`（刪掉 cwd、unset `APP_PROJECT_DIR`） | 我的 harness 在 HEAD 上連跑 3 輪都沒有 throw（前次在 6446a2d 上 3 輪都 throw）。`6446a2d` 加上 export 跑新測試，「工作目錄被刪掉」以 `ENOENT … uv_cwd` 失敗。突變 Mb、Mc 都重現轉紅 | 已解決 |
| SF2：重入前提寫錯 | 註解（`context-snapshots.ts:24-28`）與 `step2-red-green.md:15`、`:46` 都標上更正；新增 projector 測試（`:301-343`） | harness 結果不變：單一 snapshot 失敗寫 2 輪、同步深度 2；目錄失敗寫 3 輪、10 筆。新測試每次給不同錯誤訊息，避開 dedupe，以 hook 計數；突變 Ma（先記再標）重現轉紅 | 已解決。註解「必須先 add 再 record」正確說明了有上限的原因 |
| SF3：不推告警（需決策） | README D-1 選 (a)；文件寫明不推告警，以及看得到失敗的地方 | 對照 `error-alerter.ts:21-22`：門檻與時間窗的敘述正確；log 字串與 `context-snapshots.ts:233` 一致 | 決策已記錄；文件三個地方中有一個不可靠（本次 SHOULD FIX 1） |
| SF4：「不記 runtime issue」的斷言太窄 | `tests/memory-health.test.ts:599-602` 改成加總所有 scope 的 count | 突變 Md 補上 import 後，3 個 error 情況的測試轉紅，與證據相同；第一次漏 import 的 ReferenceError 那次不算，證據採用的是第二次 | 已解決。因為 dedupe 命中只會加 count，所以加總 count 才正確 |
| NICE 2：措辭 | `docs/web-console-reference.md:67` 改寫 | 對照前次的 18 種組合矩陣：「封存沒讀到時，checkpoint 有 session ID 或處理時間、或者有 `memory.db`，就是 `null`；兩者都沒有時是 `true`」，在 remote 與 error 兩種封存下都成立 | 正確 |

實作者突變的可信度：Ma～Md 我都在暫存 worktree 上獨立重做，轉紅的測試與 `step4-review-followup.md:50-55` 完全相同；每次跑完都還原，最後以 `diff -q` 確認與 HEAD 相同。

### 測試隔離

**`clearContextSnapshotFailures()`**：
- 只供測試使用的 export，和同 repo 的 `clearPromptSessionTraces`、`clearMemoryIntentTraces`、`clearMemoriaRecallTraces` 是同一種慣例。
- 正式程式沒有呼叫端，可以接受。

三個共享狀態：
- **模組層級的 `Set`**：`withSnapshotDataDir` 與 cwd 測試開頭都會清空，每個新測試都從「尚未失敗」開始。
  - 先前的 AC-3、AC-4 測試沒有依賴殘留狀態。AC-4 用的 scope 在它之前沒有出現過。
  - `tsx --test` 每個測試檔各自一個程序，不會跨檔案污染。
- **`recentIssues` 的 20 筆緩衝**：projector 測試已改用 hook 計數；目錄測試目前不受影響，但結構上容易受影響（NICE 1）。
- **60 秒 dedupe**：
  - projector 測試每次用不同訊息，量得到重入。
  - AC-4 測試以 count 總和計數，不受 dedupe 影響。
  - 目錄測試的錯誤訊息（`ENOTDIR`／`EEXIST`）和前面的測試都不同，不會被合併。
- **cwd 測試**：在 `finally` 裡還原 cwd、`APP_PROJECT_DIR`、`DB_DIR`。cwd 被刪掉時所有路徑解析都會失敗，所以不會寫出任何檔案到 repo。

### 新引入的問題

- 包上 try 之後，`recordRuntimeIssue()` 如果在 `emitEvent()` 裡 throw，那一筆已經進了 `recentIssues`，但 hook（IssueStore、ErrorAlerter）不會被呼叫。這只發生在工作目錄被刪掉的情況，而那時 `console.warn` 已經先印出紀錄。可以接受。
- 程式差異只有一個 try 包裝和一個新 export，不影響 10 個 snapshot 在成功情況下的輸出。前次逐字比對的結論仍然成立；這次只在 HEAD 上重跑 harness 確認行為，沒有再做兩版比對。
- 完整交付範圍 `0b030f0..55ab72d` 的其餘部分，前次報告已逐項審過，這次沒有變動。

### 需求、架構、安全、品質

- 需求：AC-1～AC-4 的實作與判定不變；D-1 確認不改 AC-4。
- 安全：搜尋本次 diff 的 `/home/`、帳號名、`/tmp/`、長數字 ID 與 token 樣式，只命中前次報告引用的搜尋說明文字，沒有私人資料。
- 品質：
  - try 加上註解，說明不能往外傳的原因。
  - 新測試的斷言都有獨立的期望值：1 次、深度 2、3 輪、每個檔案各 1，都是人工推導的結果，不是重算實作。

### 豁免、待確認與限制

- 豁免：沿用 README「Gate 豁免紀錄」2026-10-21 的不開 PR。
- 待確認：D-1 已有結論，只有狀態值的寫法要調整（SHOULD FIX 3）。
- 限制：沒有啟動服務，所以沒有實際看到釘選訊息；SHOULD FIX 1 是由程式碼推論。

## 你自己跑過的命令與結果

以下測試與 CLI 都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行。

| 命令 | 結果 |
|---|---|
| `git diff -a 6446a2d 55ab72d \| git patch-id --stable`、`git diff -a 0b030f0 55ab72d \| git patch-id --stable` | `d12a42bf…`、`e6ed6854…`，都一致 |
| `git diff --name-status 6446a2d 1b7fb57`；`git diff --stat 1b7fb57 55ab72d -- docs/issues/issue-0018/review-6446a2d.md` | 只有 `A review-6446a2d.md`；之後沒有修改 |
| `npm run build` | exit 0 |
| `npm run test` | exit 0；`# tests 558`、`# pass 558`、`# fail 0`；`tests/docker/` 4 個檔案的測試名稱都出現在輸出中 |
| `npm run lint` | exit 0 |
| 暫存 worktree（`6446a2d`），放入 HEAD 的兩個測試檔，跑 `npx tsx --test tests/context-snapshots.test.ts` | 原樣：`SyntaxError`（缺 export）；補 export 後：`# tests 7`、`# fail 1`（工作目錄被刪掉，`uv_cwd`）；export 不做事：`# fail 2`（目錄無法建立、接上 projector）；`tests/memory-health.test.ts` 在 `6446a2d` 上是 19/19 |
| 同一個 worktree 換入 HEAD 原始碼後做突變 Ma、Mb、Mc、Md（Md 有補 import） | 基準 26/26；轉紅的測試與證據相同；最後以 `diff -q` 確認已還原 |
| `npx tsx harness/deleted-cwd.mts <HEAD>` | 3 輪都 `no throw` |
| `npx tsx harness/reentry.mts <HEAD> one｜all` | `writeCalls 2／3`、`maxSyncDepth 2`、`threw null`、issue 1／10 筆 |
| `git worktree remove --force …`、`git worktree prune` | 暫存 worktree 已移除 |

沒有使用 git stash，沒有碰正式部署與 `runtelenexus_*` volume，也沒有任何網路寫入。

## 流程判定
PASS

沒有 MUST FIX。前次 4 項 SHOULD FIX 都已解決或依使用者決策處理，突變也都重現。本次 3 項 SHOULD FIX 都是文件與流程紀錄的準確度問題，不影響程式行為與驗收判定，建議合併前一併修正。
