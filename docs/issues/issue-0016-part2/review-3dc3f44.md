# 審查報告

- 範圍：`main..fix/issue-0016-backfill-remote-unsupported`（本機審查，不開 PR；依 README「Gate 豁免紀錄」2026-10-21）
- Reviewed BASE SHA：`af5d57b89483cc7b4ddb2892c7a5f89558065b7b`（`git rev-parse main`）
- Reviewed HEAD SHA：`3dc3f448784bb12342c722e1b2f4e4d254404c8a`
- Reviewed patch-id：`0d44a910d0c487eff01ec96d87ea9e9b06299bb8`（reviewer 以 `git diff -a af5d57b 3dc3f44 | git patch-id --stable` 自行重算，與協調者提供的值相同）
- 獨立 reviewer：獨立 subagent（Claude Opus 5.5），沒有參與實作
- Review artifact：`docs/issues/issue-0016-part2/review-3dc3f44.md`（未提交）
- 審查日期：2026-10-21
- 變更範圍：2 個 commit（`43cc02a` 程式與測試、`3dc3f44` 證據），10 個檔案，+211／−5。程式只動兩處：`judgeBackfillSource()` 遠端分支的 `detail` 字串，以及 `MemoryBackfillWorker.start()` 在 `source === 'remote'` 時多一行 `console.warn`。判定邏輯、狀態集合、報告形狀都沒動。

## 問題與風險

### MUST FIX

無

### SHOULD FIX

1. **`tests/memory-backfill-worker.test.ts:376-403`：AC-2 測試分不出「啟動警告一次」和「每輪都警告」，也沒檢查警告內容的第二個要素**
   - 問題：
     - 測試的 50 ms 內 `intervalMs` 是 60 000，只會跑 startup 那一輪，所以 `warns.length === 1` 對「每輪都 warn」也成立。reviewer 的突變 M6 把警告從 `start()` 移到 `runOnce()` 的 `remote-unsupported` 分支（每輪 warn 一次），3 個目標測試檔 48/48 仍全過。
     - AC-2 要求這行說明三件事：遠端不支援、worker 每輪只會印 skipped、建議設為 `false`。測試（`:390-391`）只比對第一和第三件。突變 M9 拿掉「worker 每輪只會印 skipped」，48/48 仍全過。
   - 影響：目前的實作是對的。reviewer 用編譯後的 worker 跑 4 輪，warn 只有 1 次，內容三點都有。但 AC-2 的核心性質「一次」，以及 AC 要求的內容，沒有回歸測試保護。之後如果有人把每輪的 skipped 改成 warn、又刪掉啟動警告，或者改寫警告文字，測試都擋不住。
   - 建議修法：在遠端那個測試裡，`captureStart` 之前（或在 `finally` 的 `shutdown` 之前）再呼叫一次 `await worker.runOnce('interval')`，然後斷言：
     - `warns.length` 仍是 1；
     - `logs` 裡有 `startup skipped. remote-unsupported: ` 和 `interval skipped. remote-unsupported: ` 各一行。

     再補 `assert.match(warns[0] ?? '', /每輪只會印 skipped/)`。修完後重跑 M6、M9，確認兩個突變都轉紅。

### NICE TO HAVE

1. **`docs/web-console-reference.md:68`**：`remote-unsupported` 的說明是「遠端模式，回填只讀本機 `sessions.db`」。這句沒有暫時的說法，不違反 AC-3，但沒有寫出「正式不支援」。可以補半句，或連到 `configuration-reference.md` 的回填段落，讓看 API 文件的人也知道這是定案。
2. **`CHANGELOG.md:30`**：2.31.0 段落寫「遠端模式要不要支援回填，仍在 GitHub #16 討論」。這是已發版本的歷史紀錄，本分支不必改。下一版的 release notes 要寫明「已定案為正式不支援」，以免讀者只看到這句。
3. **`src/services/memory-backfill.ts:238`（既有問題，不在本次範圍內）**：regex 字元類別裡有一個字面 NUL 位元組（`[^\x00-\x7f…]` 的 `\x00` 是實際的 0x00）。`grep` 因此把整個檔案當二進位：本環境的 `grep` 帶 `-I`，會直接跳過這個檔案、不出任何訊息。`evidence/step2-cli-and-docs.md` 的 `grep -rn "目前不支援\|不支援遠端封存" … src` 也因此實際上沒有掃到這個檔案。reviewer 用 Python 另外確認過，這個檔案不含這兩段文字，所以結論不受影響。建議另開小修，改成跳脫寫法 `\x00`，或在 `docs/agents/landmines.md` 記一筆。

### 需決策

無

## 驗收對照

| AC | 判定 | 證據 |
|---|---|---|
| AC-1：遠端模式的原因說明是正式的不支援，三個地方同一句，其他行為不變 | 符合 | **內容**：`src/services/memory-health.ts:382-388` 的新 `detail` 寫了「遠端 Memoria 模式不支援回填」、「回填只讀本機的 sessions.db（MEMORIA_ARCHIVE_DB 或 MEMORIA_HOME 指向的檔案）」、「請把 MEMORY_BACKFILL_ENABLED 設為 false」，沒有「目前」。<br>**三個地方**：<br>- worker 每輪：`runOnce` 直接印 `assessArchiveSource().detail`。reviewer 用 dist 實跑，startup／interval 每輪都印這句。<br>- 健康報告：`memory-health.ts:607` 的 `sourceDetail`、`:661` 的 markdown。dist CLI 的 markdown 與 `--json` 都是同一句。<br>- `memory:backfill`：`memory-backfill.ts:866` 沿用 `assessBackfillSource().detail`。dist 實跑 exit 1，訊息是同一句，暫存目錄沒有寫出 checkpoint。<br>**其他行為不變**：<br>- diff 只改遠端分支的字串。`unavailable`、`error`、`empty`、`up-to-date`、`pending` 的訊息原樣；突變 M12 改 `unavailable` 的訊息，第一部分的測試會轉紅。<br>- 遠端狀態不走 `error` 分支，不記 runtime issue。<br>- `--json` 的 `backfill` 鍵集合不變。<br>- 舊句子只有第一部分的證據檔還在用（`docs/issues/issue-0016/evidence/`），那是歷史紀錄；`tests/` 裡沒有比對舊全文的斷言。 |
| AC-2：遠端模式且回填開啟時啟動 warn 一次，排程照常；本機或沒開時輸出不變 | 符合（測試強度見 SHOULD FIX 1） | `memory-backfill-worker.ts:169-178`：`enabled` 檢查之後才判斷 `source === 'remote'`，`Starting.` 照印，計時器照建。reviewer 用 dist 跑 `intervalMs=30`、120 ms：<br>- 遠端開啟：`Starting … source=remote`、1 行 WARN、之後 4 輪 skipped；<br>- 遠端沒開：只有 `Disabled by MEMORY_BACKFILL_ENABLED.`；<br>- 本機開啟：沒有 WARN，每輪印 `unavailable`。<br>`start()` 只有 `src/main.ts:438` 呼叫一次。evidence 的 M2～M5 與 reviewer 的 M7（沒開也 warn）、M11（遠端時不印 Starting）都會轉紅；M6、M9 不會，見上。 |
| AC-3：文件寫明正式不支援 | 符合 | `docs/configuration-reference.md:220-227` 逐項寫到：<br>- 只適用於指向本機 `sessions.db` 的部署；<br>- 正式不支援、不是暫時的限制；<br>- 原因是沒有可分頁、可 checkpoint 的 session 列出 API；<br>- 不建議共享可寫的 `sessions.db`；<br>- 遠端部署保持 `false`；<br>- 另外寫了 warn、CLI 與健康報告的表現。<br>`.env.example:135` 加了一行註解。reviewer 用 `command grep -rnaI "目前不支援\|不支援遠端封存\|仍在.*#16"` 掃整個 repo（排除 node_modules、dist、.git）：只有 issue-0016 系列的歷史文件和 `CHANGELOG.md:30` 的已發版段落（見 NICE TO HAVE 2）。這次修改沒有讓 `configuration-reference.md` 的 Prettier 差異變多（main 與 HEAD 都是同樣 16 行既有差異）。 |

失敗面：

| 失敗面 | 結論 |
|---|---|
| 舊測試比對舊全文 | 沒有這種斷言，全套 598/598 通過 |
| CLI exit 行為 | 仍然是 throw，exit 1，沒寫 checkpoint |
| 報告形狀 | 不變 |
| 警告誤觸發 | 沒開或本機都不印；本機的判定沿用 `currentArchiveSource()`，和 `Starting.` 的 `source=` 是同一個值 |
| 測試的時序 | 見下方「驗證重跑」第 6 項 |
| 全域狀態外洩 | console 在 `finally` 還原，env 由 `withSourceEnv`、`withArchiveEnv`、`withoutArchiveEnv` 還原，worker 在 `finally` 呼叫 `shutdown()` 而且計時器都 `unref`，沒有外洩 |

## 驗證重跑

全部在隔離的 worktree `/home/kevin/Documents/RCodes/moltbot-lite-review-0016p2`（detached 在 `3dc3f44`，node_modules 用 symlink）執行，`TMPDIR=$HOME/.cache/memoria-release-tmp`，測試加 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB`。

1. `git diff -a main HEAD | git patch-id --stable`：`0d44a910d0c487eff01ec96d87ea9e9b06299bb8`，相符。
2. 3 個目標測試檔：`npx tsx --test tests/memory-health.test.ts tests/memory-backfill.test.ts tests/memory-backfill-worker.test.ts`，exit 0，`# tests 48`、`# pass 48`、`# fail 0`。
3. **紅燈重現**：把兩個 `src` 檔換回 main 版本，跑同一組測試：`# tests 48`、`# pass 45`、`# fail 3`。失敗的是新增的遠端 AC-2、backfill AC-1、health AC-1 三個，和 evidence 一致。之後還原，`git status --short` 為空。
4. `npm test`：exit 0，`# tests 598`、`# pass 598`、`# fail 0`，和 evidence 一致。
5. `npm run build`、`npm run lint`：都是 exit 0。`npx prettier --check` 檢查變更的 5 個 ts 檔：全部通過。
6. 時序穩定性：`tests/memory-backfill-worker.test.ts` 以 8 個並行、共 32 次執行（12 核），32/32 通過（每次 `# tests 20`）。
   - 原因：startup 計時器是 0 ms，而且在 50 ms 等待計時器之前註冊。遠端分支在 `runOnce` 第一個 `await` 之前就同步印出 log，Node 的計時器依到期時間觸發，所以沒有競態。
7. 編譯後的 CLI，遠端模式，暫存 `DB_DIR` 與 `MEMORY_BACKFILL_CHECKPOINT_FILE`：

   | 命令 | exit | 結果 |
   |---|---|---|
   | `node dist/tools/memory-backfill-cli.js once --json` | 1 | `Error: memory backfill: 遠端 Memoria 模式不支援回填：…請把 MEMORY_BACKFILL_ENABLED 設為 false` |
   | `… once --json --write --save-checkpoint` | 1 | 暫存目錄沒有 checkpoint |
   | `node dist/tools/memory-health-cli.js` | 0 | `Backfill Source State: remote-unsupported`，Detail 是同一句 |
   | `node dist/tools/memory-health-cli.js --json` | 0 | `sourceState` 與 `sourceDetail` 相同；`backfill` 的鍵為 `checkpoint, checkpointExists, dryRun, enabled, lastCandidates, lastDuplicates, lastRunAt, lastRunStatus, lastScannedSessions, lastSuccessAt, lastWritten, sourceDetail, sourceState` |

8. 編譯後的 worker（`dist/services/memory-backfill-worker.js`，`startupDelayMs=0`、`intervalMs=30`、120 ms）：結果見「驗收對照」AC-2。
9. 額外突變：每次只取代一處，跑 3 個目標測試檔，之後以 `git checkout -- src` 還原，每次確認 `git status --short` 為空。

   | 突變 | 結果 |
   |---|---|
   | M6：警告從 `start()` 移到每輪（`runOnce` 的 remote-unsupported） | **存活**（48/48） |
   | M7：警告移到 `enabled` 檢查之前（沒開也 warn） | 轉紅：本機／沒開 AC-2 |
   | M8：`memory:backfill` 改用寫死的舊句子 | 轉紅：第一部分 AC-4、第二部分 AC-1 |
   | M9：警告拿掉「worker 每輪只會印 skipped」 | **存活**（48/48） |
   | M10：worker 每輪的遠端訊息不帶 detail | 轉紅：第一部分 AC-2 |
   | M11：遠端時不印 `Starting.` | 轉紅：第一部分 AC-2、第二部分遠端 AC-2 |
   | M12：本機 `unavailable` 的訊息被改 | 轉紅：第一部分 AC-4、AC-1 |

10. 結束時移除審查用的 worktree；主工作目錄只多出本報告。

## 判定

PASS

沒有 MUST FIX，三個 AC 都有實作與實跑證據。但有一項 SHOULD FIX（AC-2 測試分不出「一次」和「每輪」，也沒檢查警告內容的第二點），依協調者的規則不符合自動合併的條件，建議補完測試、重跑 M6、M9 確認轉紅後再合併。
