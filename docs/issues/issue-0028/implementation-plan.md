# Implementation Plan - Issue 0028

驗收規格與核准見 [README.md](./README.md#gherkin-驗收劇本)；風險與首要驗證只在 [README](./README.md#風險與首要驗證) 維護，本檔不重寫。

## 前置分析

### 現況（2026-11-16 讀程式碼確認）

- opencode `--format json` 每個 `text` 事件是一段完整文字，不是逐字 delta。`tests/fixtures/opencode/1.18.34-tool-use.stdout.jsonl` 是實例：第一個 step 的文字「I'll run that command now.」後接 `tool_use`，該 step 的 `step_finish.part.reason` 是 `tool-calls`；第二個 step 的文字「The command printed `tool-probe-42`.」以 `reason: stop` 結束。
- 串流路徑 `src/core/cli-agent-base.ts:343` 以 `aggregatedText += parsed.deltaText` 不加分隔接起各段，結束時對整串跑一次 `cleanOutput()`（`:475`、`:567`）。`interpretEvent()` 已把 `step_finish` 的 `reason` 放進 `stats`，但只保留最後一筆。
- 非串流路徑在 `src/core/opencode.ts` 解析整份 stdout 後產生 `structured.text`（`:409`），同樣是全文。
- `src/core/agent.ts` 在 runner 與本機兩條路徑都把 `[Opencode] ` 加在全文前；`fromRunnerStructured()`（`:16`）只複製 `sessionId`、`stats`、`failure`，新欄位不會自動帶過來。
- `src/core/message-pipeline.ts` 對全文依序做 `normalizeAgentResponse()`（抽 SEND_FILE）、`parseMemoryIntent()`，接著儲存（`persistModelResponse`）、送 Telegram（`telegramStreamRenderer.finalize()` 或 `thinkingMessenger.deliverFinalResponse()`）、摘要追問。
- `TelegramStreamRenderer.finalize()` 預設送新訊息（`finalizeAsNewMessage` 跟著 reasoning 模式，預設開），長度在 3900 以內且關掉新訊息時才就地編輯；兩條都用 MarkdownV2。
- `TelegramConnector.sendMessage(parseMode: 'markdown-v2')` 先 `renderMarkdownV2()` 再 `chunkMarkdownV2(…, 4096)`；chunker 只認得 code fence，會把引言切在任意一行。拒收時 `sendChunkRaw()` 把同一段已渲染的 MarkdownV2 原樣當純文字重送，所以引言標記會外露。
- 排程走 `connector.sendMessage(userId, header + response)`，不帶 `parseMode`，不受本 issue 影響。

### 設計

1. **在解析層保留分段**。串流與非串流路徑都依 step 收集文字：遇到 `step_finish` 時把該 step 累積的文字標成 `tool-calls`（過程）或其他原因。回合結束時：
   - 最後一個有文字的 step 不是以 `tool-calls` 結束 → 它的文字是結論，之前各 step 的文字依序為過程段落。
   - 只有一段，或沒有任何 `tool-calls` step 有文字 → 沒有過程（SCN-002）。
   - 最後一個 step 沒有文字 → 不分段（SCN-003）。
   - 每段各自 `cleanOutput()`，空段捨棄。
   - think 結束標籤：段落裡標籤前的文字移到過程（成為一段），標籤後的文字留在原處（SCN-005）。兩個標籤本身沿用 #27 的處理不輸出。
2. **結果型別**。`AgentStructuredResult` 新增可選欄位（暫名 `replyParts: { process: string[]; conclusion: string }`），只有確實分出過程時才帶。`text` 維持現在的全文，儲存與摘要照舊（SCN-009）。`fromRunnerStructured()` 帶上新欄位，runner 的 HTTP 回應本來就序列化整個 `structured`。降級結果（`failure` 有值、中止）不帶（SCN-007）。tool_only 追問的回合以追問的文字為結論，首輪若有過程文字一併保留為過程。
3. **組裝**。pipeline 對全文的既有處理不變；另外對 `replyParts` 的每一段做同樣的 SEND_FILE 與 MEMORY_INTENT 移除（SCN-008），`[Opencode] ` 加在結論前。把顯示用的過程與結論交給 `finalize()`／`deliverFinalResponse()`；沒有 `replyParts` 時走原本的單一字串路徑（SCN-002 逐字相同）。
4. **渲染與切段**。過程渲染成 MarkdownV2 可展開引言：第一行 `**>過程`，各段之間空一個引言行，最後一行結尾加 `||`。結論加過程在 4096 以內時一則送出；超過時結論照現有方式切段送出，過程依段落切成多則，每則都是完整的可展開引言（SCN-004）。確切寫法以步驟 2 的實測為準。
5. **純文字退回**。帶過程的訊息被以 parse error 拒收時，改送由原文組成的純文字版本（結論、空行、「過程」、各段），不送已渲染的 MarkdownV2（SCN-006）。

## 實作步驟

1. 📝 **步驟 1：唯讀盤點正式部署的 opencode.db**（SCN-001、SCN-003；TBD-1）
   - 做法：使用者授權後，以 `sqlite3 .backup` 從 runner 容器的 `/home/node/.local/share/opencode/opencode.db` 複製快照到 scratchpad，不修改線上檔案；只查聊天 session（排除排程與探針）。
   - 產出：`evidence/step1-inventory.md`，只放統計與判定，不放回覆原文（地雷 L-10）：聊天回合總數；有過程的回合數與比例；最後一段的長度分布；「最後一段 80 字以內且前一個 step 有工具呼叫」的回合數，從中抽樣（至少 20 則，不足則全數）判定最後一段是不是結論；含 think 結束標籤的回合數。
   - 相依：無。
   - 完成判準：統計與抽樣判定寫入證據檔，回報使用者；使用者對 TBD-1 給出結論（維持規格，或修訂後重新核准受影響的 Scenario）。
2. 📝 **步驟 2：開發用 bot 實測可展開引言**（SCN-004、SCN-006、SCN-010 的前提；TBD-2）
   - 做法：使用者提供開發用 bot 的 token 與實測時機後，直接呼叫 Bot API `sendMessage`（不 poll）送樣本：最小的可展開引言；引言裡有清單、粗體、行內程式碼、程式碼區塊；結論加引言接近 4096；只有引言的訊息；刻意寫錯的樣本，確認錯誤訊息的形狀以及 `isParseModeError()` 認得它。
   - 產出：`evidence/step2-telegram-probe.md`，記錄每則樣本的 MarkdownV2 原文、回應（`ok` 或錯誤描述），以及使用者在手機上看到的摺疊效果。
   - 相依：無（可與步驟 1 並行）。
   - 完成判準：設計第 4 點的寫法得到 `ok: true` 且使用者確認摺疊；被拒收的寫法列出替代寫法並重測通過。
3. 📝 **步驟 3：解析層保留過程與結論**（SCN-002、SCN-003、SCN-005、SCN-007、SCN-008 的路徑一致部分）
   - 產出：`cli-agent-base.ts`、`opencode.ts`（必要時 `opencode-event-parser.ts`）、`agent-result.ts`、`agent.ts` 的修改與測試。
   - 測試：以 `1.18.34-tool-use.stdout.jsonl` 與手寫的多 step fixture 驅動串流與非串流路徑，斷言 `replyParts` 的過程與結論（期望值取自 fixture 的字面文字）；只有一個 step、最後一個 step 沒有文字、含 think 標籤、逾時／限流／上游錯誤各一例；runner 路徑（`dynamic-agent-runner-stream`）與本機路徑結果相同；`text` 與變更前相同。
   - 相依：步驟 1（TBD-1 有結論）。
   - 完成判準：上述測試先紅後綠，紅綠重構證據寫回本步驟；`npm run build` 通過。
4. 📝 **步驟 4：組裝、渲染與送出**（SCN-001、SCN-004、SCN-006、SCN-008、SCN-009）
   - 產出：pipeline、`telegram-stream-renderer.ts`、`message-pipeline-helpers.ts`、`markdown-v2.ts`／`chunker.ts`、`connectors/telegram.ts` 的修改與測試。
   - 測試：`telegram-stream-renderer-finalize` 斷言送出的訊息順序與內容（結論在前、引言第一行「過程」、各段分開）；超長樣本斷言每則都是完整引言且全部字詞都在（沿用 #27 的字詞保留檢查）；模擬 parse error 斷言純文字版本不含 `**>`、`||`；SEND_FILE、MEMORY_INTENT 在過程與結論中都被移除、檔案照送；`persistModelResponse` 與摘要追問收到的文字與變更前相同；沒有 `replyParts` 的回覆輸出與變更前逐字相同。
   - 相依：步驟 2、步驟 3。
   - 完成判準：上述測試先紅後綠並記錄證據；`npm run build`、`npm run test`（核對 `# tests` 數量，地雷 L-01）、`npm run lint` 全部 exit 0。
5. 📝 **步驟 5：實機驗收**（SCN-010）
   - 做法：以開發用 bot 送出步驟 4 實際產生的訊息（至少一則一般長度、一則超長、一則含清單與程式碼），或在開發 stack 跑一個會呼叫工具的真實回合；時機由使用者決定。
   - 產出：`evidence/step5-device-check.md`。
   - 相依：步驟 4。
   - 完成判準：每則 `ok: true`，使用者在手機上確認過程預設摺疊、可展開、結論在前。
6. 📝 **步驟 6：常青文件**
   - 產出：`CLAUDE.md` Key Modules 表（`markdown-v2.ts` 與 `telegram-stream-renderer.ts` 相關說明）、`ARCHITECTURE.md` 訊息流程、`README.md` 功能說明。
   - 相依：步驟 4。
   - 完成判準：三份文件描述的行為與實作一致。

## 使用方式對照

| 情況 | 變更前 | 變更後 |
|------|--------|--------|
| 會呼叫工具且途中有說話的提問 | 一則：`[Opencode] 數據已到手。接著抓……（結論）` | 一則：`[Opencode]（結論）`，下面是摺疊的「過程」 |
| 直接回答、沒有工具 | 一則全文 | 不變 |
| 超長回覆 | 依行切成多則 | 結論的切段不變，過程另起摺疊引言 |

## 測試策略

| Scenario | 層級 | 策略 |
|---|---|---|
| SCN-001 | 單元＋整合 | 解析層產出分段（步驟 3）；renderer finalize 的送出內容（步驟 4） |
| SCN-002 | 整合 | 沒有過程的回覆新舊輸出逐字相同 |
| SCN-003 | 單元 | 最後一個 step 沒有文字的 fixture |
| SCN-004 | 單元＋整合 | 切段後每則都是完整引言；字詞保留檢查 |
| SCN-005 | 單元 | 含 think 結束標籤的 fixture |
| SCN-006 | 整合 | 模擬 Telegram parse error |
| SCN-007 | 單元 | 降級結果不帶 `replyParts`，送出內容不變 |
| SCN-008 | 整合 | 標記移除、檔案照送；runner 與本機、串流與非串流一致 |
| SCN-009 | 整合 | 儲存與摘要追問收到的文字不變 |
| SCN-010 | 實機 | 步驟 2 先驗寫法，步驟 5 驗實際產出 |

外迴圈以標注 Scenario ID 的整合測試承擔（repo 沒有 BDD runner）；與單元測試同層者依 verification.md 合併並記錄理由。

## 檢查清單

- [ ] 步驟 1 證據不含回覆原文，TBD-1 有結論
- [ ] 步驟 2 的寫法得到 Telegram 接受
- [ ] 沒有過程的回覆新舊輸出逐字相同
- [ ] 儲存與摘要追問的文字不變
- [ ] `npm run build`、`npm run test`、`npm run lint` 通過，`# tests` 數量相稱
- [ ] GitNexus impact 與 grep 核對呼叫者（project.md 本地 gate）
- [ ] 常青文件已更新
