# Issue 0020 - 聊天召回缺少升級後的獨立指標：看不出遷移或修正後召回是否改善 (Small)

GitHub：[#20](https://github.com/raybird/telenexus/issues/20)

## 概述

#15 的驗收方向要求「獨立呈現升級後的召回指標，不把歷史 99 筆當成新版基準」，v2.31.0 沒有做到。現在看得到的召回資訊都回答不了「升級或遷移之後，聊天召回有沒有變好」：

- `memoria-status.md` 的「Recall Telemetry」（`src/services/memoria-recall-telemetry.ts`）：
  - 只在記憶體保留最近 50 筆，重啟就歸零。
  - 分不出因信心低於門檻而沒有注入的召回。`Avg Hits` 是 Memoria 回傳的筆數，會高估實際注入 prompt 的內容。
- `workspace/context/events.jsonl` 的 `memoria_recall` 事件：有 `dropped_low_confidence`，但只保留 7 天，而且要自己解析。
- Memoria 端的 `recall_telemetry`：混著修 scope 之前的查詢。

已確認的現況：
- Memoria 召回只有一個呼叫點：`src/main.ts` 的 `buildPromptFn` → `MemoriaRecallClient.recallWithMeta()`，scope 一律是 `user:<id>`（`src/prompt/builder.ts`）。
- 排程走本機記憶（`buildMemoryContextLines`），不呼叫 Memoria，所以 Memoria 召回全都是聊天的。

本 issue 把每次聊天召回的結果逐筆存進 `moltbot.db`，依 TeleNexus 版本彙總，呈現在 `memoria-status.md`。

**不在範圍內**：
- 門檻與排序的重新校準，在 #19 處理。
- 判斷注入的內容是否相關。
- 遷移時間點的切分：無法自動偵測，使用者 Q2 選擇只依版本。
- 既有的記憶體內「Recall Telemetry」區塊不改。

## 涉及檔案

- `src/core/memory.ts` - 新增 `memoria_recall_events` 表，以及寫入、彙總、清理的方法
- `src/services/memoria-recall-telemetry.ts` - 召回結果的通知 hook，以及每次召回是否注入的判定
- `src/core/memoria-recall.ts` - 每次召回（含失敗）回報一筆結果
- 新的 `src/services/recall-metrics-store.ts` - 訂閱 hook 寫入資料庫，啟動時與每 6 小時清理超過保留期的資料；仿照 `issue-store.ts`
- `src/services/memoria-status.ts` - 新增依版本彙總的區塊
- `src/services/context-snapshots.ts` - 產生 `memoria-status.md` 時傳入版本與彙總的讀取函式
- 新的 `src/utils/app-version.ts` - `readAppVersion()` 由 `src/web/server.ts` 搬來共用
- `src/main.ts` - 啟動 store
- `tests/` - AC-1～AC-4 的測試
- `docs/web-console-reference.md` - 指標的判讀
- `docs/configuration-reference.md` - 資料表、保留期與寫入失敗的行為

## 驗收條件

1. **AC-1：每次聊天召回逐筆保存，跨重啟保留**
   - 每次 `recallWithMeta()` 結束，成功或失敗都在 `moltbot.db` 的 `memoria_recall_events` 寫一筆。欄位：
     - 時間、TeleNexus 版本（讀 `package.json`，讀不到時是 `unknown`）、scope 種類（`user`）；
     - `ok`、`route_mode`、`hit_count`、`dropped_low_confidence`、`injected`、`degraded`、`latency_ms`。
   - 不存問句、snippet 與使用者 ID。
   - `injected` 的定義：請求成功，而且回傳給 prompt 組裝的 snippet 至少一筆；被信心門檻丟棄的不算。
   - 保留 30 天。程序啟動後清理一次，之後每 6 小時清理一次。
   - 寫入失敗不影響召回，只印 warn，不記 runtime issue，以免每則訊息都記一次。
   - 檢查方式：單元測試以假 Memoria 回應涵蓋成功有命中、成功零命中、信心過低被丟棄、降級路由、HTTP 失敗，確認寫入的欄位；重新開啟同一個資料庫後資料仍在；超過 30 天的資料會被清掉。
2. **AC-2：依版本彙總的指標**
   - 每個版本計算：
     - 召回次數，含失敗；失敗次數；
     - 有命中比例：`hit_count > 0` 的成功次數 ÷ 成功次數；
     - 注入比例：`injected` ÷ 成功次數；
     - 降級比例：`degraded` ÷ 成功次數；
     - 該版本第一筆與最後一筆的時間。
   - 檢查方式：單元測試放入兩個版本的資料，確認各項數字。
3. **AC-3：樣本不足時標示不可判定**
   - 某版本的成功次數少於 20 時，三個比例都顯示 `unknown`，並附上 n。不顯示成 0%，做法與 #17 處理未知值的方式一致。
   - 完全沒有資料時，區塊寫明尚無樣本。
   - 檢查方式：單元測試涵蓋 0 筆、19 筆、20 筆三種情況。
4. **AC-4：呈現在 memoria-status.md**
   - `memoria-status.md` 新增「Recall Metrics by Version」一節，列出：
     - 目前版本；
     - 保留期內最近的前一個版本，用來和目前版本比較。
   - 讀取資料庫失敗時，這一節標示讀取失敗與原因，`memoria-status.md` 其他內容照常產生。沿用 #18 的原則：報告不 throw。
   - 檢查方式：單元測試確認 markdown 內容；讓資料庫讀取 throw，確認不 throw、其他區塊照常。

- **核准日期**: 2026-10-21
- **核准來源**: 使用者 2026-10-21 對話的逐題確認：
  - Q1「怎麼跨重啟保存」選「moltbot.db 新增逐筆紀錄表（建議）」（AC-1）。內容是：每次召回一列，含時間、版本、ok、route_mode、hit_count、是否因信心過低丟棄、是否注入、latency；不存問句與內容；保留 30 天，比照 runtime_issues 定期清理。
  - Q2「以什麼為界、顯示在哪」選「依版本，顯示在 memoria-status.md（建議）」（AC-2、AC-4）。內容是：列出目前版本與保留期內前一版的指標，並標出各版第一筆的時間；不另做遷移時間的切分。
  - Q3「樣本門檻」選「少於 20 筆（建議）」（AC-3）。
  - 之後以一則總結確認推導出的行為 (a)～(e)，並說明不存問句、snippet 與使用者 ID，使用者選「全部照寫核准（建議）」：
    - (a) `injected` 的定義（AC-1）；
    - (b) 比例的分母是成功次數，失敗另計（AC-2）；
    - (c) 寫入失敗只印 warn（AC-1）；
    - (d) 清理時機（AC-1）；
    - (e) 讀取失敗時該節標示失敗、不 throw（AC-4）。

## 風險與首要驗證

**風險**: Low
- 新增一張表與一條寫入路徑。寫入在召回完成之後，失敗不影響聊天。
- 每則聊天訊息多一次 SQLite 單列 INSERT，成本可忽略。
- 不改既有欄位與召回行為；回復時移除寫入即可，留下的表不影響其他功能。

首要驗證是 AC-1 的「注入」判定與召回實際回傳給 prompt 的 snippet 一致，因為這是 #20 要回答的核心數字。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|---|---|---|---|
| D-1 | 第一個提交單獨檢出時測試載入失敗，用 ff-only 合併會在 main 留下測試壞掉的提交，干擾 `git bisect`（審查 [review-ed4c001.md](review-ed4c001.md) SHOULD FIX 2，`需決策`） | 已解決（2026-10-21）：使用者選「重整分支歷史」。分支還沒推送；原 HEAD 保留在 `backup/issue-0020-ed4c001` | 不改驗收條件 |

## 實作與驗證步驟

1. ✅ **AC-1：逐筆保存**
   - 驗證方式：先寫測試確認失敗，再實作 `memory.ts` 的表與方法、telemetry hook、`memoria-recall.ts` 的回報、`recall-metrics-store.ts`。改 symbol 前跑 `gitnexus_impact`，並以 `grep` 核對呼叫者。
   - 完成判準：AC-1 的每個檢查方式都有紅燈與綠燈紀錄，並以突變確認「被丟棄的不算注入」會被測試擋下。
   - 相依：無。驗收條件已於 2026-10-21 核准。
   - 完成證據：[evidence/step1-red-green.md](evidence/step1-red-green.md)。空殼上紅燈 9/9；綠燈相關測試 40/40；4 個突變都轉紅，其中 M4 以補上 import 的那次為準。
2. ✅ **AC-2～AC-4：彙總與呈現**
   - 驗證方式：先寫彙總與 markdown 的測試，確認失敗，再實作 `memory.ts` 的彙總查詢與 `memoria-status.ts` 的區塊。
   - 完成判準：AC-2～AC-4 有紅燈與綠燈紀錄；以突變確認門檻 20 與「前一版」的挑選會被擋下。
   - 相依：步驟 1。
   - 完成證據：[evidence/step2-red-green.md](evidence/step2-red-green.md)。空殼上紅燈 5/15，彙總測試因為查詢在步驟 1 已寫好而先通過，改以突變證明；綠燈 16/16；7 個突變都轉紅。
3. ✅ **交付檢查**
   - 驗證方式：更新 `docs/web-console-reference.md`；執行 `npm run build`、`npm run test`（核對 `# tests` 數與測試檔數相稱，`tests/docker/` 有跑到）、`npm run lint`。
   - 完成判準：全部通過。
   - 相依：步驟 1、2。
   - 完成證據：[evidence/step3-delivery.md](evidence/step3-delivery.md)。編譯後的程式跨兩個程序實跑，數字與假服務的規則相符；`# tests 574`、`# pass 574`；build、lint 通過。
4. ✅ **審查後續：[review-ed4c001.md](review-ed4c001.md)**
   - 產出：`tests/recall-metrics.test.ts`、`src/core/memoria-recall.ts`、`src/services/recall-metrics-store.ts`、`src/services/memoria-status.ts`、`src/services/memoria-recall-telemetry.ts`、`ARCHITECTURE.md`、`CLAUDE.md`、文件與證據。
   - 驗收：AC-1、AC-2、AC-4。
   - 相依：步驟 1～3。
   - 完成證據：[evidence/step4-review-followup.md](evidence/step4-review-followup.md)。
     - SHOULD FIX 1、3 已處理；SHOULD FIX 2 依 D-1 重整歷史，每個實作提交單獨檢出時全套測試都通過。
     - 新增的 3 個測試中，scope 的測試在舊程式上是紅燈；另外 2 個守的是既有行為，分別以突變 M11、M13 證明有效。複審後更正的突變紀錄見同一份證據。
     - `# tests 577`、`# pass 577`。

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-21 | 不開 PR；改由獨立 subagent 在本機審查 `main..HEAD`，合併由使用者決定 | 交付方式選「分支＋本機審查（建議）」 | 沒有 GitHub 上的 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-21 | 建立；逐題確認 Q1～Q3 與交付方式 | - |
| 2026-10-21 | AC-1～AC-4 核准；記錄不開 PR 的 Gate 豁免 | 使用者 |
| 2026-10-21 | 本機獨立審查 review-ed4c001：PASS，有 3 項 SHOULD FIX；使用者指示審查 PASS 而且沒有要修的項目時自動合併，有的話先修、複審再回報 | reviewer／使用者 |
| 2026-10-21 | D-1：重整分支歷史（審查 SHOULD FIX 2） | 使用者 |
| 2026-10-21 | 審查後續：SHOULD FIX 1、3 與 NICE 1、2、4～7 | - |
| 2026-10-21 | 本機獨立複審 review-849715e：PASS；SHOULD FIX 1 項，是證據裡的突變紀錄不精確，已更正 | reviewer |
| 2026-10-21 | 本機獨立複審 review-3c7f3fa：PASS，沒有任何發現 | reviewer |
| 2026-10-21 | 依使用者事先的指示（審查 PASS 而且沒有要修的項目時自動合併）以 `git merge --ff-only` 合併進 `main`（`02f9277`）；重整前的歷史保留在 `backup/issue-0020-ed4c001`，review-ed4c001 的 SHA 指向那裡 | 使用者 |

---
**建立日期**: 2026-10-21  
**分級**: Small  
**風險**: Low\
**狀態**: 已完成
