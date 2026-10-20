# Issue 0016 - MemoryBackfillWorker 讀不到封存時誤報「沒有新資料」：回填來源狀態誠實化 (Small)

GitHub：[#16](https://github.com/raybird/telenexus/issues/16)

## 概述

官方 Compose 把 Memoria 拆成獨立的 HTTP 服務後，telenexus 讀不到它的 `sessions.db`。`MemoryBackfillWorker`（`src/services/memory-backfill-worker.ts`）的 `defaultHasPendingArchiveSessions()` 遇到封存檔不存在就回 `false`，`runOnce()` 把所有 `false` 都記成 `skipped. no new archive sessions.`。所以「遠端模式根本讀不到」、「設定的路徑找不到」、「封存是空的」、「真的沒有新資料」都印成同一行。GitHub #16 的部署（2026-10-19，v2.30.1）開了回填，worker 每 5 分鐘就誤報一次沒有新資料，而 Memoria 實際有 2,522 個 session。

健康報告的 backfill 區塊只顯示 checkpoint 裡最後一次執行的紀錄。那台部署的紀錄停在 2026-05-31，看起來像回填正常地停著，看不出 worker 其實每輪都被擋下。

手動執行 `memory:backfill` 時，遠端模式報 `sessions.db not found: <sentinel 路徑>`，看不出這是不支援遠端，而不是檔案遺失。

**範圍**：GitHub #16 有兩部分，本 issue 只處理第一部分：把狀態誠實呈現，沿用 #17 的封存 `source`／`status` 判定。第二部分是要支援遠端回填，還是正式標成不支援，仍待決定，見 TBD-1；所以本 issue 合併後 GitHub #16 仍維持開啟。何時執行回填的判斷不變；dry-run 預設不變。

## 涉及檔案

- `src/services/memory-health.ts` - 新增回填來源的共用判定；健康報告的 backfill 區塊與 markdown 加上來源狀態與原因
- `src/services/memory-backfill-worker.ts` - 依判定結果決定是否執行並印出實際原因；啟動訊息加上來源
- `src/services/memory-backfill.ts` - 遠端模式與路徑不存在時，錯誤訊息改用判定的原因
- `tests/memory-health.test.ts`、`tests/memory-backfill-worker.test.ts`、`tests/memory-backfill.test.ts` - AC-1～AC-4 的測試
- `docs/web-console-reference.md`、`docs/configuration-reference.md` - 健康報告新欄位與 worker 訊息的判讀

## 驗收條件

1. **AC-1：回填來源的共用判定**：同一個函式依封存與 checkpoint 判定回填來源的狀態，共六種：
   - `remote-unsupported`：遠端模式，也就是 #17 的 `archive.source=remote`。
   - `unavailable`：有設定 `MEMORIA_ARCHIVE_DB` 或 `MEMORIA_HOME`，但檔案不存在。
   - `error`：封存存在但讀不了。
   - `empty`：封存可讀，但沒有任何 session。
   - `up-to-date`：沒有比 checkpoint 處理時間更新的 session。
   - `pending`：有比 checkpoint 處理時間更新的 session，或 checkpoint 沒有處理時間。

   每種狀態都附原因說明。「有沒有新資料」的比較方式和現在一樣：封存最新的 `timestamp` 原樣與 checkpoint 的 `lastProcessedTimestamp` 做字串比較。 — 檢查方式：單元測試涵蓋六種狀態，並以和舊判定相同的資料比對 `pending`／`up-to-date` 結果。
2. **AC-2：worker 依判定執行並印出實際原因**：只有 `pending` 時才執行回填，和現在一樣。`remote-unsupported`、`unavailable`、`empty`、`up-to-date` 各印各的原因，`no new archive sessions` 只用在 `up-to-date`。`error` 和現在讀取失敗時一樣：記 `memory-backfill:worker` runtime issue，並呼叫 `onAfterRun`。每輪都印，頻率不變。啟動訊息加上封存來源（`local`／`remote`）。 — 檢查方式：單元測試注入各種判定結果，確認回填是否執行、印出的訊息、runtime issue 與 `onAfterRun`；另用預設判定，在遠端模式下確認不會印出 `no new archive sessions`。
3. **AC-3：健康報告顯示回填來源狀態**：健康報告（CLI、`GET /api/memory-health`、`memory-status.md`）的 backfill 區塊新增來源狀態與原因，由 AC-1 的同一個函式判定；markdown 也一起列出。不論回填有沒有啟用都會顯示。 — 檢查方式：單元測試在遠端模式與本機有待處理 session 兩種情況下比對 JSON 與 markdown；編譯後以 `node dist/tools/memory-health-cli.js` 在遠端模式實跑。
4. **AC-4：CLI 錯誤訊息說明實際原因**：`memory:backfill` 遇到 `remote-unsupported` 或 `unavailable` 時，錯誤訊息改成判定的原因，不再只寫 `sessions.db not found: <路徑>`；仍然失敗退出。是否記錄 runtime issue、是否寫入 checkpoint、其他狀態的行為都不變。 — 檢查方式：單元測試在兩種情況下確認 `runMemoryBackfill()` throw 的訊息；編譯後以 `node dist/tools/memory-backfill-cli.js once --json` 在遠端模式實跑，確認 exit code 不是 0，且訊息說明是遠端模式。

- **核准日期**: 2026-10-20
- **核准來源**: 使用者 2026-10-20 對話的逐題確認。Q1「回填來源的狀態要在哪裡看得到」選「log＋健康報告（建議）」（AC-2、AC-3）。Q2「封存讀取失敗時，worker 要不要繼續記 runtime issue」選「維持記錄（建議）」（AC-2）。Q3「遠端模式下 log 要怎麼印」選「每次都印（建議）」（AC-2）。Q4「`memory:backfill` CLI 的遠端錯誤訊息要不要一併改」選「一併改（建議）」（AC-4）。之後以一則總結確認推導出的六種狀態與 AC-1～AC-4，使用者選「全部照寫核准（建議）」。

## 風險與首要驗證

**風險**: Low — 何時執行回填的判斷不變，改動是訊息、報告欄位與錯誤文字；健康報告的 JSON 只新增欄位。最需要守住的是 `pending`／`up-to-date` 的判定與舊版等價，否則會讓 worker 多跑或少跑，所以 AC-1 的等價測試先寫。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|---|---|---|---|
| TBD-1 | GitHub #16 第二部分：要支援遠端回填（可分頁、可 checkpoint 的 API 或匯出），還是把遠端模式正式標成不支援 | 不影響本次交付 | 本 issue 只讓狀態誠實呈現。2026-10-20 排定的順序是在 #15 遷移工具之後處理。追蹤：GitHub [#16](https://github.com/raybird/telenexus/issues/16) 維持開啟。 |

## 實作與驗證步驟

1. ✅ **AC-1～AC-4：共用判定、worker、健康報告與 CLI 訊息** — 驗證方式：先寫 AC-1～AC-4 的測試並確認失敗，AC-1 的等價測試優先；再最小實作讓它們通過，既有測試維持通過。改 symbol 前跑 `gitnexus_impact`，並以 `grep` 核對呼叫者。
   - 完成證據：[evidence/step1-red-green.md](evidence/step1-red-green.md)——紅燈 7 個失敗；10 個等價測試在舊程式上全過，作為基準；最小實作後 `# tests 36`、`# pass 36`；把 `>` 突變成 `>=` 時兩個等價案例轉紅。
   - 相依：無（驗收條件已於 2026-10-20 核准）。
2. ✅ **AC-3、AC-4：編譯後的 CLI 實跑** — 驗證方式：`npm run build` 後，在暫存 `DB_DIR`、遠端模式（不設定封存變數）下執行 `node dist/tools/memory-health-cli.js`（JSON 與 markdown）與 `node dist/tools/memory-backfill-cli.js once --json`。
   - 完成證據：[evidence/step2-cli.md](evidence/step2-cli.md)——健康報告兩種格式都顯示 `remote-unsupported` 與原因；`memory:backfill` exit 1，訊息說明是遠端模式，暫存目錄沒有寫出 checkpoint。worker 需要完整服務才會啟動，沒有實跑，由步驟 1 的單元測試涵蓋。
   - 相依：步驟 1。
3. ✅ **文件與交付檢查** — 更新 `docs/web-console-reference.md` 與 `docs/configuration-reference.md`；執行 `npm run build`、`npm run test`（核對 `# tests` 數與測試檔數相稱）、`npm run lint`。
   - 完成證據：2026-10-20 在步驟 1、2 完成後的工作區執行。`docs/web-console-reference.md` 補上 `backfill.sourceState`／`sourceDetail` 的判讀，並說明 `lastRunStatus` 等欄位只記實際執行；`docs/configuration-reference.md` 補上遠端模式與 worker 各狀態的訊息。`npm run build` exit 0；`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0，`# tests 516`、`# pass 516`、`# fail 0`，比 issue 0017 結束時的 499 多 17 個，就是本 issue 新增的測試數；`tests/` 下 70 個測試檔，`tests/docker/` 的測試有出現在輸出中（地雷 L-01）；`npm run lint` exit 0。
   - 相依：步驟 1、2。
4. ✅ **審查後續：SHOULD FIX 1、2** — 驗證方式：補「session 沒有時間」的等價案例與「checkpoint 格式異常時 `start()` 不 throw」的測試，先在舊程式與 `4b088e1` 上確認結果，再修正；補記審查找到的已知差異；一併處理審查 NICE TO HAVE 2、3、4。之後重跑 `npm run build`、`npm run test`、`npm run lint` 並重新審查。
   - 完成證據：[evidence/step4-review-followup.md](evidence/step4-review-followup.md)——新等價案例在舊程式上通過、在 `4b088e1` 上失敗；`start()` 測試在 `4b088e1` 上失敗，突變後也轉紅。修正後 `npm run build` exit 0；`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0，`# tests 518`、`# pass 518`、`# fail 0`，比步驟 3 多 2 個，`tests/` 下 70 個測試檔，`tests/docker/` 有跑到；`npm run lint` exit 0。
   - 相依：步驟 1～3；[review-4b088e1.md](review-4b088e1.md)。
5. ✅ **第二輪審查後續：註解位置** — [review-38716b0.md](review-38716b0.md) SHOULD FIX 1：`archiveSourceOf()`、`currentArchiveSource()` 插在 `readArchive()` 的 JSDoc 與函式之間，「不 throw、不記 runtime issue」的理由（issue 0017 AC-5）掛錯了函式。把兩個函式移到 JSDoc 之前，只搬位置，程式不變，不需要新的紅綠燈證據。NICE（等價案例再加一列 NULL）不處理：fixture 的 `timestamp` 是 `NOT NULL`，NULL 與空字串走同一條路徑，審查的 probe 已確認 NULL 新舊一致。
   - 完成證據：2026-10-20 執行。`git diff` 只有 `src/services/memory-health.ts` 的 5 行搬移；`npx prettier --check` 通過；`npm run build` exit 0；`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0，`# tests 518`、`# pass 518`、`# fail 0`；`npm run lint` exit 0。
   - 相依：步驟 4；[review-38716b0.md](review-38716b0.md)。

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-20 | 不開 PR；改由獨立 subagent 在本機審查 `main..HEAD`，合併由使用者決定 | 交付方式選「分支＋本機審查（建議）」 | 沒有 GitHub 上的 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-20 | 建立；範圍限 GitHub #16 第一部分（狀態誠實化），第二部分記為 TBD-1 | - |
| 2026-10-20 | AC-1～AC-4 核准；記錄不開 PR 的 Gate 豁免 | 使用者 |
| 2026-10-20 | 獨立審查 `4b088e1`：PASS，SHOULD FIX 2 項（[review-4b088e1.md](review-4b088e1.md)） | 獨立 subagent |
| 2026-10-20 | 處理 SHOULD FIX 1、2，不涉及規格修訂 | - |
| 2026-10-20 | 獨立重新審查 `38716b0`：PASS，SHOULD FIX 1 項（[review-38716b0.md](review-38716b0.md)）；已處理（步驟 5） | 獨立 subagent |

---

**狀態**: 進行中（審查後續已處理，待重新審查）
