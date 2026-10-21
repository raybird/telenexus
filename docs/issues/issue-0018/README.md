# Issue 0018 - memory-health 讀不了本機資料庫時 throw，整輪 context snapshot 都不更新 (Small)

GitHub：[#18](https://github.com/raybird/telenexus/issues/18)

## 概述

`collectMemoryHealthReport()`（`src/services/memory-health.ts`）會讀兩個本機資料庫，兩處都沒有錯誤處理。只要其中一個檔案存在但讀不了（損壞、不是 SQLite、缺少資料表），整個函式就會 throw：
- 運作資料庫 `moltbot.db`：在函式本體讀取。
- 檢索資料庫 `memory.db`：在 `getSqliteCounts()` 與 `collectConsistencyReport()` 讀取。

`writeContextSnapshots()`（`src/services/context-snapshots.ts`）在寫任何檔案之前，先算出全部 10 個 snapshot 的內容。其中 `memory-status` 呼叫了上面這個函式，它一 throw，就跳到外層的 `catch`，那一輪 10 個檔案一個都不會更新。`catch` 只有 `console.warn`，`error-summary.md` 和 ErrorAlerter 都看不到。

這個函式每 60 秒，以及每則訊息處理前後都會被呼叫。Web Console 的 `#/status` 直接讀這些檔案，所以整個狀態頁會靜默停在最後一次成功的內容。同一個 throw 也會讓 `npm run memory:health` 與 `GET /api/memory-health` 失敗。

#17 已把封存（Memoria `sessions.db`）讀取失敗改成在報告裡標 `status=error`，不再 throw。本 issue 用同樣的方式處理剩下的兩個本機資料庫，並讓各個 snapshot 互不牽連。

2026-10-20 審查 #17 時已在本機重現：把 `memory.db` 換成內容不是 SQLite 的檔案，`collectMemoryHealthReport()` 會 throw `file is not a database`。

## 涉及檔案

- `src/services/memory-health.ts` - 兩個本機資料庫的讀取改成回報 `status`／`detail`，數字欄位在沒讀到時為 `null`；連帶影響 `estimatedGapRecent24h` 與一致性檢查；markdown 顯示狀態與原因
- `src/services/context-snapshots.ts` - 每個 snapshot 各自計算、各自寫入；由成功轉為失敗時記一次 runtime issue，恢復時印 log
- `tests/memory-health.test.ts`、`tests/context-snapshots.test.ts` - AC-1～AC-4 的測試
- `docs/web-console-reference.md` - `GET /api/memory-health` 與 Status 頁的判讀

## 驗收條件

報告的 `operational` 與 `retrieval` 各自新增 `status` 與 `detail` 兩個欄位：
- `status` 是 `ok`、`unavailable` 或 `error`。
- `detail` 是原因說明，`ok` 時為 `null`。

這兩個欄位的形狀與 #17 的 `archive.status`／`detail` 相同。

1. **AC-1：本機資料庫沒讀到時，報告照樣產生，不冒充 0**
   - 運作資料庫或檢索資料庫的檔案不存在時，該區塊是 `status=unavailable`，`detail` 寫明找不到的路徑。
   - 檔案存在但讀不了時（不是 SQLite 檔、缺少資料表等），該區塊是 `status=error`，`detail` 帶錯誤訊息。
   - 兩種情況下，`collectMemoryHealthReport()` 都不 throw，`GET /api/memory-health` 仍回 200。
   - 該區塊的數字欄位都是 `null`：
     - 運作資料庫：`totalMessages`、`totalSchedules`、`modelResponses24h`；`lastMessageAt` 也是 `null`。
     - 檢索資料庫：`entities`、`observations`、`relations`。
   - markdown 對這些欄位顯示 `unknown`，並列出狀態與原因。
   - 這兩種情況都不記 runtime issue，只寫在報告裡，沿用 #17 對封存的決策。
   - 兩個資料庫都可讀時，既有欄位的值不變。
   - 檢查方式：單元測試對兩個資料庫各做「不存在」與「內容不是 SQLite」兩種情況，確認不 throw、欄位與 markdown 符合上述值；再以編譯後的 `node dist/tools/memory-health-cli.js --json` 在暫存 `DB_DIR` 下實跑。
2. **AC-2：連帶的推導值跟著變成未知**
   - 運作資料庫不是 `ok` 時，`archive.estimatedGapRecent24h` 是 `null`，因為它由運作資料庫的 24 小時回應數算出。
   - 檢索資料庫是 `error` 時：
     - orphan 檢查標 `error`。
     - `orphanSourceSessionObservations`、`sourceSessionTaggedObservations`、`observationsMissingSourceSession` 是 `null`。
     - 沒有查到其他問題時，`consistency.ok` 是 `null`。
   - 檢索資料庫是 `unavailable`（檔案不存在）時：
     - 沒有觀察就沒有可查的對象，orphan 檢查標 `skipped`，視為通過，與 #17 AC-4「前提不存在的檢查視為通過」相同。
     - 三個一致性計數是 0。
     - 其他檢查都通過時，`consistency.ok` 可以是 `true`。
     - 現在的程式不會建立 `memory.db` 的資料表，只有 `memory:backfill --write` 會寫入已存在的檔案，所以新部署本來就沒有這個檔案。
   - checkpoint 的兩項檢查不讀檢索資料庫，判定不變。
   - markdown 對這些欄位顯示 `unknown`。
   - 檢查方式：單元測試在檢索資料庫不存在與讀不了兩種情況下，各放一份可讀的本機封存與 checkpoint，確認上述欄位，包括「不存在」時 `consistency.ok=true`；在運作資料庫讀不了而封存可讀時，確認 `estimatedGapRecent24h=null`。
3. **AC-3：各個 snapshot 互不牽連**
   - `writeContextSnapshots()` 的 10 個 snapshot 各自計算、各自寫入。
   - 任何一個在計算或寫入時 throw，其餘照常更新，失敗的那個保留上一次的內容。
   - 失敗的不只 memory-status，任何一個都一樣；例如 `formatMemoriaStatusMarkdown` throw 時，`memory-status.md` 等其他檔案照常寫入。
   - 檢查方式：單元測試讓其中一個 snapshot 的內容產生器 throw，確認其他檔案都更新、失敗的檔案內容不變；另以 AC-1 的「檢索資料庫不是 SQLite」情況確認 `memory-status.md` 照常更新並標 `error`。
4. **AC-4：snapshot 開始失敗時記一次 runtime issue**
   - 某個 snapshot 由成功（或程序啟動後第一次執行）轉為失敗時，以 `recordRuntimeIssue('context-snapshot:<檔名>', err)` 記一次，`<檔名>` 例如 `memory-status`。
   - 同一個 snapshot 持續失敗時不重複記。
   - 恢復成功時印一行 log；之後再失敗會再記一次。
   - 失敗狀態只存在記憶體中，程序重啟後第一次失敗會再記一次。
   - `console.warn` 照舊保留。
   - 檢查方式：單元測試對同一個 snapshot 連續三輪失敗、一輪成功、再一輪失敗，確認 runtime issue 只記兩次，恢復那一輪印出 log。

- **核准日期**: 2026-10-21
- **核准來源**: 使用者 2026-10-21 對話的逐題確認。
  - Q1「修正範圍」選「兩者都做（建議）」（AC-1、AC-3）。內容是：報告標成讀取失敗，snapshot 也逐一隔離。
  - Q2「snapshot 失敗時要怎麼讓人看得到」選「開始失敗時記一次（建議）」（AC-4）。內容是：由成功轉為失敗時記一次 runtime issue，scope 例如 `context-snapshot:memory-status`；持續失敗不重複記，恢復時印一行 log。
  - Q3「本機資料庫的檔案不存在時怎麼呈現」選「標 unavailable，數字 null（建議）」（AC-1）。
  - 之後以一則總結確認推導出的行為 (a)～(f)，使用者選「全部照寫核准（建議）」：
    - (a) `operational`／`retrieval` 的 `status`／`detail` 與 `null`（AC-1）；
    - (b) `estimatedGapRecent24h` 跟著變成 `null`（AC-2）；
    - (c) 檢索資料庫沒讀到時，orphan 檢查與相關計數是未知（AC-2）；
    - (d) 報告本身不記 runtime issue（AC-1）；
    - (e) snapshot 互不牽連，scope 為 `context-snapshot:<檔名>`，狀態只存在記憶體（AC-3、AC-4）。Q2 選項「每次失敗都記」的說明寫成「等於每 30 分鐘告警一次」，實作時查到這高估了：`recordRuntimeIssue()` 會把 60 秒內 scope 與訊息都相同的紀錄合併，合併的不觸發告警 hook。但這只在錯誤訊息每次都相同、間隔小於 60 秒時才成立，「開始失敗時記一次」不依賴這兩個條件，所以選擇不變；
    - (f) API 仍回 200（AC-1）。
- **規格修訂（2026-10-21，實作前）**：
  - 原因：Q3 的建議說明寫「服務啟動就會建立這兩個檔案」。這對 `moltbot.db` 成立，`MemoryManager` 啟動時會建表；對 `memory.db` 不成立，現在的程式不會建立它的資料表。照原核准，新部署的一致性會永遠是未知。
  - 處理：更正後重問，使用者選「標 unavailable，一致性視為沒有可查的（建議）」。內容是：`memory.db` 不存在時 `retrieval.status=unavailable`、計數為 `null`，orphan 檢查標 `skipped`、三個一致性計數為 0、`consistency.ok` 可以是 `true`。
  - 影響：AC-2 依此修訂並重新核准；讀不了（`error`）的情況與 `moltbot.db` 的部分維持原核准。

## 風險與首要驗證

**風險**: Low — 改動限於報告的組裝，以及 snapshot 的寫入迴圈；`writeContextSnapshots()` 的簽名不變，回復容易。JSON 的數字欄位改成可為 `null`、新增狀態欄位，形狀變化與 #17 相同，目前沒有程式解析這份報告。GitNexus 對 `collectMemoryHealthReport` 判定 LOW（直接呼叫者：`writeContextSnapshots`、Web Console、CLI）。它對 `writeContextSnapshots` 回報 0 個呼叫者，屬於已知的低報；以 `grep` 核對，實際呼叫點是 `src/main.ts:183`，再由 message pipeline 透過 options 呼叫。依一般相依順序實作與驗證。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|---|---|---|---|
| D-1 | snapshot 失敗要不要推 Telegram 告警（審查 [review-6446a2d.md](review-6446a2d.md) SHOULD FIX 3，`需決策`）。照 AC-4，每個 snapshot 每次轉為失敗只記 1 筆，達不到 ErrorAlerter 的門檻（預設 10 分鐘 3 次），所以預設不會告警 | 已決定（2026-10-21）：使用者選「接受，文件寫明」。行為不變，`docs/web-console-reference.md` 寫明不會告警，以及看得到失敗的地方 | 不改 AC-4，不是規格修訂 |

## 實作與驗證步驟

1. ✅ **AC-1、AC-2：本機資料庫的狀態與推導值**
   - 驗證方式：先在 `tests/memory-health.test.ts` 寫 AC-1、AC-2 的測試，確認失敗；再修改 `src/services/memory-health.ts` 讓它們通過；既有測試維持通過。改 symbol 前跑 `gitnexus_impact`，並以 `grep` 核對呼叫者。
   - 完成判準：AC-1、AC-2 的每個檢查方式都有紅燈與綠燈紀錄，並以至少一個突變確認測試擋得住。
   - 相依：無。驗收條件已於 2026-10-21 核准。
   - 完成證據：[evidence/step1-red-green.md](evidence/step1-red-green.md)。紅燈 6 個失敗，其中 3 個是 throw；綠燈 `# tests 19`、`# pass 19`；3 個突變都轉紅。
2. ✅ **AC-3、AC-4：snapshot 隔離與失敗訊號**
   - 驗證方式：先在 `tests/context-snapshots.test.ts` 寫 AC-3、AC-4 的測試，確認失敗；再修改 `src/services/context-snapshots.ts`。
   - 完成判準：AC-3、AC-4 有紅燈與綠燈紀錄；以突變確認「持續失敗不重複記」與「其他檔案照常寫入」都會被測試擋下。
   - 相依：步驟 1，AC-3 的第二項檢查用到步驟 1 的行為。
   - 完成證據：[evidence/step2-red-green.md](evidence/step2-red-green.md)。紅燈 2 個失敗；換回舊的 `memory-health.ts` 時 3 個新測試全失敗；綠燈 `# tests 4`、`# pass 4`；3 個突變都轉紅。
3. ✅ **AC-1：編譯後的 CLI 實跑與交付檢查**
   - 驗證方式：
     - `npm run build` 後，在暫存 `DB_DIR` 下，分別讓 `memory.db`、`moltbot.db` 不是 SQLite 檔，執行 `node dist/tools/memory-health-cli.js --json` 與 markdown 輸出。
     - 更新 `docs/web-console-reference.md`。
     - 執行 `npm run build`、`npm run test` 與 `npm run lint`。`npm run test` 要核對 `# tests` 數與測試檔數相稱。
   - 完成判準：
     - CLI 每次執行都是 exit 0，欄位與 AC-1 相符。
     - build、test、lint 都通過，`tests/docker/` 的測試有出現在輸出中（地雷 L-01）。
   - 相依：步驟 1、2。
   - 完成證據：2026-10-21 在步驟 1、2 完成後的工作區執行。
     - CLI：在暫存 `DB_DIR` 下跑兩種情況，`--json` 與 markdown 都是 exit 0。
       - `memory.db` 不是 SQLite、沒有 `moltbot.db`：`operational=unavailable`、`retrieval=error`（`file is not a database`），數字是 `null`，`estimatedGapRecent24h=null`，orphan 是 `error`，`consistency.ok=null`。markdown 顯示 `Retrieval Status: error`、`Retrieval Entities: unknown`、`Consistency OK: unknown`。
       - `moltbot.db` 不是 SQLite、沒有 `memory.db`：`operational=error`、`retrieval=unavailable`，orphan 是 `skipped`，`consistency.ok=true`。這時封存是遠端模式，也沒有 checkpoint，所以沒有可查的對象，與修訂後的 AC-2 相符；#17 時同樣情況是 `null`。
     - 文件：`docs/web-console-reference.md` 補上 `operational`／`retrieval` 的狀態判讀與 snapshot 的失敗訊號；並更正原本「遠端模式下 `consistency.ok` 一律是 `null`」的說法。
     - 交付檢查：`npm run build` exit 0；`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0，`# tests 555`、`# pass 555`、`# fail 0`，比 #15 結束時的 546 多 9 個，就是本 issue 新增的測試數；`tests/` 下 71 個測試檔，`tests/docker/` 的 4 個檔案都出現在輸出中（地雷 L-01）；`npm run lint` exit 0。
4. ✅ **審查後續：[review-6446a2d.md](review-6446a2d.md)**
   - 產出：`src/services/context-snapshots.ts`、`tests/context-snapshots.test.ts`、`tests/memory-health.test.ts`、`docs/web-console-reference.md`、本 issue 的證據。
   - 驗收：AC-1、AC-3、AC-4。
   - 相依：步驟 1～3。
   - 完成證據：[evidence/step4-review-followup.md](evidence/step4-review-followup.md)。SHOULD FIX 1、2、4 已修正並補測試；SHOULD FIX 3 依 D-1 只改文件。補上的測試在修正前是紅燈，4 個突變都轉紅。

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-21 | 不開 PR；改由獨立 subagent 在本機審查 `main..HEAD`，合併由使用者決定 | 交付方式選「分支＋本機審查（建議）」 | 沒有 GitHub 上的 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-21 | 建立；逐題確認 Q1～Q3 與推導行為 | - |
| 2026-10-21 | AC-1～AC-4 核准；記錄不開 PR 的 Gate 豁免 | 使用者 |
| 2026-10-21 | 規格修訂：`memory.db` 不存在時 orphan 檢查標 `skipped`（Q3 前提更正後重問，AC-2） | 使用者 |
| 2026-10-21 | 本機獨立審查 review-6446a2d：PASS，有 4 項 SHOULD FIX | reviewer |
| 2026-10-21 | D-1：snapshot 失敗不推 Telegram，只在文件寫明（審查 SHOULD FIX 3） | 使用者 |
| 2026-10-21 | 審查後續：SHOULD FIX 1、2、4 修正，NICE TO HAVE 2 修正 | - |

---
**建立日期**: 2026-10-21  
**分級**: Small  
**風險**: Low\
**狀態**: 進行中
