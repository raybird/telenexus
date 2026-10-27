# 審查報告
- 範圍：完整交付範圍（本機，無 PR）
- Reviewed BASE SHA：70e46d5b3e0fde97782690cb7ac03dc5527e0304
- Reviewed HEAD SHA：4e99cebe4a392ef6b3cf5b5cf8e95deff672b1ac
- Reviewed patch-id：6dc03cdff1c1b26e26f10d731ffdcebb1440b0b2
- 審查日期：2026-10-27
- 獨立 reviewer：Claude Code 獨立 subagent（general-purpose，未參與實作）
- Review artifact：docs/issues/issue-0022/review-4e99ceb.md

審查前先核對過範圍：`git rev-parse HEAD` 是 4e99ceb，`git diff 70e46d5 4e99ceb | git patch-id --stable` 和上面的 patch-id 相同，共 42 個檔、6 個提交（9fd8ea4～4e99ceb）。規格核准 commit 44a2107 是 BASE 的祖先；從 44a2107 到 HEAD，README 只多了回填核准 SHA 的那一行，Scenario 沒有改過。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

**S1　prompt 與出貨的範例設定，仍然告訴 agent 有已停用的 MCP Memory 工具；新寫的退役說明也因此有一句不正確**　`需決策`

- 位置：
  - `src/prompt/builder.ts:584`：每一輪 full prompt 都會帶 `【知識管理 - 重要】\n你有 MCP Memory 工具可以儲存長期知識與關係：`。
  - `ai-config.example.yaml:31-33`：`memory_policy_lines` 寫著「主動使用 create_entities 儲存」「使用 create_relations」「使用 search_entities」，這些是 `mcp-memory-libsql` 知識圖譜的工具。這份檔會進 release bundle（`.github/workflows/release.yml:82`）。新安裝時，`scripts/install.sh:161-162` 會把它複製成 `ai-config.yaml`。所以照 bundle 安裝的部署，prompt 會指示模型去呼叫這些工具。
  - `docs/configuration-reference.md:190`（本次新增）：「2026-03-29 起 prompt 就不再指示它使用知識圖譜」。這句只對程式內建的預設值成立（`src/config/ai-config.ts:28-33`，`tests/ai-config.test.ts:33` 守著）。對 builder 的標題與出貨的範例設定都不成立。README 概述第 14 行的同類說法是這句的來源。
- 影響：
  - 本次交付後，所有部署的 `mcp-memory-libsql` 都停用了。prompt 卻仍然說模型有 MCP Memory 工具，範例設定還點名要它呼叫那三個工具。
  - 模型照做時，會呼叫不存在的工具，浪費回合或得到工具錯誤。
  - 實際風險不高：正式部署在 MCP 還在時，30 天內是 0 次呼叫。但退役之後，這個說法就變成錯的。
  - 文件那句話會讓維護者以為 prompt 已經乾淨了。
- 為什麼要使用者決定：README「涉及檔案」把 `src/prompt/` 列為不可觸及，`ai-config.example.yaml` 也不在本 issue 的檔案清單裡。實作照著範圍做，沒有違規；這是規格當時沒看到的缺口。
- 待決問題：這些殘留要在 #22 內處理，還是另開 issue？
- 可選做法：
  1. **（建議）** 本次只修 `docs/configuration-reference.md:190` 那句話，改成合乎事實的說法，例如「程式預設 prompt 已不指示…；`ai-config.example.yaml` 與 prompt 標題仍有舊說法，見 #<新 issue>」。`builder.ts` 的標題、`ai-config.example.yaml` 的三行，另開 issue 處理，並記入本 issue 的待確認事項作為追蹤去向。理由：改 prompt 會影響每一輪聊天，需要自己的驗收；改文件風險是零。
  2. 擴大 #22 的範圍，一起改 `ai-config.example.yaml`（改成和 `DEFAULT_CHAT_PROMPT_CONFIG.memoryPolicyLines` 相同）與 builder 的標題。要補 Scenario 並重新核准。既有部署的 `ai-config.yaml` 升級時不會被覆蓋，`docs/installation.md` 要另外說明可以手動刪掉那三行。
  3. 接受現狀，只在待確認事項記下殘餘風險。不建議：文件那句話仍然不正確。

### NICE TO HAVE

- **N1** `src/tools/memory-health-cli.ts:15`：`.description('Show memory archive and backfill health')` 還寫著 backfill，`npm run memory:health -- --help` 會顯示出來。步驟 3、4 的 grep 樣式（`memory-backfill|MemoryBackfill|MEMORY_BACKFILL_`）抓不到這個字。建議改成 `Show operational DB and Memoria archive health`。
- **N2** `evidence/step5-image.md`：沒有記錄被測映像的 ID 與來源提交（verification.md「證據重用」要求記被測提交或工作區狀態）。我用 `docker create`＋`docker cp` 補查過（沒有啟動容器）：
  - `telenexus:issue-0022` 的 ID 是 `sha256:8fe79f93fcba…`，Created 是 2026-10-27T15:30:40+08:00，介於 d124140 與 218941d 之間；
  - 映像裡的 `/app/dist/core/opencode.js`、`/app/dist/services/memory-health.js`，和 HEAD 本機 `npm run build` 的輸出逐位元組相同；
  - `/usr/local/lib/node_modules/mcp-memory-libsql` 不存在。

  所以這份證據對 HEAD 有效。建議在證據檔補上映像 ID 與來源提交。
- **N3** `evidence/step4-health-report.md` 的「實跑 `/api/status`」只有輸出，沒有實際命令。靜態 grep 本身已足以證明 SCN-008，這屬於證據持久力的問題。
- **N4** issue 文件的狀態沒有跟上：
  - `docs/issues/issue-0022/README.md:241` 仍是 `**狀態**: 待實作`；
  - `implementation-plan.md:164` 的檢查清單全部沒打勾，但六個步驟都標了 ✅。

  合併或結案時一起更新。
- **N5** `src/core/scheduler.ts:425` 的註解「檢索長期記憶 (MCP Memory)」是既有的舊說法。不在範圍內，跟 S1 一起處理即可。
- **N6** 證據沒有記錄 `gitnexus_detect_changes`。project.md 允許用 grep 與 `git diff --stat` 代替；步驟 3、4 的 grep 清單已涵蓋，不影響判定。
- **N7** SCN-007 測試裡「`memory.db` 大小與 mtime 不變」的斷言，在 BASE 上也會是綠的（BASE 用唯讀連線開它），所以它分辨不出「不讀」。真正擋住回歸的是同一個測試的鍵清單，以及 `context-snapshots` 那條「`memory.db` 是壞檔時不提它」的測試。這是證據持久力的問題，不是假綠燈。

## 已查核維度

### 驗收與證據

| SCN | 證據位置 | 結論 |
|-----|----------|------|
| SCN-001 | `evidence/step1`（A 對照組有 libsql 標記；B、D 沒有；五組都 exit 0、回 `OK`、0 個 error 事件）；`evidence/step5`（N 對照組由 npx 下載並建立 `memory.db`，I 組都沒有）；`tests/opencode-browser-config.test.ts` 的兩個真子程序測試，各多一條 `enabled === false` | 成立。有對照組，標記檔確實觀察得到啟動。I 組的設定由映像內編譯後的 `getEnv()` 產生，不是手寫 |
| SCN-002 | step1 的 E 組（沒有舊設定，加完整條目，stderr 為空）；C 組揭露只給 `enabled` 時會有 ERROR log，因此改成完整條目；單元測試 `issue 0022 SCN-001/002 預設注入…` 斷言條目內容與 `telenexus_browser` 都存在 | 成立 |
| SCN-003 | `issue 0022 SCN-003 使用者自訂的 mcp-memory-libsql 原樣保留`（deepEqual 使用者條目）；突變「`hasOwn` 改成 false」會轉紅（step2）。我另外實測「自訂 browser 加自訂 libsql」：兩者都保留，不帶 audit 檔 | 成立 |
| SCN-004 | `tests/docker/dockerfile-hygiene.test.ts` 的靜態測試（換回舊 Dockerfile 或舊 opencode.json 都會轉紅）；step5 的映像探測；我補查的映像內容（N2） | 成立 |
| SCN-005 | `tests/retired-memory-backfill.test.ts` 的 404 測試，以 `/api/health` 200 作對照組（紅燈時是 200）；`package.json` 已沒有那兩個 script；`main.ts` 已沒有 worker；我自己 grep `src tests scripts package.json skills Dockerfile compose`，除了啟動警告本身沒有殘留 | 成立。「不寫入 `memory.db`／checkpoint／報告」靠的是寫入方都已刪除（worker、CLI、`memory-backfill.ts`），加上 MCP 停用。這屬於靜態的等價證據，可以接受 |
| SCN-006 | 四個輸入：true、1、false、未設定。紅燈用空殼；突變「只認字串 true」會讓 `1` 轉紅。BASE worker 確實用 `parseBool`，而且 BASE 在 false 時會印 `Disabled by…`，HEAD 不再印 | 成立 |
| SCN-007 | `issue 0022 SCN-007…` 檢查鍵清單與 markdown 欄位順序（以字面值寫成）；`context-snapshots` 的壞 `memory.db` 測試；我另外在暫存目錄用 BASE 與 HEAD 兩版 `memory-health.ts` 跑四種情境（本機封存加運作庫、只有空資料夾、封存不是 SQLite、遠端模式），拿掉被移除的行之後，markdown 與 operational／archive 的 JSON **逐字相同** | 成立 |
| SCN-008 | `grep -rin backfill src/web/public` 沒有命中（我重跑過）；`node --check` 三個檔都通過；`status.js` 的 `load()` 已沒有呼叫回填 API | 成立（實跑的命令沒有記錄，見 N3） |
| SCN-009 | step6 的逐項對照表；我讀過 `configuration-reference.md`、`installation.md`、`web-console-reference.md`、`.env*.example` 的 diff，四項 Then 都有對應段落；唯讀檢查命令有 `bash%` 對照組（2917 次） | 成立。但新段落有一句不正確，見 S1 |

**建置與測試（我在 HEAD 4e99ceb 實跑，工作區乾淨）：**

- `npm run build`：exit 0。
- `npm run lint`：exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB TMPDIR=$HOME/.cache/memoria-release-tmp npm run test`：exit 0，`# tests 569`、`# pass 569`、`# fail 0`。
- `find tests -name '*.test.ts' | wc -l` 是 72，和 step6 相同。test script 的 glob 有加引號（L-01）。
- 輸出裡 11 個 issue 0022 的測試都有出現，確實有跑到。

**紅綠與突變的真偽：**

- step2、3、4 的紅燈原因都是缺少目標行為，不是模組不存在。步驟 3 特別用空殼避開這個問題。
- 各步驟提早就綠的測試都有說明它們擋的是哪一種回歸，並以突變證明。
- 沒有看到恆真的斷言。期望值都是字面值，不是由實作推算出來的。
- 被刪除的 38 個測試都只驗證被移除的行為。我抽查 `collectMemoryHealthReport reports cross-db consistency drift`，它只斷言 consistency。保留下來的 operational／archive 斷言都還在。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|------------|------|----------|------|
| `OPENCODE_CONFIG_CONTENT` 未設定 | 停用條目＋browser＋audit 檔 | 單元測試；我的 getEnv 探測 | 通過 |
| `mcp: null` | 視為 `{}`，加上停用條目與 browser | 我的探測（BASE、HEAD 都不 throw） | 通過，和 BASE 一致 |
| `mcp` 是字串、陣列或 `false` | throw「mcp 必須是設定物件」 | 我的探測，BASE 與 HEAD 相同 | 通過 |
| 使用者 inline 自訂 `telenexus_browser`（JSONC，有註解與尾逗號） | browser 條目不動，加上停用條目，不帶 audit 檔 | 單元測試；我的探測 | 通過。輸出由 JSONC 正規化成 JSON，語意相同（BASE 是原字串直接回傳） |
| 自訂 browser＋自訂 `mcp-memory-libsql` | 兩者都原樣保留 | 我的探測 | 通過（沒有專屬單元測試，邏輯是同一個 `hasOwn` 分支） |
| 使用者把 `mcp-memory-libsql` 設成 `null` | 原樣保留 | 我的探測 | 符合 SCN-003 的字面意思；opencode 怎麼處理 null 不在範圍內 |
| 舊 workspace 設定加上 inline 停用條目（opencode deep-merge） | 逐鍵合併，inline 優先，結果是停用；`command` 不會被執行 | step1 的 B、D 組；step5 的 I 組 | 通過 |
| 使用者在全域 opencode 設定或 `OPENCODE_CONFIG` 檔裡定義這個 MCP | 會被 inline 停用條目蓋掉 | 文件只寫 `OPENCODE_CONFIG_CONTENT` 一種保留方式 | 符合規格（SCN-003 只承諾 inline） |
| `countRecentMemoriaIssues` 不再比對 `memory-backfill`／`backfill` | 只有回填產生的 issue 會受影響，而那些來源已經刪除 | grep `src`：沒有其他會記 runtime issue 而且訊息含 backfill 的地方 | 沒有行為差異 |
| `readArchive` 少了 `SELECT id FROM sessions` | 只有 sessions 表缺 `id` 欄的封存，判定會從 error 變成 ok | Memoria 的 schema 一定有 `id` | 實務上沒有差異，可以接受 |
| Web 路由拿掉 `/api/memory-backfill/report` | 落到 404，前後的 `/api/memory-health`、`/api/memory/history` 不受影響 | 404 測試以 `/api/health` 作對照；我讀過 `server.ts` 那一段 | 通過 |
| 前端殘留引用 | 沒有 | grep 沒有命中；`node --check` 通過；`load()` 裡沒有未定義的變數 | 通過 |
| `MEMORY_BACKFILL_ENABLED` 是 `yes`／`on` | warn（沿用 `parseBool`） | `1` 有測，`yes`、`on` 走同一個 `parseBool` | 通過 |
| 本機 `dist/` 留著舊的 `memory-backfill*.js.map` | 不影響映像（`.dockerignore` 排除 `dist/`） | step4 已揭露；映像內 `dist/services` 沒有回填檔（我查過） | 不影響 |
| skills 或 prompt 叫 agent 用 MCP Memory 或跑回填 | 不應該有 | skills 只呼叫 `dist/tools/memory-cli.js` 與 `scheduler-cli.js`；`AGENTS.md` 指向 `memory-cli.js`；沒有任何地方叫 agent 跑 `memory:backfill` | prompt 標題與範例設定有殘留，見 S1 |

### 需求、架構、安全、品質

- **需求**：四件事都完成了：舊設定的 MCP 停用、回填移除、健康報告只留兩區、映像不再裝套件。範圍內「不可觸及」的檔案都沒有改。歷史文件只在 `docs/README.md` 的索引標上「已退役」，內容沒動。
- **架構**：
  - 停用條目只在 `getEnv()` 這一個合併點加入，聊天與排程（串流和非串流）共用；
  - 鍵名是常數，並註明它對應舊部署的設定；
  - `retired-memory-backfill.ts` 是一個可以注入 env 與 warn 的小函式，讓 SCN-006 測得到，不算過度設計。
- **安全**：
  - 文件裡的檢查命令用 `readonly: true` 開 opencode.db，只有 SELECT，是唯讀的。
  - 它在 `telenexus` 容器內執行，而 opencode 的資料 volume 由兩個服務共用（`docker-compose.release.yml:31`），所以路徑正確。
  - 證據檔去敏（L-10）：在新增的行裡找家目錄路徑、`.env` 裡的 Telegram 使用者 ID、token 樣式、64 位元組的雜湊，都沒有命中。只有公開的 `ghcr.io/raybird/...` 與 GitHub repo 名稱。
- **品質（code-simplify 的標準）**：
  - `getEnv()` 的兩條回傳路徑共用 `withLegacyMemoryDisabled`，沒有重複；
  - `memory-health.ts` 刪減後只剩兩區，沒有留下沒人用的型別或函式（`orUnknown` 的型別也縮了）；
  - 新測試沿用既有的固定 port 慣例（`web-streaming.test.ts` 用 39231）；
  - 沒有發現跨步驟重複的邏輯或過度設計。小問題見 N1。
- **文件**：
  - project.md 常青文件表裡相關的列都更新了：`configuration-reference.md`、`.env.example`、`.env.production.example`、`web-console-reference.md`、`installation.md`、`runtime-boundary-and-security.md`、`ARCHITECTURE.md`、`CLAUDE.md` 的 Common Commands、`docs/README.md`；
  - `ai-config.example.yaml` 也在這張表的範圍內，它的殘留見 S1；
  - `README.md`、`CONTRIBUTING.md`、`docs/current-chat-prompt.md` 沒有相關字樣。

### 豁免、待確認與限制

- **Gate 豁免**（README，2026-10-27，Q6）：不開 PR，PASS 而且沒有要修的項目時以 `git merge --ff-only` 自動合併。本報告有一項 SHOULD FIX `需決策`（S1），所以「沒有要修的項目」這個條件不成立，合併前要先由使用者決定 S1。
- **TBD-1**（另一台部署有沒有在用這個 MCP）：狀態是「待確認」，依 Q5 不阻塞本次交付。檢查命令已經寫進文件。
- **審查限制**：
  - 依指示沒有建 Docker 映像，也沒有重跑 step1、step5 的探測。映像行為以證據判斷，並用 `docker create`＋`docker cp` 核對映像內容和 HEAD 一致（N2）；過程中沒有啟動容器。
  - 沒有碰正式部署，也沒有啟動或停止任何服務。

## 流程判定

PASS

沒有 MUST FIX；九個 Scenario 與已辨識的失敗面都有可信的證據。S1 是 SHOULD FIX `需決策`，不阻擋 PASS，但依 Gate 豁免的條件，合併前要由使用者決定 S1 的處理方式。
