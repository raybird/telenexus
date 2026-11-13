# 審查報告
- 範圍：完整 PR（本機分支 `fix/issue-0027-telegram-markdown` 對 main，依 Gate 豁免不開 PR）；重點是 review-6436089.md 之後的 47b962b、4d2bf3c、4c35a8a
- Reviewed BASE SHA：8945e22e2883e81ccc38f6d1650ba98ba6b044e3
- Reviewed HEAD SHA：4c35a8abb7bb02060076f6a6874f414c64330375
- Reviewed patch-id：acfc37f0b250ad921c942decb2f959ff580f492b（審查時以 `git diff 8945e22..4c35a8a | git patch-id --stable` 重算，相符）
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，不是原實作者；與 review-6436089.md 是同一位 reviewer
- Review artifact：docs/issues/issue-0027/review-4c35a8a.md
- 核准基線：4c35a8abb7bb02060076f6a6874f414c64330375。依 acceptance.md「規格修訂的查核」以 `ref=4c35a8a` 推導，最後修改 `**核准來源**` 欄位行的提交就是被審查 HEAD；`git diff 4c35a8a 4c35a8a -- docs/issues/issue-0027/README.md` 為空。47b962b 曾把核准 commit 回填成 6436089，4c35a8a 因 AC-3、AC-6 的規格修訂改回 `待提交`，符合「重新核准後更新基線提交」的規則。核准來源新增的文字涵蓋 S2（AC-6 改寫）、N3（AC-3 的空行只適用最上層）與 N2（維持舊版行為）。AC-3 的標題寫法從 `*__標題__*` 改成 `__*標題*__`，核准來源沒有提到，只記在 Timeline。這兩種寫法產生的實體相同（同一段文字上的粗體與底線），屬於 acceptance.md「差異未改變條件、動作、結果或必要檢查」，不需要重新核准，記在 Timeline 就足夠。

## 問題與風險

- MUST FIX：無。

- **更正前次報告（review-6436089.md）的 M2、S1**：依 [step5-review-send.md](evidence/step5-review-send.md) 的實機對照，修正前的 `>>`（M2）與引言內的 fence（S1）Telegram 都回 `ok: true`，只有 M1 回 400 `Can't find end of Bold entity`。前次報告說 M2「必定回 400」、S1 可能被拒收，這兩個判斷不成立，嚴重度應該降為 NICE TO HAVE（排版一致性與防禦性），不構成退回的理由。前次的退回判定仍然成立，因為 M1 已由實機證實是 MUST FIX。現行程式保留攤平與純文字的寫法，Telegram 同樣接受（修正後 6 則都 `ok: true`），不需要改回。

- **SHOULD FIX S1 `需決策`：審查修正後的樣本沒有記錄使用者在手機上的確認**（[step5-review-send.md](evidence/step5-review-send.md)）
  - AC-5 除了要求回 `ok: true`，還要求「再由使用者在手機上確認縮排與編號看得出來」。這一輪改變了三種顯示：N1 的硬換行續行縮排、巢狀引言攤平、引言內程式碼改成純文字；step5-review-send.md 只記錄 API 結果。標題改寫只交換了實體的巢狀順序，實體的範圍相同，顯示不會改變，所以原本的確認仍然適用。
  - 待決問題：這 6 則（已送到維護者的聊天）是否需要使用者看過再確認？reviewer 建議：(a) 請使用者看一下，結果記在 README `## Timeline`（記帳區段，在 PASS 之後補記不會讓 PASS 失效）；(b) 使用者認為不必，在 Timeline 記下這個決定。
- **SHOULD FIX S2：步驟 7 放錯章節**（`docs/issues/issue-0027/README.md:87-96`）
  - 「7. ✅ 審查 review-6436089.md 的修正」接在 `## 待確認事項` 的表格後面，不在 `## 實作與驗證步驟` 底下。讀者照章節找任務清單時會漏看，而且它落在記帳區段裡，與 review-evidence.md 對記帳區段的分工不一致（以粗體開頭的清單行在那裡雖然算凍結內容，但本來就不該在那裡）。
  - 影響與做法：只是文件結構問題，不影響行為或證據。搬回 `## 實作與驗證步驟`（放在步驟 6 之後）會改動凍結內容，在 PASS 之後做就要重新審查。可選做法：合併前搬移並接受多一輪審查；或維持現狀，合併後不再修改（issue 結案後保留歷史）。由使用者決定。

- **NICE TO HAVE N1：標題裡的粗體會讓相鄰文字失去粗體**（`src/telegram/render/markdown-v2.ts:39`）
  - `# 結尾 **粗**` 輸出 `__*結尾 *粗**__`：內層的 `*` 先把外層粗體關掉，所以「粗」反而不是粗體。`# **全粗**` 輸出 `__**全粗**__`，只剩底線。main（8945e22）的 `*…*` 寫法有同樣的問題，所以不算退步。前一版的 `*__…__*` 有底線隔開，反而不會出現這個問題，但會撞上 M1。語料 986 個標題中，2 個以粗體結尾、0 個整段粗體。建議在標題裡把 strong 子節點輸出成純文字（整個標題本來就是粗體）。
- **NICE TO HAVE N2：`corpus-check.ts` 的 `isAc6()` 沒有跟著 AC-6 的改寫更新**（`docs/issues/issue-0027/evidence/corpus-check.ts`）。改寫後的 AC-6 排除了 HTML 與圖片，而分類器沒有排除。這只會讓檢查更嚴格（多比對一些回覆），444/444 的結論不受影響；之後重用這支腳本時，請記得它與 AC-6 字面範圍的差異。

## 已查核維度

- 驗收與證據：
  - AC-1：測試第 67-117 行，加上 N1 的測試第 255-257 行（手寫字面值）。我重跑 `npx tsx --test tests/telegram/render-markdown-v2.test.ts` 得 27/27。第 1 層的軟換行續行仍然不縮排（`- 第一行\n  軟換行` 輸出 `• 第一行\n軟換行`，與 main 相同），AC-6 沒有被破壞。結論：成立。
  - AC-2：同前次，沒有變更。結論：成立。
  - AC-3：改寫後的條文（底線在外層、空行只適用最上層）與測試第 29-31、124-130、228-235 行一致。實機證據：修正前的 M1 回 400、修正後 `ok: true`。我另外跑過 `#` 空標題、以粗體開頭或結尾、整段斜體、`a_b_`、尾端跳脫的 `_`、含 code span 與連結、斜體裡含粗體，都沒有 `___`，也通過檢查器。結論：成立（另有 N1）。
  - AC-4：我重跑語料（`corpus.ts new`），新版缺字詞 0 則；新增的巢狀引言、引言 → 清單 → 程式碼、清單 → 引言 → 程式碼、引言內的 think 區塊，原文字詞都還在。結論：成立。
  - AC-5：修正後 6 則 `ok: true`，修正前的對照也實際送過（M1 回 400、M2 與 S1 回 `ok`）。使用者確認見 S1。
  - AC-6：語料 444/444 逐字相同（我重跑 `compare.ts`）。改寫後的檢查命令 `npx tsx --test tests/telegram/*.test.ts tests/telegram-stream-renderer-finalize.test.ts` 我重跑得 `# tests 44 / # fail 0`。完整閘門：`npm run build` exit 0、`npm run lint` exit 0、`npm run test` exit 0，`# tests 781 / # pass 781 / # fail 0`，`find tests -name '*.test.ts' | wc -l` 得 89，與 [gates-review.log](evidence/gates-review.log) 相符。結論：成立。
  - 紅綠證據：[red-review.log](evidence/red-review.log)（被測狀態 6436089 加上新測試，26 個中 7 個失敗，失敗原因都是目標行為）→ [green-review.log](evidence/green-review.log) 27/27。突變 M13～M17 都被擋下；M17 的測試是在突變沒被擋下之後才補的，有如實揭露。新測試的期望值是手寫字面值，或「不得含 `___`、不得以 `>>` 開頭」這類與實作無關的條件，不是同義反覆。
- 相關失敗面（全部實際跑過，以依官方規則寫的近似檢查器判斷合法性；檢查器對語料 881 則新舊輸出都判 0 則不合法。前次的實機結果顯示它在 `>>` 上比 Telegram 嚴格，這次不以它判定引言）：
  - 標題的各種行內組合：見 AC-3，都合法；粗體相鄰的顯示問題見 N1。
  - `quoteDepth` 狀態：引言之後的程式碼、標題、引言照常輸出（測試第 259-263 行與我的探測），`try/finally` 保證例外時也會歸零。引言 → 清單 → 程式碼後接段落、引言內兩層巢狀的程式碼、清單裡的引言裡的程式碼，都輸出成純文字並加上 `>`。
  - 引言內的硬換行續行（`> 1. a\\\n>    b`、`> - a\n>   - b\\\n>     c`）：每一行都有 `>`，縮排正確。
  - 跨行的粗體在巢狀項目裡（`**粗\n續**`）：續行縮排後實體仍然合法。
  - 切段：清單裡的程式碼仍在行首，引言內已經沒有 fence，`chunkMarkdownV2` 的 fence 判斷不受影響。
  - 其他呼叫端（`pinned-status-manager.ts`）：沒有標題、清單或引言，不受影響。
- 需求、架構、安全、品質：
  - 範圍：4d2bf3c 只動 `src/telegram/render/markdown-v2.ts` 與對應測試；4c35a8a 只動 issue 文件、證據與 CLAUDE.md 的一列。47b962b 只新增前次報告（內容與我寫的檔案逐字相同）、建立 `## 現況`、回填核准 commit。
  - 架構與簡化：`quoteDepth` 加上 `blocks()` 是最小的狀態，取代了原本只看直接子節點的特例，一個規則就同時涵蓋 M2 與 S1，沒有重複。N1 的修正與後段的 `indentLines` 邏輯一致。沒有過度設計。
  - 常青文件：CLAUDE.md 的 `markdown-v2.ts` 那一列補上了攤平與純文字，與實作相符。
  - 去敏（L-10）：搜尋 6436089..4c35a8a 變更過的所有檔案，沒有家目錄絕對路徑、帳號名、token、9～10 位數的使用者 ID 或 64 位十六進位 ID；gates-review.log 的路徑已改寫成 `~`。
  - 安全：輸出仍然全部經過既有的 escape 函式；引言內程式碼改用 `escapeMarkdownV2`，保留字元都有跳脫。
- 豁免、待確認與限制：
  - Gate 豁免（不開 PR、在本機獨立審查）沿用。TBD-1 已解決。S2、N3、N2 的使用者決定已寫進核准來源與 Timeline。
  - 限制：我沒有用正式 bot 實機呼叫；Telegram 是否接受，以實作者的 step5-review-send.md 為準。
  - 流程契約 2.5：協調者提交本報告時，同一個提交要把 README `## 現況` 的 `**現行 review**` 改成 `review-4c35a8a.md`，並可以把核准 commit 從 `待提交` 回填成 4c35a8a（被審查提交本身）。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
