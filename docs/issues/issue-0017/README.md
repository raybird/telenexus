# Issue 0017 - memory-health 在遠端模式把未讀取的封存報成零筆，一致性沒檢查卻回報正常 (Small)

GitHub：[#17](https://github.com/raybird/telenexus/issues/17)

## 概述

官方 Compose 把 Memoria 拆成獨立的 HTTP 服務後，telenexus 讀不到它的 `sessions.db`。`resolveMemoriaSessionsDbPath()`（`src/utils/paths.ts`）在沒有設定 `MEMORIA_ARCHIVE_DB` 或 `MEMORIA_HOME` 時，會回傳一個不存在的 sentinel 路徑。`collectMemoryHealthReport()`（`src/services/memory-health.ts`）遇到檔案不存在就保留初始值 0，一致性檢查又只在 `archiveSessionIds.size > 0` 時才執行，所以「沒讀取」和「讀了、資料正常」看起來一模一樣。

2026-10-20 在本機的正式部署（v2.30.1，遠端模式）重現：

| 欄位 | 報告值 | 實際 |
|---|---|---|
| `archive.totalSessions` | 0 | Memoria `/v1/stats` 為 1,956 |
| `archive.estimatedGapRecent24h` | 17 | 是近 24h 的 17 則模型回應減去讀不到的 0，屬於假缺口 |
| `consistency.ok` | true | orphan 與 checkpoint 兩項都沒有檢查 |

本機封存是空資料庫時，同一個 `size > 0` 條件也會跳過檢查，空封存裡的無效引用永遠不會被發現。

報告由同一個函式產生，出現在三個地方：`npm run memory:health`（CLI）、`GET /api/memory-health` 和 `workspace/context/memory-status.md`（Web Console 的 Status 頁直接顯示這份檔案）。

**與 GitHub #17 驗收條件的差異**：#17 寫的是「遠端模式從 API 取得可支援的統計」。使用者 2026-10-20 選擇遠端模式只標 unavailable、不呼叫 Memoria API（Q1），所以本 issue 不新增任何網路呼叫。#17 的其餘條件（區分來源、未知值不冒充 0、一致性區分已檢查與未檢查、空封存仍要檢查、指標在資料不足時標示不可判定）都在範圍內。

## 涉及檔案

- `src/services/memory-health.ts` - 判定封存來源與讀取狀態；未知值改為 `null`；一致性改成逐項狀態；markdown 顯示來源、狀態與 unknown
- `tests/memory-health.test.ts` - AC-1～AC-5 的單元測試
- `docs/web-console-reference.md` - `GET /api/memory-health` 與 Status 頁的說明補上來源、狀態與 unknown 的判讀

## 驗收條件

報告新增 `archive.source`（`local`／`remote`）、`archive.status`（`ok`／`unavailable`／`error`）與 `archive.detail`（原因說明，正常時為 `null`），以及每項一致性檢查的狀態（`checked`／`skipped`／`unsupported`／`error`）。

1. **AC-1：遠端模式不冒充 0**：沒有設定 `MEMORIA_ARCHIVE_DB` 與 `MEMORIA_HOME`，而且預設的本機封存路徑不存在時，報告是 `archive.source=remote`、`archive.status=unavailable`。`totalSessions`、`totalEvents`、`sessions24h`、`lastSessionAt`、`estimatedGapRecent24h` 都是 `null`，而且不發出任何網路請求。有設定這兩個變數之一但檔案不存在時，報告是 `source=local`、`status=unavailable`，`detail` 寫明找不到設定的路徑，數字欄位同樣是 `null`。markdown 對這些欄位顯示 `unknown`，並列出來源、狀態與原因。 — 檢查方式：單元測試分別在「兩個變數都沒設」與「設定的路徑不存在」下產生報告，比對上述欄位與 markdown；再用編譯後的 `node dist/tools/memory-health-cli.js --json` 在空的暫存 `DB_DIR` 下各跑一次。
2. **AC-2：遠端模式的一致性是未知，不是正常**：封存狀態不是 `ok` 時，orphan 檢查標 `unsupported`，`orphanSourceSessionObservations` 是 `null`；checkpoint session 檢查與 checkpoint 超前檢查在 checkpoint 有對應欄位時標 `unsupported`，對應的 `checkpointSessionMissing`、`checkpointAheadOfArchive` 是 `null`，沒有對應欄位時依 AC-4 標 `skipped`（值為 `false`）。讀取失敗時以 `error` 取代 `unsupported`（見 AC-5）。不論哪種組合，`consistency.ok` 都是 `null`。只依賴本機檢索資料庫的 `sourceSessionTaggedObservations` 與 `observationsMissingSourceSession` 照常計算。markdown 的 `Consistency OK` 顯示 `unknown`。 — 檢查方式：單元測試在遠端模式下放一筆帶 `source_session` 標記的觀察與一份 checkpoint，確認三項狀態、`null` 欄位與 `ok=null`；另在遠端模式、沒有 checkpoint（官方 Compose 的預設）下確認 orphan 為 `unsupported`、兩項 checkpoint 為 `skipped`、`ok=null`。
3. **AC-3：空的本機封存照樣檢查**：本機封存可讀（`status=ok`）時，三項檢查都會執行，封存裡沒有任何 session 也一樣。空封存加上一筆帶 `source_session` 的觀察，orphan 計 1；checkpoint 指向的 session 不存在時，`checkpointSessionMissing=true`；checkpoint 有處理時間而封存沒有任何 session 時，`checkpointAheadOfArchive=true`。任一項查到問題時 `consistency.ok=false`。非空封存的既有判定結果不變。 — 檢查方式：新增空封存的單元測試；既有的 `reports cross-db consistency drift` 與 LIKE 預篩等價測試維持通過。
4. **AC-4：前提不存在的檢查視為通過**：沒有 checkpoint，或 checkpoint 沒有 session ID／處理時間時，對應的 checkpoint 檢查標 `skipped`，不影響判定。所有檢查都是 `checked` 或 `skipped` 且沒有查到問題時，`consistency.ok=true`；有任何一項是 `unsupported` 或 `error` 且沒有查到問題時，`consistency.ok=null`。 — 檢查方式：單元測試在本機封存可讀、沒有 checkpoint 的情況下確認 `ok=true` 與兩項 `skipped`。
5. **AC-5：封存讀取失敗不會讓報告中斷**：本機封存存在但無法讀取時（不是 SQLite 檔、缺少 `sessions` 表等），報告仍然產生：`archive.status=error`，`detail` 帶錯誤訊息，數字欄位為 `null`，依賴封存的檢查標 `error`，`consistency.ok=null`。這種情況不記 runtime issue，只寫在報告裡。 — 檢查方式：單元測試把封存路徑指向一個內容不是 SQLite 的檔案，確認 `collectMemoryHealthReport()` 不 throw，且欄位符合上述值。

- **核准日期**: 2026-10-20
- **核准來源**: 使用者 2026-10-20 對話的逐題確認。Q1「遠端模式下，archive 統計要怎麼取得」選「只標 unavailable」，內容是「遠端模式完全不打 API，所有 archive 數字都是 null」（AC-1、AC-2）。Q2「無法取得的數字在 JSON 裡要怎麼呈現」選建議答案「null 加來源與狀態欄位」，內容是「數字欄位改成 number|null，另外新增 archive.source 與 archive.status」（AC-1、AC-5）。Q3「一致性檢查沒有完整執行時，consistency.ok 要回什麼」選建議答案「ok=null＋逐項狀態」（AC-2、AC-4）。Q4（遠端失敗要不要記 runtime issue）因 Q1 不打 API 而不再適用。之後以一則總結確認推導出的行為：(a) 設定的封存路徑不存在時為 `source=local`、`status=unavailable` 並在 `detail` 寫明（AC-1）；(b) 空封存而 checkpoint 有處理時間時判定超前（AC-3）；(c) 沒有 checkpoint 時兩項 checkpoint 檢查標 `skipped` 並視為通過（AC-4）；(d) 封存讀不了時報告照樣產生、標 `error`、不記 runtime issue（AC-5）。使用者選「全部照寫核准」。
- **規格修訂（2026-10-20）**：獨立審查（[review-4451564.md](review-4451564.md) SHOULD FIX 1，`需決策`）指出 AC-2 與 AC-4 在「遠端模式＋沒有 checkpoint」時字面衝突。使用者選「維持 skipped，補紀錄與測試」，內容是「把 AC-2 文字修成『有 checkpoint 時才標 unsupported』，補一個『遠端＋沒有 checkpoint』的單元測試」。AC-2 依此修訂並重新核准；實作行為不變。

## 風險與首要驗證

**風險**: Low — 不新增網路呼叫，改動限於報告的組裝與判定，回復容易。JSON 的數字欄位改成可為 `null`，目前沒有程式解析這份報告（`src/web/public` 的 `getMemoryHealth()` 沒有呼叫端，`skills/` 也沒有讀取），依一般相依順序實作與驗證。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|---|---|---|---|
| TBD-1 | 遠端模式要不要透過 Memoria `GET /v1/stats` 取得總數與最後時間 | 不影響本次交付 | 2026-10-20 結論：使用者 Q1 選擇只標 unavailable。追蹤：無——要看遠端實際筆數，可直接查 Memoria 的 `/v1/stats`；之後若要在報告裡呈現，另開 issue。 |
| TBD-2 | 檢索資料庫 `memory.db` 損壞時 `collectMemoryHealthReport()` 仍會 throw，該輪 context snapshot 整批寫不出來（審查 NICE TO HAVE 5，既有行為） | 待確認 | 不影響 AC-1～AC-5（AC-5 只涵蓋封存）。等待使用者決定是否另開 GitHub issue。 |

## 實作與驗證步驟

1. ✅ **AC-1～AC-5：報告的來源、狀態與一致性判定** — 驗證方式：先在 `tests/memory-health.test.ts` 寫 AC-1～AC-5 的測試並確認失敗，再修改 `src/services/memory-health.ts` 讓它們通過；既有測試維持通過。改 symbol 前跑 `gitnexus_impact` 並以 `grep` 核對呼叫者。
   - 完成證據：[evidence/step1-red-green.md](evidence/step1-red-green.md)——紅燈 7 個失敗（含 AC-5 的兩次 throw），另用 probe 在舊程式上印出遠端與空封存都是 `ok=true`；最小實作與重構後都是 `# tests 9`、`# pass 9`。
   - 相依：無（驗收條件已於 2026-10-20 核准）。
2. ✅ **AC-1：編譯後的 CLI 實跑** — 驗證方式：`npm run build` 後，在暫存 `DB_DIR` 下分別以「不設定封存變數」與「`MEMORIA_ARCHIVE_DB` 指向不存在的檔案」執行 `node dist/tools/memory-health-cli.js --json` 與不帶 `--json` 的 markdown 輸出。
   - 完成證據：[evidence/step2-cli.md](evidence/step2-cli.md)——四次執行都是 exit 0；遠端為 `remote`／`unavailable`，設定的路徑不存在為 `local`／`unavailable`，數字欄位都是 `null`（markdown 為 `unknown`），`consistency.ok=null`。
   - 相依：步驟 1。
3. ✅ **文件與交付檢查** — 更新 `docs/web-console-reference.md`；依序執行 `npm run build`、`npm run test`（核對 `# tests` 數與測試檔數相稱）、`npm run lint`。
   - 完成證據：2026-10-20 在步驟 1、2 完成後的工作區執行。`docs/web-console-reference.md` 補上 `archive.source`／`status`／`detail` 與 `consistency.checks`／`ok` 的判讀。`npm run build` exit 0；`npm run test` exit 0，`# tests 497`、`# pass 497`、`# fail 0`，`tests/` 下 70 個測試檔，巢狀目錄（如 `tests/docker/`）的測試有出現在輸出中（地雷 L-01）；`npm run lint` exit 0。
   - 相依：步驟 1、2。
4. ✅ **審查後續：AC-2 規格修訂與 SHOULD FIX** — 驗證方式：補「遠端模式＋沒有 checkpoint」的單元測試，並以突變確認它擋得住 AC-2 字面解讀的回歸；在步驟 1 證據補上 GitNexus impact 與 grep 的結果；一併處理審查 NICE TO HAVE 1、3、6、7。之後重跑 `npm run build`、`npm run test`、`npm run lint` 並重新審查。
   - 完成證據：[evidence/step4-review-followup.md](evidence/step4-review-followup.md)——突變後新測試與 AC-4 測試轉紅、還原後全綠；`npm run test` `# tests 499`、`# pass 499`，build 與 lint exit 0。
   - 相依：步驟 1～3；[review-4451564.md](review-4451564.md)。

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-20 | 不開 PR；改由獨立 subagent 在本機審查 `main..HEAD`，合併由使用者決定 | 交付方式選「分支＋本機審查（建議）」 | 沒有 GitHub 上的 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-20 | 建立；逐題確認 Q1～Q4，範圍依 Q1 縮減為不呼叫遠端 API | - |
| 2026-10-20 | AC-1～AC-5 核准 | 使用者 |
| 2026-10-20 | 獨立審查 `4451564`：PASS（[review-4451564.md](review-4451564.md)） | 獨立 subagent |
| 2026-10-20 | AC-2 規格修訂（審查 SHOULD FIX 1）；記錄不開 PR 的 Gate 豁免 | 使用者 |

---
**建立日期**: 2026-10-20  
**分級**: Small  
**風險**: Low\
**狀態**: 待重新審查
