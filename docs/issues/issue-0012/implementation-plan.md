# Issue 0012 實作計畫

驗收劇本與核准狀態見 [README](./README.md)。本檔是實作步驟與進度的唯一來源。

## 現況

2026-10-06 從 repo 程式碼與正式環境（opencode 1.18.34）唯讀查得。

### session 接續

- 聊天與 passthrough 指令由 `buildChatArgs()`（`src/core/opencode.ts`）組參數：沒有 `forceNewSession` 就加 `-c`。opencode 對 `-c` 的說明是 "continue the last session"。
- `scheduler.ts` 呼叫 `taskAgent.chat()` 的三處中，一般排程任務與每日摘要帶 `forceNewSession: true`，每次開新 session。`summarize()` 自己組參數、不帶 `-c`，每次也開新 session。
- 追蹤提醒（`scheduler.ts` 的 reflection）呼叫 `taskAgent.chat(reflectionPrompt)` 時不帶選項，所以用 `-c`。它的 prompt 已自帶使用者與 AI 的近期訊息。
- `tool_only` 追問（`cli-agent-base.ts`）用同一組 options 再呼叫 `chatStructured()`。原回合帶 `forceNewSession: true` 時，追問會開一個沒有上下文的新 session；原回合用 `-c` 時，追問接到的是當下最後被更新的 session。
- runner 有 interactive 與 scheduled 兩條 lane，彼此並行，所以排程可能在聊天回合進行中更新 session。
- 回合的 session id 已經能取得：`interpretEvent()` 會讀事件的 `sessionID`，runner 也會在 structured result 中回傳 `sessionId`。

正式環境 opencode.db 2026-10-03 的紀錄（近 12 天內有兩則以上使用者訊息的 session）：

| session 建立者 | 建立時間 | 之後接進來的 |
|---|---|---|
| 每日對話摘要排程 | 09:00:00 | 09:02:44 聊天訊息、09:02:55 `tool_only` 追問 |
| 使用者訊息摘要呼叫 | 09:03:12 | 09:05:08 聊天訊息 |
| 早安市場分析排程 | 09:20:00 | 09:35:08 追蹤提醒 |

對照 TeleNexus 的訊息紀錄，09:02:43 與 09:05:07 正是使用者的兩則聊天訊息。

### 記憶注入

- 記憶區塊由 `buildMemoryContextAsync()`（`src/prompt/builder.ts`）組成，分三段：核心決策回顧、相關歷史摘要、近期對話。總預算 1500 字，近期對話最多 10 則、每則截到 180 字。
- 「近期對話」來自 `getRecentConversation()`，取 messages 表最近 10 筆，不分來源。排程輸出由 `persistSchedulerMessage()` 寫進同一張表，role 是 `model`，沒有對應的 user 列。
- 正式環境近 30 天有 455 則 model 訊息、9 則 user 訊息，所以「近期對話」幾乎都是排程輸出。排程輸出沒有一致的前綴（帶 📅 或 🔔 的只有 31 則），無法用文字辨識。
- Memoria 召回（`MemoriaRecallClient.recallWithMeta()`）回傳 `meta.confidence`（可能是 null）與 `confidence_basis`，目前只記進遙測，沒有當作門檻。正式環境近 7 天沒有 `memoria_recall` 事件。

## 設計

### 聊天 session 綁定

新增 `src/services/chat-session-store.ts`，每位使用者存一個聊天 session id，檔案放在 `data/` 下（同 `model-health-state.json` 的做法），不改資料庫 schema。只在 telenexus 讀寫。

```ts
interface ChatSessionStore {
  get(userId: string): string | undefined;
  set(userId: string, sessionId: string): void;
  clear(userId: string): void;
}
```

`AIAgentOptions` 加上 `sessionId?: string`，經 `DynamicAIAgent` 與 `RunnerRequest` 傳到兩邊的執行端。`buildChatArgs()` 的規則改為：

```diff
 if forceNewSession
   不加接續參數
-else
-  加 -c
+else if sessionId
+  加 -s <sessionId>
+else
+  不加接續參數（開新 session）
```

聊天回合結束後，以結果的 `sessionId` 更新綁定。這同時涵蓋 SCN-002：首次對話與 `/new` 都開新 session，回合結束後改綁。升級後的第一則聊天沒有綁定，會開新 session；這一回合照 SCN-006 注入「近期對話」。

session 不存在時（SCN-003），opencode 不到一秒就以 exit 1 結束，stdout 沒有事件，stderr 含 `Session not found`（步驟 1）。以這三個條件偵測，不靠推測。偵測到時清除綁定，以新 session 重跑一次，並記 `recordRuntimeIssue('chat-session:missing', …)`。本機 fallback 與 runner 的 opencode 資料若不共用，綁定的 id 在本機一定不存在，也走同一條路。

`tool_only` 追問改用原回合結果的 `sessionId`，以 `-s` 送出（SCN-004）。追蹤提醒改帶 `forceNewSession: true`（SCN-005）。

### 近期對話

- **SCN-006**：`buildPrompt` 多接收「這一回合是否接續綁定的 session」。接續時，記憶區塊不放「近期對話」段；開新 session 時照舊放。
- **SCN-007**：先採查詢時的配對規則，不加欄位。user 訊息一律算聊天；model 訊息只有在同一使用者的前一筆是 user 訊息時才算聊天回覆。規則對新舊資料一樣適用，不需要回填。已知的誤判：聊天回合進行中，若剛好有排程寫入，排程輸出會被當成聊天回覆，真正的回覆反而被排除。步驟 5 在資料庫複本上量測誤判率。不可接受時改為新增來源欄位，那是 schema 變更，規模要升為 Large 重新評估（TBD-3）。

### confidence 門檻

`MEMORIA_RECALL_MIN_CONFIDENCE` 設定門檻。召回的 `confidence` 低於門檻時，丟棄這次 Memoria 的結果，改走既有的本機語意摘要（與 Memoria 回傳 0 筆時相同）。預設值與 null 的處理由步驟 6 抽樣後決定（TBD-2）。丟棄時記進 `memoria_recall` 事件，讓注入量下降時看得出原因。

## 實作步驟

1. ✅ **契約探測：opencode 1.18.34 的 `-s` 行為**（SCN-001、SCN-002、SCN-003）
   - 產出：`evidence/step1-session-flag-probe.md`；TBD-1 的結論。
   - 相依：無。
   - 方式：用正式映像以 `docker run` 隔離啟動（暫存資料目錄、不掛 named volume、不發佈 port、不帶 Telegram token），沿用 issue 0008 的做法。
   - 完成判準：四種情況各有實際事件輸出與 exit code：`-s` 有效 id、`-s` 不存在的 id、`-s` 已用 `opencode session delete` 刪除的 id、`-s` 執行期間另一個 session 被更新。有效 id 的回合能引用前一回合的內容，事件的 `sessionID` 與指定的相同，opencode.db 中只有該 session 的使用者訊息數加一。證據檔已去敏（無本機絕對路徑、無完整容器 ID）。
   - 完成證據（2026-10-06）：[evidence/step1-session-flag-probe.md](./evidence/step1-session-flag-probe.md)。`-s` 有效 id 接續並帶入歷史（回覆引用先前的代號），並行下仍落在指定 session，只有它的使用者訊息數加一；不存在與已刪除的 id 都是 exit 1、無事件、stderr `Session not found`。對照組 `-c` 接到最後建立的 session。
2. ✅ **聊天 session 綁定存放**（SCN-001、SCN-002）
   - 產出：`chat-session-store.ts` 與單元測試。
   - 相依：無（可與步驟 1 並行）。
   - 完成判準：讀寫、清除、檔案不存在、檔案毀損都有測試；毀損時視為沒有綁定，並記 runtime issue。先紅後綠，期望值寫死。
   - 完成證據（2026-10-06）：紅燈 [evidence/step2-red.txt](./evidence/step2-red.txt)（空殼實作，6 項中 5 項失敗於行為斷言）；綠燈 [evidence/step2-green.txt](./evidence/step2-green.txt)（6/6 通過，build、eslint exit 0）。另涵蓋值不是非空字串、內容不是物件、寫入失敗三種情況。重構為 no-op。
3. ✅ **聊天與 passthrough 改用綁定的 session**（SCN-001、SCN-002、SCN-003）
   - 產出：`opencode.ts`、`agent.ts`、`runner.ts`、`message-pipeline*.ts` 的變更與測試。
   - 相依：步驟 1、2。
   - 完成判準：`buildChatArgs()` 在三種情況（有綁定、`/new`、沒有綁定）產生的參數都有測試，且沒有任何路徑再產生 `-c`（`grep -rn "'-c'" src` 為空）；runner 與本機路徑都把 `sessionId` 傳到 opencode；回合結束後綁定更新為結果的 `sessionId`；session 不存在時回合仍回覆、綁定改為新 id、記一筆 runtime issue。先紅後綠。
   - 完成證據（2026-10-07）：分三層先紅後綠。紅燈 [3a](./evidence/step3a-red.txt)（參數與 session-missing 判定，14 項中 9 項失敗）、[3b](./evidence/step3b-red.txt)（DynamicAIAgent 傳遞，5 項中 4 項失敗）、[3c](./evidence/step3c-red.txt)（pipeline 綁定與重跑，7 項全失敗）；綠燈 [evidence/step3-green.txt](./evidence/step3-green.txt)，完整測試 402/402、build、lint 都是 exit 0，`src/` 中已無 `'-c'`。
   - 實作備註：session 不存在時，opencode agent 回傳 `failure.kind = 'session-missing'` 且不發任何事件；runner 的 audit 記為失敗，但不觸發斷路器（HTTP 層仍是成功）。`DynamicAIAgent` 新增 `chatStructured()`，non-stream 路徑也能取得 sessionId 與 failure；runner stream 路徑原本會丟掉 `failure`，已一併保留。`main.ts` 建立唯一的 `ChatSessionStore`，傳給 Telegram 與 Web 兩個 pipeline。
   - 已知暫時退步：首次對話（還沒有綁定）的 `tool_only` 追問會開新 session。已於步驟 4 修正。
4. ✅ **`tool_only` 追問與追蹤提醒**（SCN-004、SCN-005）
   - 產出：`cli-agent-base.ts`、`scheduler.ts` 的變更與測試。
   - 相依：步驟 3。
   - 完成判準：追問的參數帶原回合的 `sessionId`，聊天回合與 `forceNewSession` 的排程回合都有測試；原回合沒有 `sessionId` 時的行為有測試並寫明；追蹤提醒的呼叫帶 `forceNewSession: true`。先紅後綠。
   - 完成證據（2026-10-07）：紅燈 [evidence/step4-red.txt](./evidence/step4-red.txt)（排程回合與首次聊天的追問沒帶 `-s`；追蹤提醒沒帶 `forceNewSession`）；綠燈 [evidence/step4-green.txt](./evidence/step4-green.txt)，完整測試 407/407。原回合事件沒有 `sessionID` 時沿用原選項：opencode 1.18.34 每個事件都帶 sessionID，只有格式改變時才會發生，以行為保留測試涵蓋。
5. ✅ **近期對話只取聊天訊息**（SCN-007）
   - 產出：`memory.ts` 的查詢變更與測試；`evidence/step5-recent-conversation-inventory.md`。
   - 相依：無。
   - 方式：先在 repo 之外的 `moltbot.db` 複本上，比較新規則與現行查詢的結果，量出誤判的筆數。複本含私人對話，不進版控，用完即刪。
   - 完成判準：測試涵蓋聊天與排程交錯、只有排程、聊天中途插入排程輸出（記錄為已知限制）、空表。期望值是寫死的案例。盤點記錄複本的時間範圍、總筆數、新規則排除的排程輸出數、誤判數與判定理由；TBD-3 有結論。
   - 完成證據（2026-10-07）：盤點 [evidence/step5-recent-conversation-inventory.md](./evidence/step5-recent-conversation-inventory.md)：3,186 筆中 297 個聊天回合，確定誤判 9 筆（3.0%，最壞 4.7%）；最近 10 筆在現行規則下全是排程輸出，新規則下全是聊天。紅燈 [evidence/step5-red.txt](./evidence/step5-red.txt)（6 項中 5 項失敗）；綠燈 [evidence/step5-green.txt](./evidence/step5-green.txt)，完整測試 413/413。TBD-3 結論：不新增來源欄位。
6. ✅ **Memoria confidence 門檻**（SCN-008）
   - 產出：`memoria-recall.ts`、`builder.ts` 的變更與測試；`.env.example` 新設定；`evidence/step6-confidence-sampling.md`。
   - 相依：無。
   - 方式：在隔離的 Memoria 執行個體上載入正式資料的快照複本，以措辭不同的中文問句抽樣，題目先凍結再跑（沿用 `builder.ts` 註解中 1.28.0 評估的做法）。每題記錄 confidence、basis 與每筆結果是否相關，用來決定預設值與 null 的處理。
   - 完成判準：TBD-2 有結論，理由寫在證據檔中。低於門檻、等於門檻、高於門檻、confidence 為 null、未設定門檻都有測試。低於門檻時改用本機語意摘要，`memoria_recall` 事件帶有被丟棄的標記。先紅後綠。
   - 完成證據（2026-10-07）：抽樣 [evidence/step6-confidence-sampling.md](./evidence/step6-confidence-sampling.md)：12 題凍結問題，無關問題最高 0.143、相關問題最低 0.25（R4 除外），預設門檻取 0.2；null 照常注入。紅燈 [evidence/step6-red.txt](./evidence/step6-red.txt)（10 項中 5 項失敗）；綠燈 [evidence/step6-green.txt](./evidence/step6-green.txt)，完整測試 423/423。門檻在 `MemoriaRecallClient.recallWithMeta()` 套用，`builder.ts` 不需修改：被擋下時回傳 0 筆，沿用既有的本機語意摘要退路。
7. 📝 **接續時省略近期對話**（SCN-006）
   - 產出：`builder.ts`、`main.ts`、`message-pipeline*.ts` 的變更與測試。
   - 相依：步驟 3、5。
   - 完成判準：接續綁定的 session 時，記憶區塊沒有「近期對話」段；首次、`/new`、改綁三種情況都有該段。full 與 compact 模式各有測試。先紅後綠。
8. 📝 **實地驗證、常青文件與交付檢查**（全部 Scenario）
   - 產出：`evidence/step8-end-to-end.md`；常青文件更新。
   - 相依：步驟 1～7。
   - 方式：在隔離環境依序執行聊天、排程、再聊天、`/new`、再聊天，檢查 opencode.db 中每個回合進了哪個 session。
   - 完成判準：opencode.db 中兩則聊天訊息落在同一個 session，排程 session 中沒有聊天訊息；`/new` 後的聊天落在新 session；`npm run build`、`npm run test`（核對 `# tests` 與測試檔數相稱）、`npm run lint` 都是 exit 0；下方常青文件已更新。

## 使用方式對照

| 情境 | 變更前 | 變更後 |
|---|---|---|
| 排程剛跑完時聊天 | 接進排程的 session | 接進自己的聊天 session |
| 升級後第一則聊天 | `-c` 接最後被更新的 session | 開新 session 並注入「近期對話」 |
| 手動除錯時接續聊天 | `opencode run -c` | `opencode run -s <綁定的 id>`，id 從綁定檔讀取 |

## 測試策略

| Scenario | 測試層級 | 說明 |
|---|---|---|
| SCN-001 | 單元測試加實跑 | 單元測試驗證參數與綁定更新；只有實跑能驗證 opencode 接到哪個 session（步驟 1、8） |
| SCN-002 | 單元測試加實跑 | 同上 |
| SCN-003 | 單元測試加實跑 | 偵測條件取自步驟 1 的實際輸出，不靠推測 |
| SCN-004 | 單元測試 | 追問參數是我們組的，單元測試足以涵蓋 |
| SCN-005 | 單元測試 | 同上 |
| SCN-006 | 單元測試 | prompt 組裝是純函式，外迴圈與內迴圈同層，合併紅燈 |
| SCN-007 | 單元測試加資料盤點 | 規則的正確性用寫死的案例驗證；誤判率由複本盤點量測 |
| SCN-008 | 單元測試加抽樣 | 門檻邏輯用單元測試；預設值由抽樣決定 |

## 風險與首要驗證

見 [README 的「風險與首要驗證」](./README.md#風險與首要驗證)。步驟 1 就是首要驗證。

## 常青文件

| 文件 | 更新內容 |
|---|---|
| `docs/configuration-reference.md` | 「Runner Session Context」改寫：聊天綁定自己的 session、手動接續改用 `-s`；新增 `MEMORIA_RECALL_MIN_CONFIDENCE` |
| `.env.example` | `MEMORIA_RECALL_MIN_CONFIDENCE` |
| `docs/current-chat-prompt.md` | 「近期對話」的注入條件與來源 |
| `docs/summary-aware-retrieval-plan.md` | 近期對話只取聊天訊息；Memoria 的 confidence 門檻 |
| `ARCHITECTURE.md`、`CLAUDE.md` | 只在新增的 `chat-session-store` 改變模組職責描述時更新 |
| `CHANGELOG.md` | 發版時寫明：升級後第一則聊天會開新 session |

## 檢查清單

- [x] SCN-003～006 已核准（2026-10-06）
- [x] 步驟 1 的證據確定了 TBD-1
- [x] `src/` 中沒有任何路徑再產生 `-c`（2026-10-07）
- [x] TBD-2、TBD-3 有結論與證據（2026-10-07）
- [ ] 證據檔已去敏
- [ ] `Dockerfile`、`docker-compose*.yml` 沒有變更
- [ ] 改 symbol 前跑過 GitNexus impact，並另外用 grep 數過呼叫點
