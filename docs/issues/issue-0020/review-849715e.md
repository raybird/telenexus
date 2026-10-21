# 審查報告
- 範圍：完整交付範圍 6b6eb1d..849715e（含歷史重整後的審查後續）
  - 共 6 個提交：`7fe83b3`、`7819017`、`7d3b69c`、`caccb14`、`2a6c8c6`、`849715e`。
  - 重點是歷史重整的等價性，以及審查後續 `caccb14..849715e`。
  - `6b6eb1d..7d3b69c` 與前一輪審查的 `6b6eb1d..ed4c001` 內容相同（見下方核實），前一輪的查核結論沿用 [review-ed4c001.md](review-ed4c001.md)。
- Reviewed BASE SHA：6b6eb1d3af9e2553fd815a5ce543c029e37a00b4（main）
- Reviewed HEAD SHA：849715e748e1e1828400feeb39d5b5697f486ee1
- Reviewed patch-id：
  - 完整範圍 `6b6eb1d..849715e`：de0bdf8fe9377b99c15c8b0ef804c28e2b79de0d
  - 後續範圍 `caccb14..849715e`：bd365821078f5dc9cd5bb3775378cc4c2825b7c0
  - 兩個都由 reviewer 以 `git diff -a <base> <head> | git patch-id --stable` 重算，與協調者提供的值一致。
- 審查日期：2026-10-21
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，不是本 issue 的實作者；與 review-ed4c001 是同一位 reviewer
- Review artifact：docs/issues/issue-0020/review-849715e.md

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

1. **step4 證據把突變 M11 的影響寫多了一個測試**：`docs/issues/issue-0020/evidence/step4-review-followup.md:46`
   - 證據寫 M11（`ORDER BY version DESC`）會讓「降版」與「scope 不是 prefix:id 格式」兩個測試轉紅，括號註明後者「同時檢查寫入順序」。
   - 我在 `849715e` 重做 M11：`# tests 19 / # fail 1`，只有「降版時依最後一筆的時間挑前一版」轉紅。
   - scope 測試讀的是 `readRows()` 的 `ORDER BY id`，不經過 `summarizeMemoriaRecallByVersion()`，所以不可能受這個突變影響。
   - 推測原因：做 M11 時，scope 測試本身還有證據第 52 行提到的 `recallOnce()` 預設值錯誤，它的失敗被誤記到 M11 名下。
   - 影響：M11 對 SHOULD FIX 1 的證明仍然成立，我已重現。只是證據把覆蓋面寫得比實際大。
   - 同類的小問題：`docs/issues/issue-0020/README.md:121` 寫「另外 2 個守的是既有行為，以突變證明有效」，但 step4 的突變表只記錄了降版測試（M11）的突變。`readAppVersion` 的測試沒有記錄任何突變。
     - 我自己把讀取路徑改成 `nope.json`，那個測試會轉紅，所以它是有效的。問題只在敘述沒有對應的紀錄。
   - 建議：
     - M11 那一列只留降版測試；
     - README 第 121 行改成「降版測試以突變 M11 證明；readAppVersion 的測試比對 package.json」，或者在 step4 補上該測試的突變紀錄。
   - 這兩處都是純文件修正，不影響任何驗收的判定。

### NICE TO HAVE

1. **trace hook 的 warn 沒有測試**：`src/services/memoria-recall-telemetry.ts:60`
   - 我把 warn 拿掉（`void err`），測試仍然 19/19 通過。step4 也沒有宣稱這一項有測試。
   - 行為很單純，不補也可以。
2. **以 `:` 開頭的 scope 會記成空字串**：`src/core/memoria-recall.ts:135`
   - 例如 `:abc` 會得到 `scope_kind=''`。沒有洩漏 ID，也沒有現行的呼叫者會傳這種值，只是值不好讀。
   - 需要的話可以和沒有冒號一樣歸成 `other`。

## 已查核維度

### 歷史重整（D-1，對應前次的 SHOULD FIX 2）

| 核實項目 | 結果 |
|---|---|
| `git diff ed4c001 7d3b69c` | 0 行：重建後的實作與文件和前次審查的 HEAD 完全相同 |
| `git diff 95ac16a caccb14` | 0 行。`backup/issue-0020-ed4c001` 指向 `95ac16a`，就是 ed4c001 加上報告 |
| `git diff ed4c001 7819017 -- src tests` | 0 行：前兩個提交合起來，就是原本的程式與測試 |
| 每個提交的 parent | 一條直線，`7fe83b3` 的 parent 是 `6b6eb1d`，沒有 merge 提交 |
| `7fe83b3` 單獨檢出 | `tsc --noEmit` exit 0；全套測試 `# tests 567 / # pass 567`；測試檔只 import 步驟 1 已有的模組，共 9 個測試 |
| `7819017` 單獨檢出 | `tsc --noEmit` exit 0；全套測試 `# tests 574 / # pass 574` |

結論：前次的 SHOULD FIX 2 已解決。每個實作提交單獨檢出時，build 與測試都通過，`git bisect` 不會被干擾。內容和前次審查完全相同，前次對 AC-1～AC-4 的查核結論繼續有效。

### 前次發現的處理情況

| 前次發現 | 處理 | reviewer 核實 | 判定 |
|---|---|---|---|
| SHOULD FIX 1：SQL 依時間排序沒有被釘住 | 新增降版測試：依序寫入 2.29.0、2.31.0、2.30.1。斷言彙總順序是 `['2.30.1','2.31.0','2.29.0']`，目前版本是 2.29.0 時前一版是 2.30.1 | 測試資料讓時間順序和版本號大小相反，期望值是人工推導的字面值。`ORDER BY version DESC` 會得到 2.31.0 在前，我重做 M11 確認轉紅 | 已解決 |
| SHOULD FIX 2：第一個提交測試載入失敗 | 依 D-1 重整歷史 | 見上節 | 已解決 |
| SHOULD FIX 3：常青文件沒有登記新模組 | `ARCHITECTURE.md:111-113`、`CLAUDE.md:100` | 兩處都在 `issue-store` 旁邊登記，內容與實作相符：30 天保留、啟動時與每 6 小時清理、不存問句、內容與使用者 ID | 已解決 |
| NICE 1：沒有冒號的 scope | 記成 `other`；沒帶 scope 時記 `none` | 把舊版 `memoria-recall.ts`（`7819017`）放回後，新測試轉紅；突變 M12（寫入整串）也轉紅 | 已處理 |
| NICE 2：hook 的 catch 靜默 | 印 `[memoria-recall] trace hook failed:` | 仍在 catch 裡面，不影響聊天；這個 warn 沒有測試（NICE TO HAVE 1） | 已處理 |
| NICE 3：6 小時清理沒有測試 | 不處理，理由寫在 step4 | 理由合理：與 `issue-store` 相同，而且 AC-1 的檢查方式沒有要求 | 接受 |
| NICE 4：「30 天」寫在兩處 | 匯出 `RECALL_METRICS_RETENTION_DAYS` | 說明行、log 與 `RETENTION_MS` 都改用這個常數 | 已處理 |
| NICE 5：README 寫「每日清理」 | 改成「啟動時與每 6 小時清理」 | 與 AC-1 一致 | 已處理 |
| NICE 6：Recalls 計的是召回次數 | 在 `docs/web-console-reference.md` 補上說明 | 與 `message-pipeline.ts` 改開新 session 時的重組行為相符 | 已處理 |
| NICE 7：readAppVersion 沒有直接測試 | 新增測試，比對 `package.json` 的 version | 把讀取路徑改成 `nope.json` 會轉紅。期望值直接讀檔案，與實作走同樣的路徑解析，但能和錯誤的實作不一致，不算同義反覆。正式映像的 cwd 是 `/app`，這一點在前次審查已確認 | 已處理 |

### 相關失敗面（這次新增的部分）

| 失敗面 | 輸入／狀態 | 預期行為 | 現有覆蓋 | 判定 |
|---|---|---|---|---|
| scope 不是 `prefix:id` | `secret-user-42` | `scope_kind='other'`，資料表裡沒有 ID | 新測試；突變 M12；舊程式上是紅燈 | 通過 |
| 沒帶 scope | `recallWithMeta(QUERY)` | `scope_kind='none'` | 新測試直接呼叫 client，避開 `recallOnce()` 的預設值 | 通過 |
| 降版或同一版本重新出現 | 2.29 → 2.31 → 2.30.1 | 依最後一筆的時間排序，前一版取最近的其他版本 | 新測試；突變 M11 | 通過 |
| 新的 import 造成循環依賴或副作用 | `memoria-status.ts` → `recall-metrics-store.ts` → `memoria-recall-telemetry.ts` | 沒有循環；載入時沒有副作用 | `memoria-recall-telemetry.ts` 沒有任何 import。`recall-metrics-store.ts` 頂層只有常數與函式宣告，計時器和 hook 要呼叫 `startRecallMetricsStore()` 才會建立。`madge --circular` 檢查 dist 的 16 個檔案：沒有循環。單獨 `import()` 編譯後的 `memoria-status.js` 不會啟動任何東西 | 通過 |
| hook 出錯 | hook throw | 印 warn，不影響聊天 | 程式可以直接看出這個行為；沒有測試 | 可接受（NICE TO HAVE 1） |

### 需求、架構、安全、品質

- **需求**：沒有改動 AC，也沒有新增未核准的行為。scope 記成 `other` 是 AC-1「不存使用者 ID」更嚴格的落實，不是新的可觀察行為。
- **架構**：formatter 為了一個常數去 import store 模組，兩者有了耦合，但沒有循環、沒有副作用，可以接受。另一個做法是把常數放在 `memory.ts` 或獨立的常數檔，但這不構成問題。
- **安全與隱私**：scope 不論格式都不會把 ID 寫進資料庫。
- **重複與過度設計**：沒有新的重複。新增的 3 個測試都對應前次的發現，沒有多做。
- **GitNexus**：後續範圍只改 `recallWithMeta`、`recordMemoriaRecallTrace`、`formatRecallMetricsByVersionMarkdown` 與 store 的常數。`git diff --stat caccb14 849715e -- src` 共 4 個檔案，與證據一致。前次已說明這個 repo 的索引已經過時，這次沒有再跑 `detect_changes`。
- **證據去識別化**：在 `caccb14..849715e` 的 diff 裡搜尋 `/home/`、OS 帳號名、`/tmp/claude`、8 位數以上的數字、bot token 樣式，都沒有命中。

### 豁免、待確認與限制

- **Gate 豁免**：不開 PR、改由本機獨立審查，沿用 README「Gate 豁免紀錄」2026-10-21 的紀錄。
- **待確認事項**：D-1 已解決（2026-10-21，使用者選擇重整分支歷史），README 有記錄結論與備份分支。
- **Timeline**：README 記有使用者的指示：「審查 PASS 而且沒有要修的項目時自動合併，有的話先修、複審再回報」。本報告有 1 項 SHOULD FIX，是否先修再合併，依這條指示處理。
- **環境**：
  - 所有測試都用 `TMPDIR=$HOME/.cache/memoria-release-tmp`，沒有遇到配額錯誤。
  - worktree 開在 `$HOME/.cache` 下的暫存目錄，`node_modules` 以 symlink 指向主 checkout。用完已經 `git worktree remove` 與 `prune`，並刪掉暫存目錄。
  - 沒有使用 `git stash`；沒有碰正式部署或它的 volume；沒有網路寫入。

## 你自己跑過的命令與結果

以下測試都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行，`TMPDIR=$HOME/.cache/memoria-release-tmp`。

| 命令 | 結果 |
|---|---|
| `git diff -a 6b6eb1d 849715e \| git patch-id --stable` | `de0bdf8f…`，一致 |
| `git diff -a caccb14 849715e \| git patch-id --stable` | `bd365821…`，一致 |
| `git diff ed4c001 7d3b69c \| wc -l`、`git diff 95ac16a caccb14 \| wc -l` | 都是 0 |
| `git rev-parse backup/issue-0020-ed4c001` | `95ac16a1…` |
| worktree 檢出 `7fe83b3`：`npx tsc -p . --noEmit`、`npm run test` | tsc exit 0；`# tests 567 / # pass 567 / # fail 0` |
| worktree 檢出 `7819017`：同上 | tsc exit 0；`# tests 574 / # pass 574 / # fail 0` |
| worktree 檢出 `849715e`：`npx tsx --test tests/recall-metrics.test.ts` | `# tests 19 / # fail 0` |
| 突變 M11：`ORDER BY version DESC` | `# fail 1`：只有降版測試轉紅（SHOULD FIX 1） |
| 突變 M12：沒有冒號時寫入整串 | `# fail 1`：scope 測試轉紅 |
| 放回 `7819017` 的 `memoria-recall.ts` | `# fail 1`：scope 測試轉紅（舊程式上的紅燈成立） |
| 突變：hook 的 warn 改成 `void err` | `# fail 0`（NICE TO HAVE 1） |
| 突變：`readAppVersion` 改讀 `nope.json` | `# fail 1`：readAppVersion 的測試轉紅 |
| 每次突變後 `git checkout -- src` | `git diff --numstat src` 回到 0 |
| 主 checkout（HEAD `849715e`）：`npm run build` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test` | exit 0；`# tests 577 / # pass 577 / # fail 0 / # cancelled 0`；`tests/docker/` 4 個檔案的測試名稱都出現在輸出中 |
| `npx madge --circular --extensions js dist/services/{memoria-status,recall-metrics-store,memoria-recall-telemetry,context-snapshots}.js` | `No circular dependency found!`（16 個檔案） |
| `node -e "import('./services/memoria-status.js')…"`（在 dist 下） | 只匯出兩個 format 函式，載入時沒有輸出或副作用 |
| `git diff caccb14 849715e \| grep -nE "/home/\|<帳號名>\|/tmp/claude\|[0-9]{8,}\|bot[0-9]+:"` | 沒有命中 |
| `git worktree remove --force`、`git worktree prune`、刪除暫存目錄 | 只剩主 checkout |

## 流程判定

**PASS**

- 沒有 MUST FIX。
- 前次的 3 項 SHOULD FIX 都已解決：
  - 歷史重整的內容等價，每個提交單獨檢出時測試都通過；
  - 降版測試能擋下依版本號排序的突變；
  - 常青文件已登記。
- 這次的修正沒有引入循環依賴或副作用，`# tests 577` 全部通過。
- 唯一的 SHOULD FIX 是 step4 證據與 README 對突變結果的敘述不精確。我已實測，突變結果本身成立，這兩處是純文件修正，不影響驗收判定。
- 修正後會產生新的 HEAD，需依 review-evidence.md 重新核對：只差這兩個文件檔時，核對該檔的差異即可。
