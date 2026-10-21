# Issue 0015 實作計畫 - 舊版 project scope 記憶的分類遷移工具

驗收劇本見 [README.md](README.md#gherkin-驗收劇本)，風險與首要驗證見 [README.md](README.md#風險與首要驗證)。

## 前置分析

調查與模擬都在另一台部署的資料副本上完成，見 [investigation-scope-classification.md](evidence/investigation-scope-classification.md) 與 [investigation-migration-simulation.md](evidence/investigation-migration-simulation.md)。對設計有影響的結論：

- **分類依據**：每個舊 session 的 `UserMessage` 事件 metadata 都有 `platform` 與 `user_id`，與 summary 字串裡的 `platform=` 不一致 0 筆，不需要靠內容猜。舊資料沒有 `memoryIntent`，所以重建的 summary 不會帶【決策】之類的後綴。
- **只改 scope 召不回**：summary、`recall_fts` 與 `memory_nodes` 的 title／summary 都是 metadata，必須從事件重建 summary。
- **索引交給 Memoria 重建**：`memoria index build` 只處理沒有 `memory_node_sources` 的 session。刪掉這些 session 的 sources 與 level-2 node，再刪掉因此失去來源的舊 topic 與 root node，就不必手寫 `memory_nodes`。`sessions` 的 UPDATE trigger 會自動重建 `recall_fts`。
- **其他資料表**：`memory_utility` 以 ref id 記錄，session ID 不變就不受影響；`memory_sources`、`memory_attributes`、`sources` 在副本裡都是 0 筆。
- **遠端模式**：正式 Compose 裡 telenexus 平常讀不到 `memoria_data` volume，所以工具要以 `docker compose run` 另外掛載 volume 來執行。Memoria 停止期間，telenexus 的同步會進 hook queue，之後補送，不會遺失。

## 設計方案

### CLI

```bash
node dist/tools/memoria-legacy-scope-cli.js [--db <sessions.db>] [--from-scope project:TeleNexus] [--write] [--json]
npm run memoria:migrate-legacy-scope -- [同上]
```

- `--db` 預設沿用 `resolveMemoriaSessionsDbPath()`，也就是 `MEMORIA_ARCHIVE_DB` 或 `MEMORIA_HOME/.memory/sessions.db`。
- `--from-scope` 預設 `project:TeleNexus`；只處理 `scope` 等於它的 session。
- 不加 `--write` 只預覽（SCN-001）。
- 備份與遷移紀錄放在資料庫所在目錄下的 `legacy-scope-migration/<時間戳>/`，所以在容器裡會留在 Memoria 的 volume 內。紀錄含 session ID，不離開 volume。

### 流程

1. **前置檢查**（SCN-008）：`PRAGMA quick_check` 必須是 `ok`；`sessions`、`events`、`memory_nodes`、`memory_node_sources` 必須有遷移用到的欄位。任何一項不符就以非 0 結束，不寫入、不備份。
2. **服務檢查**（SCN-007，只在 `--write` 時）：設定了 `MEMORIA_ENDPOINT` 時，以短逾時打 `/v1/health`；有回應就拒絕寫入。沒有設定時印出「略過檢查」的警告，由操作文件要求先停止 Memoria。
3. **分類**（SCN-002、SCN-004）：純函式，輸入舊 session 與其事件，輸出遷移計畫與人工審閱清單。
   - 歸入人工審閱的情況：沒有 `UserMessage`，或有多筆；metadata 無法解析、缺 `user_id`；`platform` 不是 `telegram`／`console`／`scheduler`；`ModelMessage` 的 `platform` 或 `user_id` 與 `UserMessage` 不一致；事件內容無法取出文字。
   - 目標 scope：`scheduler` → `scheduler:<user_id>`，其餘 → `user:<user_id>`，與 `buildScope()` 相同。
   - summary：重用 `memoria-sync.ts` 的 summary 組法，輸入事件 content 裡的 `text`。
4. **寫入**（SCN-003、SCN-009，只在 `--write` 且計畫非空時）：
   1. 以 `VACUUM INTO` 產生備份檔。
   2. 在一個 `BEGIN IMMEDIATE` transaction 裡：更新 `scope` 與 `summary`；刪除這些 session 的 `memory_node_sources` 與 `node:session:<id>`；刪除舊分區裡失去來源的 level-1 node 與沒有子節點的 level-0 node。
   3. commit 前自我檢查：events 筆數與內容雜湊不變，舊分區只剩人工審閱的 session。不符就回滾並以非 0 結束。
   4. 寫出遷移紀錄（逐筆 session ID、原 scope、新 scope、分類依據，加上統計）。
5. **重跑**（SCN-006）：計畫為空時不備份、不開 transaction，只回報人工審閱清單。

### 使用方式對照

| | 變更前 | 變更後 |
|---|---|---|
| 舊記憶 | 沒有工具，只能手寫 SQL（本機 2026-08-14 就是這樣遷的） | 預覽 → 停 Memoria → `--write` → `memoria index build` → 啟動 Memoria |
| 回復 | 無 | 停 Memoria，以備份檔覆蓋 `sessions.db`，刪除 `-wal`／`-shm`，再啟動 |

確切命令（volume 名稱、使用者、entrypoint）由步驟 1 驗證後寫進 `docs/installation.md`。

## 測試策略

- **單元測試**：`tests/memoria-legacy-scope.test.ts`。合成資料庫的結構取自 Memoria 1.28.1 的 DDL（只有結構，不含資料），連同 FTS trigger 一起建立，這樣 `recall_fts` 的變化也測得到。
- **舊程式基準**：`memoria-sync.ts` 只匯出 summary 函式、不改行為，以既有測試在修改前後同組綠燈作為等價證據。
- **端到端**：在拋棄式 Compose 專案上，以 release 映像（步驟 1）和本分支建出的映像（步驟 4），對資料副本與合成的兩位使用者資料實際執行。
- **環境隔離**：測試與 CLI 一律以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行；端到端用獨立的 Compose 專案名稱與 volume，不碰 `~/Documents/RunTelenexus` 的部署與它的 volume，不啟動 telenexus 服務本身（不需要 Telegram token）。
- **去識別化**：公開證據只放統計、遮蔽後的 ID 與問句主題；資料副本、凍結問句原文、遷移紀錄都留在 repo 之外。

| Scenario | 測試層級 | 證據 |
|---|---|---|
| SCN-001 | 單元：預覽前後檔案雜湊相同、目錄裡沒有新檔 | 步驟 2 |
| SCN-002 | 單元：scope、summary、索引節點、events 不變 | 步驟 3 |
| SCN-003 | 單元：備份可開啟且與寫入前內容相同；紀錄的欄位與統計 | 步驟 3 |
| SCN-004 | 單元：每種歸入審閱的情況各一筆 | 步驟 2 |
| SCN-005 | 單元（兩位使用者的分區）＋端到端（重建索引後以 Memoria 召回） | 步驟 3、4 |
| SCN-006 | 單元：連跑兩次 | 步驟 3 |
| SCN-007 | 單元：以本機假服務回應 `/v1/health` | 步驟 2 |
| SCN-008 | 單元：缺欄位的資料庫、損壞的資料庫 | 步驟 2 |
| SCN-009 | 單元：在 transaction 中注入失敗，比對前後內容 | 步驟 3 |
| SCN-010 | 端到端：備份覆蓋後比對各資料表筆數與內容雜湊 | 步驟 1、4 |
| SCN-011 | 端到端：依文件的命令實際執行 | 步驟 4 |
| SCN-012 | 端到端：凍結問句在遷移前後的召回 | 步驟 4 |

## 實作步驟

1. ⏳ **在拋棄式 Compose 部署上驗證操作路徑**（首要驗證；SCN-010、SCN-011 的前提）
   - 做法：以 release 映像 v2.30.1 與 `docker/memoria.Dockerfile` 建立獨立的 Compose 專案，把資料副本放進它的 Memoria volume。依序跑：停 Memoria、以 telenexus 映像掛載 volume 執行調查腳本的 `full` 模式（含 `VACUUM INTO` 備份）、以 Memoria 映像跑 `memoria index build`、啟動 Memoria 並召回、再以備份覆蓋並確認回復。
   - 產出：`evidence/step1-operational-path.md`，記錄每個命令、結果，以及需要調整的前提（volume 名稱、使用者與權限、entrypoint、唯讀 rootfs）。
   - 完成判準：整條路徑都跑通，或找出不成立的前提並據此修訂本計畫的 CLI 設計；回復後各資料表筆數與內容雜湊與遷移前相同，Memoria 健康檢查通過。
   - 相依：無。
2. ⏳ **分類、預覽與防護**（SCN-001、SCN-004、SCN-007、SCN-008）
   - 做法：先寫測試確認失敗，再實作前置檢查、服務檢查、分類與預覽輸出，以及 CLI 骨架。`memoria-sync.ts` 匯出 summary 函式前後跑既有測試。
   - 產出：`src/services/memoria-legacy-scope.ts`、`src/tools/memoria-legacy-scope-cli.ts`、`package.json` 的 script、測試與 `evidence/step2-red-green.md`。
   - 完成判準：上列 Scenario 的測試先紅後綠，突變檢查會轉紅；既有測試維持通過。
   - 相依：步驟 1。
3. ⏳ **寫入、備份、紀錄與回滾**（SCN-002、SCN-003、SCN-005 的分區部分、SCN-006、SCN-009）
   - 做法：同上，先紅後綠。
   - 產出：同一組檔案與 `evidence/step3-red-green.md`。
   - 完成判準：上列 Scenario 的測試先紅後綠，突變檢查會轉紅；`npm run build`、`npm run test`、`npm run lint` 通過。
   - 相依：步驟 2。
4. ⏳ **在資料副本上端到端量測**（SCN-005 的召回部分、SCN-010、SCN-011、SCN-012）
   - 做法：以本分支建出的映像重跑步驟 1 的路徑，這次用正式工具與文件草稿上的命令。召回沿用模擬時凍結的問句與 `run-recall.mjs` 的 payload。另以合成的兩位使用者資料驗證 SCN-005。
   - 產出：`evidence/step4-end-to-end.md`（去識別化）。
   - 完成判準：SCN-012 的各項數字都列出，且舊決策命中數高於遷移前、排程與其他 scope 的注入為 0；回復後內容雜湊相同。
   - 相依：步驟 3。
5. ⏳ **操作文件與常青文件**
   - 做法：`docs/installation.md` 的「升級」下新增舊記憶遷移一節，寫明預覽、停止、寫入、重建索引、啟動與回復的命令，以及 Memoria 停止期間同步會進 hook queue。依需要更新 `docs/configuration-reference.md`。以步驟 4 的量測結果起草 TBD-1 的 GitHub issue。
   - 產出：文件變更；TBD-1 的 issue 草稿。
   - 完成判準：文件的命令與步驟 4 實際跑過的一致；`npm run build`、`npm run test`、`npm run lint` 通過。
   - 相依：步驟 4。

## 檢查清單

- [ ] 步驟 1 的前提都已驗證，CLI 設計已依結果修訂
- [ ] SCN-001～SCN-012 都有對應證據
- [ ] 測試與 CLI 都在 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 下執行，沒有碰到 `~/.memoria` 與正式部署
- [ ] 公開證據已去識別化
- [ ] `npm run build`、`npm run test`（核對 `# tests` 數與測試檔數）、`npm run lint` 通過
- [ ] 改 symbol 前跑 `gitnexus_impact` 並 `grep`；提交前跑 `detect_changes`
