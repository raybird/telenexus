# 審查報告
- 範圍：完整交付範圍（本機獨立審查，未開 PR）
- Reviewed BASE SHA：9ff41121a4c847c85ce301d771cb0e88466ca26e（main）
- Reviewed HEAD SHA：e0585ce3a2dd0c6025ce8fc903731532342ae10b
- Reviewed patch-id：b802aac57d3da1690d167eb0b1b022530efead1a（reviewer 以 `git diff -a 9ff4112 e0585ce | git patch-id --stable` 重算，與協調者提供的一致）
- 審查日期：2026-10-21
- 獨立 reviewer：Claude（Opus 5.5）隔離 subagent，沒有參與本 issue 的實作
- Review artifact：docs/issues/issue-0015/review-e0585ce.md

## 問題與風險

### MUST FIX
無。

### SHOULD FIX

1. **服務檢查把「有回應但不是 2xx」和「回應太慢」都當成 Memoria 已停止**
   - 位置：`src/services/memoria-legacy-scope.ts:387-394`。它沿用 `src/core/memoria-recall.ts:365-377` 的 `pingMemoriaEndpoint()`，這個函式只有在 2 秒內收到 2xx 才回 `true`，其餘一律回 `false`。
   - 實測：本機假服務回 503、回 404，或延遲 3 秒才回 200，工具都照樣寫入，`serviceCheck.reachable=false`。CLI 還會印出「連不上，視為 Memoria 已停止」。Memoria 1.28～1.30 的 `/v1/health` 在 `runVerify` 不通過時會回 503，例如目錄缺漏或沒有寫入權限，而 v2.18 非 root 化遇過這類權限問題。
   - 這和核准的規格不一致：實作計畫寫「有回應就拒絕寫入」，SCN-007 寫「能連上設定的 Memoria 服務」。`docs/installation.md:80` 也寫「連得上就拒絕寫入」。
   - 為什麼不列 MUST FIX：
     - 文件的主要控制是第 2 步 `docker compose stop`，服務檢查只是操作人員跳過這一步時的第二道防線。
     - 即使 Memoria 在跑，寫入仍在 `BEGIN IMMEDIATE` 的單一 transaction 裡，SQLite 的鎖保證不會交錯或損毀。
     - 實際的影響是 Memoria 可能短暫收到 SQLITE_BUSY，以及備份不含備份與 transaction 之間寫入的資料。
   - 建議：只把連線層的「確定沒有服務」視為已停止，也就是 `ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`。逾時和任何 HTTP 回應（不論狀態碼）都拒絕寫入。補上 503 與逾時兩個測試。建議在正式部署執行前修好。

2. **`--db` 預設值與 npm script 讓工具可能在主機上對錯的資料庫寫入，而且服務檢查必定失效**
   - 位置：`src/tools/memoria-legacy-scope-cli.ts:43`，以及 `package.json` 的 `memoria:migrate-legacy-scope`。
   - `--db` 預設用 `resolveMemoriaSessionsDbPath()`，會優先取 `MEMORIA_HOME`。維護者主機的 `MEMORIA_HOME` 是私人的 `~/.memoria`，repo 的 `.env` 沒有任何 `MEMORIA_*` 設定。
   - 所以在 repo 裡直接執行 `npm run memoria:migrate-legacy-scope -- --write` 時：
     - 目標是私人的 Memoria。
     - 端點是預設的 `http://memoria:3917`，主機解析不到，所以一定被「視為已停止」。
   - 分類條件要求 `platform` 必須是 telegram／console／scheduler，而且要有 `user_id`，所以私人資料被搬動的機率很低。但這是一個不必要的陷阱：計畫已決定「文件一律明寫 `--db`」，預設值在正式流程裡用不到。
   - 建議：沒有明寫 `--db` 時拒絕執行，至少在 `--write` 時拒絕。

3. **常青文件少一筆**
   - `package.json` 新增了 `memoria:migrate-legacy-scope`，但 `CLAUDE.md` 的 Common Commands「Memory tooling」區（`CLAUDE.md:36` 起）沒有補上。`docs/agents/project.md` 的常青文件表規定 npm scripts 要更新這一區。
   - 建議：補一行，並註明這個命令要搭配 `--db`，正式部署照 `docs/installation.md` 的方式執行。

4. **SCN-013 的核准紀錄沒有依修訂規則展開**
   - 位置：`docs/issues/issue-0015/README.md:158`。
   - `docs/agents/acceptance.md`「Gherkin 核准紀錄」規定：出現分批或修訂時，要展開成 `| Scenario | 核准日期 | 狀態 |` 表格，並更新基線提交。
   - 目前只有一句摘要，`核准 commit` 仍是 ee4340b，而那個提交不含 SCN-013。SCN-013 的 Gherkin 是在 `cf5cbff` 和修正一起提交的。
   - 核准來源有記錄，是使用者選「修共用的截斷函式（建議）」，所以這是紀錄格式與可追溯性的缺口，不是未核准就實作。
   - 建議：展開成 13 列的表格，SCN-013 的基線填 `cf5cbff`。協調者也確認一次：使用者的選擇是否涵蓋 SCN-013 的 Then 原文（另見 NICE TO HAVE 第 1 項）。

5. **「不會誤刪其他 scope 的節點」沒有回歸守門**
   - 位置：`src/services/memoria-legacy-scope.ts:254-263`。
   - 突變檢查：把兩條 `DELETE FROM memory_nodes` 的 `scope = ?` 條件拿掉，21 個測試全綠。原因是測試資料裡沒有其他 scope、而且沒有來源或子節點的節點。
   - 行為本身正確：我用合成資料驗證過。`user:1` 裡沒有來源的 topic 和沒有子節點的 root 都保留；舊分區裡只剩已遷移 session 的 topic 被刪，仍有人工審閱 session 的 topic 與 root 保留。在資料副本上寫入後，其他 scope 的 `memory_nodes` 與來源雜湊也完全不變。
   - 這屬於證據持久力，不是假綠燈。
   - 建議：補一個寫入測試，事先放入其他 scope 的孤兒 topic 與 root，斷言寫入後仍在。

### NICE TO HAVE

1. `需決策`：**SCN-013 的 Then 寫「不含切成一半的 emoji」，實作只處理 surrogate pair。**
   - 位置：`src/core/memoria-sync.ts:84-91`。
   - 國旗（🇹🇼）、ZWJ 組合（👨‍👩‍👧）與膚色修飾仍可能被切成合法、但只剩一半的字形。這不會產生不合法的 UTF-8，而 README 寫明的修訂動機正是不合法的 UTF-8。
   - 待決問題：要把 Then 的措辭收斂成「不留下落單的 surrogate（不寫出不合法的 UTF-8）」，還是改用 `Intl.Segmenter` 以字形為單位截斷？
   - reviewer 建議收斂措辭，因為字形截斷會改變正式同步的長度語意，超出這次修訂。

2. **自我檢查其實測得到。**
   - `evidence/step3-red-green.md:51` 寫「沒有可以造出違反情況的測試」，但用與 SCN-009 相同的 trigger 手法就能造出來。
   - 我實測兩種：`AFTER UPDATE ON sessions` 改寫 events，以及在舊分區插入一筆 session。兩者都觸發自我檢查，整批回滾，檔案位元組與執行前相同。
   - 建議補成測試。另外 `ModelMessage 超過一筆` 這條審閱規則沒有測試，拿掉也不會轉紅。

3. **操作文件可以再補三點**（`docs/installation.md:82-90`）：
   - 工具輸出的備份路徑是 `/memoria/.memory/…`，回復命令在 Memoria 容器裡要寫成 `/data/.memory/…`，兩者的對應建議明寫。
   - 回復會一併丟掉遷移後新增的所有記憶。
   - 重建索引前不要跑 `memoria prune --stale-days`。遷移後的 session 暫時沒有 `memory_node_sources`，正好符合 Memoria `pruneStaleMemory` 刪除 session 與事件的條件。

4. **人工審閱的原因文字不精確。** `user_id` 存在但不是字串時，原因寫成「缺少 user_id」（`src/services/memoria-legacy-scope.ts:93-94`）。結果是保守的，只是文字不準。

5. **重複計算。** `writeMigration` 的 `record` 與 `buildReport` 各自計算 `totals` 與 `byTargetScope`（`src/services/memoria-legacy-scope.ts:308-326`、`337-361`），可以讓紀錄由同一份計畫物件產生。規模很小，不影響正確性。

6. **版本相容檢查沒有涵蓋 trigger。** `assertUsable` 只檢查欄位，沒有檢查 `trg_recall_fts_sessions_au` 是否存在。如果 Memoria 改版拿掉這個 trigger，`recall_fts` 會留著舊的 metadata body，而且不會報錯。目前釘的是 1.28.1，沒有立即風險。

## 已查核維度

### 驗收與證據

| Scenario | 證據位置 | 結論 |
|---|---|---|
| SCN-001 預覽唯讀 | `tests/memoria-legacy-scope.test.ts` 的三個 SCN-001 測試（檔案 SHA-256 與目錄清單）；步驟 4 第 1 步。reviewer 另在唯讀目錄（目錄 500、檔案 400）對副本執行預覽：exit 0，檔案雜湊不變，沒有產生 journal | 成立 |
| SCN-002 分區、重建 summary、移除索引、事件不變 | 單元測試 SCN-002（含字面值 summary 與 `recall_fts` body）。reviewer 在副本上寫入：events、`memory_utility`、`wiki_pages` 雜湊不變，`foreign_key_check` 0 筆，`quick_check` ok，`recall_fts` 與 summary 不一致 0 筆 | 成立 |
| SCN-003 備份與紀錄 | 單元測試 SCN-003。reviewer 把副本寫入後的備份與原檔比對：38 張表（含 FTS shadow table）、schema、`user_version`、`page_size`、`journal_mode` 全部相同 | 成立 |
| SCN-004 歸屬不明不遷移 | 8 種情況的預覽與寫入測試；突變「UserMessage 不要求剛好一筆」「不檢查 ModelMessage 一致」reviewer 重跑都轉紅 | 成立；「ModelMessage 多筆」的規則沒有守門（NICE 2） |
| SCN-005 多使用者隔離 | 單元測試（分區）；步驟 4 的合成兩位使用者端到端召回 | 成立 |
| SCN-006 重跑 | 單元測試；步驟 4。reviewer 在副本上再跑一次 `--write`：遷移 0 筆，`legacy-scope-migration/` 仍只有 1 個目錄 | 成立 |
| SCN-007 Memoria 執行中拒絕寫入 | 單元測試（假服務回 200）；步驟 4 實際的 Memoria | 200 的情況成立。503、404 與逾時會誤判（SHOULD 1） |
| SCN-008 資料不符就中止 | 檔案不存在、缺欄位、資料頁損壞，預覽與寫入各一組 | 成立 |
| SCN-009 失敗時整批回滾 | 用 trigger 讓第三筆失敗；突變「不包 transaction」reviewer 重跑轉紅；reviewer 另以 trigger 觸發兩種自我檢查，也都回滾 | 成立 |
| SCN-010 以備份回復 | 步驟 1、步驟 4 的指紋表，回復後各表相同，`/v1/stats` 正常 | 成立 |
| SCN-011 依文件跑完 Compose 流程 | 步驟 4 第二輪；命令與 `docs/installation.md:61-90` 一致，只把 `docker compose` 換成指定拋棄式專案的形式 | 成立 |
| SCN-012 召回量測 | 步驟 4 的量測表：舊決策 0/10 → 7/10，原有資料 2/2，排程與其他 scope 的注入為 0，對照題照實列出 | 成立；樣本小，已揭露 |
| SCN-013 截斷不切開 emoji | `tests/memoria-sync-payload.test.ts` 新測試；reviewer 在 `7ef6ebc` 的 `memoria-sync.ts` 上重現紅燈（`不能有落單的前半`，14 個中 1 個失敗）；舊版在副本上寫出 3 筆不合法 UTF-8 的 summary，新版 0 筆（以 `TextDecoder` fatal 模式逐筆解碼） | surrogate 的部分成立；措辭範圍見 NICE 1 |

### 相關失敗面

| 輸入／狀態 | 預期行為 | 現有覆蓋 | 判定 |
|---|---|---|---|
| 預覽時 Memoria 在跑 | 照常預覽，不需要停 | 單元測試 SCN-001 | 通過 |
| `--write` 時 Memoria 回 200 | 拒絕，沒有任何檔案 | SCN-007 測試與步驟 4 | 通過 |
| `--write` 時 Memoria 回 503／404，或超過 2 秒才回應 | 依規格應拒絕 | 沒有測試；reviewer 探針顯示會寫入 | 缺口（SHOULD 1） |
| 在主機上以預設 `--db` 執行 | 不應碰到不相關的 Memoria | 沒有 | 缺口（SHOULD 2） |
| 改寫中途 SQL 失敗 | 回滾，內容相同 | SCN-009 | 通過 |
| 自我檢查不符（events 被改、舊分區多出一筆） | 回滾 | 沒有測試；reviewer 以 trigger 實測會回滾 | 行為通過，缺測試（NICE 2） |
| 沒有寫入權限，備份目錄建不起來 | 中止，不改寫 | 沒有測試；reviewer 實測輸出「備份失敗，沒有改寫資料庫」，資料庫不變 | 通過 |
| 舊分區的 topic 混有已遷移與人工審閱的 session | 只刪失去所有來源的 topic，root 保留 | SCN-004 寫入測試，加上 reviewer 的合成探針（兩個 topic） | 通過 |
| 其他 scope 有孤兒 topic 或 root | 不動 | reviewer 探針通過；突變「拿掉 scope 條件」沒有測試會轉紅 | 行為通過，缺守門（SHOULD 5） |
| 舊分區有原本就沒來源、卻有子節點的 topic | 刪除時外鍵擋下，整批回滾，fail-safe | 程式審查（better-sqlite3 預設開啟外鍵，資料副本為 1）；副本裡這種節點 0 筆 | 可接受 |
| Memoria `pruneConsolidate`／`pruneStaleMemory` 留下只剩 topic 來源的 session | 以 `session_id` 刪除來源，可以處理；level-2 node 不存在時刪除是 no-op | 程式審查（讀過 Memoria 1.30 `dist/cli.mjs`） | 通過 |
| 舊分區的 topic 也被其他 scope 的 session 當成來源 | 不刪那個 topic | 副本裡 0 筆；條件只看有沒有來源，所以會保留 | 通過 |
| metadata 是 JSON 但不是物件，`user_id` 不是字串、是空字串或只有空白，或缺 platform | 列入人工審閱 | 程式審查加上 SCN-004 測試（缺欄位）；陣列、數字由 `parseObject` 擋下 | 通過（原因文字見 NICE 4） |
| ModelMessage 0 筆 | 照常遷移，summary 只有使用者那一邊（規格沒有要求審閱） | 程式審查；副本裡 0 筆 | 可接受 |
| UserMessage 文字是空字串 | 與正式同步相同，都經 `buildSummary` | 程式審查；副本裡 0 筆 | 可接受 |
| 舊 session 帶 DecisionMade／SkillLearned | summary 不帶後綴 | 副本裡 0 筆；`git log` 確認意圖事件與 scope 分區都在 2026-08-14 加入，舊資料不可能有 | 通過 |
| `--from-scope` 指到 `user:`／`scheduler:` | 不應重寫新資料 | reviewer 推演：目標與來源相同時，「舊分區只剩審閱筆數」的自我檢查會失敗並回滾，但會留下一份備份 | 可接受 |
| 截斷不在 surrogate 上 | 行為與修改前相同 | reviewer 做 20 萬筆隨機差分（含 emoji、ZWJ、國旗、落單 surrogate、空白），新舊版有 19,054 筆不同，全部是「head 以高位 surrogate 結尾、新版少取一個單位」，例外 0 筆 | 通過 |

### 需求、架構、安全、品質

- **資料安全**：
  - 預覽用 `readonly` 開檔，唯讀目錄也能跑。
  - 備份（`VACUUM INTO`）在 transaction 之前完成，失敗就不改寫。
  - 改寫、刪除索引與自我檢查都在同一個 `.immediate()` transaction 裡。計畫在鎖內重算。
  - 計畫為空時直接返回，不備份。
  - 殘餘風險：備份與 `BEGIN IMMEDIATE` 之間不在同一個鎖內。Memoria 停止時沒有影響，這也是 SHOULD 1 值得修的原因之一。
- **分類與正式同步一致**：
  - `toScope` 的判斷與 `buildScope()` 相同。差別只有工具會 trim `user_id`；副本裡帶空白的 0 筆。
  - summary 直接重用匯出的 `buildSummary`，沒有複製邏輯。
  - 舊事件的 `platform` 由當時的同步寫成 `turn.platform || 'telegram'`，一定有值。
- **索引節點**：刪除條件與 Memoria 的索引結構相符。每個 session 有 topic→session 與 session→session 兩筆來源，`index build` 只處理沒有來源的 session。副本寫入後再重建，`memoryIndex.missing=0`（步驟 4）。
- **跨 scope／跨使用者**：副本寫入後，其他 scope 的節點與來源雜湊不變，人工審閱 session 的 2 筆來源保留。
- **SCN-013 的影響範圍**：`truncateForSummary` 的呼叫只在 `buildSummary` 裡（3 處）。`buildSummary` 的呼叫者是 `memoria-sync.ts:356` 的同步路徑，以及遷移服務。行為差異只在截斷點落在 surrogate pair 時出現（見上表）。
- **測試真偽**：
  - SCN-002 的 summary 斷言同時有 `buildSummary()` 的結果和字面值，不是同義反覆。
  - schema fixture 涵蓋遷移碰到的 4 張表、FTS 與 trigger，含外鍵。
  - 我在副本上核對過，其他資料表都不以外鍵指向 `sessions` 或 `memory_nodes`（`wiki_*`、`git_*` 只互相參照），`wiki_pages` 是 `global` scope 的 index-meta。所以 fixture 足以代表遷移相關的真實結構。
  - 沒有發現假綠燈。
- **紅綠燈與突變紀錄**：
  - 步驟 3 的紅燈，reviewer 在 `265369c` 的實作加上 `7ef6ebc` 的測試上重現：21 個中 7 個失敗，就是證據列的那 7 個。
  - SCN-013 的紅燈也重現了。
  - 步驟 2 與步驟 3 列出的突變，我重跑其中 5 個，都轉紅。
  - 步驟 2 的空殼紅燈沒有留下提交，無法重現，所以採信紀錄。
- **證據去識別化**：
  - 新增內容裡沒有本機家目錄路徑、6 位以上的數字 ID、UUID 或 token 樣式。
  - 十六進位字串只有指紋雜湊。
  - 問句只寫主題，或是合成的內容。
- **重複與過度設計**：整體精簡，只有 NICE 5 的小重複。`--from-scope` 是核准計畫裡的選項，因為有自我檢查，誤用時會回滾。
- **常青文件**：`docs/installation.md` 已更新；`docs/configuration-reference.md` 不需要改，理由合理。`CLAUDE.md` 缺一行（SHOULD 3）。

### 豁免、待確認與限制

- Gate 豁免：不開 PR，改由本機獨立審查，見 README「Gate 豁免紀錄」。本報告依這個豁免進行。
- TBD-1（召回門檻校準）已另開 #19；TBD-2 維持「結案時回報」。兩者都不影響本次交付。
- 限制：
  - reviewer 沒有重跑 Compose 端到端流程。SCN-010～SCN-012 採信步驟 1 與步驟 4 的紀錄。
  - 我在資料副本的暫存複本上直接呼叫服務層，交叉驗證了其中與資料有關的數字：2,301／2,300／1，`user:` 1,021、`scheduler:` 1,279，以及審閱原因。
  - Memoria 的行為以主機全域安裝的 1.30.0 原始碼為參考。部署用的是 1.28.1，索引與 prune 的結構以副本的實際 DDL 交叉確認。
  - 資料副本的暫存複本已在審查結束時刪除；報告只寫統計數字。

## 你自己跑過的命令與結果

以下命令都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行，沒有碰 `~/.memoria`、正式部署或 `runtelenexus_*` volume，也沒有啟動任何服務。

- `git diff -a 9ff4112 e0585ce | git patch-id --stable` → `b802aac57d3da1690d167eb0b1b022530efead1a`，一致。
- `npm run build` → exit 0。
- `npm run lint` → exit 0。
- `npm run test` → exit 0：`# tests 540`、`# pass 540`、`# fail 0`。`tests/` 下有 71 個測試檔，`tests/docker/` 4 個檔案的測試名稱都出現在輸出中。
- `npx tsx --test tests/memoria-legacy-scope.test.ts tests/memoria-sync-payload.test.ts` → 35/35 通過。
- 在 scratchpad 的 `git worktree`（`e0585ce`，已移除）做突變：
  - 拿掉兩條節點刪除的 scope 條件 → 0 個失敗。
  - 拿掉兩個自我檢查 → 0 個失敗。
  - 拿掉 ModelMessage 多筆的檢查 → 0 個失敗。
  - 不刪 root → SCN-002 失敗。
  - 不做服務檢查、不包 transaction、計畫為空也備份、UserMessage 不要求剛好一筆、不檢查 ModelMessage 一致 → 都轉紅。
  - 每次都還原，並確認與原檔相同。
- 在同一個 worktree 套用 `265369c` 的實作與 `7ef6ebc` 的測試 → 21 個中 7 個失敗，與步驟 3 的紅燈一致。套用 `7ef6ebc` 的 `memoria-sync.ts` 跑 payload 測試 → 14 個中 1 個失敗（SCN-013）。
- 服務檢查探針（本機假服務）：回 200 時拒絕；回 503、回 404、延遲 3 秒時都寫入。
- 資料副本的暫存複本（只輸出統計）：
  - 預覽：2,301 筆，可遷移 2,300 筆，審閱 1 筆。
  - 寫入：耗時 1.83 秒。其他 scope 的節點、events、`memory_utility`、`wiki_pages` 雜湊都不變，`foreign_key_check` 0，`quick_check` ok，不合法 UTF-8 0 筆，FTS 與 summary 不一致 0 筆。
  - 備份與原檔比對：38 張表、schema、header pragma 全部相同。
  - 重跑：遷移 0 筆，沒有新目錄。
  - 唯讀目錄：預覽 exit 0，雜湊不變；`--write` 回報「備份失敗，沒有改寫資料庫」。
  - 用 `7ef6ebc` 的程式寫入同一份副本：不合法 UTF-8 的 summary 3 筆。
- 截斷差分：20 萬筆隨機字串，例外 0 筆（見失敗面表）。
- 合成資料的索引節點探針：舊分區有兩個 topic、`user:1` 有孤兒節點。結果正確（見失敗面表）。
- 自我檢查探針：兩種 trigger 都回滾，檔案位元組與執行前相同。

## 流程判定

PASS

沒有 MUST FIX；SCN-001～SCN-013 都有證據；重要失敗面也都有證據或行為驗證。SHOULD FIX 第 1、2 項是寫入防線的缺口，建議在正式部署上執行遷移前修好。
