# 審查報告

- 範圍：完整交付範圍（本機獨立審查，未開 PR）
- Reviewed BASE SHA：db05c0afde5d5ffc57fedea110612cbe1e1344a9（main）
- Reviewed HEAD SHA：a64e97c2a610127b06a1d7572f7dd1c4e84bdcaa
- Reviewed patch-id：f7f9bc0bf58412dece121ca8bf5890998c90423a（`git diff db05c0a a64e97c | git patch-id --stable` 重算，與交付紀錄一致）
- 審查日期：2026-10-16
- 獨立 reviewer：Claude Code 獨立 subagent（general-purpose），非原實作者
- Review artifact：docs/issues/issue-0009/review-a64e97c.md

審查範圍是 `db05c0a..a64e97c` 的 7 個提交、29 個檔案（+1468／−62）。風險等級依 README 為 High，原因是刪除不可逆。

## 問題與風險

### MUST FIX

**M1（需決策）：在主機上執行時，清理會刪除不屬於 TeleNexus 的 opencode session**

- 位置：`src/services/opencode-session-retention.ts:321-334`（候選查詢不限範圍）、`src/runner.ts:761-768`（runner 一律掛載）、`src/main.ts:423-429`、`src/services/opencode-session-retention.ts:72`（預設啟用）。
- 問題：清理能安全刪除，前提是 `opencode.db` 只給 TeleNexus 用（README 概述：「TeleNexus 自己另外保存對話紀錄，不會讀取舊的 opencode session」）。容器部署確實如此：compose 用獨立的 named volume `opencode_auth` 掛 `~/.local/share/opencode`，註解寫明「不讀 host ~/.local/share/opencode」。但 README「本機開發」與 CONTRIBUTING.md 都把主機執行（`npm run dev`、`npm run dev:runner`）列為支援的替代方式。在主機上，opencode 用的是開發者自己的全域 `~/.local/share/opencode/opencode.db`，裡面有開發者在所有專案中親自使用 opencode 留下的 session。這台開發機上就有這個檔案。
  - `npm run dev:runner` 一律啟動清理。`npm run dev` 則在 `.env` 沒有 `RUNNER_ENDPOINT` 時啟動。
  - 候選 SQL `select … from session where parent_id is null order by time_updated asc limit N` 沒有用 `directory` 或 `project_id` 限縮範圍。步驟 1 的證據也記錄了「`session list` 不分目錄」。
  - 結果是：只要在主機上跑滿一小時，每小時就會刪掉最多 100 個早於 30 天、和 TeleNexus 無關的個人 opencode 對話，而且不能復原。如果 `session delete` 其實只能刪目前 project 的 session（在主機上 project_id 不是 `global`，這點沒有實測），換成另一種壞結果：別的 project 的舊 session 永遠佔住最舊的 100 個名額，每小時都記一次 `opencode-retention:delete`，清理永遠沒有進度。
- 覆蓋：沒有任何測試、證據或文件提到主機模式。`docs/configuration-reference.md:115-129` 沒有警告，README「本機開發」也沒有。
- 待決問題：主機執行時，清理的範圍與預設值要怎麼定？
- 可選做法：
  1. 候選查詢只選 `directory` 屬於 TeleNexus 工作目錄的 session（容器內實測是 `/app`、`/app/workspace`；主機上是 repo 與它的 `workspace/`）。範圍最窄，能同時擋住以後任何共用 DB 的情境。這會收窄 SCN-001 的適用範圍，需要修訂規格並重新核准。
  2. 預設值依執行環境決定：只有在容器內（例如偵測到 compose 的 `APP_PROJECT_DIR=/app`）才預設啟用，主機執行預設停用。
  3. 保持現狀，只在 `docs/configuration-reference.md` 與 README「本機開發」加上警告：主機執行請設 `OPENCODE_SESSION_RETENTION_ENABLED=false`。殘餘風險要記入 Gate 豁免紀錄。
- reviewer 建議：做法 1，並在文件寫明清理範圍。至少要做到做法 3，並由使用者在 README 的 Gate 豁免紀錄中明確接受殘餘風險。

### SHOULD FIX

**S1（需決策）：「只在一個服務執行」與「有任務時不回收」在部分部署設定下不成立，文件描述與程式不一致**

- 位置：`src/runner.ts:761-768`（runner 不看任何條件，一律掛載）、`src/services/opencode-session-retention.ts:250-253`、`docs/configuration-reference.md:125`、`ARCHITECTURE.md:120`、`CLAUDE.md:101`；計畫步驟 3 的完成判準是「同一份部署只有一個服務會執行清理」（`docs/issues/issue-0009/implementation-plan.md:106`）。
- 問題：
  1. 用 compose 部署、但 `.env` 的 `RUNNER_ENDPOINT` 留空時（compose 是 `${RUNNER_ENDPOINT:-}`，agent-runner 服務照樣啟動），telenexus 與 agent-runner **兩邊都會清理**。兩個計時器在 `compose up` 時幾乎同時啟動，兩邊會查到同一批最舊的 100 個 session。積壓期間每一輪都會互相刪掉對方要刪的 session，製造大量 `opencode-retention:delete`，可能觸發 ErrorAlerter 推播。這種設定下所有工作都在 telenexus 本地執行，但 runner 的 `isIdle` 只看自己的兩條 lane，永遠是 idle，所以 VACUUM 可能在任務執行中進行，違反 SCN-006 的「有任務在執行時不進行空間回收」。
  2. 即使有設 `RUNNER_ENDPOINT`，telenexus 在下列情況仍會在本地執行 opencode：`CHAT_USE_RUNNER_PERCENT<100`、`SCHEDULE_USE_RUNNER=false`、circuit breaker 開啟後的 local fallback，以及 telenexus 自己的模型健康探針。runner 的 `isIdle` 看不到這些工作。依步驟 1 的實測（220 MB 的 VACUUM 不到 1 秒，寫入最多等 390 ms，opencode 的 `busy_timeout=5000`），目前的實際影響很小。但資料庫越大，VACUUM 越久，超過 5 秒就可能讓寫入失敗。
  3. 文件寫「有 `RUNNER_ENDPOINT` 時只在 agent-runner 執行，否則在 telenexus 執行」。實際上 agent-runner 只要在跑就一定會執行。
- 現有覆蓋：`tests/opencode-session-retention-run.test.ts` 只測了 `shouldMainRunRetention` 的回傳值，沒有覆蓋 runner 端的條件，也沒有覆蓋兩邊同時執行的情境。
- 待決問題：沒設 `RUNNER_ENDPOINT` 而 agent-runner 仍在跑的部署要不要支援？
- 可選做法：(a) runner 也加上啟動條件（例如只有在收過工作，或有明確設定時才清理），或改由單一來源決定由誰執行；(b) 不改程式，把文件改成實際行為：「agent-runner 一律執行；telenexus 只在沒設 `RUNNER_ENDPOINT` 時執行；兩者都在跑而 `RUNNER_ENDPOINT` 留空時，兩邊都會清理」，並說明 VACUUM 的閒置判斷只涵蓋執行清理的那個服務。
- reviewer 建議：至少做 (b)，讓文件與程式一致，並把計畫中「同一份部署只有一個服務會執行清理」改寫成實際成立的條件。

### NICE TO HAVE

- **N1**：`src/services/opencode-session-retention.ts:322-324`。SQLite 的 `ORDER BY … ASC` 會把 NULL 排在最前面。`time_updated` 為 NULL 的列會佔住 LIMIT 名額，而 `selectSessionsToDelete` 又會把它們濾掉。這類列一旦達到 100 + 綁定數個，清理就會靜默停住：每輪 deleted 都是 0，也沒有 runtime issue。同樣地，永遠刪不掉的 session 也會一直佔住最舊的名額（這種情況至少會記 runtime issue）。建議在 SQL 加上 `and time_updated is not null`。opencode 的 schema 是否 NOT NULL 沒有證據可查。
- **N2**：`src/services/opencode-session-retention.ts:213`。查詢上限是 100 + 綁定數。綁定數大到讓輸出超過約 64 KB 時（依步驟 1 每列約 87 bytes，約 600 個綁定），JSON 解析會失敗，之後每輪都是 `query-failed`。這種失敗看得到，也不會誤刪；以目前單一使用者的部署可以忽略，只在這裡留紀錄。
- **N3**：`src/services/chat-session-store.ts:28-30`。狀態檔不存在（ENOENT）時視為沒有綁定，對新部署是正確的。但這是建立在「兩個服務共用同一個 `data/`」的假設上。如果 runner 的 `DB_DIR` 和主服務不同（掛載設定錯誤，或 runner 在別處執行），綁定中的 session 會在沒有任何警示的情況下失去保護。建議在 `docs/configuration-reference.md` 寫明這個前提。另外，`ChatSessionStore.persist()` 寫入失敗時，記憶體內的綁定不會落到檔案，也就不受清理保護。這要同時滿足寫入失敗、30 天沒有聊天、期間沒有重啟才會發生，風險極低。
- **N4**：`docs/issues/issue-0009/README.md:13-33`。「涉及檔案」沒有列出 `src/core/execution-queue.ts`（本次新增了 `isIdle()`）與 `ARCHITECTURE.md`。變更本身很小，只是加法，不影響行為，但範圍紀錄應該補上。
- **N5**：`src/services/opencode-session-retention.ts:312`。查詢多取了沒用到的 `pragma_page_size()`；`docs/configuration-reference.md` 也沒有提到 VACUUM 期間需要暫時多一份資料庫大小的磁碟空間（步驟 1 的證據有記，但沒有實測峰值）。

## 已查核維度

### 驗收與證據

| SCN | 證據位置 | 結論 |
| --- | --- | --- |
| SCN-001 | `tests/opencode-session-retention-select.test.ts`（8 個案例，期望值是寫死的 ID 清單）；`tests/opencode-session-retention-run.test.ts`（解析、執行流程，以及用假 opencode 驗證實際送出的 CLI 參數）；`evidence/step1-delete-vacuum-probe.md`（串聯刪除時各資料表的筆數差異）；`evidence/step6-e2e-copy.md` 與 `step6-e2e-runs.jsonl`（25 輪、刪除 2,327 個、失敗 0，早於 30 天且未綁定的 session 從 2,326 降到 0） | 有效。紅燈都是斷言失敗（步驟 2：7/8；步驟 3：15/23），失敗原因與目標行為一致。外層的假 opencode 測試沒有自然紅燈，以變異檢查（`asc` 改 `desc`）補上，並如實揭露。e2e 有寫反向自檢。主機模式另見 M1。 |
| SCN-002 | `tests/opencode-session-retention-select.test.ts`（綁定的 session 過期也不選）；`tests/chat-session-store.test.ts`（毀損時拋出、不存在時視為空）；`tests/opencode-session-retention-run.test.ts`（讀不到綁定就跳過；查詢上限 101 證明有為綁定的 session 多留名額）；step1 與 step6 的 `opencode run -s <綁定 id>` 接續實測，各有對照組 | 有效。對照組（已刪除的 session 回 `Session not found`）證明判準能區分成功與失敗。 |
| SCN-003 | `tests/opencode-session-retention-run.test.ts`：預設值、自訂天數、停用、0／負數／非數字退回 30、啟動時不立刻跑、到間隔才跑、停用時不排程；step6 啟動 log 顯示 `retentionDays=30 intervalMs=3600000` | 有效。 |
| SCN-004 | `tests/model-health-probe-session.test.ts`（成功與 426 失敗都刪除、刪除失敗不改變結果、沒有事件時不刪；session id 取自 1.18.34 的既有 fixture）；step6 的 `probe-e2e.mjs`（探針執行期間出現 1 個新 session，結束後剩 0 個） | 有效。逾時且沒有任何事件時取不到 session id，留給保留期清理處理；這點已如實揭露。 |
| SCN-005 | `tests/opencode-session-retention-run.test.ts`：讀綁定、查詢、單筆刪除、回收各自失敗時記錄 runtime issue 且不拋出；上一輪沒結束時跳過；step1 實測刪除與 `opencode run` 並行都成功 | 有效。「下一次清理時重試」靠排程本身與失敗不拋出的組合承擔，合理。 |
| SCN-006 | `tests/opencode-session-retention-run.test.ts`：達門檻、未達門檻、busy、一天一次、失敗；`tests/execution-queue-idle.test.ts`；step6 第 3 輪 `reclaimed`、檔案從 221.1 MB 降到 164.4 MB | 判斷邏輯有效。但 runner 的 idle 判斷涵蓋不到 telenexus 本地執行的工作，見 S1。 |

**規格修訂查核**：`git diff da76420 a64e97c -- README.md` 只有 SCN-002 的 Given、Then 與標題實質改變。這次修訂有 b5059de 的核准紀錄（2026-10-16，逐題確認 Q1 的原話「綁定中的一律保留」）。`git diff b5059de a64e97c` 沒有動到 Gherkin，只有核准 commit 的回填、TBD 結案、Gate 豁免與 Timeline。核准表與現存的 Scenario 集合完全相等，全部為已核准。

**假綠燈與同義反覆**：沒有發現。期望值都是寫死的字面值或 fixture 中的固定 ID，沒有用和實作相同的方式重算。紅燈都是缺少目標行為造成的斷言失敗。在 stub 下本來就會通過的空結果案例，已逐一說明原因。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
| --- | --- | --- | --- |
| `chat-session-state.json` 毀損（JSON 不完整或是陣列） | 跳過這次清理，記 `opencode-retention:protected-ids` | store 測試與 run 測試 | 正確 |
| 狀態檔權限錯誤（EACCES） | `loadBindings` 只對 ENOENT 回傳空集合，其他錯誤都拋出，所以會跳過 | 沒有直接測試，靠閱讀程式碼確認 | 正確 |
| 狀態檔不存在 | 視為沒有綁定 | store 測試 | 正確，前提是兩個服務共用 `data/`（N3） |
| 主機執行，DB 與個人 opencode 共用 | 不應刪除非 TeleNexus 的 session | 無 | **M1** |
| `RUNNER_ENDPOINT` 留空而 agent-runner 仍在跑 | 只有一邊清理 | 無 | **S1** |
| `RUNNER_ENDPOINT` 有設但 runner 服務沒跑（例如只跑 `npm run dev`） | 沒有人清理，不會誤刪 | 無 | 安全，但沒有文件說明 |
| `opencode db` 輸出經 pipe 截斷 | JSON 解析失敗、記 query、不刪任何 session | run 測試（截斷字串） | 正確；上限計算見 N2 |
| `time_updated` 為 NULL | 不選 | select 測試 | 選取邏輯正確；SQL 名額可能被佔住（N1） |
| SQL 注入 | 唯一的插值是 `Math.max(1, Math.floor(limit))` 算出的數字；session id 以 argv 傳給 `session delete`，不經 shell | 用假 opencode 驗證參數 | 沒有風險 |
| 排程重疊、stop、unref、啟動時不立刻跑 | 都依設計 | run 測試（mock timers） | 正確 |
| `ExecutionQueue` 在 cancel 或 abort 之後 | drain 的 finally 在沒有 pending 工作時會刪掉 state，`cancel` 會清空 pending，所以 states 不會永遠非空 | 閱讀程式碼；idle 測試只涵蓋一般路徑 | 正確。abort 後到子程序真正結束前有很短的 idle 誤判窗口，可以忽略。 |
| `defaultProbe` 逾時或失敗 | 刪除在 resolve 前完成，最多多等 30 秒；刪除失敗只記 `model-health:probe-session-delete`，不改變結果 | probe-session 測試 | 正確。告警判斷、豁免視窗與 `interpretProbeOutput` 都沒有改。健康檢查每小時一次，多 30 秒不影響排程。 |
| 刪除與執行中的任務並行 | 兩邊都成功 | step1 實測（刪除 60 個期間跑 run） | 正確 |
| 子程序生命週期（L-07） | 所有 opencode 呼叫都經 `runProcess` 或 `trackChildProcess`，逾時以 process group 終止；stdin 為 ignore（依 step1 的發現） | 閱讀程式碼 | 正確 |
| L-06：新的呼叫點不使用 `-c` | `session delete`、`db` 不建立 session；探針本來就是新 session | 閱讀程式碼 | 正確 |

### 需求、架構、安全、品質

- **只透過 opencode CLI**：查詢經 `opencode db` 唯讀 SELECT，刪除經 `opencode session delete`，回收經 `opencode db VACUUM`。沒有直接寫入 opencode 的資料表，符合 README 的「不可觸及」。
- **runtime issue 慣例**：新的失敗路徑都經 `recordRuntimeIssue`，scope 分別是 `opencode-retention:{protected-ids,query,delete,vacuum,internal}` 與 `model-health:probe-session-delete`。grep 確認沒有其他程式碼對 `model-health:` 前綴做特殊處理，所以不會誤觸發模型告警。
- **`chat-session-store.ts` 重構前後是否等價**：聊天端的 `readBindings` 對 ENOENT 仍回傳空集合而且不記錄；其他讀取錯誤與解析錯誤都記 `chat-session:state-read` 並回傳空集合，和重構前一致。既有的 6 個 store 測試前後都通過。
- **跨 Task 重複與過度設計**：沒有明顯的過度設計。`opencode session delete` 在保留期清理與探針各呼叫一次，但兩者的逾時與失敗語意不同，分開放可以接受。`selectSessionsToDelete` 在 SQL 已經過濾 `parent_id` 之後又過濾一次，屬於低成本的防禦，可以接受。
- **文件一致性**：`.env.example`、`docs/configuration-reference.md`、`CLAUDE.md`、`ARCHITECTURE.md` 寫的設定名稱、預設值、每次上限、20% 門檻與 runtime issue scope 都和程式一致。唯一不一致的是「由哪個服務執行」（S1）。release bundle 是從 `.env.example` 複製的，`RUNNER_ENDPOINT` 預設有值，所以預設的 bundle 部署落在文件描述的情境內。
- **公開 repo**：evidence 與腳本中的路徑都是容器內路徑（`/home/node/...`、`/app/...`、`/work`），沒有主機家目錄、Telegram 使用者 ID、token 或完整容器 ID。測試裡的兩個 session id 來自 BASE 已存在的 fixture（`tests/fixtures/opencode/1.18.34-*.stdout.jsonl`），不是新揭露的資訊。提交訊息沒有 AI 署名。

### 豁免、待確認與限制

- Gate 豁免（README）：不開 PR，改由本機獨立審查，合併由使用者執行。本報告依此豁免作為審查紀錄。
- `implementation-plan.md` 檢查清單中，「發版說明提醒：預設啟用，升級後首次清理會刪除 30 天以前的 session」尚未勾選。這屬於發版時要完成的事項，不阻擋本次審查，但發版前必須完成。
- 本次審查沒有重跑 step1、step6 的容器實測（任務限制不能啟動容器）。實測結論採信 evidence 中的命令、腳本與彙總數字。腳本與文字描述一致。
- GitNexus 的 impact 會低報呼叫者（project.md），所以呼叫者改用 grep 核對：`executionQueue` 新增的呼叫點只有 `main.ts`；`readBoundSessionIds` 只在保留期服務使用；`defaultProbe` 的唯一呼叫點是 `startModelHealthCheck` 的預設 probe。

### 獨立重跑的 gate 結果

在 repo 的 HEAD `a64e97c` 執行，工作區乾淨（`git status --short` 為空）：

| 命令 | exit code | 摘要 |
| --- | --- | --- |
| `npm run build` | 0 | `tsc` 與 copy-web-assets 都成功 |
| `npm run test` | 0 | `# tests 479`、`# pass 479`、`# fail 0`、`# cancelled 0`、`# skipped 0` |
| `npm run lint` | 0 | 沒有輸出錯誤 |

`find tests -name '*.test.ts' | wc -l` 是 70（BASE 是 66，本次新增 4 個），與 `# tests 479` 相稱（project.md 的 2026-10-01 基準是 46 個檔、284 個測試）。逐一抽查後確認新測試都有實際執行：「綁定中的聊天 session 已過期也不選」「實際的 deps 以 opencode db 讀取空間」「探測成功後刪除自己的 session」「isIdle 為 true」「唯讀取得所有綁定中的」「有 runner 時主服務不清理」都出現在輸出中，結果為 `ok`。數字與計畫步驟 5 記錄的 `# tests 479` 一致。

## 流程判定

**RETURN TO execute-task**

理由：M1 是不可逆的資料刪除，影響的是產品資料邊界以外的資料。它發生在文件列為支援的主機執行模式，而且預設啟用，目前沒有任何測試、證據或文件涵蓋。依 review-evidence.md，有 MUST FIX 就不能 PASS。M1 與 S1 都標了 `需決策`：由協調者依 acceptance.md 的「逐題確認」取得使用者的決定。

- 如果選擇修改程式（M1 的做法 1 或 2），要補上紅綠重構證據，並依規格修訂流程處理 SCN-001 的範圍。
- 如果使用者接受殘餘風險（M1 的做法 3），要補上文件警告，並把這個決定記入 README 的 Gate 豁免紀錄，之後重新審查。

除了 M1、S1 以外，其他驗收與失敗面都有有效證據，gate 也全部通過。
