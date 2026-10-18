# 審查報告

- 範圍：完整交付範圍（本機獨立審查，未開 PR），第二輪，接續 [review-3684612.md](review-3684612.md)。本輪重點是 `3684612..501d9ed` 的兩個提交：9df46ba 是報告提交，501d9ed 是修正。
- Reviewed BASE SHA：72f5dc1e275a08e8cda92abb3b182f54c758b5a5（main）
- Reviewed HEAD SHA：501d9ed38e26a04c53c30eeecf06faafd6d52080
- Reviewed patch-id：edecc137e0f5efb62d06170e5ad45c387ea72f28（以 `git diff 72f5dc1 501d9ed | git patch-id --stable` 重算，與協調者提供的值一致）
- 審查日期：2026-10-18
- 獨立 reviewer：Claude Code 獨立 subagent（general-purpose），非原實作者
- Review artifact：docs/issues/issue-0014/review-501d9ed.md

## 問題與風險

- MUST FIX：無
- SHOULD FIX：無
- NICE TO HAVE：無新增

## 上一輪發現的處理結論

| 編號 | 上一輪內容 | 501d9ed 的處理 | reviewer 驗證 | 結論 |
|---|---|---|---|---|
| M1 | 待重試期間，閒置檢查（`readSpaceStats`）失敗的分支沒有測試，突變能存活 | 新增測試 `tests/opencode-session-retention-run.test.ts:620`「待重試期間閒置檢查失敗時記錄 runtime issue、不截斷，狀態保留到下一輪」。斷言 `not-truncated`、待重試仍為 true、`calls` 為空、scope 為 `opencode-retention:wal-truncate`；下一輪恢復後是 `truncated`，而且只呼叫一次 `truncate` | 在 scratchpad 的 `git archive 501d9ed` 複本重放上一輪的 M1 突變（不記 issue、把待重試設為 false），結果 33/34，只有這個新測試失敗。另外加做一個變體：只拿掉記錄 issue、待重試維持 true，同樣只有這個新測試失敗。還原後 34/34 | 已解決 |
| M2 | 「重試期間不 VACUUM」只在 24 小時內驗證過 | 新增測試 `:650`：`lastReclaimAt = NOW - 25h`，待重試中、超過門檻、閒置，截斷回 busy。斷言 `reclaim === 'wal-truncate-pending'`、`vacuums === 0`、`calls` 為 `['truncate']`，待重試仍為 true | 重放上一輪的 M2 突變（超過一天且截斷沒成功時，回到回收流程），結果 33/34，只有這個新測試失敗；還原後 34/34。這個判準現在和失敗模式相交 | 已解決 |
| N1 | 兩個解析函式重複取 JSON 第一列；內部函式和 dep 同名 | `src/services/opencode-session-retention.ts:137-141` 新增 `firstJsonRow`，`parseWalCheckpoint` 與 `parseSpaceStats` 都改用它；內部函式改名為 `attemptWalTruncate`，兩個呼叫點都已更新 | 拋錯語意不變（`JSON.parse` 失敗照樣拋出，不是陣列或沒有列時回 undefined，再由欄位檢查拋出），解析測試全過。grep 確認文件中的 `truncateWal` 指的都是 dep，名稱仍正確 | 已解決 |
| N2 | TRUNCATE 等待讀取者時會擋住寫入 | `docs/configuration-reference.md:125` 補上「最多等 5 秒（`busy_timeout`），這段期間新的寫入也要等；重試前已確認閒置，所以很少碰上」 | 和步驟 1 的實測（有讀取者時 5,671 ms）以及 `retryWalTruncate` 的閒置檢查一致 | 已解決（列為已揭露的剩餘風險） |
| N3 | step1 證據的執行順序要讀者自己推 | `evidence/step1-wal-truncate-probe.md:7` 補上「執行順序」：量大小、跑 `opencode db`、再量一次，接著 `wal.cjs free 0.2`，最後 `wal.cjs run`，也說明 WAL 為何從 0 開始 | 補上後和兩節的數字對得起來（TBD-1 時 WAL 是 4.9 MB，`free` 後 WAL 被刪除，所以是 0）。TBD-1 用的 `node -e …` 原文沒有記下，但步驟是單純的量大小，不影響重現 | 已解決 |
| N4 | 提前結束的那一輪不會重試截斷 | `docs/configuration-reference.md:125` 補上「綁定狀態讀不到或查詢失敗而提前結束的那一輪不會重試」 | 和 `runRetentionOnce` 的提前 return 一致 | 已解決（寫進文件） |
| N5 | README 頁尾的風險敘述過時，Timeline 沒更新 | 頁尾改為「開始時未確認，2026-10-18 已由步驟 1 確認」；Timeline 加上第一輪審查退回的紀錄 | README 和內文一致 | 已解決 |

## 已查核維度

### 驗收與證據

- **9df46ba（報告提交）**
  - 父提交是 3684612，不是 merge。
  - `git diff --name-status 3684612 9df46ba` 只有 `A docs/issues/issue-0014/review-3684612.md`，模式 100644。
  - 內容和 reviewer 上一輪寫的檔案逐字相同（以 `diff` 確認）。
  - 結論：沒有改動其他檔案。
- **501d9ed**
  - 父提交是 9df46ba。
  - 改動的檔案：`src/services/opencode-session-retention.ts`、`tests/opencode-session-retention-run.test.ts`、`docs/configuration-reference.md`、`docs/issues/issue-0014/README.md`、`docs/issues/issue-0014/evidence/step1-wal-truncate-probe.md`。
  - 程式只做了 N1 的重構，沒有行為變更。
- **規格**
  - 在 501d9ed 上，「驗收條件」段落和核准版 33f9db9 相比，只差在 `核准 commit` 回填為 `33f9db9`，AC-1、AC-2 的內容和失敗路徑都沒有變。
- **AC-1**
  - 單元測試：`:469`、`:479`、`:491`、`:423` SCN-006、`:604`。
  - 外迴圈：`evidence/step3-e2e-copy.md`。
  - `git diff 3684612 501d9ed -- src` 只有 N1 的重構，step3 用 b1c79e8 編出的 dist 得到的綠燈仍代表本版的行為：截斷的邏輯和命令都沒變。
  - 結論：證據完整，維持上一輪的結論。
- **AC-2**
  - busy：`:506`。
  - busy → 拋錯 → 成功：`:526`。
  - 忙碌時不重試：`:572`。
  - 閒置檢查失敗：`:620`，對應 M1。
  - 超過一天仍不 VACUUM：`:650`，對應 M2。
  - 複本上的 busy 輸出：step1。
  - 結論：AC-2 明列的三條失敗路徑（當成完成、重跑 VACUUM、沒記 issue）都有能讓對應突變失敗的測試。證據完整。
- **紅綠重構證據**
  - README 步驟 2 補了這兩個測試的紅燈：在已存在的生產程式上暫時放進突變取得，33/34，各自只有對應的新測試失敗；還原後 34/34。N1 重構後同一組測試 34/34。
  - 因為生產程式不用改，以突變取得紅燈是可以證明「這個測試擋得住目標失敗」的合理方式，README 也有揭露。
  - reviewer 自己重跑，結果和 README 的紀錄一致。
  - 原本的四段證據仍有效。
  - 結論：完整。
- **假綠燈**
  - 新測試的期望值都是字面值，沒有同義反覆，沒有 mock 掉被測核心。
  - M2 的測試把 `lastReclaimAt` 設在 25 小時前，不再被 24 小時間隔遮住。

### 相關失敗面

上一輪表格裡的 F1～F18 在本輪重新確認，結論如下：

- F7（待重試期間閒置檢查失敗）：改判為通過，由 `:620` 涵蓋，突變會讓測試失敗。
- F8（待重試超過 24 小時又達門檻）：改判為通過，由 `:650` 涵蓋，突變會讓測試失敗。
- F14（提前結束的那一輪不重試）：已寫進文件，判為可接受。
- 其餘項目（busy／exit 0、拋錯／逾時、解析失敗、延後重試、停用、重啟、雙服務、log 摘要、去重、stdin）的程式行為沒變，維持上一輪的通過或可接受。
- 另外重放了「忽略 busy」的突變：501d9ed 上有 3 個測試失敗，busy 判定的守門仍然有效。

### 需求、架構、安全、品質

- **需求**：範圍沒有變，只在 VACUUM 後截斷，沒有處理既有的 WAL。
- **架構**：仍然一律經 opencode CLI，新錯誤都走 `recordRuntimeIssue`。
- **品質**：`firstJsonRow` 消除了重複；改名後內部函式和 dep 不再混淆。沒有新的過度設計。
- **常青文件**
  - `docs/configuration-reference.md` 新增的兩句和實作一致。
  - `ARCHITECTURE.md`、`CLAUDE.md`、`docs/agents/landmines.md`、`docs/agents/project.md`、`docs/README.md` 這輪沒有改動，上一輪已確認一致。
  - 本輪新增的連結都指向存在的檔案，包括 README 連到 `review-3684612.md` 的兩處。
- **證據去敏**：對 `9df46ba..501d9ed` 的新增行 grep 主機路徑、使用者名稱、部署目錄名、session ID、64 位 hex、9～10 位數字 ID 與 token，結果沒有命中。整個範圍的結論維持上一輪：只有容器內的 `/home/node`。
- **安全**：沒有新的輸入面。

### 豁免、待確認與限制

- **豁免**：不開 PR、改本機獨立審查，README「Gate 豁免紀錄」有記錄。
- **待確認事項**：TBD-1 已解決；TBD-2 依 Q1 不在本次範圍，由使用者在升級時決定。
- **reviewer 的限制**：沒有執行 docker，也沒有碰正式部署，step1 與 step3 的實測數字沒有重跑，只核對了內部一致性。突變測試都在 scratchpad 的 `git archive 501d9ed` 複本上進行，worktree 沒有修改。

## 流程判定

PASS
