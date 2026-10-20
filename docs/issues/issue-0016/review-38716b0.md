# 審查報告

- 範圍：完整交付範圍（本機獨立審查，未開 PR）。包含 `4b088e1`（實作，上一輪已審，報告為 [review-4b088e1.md](review-4b088e1.md)）、`7aa7933`（只新增上一輪報告）、`38716b0`（審查後續修正，本輪重點）。
- Reviewed BASE SHA：e7064e9ee5593d2518795066224e118650336099（main）
- Reviewed HEAD SHA：38716b08062aacbf4ae1fb126b85540ff6cee7d3
- Reviewed patch-id：`863a1b6f89f25730d4b588f411b7580332942fe5`（reviewer 以 `git diff e7064e9 38716b0 | git patch-id --stable` 重算，與協調者提供的值一致）
- 審查日期：2026-10-20
- 獨立 reviewer：Claude Code 獨立 subagent（general-purpose），非原實作者
- Review artifact：docs/issues/issue-0016/review-38716b0.md

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

1. **`readArchive()` 的說明註解被新函式隔開，現在掛在 `archiveSourceOf()` 上**
   - 位置：`src/services/memory-health.ts:202-209`。
   - 現況：`38716b0` 把 `archiveSourceOf()` 和 `currentArchiveSource()` 插在 `readArchive()` 的 JSDoc 與函式本體之間。結果「讀不到封存時回傳 unavailable / error 與 null 統計，不 throw……也不記 runtime issue……」這段註解現在描述的是只有一行的 `archiveSourceOf()`，`readArchive()`（`:216`）反而沒有註解。
   - 影響：沒有行為影響，但這段註解是「封存讀取失敗不記 runtime issue」的理由。這條和 `CLAUDE.md`「錯誤一律 `recordRuntimeIssue`」不同，是 issue 0017 AC-5 核准過的例外。註解掛錯函式，日後維護的人在 `readArchive()` 上就看不到為什麼不記，而 IDE 的 hover 顯示在 `archiveSourceOf()` 上又是錯的說明。
   - 建議：把兩個新函式移到這段 JSDoc 之前，讓註解回到 `readArchive()` 正上方。這只是搬動位置，不需要重跑紅綠燈證據。

### NICE TO HAVE

1. **「session 沒有時間」的等價案例只測了空字串**（`tests/memory-backfill-worker.test.ts` 的 `PENDING_EQUIVALENCE_CASES`）。NULL 走的是同一條程式路徑：`MAX` 會回 NULL，`parseIsoDate()` 再轉成 `null`。reviewer 的差異 probe 確認 NULL 的情況新舊一致，要補的話加一列就好；Memoria 實際的 schema 是 `timestamp DATETIME`，可以是 NULL。
2. **上一輪 NICE 1、5、6 不處理的理由**（`evidence/step4-review-followup.md`）reviewer 接受。

## 已查核維度

### 驗收與證據

**範圍與歷史**

- `git log e7064e9..38716b0` 只有三個提交。`7aa7933` 只新增了 `review-4b088e1.md`（`--name-status` 為 `A`）。工作區的這份檔案和 `7aa7933` 中的版本完全相同。
- `38716b0` 改了 README 的步驟 4、Timeline 和頁尾狀態；AC-1～AC-4 和核准來源都沒動，Timeline 也寫明「不涉及規格修訂」。

**`.serena/` 與 stash**

- `git diff --name-only e7064e9 38716b0` 沒有 `.serena/` 的檔案。`git diff HEAD -- .serena` 為空，`git status` 也乾淨，所以提交和工作區都沒有夾帶 `.serena/` 的變更。
- `git stash list` 有兩筆，建立時間是 2026-08-08 和 2026-08-10，都建在 `main` 的 `cb5f582` 上，各自改了 `.serena/project.yml`。都是在本 issue 之前就存在的 stash，沒有被消掉，也沒有新增，和證據的說明一致。
- reviewer 沒有使用 `git stash`。舊程式的複本都用 `git archive <SHA>` 取到 scratchpad。

**SHOULD FIX 1（上一輪）：等價差異**

reviewer 拿上一輪的差異 probe 重跑舊版 `e7064e9` 和新版 `38716b0`，13 種邊界資料的結果如下。

| 資料 | 舊版 | 新版 | 是否已記錄 |
|---|---|---|---|
| timestamp 全是 NULL，有或沒有 checkpoint；全是空字串，沒有 checkpoint | 不執行 | 不執行（`no new archive sessions`） | 已修正為一致 |
| timestamp 是 INTEGER，有或沒有 checkpoint | 記 runtime issue | `up-to-date`，不記 issue | 已記錄 |
| 缺 `events` 表 | 執行（真正的回填會在讀 `events` 時失敗） | `error`，記 issue | 已記錄（步驟 1） |
| 缺 `id` 欄位 | 執行 | `error`，記 issue | 已記錄 |
| checkpoint 格式錯誤、是陣列、`lastProcessedTimestamp` 是 `null` | 執行 | 執行 | 一致 |
| checkpoint 的 `lastProcessedTimestamp` 是數字 | `runOnce` 記 issue 並呼叫 `onAfterRun` | 一樣；`start()` 不 throw | 一致 |
| 損壞檔、缺 `sessions` 表 | 記 issue | 記 issue（訊息多了「封存讀取失敗：」前綴） | 一致 |

除了已記錄的三項，沒有其他差異。

**新增測試的紅燈與真偽**（reviewer 用「舊 `src` 加新 `tests`」的複本重跑）

- 新的等價案例「session 的時間是空字串且沒有 checkpoint」在 `e7064e9` 上**通過**，在 `4b088e1` 上失敗，所以期望值就是舊版行為。
- 新測試「checkpoint 的處理時間不是字串時 `start()` 不 throw」：
  - 在 `4b088e1` 上失敗，錯誤是 `TypeError: checkpoint?.lastProcessedTimestamp?.trim is not a function`，也就是 `start()` throw 了。
  - 在 `e7064e9` 上只因為啟動訊息沒有 `source=` 而失敗。實際輸出有 `startup failed: checkpoint?.lastProcessedTimestamp?.trim is not a function`，代表舊版的 `runOnce()` 也會記失敗，和新版要求的行為相同。
  - 和證據的說明一致。

**突變**（reviewer 在 `38716b0` 的複本上做，做完以 `cmp` 確認已還原）

| 突變 | 轉紅的測試 |
|---|---|
| N1：拿掉 `!archive.lastSessionAt` 的分支，恢復 `4b088e1` 的寫法 | 新的等價案例 |
| N2：啟動訊息改回 `this.assessArchiveSource().source` | 新的 `start()` 測試 |
| N3：`currentArchiveSource()` 一律回 `'local'` | AC-2「遠端模式用預設判定……啟動訊息帶 source=remote」 |
| N4：`>` 改成 `>=` | 兩個等價案例與 AC-1 六種狀態的測試 |

**健康報告**：reviewer 用 issue 0017 的 189 組狀態矩陣比對 `4b088e1` 和 `38716b0`。只有「timestamp 全 NULL」那 27 組的 `Backfill Source` 兩行不同，這正是本次的修正；`archive`／`consistency` 的 JSON 和其餘 markdown 完全相同。所以抽出 `archiveSourceOf()` 沒有改變任何既有欄位。

**驗證命令**

- reviewer 在 HEAD 上執行 `npm run build`、`npm run lint`，都是 exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0，`# tests 518`、`# pass 518`、`# fail 0`。
- 518 = 516 + 2，多的兩個是新的等價案例和 `start()` 測試；三個相關測試檔合計從 36 個變成 38 個。
- 測試檔有 70 個，輸出中有 `tests/docker/` 的測試（L-01）。

**各條驗收條件**

| AC | 結論 |
|---|---|
| AC-1 | 通過。11 個等價案例在舊程式上全過；剩下的差異都已記錄，而且都是 Memoria 寫不出的資料 |
| AC-2 | 通過。`start()` 改用 `currentArchiveSource()`，`runOnce()` 的行為不變 |
| AC-3 | 通過。`ARCHIVE_ENV_KEYS` 加入了 `MEMORY_BACKFILL_ENABLED`，主機的設定不再影響這個測試 |
| AC-4 | 通過。`memory-backfill.ts` 在本輪沒有改動，上一輪的查核結論沿用 |

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| `start()` 還有沒有會 throw 的路徑 | 沒有 | `currentArchiveSource()` 只呼叫 `archiveConfiguredBy()`（讀 env）、`resolveMemoriaSessionsDbPath()`（`path.resolve`）和 `fs.existsSync()`，三者都不會 throw；`start()` 裡其他只有 `setTimeout`／`setInterval` | 沒有 throw 路徑。由新測試和 N2 鎖住 |
| `start()` 和 `runOnce()` 對來源的判斷是否一致 | 一致 | 兩邊都經由 `archiveSourceOf(configuredBy, exists)`，輸入相同 | 一致。N3 會被抓到 |
| `runOnce()` 遇到 checkpoint 欄位型別錯誤 | 和舊版一樣，記 issue 並呼叫 `onAfterRun` | 新測試（`afterRunCount=1`、issue +1）與 probe | 相同 |
| 沒有時間的封存出現在健康報告上 | `up-to-date`，原因寫明無從比較 | 狀態矩陣 | 合理。和 worker 的判定相同，符合 AC-3「由同一個函式判定」 |
| timestamp 有些是 NULL、有些有值 | 取有值的 MAX，照常比較 | SQLite 的 `MAX` 會忽略 NULL | 和舊版相同 |

### 需求、架構、安全、品質

- **需求**：決定何時執行回填的條件現在和舊版一致，只差在已記錄的三種非 Memoria 資料。dry-run 預設不變。
- **架構**：`archiveSourceOf()` 讓 `readArchive()` 和 `currentArchiveSource()` 共用同一個來源判斷，沒有重複。啟動訊息不再開資料庫，也順便處理了上一輪提到的啟動成本。
- **品質**：唯一的問題是註解位置（SHOULD FIX 1）。新註解是繁體中文，密度和周邊相近。
- **文件**：`docs/web-console-reference.md` 的 `pending` 措辭已改成「回填有啟用時，worker 下一輪會執行」，和程式一致。`step2-cli.md` 補上了管線結束碼的說明。
- **證據去敏（L-10）**：在 `step4-review-followup.md` 和 README 中搜尋本機家目錄路徑、OS 帳號名、scratchpad 路徑、9～12 位數字 ID、token 格式，沒有命中。
- **提交訊息**：`fix(memory-backfill): …` 加 `Refs: #16`，沒有 AI 署名。

### 豁免、待確認與限制

- **Gate 豁免紀錄**：「不開 PR，改由獨立 subagent 在本機審查」沿用 README 既有的紀錄。TBD-1 的追蹤去向是 GitHub #16，合法。
- **證據的「意外操作與還原」**：實作者主動揭露了 `git stash` 誤用和還原的方式，reviewer 已核對工作區、提交和 stash 清單都沒有受影響，不構成缺失。
- **reviewer 的限制**：
  - 差異 probe、紅燈基準、突變和狀態矩陣都在 scratchpad 複本上執行，複本以 `git archive` 取出，`node_modules` 用 symlink 共用。
  - 所有執行都加了 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 並用暫存 `DB_DIR`，沒有讀寫使用者的 Memoria 資料。
  - 只有 `npm run build` 會更新 `.gitignore` 排除的 `dist/`。
  - worker 在完整服務裡的實跑和實作者一樣沒有做，由單元測試和 probe 涵蓋。

## 流程判定

PASS：沒有 MUST FIX。上一輪兩項 SHOULD FIX 都已正確修正：等價差異只剩已記錄的三項，`start()` 也沒有 throw 路徑了，新測試在舊程式和 `4b088e1` 上的結果都符合預期，4 種突變全被抓到；build、lint 與全部 518 個測試都通過。本輪新的 SHOULD FIX 只是註解位置，不影響行為。
