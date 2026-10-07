# 審查報告
- 範圍：完整 PR（`main..feat/issue-0012-chat-session-binding`，依 README「Gate 豁免紀錄」不開 PR、以本機獨立審查代替）
- Reviewed BASE SHA：7a485a561de6015bf38c2774427ffd59db25ce36
- Reviewed HEAD SHA：e94635b08feed294451e96b1c6b34959b4c025e9
- Reviewed patch-id：d36d8f7a4d698a49e4028cb7dec523cf47985449（2026-10-07 以 `git diff 7a485a5 e94635b | git patch-id --stable` 重算，一致）
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，未參與本 issue 的實作
- Review artifact：docs/issues/issue-0012/review-e94635b.md

審查日期 2026-10-07。開審前確認 `git rev-parse HEAD` = e94635b08feed294451e96b1c6b34959b4c025e9，`merge-base(BASE, HEAD)` = BASE，工作區乾淨。流程契約 2.1（`docs/AGENTS.md`）與本 skill 需求相容。

## 問題與風險

### MUST FIX

1. **SCN-006「改綁」列在 compact／minimal 回合不成立：改開的新 session 拿不到「近期對話」**　`需決策`
   - 位置：`src/core/message-pipeline-chat.ts:152-177`（模式只由 `forceNewSession` 與計數決定，`rebuildForNewSession` 沿用同一個模式）；`src/core/message-pipeline.ts:214`、`:285`；`src/core/prompt-build.ts:64-71`（minimal 一律不帶記憶，compact 只在長訊息或關鍵字時帶）。
   - 輸入／狀態：使用者已有綁定 `ses_1`，計數 > 0。綁定的 session 被刪掉後，使用者傳短的追問「那第二點呢」。
   - 預期（SCN-006 Examples 第 2 列）：開新 session（首次、/new、改綁）→ 含「近期對話」段。
   - 實際：pipeline 偵測到 session-missing 後以 `continuingSession=false` 重組，但模式仍是 `minimal`（compact 短訊息同理），`buildPromptFn` 根本不組記憶區塊。新 session 收到的 prompt 沒有任何上下文，模型答不出「第二點」指什麼。變更前 `-c` 至少還帶著某個 session 的歷史，這裡是體驗退步。我在 scratch 複本加一個測試重現，結果是 `[{"mode":"full","continuingSession":false},{"mode":"minimal","continuingSession":true},{"mode":"minimal","continuingSession":false}]`，`shouldIncludeMemoryContext('compact','那第二點呢') = false`。
   - 同類狀態：沒有綁定但計數 > 0 時也一樣。例如重啟後第一則 full 回合逾時或撞到 429，沒拿到 sessionId；下一則短訊息走 compact／minimal、開新 session，仍然沒有上下文。
   - 現有覆蓋：`tests/message-pipeline-session.test.ts` 的「綁定的 session 不存在而改開新 session 時，以『不接續』重新組裝 prompt」只用第一則訊息（計數 0 → full），而且 buildPrompt 是假的，不會暴露模式問題。步驟 8 的第 7 步也沒有記錄該回合 prompt 是否含近期對話。計畫步驟 7 的完成判準寫明「首次、/new、改綁三種情況都有該段」，但只在 full 模式下驗證過。
   - 文件不一致：`docs/current-chat-prompt.md:108` 寫「或綁定的 session 已不存在而改開新的」時會注入，現行程式在 compact／minimal 下做不到。
   - 建議：只要這一回合會開新 session（沒有綁定，或 session-missing／排隊後綁定已失效而重組），就比照 `/new` 改用 `full` 模式。也可以強制帶記憶區塊並放「近期對話」。補一個測試：計數 > 0、短訊息，觸發 session-missing 後，重組的 prompt 是 full（或含近期對話），期望值寫死。
   - 待決問題：SCN-006 的「開新 session → 含『近期對話』」是否不分 prompt 模式（我的讀法），還是 README「照舊注入」指沿用原本依模式決定的規則？
   - 可選做法：(a) 依上面的建議修正。我建議這個，改動小，也符合 SCN-006 原文與常青文件。(b) 接受現狀，但要修訂 SCN-006 的 Examples 並重新核准，同時改 `docs/current-chat-prompt.md`。

### SHOULD FIX

1. **`/new` 之後第一回合若是降級結果，`/new` 會被吞掉，下一則回到舊 session**　`需決策`
   - 位置：`src/core/message-pipeline-preflight.ts:78`（pending 在 preflight 就被移除）；`src/core/message-pipeline.ts:297`（只有結果帶 `sessionId` 才改綁）；`src/core/cli-agent-base.ts:289` 的逾時與 `:447` 的 429，兩者的結果都不帶 `sessionId`，non-stream 的 `src/core/opencode.ts` 逾時與 429 分支也一樣。
   - 狀態：綁定 `ses_old` → `/new` → 下一則回合逾時或撞到 429 → 再下一則。
   - 預期：使用者要求開新對話，後續不應接回 `ses_old`。
   - 實際：綁定仍是 `ses_old`，第三則以 `-s ses_old` 接回舊對話，使用者看不到任何提示。upstream-error 的結果會帶 sessionId（`buildUpstreamErrorResult`），不受影響；abort 也不帶 sessionId，結果相同。
   - 覆蓋：無測試。SCN-002 的 Then 只要求「執行完成」的回合，所以不構成驗收缺口。
   - 建議：`forceNewSession` 回合結束時，若結果沒有 sessionId 就 `clear` 綁定，讓下一則開新 session。待決問題：降級回合後是否要維持 `/new` 的意圖？可選做法：(a) 依建議 clear（我建議這個）；(b) 接受現狀並記入 README 待確認事項。

### NICE TO HAVE

1. **session-missing 的「沒有事件／沒有 stdout」兩道窄化條件沒有測試守住**（證據持久力，不是假綠燈）。我在 scratch 複本拿掉 `src/core/cli-agent-base.ts:480` 的 `parsedLineCount === 0`，以及 `src/core/opencode.ts:541` 前一行的 `!(error.stdout || '').trim()`，`tests/chat-session-args.test.ts` 仍是 14/14 通過。建議補一筆：exit 1、stdout 有事件（例如 tool_use）、stderr 含 `Session not found`，應維持原本的失敗方式。另可考慮只在 `options.sessionId` 存在時才判定 session-missing。
2. **`sessionStore.clear()` 的效果被重跑結果的 sessionId 蓋過**：`src/core/message-pipeline.ts:290` 拿掉 clear，現有測試仍會通過。可補「重跑結果沒有 sessionId（例如逾時）時，綁定已被清除」的案例。目前即使沒清，下一則也只會多一次不到一秒的失敗與一筆 runtime issue，會自我修復。
3. **排隊時序的反方向不一致沒有測試**：組 prompt 時沒有綁定（以「不接續」組裝），執行時前一則已綁定。這時會以 `-s` 接續，同時帶「近期對話」，內容重複，但方向安全。計畫步驟 7 的備註已說明這個取捨。可補一個排隊測試，或在 `src/core/message-pipeline.ts:212-214` 的註解寫明這個方向是刻意保留。
4. **passthrough 遇到 session-missing 會在新的空 session 重跑**：例如 `/compact` 會對空 session 執行一次，白跑一回。可考慮 passthrough 不重跑，改為告知使用者綁定已重設。
5. **被門檻擋下的召回不回報 UFL**：`src/core/memoria-recall.ts:194` 回傳時不帶 `recallId`，`main.ts` 因此不設 `memoriaRecallMeta`。這是合理的設計（沒用到的結果不該評分），但 `docs/configuration-reference.md` 沒提到，可補一句。
6. 測試衛生：`tests/chat-session-store.test.ts` 與 `tests/memoria-recall-threshold.test.ts` 建的暫存目錄沒有清掉；後者在模組頂層改了 `APP_PROJECT_DIR`。

## 已查核維度

### 驗收與證據

核准狀態：`git diff 856c486 HEAD -- docs/issues/issue-0012/README.md` 的差異只有四處：核准 commit 欄位由「待提交」回填為 856c486、TBD-1～3 結案、新增 Gate 豁免紀錄、新增一筆 Timeline 與狀態。Gherkin 劇本未變動。856c486 是 BASE 的祖先。SCN-001～008 在核准表中都是「已核准」（2026-10-06），表與現存 Scenario 集合相等，TBD-4 已記錄 SCN-003～006 的核准原話。

| 編號 | 證據位置 | 結論 |
|---|---|---|
| SCN-001 | `tests/chat-session-args.test.ts`（stream／non-stream／passthrough 帶 `-s`、無 `-c`；runner 選項）、`tests/dynamic-agent-session.test.ts`（sessionId 送到 runner 並帶回）、`tests/message-pipeline-session.test.ts`（第二則以綁定接續、passthrough 接續）、`evidence/step1-session-flag-probe.md`（D、G／H：`-s` 接續且不受並行影響）、`evidence/step8-end-to-end.md`（模擬排程插在中間仍答出代號） | 通過。紅燈 step3a／3b／3c 落在目標行為上（`-s` 缺少、仍帶 `-c`、sessionId 沒傳） |
| SCN-002 | 同上三份測試的「沒有綁定」與「/new」案例、`tests/chat-session-store.test.ts`、step8 第 4～6 步 | 通過。degraded 回合吞掉 /new 不在 Then 範圍內，列 SHOULD FIX 1 |
| SCN-003 | `tests/chat-session-args.test.ts`（偵測與「其他 exit 1」）、`tests/dynamic-agent-session.test.ts`（runner 保留 failure）、`tests/message-pipeline-session.test.ts`（清綁定、記 `chat-session:missing`、重跑、使用者看不到錯誤字樣）、step1 的 E／F／F2、step8 第 7 步 | 通過。窄化條件的測試持久力見 NICE 1 |
| SCN-004 | `tests/tool-only-followup-session.test.ts`（排程回合、首次聊天、接續三種情況，追問帶 `-s ses_turn`） | 通過。紅燈 step4 2/3 失敗；第 4 項是行為保留測試，step4-green 已明說不是紅綠證據 |
| SCN-005 | `tests/scheduler-validation.test.ts` 的 SCN-005（追蹤提醒帶 `forceNewSession: true`、沒有 sessionId） | 通過。紅燈 step4 `expected: true` 落在目標上 |
| SCN-006 | `tests/prompt-recent-conversation-skip.test.ts`（builder 省略該段）、`tests/message-pipeline-session.test.ts`（continuingSession 傳遞；full 與 compact 模式；session-missing 重組）、step8（242 字與 905／1,104 字） | **部分不成立**：「接續」列與首次、/new 通過；「改綁」列在 compact／minimal 模式不成立（MUST FIX 1） |
| SCN-007 | `tests/recent-conversation-chat-only.test.ts`（交錯、只有排程、空表、limit 與排序、多使用者、已知限制）、`evidence/step5-recent-conversation-inventory.md`（3,186 筆，誤判 3.0%／最壞 4.7%，含反向自檢） | 通過。期望值是寫死的案例，不是同義反覆；已知限制在程式註解、測試與常青文件中如實揭露 |
| SCN-008 | `tests/memoria-recall-threshold.test.ts`（低於、等於、高於門檻，null、0、0.5、無效值、>1，事件標記，「相關歷史摘要」不含結果）、`evidence/step6-confidence-sampling.md`（12 題凍結問題） | 通過。「無效值」與「>1」兩案例確實可能與實作不一致（NaN 或接受 1.5 都會讓它們失敗），不是假綠燈 |

測試真偽：沒有發現假綠燈。假 `opencode` 腳本只記錄參數並回放 step1 實測的輸出，被測的偵測與參數組裝邏輯沒有被 mock 掉。pipeline 測試 mock agent 與 buildPrompt，被測的是 pipeline 自己的綁定與重跑邏輯，屬合理分層。行為保留測試（SCN-004 第 4 項；SCN-008「注入」5 項；SCN-003「其他 exit 1」）都已標明不是紅綠證據。紅燈證據是摘要輸出（部分 `expected:` 沒有值），持久力尚可。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|---|---|---|---|
| 其他 exit 1（stderr 不含 `Session not found`） | 維持 ProcessError | 測試（stream／non-stream） | 通過 |
| exit 1、stdout 有事件、stderr 剛好含 `Session not found` | 不判為 session-missing | 程式有守（`parsedLineCount === 0`／stdout 為空），沒有測試 | 通過；持久力見 NICE 1 |
| 429 與逾時優先於 session-missing | 依原本分類處理 | 程式順序正確（stream 在 `rateLimited`／`timedOut` 之後才檢查；non-stream 在 ERATELIMIT／ETIMEDOUT 之後） | 通過 |
| passthrough stream 遇到 session-missing | 重跑，使用者看不到錯誤 | passthrough 的 `runStreamChat` 會先送出含錯誤字樣的 `done`，但 Telegram renderer 只存 `finalEventText`、Web 只存 `streamedReply`，重跑的 `done` 會覆蓋 | 通過（以閱讀程式查證） |
| runner 路徑的 sessionId 與 failure | 傳到 runner，回傳時保留 | `tests/dynamic-agent-session.test.ts` 的假 runner（`/run` 與 `/run/stream`）；`src/runner.ts` 的 HTTP `ok` 固定為 true，`deriveRunOutcome` 只影響 audit | 通過 |
| session-missing 觸發斷路器或 local fallback | 都不觸發 | HTTP 成功走 `markRunnerSuccess` 分支，不 fallback（以閱讀程式查證；測試設 `fallbackToLocal:false`，failure 能被保留就代表走的是成功分支） | 通過 |
| local fallback 與 runner 的 opencode 資料 | 共用同一個 session | 兩個服務都掛 `opencode_auth:/home/node/.local/share/opencode`（`docker-compose.yml` common config）；不共用時也會走 session-missing 重跑 | 通過 |
| `executeTask` 改回結構化結果後，`chat()`／`summarize()`／排程 | 字串與前綴不變 | `chat()`／`summarize()` 取 `.text`；runner 的 chat 仍加 `[Opencode]`，summarize 不加；斷路器開啟與錯誤訊息相同；`tests/dynamic-agent-session.test.ts` 最後一項，以及全套 429 個測試通過 | 通過 |
| `AgentFailureKind` 新增 `session-missing` 後的分支處理 | 沒有漏處理的 switch | grep `failure`／`failureKind`：只有 `deriveRunOutcome`（通用處理）與 pipeline 的單一比對；health probe 的 `isRealSuccessEvent` 不受影響（session-missing 不發 `opencode_done`） | 通過 |
| 改綁的時機：成功與 upstream-error | 改綁到結果的 session | 結果帶 sessionId 才改綁 | 通過 |
| 改綁的時機：逾時、429、abort | 綁定不變 | 結果不帶 sessionId | 接續回合正確；`/new` 後的回合見 SHOULD FIX 1 |
| 首次對話／升級後第一則 | 開新 session 並注入近期對話 | 測試；計數 0 → full | 通過 |
| 排隊：組 prompt 時有綁定，執行時已被清除 | 以「不接續」重組 | 程式：`boundSessionId ? promptForAgent : promptForNewSession()`；重組模式問題見 MUST FIX 1 | 部分 |
| 排隊：組 prompt 時沒有綁定，執行時已綁定 | 送出帶「近期對話」的 prompt 並接續（重複但安全） | 沒有測試 | 可接受；NICE 3 |
| Telegram 與 Web 共用 store | 同一個實例 | `src/main.ts` 建立一個 `ChatSessionStore` 傳給兩個 pipeline；`executionQueue` 依 userId 序列化 | 通過 |
| store 檔案不存在、毀損、不是物件、值無效、寫入失敗 | 視為沒有綁定，記 runtime issue，記憶體內仍有效 | `tests/chat-session-store.test.ts` 6 項 | 通過。寫入不是 atomic，寫到一半毀損時下次啟動視為沒有綁定，可接受 |
| tool_only：forceNewSession 回合、首次聊天、事件沒有 sessionID | 追問帶回合的 `-s`；沒有 sessionID 時沿用原選項 | `tests/tool-only-followup-session.test.ts` 4 項 | 通過（non-stream 路徑原本就沒有 tool_only 追問，不在範圍內） |
| `getRecentConversation` 的 SQL | user 一律算；model 只在前一筆是 user 時算；多使用者；limit 取最新的幾筆並依時間先後排列 | 測試；內層 `WHERE user_id` 先過濾再算 LAG，`ORDER BY timestamp, id` 處理同時間戳；外層 DESC 加 LIMIT 再 reverse | 通過；已知限制如實揭露 |
| Memoria 門檻：等於門檻、null、無效、0、hits 為 0 | 等於門檻注入、null 注入、無效用預設、0 停用、0 筆不標記 | 測試（hits 為 0 以程式 `rawHits.length > 0` 查證） | 通過 |
| 門檻擋下時的 UFL | 不回報 | 不帶 recallId，不送 outcome | 通過；NICE 5 |
| 接續時省略近期對話：full／compact | 不含該段 | 測試與 step8 | 通過 |
| minimal 模式 | 本來就不帶記憶 | — | 接續時無影響；開新 session 時見 MUST FIX 1 |
| session-missing 重組 | 含「近期對話」 | 只在 full 模式驗證 | MUST FIX 1 |

### 需求、架構、安全、品質（含跨 Task 重複與過度設計）

- **需求**：涉及檔案清單中「不可觸及」的項目（`model-health-check.ts`、`memoria-sync.ts`、`Dockerfile`、`docker-compose*.yml`）都沒有被改。`grep -rn "'-c'" src` 沒有結果，只剩 `docs/cli-session-integration.md:112` 一處「不要用」的說明。
- **架構**：`ChatSessionStore` 放在 `src/services/`，只有 telenexus 使用。runner 只多一個透傳欄位。session-missing 的判定放在 agent 層，重跑放在 pipeline，邊界清楚。`AIAgent.chatStructured` 是選用方法，pipeline 的第三條 `chat()` 退路目前沒有生產實作會用到，影響不大。
- **TS 嚴格設定**：`npm run build`（tsc，含 `exactOptionalPropertyTypes`／`noUncheckedIndexedAccess`）exit 0。條件展開 `...(x ? {k:x} : {})` 的用法一致。
- **跨 Task 重複**：`fromRunnerStructured()` 合併了兩處 runner 結果組裝；`BuildPromptFn` 合併了三處型別；`OPENCODE_SESSION_NOT_FOUND_PATTERN` 由 stream 與 non-stream 共用；兩處判定的守門條件在語意上一致（都要求沒有事件或沒有 stdout）。runner payload 仍在 `executeTask` 與 `streamChat` 各組一次，是既有的重複，本次只各加一行，沒有分歧。沒有發現過度設計。
- **安全**：`git diff 7a485a5 e94635b` 與 `docs/issues/issue-0012/` 掃過 `ghp_`／`github_pat_`／`sk-`、`/home/`、`/Users/`、7 位以上數字（使用者 ID）、12 位以上十六進位（容器 ID）、`TOKEN=` 等樣式，都沒有命中。session id 只留前綴並加「…」，抽樣只記數值與相關與否，盤點只記時間、數量與類別，scope 以 `<正式使用者>` 代稱。實作者提到正式 Memoria 資料中有一筆看似 GitHub PAT（`ghp_` 開頭）的內容：那屬於正式部署的資料，不在 repo、diff 與本次程式範圍內。建議使用者另行撤銷該 token，並清理該筆記憶。
- **常青文件**：依 `docs/agents/project.md` 的對照表，`ARCHITECTURE.md`、`CLAUDE.md`（Key Modules）、`docs/configuration-reference.md`、`.env.example`、`docs/current-chat-prompt.md`、`docs/summary-aware-retrieval-plan.md`、`docs/cli-session-integration.md` 都已更新，`CHANGELOG.md` 留到發版。`docs/cli-session-integration.md` 寫的「兩個服務共用同一份 opencode.db」與 compose 相符。只有 `docs/current-chat-prompt.md:108` 的「改綁會注入」與程式不一致（併入 MUST FIX 1）。`MEMORIA_RECALL_MIN_CONFIDENCE` 沒有加進 compose 的 `environment`，但 compose 有 `env_file: .env`，設定仍會傳入容器；compose 依 README 不可觸及，可接受。

### 驗證（本次 reviewer 於 2026-10-07 在 HEAD e94635b 自行執行）

- `npm run build` → exit 0
- `npm run test` → exit 0，`# tests 429`、`# pass 429`、`# fail 0`。`tests/` 下有 65 個 `*.test.ts`，與 step3 記錄的 61 個檔加上步驟 4～7 新增的 4 個相符；輸出中 SCN-001～008 的測試都有出現。
- `npm run lint` → exit 0
- 突變檢查（在 scratchpad 的 `git archive` 複本上進行，repo 未改動）：放寬 stream 的偵測條件 → 「其他 exit 1」測試失敗（有守住）；只拿掉事件數與 stdout 守門 → 14/14 仍通過（NICE 1）；compact／minimal 改綁重現 → 見 MUST FIX 1。
- step8 的映像建於 `f75fafc`，`git diff f75fafc 596b82a -- src tests` 為空，`596b82a..e94635b` 只改文件，所以實機證據仍適用於被審查的版本。

### 豁免、待確認與限制

- Gate 豁免：只豁免「不開 PR，改由本機獨立審查，合併由使用者執行」（2026-10-06）。本報告即為該審查，沒有超出豁免範圍。
- 待確認事項：TBD-1～4 都是「已解決」，結論、理由與日期齊全，維持原狀態。MUST FIX 1 與 SHOULD FIX 1 的 `需決策` 項目由協調者逐題確認後記入 README `## 待確認事項`。
- 已揭露的限制：SCN-007 誤判約 3%；門檻依 12 題小樣本決定；session-missing 會讓 runner audit 記一筆 `ok:false`；SCN-004／005／007／008 沒有做實機驗證，以測試與盤點為證。這些揭露不構成缺失。
- 本報告尚未提交。協調者如果新增只含本報告的提交，請依 `docs/agents/review-evidence.md`「本機 artifact 提交後的有效性」驗證。

## 流程判定
RETURN TO execute-task

理由：MUST FIX 1。SCN-006 的「改綁」列在 compact／minimal 回合不成立，也沒有證據覆蓋，常青文件與程式不一致。修正後需重跑 build、test、lint，並補上對應的紅綠證據，再重新審查新的 HEAD。如果使用者選擇修訂 SCN-006，需要先重新核准該 Scenario。
