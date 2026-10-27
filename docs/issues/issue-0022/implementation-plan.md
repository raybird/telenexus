# Issue 0022 實作計畫

驗收劇本、風險與首要驗證見 [README.md](README.md)。

## 設計方案

### 停用舊設定的 MCP（SCN-001～003）

`OpencodeAgent.getEnv()`（`src/core/opencode.ts`）已經會解析使用者的 `OPENCODE_CONFIG_CONTENT`，並注入 `telenexus_browser`。這裡再加一條規則：

```diff
 config = parse(OPENCODE_CONFIG_CONTENT || '{}')
 mcp = config.mcp ?? {}
+if mcp 沒有 'mcp-memory-libsql'
+  mcp['mcp-memory-libsql'] = { type: 'local', command: ['mcp-memory-libsql'], enabled: false }
 if mcp 有 'telenexus_browser'
-  return env                                       // 使用者自訂 browser 時原樣回傳
+  return env + 合併後的 OPENCODE_CONFIG_CONTENT   // 自訂 browser 仍保留，但同樣停用舊 MCP
 mcp.telenexus_browser = {...內建設定}
```

- > NOTE（2026-10-27，步驟 1）：原本只注入 `{ enabled: false }`。契約探測發現，沒有舊設定的部署每輪會多一行 `level=ERROR … "Ignoring MCP config entry without type"`，所以改成帶 `type` 與 `command` 的完整條目。和舊設定合併後一樣是停用的，條目停用所以 `command` 不會被執行。見 [evidence/step1-opencode-mcp-disable.md](evidence/step1-opencode-mcp-disable.md) 的 C、D、E 組。
- 使用者自訂 `telenexus_browser` 時，現在是原樣回傳 env，不帶 `TELENEXUS_BROWSER_AUDIT_FILE`。這個行為不變，只是 `OPENCODE_CONFIG_CONTENT` 會多帶停用條目。
- 使用者在 `OPENCODE_CONFIG_CONTENT` 自己設了 `mcp-memory-libsql`（任何內容）時，不覆寫它（SCN-003）。
- 停用條目的鍵名寫成一個常數，並註明它對應的是舊部署 `workspace/.opencode/opencode.json` 的鍵名。

### 移除回填（SCN-005、006）

- 刪除 `src/services/memory-backfill.ts`、`src/services/memory-backfill-worker.ts`、`src/tools/memory-backfill-cli.ts`，以及 `tests/memory-backfill.test.ts`、`tests/memory-backfill-worker.test.ts`。
- `src/main.ts`：拿掉 worker 的建立、啟動與 shutdown。啟動時 `MEMORY_BACKFILL_ENABLED` 解析為 true，就 `console.warn` 一行。判斷方式沿用原本的 `parseBool`，所以 `true`／`1` 等值的判定和 v2.32.0 相同。
- `src/web/server.ts`：拿掉 `/api/memory-backfill/report`，讓它落到既有的 404 處理。
- `src/utils/paths.ts`：拿掉只給回填與檢索資料庫用的 `resolveMemoryDbPath`、`resolveMemoryBackfillCheckpointPath`、`resolveMemoryBackfillReportPath`，並修正 `resolveMemoriaSessionsDbPath` 註解裡的「backfill/health」。
- `package.json`：拿掉 `memory:backfill:dry-run`、`memory:backfill:write`。

### 健康報告（SCN-007、008）

- `MemoryHealthReport` 拿掉 `retrieval`、`backfill`、`consistency`，`paths` 拿掉 `retrievalDb` 與 `checkpointFile`。
- 只服務這三個區塊的型別與函式一併刪除，包括 `BackfillCheckpoint`、`BackfillSourceState`、`assessBackfillSource`、`judgeBackfillSource`、`collectConsistencyReport`、`readRetrievalRows`、`readCheckpoint`。
- `currentArchiveSource()` 只剩 worker 用時一併刪除；仍有其他呼叫端則保留。
- `formatMemoryHealthMarkdown` 同步拿掉對應的行。operational 與 archive 的行維持原文和順序。
- Web Console：
  - `views/status.js` 拿掉回填欄位與 Recent Backfill Runs；
  - `services/status-service.js` 拿掉 `getBackfillReport`；
  - `main.js` 拿掉 backfill 警告。

### 映像與 repo 設定（SCN-004）

- `Dockerfile`：`npm install -g` 拿掉 `mcp-memory-libsql`。
- `workspace/.opencode/opencode.json`：拿掉 `mcp` 區塊，`$schema` 與 `model` 不動。

## 實作步驟

1. ✅ **契約探測：注入停用在 `opencode run` 的行為**（SCN-001、002；首要驗證）——證據：[evidence/step1-opencode-mcp-disable.md](evidence/step1-opencode-mcp-disable.md)。成立；注入內容改成完整條目（D、E 組）
   - 做法：
     - 用 `ghcr.io/raybird/telenexus:v2.32.0`，在暫存目錄建立 workspace。
     - MCP 指令換成假指令：被啟動時在 workspace 外寫標記檔，然後以 MCP stdio 格式回應或直接結束。
     - 模型用 [issue 0008 的假上游](../issue-0008/evidence/step1-mock-opencode.json)，讓 `run` 回固定文字。
     - 跑三組 `opencode run`，stdin 接 `/dev/null`（[L-12](../../agents/landmines.md#l-12-opencode-run-在-stdin-沒關時一直等待)）：
       - A：舊設定，不注入（對照組）；
       - B：舊設定，注入 `{"enabled":false}`；
       - C：沒有舊設定，注入 `{"enabled":false}`。
   - 完成判準：
     - A 有標記檔；
     - B、C 沒有標記檔；
     - 三組都從假上游拿到回覆，exit 0，stderr 沒有設定錯誤。
   - 不成立時停止，回報結果並重新決定 Q1。
   - 產出：`evidence/step1-opencode-mcp-disable.md`。
   - 相依：Scenario 全部核准。
2. ✅ **注入停用**（SCN-001～003）——證據：[evidence/step2-config-injection.md](evidence/step2-config-injection.md)
   - 做法：
     - 改 `getEnv()` 前，跑 `gitnexus_impact` 並用 `grep` 核對呼叫點。
     - 在 `tests/opencode-browser-config.test.ts` 加測試，先轉紅再實作。測試涵蓋四種情況：
       - 預設時有停用條目；
       - 使用者自訂 `mcp-memory-libsql` 時原樣保留；
       - 使用者自訂 `telenexus_browser` 時仍有停用條目，browser 設定不變；
       - 其他使用者 MCP 不受影響。
   - 完成判準：
     - 紅燈、綠燈紀錄；
     - 至少一個突變（拿掉注入，或改成覆寫使用者設定）會讓測試轉紅；
     - 既有的 browser 設定測試照常通過。
   - 產出：`evidence/step2-config-injection.md`。
   - 相依：步驟 1。
3. ✅ **移除回填與啟動警告**（SCN-005、006）——證據：[evidence/step3-backfill-removal.md](evidence/step3-backfill-removal.md)
   - 做法：
     - 刪檔前，用 `grep -rn` 與 `gitnexus_impact` 列出所有引用，包括 `src/`、`tests/`、`scripts/`、`package.json`。
     - 啟動警告抽成可測的小函式，在 `main.ts` 呼叫。先寫測試覆蓋 true、false、未設定三種情況，確認紅燈。
     - 以測試確認 `/api/memory-backfill/report` 回 404。
   - 完成判準：
     - 紅燈、綠燈紀錄；
     - `grep` 在 `src/`、`tests/`、`package.json` 找不到 `memory-backfill`、`MemoryBackfill`、`MEMORY_BACKFILL_`。啟動警告本身與 `scripts/backfill-summary-metadata.ts` 除外。
   - 產出：`evidence/step3-backfill-removal.md`。
   - 相依：Scenario 全部核准，與步驟 2 無相依。
4. 📝 **健康報告與 Web Console**（SCN-007、008）
   - 做法：
     - 先在 `tests/memory-health.test.ts` 與 `tests/context-snapshots.test.ts` 加測試並確認紅燈。測試涵蓋三點：
       - 報告沒有那三個區塊和那兩個路徑；
       - `memory.db` 存在時大小與 mtime 不變；
       - operational 與 archive 的既有斷言照常成立。
     - 只測三個區塊的既有測試，隨行為移除而刪除，並在證據裡逐一列出。依 verification.md，這屬於「核准的行為已變更」。
     - Web Console 沒有前端測試，改用靜態檢查：`grep` 前端已沒有 `backfill`；並在開發 stack 或編譯後實跑 `/api/status`，確認 `memory` 物件沒有 `backfill_*` 鍵。
   - 完成判準：
     - 紅燈、綠燈紀錄；
     - 刪除的測試附清單與理由；
     - 靜態檢查與 `/api/status` 實跑結果。
   - 產出：`evidence/step4-health-report.md`。
   - 相依：步驟 3（共用 `paths.ts` 與回填型別的移除）。
5. 📝 **映像與 repo 設定**（SCN-004）
   - 做法：
     - 改 `Dockerfile` 與 `workspace/.opencode/opencode.json`。
     - 以 `docker build`（production stage）建出本機映像，確認 `/usr/local/lib/node_modules/mcp-memory-libsql` 不存在。
     - 在新映像重跑步驟 1 的 B 組（舊設定加上步驟 2 實際組出的 `OPENCODE_CONFIG_CONTENT`）。另跑一組不注入的對照組，確認 opencode 會嘗試透過 npx 取得 MCP（有標記或 npx 的下載／錯誤訊息），而注入組沒有。
   - 完成判準：
     - 映像內查無套件；
     - 注入組不嘗試啟動 MCP，對照組會嘗試；
     - `tests/docker/compose-parity.test.ts` 照常通過。
   - 產出：`evidence/step5-image.md`。
   - 相依：步驟 2。
6. 📝 **文件與交付檢查**（SCN-009）
   - 做法：依 project.md 的常青文件表更新以下文件。
     - `docs/configuration-reference.md`：
       - 回填段落改成退役說明；
       - runtime issue scope 範例拿掉 `memory-backfill:worker`；
       - 寫明另一台部署升級前的唯讀檢查命令，也就是查 opencode.db 裡 `mcp-memory-libsql_*` 工具的呼叫次數；
       - 寫明想保留 MCP 時，`OPENCODE_CONFIG_CONTENT` 怎麼設定。
     - `.env.example`、`.env.production.example`：拿掉 `MEMORY_BACKFILL_*`，以及只為回填存在的封存掛載註解。
     - `docs/web-console-reference.md`：API 清單與 memory-status 說明。
     - `docs/installation.md`：升級說明，不需要手動步驟，`memory.db` 原地保留。
     - `docs/runtime-boundary-and-security.md`：`memory-status.md` 與 `memory.db` 的描述。
     - `ARCHITECTURE.md`、`CLAUDE.md`：Common Commands 與模組說明。
     - `docs/README.md`：操作索引裡的回填命令。
     - 歷史文件維持原樣。
   - 完成判準：
     - 逐項對照 SCN-009；
     - `grep` 常青文件已沒有 `MEMORY_BACKFILL_`、`memory:backfill:`（歷史文件除外，命中清單附在證據裡）；
     - `npm run build`、`npm run test`（核對 `# tests` 數與 `tests/` 檔數，[L-01](../../agents/landmines.md#l-01-測試指令少跑了檔案輸出仍是--fail-0)）、`npm run lint` 都 exit 0；
     - 證據檔已去敏（[L-10](../../agents/landmines.md#l-10-證據檔把本機資訊帶進公開-repo)）。
   - 產出：`evidence/step6-docs-and-checks.md`。
   - 相依：步驟 2～5。

## 使用方式對照

| 情境 | 變更前 | 變更後 |
|------|--------|--------|
| 升級舊部署 | — | 照常 `install.sh --upgrade`，不需要改 `workspace/` |
| 想保留 `mcp-memory-libsql` | 預設就有（舊部署） | 在 `.env` 的 `OPENCODE_CONFIG_CONTENT` 設定完整的 MCP 條目，並自行確保 `npx` 取得得到套件 |
| 看記憶健康 | `memory-status.md` 五個區塊 | 兩個區塊（運作資料庫、封存） |
| 執行回填 | `npm run memory:backfill:*` | 已移除 |

## 測試策略

| Scenario | 層級 | 做法 |
|----------|------|------|
| SCN-001、002 | 外部契約 + 單元 | 步驟 1 的契約探測（opencode 實際行為），加上步驟 2 對 `getEnv()` 輸出的單元測試；兩者各自負責不同的失敗面，所以保留雙迴圈 |
| SCN-003 | 單元 | `getEnv()` 的單元測試 |
| SCN-004 | 映像實測 | 步驟 5 建出的映像 |
| SCN-005 | 單元／整合 | 啟動警告函式的測試、Web server 404 的測試、`grep` 靜態檢查 |
| SCN-006 | 單元 | 啟動警告函式三種輸入 |
| SCN-007 | 整合 | `collectMemoryHealthReport`、`formatMemoryHealthMarkdown` 與 context snapshot 的測試，使用暫存 `DB_DIR` |
| SCN-008 | 靜態 + 實跑 | 前端沒有測試框架，以 `grep` 與 `/api/status` 實跑替代 |
| SCN-009 | 靜態 | 文件 diff 對照與 `grep` |

刪除的測試只限「只驗證被移除行為」的案例，每一個都列在對應步驟的證據裡。

## 檢查清單

- [ ] Scenario 全部核准並提交（核准 commit 回填）
- [ ] 步驟 1 契約探測成立
- [ ] 改 symbol 前跑 `gitnexus_impact` 並以 `grep` 核對；commit 前跑 `gitnexus_detect_changes`（在 worktree 時改用 `git diff --stat`）
- [ ] build、test、lint 都 exit 0，`# tests` 數與檔數相稱
- [ ] 證據檔去敏
- [ ] 本機獨立審查 PASS 後才合併；不發版、不推送
