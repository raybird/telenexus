# Issue 0019 - 舊記憶遷移後無關問句的召回 confidence 上升：重新校準注入判準 (Medium)

GitHub：[#19](https://github.com/raybird/telenexus/issues/19)

## 文件清單
- [implementation-plan.md](./implementation-plan.md)
- [evidence/step1-evaluation-set.md](./evidence/step1-evaluation-set.md)
- [evidence/step2-criteria.md](./evidence/step2-criteria.md)
- [evidence/step3-implementation.md](./evidence/step3-implementation.md)
- [evidence/step4-end-to-end.md](./evidence/step4-end-to-end.md)
- [evidence/step5-review-followup.md](./evidence/step5-review-followup.md)
- [review-fe4504b.md](./review-fe4504b.md)
- [review-940ba9c.md](./review-940ba9c.md)

## 概述

#15 的遷移工具把舊版 `project:TeleNexus` 的記憶分到 `user:` 分區之後，聊天召回的語料大幅增加。在另一台部署的資料副本上，`user:` 分區從 20 筆增加到 1,041 筆，無關問句的 confidence 也跟著上升。issue 0012 的 `MEMORIA_RECALL_MIN_CONFIDENCE=0.2` 分不開相關與無關的問句：

- 遷移後，無關的對照題 4 題中有 2 題被注入。
- 「17 乘以 23」的 confidence 是 0.4，高於有命中的相關題的最低值 0.294。

已確認的現況：
- confidence 是 Memoria 算的 `lexical_coverage`，也就是問句 token 出現在第一筆結果裡的比例（Memoria 1.28.1，`src/core/db/recall.ts` 的 `tokenCoverage()`）。
  - 中文切成 2 字的窗格，英數字串各算一個 token。
  - 短問句與「什麼」「多少」這類泛用詞、數字，容易因巧合得到高覆蓋率。
- 部署的 Memoria 映像釘在 1.28.1（`docker/memoria.Dockerfile`）。
- 2026-10-21 在資料副本上重現：用同一個 Memoria 1.28.1 映像，#15 的電影、義大利麵兩題對照題分別是 0.143、0.167，和 #15 的量測相同。
- #15 凍結的 16 題問句已找不到：原文本來就不進 repo，當時的暫存也已經清掉。

**範圍**：只改 TeleNexus（使用者 Q1）。可以做的有：
- 問句送出前的處理；
- 拿回結果後，自己重算判準或重新排序；
- 調整門檻。

量測若證明只有改 Memoria 才解得了，記為發現，另開 Memoria 的 issue。

**不在範圍內**：
- #15 的遷移工具。要不要在正式部署上執行遷移，另外決定。
- 判斷注入內容的品質細節：只判「有沒有命中目標對話」。
- 升級 Memoria。

## 涉及檔案

- `src/core/memoria-recall.ts` - 注入判準：`droppedLowConfidence` 的計算，以及送出的問句
- `src/core/memoria-recall-query.ts`（新增）- 問句改寫與內容 token 的計算
- `ARCHITECTURE.md`、`CLAUDE.md`、`docs/summary-aware-retrieval-plan.md`、`docs/web-console-reference.md` - 登記模組並更新判準的說明
- `tests/memoria-recall-criteria.test.ts`（新增）、`tests/memoria-recall-threshold.test.ts` - 判準的測試，用合成資料
- `docs/issues/issue-0019/evidence/` - 評估集的組成、凍結雜湊、量測結果；不含問句原文與對話內容
- `docs/issues/issue-0019/evidence/scripts/` - 量測腳本，不含私人資料
- `docs/configuration-reference.md`、`docs/current-chat-prompt.md` - 判準的說明

## 驗收條件

1. **AC-1：凍結的評估集與可重現的量測**
   - 從遷移後的資料副本出題：
     - 相關題至少 30 題：每題對應副本裡的一段對話，標註目標 session；
     - 無關題至少 30 題：主題在副本裡找不到，其中至少 10 題含數字。
   - 問句原文、標註與資料副本都放在 repo 外的私人目錄。repo 只放組成說明、主題分類與檔案的 sha256。
   - 量測前凍結。凍結後不改題目；要改就重新凍結，並在證據裡記錄原因。
   - 使用者在量測前抽查至少 5 題相關、5 題無關的問句與標註。
   - 量測腳本放在 repo（不含私人資料），對正式部署相同版本的 Memoria（1.28.1 映像）跑同一個 payload：`top_k=5`、`mode=hybrid`、`scope=user:<id>`。
   - 每個候選判準輸出兩個數字：
     - 相關命中率：注入的結果含目標 session 的題數 ÷ 相關題數；
     - 無關注入率：有任何注入的題數 ÷ 無關題數。
   - 檢查方式：證據記錄凍結雜湊、抽查結果，以及現行判準（confidence ≥ 0.2）在評估集上的基準數字。
2. **AC-2：判準達到通過門檻**
   - 選出的判準在評估集上同時滿足：
     - 無關注入率 ≤ 10%；
     - 相關命中率不低於現行判準在同一評估集上的結果。
   - 為避免針對題目過度調整，評估集分成調整集與驗收集。判準只用調整集設計；驗收集在判準定案後只跑一次，通過門檻以驗收集的結果為準。
   - 達不到時，回報可得的最佳取捨，由使用者決定是否修訂門檻，依規格修訂處理。
   - **規格修訂（2026-10-21，使用者選「做第二版＋全新驗收集（建議）」）**：第一版判準在驗收集上的無關注入是 4/17，未達門檻。
     - 舊的調整集與驗收集合併成 100 題的調整集，用來設計第二版。
     - 另外凍結一組全新的驗收集（相關、無關各 17 題），在設計第二版之前寫好，第二版定案後只跑一次。
     - 通過門檻不變。
   - 檢查方式：證據列出各候選判準在調整集上的數字，以及選定判準在驗收集上的數字。
3. **AC-3：判準實作在 TeleNexus，行為可預期**
   - 實作在 TeleNexus 端，不改 Memoria。
   - `confidence` 為 `null`（語意路由，無法判斷）時照常注入，維持 issue 0012 的行為。
   - 被新判準擋下的召回，`memoria_recall` 事件與 #20 的 `memoria_recall_events` 都記為 `dropped_low_confidence`、`injected=0`，不回報 UFL outcome，與現行被門檻擋下時相同。
   - `MEMORIA_RECALL_MIN_CONFIDENCE` 仍然有效；若它的意義有改變，文件寫明。
   - 檢查方式：單元測試用合成的 Memoria 回應，涵蓋擋下、放行、`null`；既有的門檻測試維持通過，或依文件更新的意義修改。
4. **AC-4：文件**
   - `docs/configuration-reference.md` 與 `docs/current-chat-prompt.md` 說明新的判準、它的來源與已知限制。

- **核准日期**: 2026-10-21
- **核准來源**: 使用者 2026-10-21 對話的逐題確認：
  - Q1「判準可以改在哪裡」選「先只改 TeleNexus（建議）」。
  - Q2「評估資料怎麼來」選「我從副本出題，你抽查（建議）」（AC-1）。內容是：把副本搬到 repo 外的持久位置；出一組較大的問句集，相關與無關各約 30 題，無關題包含日常、計算、含數字的閒聊；執行前凍結；標註標準寫進文件；使用者抽查幾題；問句原文不進 repo。
  - Q3「通過門檻」選「無關注入率 ≤10%，相關命中不低於基準（建議）」（AC-2）。內容是：達不到時回報最佳可得的取捨，由使用者決定。
  - 交付方式選「分支＋本機審查（建議）」：合併前等使用者指示。
  - 推導出的行為：使用者以「全部照寫核准（建議）」一併核准 AC-1～AC-4 與以下各項。
    - (a) 「命中」的定義：注入的結果含目標 session（AC-1）；
    - (b) 調整集與驗收集的切分，驗收集只跑一次（AC-2）；
    - (c) 量測用 Memoria 1.28.1 映像（AC-1）；
    - (d) 被新判準擋下時，事件與 #20 的紀錄沿用 `dropped_low_confidence`（AC-3）；
    - (e) 資料副本放在 `~/.cache/telenexus-issue19/`，權限只有使用者本人（AC-1）。

## 風險與首要驗證

**風險**: Medium
- 判準直接決定聊天 prompt 會不會帶到長期記憶。
  - 擋太多：相關記憶召回不到，回到遷移前的狀態。
  - 擋太少：無關內容汙染回覆。
- 評估集只來自一份部署的資料，判準可能過度貼合這份資料；以 AC-2 的驗收集降低這個風險，並在文件寫明限制。
- 實作本身改動小，只動一個判斷式及其輔助函式，回復容易。

首要驗證是 AC-1 的基準數字：現行判準在新評估集上的相關命中率與無關注入率。它決定 AC-2 的比較基準，也驗證 #15 的觀察在較大的題集上是否成立。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|---|---|---|---|
| D-1 | 第一版判準在驗收集未達 AC-2 的門檻 | 已解決：使用者 2026-10-21 選「做第二版＋全新驗收集（建議）」；第二版在全新驗收集通過，見 [step2-criteria.md](evidence/step2-criteria.md) | AC-2 規格修訂 |
| D-2 | 審查 review-fe4504b 的 `需決策`：新驗收集（34 題）沒有使用者抽查 | 已解決：2026-10-21 以雜湊排序隨機抽出相關 5 題（附目標對話的日期與摘要開頭）、無關 5 題給使用者看，使用者回覆「可以」，標註不需修改 | 第二版的驗收結果沿用，不重驗 |
| D-3 | 驗收題 C17 的原句留在分支歷史裡：實作的提交寫進測試檔，前次審查報告又引用一次（複審 [review-940ba9c.md](review-940ba9c.md) MUST FIX，`需決策`） | 已解決（2026-10-21）：使用者選「改寫分支歷史（建議）」。<br>• 分支還沒推送，以 `git filter-branch --tree-filter` 只換掉這兩處，並把前次報告裡兩個評估題片段改成題號，其他內容不變。<br>• 原 HEAD 保留在 `backup/issue-0019-940ba9c`，兩份審查報告記的 SHA 指向那裡。<br>• 新舊 SHA 對照：`b9a2ff9`→`ad6a06a`、`fe4504b`→`09a5060`、`eb0415f`→`92b411d`、`2023b4b`→`6c22b23`、`b7cde44`→`c090a9c`、`940ba9c`→`515d8f8`；`a75367c`、`1019b8e` 沒有變。 | 不改驗收條件 |

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-21 | 不開 PR；改由獨立 subagent 在本機審查 `main..HEAD`，合併由使用者決定 | 交付方式選「分支＋本機審查（建議）」 | 沒有 GitHub 上的 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-21 | 建立；逐題確認 Q1～Q3 與交付方式 | - |
| 2026-10-21 | AC-1～AC-4 與推導行為 (a)～(e) 核准 | 使用者 |
| 2026-10-21 | 步驟 1：評估集凍結並經使用者抽查；基準為相關命中 24/33、無關注入 14/33 | - |
| 2026-10-21 | 步驟 2：第一版判準在驗收集未達門檻（無關注入 4/17） | - |
| 2026-10-21 | 規格修訂：做第二版並以全新驗收集驗收 | 使用者 |
| 2026-10-21 | 步驟 2：第二版判準在全新驗收集上，相關命中 17/17、無關注入 1/17，通過 | - |
| 2026-10-21 | 步驟 3、4：實作、測試與文件；編譯後的 client 與離線計算比對 134 題，全部一致 | - |
| 2026-10-21 | 本機獨立審查 review-fe4504b：RETURN TO execute-task。MUST FIX 1 項，是測試字串與驗收題相同；已修正，另外處理 SHOULD FIX 1～4 與 NICE | reviewer |
| 2026-10-21 | 新驗收集經使用者抽查 10 題（相關、無關各 5 題），回覆「可以」（D-2） | 使用者 |
| 2026-10-21 | 本機獨立複審 review-940ba9c：RETURN TO execute-task。前次各項都已解決；新的 MUST FIX 是 C17 原句還在分支歷史，依 D-3 改寫歷史；NICE 一項（量測腳本被測試依賴）在檔頭註明 | reviewer |

---
**建立日期**: 2026-10-21  
**分級**: Medium  
**風險**: Medium\
**狀態**: 進行中
