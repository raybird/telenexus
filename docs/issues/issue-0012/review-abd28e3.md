# 審查報告
- 範圍：完整 PR（`main..feat/issue-0012-chat-session-binding`，依 README「Gate 豁免紀錄」不開 PR、以本機獨立審查代替）。這是 [review-e94635b.md](./review-e94635b.md) 判 RETURN TO execute-task 之後的重審
- Reviewed BASE SHA：7a485a561de6015bf38c2774427ffd59db25ce36
- Reviewed HEAD SHA：abd28e36942b136a0f5d3cffc06d5596451fa288
- Reviewed patch-id：a43424ed083dc311b9fe06662c17393bf084b79b（2026-10-07 以 `git diff 7a485a5 abd28e3 | git patch-id --stable` 重算，一致）
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，未參與本 issue 的實作
- Review artifact：docs/issues/issue-0012/review-abd28e3.md

審查日期 2026-10-07。開審前確認 `git rev-parse HEAD` = abd28e36942b136a0f5d3cffc06d5596451fa288，工作區乾淨。上次審查之後只有兩筆新提交：`263caff` 只新增 `review-e94635b.md`，`abd28e3` 是修正。本次審查完整的 `BASE..HEAD`，上次報告中仍然成立的結論沿用，並在下文註明。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

1. **新增的 prompt 選擇原因 `new-session` 在 Web Console 沒有對應的顯示文字**
   - 位置：`src/core/message-pipeline-chat.ts:196-197` 新增了 `'new-session'`；`src/web/server.ts:1146` 的 `humanizePromptReason()` switch 沒有這個 case，會落到 `default`，直接顯示原始字串 `new-session`。其他原因都有中文說明。
   - 影響：只影響顯示，不影響行為。不過這正是 `docs/agents/project.md`「新增必須被處理的狀態時，手動找齊所有分支」點名的情況。
   - 建議：補一個 case，例如「開新 Session（無可接續）」。不需要使用者決策，也不阻擋 PASS。

### NICE TO HAVE

1. **重組路徑的 telemetry 與實際送出的 prompt 不一致**：`rebuildForNewSession` 以 full 重組後，`promptTelemetry.promptMode`、`promptSelectionReason` 與 `promptLength` 記的仍是第一次組裝的結果，例如 minimal 與它的長度。只出現在 session-missing，或排隊期間綁定被清掉的少見路徑，可以在重組後更新 telemetry。
2. **重組時那次 Memoria 召回不會回報 UFL**：`message-pipeline-chat.ts:188` 的重組只回傳 prompt。如果第一次組裝是 minimal，`memoriaRecall` 會是 undefined，於是重組時 full 模式注入的召回結果完全不回報 outcome。路徑少見，損失的只是一次效用訊號。
3. **`/new` 的清除放在佇列 callback 內**（`src/core/message-pipeline.ts:285`）：如果排隊中的 `/new` 回合在開始執行前就被 `/abort` 取消，pending 已在 preflight 消耗，綁定卻沒有清掉，下一則仍會接回舊 session。情況極少，可以記為已知限制，或改在 preflight 消耗 pending 時就清除。
4. **「forceNewSession 同時帶 sessionId」時 session-missing 判定不成立，這一點沒有測試**：程式已經處理（`cli-agent-base.ts:481`、`opencode.ts` 的 `!options?.forceNewSession`），與 `buildChatArgs` 的條件一致。目前的新測試只涵蓋「沒有 sessionId」。
5. `src/core/opencode.ts:181-188` 有一處與本修正無關的 prettier 換行。純格式，不影響行為。
6. 上次的 NICE 4（passthrough 遇到 session-missing 時，會在新的空 session 上重跑一次）沒有處理，已在 `docs/cli-session-integration.md` 記為已知限制。這是可接受的揭露。

## 已查核維度

### 驗收與證據

- **核准**：`git diff 856c486 abd28e3 -- docs/issues/issue-0012/README.md` 沒有任何 Scenario 或 Given／When／Then 的變動，只多了 TBD-5、TBD-6、一筆 Timeline，以及上次已確認的回填與結案。SCN-001～008 仍是已核准。TBD-5 與 TBD-6 記有逐題確認的題號、選項與日期，兩者都是讓實作符合既有 SCN-006、SCN-002，不修改規格，所以不需要重新核准。
- **SCN-001、004、005、007、008**：上次判定的證據與結論仍然成立。這兩筆提交沒有改動相關程式，只有 `tests/memoria-recall-threshold.test.ts` 改成會清理暫存目錄，斷言沒有變。
- **SCN-002**：除了原有證據，新增 `tests/message-pipeline-session.test.ts` 的「TBD-6：/new 之後的回合沒有拿到 session 時，下一則不會接回舊 session」。紅燈記在 `evidence/step9-red.txt`（舊碼下綁定仍是 `ses_old`）。判定通過。
- **SCN-003**：除了原有證據，新增四項窄化測試（stream／non-stream 各兩項：「有事件輸出」與「沒有指定 session」），以及「重跑也沒拿到 session 時，綁定已清除」。判定通過。
- **SCN-006**：上次的 MUST FIX 已修正。新增兩個測試，「TBD-5：沒有綁定的回合一律以 full 組裝」與「綁定失效而重組時以 full 組裝，即使原本是 minimal」，期望值寫死，在舊碼下失敗（step9-red）。`docs/current-chat-prompt.md` 已改成與程式一致。判定通過。
- **紅綠證據**：step9-red 的 5 項失敗都落在新行為上。另外 3 項持久力測試在實作前就成立，step9-green 以突變驗證，並已說明它們不是紅綠證據。綠燈 32/32，完整測試 437/437。重構 no-op 已記錄。

### 突變驗證（reviewer 自行複核）

在 scratchpad 的 `git archive abd28e3` 複本上，每次只套用一個突變，跑對應的測試檔，跑完逐一還原，最後以 `diff -r` 確認與原始碼相同。repo 本身沒有改動，`git status` 乾淨。

| 突變 | 結果 |
|---|---|
| M1：拿掉 `cli-agent-base.ts` 的 `parsedLineCount === 0` | 「[stream] 有事件輸出時…」失敗 |
| M3：拿掉 session-missing 分支的 `sessionStore?.clear()` | 「重跑也沒拿到 session 時，失效的綁定已被清除」失敗 |
| M4：拿掉 `shouldUseFullPrompt` 的 `options.opensNewSession` | 「TBD-5：沒有綁定的回合一律以 full 組裝」失敗 |
| M5：重組改回 `build(promptMode, false)` | 「TBD-5：綁定失效而重組時以 full 組裝」失敗 |
| M6：拿掉 `/new` 開頭的 clear | 「TBD-6：/new 之後的回合…」失敗 |
| M7：拿掉 `opencode.ts` 的 `Boolean(options?.sessionId)` | 「[non-stream] 沒有指定 session 時不判為 session-missing」失敗 |

M1 與 M3 和實作者記錄的結果一致，M4～M7 是我額外補做的。每一項修正都至少有一個測試守著，突變驗證可信。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| 有 store、沒有綁定、短訊息、計數 > 0 | full | TBD-5 測試、M4 | 通過 |
| 有綁定，送出時 session-missing，原模式是 minimal | 重組為 full、不接續 | TBD-5 測試、M5 | 通過 |
| 沒有提供 store（既有呼叫端） | 不強制 full，維持原本的模式選擇 | `opensNewSession = Boolean(sessionStore) && !continuingSession`（`message-pipeline.ts:217`）；既有沒有用 store 的 pipeline 測試都通過（437/437） | 通過 |
| passthrough | 不組 prompt，不受 `opensNewSession` 影響 | `preparePromptForAgent` 對 passthrough 不進入組裝分支 | 通過 |
| full prompt 計數 | 每則訊息推進一次，重組不推進 | `:207` 只在第一次組裝後 +1；開新 session 的回合也照常推進，只是讓下一次週期性 full 的時間點往後移，無害 | 通過 |
| 重組與 Memoria 召回 | 會召回且注入 | full 一律帶記憶，會多一次召回，延遲上限是 `MEMORIA_RECALL_TIMEOUT_MS`。telemetry 與 UFL 的落差見 NICE 1、2 | 可接受 |
| `/new` 後第一回合逾時、429、中止 | 下一則不接回舊 session | TBD-6 測試、M6 | 通過 |
| `/new` 之後的 session-missing 重跑 | 不會發生 | 先清除綁定，`forceNewSession` 也不帶 `-s`，偵測同樣排除 forceNewSession | 通過 |
| 同一使用者排隊：X（/new 後）執行中，Y 已組裝為「接續」 | Y 執行時接續 X 的新 session；X 沒拿到 session 時改以 full 重組 | 程式：Y 送出前重讀綁定，`boundSessionId` 為空就走 `rebuildForNewSession`（full） | 通過（以閱讀程式查證） |
| 排隊反方向：組裝時沒有綁定、送出時已綁定 | 以 `-s` 接續並帶近期對話（內容重複，方向安全） | `:214` 的註解寫明是刻意保留 | 可接受 |
| session-missing 判定與 `buildChatArgs` 一致 | 只有真的帶 `-s`（`!forceNewSession && sessionId`）才可能判定 | stream（`cli-agent-base.ts:481`）、non-stream（`opencode.ts:545` 附近）、passthrough（stream passthrough 走 `chatStructured`，同一個判斷）、runner（`buildAgentOptions` 傳入 `forceNewSession` 與 `sessionId`）四條路徑一致 | 通過；forceNewSession 的組合沒有測試（NICE 4） |
| 其餘失敗面（runner 斷路器與 fallback、`executeTask` 改回傳結構化結果、`failure.kind` 分支、store 毀損與寫入失敗、tool_only、SQL、門檻） | — | 上次已查核，這次修正沒有觸及 | 沿用上次「通過」的判定 |

### 需求、架構、安全、品質（含跨 Task 重複與過度設計）

- **需求**：TBD-5 的定義「有綁定機制但這一回合不接續，以及 session-missing 的重組」與程式完全對應。TBD-6「forceNewSession 回合一開始就清除舊綁定」也已照做。
- **架構**：`opensNewSession` 由 pipeline 計算、在 `preparePromptForAgent` 使用，與既有的 `continuingSession` 對稱，沒有越過模組邊界。`build(mode, continuingSession)` 讓重組與第一次組裝共用同一段程式，沒有重複，也沒有過度設計。
- **常青文件**：`docs/current-chat-prompt.md`（full、上一回合沒拿到 session）、`docs/cli-session-integration.md`（full 重組、passthrough 限制、`/new` 先清除）、`docs/configuration-reference.md`（被門檻擋下時不回報 UFL）都與程式一致。`configuration-reference.md` 的「/new … 回合結束後綁定改為新 session」沒有寫到「開始時先清除」，但細節已在 cli-session-integration 說明，不算矛盾。
- **TS 嚴格設定與 lint**：build 與 lint 都是 exit 0。
- **安全**：掃過新增內容中的 token 樣式（`ghp_` 後接長字串、`github_pat_`）、本機絕對路徑、7 位以上數字與長十六進位，都沒有命中。命中的只有本報告與上次報告中的 commit SHA，以及容器內路徑 `/home/node/...`，後者不是本機路徑。上次報告中的「`ghp_` 開頭」是描述文字，不是 token。正式 Memoria 資料中那筆疑似 PAT，仍然屬於正式資料、不在本次範圍，建議使用者另行撤銷。

### 驗證（reviewer 於 2026-10-07 在 HEAD abd28e3 自行執行）

- `npm run build` → exit 0
- `npm run lint` → exit 0
- `npm run test` → exit 0，`# tests 437`、`# pass 437`、`# fail 0`。`tests/` 下仍是 65 個 `*.test.ts`，這次沒有新增檔案，新增的 8 個測試加在既有的兩個檔案裡，429 + 8 = 437，數量相符。
- 跑完 `git status --short` 為空。

### 豁免、待確認與限制

- Gate 豁免：同上次，只豁免「不開 PR，改由本機獨立審查」，本報告即為該審查。
- 待確認事項：TBD-1～6 都是「已解決」，結論、理由與日期齊全。本次沒有新的 `需決策` 項目。
- 已揭露的限制：passthrough 遇到 session-missing 會在空 session 上重跑；SCN-007 誤判約 3%；門檻依小樣本決定；session-missing 會讓 runner audit 記一筆 `ok:false`。這些揭露不構成缺失。
- step8 的實機驗證是在修正之前做的。這次修正只改了開新 session 回合的 prompt 模式與 `/new` 的清除時機，step8 驗過的 session 落點與改綁不受影響，新行為由 step9 的單元測試與突變驗證覆蓋。
- 本報告尚未提交。協調者如果新增只含本報告的提交，請依 `docs/agents/review-evidence.md`「本機 artifact 提交後的有效性」驗證。

## 流程判定
PASS

理由：上次的 MUST FIX 已修正，有紅綠證據與突變驗證；本次沒有 MUST FIX。SCN-001～008 與重要失敗面都有證據。報告已存檔，審查由非實作者的獨立 reviewer 完成。剩下的 1 項 SHOULD FIX（Web Console 顯示文字）與 6 項 NICE TO HAVE 都不阻擋交付。
