# Issue 0009 實作計畫

驗收劇本、風險與涉及檔案以 [README.md](./README.md) 為準；本檔是任務清單、狀態與證據的唯一來源。

## 現況（2026-10-01 調查）

以唯讀方式查一個運行約七個月的部署，只取彙總數字。

- **大小**：`opencode.db` 123 MB，另有 4 MB 的 WAL。`freelist_count` 為 0、`auto_vacuum` 為 0，代表從沒刪過資料，刪除後檔案也不會自動縮小。
- **組成**：`part` 表 98 MB（約八成），`message` 7 MB，`session` 1 MB。`part` 中工具輸出 54 MB，依序是 bash 21.5、websearch 13.9、webfetch 11.9。
- **數量**：2,961 個 session，期間 2026-02-23 至 2026-10-01。
- **年齡**：70 MB 的實際內容中，30 天以前的 session 佔 61 MB，90 天以前的佔 34 MB。
- **使用型態**：2,873 個 session（97%）只有一則使用者訊息。排程與健康檢查探針每次都開新 session；只有聊天以 `-c` 沿用最近的 session，最大的一個有 3.3 MB、3,653 筆片段。
- **近期的 session 數暴增**：9 月有 1,411 個，多數是 issue 0008 的失敗回合與每小時一次的探針，內容幾乎是空的。

TeleNexus 的對話紀錄另存在自己的 SQLite 與 Memoria。`src/` 與 `scripts/` 沒有任何地方讀取 `opencode.db`；記憶回填讀的是 Memoria 的 `sessions.db`，不是它。

opencode 1.15.10 提供的相關指令：`opencode session list`（`--format json`、`-n`，欄位有 `id`、`created`、`updated`、`title`、`directory`、`projectId`）、`opencode session delete <sessionID>`、`opencode db [query]`。CLI 的說明中沒有自動清理的選項。

## 取捨

### 透過 opencode 的 CLI 刪除，而不是直接下 SQL

直接 `DELETE` 比較快，但資料表是 opencode 的內部結構，釘版一升就可能改變，而且要自己保證串聯刪除正確。`session delete` 是官方介面。代價是每刪一個 session 要啟動一次行程，首次清理會比較久，所以每次清理設上限、分多次做完。

空間回收用的 `VACUUM` 與 `PRAGMA` 不改寫資料表的內容，可經 `opencode db` 執行；實際做法由步驟 1 的實測決定。

### 以保留期清理，而不是任務跑完就刪

排程的結果已經存進 TeleNexus，理論上跑完就能刪。保留一段時間的好處是出問題時還能用 `opencode export` 回頭看那次執行的工具輸出。探針是例外：它的內容沒有除錯價值，數量又多，所以用完即刪。

### 不在範圍：聊天 session 輪替

聊天永遠沿用同一個 session，它會持續長大。輪替會改變對話延續的行為，需要另外評估品質，不放進這個 issue。

## 設計方案

具體命名、預設值與介面可由 execute-task 依步驟 1 的實測調整，等價的寫法不視為規格變更。

### 挑選待刪 session

純函式：輸入 session 清單、綁定中的 session ID、現在時間、保留天數，輸出要刪的 session。規則：

- 以最後更新時間判斷是否過期，而不是建立時間。長期沿用的聊天 session 建立得早但一直在更新。
- 綁定中的聊天 session 一律保留，不論多舊。綁定由 telenexus 寫在 `data/chat-session-state.json`（issue 0012），兩個服務共用 `data/`；清理在每次執行時重新唯讀讀取，讀取失敗就跳過這一次清理，不在沒有保護清單的情況下刪除。
- 只選頂層 session（`parent_id` 為空）；子 session 會隨父 session 一併刪除。
- 每次最多回傳固定數量（100），最舊的優先。
- 候選以 `opencode db --format json` 的 `SELECT … ORDER BY time_updated LIMIT 100` 取得，只讀不寫。opencode 的輸出超過約 64 KB 時，經 pipe 會被截斷而 exit 仍為 0，所以輸出必須能完整解析成 JSON，解析失敗就當作清理失敗。`session list` 由新到舊排序，不適用（步驟 1）。

### 執行與排程

- 每小時執行一次，啟動後不立刻跑（TBD-1）。呼叫 opencode 的子程序 stdin 設為 ignore：`opencode run` 會讀 stdin，未關閉時會一直等待（步驟 1）。
- 對每個待刪 session 呼叫 `opencode session delete`。單一 session 失敗就記下並繼續下一個；整體失敗以 `recordRuntimeIssue('opencode-retention:<原因>', ...)` 記錄，下次再試。
- 每次執行寫一筆 log：候選數、成功數、失敗數、耗時。
- 只在一個服務執行：使用 runner 的部署由 `agent-runner` 掛載，沒有 runner 的部署由主服務掛載，避免兩邊同時刪。

### 設定

經 `.env` 傳入容器，不需要改 compose 檔。暫定：

- `OPENCODE_SESSION_RETENTION_ENABLED`，預設 `true`
- `OPENCODE_SESSION_RETENTION_DAYS`，預設 `30`

預設啟用代表既有部署升級後，第一次清理就會刪掉 30 天以前的 session。發版說明必須明寫這一點與停用方式。

### 探針 session

健康檢查探針在取得結果後刪除自己建立的 session。session ID 取自探針輸出的事件，這依賴 issue 0008 把探針改為解析事件。

### 空間回收

刪除後檔案不會縮小，但空出的頁面會被重複使用，檔案不再長大。要讓檔案變小需要 `VACUUM`，它在執行期間需要獨佔資料庫。做法：經 `opencode db "VACUUM"` 執行，`page_count` 與 `freelist_count` 經 `opencode db "pragma …"` 讀取。條件：沒有 opencode 任務在執行、`freelist_count` 達 `page_count` 的 20% 以上，且當天還沒回收過（TBD-2）。步驟 1 實測，220 MB 的複本回收不到 1 秒，期間讀取不受影響，寫入最多等 390 ms；opencode 的連線設有 `busy_timeout=5000`。

## 測試策略

| 驗收    | 層級                         | 證據                                                                               |
| ------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| SCN-001 | 單元測試加資料庫複本上的實跑 | 挑選邏輯的紅綠重構證據；複本上刪除前後各資料表筆數的差異                           |
| SCN-002 | 單元測試加資料庫複本上的實跑 | 綁定中的 session 已過期時不被選中；複本上清理後 `opencode run -s <綁定 id>` 仍接續同一個 session |
| SCN-003 | 單元測試                     | 設定解析的預設值、自訂天數與停用                                                   |
| SCN-004 | 單元測試加實跑               | 探針結束後呼叫了刪除；實跑後 session 數不增加                                      |
| SCN-005 | 單元測試                     | 以失敗的執行器驅動：記錄 runtime issue、不拋出、下一輪重試                         |
| SCN-006 | 資料庫複本上的實跑加單元測試 | 回收前後的檔案大小與耗時；有任務執行時不回收的判斷                                 |

資料庫複本上的實跑是實地觀測。反向自檢：刪除沒有生效時，筆數差異會是零、檔案大小不變，與成功時不同。對照組是清理前的同一份複本。

## 實作步驟

1. ✅ **在資料庫複本上驗證 opencode 的刪除與回收行為**（SCN-001、SCN-002、SCN-006）
   - 產出：實測紀錄，存於本目錄 `evidence/`；TBD-1 與 TBD-2 的結論。
   - 相依：無。資料庫複本放在 repo 之外，含有私人對話，不進版控，驗證完即刪除。
   - 證據（2026-10-16）：[evidence/step1-delete-vacuum-probe.md](evidence/step1-delete-vacuum-probe.md)。完成判準逐項對應：刪除連帶清掉訊息、片段、事件與子 session，其他 session 不變；`storage/session_diff/` 的檔案不刪，但孤立的檔案合計只有約 1 KB，不處理。單次刪除 p50 785 ms，連續刪 100 個需 79.8 秒。在 `opencode run` 執行期間刪除 60 個，兩邊都成功。`session list` 由新到舊排序，`updated` 即 `time_updated`，輸出經 pipe 超過約 64 KB 會被截斷。`VACUUM` 讓 220.9 MB 降到 168.8 MB，期間讀取不受影響、寫入最多等 390 ms。綁定的 129 天前 session 在周圍 50 個被刪後，以 `-s` 接續成功，對照組（已刪除的 session）回 `Session not found`。複本已在驗證後刪除。
   - 完成判準：以下每一項都有實際輸出為證。`session delete` 後該 session 的訊息與片段筆數歸零，其他 session 不變，子 session 的處理方式明確；單次刪除與連續刪除 100 個的耗時；有 `opencode run` 在執行時刪除另一個 session 的結果；`session list` 的排序與 `updated` 欄位的意義；`VACUUM` 前後的檔案大小、耗時，以及期間另一個連線讀寫的行為；清理後 `opencode run -s <id>` 仍接續原 session。以映像目前釘的 opencode 版本實測，`現況` 一節記錄的 CLI 選項取自 1.15.10，需重新確認。
2. ✅ **挑選待刪 session 的邏輯**（SCN-001、SCN-002）
   - 產出：挑選函式與單元測試。
   - 相依：步驟 1（`updated` 的意義與排序）。
   - 完成判準：測試涵蓋過期與未過期、綁定中的 session 已過期、綁定清單為空、session 清單為空、數量超過上限、時間欄位缺漏；先紅後綠；期望值是寫死的案例，不由測試重算。
   - 證據（2026-10-16）：`selectSessionsToDelete()`（`src/services/opencode-session-retention.ts`）與 `tests/opencode-session-retention-select.test.ts` 的 8 個案例，期望值都是寫死的 ID 清單。
     - 紅燈：`npx tsx --test tests/opencode-session-retention-select.test.ts`，exit 1，8 個測試中 7 個失敗，失敗原因都是 stub 回傳空陣列、選不出過期的 session。「session 清單為空」在 stub 下本來就會通過，這是空清單案例的性質，不是測試失效。
     - 最小實作後：同一命令 exit 0，8/8 通過。
     - 重構：用 `Number.isFinite` 一次排除 null 與 NaN，同一命令 exit 0，8/8 通過；`npx tsc --noEmit -p .` exit 0；`npx eslint src/services/opencode-session-retention.ts` exit 0。
     - 單迴圈合併：這是純函式，沒有另一層整合責任。外迴圈（在資料庫複本上實跑）由步驟 6 承擔。
3. ✅ **清理的執行、排程與設定**（SCN-001、SCN-003、SCN-005）
   - 產出：清理服務、`runner.ts` 與 `main.ts` 的掛載、`.env.example` 的設定。
   - 相依：步驟 2。
   - 完成判準：預設值、自訂天數與停用都有測試；綁定狀態檔讀取失敗時跳過該次清理（測試）；執行器失敗時記錄 runtime issue 且不影響呼叫端（先紅後綠）；同一份部署只有一個服務會執行清理；`npm run build`、`npm run test`、`npm run lint` 都是 exit 0。
   - 證據（2026-10-16）：清理流程在 `src/services/opencode-session-retention.ts`（`loadRetentionConfig`、`parseCandidateRows`、`runRetentionOnce`、`startOpencodeSessionRetention`、`createOpencodeRetentionDeps`）；`src/services/chat-session-store.ts` 新增 `readBoundSessionIds()`，毀損時拋出；`src/runner.ts` 一律掛載，`src/main.ts` 只在沒有 `RUNNER_ENDPOINT` 時掛載（`shouldMainRunRetention`）；`.env.example` 新增兩個設定。測試在 `tests/opencode-session-retention-run.test.ts` 與 `tests/chat-session-store.test.ts`。
     - 紅燈：先放回傳空值或固定值的 stub，執行 `npx tsx --test tests/opencode-session-retention-run.test.ts tests/chat-session-store.test.ts`，exit 1，23 個測試中 15 個失敗，都是斷言失敗（例如預期 `retentionDays` 30 實得 0、預期 skipped `disabled` 實得 undefined、預期查詢上限 `[101]` 實得 `[]`），沒有執行期錯誤。在 stub 下本來就會通過的有三類：既有的 6 個 store 測試、「狀態檔不存在代表沒有綁定」、「停用時不排程」，後兩者是空結果案例的性質。
     - 最小實作後：同一命令加上步驟 2 的測試共 31 個，exit 0、全部通過。
     - 外層：`createOpencodeRetentionDeps()` 以放在 `PATH` 上的假 `opencode` 驗證實際的 CLI 參數（`db --format json <SQL>`、`session delete <id>`）、輸出解析，以及刪除失敗時會拋出。這個測試是實作後才補的，沒有自然的紅燈，所以做了變異檢查：把 SQL 的 `asc` 改成 `desc` 後它失敗（1 個失敗），還原後通過。真正的 opencode 由步驟 6 在資料庫複本上驗證。
     - 重構：`chat-session-store.ts` 的讀檔與解析抽成 `loadBindings()`，聊天端（毀損時當作沒有綁定）與清理端（毀損時拋出）共用；既有的 6 個 store 測試前後都通過。新檔案經 prettier 格式化。
     - 專案 gate：`npm run build` exit 0；`npm run test` exit 0，`# tests 465`、`# pass 465`、`# fail 0`，`tests/` 下有 68 個測試檔；`npm run lint` exit 0。`docker-compose.yml` 與 `docker-compose.release.yml` 沒有變更。
4. ✅ **探針 session 用完即刪**（SCN-004）
   - 產出：`model-health-check.ts` 的變更與測試。
   - 相依：步驟 3；issue 0008 的探針變更（TBD-3）。
   - 完成判準：探針成功與失敗兩種情況都會刪除自己的 session；刪除失敗不改變探測結果。
   - 證據（2026-10-16）：`src/services/model-health-check.ts` 新增 `findProbeSessionId()`，從 stdout 事件取出 `sessionID`；`defaultProbe()` 結束（不論成功、失敗或逾時）後以 `opencode session delete` 刪除該 session，失敗時記 `model-health:probe-session-delete`。測試在 `tests/model-health-probe-session.test.ts`，以假的 `opencode` 搭配 1.18.34 的 ok 與 426 fixture，期望的 session id 是 fixture 裡寫死的值。
     - 紅燈：`findProbeSessionId` 先回傳 undefined，執行 `npx tsx --test tests/model-health-probe-session.test.ts`，exit 1，5 個測試中 4 個失敗，都是斷言失敗：取不到 session id，也沒有任何刪除呼叫。「沒有事件時不呼叫刪除」在 stub 下本來就會通過。
     - 最小實作後：同一命令連同 `tests/model-health-upstream-error.test.ts`、`tests/model-health-check.test.ts` 共 53 個，exit 0、全部通過。
     - 單迴圈合併：探針的輸入（假 opencode 的 stdout 與 exit code）和刪除呼叫，在同一層就能觀察，沒有另一層整合責任；真實 opencode 的刪除語意已在步驟 1 驗證。
     - 限制：逾時時若 opencode 還沒輸出任何事件，就取不到 session id，該 session 留給保留期清理處理。
     - 重構：no-op，函式已是最小形狀。
     - 專案 gate：`npm run build` exit 0；`npm run test` exit 0，`# tests 470`、`# pass 470`、`# fail 0`，69 個測試檔；`npm run lint` exit 0。
5. ✅ **空間回收**（SCN-006）
   - 產出：回收的判斷與執行，及其測試。
   - 相依：步驟 1、3。
   - 完成判準：有任務執行時不回收（測試）；可回收空間低於門檻時不回收（測試）；回收失敗記錄 runtime issue 且不影響服務。
   - 證據（2026-10-16）：`src/services/opencode-session-retention.ts` 新增 `parseSpaceStats()` 與 `maybeReclaimSpace()`，每輪刪除後判斷是否回收：一天內回收過、`freelist_count` 未達 `page_count` 的 20%、或有任務在執行時都不回收。空間經 `opencode db --format json "select * from pragma_page_count(), pragma_freelist_count(), pragma_page_size()"` 讀取，回收經 `opencode db VACUUM`。「沒有任務」的判斷：runner 是兩條 lane 的執行數都是 0；主服務是新增的 `ExecutionQueue.isIdle()`。測試在 `tests/opencode-session-retention-run.test.ts` 與 `tests/execution-queue-idle.test.ts`。
     - 紅燈：`parseSpaceStats` 與 `isIdle` 先放回傳固定值的 stub，`runRetentionOnce` 先不做回收。執行 `npx tsx --test tests/opencode-session-retention-run.test.ts tests/execution-queue-idle.test.ts`，exit 1，24 個測試中 8 個失敗，都是斷言失敗（預期 `reclaimed`、`below-threshold`、`busy`、`recently-reclaimed`、`failed` 實得 undefined；`isIdle` 預期 true 實得 false；空間解析與 CLI 參數不符）。「停用時不讀取空間」在 stub 下本來就會通過。
     - 最小實作後：同一命令連同 `tests/execution-queue-cancel.test.ts` 共 27 個，exit 0、全部通過。
     - 單迴圈合併：回收的判斷與執行器都以注入的 deps 在同一層觀察；真實的 `VACUUM` 與並行行為在步驟 1 已實測，端到端由步驟 6 承擔。
     - 重構：no-op；新程式經 prettier 格式化。
     - 專案 gate：`npm run build` exit 0；`npm run test` exit 0，`# tests 479`、`# pass 479`、`# fail 0`，70 個測試檔；`npm run lint` exit 0。
6. ✅ **複本上的端到端驗證與文件**（SCN-001、SCN-002、SCN-006）
   - 產出：以實作後的映像對資料庫複本跑完整清理的紀錄；`docs/configuration-reference.md`、`CLAUDE.md`（模組表與相關段落）的更新。
   - 相依：步驟 3、5。啟動容器屬 `docs/agents/project.md` 列的使用者決定事項，執行前取得同意；只啟動 agent-runner，掛載的是複本，不碰任何運行中的部署。
   - 完成判準：清理後複本中早於保留期且未綁定的 session 數為零、綁定中的 session 仍在、檔案大小下降；`opencode run -s <綁定 id>` 仍可接續；文件寫明預設啟用、停用方式，以及升級後首次清理會刪除舊 session。
   - 證據（2026-10-16）：[evidence/step6-e2e-copy.md](evidence/step6-e2e-copy.md)。使用者同意後，以本分支建出的本機映像啟動拋棄式 agent-runner，對正式資料庫的複本執行：
     - 啟動 log 顯示清理以預設值排程（30 天、每小時）。
     - 以編譯後的實作與真實 opencode 跑 25 輪，刪除 2,327 個 session、0 失敗。早於保留期且未綁定的頂層 session 從 2,326 降到 0，綁定的 135 天前 session 仍在。
     - 檔案從 221.1 MB 降到 164.4 MB，第 3 輪觸發回收，之後一天一次的限制生效。
     - `opencode run -s <綁定 id>` 接續成功，訊息從 4 則變 7 則，沒有新增 session。
     - 編譯後的 `defaultProbe` 執行後沒有留下 session。
     - 映像、容器與複本都已刪除，正式部署全程 healthy。
     - 文件：`docs/configuration-reference.md` 新增「opencode session 保留期清理」一節，寫明預設啟用、停用方式與升級後的第一輪；`CLAUDE.md` 更新 Key Modules 表與模型健康檢查段落；`ARCHITECTURE.md` 更新模組清單；`.env.example` 已在步驟 3 更新。

## 風險與首要驗證

見 [README.md](./README.md) 的「風險與首要驗證」。步驟 1 即首要驗證。

次要風險：清理與 opencode 任務同時寫入同一個資料庫。opencode 以 WAL 模式開啟資料庫，刪除與任務並行理論上可行，實際結果由步驟 1 確認；不成立時，清理改為只在沒有任務執行時進行。

## 檢查清單

- [x] 2026-10-16 步驟 1 的實測在寫清理程式之前完成
- [x] 2026-10-16 資料庫複本放在 repo 之外，驗證後已刪除
- [x] 2026-10-16 證據檔只含彙總數字（無對話內容、token、使用者 ID、本機路徑）
- [x] 2026-10-16 `docker-compose.yml`、`docker-compose.release.yml` 沒有變更
- [ ] 發版說明提醒：預設啟用，升級後首次清理會刪除 30 天以前的 session，並附停用方式
- [x] 2026-10-16 依 `docs/agents/project.md` 的常青文件對照更新受影響的文件（configuration-reference、CLAUDE.md、ARCHITECTURE.md、.env.example）
