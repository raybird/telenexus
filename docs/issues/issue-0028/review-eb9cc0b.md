# 審查報告
- 範圍：完整 diff（本機流程，無 PR）`git diff 79b081d eb9cc0b`，4 個提交（f1f8336、17b4cb3、933f5ce、eb9cc0b），31 個檔案，+1795／−75
- Reviewed BASE SHA：79b081d3087c0ad5aceec40a3803aa8de730754b
- Reviewed HEAD SHA：eb9cc0bd946de31d69290360e1fc71369beb76e5
- Reviewed patch-id：8470c2fca4c29dd961f0e5ba7dacc47c8950d79f（重算結果相同）
- 獨立 reviewer：Claude（Opus 5.5）隔離 subagent，不是實作者；只讀，沒有修改、提交或推送，也沒有呼叫 Telegram 或任何外部服務
- Review artifact：docs/issues/issue-0028/review-eb9cc0b.md
- 核准基線：17b4cb300ab264023e5386671d2fa45d0df0c367。依 acceptance.md 的推導命令重跑後得到這個值。`git diff 17b4cb3 eb9cc0b -- docs/issues/issue-0028/README.md` 只改了 `**狀態**` 一行（「步驟 1～3 完成」改成「步驟 1～6 完成，等待本機獨立審查」）。Gherkin、核准來源與核准表在這之後都沒有變動。

## 問題與風險

### MUST FIX
無

### SHOULD FIX
1. **結論只剩標記時仍然摺疊，畫面只看到 `[Opencode]`**
   - 位置：`src/core/message-pipeline-chat.ts:134`。
   - 問題：`toFoldedReply()` 用 `!conclusion` 判斷結論是不是空的，但這時結論已帶 `[Opencode]` 前綴，清掉 SEND_FILE 與 MEMORY_INTENT 之後至少還剩 `"[Opencode]"`，判斷永遠不會成立。
   - 實測：本機跑腳本，`toFoldedReply({ process: ['我來產生報告。'], conclusion: '[Opencode] [[SEND_FILE:/tmp/a.pdf]]' })` 回 `{ conclusion: '[Opencode]', process: ['我來產生報告。'] }`。MEMORY_INTENT 只放在最後一個 step 的情況結果一樣。
   - 影響：使用者只看到一行 `[Opencode]` 加一段摺起來的「過程」，模型真正說的話全被摺起來。變更前這些文字會直接顯示。這違反 SCN-003 的本意（最後一個 step 沒有可見文字時不摺疊），也是 README「最大風險」的極端版本。
   - 頻率：步驟 1 盤點的 85 個回合結論最短 103 字，沒有這種情況，所以很少見。但「說明後呼叫工具產檔，最後只輸出 `[[SEND_FILE:…]]`」在小模型上是合理會出現的寫法。
   - 建議：改用 pipeline 既有的 `hasVisibleText(conclusion)` 判斷，並補一支測試（結論只有 SEND_FILE 或 MEMORY_INTENT 時 `folded` 為空，照舊送全文）。
   - 不需改規格。

### NICE TO HAVE
1. **過程裡有 Markdown 引言時，送出的文字會變成 `>>`，未實測**（`src/telegram/render/folded-reply.ts:67`）
   - 現象：`renderMarkdownV2('> 注意')` 輸出 `>注意`，包進可展開引言後變成 `>>注意`。
   - 未驗證：步驟 2 和步驟 5 都沒有測這種寫法，reviewer 也不能呼叫 API 確認。依 Telegram 的規則，行中的 `>` 是保留字元，推測會被以 parse error 拒收。
   - 影響：被拒收時會走 SCN-006 的純文字退回，內容不丟，但整則（含結論）失去格式。
   - 建議：在引言內把渲染行開頭的 `>` 跳脫或去掉，或下次實測時加這個樣本。
2. **`reply-parts.ts:47` 的 `last.reason === 'tool-calls'` 判斷沒有測試保護**
   - 變異：把它改成 `if (!last)`，`opencode-reply-parts` 與 `dynamic-agent-reply-parts` 的 12 支測試仍全過。
   - 這個判斷防的情況：回合在一個有文字、以 tool-calls 結束的 step 後就停了（例如非 0 結束但有文字的成功出口）。
   - 建議：補一支 fixture 測試。
3. **串流摺疊路徑的 `messageThreadId` 沒有測試保護**（`src/core/telegram-stream-renderer.ts:534`）
   - 變異：拿掉這一行，全套 813 支測試仍全過。
   - 影響：論壇主題（topic）的回覆會跑到 General。
   - 建議：pipeline 串流測試加一個帶 thread id 的情況。
4. **SCN-002 與 SCN-005 字面上有衝突，README 沒寫明優先順序**
   - 衝突：只有一個 step、但含 think 結束標籤的回合，SCN-002 的 Given「只有一個 step」要求與變更前逐字相同，SCN-005 要求摺疊推理文字。
   - 實作的選擇：`tests/opencode-reply-parts.test.ts:164` 明確選了 SCN-005，這也符合概述（推理文字「一併摺進過程」）與 Q3 的答案。
   - 建議：在 README 或 plan 註明「think 推理文字優先於 SCN-002」。
5. **程式與文件對「過程」的定義不一致**
   - 程式：`reply-parts.ts:58` 把最後一個 step 以外的所有 step 都當過程，不論結束原因。
   - 文件：程式註解（`reply-parts.ts:6`）、CLAUDE.md、ARCHITECTURE.md 都寫「以 tool-calls 結束的 step」。
   - 評估：opencode 在非最後的 step 實際上都是 tool-calls，步驟 4 的語料檢查也是這樣假設，所以影響很小。建議把措辭對齊實作，或只收 tool-calls。
6. **SCN-007 的測試比計畫少**
   - 計畫：步驟 3 的「測試」段寫「逾時／限流／上游錯誤各一例」。
   - 實際：只有上游錯誤一例（`tests/opencode-reply-parts.test.ts:193`）。
   - 為什麼目前沒問題：逾時、限流、中止都由 `buildTextOnlyStructuredResult()` 組結果，不經 `successResult()`，所以結構上不會帶 `replyParts`。reviewer 逐一讀過 `cli-agent-base.ts` 與 `opencode.ts` 的各個出口確認。
   - 建議：計畫的描述改成實際做法，或補測試。
7. **`cleanOutput` 的垃圾偵測是逐段判斷，可能與全文判斷不一致**
   - 機制：`cleanOutput` 遇到大量 `</function>` 時會把整段換成警示句。
   - 不一致的情況：全文被換成警示句時，`replyParts` 的各段可能沒有觸發，結果是全文顯示警示、摺疊版面卻顯示內容；反過來也可能。
   - 評估：極少見，可接受。
8. **小幅精煉**
   - `folded-reply.ts` 的 `{ line; close }` fence 型別寫了兩次（`splitSegment` 裡的 `Fence` 與 `toggleFence` 的簽章），可以提到檔案層。
   - `sendFoldedReply` 的 options 型別在 `types/index.ts` 與 `telegram.ts` 各寫一份，沿用 `sendMessage` 的既有寫法，可接受。
   - `reply-parts.ts` 開頭的說明註解放在 `type StepText` 上方，比較像是 `StepTextCollector` 的說明。

## 已查核維度

### 驗收與證據
- **SCN-001**：通過。
  - 解析層：`tests/opencode-reply-parts.test.ts:73,83`，用真實的 1.18.34 fixture 加手寫多 step 樣本，串流與非串流各跑一次。
  - 組版：`tests/telegram/render-folded-reply.test.ts` 第一支測試，逐字比對 `**>過程`、空的引言行、`||`。
  - pipeline：`tests/message-pipeline.test.ts` 的「SCN-001／SCN-008（stream／non-stream）」。
- **SCN-002**：通過。
  - 單一 step 與「工具呼叫前沒說話」兩種情況都沒有 `replyParts`（`opencode-reply-parts:109,116`）。
  - pipeline 沒有 `replyParts` 時照舊呼叫 `sendMessage`（「SCN-002：沒有 replyParts 時照舊送全文」）。
  - 程式路徑：`foldedReply` 為 undefined 時，`finalize`／`deliverFinalResponse` 走的程式碼與變更前相同，所以逐字相同在結構上成立。
  - 例外：見 NICE TO HAVE 第 4 點。
- **SCN-003**：通過。`opencode-reply-parts:131`（最後一個 step 沒有文字）、`:178`（最後一個 step 全是推理文字）。缺口見 SHOULD FIX 第 1 點與 NICE TO HAVE 第 2 點。
- **SCN-004**：通過。
  - `render-folded-reply` 的三支 SCN-004 測試：多段、單段超長、超長程式碼區塊。每支都斷言每則 ≤4096、引言完整、fence 成對、每個字詞都在。
  - 計畫記錄的變異檢查：關掉 fence 追蹤時測試會失敗。
  - 本機語料（`evidence/step4-corpus-check.md`）：391 個回合、404 則，缺字詞 0、超長 0、引言不完整 0，反向自檢抓得到遺漏。
  - reviewer 另外實測：單行 5000 個 `.`、3000 組 `_a_`、400 項清單、300 列表格、巢狀 fence（```` ````md ```` 內含 ```` ``` ````），每則都 ≤4096、fence 成對。
- **SCN-005**：通過。`opencode-reply-parts:146,164`，推理文字進過程，兩個標籤都不留。
- **SCN-006**：通過。
  - `tests/telegram/connector-folded-reply.test.ts` 用 parse error 替身驗證：純文字由原文組成、不含 `**>`／`||`，超長時只有被拒收的那則退回。
  - `render-folded-reply` 的 SCN-006 測試檢查每則的 plain 版本。
  - 計畫記錄的變異檢查：退回時忽略 `plainFallback`，這兩支測試會失敗。
  - 補充：結論被切成多則時，結論那幾則沿用原本的退回（把已渲染的 MarkdownV2 當純文字送）。這些訊息不含引言標記，仍符合規格。
- **SCN-007**：通過，理由見 NICE TO HAVE 第 6 點。
  - 測試：上游錯誤一例。
  - 程式碼：逾時、限流、中止、`🛑 任務已取消`、`Error calling runner` 的出口都不帶 `replyParts`，pipeline 因此走舊路徑。
- **SCN-008**：通過。
  - 標記：pipeline 串流與非串流兩種模式都斷言 SEND_FILE 與 MEMORY_INTENT 在過程和結論裡都移除、檔案照送（caption 正確）、intent 有記錄。
  - runner 與本機：`tests/dynamic-agent-reply-parts.test.ts` 用本機 HTTP 模擬 runner，串流與非串流都帶回相同的 `replyParts`，前綴只加在結論。
  - 程式碼：`src/runner.ts` 本來就序列化整個 `structured`。
- **SCN-009**：通過。
  - 聊天：pipeline 測試斷言儲存的是清掉標記後的全文。摘要追問與 recall 仍用同一個 `cleanedResponse`，程式路徑沒改。
  - 排程：`tests/scheduler-folded-reply.test.ts` 斷言記憶、Memoria 同步與重試判斷都用全文，重試後送出的是第二次的結果。
- **SCN-010**：通過。
  - 步驟 2 送 7 則有效樣本加 1 則刻意寫錯的；步驟 5 用 `buildFoldedMessages()` 與 connector 的渲染實際產生 7 則，全部 `ok: true`。
  - 使用者在手機上確認「都正常」。
  - 版本：`git diff 933f5ce eb9cc0b -- src` 為空，步驟 5 的樣本就是被審查的程式產生的。
- **SCN-011**：通過。`scheduler-folded-reply` 的 SCN-011 測試，加上 connector／render 測試對排程標頭的跳脫與第一行位置。
- **SCN-012**：通過。
  - 測試：排程沒有過程時仍走 `sendFoldedReply`、`process` 為空，connector 送出 MarkdownV2、不產生引言（connector 測試 SCN-012）。
  - 語料：步驟 4 含 386 個排程回合，字詞保留檢查缺字詞 0。

### 相關失敗面
| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| 串流與非串流的 step 分段 | 兩條路徑結果相同 | `runBoth` 跑真實的 `OpencodeAgent` | 通過 |
| tool_only 追問 | 首輪沒有文字，以追問的結果為準 | 讀碼：追問走 `chatStructured()`，首輪沒有可保留的過程 | 通過（符合設計第 2 點） |
| think 標籤（多個、只在最後、只有開頭標籤） | 取最後一個結束標籤之前；標籤全部去掉 | 測試 2 支加讀碼；只有開頭標籤時維持舊行為 | 通過 |
| 降級結果 | 不帶 replyParts | 上游錯誤有測試，其餘讀碼確認 | 通過 |
| 4096 切段：程式碼區塊、單行超長、表格、清單 | 每則完整、字詞都在 | 單元測試、語料加 reviewer 的探測 | 通過 |
| 純文字退回超長 | 依行切多則 | `sendChunkRaw` 用 `splitMessage(plainFallback)` 切；connector 測試覆蓋 | 通過 |
| 結論只剩 SEND_FILE／MEMORY_INTENT | 不摺疊 | 無測試；實測會摺疊 | SHOULD FIX 第 1 點 |
| 過程裡有 Markdown 引言 | Telegram 接受，或退回純文字 | 無；拒收時仍走 SCN-006 | NICE TO HAVE 第 1 點 |
| 非 Telegram 連接器 | 照舊送全文 | `sendFoldedReply` 是可選方法；排程的退回有測試；pipeline 與 renderer 會先檢查方法存在 | 通過 |
| 論壇 topic 的 thread id | 摺疊版面送到同一個 thread | 有實作、無測試 | NICE TO HAVE 第 3 點 |
| Web Console | 不在範圍，行為不變 | `streamResponse` 路徑沒改 | 通過 |
| passthrough 指令 | 不分段 | `toStructuredResult` 在 passthrough 時不呼叫 `parseOpencodeJsonOutput` | 通過 |

### 需求、架構、安全、品質
- **架構**：分段在解析層（`reply-parts.ts`），組版在 render 層（`folded-reply.ts`），連接器以可選方法擴充。分層清楚。`withChatPrefix()` 讓四個出口共用前綴邏輯，`successResult()` 讓兩個成功出口共用結果組裝，`sendChunkRaw()` 的退回只有一份。沒有看到跨 Task 的重複邏輯或過度設計。`splitSegment` 稍嫌複雜（約 45 行），但它在原始 Markdown 這一層切段（chunker 是在渲染後切），因為每則引言必須各自完整，這個分工有道理。
- **安全**：證據檔與樣本都是合成內容，沒有 token、聊天 ID 或正式回覆原文。以 grep 檢查 bot token 樣式與長數字 ID，沒有命中（L-10）。新的 log 只記則數與段數，不記內容。
- **格式**：變更的 src／tests 檔案通過 `prettier --check`。

### 執行結果
- `npm run build`：exit 0。
- `npm run lint`：exit 0。
- `npm run test`：exit 0，`# tests 813`、`# pass 813`、`# fail 0`。`tests/` 下有 94 個測試檔，與計畫記錄的 813 支、94 個檔相符（L-01）。
- 變異檢查：兩次，都在結束前用 `git checkout --` 還原。最後 `git status` 是乾淨的。

### 豁免、待確認與限制
- 無 Gate 豁免。README 的 TBD-1～4 都是已解決。
- 限制：reviewer 不能呼叫 Telegram，所以 NICE TO HAVE 第 1 點（`>>`）是依 MarkdownV2 規則推測，沒有實測。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
