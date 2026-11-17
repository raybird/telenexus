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
- 排程經 `runScheduledChat()` → `taskAgent.chat()`（非串流的 chat 任務，同樣帶 `[Opencode]` 前綴），再以 `connector.sendMessage(userId, header + response)` 送出，不帶 `parseMode`：單則時 auto 模式把 Markdown 轉成 HTML，超過一則時以純文字送出。範圍是否納入排程待 TBD-4。

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
6. **排程**（SCN-011、SCN-012）。`runScheduledChat()` 改取 structured 結果（`taskAgent.chat()` 只回字串），`assessAiResponse()`、`persistSchedulerMessage()` 照舊吃全文（SCN-009）。送出改為 `sendMessage(…, { parseMode: 'markdown-v2' })`：排程標頭（`🕐 [排程: 名稱]`，名稱需跳脫）在第一行，接著是與聊天相同的結論＋摺疊過程版面。組版面的邏輯與聊天共用一個函式，不各寫一份。排程失敗的錯誤訊息照舊。

## 實作步驟

1. ✅ **步驟 1：唯讀盤點正式部署的 opencode.db**（SCN-001、SCN-003；TBD-1）
   - 結果（2026-11-16）：[evidence/step1-inventory.md](evidence/step1-inventory.md)。有過程的 85 個回合，結論最短 103 字，沒有「結論很短、前一步有工具」的回合；結論最短的 20 個中 19 個的最後一段是結論，1 個是 think 推理文字（依 SCN-005、SCN-003 處理）。另發現 85 個中 83 個是排程結果。使用者同日對 TBD-1 選維持分界規則、對 TBD-4 選納入排程（規格修訂見 README Timeline）。
   - 做法：使用者授權後，以 `sqlite3 .backup` 從 runner 容器的 `/home/node/.local/share/opencode/opencode.db` 複製快照到 scratchpad，不修改線上檔案；只查聊天 session（排除排程與探針）。
   - 產出：`evidence/step1-inventory.md`，只放統計與判定，不放回覆原文（地雷 L-10）：聊天回合總數；有過程的回合數與比例；最後一段的長度分布；「最後一段 80 字以內且前一個 step 有工具呼叫」的回合數，從中抽樣（至少 20 則，不足則全數）判定最後一段是不是結論；含 think 結束標籤的回合數。
   - 相依：無。
   - 完成判準：統計與抽樣判定寫入證據檔，回報使用者；使用者對 TBD-1 給出結論（維持規格，或修訂後重新核准受影響的 Scenario）。
2. ✅ **步驟 2：實測可展開引言**（SCN-004、SCN-006、SCN-010 的前提；TBD-2）
   - 結果（2026-11-16）：[evidence/step2-telegram-probe.md](evidence/step2-telegram-probe.md)。7 則有效樣本都 ok=true，刻意寫錯的回 400 `can't parse entities`；使用者在手機上確認過程預設摺疊、可展開，段落之間留空的引言行。依 TBD-2 改以正式 bot 的 token 送出。
   - 做法：直接呼叫 Bot API `sendMessage`（不 poll）送樣本：最小的可展開引言；引言裡有清單、粗體、行內程式碼、程式碼區塊；結論加引言接近 4096；只有引言的訊息；刻意寫錯的樣本，確認錯誤訊息的形狀以及 `isParseModeError()` 認得它。
   - 產出：`evidence/step2-telegram-probe.md`，記錄每則樣本的 MarkdownV2 原文、回應（`ok` 或錯誤描述），以及使用者在手機上看到的摺疊效果。
   - 相依：無（可與步驟 1 並行）。
   - 樣本另含一則排程標頭開頭的訊息（SCN-011）。
   - 完成判準：設計第 4 點的寫法得到 `ok: true` 且使用者確認摺疊；被拒收的寫法列出替代寫法並重測通過。
3. ✅ **步驟 3：解析層保留過程與結論**（SCN-002、SCN-003、SCN-005、SCN-007、SCN-008 的路徑一致部分）
   - 實作（2026-11-16）：新增 `src/core/reply-parts.ts`（`StepTextCollector`：依 step 收文字，結束原因 `tool-calls` 的是過程，最後一個 step 是結論；段落裡最後一個 think 結束標籤前的文字歸入過程，兩個標籤不留；逐段套 `cleanOutput`）。`AgentStructuredResult.replyParts`；串流（`cli-agent-base.ts` 兩個成功出口共用 `successResult()`）與非串流（`parseOpencodeJsonOutput(stdout, clean)`）各自收集；`CliStreamParse.stepFinished` 帶 step 結束原因；`agent.ts` 的 `fromRunnerStructured()` 帶上 `replyParts`，`withChatPrefix()` 把前綴加在全文與結論前（四個出口共用）。runner 的 HTTP 回應本來就序列化整個 `structured`（`src/runner.ts` 的 result 事件），不需修改。
   - 外迴圈與單元合併：被測行為在 agent 的回傳值這一層就完整可觀察，假 `opencode` 跑真實的 `OpencodeAgent`（串流與非串流）與 `DynamicAIAgent`（runner 以本機 HTTP 模擬、本機替換 opencodeAgent），沒有另一層整合責任。
   - 紅燈：`npx tsx --test tests/opencode-reply-parts.test.ts` exit 1，9 個中 4 個失敗（SCN-001 前提 2 個、SCN-005 2 個），原因是回傳值沒有 `replyParts`（actual `undefined`）；其餘 5 個「不該分段」的情況在紅燈時已通過，作為回歸保護。`npx tsx --test tests/dynamic-agent-reply-parts.test.ts` exit 1，3 個中 2 個失敗：runner 路徑 `replyParts` 為 `undefined`（被 `fromRunnerStructured` 丟掉），本機路徑的結論沒有 `[Opencode]` 前綴。
   - 綠燈：同兩個檔案 12 個測試全過（exit 0）。期望值都是 fixture 與測試裡的字面文字，`1.18.34-tool-use.stdout.jsonl` 是真實 opencode 輸出。
   - 既有測試契約變更：`tests/opencode-stream-status.test.ts` 對 `parseStreamLine()` 的 step_finish 輸出做完整比對，補上新的 `stepFinished: { reason: 'tool-calls' }` 欄位，原有欄位的斷言不變。理由：核准行為需要 step 結束原因，這是新增的欄位。
   - 精煉：檢查變更後沒有實質可簡化之處（no-op）；`prettier --write` 只調整了新測試檔的換行。
   - 交付檢查：`npm run build` exit 0；`npm run test` exit 0，`# tests 793`、`# pass 793`，91 個測試檔（比主幹多的 12 個就是本步驟新增的測試）；`npm run lint` exit 0。
   - 影響分析：GitNexus impact 回報 LOW（`parseOpencodeJsonOutput` 0 個呼叫者、`runStreamChat` 1 個、`fromRunnerStructured` 查無此 symbol）；grep 實際呼叫點為 `parseOpencodeJsonOutput` 1 處（`opencode.ts` 的 `toStructuredResult`）、`fromRunnerStructured` 2 處、`parseStreamLine` 2 處，都在本次修改範圍內，新增的都是可選欄位。
   - 產出：`cli-agent-base.ts`、`opencode.ts`（必要時 `opencode-event-parser.ts`）、`agent-result.ts`、`agent.ts` 的修改與測試。
   - 測試：以 `1.18.34-tool-use.stdout.jsonl` 與手寫的多 step fixture 驅動串流與非串流路徑，斷言 `replyParts` 的過程與結論（期望值取自 fixture 的字面文字）；只有一個 step、最後一個 step 沒有文字、含 think 標籤、逾時／限流／上游錯誤各一例；runner 路徑（`dynamic-agent-runner-stream`）與本機路徑結果相同；`text` 與變更前相同。
   - 相依：步驟 1（TBD-1 有結論）。
   - 完成判準：上述測試先紅後綠，紅綠重構證據寫回本步驟；`npm run build` 通過。
4. ✅ **步驟 4：組裝、渲染與送出**（SCN-001、SCN-004、SCN-006、SCN-008、SCN-009、SCN-011、SCN-012）
   - 實作（2026-11-16）：新增 `src/telegram/render/folded-reply.ts` 的 `buildFoldedMessages()`，聊天與排程共用（設計第 6 點）：結論加過程在 4096 以內時一則；超過時結論照 `chunkMarkdownV2()` 切段，過程依段落另起一或多則完整引言，單段放不下時依行切，切在程式碼區塊裡會補上結尾 fence、下一則以同一個開頭 fence 接續。每則帶過程的訊息附原文組成的純文字版本。`Connector.sendFoldedReply?()`（`types/index.ts` 的 `FoldedReply`）由 `TelegramConnector` 實作，渲染沿用 `renderForMarkdownV2()`（含表格正規化）；`sendChunkRaw()` 加可選的最後參數 `plainFallback`，parse error 時改送它（過長則依行切），沒給時與變更前相同。pipeline 改取回合的 structured 結果，`toFoldedReply()`（`message-pipeline-chat.ts`）對每段做與全文相同的 SEND_FILE、MEMORY_INTENT 移除，清掉後沒有過程或結論為空時不摺疊；`TelegramStreamRenderer.finalize()` 與 `ThinkingMessenger.deliverFinalResponse()` 收到摺疊版面且連接器支援時改走 `sendFoldedReply()`，否則照舊。排程的 `runScheduledChat()` 改用 `chatStructured()`（沒有時退回 `chat()`），重試判斷與 `persistSchedulerMessage()` 照舊吃全文，連接器支援時一律以 `sendFoldedReply()` 送出（沒有過程時 `process` 為空，只送結論）。
   - 與原計畫的差異：不改 `markdown-v2.ts`／`chunker.ts`，組版放在新檔；renderer 的摺疊路徑由 pipeline 的串流測試走過真實的 `TelegramStreamRenderer`，不另寫 `telegram-stream-renderer-finalize` 的測試；摘要追問沿用同一個 `cleanedResponse`，程式路徑未改，以 pipeline 測試斷言儲存的全文代表 SCN-009。
   - 紅燈：在分支 HEAD（`17b4cb3`，尚無本步驟的實作）的暫時 worktree 放進新測試執行：`tests/telegram/render-folded-reply.test.ts` exit 1（`ERR_MODULE_NOT_FOUND` folded-reply.js）；`tests/telegram/connector-folded-reply.test.ts` exit 1，4 個全失敗（`connector.sendFoldedReply is not a function`）；`tests/scheduler-folded-reply.test.ts` exit 1，4 個全失敗（排程仍呼叫 `chat()`，沒有送出摺疊版面、重試次數 0）；`tests/message-pipeline.test.ts` exit 1，23 個中 2 個失敗（SCN-001／SCN-008 的串流與非串流：沒有呼叫 `sendFoldedReply`），SCN-002 與「過程清掉標記後是空的」2 個在紅燈時已通過，作為回歸保護。
   - 變異檢查：關掉 fence 追蹤時「超長程式碼區塊切在中間」失敗；退回時忽略 `plainFallback` 時 SCN-006 的 2 個測試失敗；兩者還原後全過。
   - 綠燈：上述 4 個檔案 39 個測試全過（組版 8、connector 4、排程 4、pipeline 23）。
   - 本機語料（SCN-004、SCN-012）：[evidence/step4-corpus-check.md](evidence/step4-corpus-check.md)。快照中 391 個有文字的回合（386 個排程、85 個有過程）送出 404 則，缺字詞 0、超過 4096 字 0、引言不完整 0、純文字版含引言標記 0；反向自檢少送一段過程時 85 個回合全被抓出。
   - 精煉：`sendFoldedReply()` 原本自寫一套 parse error 退回，改為 `sendChunkRaw()` 的可選參數，退回只剩一份；重跑受影響測試全過。
   - 交付檢查：`npm run build` exit 0；`npm run test` exit 0，`# tests 813`、`# pass 813`，94 個測試檔（比步驟 3 多 20 個測試、3 個檔案，都是本步驟新增）；`npm run lint` exit 0。
   - 影響分析：GitNexus impact `sendChunkRaw` CRITICAL（所有送訊息的共用路徑，直接呼叫者 `sendMessage`、`editMessage`），因此只加一個可選的最後參數，既有呼叫點都不傳、行為不變；`runScheduledChat` HIGH，唯一呼叫者 `executeTask` 在本次範圍內；`finalize`、`deliverFinalResponse` LOW。grep 實際呼叫點：`sendChunkRaw` 3 處（`sendMessage`、`editMessage` 的退回送出、新的 `sendFoldedReply`）、`finalize` 1 處、`deliverFinalResponse` 2 處（pipeline 的成功路徑帶摺疊版面，錯誤路徑不帶、行為不變）、`runScheduledChat` 2 處（首次與重試）。
   - 產出：pipeline、`telegram-stream-renderer.ts`、`message-pipeline-helpers.ts`、`markdown-v2.ts`／`chunker.ts`、`connectors/telegram.ts`、`scheduler.ts` 的修改與測試。
   - 排程測試：有過程的排程結果第一行是標頭、版面與聊天相同；沒有過程與超過一則的排程結果以 MarkdownV2 送出且字詞都在；重試判斷與 `persistSchedulerMessage` 收到全文。另以步驟 1 的快照（只在本機）把近 30 天排程結果跑過新的組版與轉換，統計缺字詞的則數，必須是 0，證據只記數字。
   - 測試：`telegram-stream-renderer-finalize` 斷言送出的訊息順序與內容（結論在前、引言第一行「過程」、各段分開）；超長樣本斷言每則都是完整引言且全部字詞都在（沿用 #27 的字詞保留檢查）；模擬 parse error 斷言純文字版本不含 `**>`、`||`；SEND_FILE、MEMORY_INTENT 在過程與結論中都被移除、檔案照送；`persistModelResponse` 與摘要追問收到的文字與變更前相同；沒有 `replyParts` 的回覆輸出與變更前逐字相同。
   - 相依：步驟 2、步驟 3。
   - 完成判準：上述測試先紅後綠並記錄證據；`npm run build`、`npm run test`（核對 `# tests` 數量，地雷 L-01）、`npm run lint` 全部 exit 0。
5. ✅ **步驟 5：實機驗收**（SCN-010）
   - 結果（2026-11-16）：[evidence/step5-device-check.md](evidence/step5-device-check.md)。以 `step5-samples.ts` 用實際的 `buildFoldedMessages()` 與 connector 渲染產生 5 個回覆共 7 則（一般長度、過程含清單與程式碼、排程有過程、超長拆成 3 則、排程沒有過程），依 TBD-2 以正式 bot 的 token 送出，7 則都 ok=true；使用者在手機上確認「都正常」。
   - 做法：以開發用 bot 送出步驟 4 實際產生的訊息（至少一則一般長度、一則超長、一則含清單與程式碼），或在開發 stack 跑一個會呼叫工具的真實回合；時機由使用者決定。
   - 產出：`evidence/step5-device-check.md`。
   - 相依：步驟 4。
   - 完成判準：每則 `ok: true`，使用者在手機上確認過程預設摺疊、可展開、結論在前。
6. ✅ **步驟 6：常青文件**
   - 結果（2026-11-16）：`CLAUDE.md` Key Modules 新增 `folded-reply.ts` 一列（含純文字退回的理由與 `replyParts` 的來源），`scheduler.ts` 列補上送出方式；`ARCHITECTURE.md` 補 pipeline、`folded-reply.ts`、排程的說明與聊天／排程流程的送出步驟；`README.md` 功能列表新增「過程摺疊」。`CLAUDE.md` 在 HEAD 就不符合 prettier，未整份重排，只改這兩列。
   - 產出：`CLAUDE.md` Key Modules 表（`markdown-v2.ts` 與 `telegram-stream-renderer.ts` 相關說明）、`ARCHITECTURE.md` 訊息流程、`README.md` 功能說明。
   - 相依：步驟 4。
   - 完成判準：三份文件描述的行為與實作一致。

7. ✅ **審查修正**（[review-eb9cc0b.md](review-eb9cc0b.md) 的 SHOULD FIX 1 與 NICE TO HAVE 1～3；使用者 2026-11-17 選「修 SHOULD FIX 加三項小補強（建議）」）
   - SHOULD FIX 1：`toFoldedReply()` 改以 `hasVisibleText()` 判斷結論，結論只剩 `[Opencode]` 前綴（例如最後一個 step 只有 SEND_FILE 或 MEMORY_INTENT）時不摺疊，照舊送全文（SCN-003）。
   - NICE 1：`folded-reply.ts` 的 `quote()` 把過程裡渲染出的 Markdown 引言行（開頭 `>`）攤平進摺疊引言，不送出 `>>`；程式碼區塊內以 `>` 開頭的行是內容，照原樣保留。
   - NICE 2：補 `StepTextCollector` 單元測試，回合停在以 tool-calls 結束的 step 時沒有 `replyParts`。
   - NICE 3：pipeline 串流測試補論壇主題，斷言摺疊版面帶著原本的 `messageThreadId`。
   - 紅燈：在 `dffa5b4`（修正前）的暫時 worktree 放進新測試：`tests/telegram/render-folded-reply.test.ts` 9 個中 1 個失敗（輸出含 `>>注意來源`）；`tests/message-pipeline.test.ts` 26 個中 2 個失敗（結論只有 SEND_FILE／MEMORY_INTENT 時仍呼叫 `sendFoldedReply`）。NICE 2、3 的測試保護既有行為，在修正前已通過，改以變異確認：把 `last.reason === 'tool-calls'` 拿掉時 NICE 2 的測試失敗；拿掉 renderer 摺疊路徑的 `messageThreadId` 時 NICE 3 的測試失敗；兩者還原後全過。
   - 實測：[evidence/review-fix-samples.ts](evidence/review-fix-samples.ts) 產生 2 則（過程含 Markdown 引言、程式碼區塊有以 `>` 開頭的行，後者送出的是 `>> 1`），依 TBD-2 以正式 bot 的 token 送出，都 ok=true；使用者 2026-11-17 在手機上確認「都正常」（引言文字在過程裡正常顯示，程式碼行顯示為 `> 1`）。
   - 交付檢查：`npm run build` exit 0；`npm run test` exit 0，`# tests 818`、`# pass 818`（比審查時多 5 個，都是本項新增）；`npm run lint` exit 0；步驟 4 的語料檢查重跑結果不變（缺字詞 0、超長 0、引言不完整 0）。
   - 影響分析：GitNexus 索引尚未收錄本分支新增的符號（`toFoldedReply`、`quote` 回報 not found），改以 grep 核對：`toFoldedReply` 1 處呼叫（pipeline），`quote` 只在 `folded-reply.ts` 內部 3 處。
   - 未處理：NICE 4～8 維持審查報告的評估，不在本項範圍。

## 使用方式對照

| 情況 | 變更前 | 變更後 |
|------|--------|--------|
| 會呼叫工具且途中有說話的提問 | 一則：`[Opencode] 數據已到手。接著抓……（結論）` | 一則：`[Opencode]（結論）`，下面是摺疊的「過程」 |
| 直接回答、沒有工具 | 一則全文 | 不變 |
| 超長回覆 | 依行切成多則 | 結論的切段不變，過程另起摺疊引言 |
| 排程結果 | `🕐 [排程: 名稱]` 後接全文，單則 HTML、多則純文字 | 標頭後接 `[Opencode]`＋結論與摺疊的過程，一律 MarkdownV2 |

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
| SCN-011 | 整合 | 排程送出內容：標頭在第一行，版面與聊天共用 |
| SCN-012 | 整合＋本機資料 | 字詞保留檢查；步驟 1 快照的排程結果缺字詞 0 則 |

外迴圈以標注 Scenario ID 的整合測試承擔（repo 沒有 BDD runner）；與單元測試同層者依 verification.md 合併並記錄理由。

## 檢查清單

- [x] 步驟 1 證據不含回覆原文，TBD-1 有結論
- [x] 步驟 2 的寫法得到 Telegram 接受
- [x] 沒有過程的回覆新舊輸出逐字相同
- [x] 儲存與摘要追問的文字不變
- [x] `npm run build`、`npm run test`、`npm run lint` 通過，`# tests` 數量相稱
- [x] GitNexus impact 與 grep 核對呼叫者（project.md 本地 gate）
- [x] 常青文件已更新
