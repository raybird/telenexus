# Issue 0016 第二部分 - 遠端 Memoria 模式正式標成不支援記憶回填 (Small)

GitHub：[#16](https://github.com/raybird/telenexus/issues/16)（第一部分見 [issue-0016](../issue-0016/README.md)）

## 文件清單
- [evidence/step1-messages.md](./evidence/step1-messages.md)
- [evidence/step2-cli-and-docs.md](./evidence/step2-cli-and-docs.md)
- [evidence/step3-review-followup.md](./evidence/step3-review-followup.md)
- [review-3dc3f44.md](./review-3dc3f44.md)
- [review-0640b95.md](./review-0640b95.md)

## 概述

GitHub #16 要求「明確選擇支援遠端回填（透過可分頁、可 checkpoint 的 API／匯出）或將目前模式標為 unsupported」。第一部分（issue-0016，已合併）只讓狀態如實呈現，這個選擇留成 TBD-1。2026-10-21 使用者選「正式標成不支援（建議）」。

已確認的現況：
- Memoria 的 HTTP API 只能依單一 ID 取 session 摘要（`GET /v1/sessions/:id/summary`），沒有可分頁、可 checkpoint 的 session 列出 API。部署釘的 1.28.1 和本機裝的最新版都一樣。要支援遠端回填，得先改 Memoria。
- 回填把候選寫進 `memory.db`。在 `src/` 裡，讀寫 `memory.db` 的只有回填本身（`memory-backfill.ts`、`memory-backfill-cli.ts`）和 `memory-health.ts`。聊天組 prompt 用的是 `moltbot.db` 與 Memoria 召回。
- 遠端模式的原因說明只有一個來源，是 `judgeBackfillSource()`（`src/services/memory-health.ts`），內容是「遠端 Memoria 模式：回填只讀本機的 sessions.db，目前不支援遠端封存」。同一句話會出現在三個地方：
  - worker 每輪的 `skipped. remote-unsupported: …`；
  - 健康報告的 `backfill.sourceDetail`；
  - `memory:backfill` 失敗退出時的錯誤訊息。

  「目前不支援」讀起來像暫時的狀態。
- worker 啟動訊息只有 `source=remote`，沒有說明遠端模式不支援。
- `.env.example` 的 `MEMORY_BACKFILL_*` 沒有提到遠端模式。`docs/configuration-reference.md` 已經寫了遠端讀不到封存，但沒有寫明這是正式的不支援、為什麼不支援、該怎麼設定。

**範圍**：
- 只改 TeleNexus 的訊息與文件。
- 判定邏輯不變：何時執行、哪些狀態記 runtime issue、dry-run 預設、CLI 的 exit code 都和第一部分相同。
- 不改 Memoria，也不建議把 Memoria 可寫的 `sessions.db` 共享給另一個容器，這是 #16 本身的要求。

## 涉及檔案

- `src/services/memory-health.ts`：遠端模式的原因說明
- `src/services/memory-backfill-worker.ts`：遠端模式且回填開啟時的啟動警告
- `tests/memory-backfill-worker.test.ts`、`tests/memory-health.test.ts`、`tests/memory-backfill.test.ts`：AC-1、AC-2 的測試
- `docs/configuration-reference.md`、`.env.example`：AC-3

## 驗收條件

核准來源：
- 方向：使用者 2026-10-21 回答 #16 第二部分時，選「正式標成不支援（建議）」。
- Q1：選「維持每輪都印（建議）」（2026-10-21）。
- 交付方式（Q2）：選「分支＋本機審查，PASS 後自動合併（建議）」（2026-10-21）。

1. **AC-1：遠端模式的原因說明是正式的不支援，並寫出處理方式**
   - 說明要寫出三件事：
     - 遠端 Memoria 模式不支援回填；
     - 原因是回填只讀本機的 `sessions.db`；
     - 不要回填就把 `MEMORY_BACKFILL_ENABLED` 設為 `false`。
   - 不再出現「目前」這類暫時的說法。
   - 同一句話出現在 worker 每輪的 `skipped. remote-unsupported: …`、健康報告的 `backfill.sourceDetail`（JSON 與 markdown），以及 `memory:backfill` 失敗退出的訊息。
   - 其他行為不變：
     - worker 每輪都印（Q1）；
     - `memory:backfill` 仍然 exit 非 0；
     - 不記 runtime issue；
     - 其他狀態的訊息也不變。
   - 檢查方式：
     - 單元測試確認遠端模式下的 `detail` 符合以上三點，而且不含「目前」；
     - 編譯後以 `node dist/tools/memory-backfill-cli.js once --json` 與 `node dist/tools/memory-health-cli.js` 在遠端模式實跑，確認訊息與 exit code。
2. **AC-2：遠端模式且回填開啟時，啟動時警告一次**
   - `MEMORY_BACKFILL_ENABLED=true` 而封存來源是 `remote` 時，worker 啟動用 `console.warn` 印一行。這行說明遠端模式不支援回填，worker 每輪只會印 skipped，並建議把 `MEMORY_BACKFILL_ENABLED` 設為 `false`。
   - 原本的 `Starting. …` 訊息照印，排程照常建立（Q1）。
   - 封存來源是 `local`，或者回填沒開時，啟動的輸出和現在相同。
   - 檢查方式：單元測試分別啟動遠端開啟、本機開啟、沒開三種 worker，確認 warn 的有無與內容，以及排程照常建立；確認後關掉 worker。
3. **AC-3：文件寫明正式不支援**
   - `docs/configuration-reference.md` 的回填段落寫明以下幾點：
     - 遠端 Memoria 模式（官方 Compose）正式不支援回填，不是暫時的限制；
     - 原因是 Memoria 沒有可分頁、可 checkpoint 的 session 列出 API；
     - 不建議為了回填，把 Memoria 可寫的 `sessions.db` 共享給 telenexus 容器；
     - 遠端部署應保持 `MEMORY_BACKFILL_ENABLED=false`；
     - 回填只適用於 `MEMORIA_ARCHIVE_DB` 或 `MEMORIA_HOME` 指向本機 `sessions.db` 的部署。
   - `.env.example` 的回填區塊加一行註解，說明遠端 Memoria 模式不支援回填。
   - 檢查方式：閱讀 diff，確認以上各點都寫到；`grep` 確認文件裡沒有留下「目前不支援遠端」這類暫時的說法。

## 風險與首要驗證

**風險**: Low
- 改動是一句原因說明、一行啟動警告和文件，判定邏輯不動。
- 這句說明同時是 `memory:backfill` 的錯誤訊息。第一部分的測試只比對前綴，所以首要驗證是三個出現的地方都換成新句子，其他狀態的訊息不受影響。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|---|---|---|---|
| N-1 | 回填寫入的 `memory.db` 目前沒有任何聊天路徑讀取，只有回填本身和健康報告會讀寫（以 `grep` 查 `src/` 確認）。本機模式的回填要不要保留、要不要接回聊天，不在本 issue 範圍內 | 揭露，不阻塞 | 可另開 issue；是否開立由使用者決定 |
| N-2 | GitHub #16 要不要在合併後關閉 | 合併後由使用者決定 | 不影響驗收 |

## 實作與驗證步驟

1. ✅ **步驟 1：原因說明與啟動警告**（AC-1、AC-2）——證據：[evidence/step1-messages.md](evidence/step1-messages.md)
   - 改動前先跑 `gitnexus_impact`，並用 `grep` 核對 `judgeBackfillSource` 與 `MemoryBackfillWorker.start` 的呼叫點。
   - 測試先轉紅，改完再轉綠。
   - 完成判準：
     - 兩個目標測試檔與全套 `npm test` 通過，並核對 `# tests N`；
     - build 與 lint 都 exit 0；
     - 至少一個突變能讓新測試轉紅。分別試兩種：還原原因說明、拿掉警告。
   - 產出：`evidence/step1-messages.md`。
2. ✅ **步驟 2：編譯後實跑與文件**（AC-1、AC-3；相依步驟 1）——證據：[evidence/step2-cli-and-docs.md](evidence/step2-cli-and-docs.md)
   - 在暫存 `DB_DIR`、沒設封存變數（也就是遠端模式）的環境下，實跑編譯後的兩個 CLI，記錄輸出與 exit code。
   - 更新 `docs/configuration-reference.md` 與 `.env.example`。
   - 完成判準：
     - CLI 的輸出符合 AC-1；
     - 文件逐項符合 AC-3；
     - `grep` 找不到暫時的說法。
   - 產出：`evidence/step2-cli-and-docs.md`。

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-21 | 不開 PR，改由獨立 subagent 在本機審查 `main..HEAD`；審查 PASS 而且沒有要修的項目時，以 `git merge --ff-only` 自動合併 | 交付方式選「分支＋本機審查，PASS 後自動合併（建議）」 | GitHub 上沒有 PR 紀錄，審查報告保存在本 issue 目錄；合併前使用者不會再看一次 |

## Timeline

| 日期 | 事件 | 負責 |
|------|------|------|
| 2026-10-21 | 建立。使用者選擇正式標成不支援、Q1「維持每輪都印」、Q2 交付方式 | - |
| 2026-10-21 | 步驟 1、2：原因說明、啟動警告與文件；4 個新測試、5 個突變都轉紅，全套 598 個通過，編譯後的 CLI 在遠端模式實跑 | - |
| 2026-10-21 | 本機獨立審查 review-3dc3f44：PASS，SHOULD FIX 1 項（遠端 AC-2 測試太弱）。 | reviewer |
| 2026-10-21 | 依審查補強遠端 AC-2 測試，見 [evidence/step3-review-followup.md](evidence/step3-review-followup.md) | - |
| 2026-10-21 | 本機獨立複審 review-0640b95：PASS，沒有 MUST FIX 或 SHOULD FIX | reviewer |
| 2026-10-21 | 依使用者事先的指示（審查 PASS 而且沒有要修的項目時自動合併）以 `git merge --ff-only` 合併進 `main`（`6eefdc2`） | 使用者 |

---
**建立日期**: 2026-10-21  
**分級**: Small  
**風險**: Low\
**狀態**: 已完成
