# 審查報告
- 範圍：完整 diff（本機流程，無 PR）。`git diff 79b081d 51b8e1c` 共 8 個提交：f1f8336、17b4cb3、933f5ce、eb9cc0b、dffa5b4、2eafbb6、cc6caa1、51b8e1c。這一輪重點看增量 `git diff cc6caa1 51b8e1c`（11 個檔案，+116／−35）。
- Reviewed BASE SHA：79b081d3087c0ad5aceec40a3803aa8de730754b
- Reviewed HEAD SHA：51b8e1c8d7802246caae4dc8fbddde232f9b6de4
- Reviewed patch-id：ebd88a39a79c668af1be68055ac120046025584b
- 獨立 reviewer：Claude（Opus 5.5）隔離 subagent，不是實作者，與前兩輪（[review-eb9cc0b.md](review-eb9cc0b.md)、[review-2eafbb6.md](review-2eafbb6.md)）是同一個 reviewer。全程只讀，沒有修改、提交或推送，也沒有呼叫 Telegram 或任何外部服務。
- Review artifact：docs/issues/issue-0028/review-51b8e1c.md
- 核准基線：17b4cb300ab264023e5386671d2fa45d0df0c367。
  - 在 51b8e1c 上重跑推導命令，結果仍是 17b4cb3，與 README 的 `**核准 commit**` 一致。
  - `git diff 17b4cb3 51b8e1c -- docs/issues/issue-0028/README.md` 只動了記帳區段：`## 現況` 的 `**現行 review**`、`**核准 commit**` 的值、Timeline 兩列、`**狀態**`。Gherkin、核准來源與核准表都沒有改。
  - NICE 4 的優先順序說明寫在 implementation-plan.md 設計第 1 點，沒有寫進規格。

## 問題與風險
### MUST FIX
無

### SHOULD FIX
無

### NICE TO HAVE
1. **`shownText` 去掉 think 標籤這一步沒有測試保護**
   - 位置：`src/core/reply-parts.ts:79`。
   - 變異：把 `shownText.replace(THINK_TAG, '')` 改成 `shownText`，13 支測試仍然全過。
   - 這一步影響的情況：think 標籤出現在一段文字的中間，例如同一個 step 裡有 `x</think>y</think>z`，或 `前<think>後`。
     - 有這一步：那一段是 `xy`，在去掉標籤的全文裡找得到，照常分段。
     - 沒有這一步：全文裡找不到 `xy`，那個回合就不分段。
   - 影響：漏掉時只會照舊送全文，不丟內容。
   - 建議：補一支 fixture，例如 `x</think>y</think>z` 後接 tool-calls、再接結論，斷言照常分段。
2. **NICE 5 的語料數字與實際資料有一點落差**（證據的說法，不影響程式）
   - `evidence/step4-corpus-check.ts` 把最後一個 step 以外都強制當成 `tool-calls`。所以「85 個有過程的回合仍全部分段」沒有反映 NICE 5 的新規則。
   - 快照中結束原因是 `unknown` 的那 1 個 step，所在回合現在不會分段。
   - 計畫第 8 項有另外寫出「2,144 個中 1 個」，資訊有揭露。如果要精確，可以在證據檔註明那個回合現在照舊送全文。
3. **殘餘風險（只記錄，不必修）**
   - 現在分段完全依賴 `step_finish.part.reason` 是字串 `tool-calls`。
   - 如果 opencode 哪天改名或拿掉這個欄位，所有回合都會安靜地退回送全文。這是安全的退化，但不會有任何錯誤。
   - 下次升級 opencode 釘版、重新擷取 `tests/fixtures/opencode/` 的樣本時，`1.18.34-tool-use` 那類測試會抓到這個變化。

第一輪的 NICE 4～8 都已處理，查核結果見下文。

## 已查核維度
### 增量修正的查核
**NICE 5：非最後的 step 有文字、但不是 tool-calls 時不分段**
- 位置：`src/core/reply-parts.ts:65`。
- 查過的幾條可能誤殺正常回合的路徑：
  - **step_finish 缺 reason**：串流時 `parseStreamLine` 給 `stepFinished: {}`，非串流時 `event.part?.reason` 是 undefined，兩條路徑都會變成不分段。這是安全退化，見殘餘風險。
  - **step_finish 整個缺漏**：前後兩段文字會併成同一個 step，不會產生「非 tool-calls 的 step」。
  - **串流的 trailing buffer**：stdout 結尾沒有換行時，close 階段解析最後一行，`trailing.stepFinished.reason` 照樣傳給 `finishStep()`。正常的 `stop` 只會出現在最後一個 step，所以不受這條規則影響。
  - **非 tool-calls、但清洗後是空的 step**：照常略過，不阻擋分段（探測第 9 例）。
- 正常的 tool-calls 加 stop 回合，在串流和非串流都照常分段，用的是真實 1.18.34 fixture 的測試。
- 新測試：「SCN-001 定義：非最後的 step 有文字但不是以 tool-calls 結束」。
- 變異：拿掉這個檢查，新測試失敗。

**NICE 7：新增的必填參數 `shownText`**
- 兩條路徑傳的值：
  - 串流的兩個成功出口在呼叫 `successResult()` 之前，都已經做過 `aggregatedText = this.cleanOutput(aggregatedText)`，所以傳進去的是清洗後的全文。
  - 非串流傳 `clean(text)`，`text` 是 `join('').trim()` 的結果，和後面 `structured.text` 的值相同。
- 兩條路徑等價：以真的 `cleanOutput` 對 14 種情況各跑兩條路徑，結果全部相同。這 14 種是：基本、推理文字、前後空白、CRLF、step 開頭的 `> build ·`、工具結果行、只有開頭的 think 標籤、缺 reason、空的非 tool-calls step、step 內的 `<thinking>`、ANSI 色碼、大寫標籤、一段裡有多個結束標籤、小量的 function 外洩。
- 為什麼正常回合不會被誤判：
  - 每段的開頭在逐段清洗時一定是行首，所以全文清洗只可能在跨 step 的邊界多刪東西，不會比逐段少刪。
  - `cleanOutput` 不會改動段落內的空白。
  - 每段都已 trim 過。
  - 所以只有跨 step 的結構才會讓某段不在全文裡，例如沒有在同一個 step 關閉的 `<thinking>` 或 `<function>`，或整份全文觸發外洩警示。這正是要擋的情況。
- 呼叫者：grep 確認 `build()` 有 2 處正式呼叫（cli-agent-base 的 `successResult()`、opencode 的 `parseOpencodeJsonOutput()`），另外測試與 `step4-corpus-check.ts` 都已改成兩個參數。
- 紅燈可信度：以 `git archive cc6caa1` 把修正前的 src 與 tests 解到 scratchpad，換上 51b8e1c 的測試檔重跑。13 支中 3 支失敗，就是新增的那 3 支，與實作者的記錄一致。這個做法沒有動到 repo 的 worktree 或 stash，scratchpad 副本已刪除。
- 變異：拿掉全文一致性檢查，跨 step `<thinking>` 與外洩警示兩支測試失敗。去掉 think 標籤那一步沒被抓到，見 NICE TO HAVE 1。

**NICE 8：型別整理**
- 改了什麼：`Fence` 提到檔案層，`toggleFence` 的簽章改用它；新增 `SendFoldedReplyOptions` 介面，`Connector` 與 `TelegramConnector` 都改用它；`StepTextCollector` 的說明註解移到 class 上方。
- 沒有改變行為：欄位完全相同；build、lint、全部測試都通過；renderer 與 helpers 傳的物件常值型別相容。

**NICE 4、6：文件**
- 計畫設計第 1 點寫明：只有一個 step 但含 think 結束標籤時，SCN-005 優先於 SCN-002，依據是 Q3 的答案。這與實作和 `opencode-reply-parts:164` 的測試一致。
- 步驟 3 的測試描述改成實際做法：SCN-007 只有上游錯誤一例，其餘降級出口以讀碼確認不帶 `replyParts`。
- 規格本身沒有改。
- CLAUDE.md 的 `folded-reply.ts` 那一列補上「每段都要出現在清洗後的全文裡才分段」。「以 tool-calls 結束的 step 為過程」這個說法現在與實作一致（第一輪 NICE 5 的措辭問題已消失）。

所有變異都用 `git checkout --` 還原，結束時 `git status` 乾淨。

### 驗收與證據
前兩輪對 SCN-001～SCN-012 的結論仍然成立：
- 這次增量只動了 `reply-parts.ts` 的分段條件、`build()` 的兩個呼叫點，以及純型別整理。組版、送出、pipeline、排程都沒有改。
- 前兩輪引用的測試全部通過。
- SCN-001 的過程定義、SCN-003 與 SCN-009 的「顯示不多於全文」都多了覆蓋。
- 新規則只會讓更多回合不分段、照舊送全文。不分段時走的是 SCN-002 的舊路徑，不會帶來顯示上的新風險。

### 相關失敗面
| 情況 | 判定 |
|---|---|
| 結束原因不明或缺 reason | 通過，退化成送全文 |
| 跨 step 的清洗結構 | 通過 |
| 逐段的外洩警示 | 通過 |
| 串流與非串流的 shownText 等價 | 通過 |
| think 標籤在段落中間 | 程式正確但沒有測試，見 NICE TO HAVE 1 |
| 其餘失敗面 | 沿用前兩輪結論 |

### 需求、架構、安全、品質
- 修正都在原本的模組裡完成，新增的兩個條件各一行，沒有新的抽象。
- `build()` 改成必填參數，呼叫端不會忘記傳全文。
- 變更檔通過 `prettier --check`。
- 這次增量沒有新的證據樣本，沒有 token、聊天 ID 或正式回覆原文（L-10）。

### 執行結果
| 命令 | 結果 |
|---|---|
| `npm run build` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test` | exit 0，`# tests 821`、`# pass 821`、`# fail 0` |

測試數比 2eafbb6 的 818 多 3 支，正好是這次新增的；測試檔仍是 94 個（L-01）。

### 豁免、待確認與限制
- 沒有 Gate 豁免；TBD-1～4 都已解決。
- 限制：reviewer 手上沒有步驟 1 的快照，「用真的 cleanOutput 重跑語料、85 個回合仍全部分段」以計畫的記錄為準。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
