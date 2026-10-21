# 審查報告

- 範圍：完整分支 `main..feat/issue-0019-recall-criteria`（依 README「Gate 豁免紀錄」，本機審查取代 PR）
- Reviewed BASE SHA：`d0da5fb1c1202f78a7dac4c2609ff38b18b04462`
- Reviewed HEAD SHA：`fe4504b2c5742718bae864feaaa5b5a6aa2018df`
- Reviewed patch-id：`698eb6eacd9a7c009e375f5e0137a573b6a99b3f`（reviewer 自行以 `git diff -a BASE HEAD | git patch-id --stable` 重算，與協調者提供的一致）
- 獨立 reviewer：協調者派出的獨立 subagent（Claude Opus 5.5），沒有參與實作
- Review artifact：`docs/issues/issue-0019/review-fe4504b.md`
- 審查日期：2026-10-21

## 問題與風險

### MUST FIX

1. **驗收集的問句原文進了 repo**：`tests/memoria-recall-criteria.test.ts:110`
   - 這一行的測試字串和凍結檔 `frozen.json` 的 C17 逐字相同。C17 是第一版驗收集的無關題。
   - （2026-10-21 改寫分支歷史時，協調者把本報告引用的原句改成題號，見 README 的 D-3；判定與其他內容不變。）
   - 對應的診斷在 `evidence/step2-criteria.md` 的「驗收集上仍被注入的 4 題」表格，寫出了 C17 命中的 token，所以 repo 讀者可以把這題完整還原。
   - 這違反 AC-1「問句原文、標註與資料副本都放在 repo 外的私人目錄」，也違反協調者交代的隱私條件。repo 是公開的，推上去之後就收不回來。
   - 實際的隱私影響很低：這題是協調者寫的日常問題，私人訊息與資料副本裡都找不到，也不含個資。但它是核准規格明文禁止的內容。
   - 建議：換成不在評估集裡的句子，保留同樣的結構（單字虛詞「要」接在內容詞前面），例如「出國前要準備哪些東西？」。另外跑一次 `tests/memoria-recall-criteria.test.ts`。修正只改測試的字面值，重審範圍很小。
   - 檢查方法：從 diff 新增的行抽出所有含中文的引號字串（53 個），逐一和兩份凍結檔的問句、`user-msgs.txt` 比對。逐字相同的另外還有「晚餐吃什麼好」（C01）、「怎麼煮義大利麵」（C04）、「17 乘以 23」（C02），以及「推薦科幻電影」的近似句。這幾句在 BASE 就已經出現在 issue 0012、0015 的證據與 GitHub #19，是 #15 公開過的對照題，不算這次洩漏。「結論是什麼」只是 A10 的子字串，BASE 的 `tests/recall-metrics.test.ts` 本來就有。

### SHOULD FIX

1. **兩份清單與命中數算法沒有測試守住，會偏離量測。**
   - 背景：step3 說 TS 的清單「與 function-words.mjs 第二版相同，套用順序也相同」。目前這句是對的：reviewer 逐項比對兩份清單，順序完全一致；隨機輸入 20 萬筆，`stripFunctionWords` 與 `tokenizeQuery` 也零差異。
   - 問題：下列 reviewer 自己做的突變，兩個測試檔都照樣全綠：
     - R2：只看第一筆 snippet 改成看所有 snippet 合併。這就是 step2 量過的 `snippet-any`：pool 上無關注入 6/50，`snippet-top` 是 0/50。測試的假 Memoria 只回 1 筆 hit，所以分不出兩者。
     - R3：先拿掉單字虛詞、再拿掉多字詞。在 134 題評估題中，有 3 題送出的問句會改變。
     - R6：清單裡少了「幾」。134 題中有 17 題送出的問句會改變。
     - R7：多字詞不依長度排序。目前的清單本來就大致由長到短，所以這個突變的行為幾乎相同。
   - 依 verification.md，這屬於證據持久力，不是假綠燈：本次 134 題的端到端比對證明目前程式碼和量測一致。
   - 建議：
     - 加一個測試，比較 `src/core/memoria-recall-query.ts` 與 `evidence/scripts/function-words.mjs` 的兩份清單與順序，做法同 `tests/probe-models-script.test.ts`；
     - 加一個 2 筆 hit 的案例：內容 token 分散在第一筆與第二筆 snippet，結果應該是不注入。

2. **AC-4 的已知限制少了一項可預期的行為。**`docs/configuration-reference.md` 的「已知限制」沒有寫到：
   - 拿掉功能詞後，內容 token 不到 2 個的問句，在字面路由上一律不注入。例如只問一個英文名稱，或只問一個 2 字的中文詞：`tokenizeQuery` 只產生 1 個 token，`MIN_MATCHED_TOKENS=2` 不可能達到。改版前 confidence 1.0 會注入。
   - 英文的疑問詞與虛詞（what、is、the…）不會拿掉，都算內容 token。
   - `MEMORIA_RECALL_MIN_CONFIDENCE=0` 只停用注入判準，問句仍會改寫（`src/core/memoria-recall.ts:133`）。所以只改 env 無法完全回到改版前的行為，Memoria 的排序也會因改寫而不同（step2 已觀察到「一進一出」）。文件寫的「`0` = 停用整個注入判準」容易被讀成整個 issue 0019 的改動都停用。
   - 建議：在「已知限制」補上前兩點，並在 `0` 的說明加一句「問句改寫仍會套用」。

3. **方法論的揭露可以更精確（`需決策` 只限第 3 點）。**
   - 時序：對照協調者的工具呼叫紀錄（UTC 時間）：
     - 08:23:28 使用者選「做第二版＋全新驗收集」；
     - 08:33:02 寫新驗收題的草稿；
     - 08:33:14 凍結（`frozenAt` 與檔案 sha256 `3f048252…` 都和 step2 一致）；
     - 08:33:35 起才出現 `SINGLE_CHAR_FUNCTION_WORDS` 與 `snippet-top` 的程式；
     - 08:34:05 跑驗收集一次。
   - 所以「具體清單與算法在凍結之後才寫」成立，驗收集也只跑了一次判準量測。
   - 但第二版的**方向**（純數字不計入命中、補「要」「在」這類單字虛詞）在 08:23 給使用者的選項說明裡就已經定了，新驗收題是同一個 agent 在知道方向之後寫的。step2 與 README 寫的「在設計第二版之前寫好」少了這個前提。建議補一句，和已揭露的「新相關題比較容易」放在一起。
   - 新驗收集只有 17 題無關題，1/17 剛好壓在門檻上，多 1 題就不通過。依二項分布，1/17 的 95% 信賴區間約為 0.15%～29%。建議在限制裡寫出樣本小。
   - `需決策`：AC-1 規定使用者在量測前抽查，原評估集有做。全新驗收集沒有抽查紀錄：08:23 到 08:34 之間沒有任何詢問。規格修訂的文字沒有明確要求抽查，所以 reviewer 不列為 MUST FIX。
     - 待決問題：要不要讓使用者事後抽查新驗收集的 5 題相關、5 題無關？它已經凍結，抽查不改結果，只確認標註可信。
     - 可選做法：(a) 事後抽查並記錄；(b) 接受不抽查，在 README 註明。
     - reviewer 建議 (a)：成本低，而且通過與否完全取決於這 34 題的標註。

4. **紅綠燈紀錄沒有實際命令與 exit code。**
   - 問題：`evidence/step3-implementation.md` 的「紅燈與綠燈」表只有結果摘要。verification.md 要求每一段都記實際命令與 exit code。
   - reviewer 已自行重現綠燈：
     - 兩個目標測試檔 24/24 通過；
     - 全套 `# tests 591`、`# pass 591`、`# fail 0`；
     - lint 通過。
   - 突變紀錄也提供了等價的紅燈，所以不影響本次判定。
   - 建議：補上命令，例如 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/memoria-recall-criteria.test.ts ...`，以及各段的 `# fail` 數。

### NICE TO HAVE

1. `evidence/scripts/evaluate.mjs` 在 HEAD 的 sha256 前 16 碼是 `091dcdbb47197493`，step2 記錄的定案雜湊是 `d0e7c1649db11422`。
   - 原因：fe4504b 為了 `verify-client.mjs` 加了只影響輸出的 `injectedIds` 欄位，不影響計分。
   - 定案版可以用 `git show 1019b8e:docs/issues/issue-0019/evidence/scripts/evaluate.mjs` 取回，雜湊相符。
   - 建議在 step2 或 step4 註明這件事，免得讀者對不上雜湊。
2. 測試的其他字串是評估題的片段，不是原文：
   - `tests/memoria-recall-criteria.test.ts:115` 的字串取自調整集相關題 R01 的用詞；
   - `:119` 的字串和 B12 相近。
   - 兩者都不算洩漏私人資料，但換成中性的詞更乾淨。
3. 判準的語意有一個細微改變：有 hit 但 snippet 全部空白時，以前記 `droppedLowConfidence=false`、`injected=false`，現在因為 `matchedTokens=0` 而記 `droppedLowConfidence=true`。`injected` 不受影響，對 #20 的 `Injected Rate` 沒有影響，只會讓「丟棄」的計數多算這種少見的情況。
4. `verify-client.mjs` 在定案後又對新驗收集的問句發了一次 recall，用途是比對實作與離線計算，判準沒有改，不算第二次驗收。建議在 step4 寫明這一點。
5. 私人目錄 `~/.cache/telenexus-issue19/` 本身是 700，但裡面的 `eval/*.json` 與 `user-msgs.txt` 是 664。實際上只有使用者讀得到，可以改成 600，貼近推導行為 (e) 的字面。

## 已查核維度

### 驗收與證據

**AC-1**（`evidence/step1-evaluation-set.md`）
- 凍結檔 sha256 和實際檔案相符：
  - `frozen.json`：`10f048da…`；
  - `frozen-v2-acceptance.json`：`3f048252…`。
- 組成符合題數要求：
  - 相關 50、無關 50，其中含數字的無關題 22；
  - 新驗收集 17＋17。
- 使用者抽查：08:14:42 詢問，回答「可以，開始量測（建議）」。
- reviewer 以 `evaluate.mjs` 對私人 raw 檔重算基準 24/33、14/33 與門檻表，全部相同。
- 結論：成立。例外是 MUST FIX 1 的原文洩漏。

**AC-2**（`evidence/step2-criteria.md`）
- reviewer 重算的數字全部和證據相同：
  - 第一版調整集 7 列；
  - 第一版驗收集：14/17、8/17 對 15/17、4/17；
  - pool 6 列：38/50、22/50；39/50 與 5、2、3、0、6/50；
  - 新驗收集：17/17、8/17 對 17/17、1/17。
- 規格修訂有使用者選擇的紀錄（08:23:28 的回答與 README D-1 一致）。通過門檻沒有改。
- 結論：成立。揭露可以更完整，見 SHOULD FIX 3。

**AC-3**（`src/core/memoria-recall.ts:131-225`、`src/core/memoria-recall-query.ts`、`evidence/step3-implementation.md`）
- 只改 TeleNexus。
- `confidence` 為 null 照常注入：`memoria-recall.ts:175`，兩個測試檔都有覆蓋，突變 R1 讓 2 個測試轉紅。
- 門檻 0 停用判準：`:176`，突變 M4 有紀錄。
- 擋下時事件記 `dropped_low_confidence`、`min_confidence`、`matched_tokens`、`min_matched_tokens`，trace 記 `droppedLowConfidence=true`、`injected=false`，`memoria_recall_events` 的 `injected=0`。三者都有測試，分別在 `tests/memoria-recall-criteria.test.ts:209-263`。
- 擋下時不回傳 `recallId`：`:219`。
- 整句都是功能詞時改送原句而且不注入：`:133-139`，reviewer 的突變 R4 轉紅。
- 結論：成立。

**AC-3：門檻測試的修改**（`tests/memoria-recall-threshold.test.ts:83-84`）
- 只把查詢從「問題」改成「殭屍程序的結論」。改寫後是「殭屍程序 結論」，4 個 token 都在 snippet 裡，所以擋下只可能來自 confidence。
- 8 個案例與期望值都沒有改，事件測試與 `buildMemoryContextAsync` 測試也沒有改。
- 這個修改是 AC-3 允許的「依文件更新的意義修改」，沒有弱化：reviewer 的突變 R8（`||` 改成 `&&`）讓這個檔案的 5 個門檻案例轉紅。
- 結論：合法。

**AC-4**（`docs/configuration-reference.md:168-179`、`docs/current-chat-prompt.md:110-112`，以及 `summary-aware-retrieval-plan.md`、`web-console-reference.md`、`ARCHITECTURE.md`、`CLAUDE.md`）
- 新判準、來源、量測結果與主要限制都寫了，env 意義的改變也寫明了。
- 結論：大致成立，有缺漏，見 SHOULD FIX 2。

**端到端**
- reviewer 在隔離的 worktree 執行 `npm run build`，再用 `verify-client.mjs` 對 `tn19-memoria`（Memoria 1.28.1）跑 134 題，結果「比對 134 題，不一致 0 題」。
- 另外用私人 raw 檔逐題比對，`stripFunctionWords` 送出的問句和 raw 裡記錄的 query 一致：pool 100 題、新驗收集 34 題都是 0 差異。用 TS 模組模擬 client 的判斷，和 `evaluate.mjs` 的 `snippet-top` 也是 0 差異。

**實作與量測一致**
- 兩份清單逐項相同、順序相同。多字詞的排序：JS 的 `sort` 是 stable，兩邊對同一份陣列做同樣的排序，結果相同。
- `tokenizeQuery` 和容器內 Memoria 1.28.1 `dist/cli.mjs` 的實作逐行一致。Memoria 用全域 regex 的 `.test` 並重設 `lastIndex`，TS 用非全域 regex，兩者等價。
- 命中數的算法和 `evaluate.mjs` 的 `snippet-top` 相同：先過濾空白 snippet、取第一筆、排除純數字 token。
- 唯一的差異是：拿掉功能詞後是空字串時，TS 改送原句並算 0 個 token，腳本會送出空字串。評估集沒有這種題目（0/134），而且 TS 的行為是 AC-3 規定的。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| confidence 為 null | 注入 | 兩個測試檔；R1 轉紅 | 有守住 |
| 門檻 0 | 判準停用、注入 | M4；threshold 測試 | 有守住；問句仍會改寫，文件待補（SHOULD FIX 2） |
| 門檻無效值、大於 1 | 用預設 0.2 | threshold 測試 | 有守住 |
| 只命中 1 個內容 token | 不注入 | M1 | 有守住 |
| 只命中數字 | 不注入 | M2 | 有守住 |
| 虛詞拼成的窗格 | 不注入 | M7 | 有守住 |
| 整句都是功能詞 | 送原句、不注入 | R4 | 有守住 |
| 內容 token 分散在多筆 snippet | 只看第一筆 | 無（R2 存活） | SHOULD FIX 1 |
| 清單或順序偏離量測 | 與 function-words.mjs 相同 | 只有端到端一次（R3、R6 存活） | SHOULD FIX 1 |
| 只有 1 個內容 token 的短問句 | 字面路由一律不注入 | 無測試，文件沒寫 | SHOULD FIX 2 |
| 英文問句 | 英文虛詞不拿掉 | 無 | SHOULD FIX 2 的揭露 |
| 有 hit 但 snippet 全部空白 | 不注入 | 無 | 行為正確，計數語意見 NICE 3 |
| 呼叫點 | 介面不變 | grep | 正式環境唯一的呼叫點是 `src/main.ts:234`（`buildPromptFn`），傳入的是使用者原始訊息（`src/prompt/builder.ts:489`）。`src/`、`scripts/` 沒有其他的 `recallWithMeta`、`recall(` 或 `MemoriaRecallClient` 使用處 |

### 需求、架構、安全、品質

- **需求**：符合 Q1「只改 TeleNexus」，沒有升級 Memoria。
- **架構**：新模組 `memoria-recall-query.ts` 是無副作用的純函式，放在 `src/core/`，和 client 同層。`ARCHITECTURE.md` 與 `CLAUDE.md` 都已登記。
- **安全與隱私**：
  - diff 不含使用者 ID：scope 裡的 9 碼 ID 0 次。
  - diff 不含目標 session id：137 個中 0 個。
  - diff 不含 token、密鑰，也沒有對話內容：測試的 snippet 字串在資料副本與私人訊息裡都找不到；「殭屍程序」這個主題在 BASE 的測試就有。
  - 驗收題原文見 MUST FIX 1。
  - 沒有新的網路面或權限面。
- **品質**：
  - prettier：變更的程式、測試與 `CLAUDE.md` 都通過。
  - lint 通過。
  - 效能：每則訊息對約 80 個詞做 split/join，可以忽略。
- **跨 Task 重複**：tokenizer 與清單在 TS 與 `.mjs` 各有一份。這是刻意的：量測腳本要能在沒有 build 的環境獨立執行，做法同 `probe-models.mjs`。缺的是一致性測試（SHOULD FIX 1）。沒有過度設計。

### 豁免、待確認與限制

- 豁免：README「Gate 豁免紀錄」記載不開 PR、改由本機審查，本報告依此執行。
- 待確認：D-1 已解決，有使用者選擇的紀錄。新驗收集沒有抽查（SHOULD FIX 3 `需決策`）。
- 已揭露的限制（揭露不扣分）：
  - 新相關題比較容易；
  - 只有一份部署的資料，而且全部走字面路由；
  - 只看前 200 字的 snippet；
  - tokenizer 複製自 Memoria 1.28.1；
  - 第一版驗收失敗的經過與 4 題診斷；
  - M2、M7 第一次沒有轉紅、補測試後才轉紅的經過。
- reviewer 執行環境：
  - worktree `~/.cache/tn19-review-wt`，`node_modules` 以 symlink 連到 repo，審查後移除；
  - 測試以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB`、`TMPDIR=$HOME/.cache/memoria-release-tmp` 執行；
  - 沒有碰 `tn19-memoria` 的設定，沒有碰 RunTelenexus。

## 流程判定

**RETURN TO execute-task**

- 原因：MUST FIX 1。驗收題原文違反 AC-1，修正只需要換掉測試的字面值。
- 修正後重審的範圍：該測試檔、兩個目標測試的重跑結果，以及 SHOULD FIX 中決定處理的項目。
- 其餘維度都已查核，沒有正確性或架構問題。實作和量測的判準一致，量測數字可以重現。
