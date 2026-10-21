# 審查報告（複審）

- 範圍：完整分支 `main..feat/issue-0019-recall-criteria`。這次是 [review-fe4504b.md](review-fe4504b.md) 的複審，同時重審整個範圍。
- Reviewed BASE SHA：`d0da5fb1c1202f78a7dac4c2609ff38b18b04462`
- Reviewed HEAD SHA：`940ba9c0d77a563fecb219ff820b5d3b5e441332`
- Reviewed patch-id：`2d0ab9adc62b55f8497ef2595d07e6ff525f1b2f`（reviewer 以 `git diff -a BASE HEAD | git patch-id --stable` 重算，與協調者提供的一致）
- 獨立 reviewer：協調者派出的獨立 subagent（Claude Opus 5.5），沒有參與實作
- Review artifact：`docs/issues/issue-0019/review-940ba9c.md`
- 審查日期：2026-10-21
- fe4504b 之後的新提交：
  - `eb0415f`：前次審查報告；
  - `2023b4b`：修正與測試；
  - `b7cde44`：揭露與命令紀錄；
  - `940ba9c`：D-2 抽查紀錄。

## 問題與風險

### MUST FIX

1. **C17 的原句仍在分支裡：在前次審查報告本身，也在分支歷史裡。**
   - 位置：
     - HEAD 的 `docs/issues/issue-0019/review-fe4504b.md:16`：前次報告為了說明問題，逐字引用了 C17。這是 reviewer 自己的疏失。
     - 歷史：`git log -S` 顯示 C17 原句經過三個提交：
       - `b9a2ff9` 的測試檔加入；
       - `eb0415f` 的報告加入；
       - `2023b4b` 從測試檔拿掉。
     - 所以 `b9a2ff9` 到 `940ba9c` 每個提交的樹都還有這句。main 是保留歷史的線性合併，這個分支照現在的樣子合併並推到公開的 GitHub，原句就會進到公開歷史。
   - 影響：
     - 前次的 MUST FIX 1 只在 HEAD 的測試檔修好了，AC-1「問句原文不進 repo」整體上還沒達成。
     - `evidence/step5-review-followup.md` 的「評估集掃描」說「只剩『17 乘以 23』」，和事實不符：前次報告在這次的 diff 裡也是新增的行。
   - 檢查方法：
     - 把 BASE..HEAD 每個檔案新增的行做正規化（去掉空白與標點），和兩份凍結檔的 134 題比對逐字子字串。
     - 7 字以上的命中中，BASE 沒有的只有兩種：
       - C17（9/9 字），只在 `review-fe4504b.md`；
       - 「的Memoria」這類技術詞的片段（8 字），不算題目內容。
     - 其他命中（C01、C04 等）在 BASE 的 issue 0012、0015 證據裡就有，是 #15 公開過的對照題。
   - 建議：
     1. 把 `review-fe4504b.md:16` 的引用改成「測試字串和凍結檔 `frozen.json` 的 C17 逐字相同」，不寫出原句。
     2. 順便把 `:74-75` 的兩個片段（取自 R01、B12 的用詞）也改成題號，和 `b7cde44` 改用主題代稱的做法一致。
     3. 讓原句不進公開歷史，做法見下方 `需決策`。
     4. 修正後更正 step5 的掃描說明。
   - `需決策`：怎麼把原句從歷史拿掉。分支還沒推到遠端（沒有 `refs/remotes` 含 fe4504b），現在處理的成本最低。
     - (a) 合併時 squash 成一個提交。最簡單，但會失去分支的提交紀錄，`review-fe4504b.md` 記錄的 `fe4504b` 也不會出現在 main 的歷史裡。
     - (b) 改寫分支：修改 `b9a2ff9` 的測試字串與 `eb0415f` 的報告，其餘提交照舊。這樣保留提交結構，但所有 SHA 都會改變，`review-fe4504b.md` 的 `Reviewed HEAD SHA` 會指向不在分支上的提交。可以比照 issue 0020，留一條本機備份分支（不推送），在 README 記下新舊 SHA 的對應。
     - (c) 接受原句進入公開歷史。不建議：違反核准的 AC-1，而且推上去之後就收不回來。
     - reviewer 建議 (a) 或 (b)。不論哪一種，完成後都要對新 HEAD 做一次簡短複審：
       - 確認新 HEAD 的樹和 `940ba9c` 只差上述文字修改；
       - 確認 `git log -S` 在新範圍內找不到原句。

### SHOULD FIX

無。

### NICE TO HAVE

1. `tests/memoria-recall-criteria.test.ts:17` 直接 import `docs/issues/issue-0019/evidence/scripts/function-words.mjs`。
   - 這個做法有前例：`tests/release-workflow.test.ts` import 了 `scripts/*.mjs`。專案也不對 tests 做型別檢查，tsconfig 只含 `src`。
   - 但這讓產品測試依賴 issue 目錄裡的證據腳本：之後整理 `docs/issues/` 時，搬動或刪掉這個檔案，測試會直接壞掉。
   - 建議在 `function-words.mjs` 開頭註明「`tests/memoria-recall-criteria.test.ts` 會讀這個檔案」。

## 前次發現的處理

| 前次項目 | 處理 | 複審結論 |
|---|---|---|
| MUST FIX 1：測試字串是 C17 原句 | 測試檔已換成不在評估集裡的句子，結構相同 | **測試檔已解決**；報告本身與歷史仍有原句，見本次 MUST FIX 1 |
| SHOULD FIX 1：清單、順序、第一筆 snippet 沒有守住 | 新增清單一致性測試與 2 筆 hit 的測試 | **已解決**。reviewer 重跑突變，每個都讓指定的測試轉紅：<br>• R2（看全部 snippet）、R3（先拿單字）、R6（少了「幾」）；<br>• 另外加的 R9（拿掉空白 snippet 的防護）；<br>• R10：在 `function-words.mjs` 加一個字，模擬量測端偏離。 |
| SHOULD FIX 2：已知限制少三點 | `docs/configuration-reference.md:178-180` 補上三點 | **已解決**，文字正確 |
| SHOULD FIX 3：方法論的揭露與 `需決策` | step2「已知限制」補上「方向先知」與 1/17 的信賴區間；D-2 補做抽查 | **已解決**。說明見下方「D-2 的查核」。 |
| SHOULD FIX 4：沒有命令與 exit code | step3 新增「命令與 exit code」一節 | **已解決**，reviewer 重跑結果一致 |
| NICE 1：evaluate.mjs 的雜湊不同 | step2 寫明原因與取回命令 | 已解決 |
| NICE 2：測試字串取自 R01、B12 的用詞 | 測試已換成中性的詞 | 測試已解決；前次報告 `:74-75` 仍有，見 MUST FIX 1 的建議 2 |
| NICE 3：snippet 全部空白時被記為丟棄 | `src/core/memoria-recall.ts:177-179` 加上 `snippets.length > 0`，並新增測試 | **已解決**，說明見下方「NICE 3 的修正」 |
| NICE 4：verify-client 不算第二次驗收 | step4 寫明 | 已解決 |
| NICE 5：私人目錄的檔案權限 | 改成 600 | 已解決，reviewer 以 `stat` 確認 |

**D-2 的查核**：對照協調者的工作紀錄：
- 2026-10-21 08:54 的訊息列出了 A05、A06、A09、A13、A17 與 B01、B09、B12、B14、B16 共 10 題。reviewer 只比對這 10 題的原文是否都在訊息裡（都在），沒有抄錄。
- 使用者 10:58 回覆「可以」。
- 抽到的無關題包含唯一被注入的 B14。

**NICE 3 的修正**：
- 改了之後：有 hit 但 snippet 全部空白、confidence 達門檻時，記 `droppedLowConfidence=false`、`injected=false`；confidence 低於門檻時照樣記為丟棄。
- 注入行為沒有改變，134 題的端到端比對仍然一致。
- 這是產品碼的修改，紅燈證據是 R9 突變讓新測試轉紅。

## 已查核維度

### 驗收與證據

- **AC-1**：凍結雜湊、組成、兩次抽查（原評估集 08:14、新驗收集 D-2）都有紀錄。問句原文的條件還沒完全達成（MUST FIX 1）。
- **AC-2**：前次 reviewer 已用私人 raw 檔重算全部數字，結果相同。這次的修改沒有動判準、清單或量測腳本：
  - `function-words.mjs`、`collect-recall.mjs`、`evaluate.mjs` 在 fe4504b..940ba9c 都沒有變更；
  - 唯一的產品碼修改是 NICE 3 的空白 snippet 防護，不影響注入。
  - 結論：成立。
- **AC-3**：前次查核的行為都還在：null 照常注入、門檻 0 停用、擋下時的事件與 #20 紀錄、不回傳 recallId、整句都是功能詞。reviewer 重跑突變：
  - R11（`MIN_MATCHED_TOKENS` 改成 1）讓 5 個測試轉紅；
  - R12（拿掉 null 判斷）讓 2 個測試轉紅。
  - 結論：成立。
- **AC-4**：`docs/configuration-reference.md` 補齊了三項限制，原因說明改用一般描述。結論：成立。
- **reviewer 重跑的結果**，在 `940ba9c` 的隔離 worktree 執行：
  - 測試環境：`TMPDIR=$HOME/.cache/memoria-release-tmp`、`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB`；
  - 兩個目標測試檔：`# tests 27`、`# fail 0`；
  - `npm run build` exit 0、`npm run lint` exit 0，prettier 對變更的程式與測試通過；
  - `npm test`：`# tests 594`、`# pass 594`、`# fail 0`（591 加 3）；
  - `verify-client.mjs` 用重建的 `dist/` 對 `tn19-memoria` 比對：「比對 134 題，不一致 0 題」。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| 清單或順序和量測腳本不一致（兩邊任一邊改動） | 測試轉紅 | 清單一致性測試；R3、R6、R10 | 有守住 |
| 內容 token 分散在多筆 snippet | 只看第一筆、不注入 | 2 筆 hit 的測試；R2 | 有守住 |
| 有 hit 但 snippet 全部空白 | 不注入、不記為丟棄 | 新測試；R9 | 有守住 |
| 原文進入公開 repo（HEAD 與歷史） | 不出現 | 掃描、`git log -S` | **未通過**（MUST FIX 1） |
| 其他前次已查核的失敗面（null、門檻 0、無效門檻、只命中 1 個、只命中數字、虛詞窗格、整句功能詞、呼叫點） | 同前次 | 前次的突變與 R11、R12 | 有守住 |

### 需求、架構、安全、品質

- **需求與架構**：`FUNCTION_WORDS`、`SINGLE_CHAR_FUNCTION_WORDS` 改成 export，只供測試使用。正式環境唯一的呼叫點仍是 `src/main.ts:234`，介面不變。
- **安全與隱私**：
  - diff 不含使用者 ID 或目標 session id（前次已查，這次的新增行裡沒有任何 ID 格式的字串）；
  - 驗收題原文見 MUST FIX 1。
- **品質**：
  - 新測試的期望值來自量測腳本或人工推導的字面值，不是同義反覆。清單一致性測試是兩份獨立實作互相比對，R10 證明任一邊改動都會轉紅。
  - 沒有新的重複邏輯或過度設計。

### 豁免、待確認與限制

- Gate 豁免：沿用 README 的「不開 PR，改本機審查」。
- 待確認：D-1、D-2 都已解決，有使用者的回覆。本次 MUST FIX 1 的處理方式待使用者決定。
- reviewer 執行環境：
  - worktree `~/.cache/tn19-review-wt2`，`node_modules` 以 symlink 連到 repo；
  - 突變都以備份還原，worktree 在審查後移除；
  - 沒有碰 `tn19-memoria` 的設定，沒有碰 RunTelenexus。

## 流程判定

**RETURN TO execute-task**

- 原因：MUST FIX 1。驗收題的原句還在 HEAD（前次審查報告第 16 行）與分支歷史裡，違反 AC-1。
- 其餘前次發現都已確實解決。程式、測試、文件與量測的一致性都沒有問題。
- 修正方式（`需決策`）：
  - 選 (a) squash：修正提交，並且決定以 squash 合併之後，複審只需要確認新 HEAD 和 `940ba9c` 的差異只有報告的文字修改，以及新範圍的 `git log -S` 找不到原句。
  - 選 (b) 改寫歷史：SHA 會全部改變，複審要確認新 HEAD 和 `940ba9c` 的差異只有報告的文字修改，以及 `git log -S` 在新範圍內找不到原句。
