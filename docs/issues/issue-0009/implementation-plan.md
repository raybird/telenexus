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

純函式：輸入 session 清單、現在時間、保留天數，輸出要刪的 session。規則：

- 以最後更新時間判斷是否過期，而不是建立時間。長期沿用的聊天 session 建立得早但一直在更新。
- 最後更新時間最新的那一個 session 一律保留，不論多舊。
- 每次最多回傳固定數量，最舊的優先。

### 執行與排程

- 定期執行（暫定每天一次，在離峰時段），啟動後不立刻跑。
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

刪除後檔案不會縮小，但空出的頁面會被重複使用，檔案不再長大。要讓檔案變小需要 `VACUUM`，它在執行期間需要獨佔資料庫。條件：沒有 opencode 任務在執行，且可回收空間超過門檻。門檻與做法由步驟 1 決定。

## 測試策略

| 驗收    | 層級                         | 證據                                                                               |
| ------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| SCN-001 | 單元測試加資料庫複本上的實跑 | 挑選邏輯的紅綠重構證據；複本上刪除前後各資料表筆數的差異                           |
| SCN-002 | 單元測試加資料庫複本上的實跑 | 最新 session 已過期時不被選中；複本上清理後 `opencode run -c` 仍接續同一個 session |
| SCN-003 | 單元測試                     | 設定解析的預設值、自訂天數與停用                                                   |
| SCN-004 | 單元測試加實跑               | 探針結束後呼叫了刪除；實跑後 session 數不增加                                      |
| SCN-005 | 單元測試                     | 以失敗的執行器驅動：記錄 runtime issue、不拋出、下一輪重試                         |
| SCN-006 | 資料庫複本上的實跑加單元測試 | 回收前後的檔案大小與耗時；有任務執行時不回收的判斷                                 |

資料庫複本上的實跑是實地觀測。反向自檢：刪除沒有生效時，筆數差異會是零、檔案大小不變，與成功時不同。對照組是清理前的同一份複本。

## 實作步驟

1. 📝 **在資料庫複本上驗證 opencode 的刪除與回收行為**（SCN-001、SCN-002、SCN-006）
   - 產出：實測紀錄，存於本目錄 `evidence/`；TBD-1 與 TBD-2 的結論。
   - 相依：無。資料庫複本放在 repo 之外，含有私人對話，不進版控，驗證完即刪除。
   - 完成判準：以下每一項都有實際輸出為證。`session delete` 後該 session 的訊息與片段筆數歸零，其他 session 不變，子 session 的處理方式明確；單次刪除與連續刪除 100 個的耗時；有 `opencode run` 在執行時刪除另一個 session 的結果；`session list` 的排序與 `updated` 欄位的意義；`VACUUM` 前後的檔案大小、耗時，以及期間另一個連線讀寫的行為；清理後 `opencode run -c` 接續的是哪一個 session。
2. 📝 **挑選待刪 session 的邏輯**（SCN-001、SCN-002）
   - 產出：挑選函式與單元測試。
   - 相依：步驟 1（`updated` 的意義與排序）。
   - 完成判準：測試涵蓋過期與未過期、最新 session 已過期、清單為空、數量超過上限、時間欄位缺漏；先紅後綠；期望值是寫死的案例，不由測試重算。
3. 📝 **清理的執行、排程與設定**（SCN-001、SCN-003、SCN-005）
   - 產出：清理服務、`runner.ts` 與 `main.ts` 的掛載、`.env.example` 的設定。
   - 相依：步驟 2。
   - 完成判準：預設值、自訂天數與停用都有測試；執行器失敗時記錄 runtime issue 且不影響呼叫端（先紅後綠）；同一份部署只有一個服務會執行清理；`npm run build`、`npm run test`、`npm run lint` 都是 exit 0。
4. 📝 **探針 session 用完即刪**（SCN-004）
   - 產出：`model-health-check.ts` 的變更與測試。
   - 相依：步驟 3；issue 0008 的探針變更（TBD-3）。
   - 完成判準：探針成功與失敗兩種情況都會刪除自己的 session；刪除失敗不改變探測結果。
5. 📝 **空間回收**（SCN-006）
   - 產出：回收的判斷與執行，及其測試。
   - 相依：步驟 1、3。
   - 完成判準：有任務執行時不回收（測試）；可回收空間低於門檻時不回收（測試）；回收失敗記錄 runtime issue 且不影響服務。
6. 📝 **複本上的端到端驗證與文件**（SCN-001、SCN-002、SCN-006）
   - 產出：以實作後的映像對資料庫複本跑完整清理的紀錄；`docs/configuration-reference.md`、`CLAUDE.md`（模組表與相關段落）的更新。
   - 相依：步驟 3、5。啟動容器屬 `docs/agents/project.md` 列的使用者決定事項，執行前取得同意；只啟動 agent-runner，掛載的是複本，不碰任何運行中的部署。
   - 完成判準：清理後複本中早於保留期的 session 數為零、最新的 session 仍在、檔案大小下降；`opencode run -c` 仍可接續；文件寫明預設啟用、停用方式，以及升級後首次清理會刪除舊 session。

## 風險與首要驗證

見 [README.md](./README.md) 的「風險與首要驗證」。步驟 1 即首要驗證。

次要風險：清理與 opencode 任務同時寫入同一個資料庫。opencode 以 WAL 模式開啟資料庫，刪除與任務並行理論上可行，實際結果由步驟 1 確認；不成立時，清理改為只在沒有任務執行時進行。

## 檢查清單

- [ ] 步驟 1 的實測在寫清理程式之前完成
- [ ] 資料庫複本放在 repo 之外，驗證後已刪除
- [ ] 證據檔只含彙總數字（無對話內容、token、使用者 ID、本機路徑）
- [ ] `docker-compose.yml`、`docker-compose.release.yml` 沒有變更
- [ ] 發版說明提醒：預設啟用，升級後首次清理會刪除 30 天以前的 session，並附停用方式
- [ ] 依 `docs/agents/project.md` 的常青文件對照更新受影響的文件
