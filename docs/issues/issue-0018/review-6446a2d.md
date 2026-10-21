# 審查報告
- 範圍：完整交付範圍（本機獨立審查，未開 PR）
- Reviewed BASE SHA：0b030f0f54514fd52e01d9fb7c118088af4f1189
- Reviewed HEAD SHA：6446a2d4c902a8c1e55820c31c874b9f945232d9
- Reviewed patch-id：2fe903991c8faafb7bd46b45ac8b5d33d0716750（`git diff -a 0b030f0 6446a2d | git patch-id --stable` 重算，與協調者提供的值一致）
- 審查日期：2026-10-21
- 獨立 reviewer：Claude（Opus 5.5），以獨立 subagent 執行，不是 issue 0018 的實作者
- Review artifact：docs/issues/issue-0018/review-6446a2d.md

## 問題與風險

### MUST FIX
無。

### SHOULD FIX

1. **`writeContextSnapshots()` 仍有路徑會 throw 給呼叫端，而且證據寫成已處理**
   - 位置：`src/services/context-snapshots.ts:223-228`、`src/services/event-bus.ts:67`、`docs/issues/issue-0018/evidence/step2-red-green.md:107`
   - 問題：證據說「`resolveContextDir()` 會呼叫 `process.cwd()`，工作目錄被刪掉時會 throw；舊程式的外層 try 會接住它，新程式也不能讓它傳到 message pipeline」。
     - 新程式的 catch 會呼叫 `recordRuntimeIssue()`，它再呼叫 `emitEvent()`。
     - `emitEvent()` 的 `resolveEventsPath()` 在 try 外面，也會呼叫 `resolveContextDir()`。
     - 所以工作目錄被刪掉、又沒有設 `APP_PROJECT_DIR` 時，這個 throw 會從 catch 裡傳出去。
   - 實測：harness 刪掉 cwd、unset `APP_PROJECT_DIR`，連跑 3 輪。
     - BASE 三輪都沒有 throw。
     - HEAD 三輪都 throw `ENOENT: no such file or directory, uv_cwd`。
     - 每輪只處理到第一個還沒標成失敗的 snapshot，就中斷整個迴圈。
   - 影響：
     - `src/main.ts` 60 秒的 `setInterval` 沒有 try，也沒有 `uncaughtException` handler，所以這個情況下程序會直接結束。
     - message pipeline 的前置與後置呼叫也會收到這個例外。
     - 實際發生機率很低：Dockerfile 與 compose 都設定 `APP_PROJECT_DIR=/app`，正式部署走不到這條路徑，只有主機開發又刪掉 cwd 時才會遇到。而且在那種狀態下，舊程式其他呼叫 `emitEvent()` 的地方也會壞掉。
     - 不過這相對 BASE 是回歸，而且證據寫的是已經處理。
   - 突變也證實沒有測試擋得住：把目錄的解析與建立移到迴圈外、不放在 try 裡（突變 M8），`tests/context-snapshots.test.ts` 4/4 仍然通過。
   - 建議：
     - 把 catch 裡的 `recordRuntimeIssue()` 包在 try 裡，或在函式最外層保留一層 try，確保這個函式不會 throw。
     - 補一個「context 目錄無法建立」的測試，例如讓 `workspace` 是一般檔案，確認不 throw、10 個 snapshot 各記一次。
     - 同時更正證據的敘述。

2. **證據說 event-projector 不會同步重入，實際上會**
   - 位置：`docs/issues/issue-0018/evidence/step2-red-green.md:76`、`src/services/event-projector.ts:59-62`
   - 問題：證據寫「event-projector 收到 `runtime_issue` 後，以 `setTimeout` 排下一輪寫入，不會同步重入」。但 projector 距離上次執行超過 `minIntervalMs`（預設 1 秒）時，會**同步**呼叫 `run()`。
     - 60 秒計時器或 message pipeline 觸發的那一輪裡，第一次失敗時，`recordRuntimeIssue()` 會在 catch 裡同步重入一次完整的 `writeContextSnapshots()`。
     - projector 的 `lastRunAt` 只在 projector 自己執行時更新。
   - 實測（`initEventProjector` 接上 `writeContextSnapshots`）：
     - 只有 `scheduler-status` 失敗：共寫 2 輪，同步深度 2，runtime issue 1 筆。
     - context 目錄無法建立：共寫 3 輪，也就是外層、同步重入、尾端補寫各一輪；同步深度 2，runtime issue 10 筆，沒有 throw。
   - 結論：
     - 不會形成迴圈。`failingSnapshots.add()` 在 `recordRuntimeIssue()` 之前執行；重入那一輪的 runtime issue 會因為 `lastRunAt` 剛更新而改走 `setTimeout`；後續輪次已經在 Set 裡，不會再發事件。
     - 代價是轉為失敗的那一刻多寫一到兩輪。
     - 結論沒錯，但推理所依據的前提是錯的。之後只要有人調整 add 與 record 的順序或 projector 的節流，這個前提就會失效。
   - 建議：
     - 更正證據與 `context-snapshots.ts:21-25` 的註解，寫明會同步重入一次、靠什麼保證有上限。
     - 可選：補一個接上 projector 的測試，確認寫入輪數有上限。

3. **snapshot 失敗在預設設定下永遠不會推 Telegram 告警** `需決策`
   - 位置：`src/services/error-alerter.ts:21-22`、`docs/issues/issue-0018/README.md:11`、`:82`
   - 問題：issue 概述把「`error-summary.md` 和 ErrorAlerter 都看不到」列為問題。改完後 ErrorAlerter 的 hook 收得到事件，但它是同一個 scope 在 10 分鐘內累積 3 次才推送。「開始失敗時記一次」的設計使每個 `context-snapshot:<檔名>` 每次轉為失敗只記 1 筆。
     - 失敗與恢復在 60 秒內反覆、錯誤訊息又相同時，第 2 筆會被 `recordRuntimeIssue` 的 dedupe 合併，連 hook 都不會呼叫。
     - 所以預設設定下不會有 Telegram 告警。
   - 影響：最常見的實際故障是地雷 L-08 的 context 目錄 `EACCES`。這時 10 個檔案全都失敗，`error-summary.md` 與同目錄的 `events.jsonl` 也寫不進去。剩下看得到的地方只有：
     - `console.warn`
     - `runtime_issues` 表（IssueStore）
     - 釘選訊息的錯誤計數
   - 核准紀錄 (e) 只討論了「每次都記」被高估的告警頻率，沒有寫明「開始時記一次＝不告警」。
   - 待決問題：snapshot 失敗要不要推 Telegram？可選做法：
     - (a) 接受現狀，在 README 與 `docs/web-console-reference.md:70` 寫明不會告警，以及能看到失敗的地方。
     - (b) 轉為失敗時直接推一則告警，不經過 threshold。
     - (c) 所有 snapshot 共用一個 scope，讓 10 個同時失敗能跨過 threshold。
   - reviewer 建議：(a)。成本最低，也符合已核准的 AC-4。若使用者期待的是「看得到」包含 Telegram，再改用 (b)。

4. **AC-1「不記 runtime issue」的斷言只看 `memory-health` 開頭的 scope**
   - 位置：`tests/memory-health.test.ts:599-601`
   - 問題：突變 M7 在 `readLocalDb()` 的 catch 裡加 `recordRuntimeIssue('local-db:' + label, err)`，`tests/memory-health.test.ts` 全部通過。實作裡本來就沒有任何以 `memory-health` 開頭的 scope，所以這個斷言幾乎不可能和程式意見不合。這是證據持久力的問題，不是假綠燈：本次實作確實沒有記 runtime issue。
   - 建議：改成比對 `getRecentIssues()` 的總筆數與 count 總和，或在測試期間掛一個 `addIssueHook` 計算呼叫次數。

### NICE TO HAVE

1. **`readLocalDb()` 與 `readArchive()` 可以合併**
   - 位置：`src/services/memory-health.ts:174`、`:309`
   - 兩者的「檔案存在判斷、唯讀開檔、try/finally 關閉、catch 轉成 error」是同一段結構。
   - `readArchive()` 可以改成呼叫 `readLocalDb(archiveDb, …, readArchiveStats)`，只在 `unavailable` 時覆寫 `detail`、補上 `source`，#17 的可觀察行為不會變。
   - 實作者不合併的理由（要動 #17 已驗證的行為，效益小）可以接受，不阻擋。

2. **文件的一致性說明有一處不精確，也有一個組合沒寫到**
   - 位置：`docs/web-console-reference.md:67`
   - 「遠端模式下有 checkpoint 或有 `memory.db` 時是 `null`」：checkpoint 存在、但沒有 session ID 與處理時間時，兩項 checkpoint 檢查是 `skipped`，`ok` 仍是 `true`。建議寫成「checkpoint 有 session ID 或處理時間」。
   - 「本機封存 `error` 且沒有 `memory.db`、沒有 checkpoint」時，`consistency.ok=true`，但 `archive.status=error`（見下方矩陣）。
     - 這符合修訂後的 AC-2：沒有可查的對象。
     - 但它和 #17 AC-5「封存讀取失敗時 `consistency.ok=null`」的字面說法不同。
     - 建議文件補一句：`ok` 只代表跨庫一致性，封存本身的狀態請看 `archive.status`。

3. **10 個 snapshot 同時失敗時，會一次記 10 筆不同 scope 的 runtime issue**
   - 位置：`src/services/context-snapshots.ts:214-229`
   - 這會佔掉 `recentIssues` 20 筆緩衝的一半，`error-summary.md` 的「Recent Runtime Issues」也會被擠滿。
   - 共同原因（目錄解析或建立失敗）可以在迴圈前先試一次，失敗就只記一筆 `context-snapshot:dir`。這樣也能順便處理 SHOULD FIX 1。

4. **`LocalRead.exists` 是多餘的欄位**
   - 位置：`src/services/memory-health.ts:163-168`
   - 它等於 `status !== 'unavailable'`，可以省略，由組裝報告的地方推導。屬可讀性建議。

## 已查核維度

### 驗收與證據

| AC | 檢查方式要求 | 證據位置 | 結論 |
|---|---|---|---|
| AC-1 | 兩個資料庫各做「不存在」與「不是 SQLite」；欄位與 markdown；不 throw；不記 runtime issue；兩者可讀時既有值不變；編譯後 CLI 實跑 | `tests/memory-health.test.ts:603-749`：運作資料庫不存在、不是 SQLite、缺資料表，檢索資料庫不是 SQLite、不存在，兩者可讀；既有 13 個測試維持通過；README 步驟 3 的 CLI 紀錄 | 通過。reviewer 重跑紅燈（BASE 程式加 HEAD 測試，6 個失敗）、綠燈與 CLI 兩種情況（`--json` 與 markdown 都是 exit 0，欄位相符）。`GET /api/memory-health` 回 200 沒有直接測試，但 `src/web/server.ts:2016-2017` 在不 throw 時無條件回 200，以程式碼推論成立。「不記 runtime issue」的斷言偏弱（SHOULD FIX 4） |
| AC-2 | 檢索資料庫不存在或讀不了時，各放可讀的封存與 checkpoint；不存在時 `ok=true`；運作資料庫讀不了時 gap 為 `null` | `tests/memory-health.test.ts:629-728` | 通過。另以 18 種組合的矩陣核對（見下方）。突變 M1（unavailable 沿用封存判定）、M4（unavailable 計數改成 null）、M9（checkpoint 檢查跟著檢索資料庫變 error）都轉紅 |
| AC-3 | 讓一個內容產生器 throw，其他檔案更新、失敗的內容不變；檢索資料庫不是 SQLite 時 `memory-status.md` 照常寫入並標 error | `tests/context-snapshots.test.ts:181-219` | 通過。reviewer 重現兩種紅燈：BASE 兩支程式時 3 個新測試都失敗，其中一個的錯誤正是 `ENOENT … memory-status.md`；只換 HEAD 的 `memory-health.ts` 時失敗 2 個。突變 S2（第一個失敗就停下）、S4（先全部算完再寫）都轉紅 |
| AC-4 | 失敗 3 輪、成功 1 輪、再失敗 1 輪 → runtime issue 2 次、恢復 log 1 行；`console.warn` 保留 | `tests/context-snapshots.test.ts:221-244` | 通過。斷言用 count 總和，不受 60 秒 dedupe 影響。突變 S1（每次都記）、S3（恢復時不清狀態）都轉紅。「程序重啟後再記」由模組層級的 `Set` 保證，沒有另外測試，合理 |

證據紀錄（`evidence/step1-red-green.md`、`evidence/step2-red-green.md`）的紅燈數、綠燈數與突變結果，reviewer 都能重現。不準確的只有兩段分析敘述（SHOULD FIX 1、2），不影響 AC 的判定。

### consistency 組合矩陣

在 HEAD 上實跑，checkpoint 的「有」代表同時有 session ID 與處理時間：

| 檢索資料庫 | 封存 | checkpoint | checks（orphan / cpSession / cpAhead） | tagged / orphan / missing | ok |
|---|---|---|---|---|---|
| ok | ok | 無／有 | checked/skipped/skipped；checked×3 | 1/0/1 | true |
| ok | remote | 無／有 | unsupported/skipped/skipped；unsupported×3 | 1/null/1 | null |
| ok | error | 無／有 | error/skipped/skipped；error×3 | 1/null/1 | null |
| unavailable | ok | 無／有 | skipped/skipped/skipped；skipped/checked/checked | 0/0/0 | true |
| unavailable | remote | 無 | skipped×3 | 0/0/0 | **true**（#17 時是 null，修訂後 AC-2 的預期行為） |
| unavailable | remote | 有 | skipped/unsupported/unsupported | 0/0/0 | null |
| unavailable | error | 無 | skipped×3 | 0/0/0 | **true**（NICE TO HAVE 2） |
| unavailable | error | 有 | skipped/error/error | 0/0/0 | null |
| error | 任何 | 任何 | orphan 都是 error，checkpoint 兩項照封存判定 | null/null/null | null |

null 與 0 的規則在所有組合下都一致：
- 檢索資料庫 `ok` 時有計數；orphan 只在 `checked` 或 `skipped` 時有數字。
- `unavailable` 時計數全是 0。
- `error` 時計數全是 `null`。

`ok=false` 只在查到問題時出現；沒有查到問題時，只要有一項是 `unsupported` 或 `error` 就是 `null`。

**修訂後的 AC-2 與 #17**：#17 的問題是「沒檢查卻回 true」，因為可能有觀察而封存讀不到。沒有 `memory.db` 時沒有任何觀察，orphan 檢查不需要封存也可以判定通過，所以 `ok=true` 和 #17 AC-4「前提不存在的檢查視為通過」是同一個原則。它和 #17 AC-2「不論哪種組合都是 null」的字面說法不同，但那句寫在檢索資料庫一定存在的前提下，而且這次修訂已經由使用者重新核准。`docs/web-console-reference.md` 也已經更正了原本「遠端模式一律 null」的說法，判定為不矛盾，只有 NICE TO HAVE 2 的措辭問題。

**運作資料庫只有部分查詢失敗時整區塊標 error**：例如缺 `schedules` 表、但 `messages` 表在。這符合 AC-1「缺少資料表等，該區塊是 status=error」。`moltbot.db` 的 schema 在 `MemoryManager` 啟動時就整組建立，缺表代表 schema 已經損壞；`detail` 也會帶出缺的是哪張表（例如 `no such table: schedules`）。判定合理，比起逐欄回報不同可信度的數字更不容易誤讀。

### 相關失敗面

| 輸入／狀態 | 預期行為 | 現有覆蓋 | 判定 |
|---|---|---|---|
| `memory.db` 或 `moltbot.db` 不是 SQLite、缺表 | 報告照樣產生，該區塊標 error，數字為 null | 單元測試、CLI 實跑 | 通過 |
| 某個 snapshot 的內容產生器 throw | 只有它保留舊內容，其他照常寫入 | AC-3 測試 | 通過 |
| context 目錄無法建立（L-08 的 `EACCES` 或 `ENOTDIR`） | 不 throw，10 個檔案各記一次 | 沒有測試；reviewer 以 harness 實測：不 throw，記 10 筆 | 行為正確，缺測試（SHOULD FIX 1） |
| cwd 被刪掉、沒有 `APP_PROJECT_DIR` | 不 throw 給呼叫端 | 沒有測試；reviewer 實測 HEAD 會 throw，BASE 不會 | 回歸，正式部署不受影響（SHOULD FIX 1） |
| 程序剛啟動就失敗 | 第一次失敗就記 | AC-4 測試的第一輪（該 scope 是第一次出現） | 通過；`startIssueStore` 與 `startErrorAlerter` 都在 `initEventProjector` 及第一次寫入之前註冊（`src/main.ts:194-196`、`:434`） |
| 持續失敗但錯誤訊息改變 | 依 AC-4 不重複記 | 依設計（`Set` 以檔名為 key） | 符合核准；`error-summary.md` 會停在第一則訊息，新的訊息只在 `console.warn` 看得到，屬已接受的取捨 |
| 與 60 秒 dedupe、ErrorAlerter 的互動 | 記一次；告警行為要清楚 | AC-4 測試用 count 總和 | 不會洗版；但預設設定下不會告警（SHOULD FIX 3，`需決策`） |
| `runtime_issue` 經 event-projector 回授 | 不形成迴圈 | 沒有測試；reviewer 實測寫入輪數上限是 3 | 有上限；證據前提寫錯（SHOULD FIX 2） |
| `loadProviderStatus()` 失敗 | 只有 runtime-status 與 provider-status 失敗 | 沒有測試 | 它內部已經 try/catch、回傳預設值，實際上不會 throw。假設真的 throw：`provider` 維持 undefined，provider-status 會再讀一次，兩個檔案各自失敗、各記一次，其他 8 個照常。行為正確 |
| 10 個檔案在成功情況下的內容 | 與重構前逐字相同 | reviewer 以固定時鐘、同一個程序分別載入 BASE 與 HEAD 比對（封存 local 與 remote × 有無 `memoriaStatus`，共 4 組） | 9 個檔案逐字相同；`memory-status.md` 只多出 `Operational Status/Detail`、`Retrieval Status/Detail` 4 行，沒有任何一行被移除或改動 |

### 需求、架構、安全、品質

- **需求**：AC-1～AC-4 全部實作，範圍沒有超出 README 的涉及檔案。函式簽名不變，呼叫端不需要修改。
- **架構**：
  - 報告失敗只寫在報告裡，snapshot 失敗才記 runtime issue，兩層分工和 #17 的決策一致。
  - `collectConsistencyReport()` 改成接收讀取結果，不再自己開檔；同一個連線只開一次。
  - 移除 `getSqliteCounts()` 後沒有殘留的呼叫者。
- **安全**：
  - 沒有新增網路呼叫，也沒有新的寫入路徑。
  - `detail` 帶出本機路徑，但 markdown 的 `## Paths` 本來就列出這些路徑，沒有擴大暴露面。
  - 證據與文件以 `/home/`、帳號名、`/tmp/`、長數字 ID、token 樣式搜尋 diff，沒有命中，符合 L-10。
- **品質**：
  - 依 code-simplify 的標準檢查：snapshot 改成 `[檔名, 產生函式]` 清單，比原本先算 10 個變數再寫 10 次清楚。
  - `getProvider()` 的延遲讀取是為了讓讀取留在各自的 try 裡，成本合理。
  - 重複邏輯只有 `readLocalDb` 與 `readArchive`（NICE TO HAVE 1）。
  - 沒有看到過度設計。
- **呼叫端與消費者**：
  - `GET /api/memory-health`、`memory-health-cli`、`writeContextSnapshots` 是報告僅有的消費者。
  - 前端 `status-service.js` 的 `getMemoryHealth()` 沒有呼叫端；Status 頁只顯示 markdown 原文。
  - `skills/` 沒有解析這份報告的欄位，所以欄位改成可為 null 不影響其他程式。

### 豁免、待確認與限制

- 豁免：README「Gate 豁免紀錄」2026-10-21 不開 PR、改本機審查。本報告依此保存為本機 artifact。
- 待確認：README 沒有待確認事項。SHOULD FIX 3 需要使用者決定。
- 限制：
  - 沒有啟動 Web Console 實測 `/api/memory-health`，依指示不啟動服務，以程式碼推論。
  - 沒有跑 GitNexus：審查只讀不改 symbol；呼叫者以 grep 核對，結果與證據相符。

## 你自己跑過的命令與結果

以下測試與 CLI 都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行，暫存檔都放在 session scratchpad。

| 命令 | 結果 |
|---|---|
| `git rev-parse 0b030f0 HEAD` | `0b030f0f54514fd52e01d9fb7c118088af4f1189`／`6446a2d4c902a8c1e55820c31c874b9f945232d9` |
| `git diff -a 0b030f0 6446a2d \| git patch-id --stable` | `2fe903991c8faafb7bd46b45ac8b5d33d0716750`，一致 |
| `npm run build` | exit 0 |
| `npm run test` | exit 0；`# tests 555`、`# pass 555`、`# fail 0`；`tests/` 下 71 個測試檔；`tests/docker/` 4 個檔案的測試名稱都出現在輸出中 |
| `npm run lint` | exit 0 |
| `git worktree add --detach <scratchpad>/wt-base 0b030f0`，複製 HEAD 的兩個測試檔進去後跑 `npx tsx --test` | memory-health：`# tests 19`、`# fail 6`，與證據相同；context-snapshots：`# tests 4`、`# fail 3`。再換入 HEAD 的 `memory-health.ts`：`# tests 23`、`# fail 2`，與步驟 2 的紅燈相同 |
| 同一個 worktree 換入 HEAD 原始碼後做突變（M1、M4、M5、M6、M9、S1～S4 轉紅；M7、M8 仍綠），每次跑完用 `cp` 還原，最後 `diff -q` 確認與 HEAD 相同 | 見上方各節 |
| `npx tsx harness/compare.mts <BASE 樹> <HEAD 樹> healthy｜remote` | 9 個檔案逐字相同；`memory-status.md` 只多 4 行 |
| `npx tsx harness/reentry.mts <HEAD> one｜all` | `{"writeCalls":2,"maxSyncDepth":2,"snapshotIssueEntries":1}`／`{"writeCalls":3,"maxSyncDepth":2,"snapshotIssueEntries":10,"threw":null}` |
| `npx tsx harness/deleted-cwd.mts <BASE>｜<HEAD>` | BASE 三輪都沒有 throw；HEAD 三輪都 `THREW ENOENT … uv_cwd` |
| `npx tsx harness/matrix.mts <HEAD>` | 上方 18 種組合的矩陣 |
| 在暫存 `DB_DIR` 下 `node dist/tools/memory-health-cli.js --json` 與 markdown，兩種情況（`memory.db` 不是 SQLite、`moltbot.db` 不是 SQLite） | 4 次都是 exit 0；欄位與 README 步驟 3 相同（`ok=null`／`ok=true`） |
| `git worktree remove --force …`、`git worktree prune`、`git status --short` | worktree 已移除；審查前工作區是乾淨的 |

沒有使用 git stash，沒有碰正式部署與 `runtelenexus_*` volume，也沒有任何網路寫入。

## 流程判定
PASS

沒有 MUST FIX。AC-1～AC-4 都有紅綠燈與突變證據，reviewer 也重現過；重要失敗面都已查核。4 項 SHOULD FIX 都不阻擋：
- 兩項是證據裡的推理前提寫錯，其中一項伴隨正式部署走不到的邊界回歸。
- 一項是告警行為，需要使用者決定。
- 一項是證據持久力。

建議合併前一併處理 SHOULD FIX 1，並由使用者回覆 SHOULD FIX 3。
