# 審查報告

- 範圍：完整交付範圍（本機獨立審查，未開 PR）
- Reviewed BASE SHA：e7064e9ee5593d2518795066224e118650336099（main）
- Reviewed HEAD SHA：4b088e1a111385efcf9a668f27edf92de7a9b78f
- Reviewed patch-id：`d6ee4b0138d951e538728fa40695e4b9eeb327ea`（reviewer 以 `git diff e7064e9 4b088e1 | git patch-id --stable` 重算，與協調者提供的值一致）
- 審查日期：2026-10-20
- 獨立 reviewer：Claude Code 獨立 subagent（general-purpose），非原實作者
- Review artifact：docs/issues/issue-0016/review-4b088e1.md

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

1. **AC-1 的等價分析少列了幾個差異：時間欄位異常的封存，新版會改判 `pending` 並啟動回填**
   - 位置：`src/services/memory-health.ts:290-310`（`judgeBackfillSource()`）；證據 `docs/issues/issue-0016/evidence/step1-red-green.md`「已知差異」。
   - 現況：reviewer 寫了差異 probe，把舊版 worker（`e7064e9`）和新版 worker（`4b088e1`）放在同一組邊界資料上跑 `runOnce()`。只注入 `runBackfill`，判定用預設函式。證據檔只列了「缺 `events` 表」一項差異，實際還有下面這些：

     | 封存狀態 | 舊版 | 新版 |
     |---|---|---|
     | 有 session，但 `timestamp` 全是 NULL 或空字串，checkpoint 沒有處理時間 | 不執行（`no new archive sessions`） | **執行回填**：`totalSessions>0` 且沒有 checkpoint 時間，判 `pending` |
     | `timestamp` 存成 INTEGER，沒有 checkpoint | `row?.last_timestamp?.trim is not a function` → 記 runtime issue | **執行回填** |
     | `timestamp` 存成 INTEGER，有 checkpoint | 記 runtime issue | `up-to-date`，**不記 runtime issue** |
     | `sessions` 表沒有 `id` 欄位 | 執行回填 | `error`（`no such column: id`），記 runtime issue |

   - 影響：AC-1 寫的是「比較方式和現在一樣」，README 也把「`pending`／`up-to-date` 與舊版等價，否則 worker 會多跑或少跑」列為首要風險，前兩列正是多跑。不過這些封存 Memoria 都寫不出來。reviewer 看過 Memoria 1.28.1 的原始碼（全域 npm 套件 `dist/cli.mjs`）：`sessions.timestamp` 的型別是 `DATETIME`，**可以是 NULL**；但兩條寫入路徑（`importSession()` 與 git 促升）都寫 `toISOString()` 的字串。`id` 是 `PRIMARY KEY`。所以現有的支援設定裡碰不到這些情況。而且回填預設是 dry-run，就算多跑一次也不會寫入資料。因此不列為 MUST FIX。
   - 建議：在 `judgeBackfillSource()` 加上「`totalSessions > 0` 但 `lastSessionAt` 是 `null`」時判 `up-to-date` 的分支（原因寫明封存沒有可比較的時間）。這樣 NULL 和空字串的情況就和舊版一致，並補一個對應的等價測試。剩下 INTEGER 與缺 `id` 欄位兩種，和缺 `events` 表一起記進證據的「已知差異」。這是讓實作符合 AC-1 原文，不需要使用者重新決定。

2. **`start()` 多了一條沒有被攔住的 throw**
   - 位置：`src/services/memory-backfill-worker.ts:166`（啟動訊息呼叫 `this.assessArchiveSource()`），追到 `src/services/memory-health.ts:293` 的 `checkpoint?.lastProcessedTimestamp?.trim()`。
   - 現況：checkpoint JSON 的 `lastProcessedTimestamp` 不是字串時（例如 `123`），`?.trim()` 會丟出 `TypeError`。reviewer 用 probe 實測：新版 `start()` 會 throw，舊版的 `start()` 不讀任何檔案，所以不會。`runOnce()` 裡同樣的 throw 會被 catch 接住，記 runtime issue，這點和舊版一樣。但 `start()` 是在 `src/main.ts:435` 的 `bootstrap()` 裡直接呼叫的，throw 會讓 `bootstrap()` reject，後面的釘選訊息初始化和 context snapshot 的定時刷新（`src/main.ts:437-462`）都不會執行。
   - 影響：正常流程碰不到。checkpoint 由 `buildCheckpoint()` 寫入，`lastProcessedTimestamp` 取自 session 的時間戳，而 Memoria 寫的是字串。只有手改 checkpoint，或封存時間戳是 INTEGER（見上一項）時才會發生。不過這是新增的啟動失敗面，而 `start()` 其實只需要 `source`。
   - 建議：讓 `start()` 只判斷來源，不讀封存內容和 checkpoint。例如從 `memory-health.ts` 匯出一個只看設定和檔案是否存在的 `resolveArchiveSource()`，或在 `start()` 加 try/catch，失敗時印 `source=unknown`。這樣也順便省掉啟動時多讀一次封存。

### NICE TO HAVE

1. **worker 每輪讀封存的成本變高**：舊版每輪只跑一次 `MAX(timestamp)`；新版的 `readArchive()` 每輪會 COUNT `sessions` 和 `events`、查近 24h 的 session，還把全部 session ID 讀進 Set。2,522 個 session 的規模可以忽略，健康報告每 60 秒也做同樣的事。封存變大時可以考慮讓判定只取需要的欄位。
2. **`docs/web-console-reference.md:67` 說 `pending` 是「worker 下一輪會執行」**，但同一句也說回填沒啟用時照樣會顯示這個狀態，而沒啟用時 worker 不會執行。建議改成「worker 啟用時，下一輪會執行」。
3. **AC-3 的測試假設主機沒有設 `MEMORY_BACKFILL_ENABLED`**（`tests/memory-health.test.ts:554` 起，`assert.equal(report.backfill.enabled, false)`），但 `withArchiveEnv` 不會清這個變數。步驟 2 的 CLI 有加 `-u MEMORY_BACKFILL_ENABLED`，單元測試沒有。可以把它加進 `ARCHIVE_ENV_KEYS`。
4. **`step2-cli-output.txt` 第一段 `memory-backfill-cli` 的輸出寫著 `exit=0`**，那是經過管線後的 exit code，緊接著另一段「exit code only」才是 1。這樣容易讓人誤讀，可以在第一段註明 exit code 來自管線。
5. **`throw new Error(detail)`**（`src/services/memory-backfill-worker.ts:190`）只保留了訊息，原始錯誤的 stack 在 `readArchive()` 裡就丟掉了。runtime issue 的用途有訊息就夠，影響可忽略。
6. **更正上一份審查**：[review-4451564.md](../issue-0017/review-4451564.md) 的 NICE 4 與失敗面表格說「Memoria 的 `sessions.timestamp` 是 `NOT NULL`」，這是錯的。那是測試 fixture 的 schema，Memoria 實際的型別是 `DATETIME`，可以是 NULL。不過寫入端一律寫 ISO 字串，所以那份審查「實務上碰不到」的結論不變。

## 已查核維度

### 驗收與證據

**驗收條件文字**：`git diff e7064e9 4b088e1 -- docs/issues/issue-0016/README.md` 只改了三個步驟的狀態、完成證據和頁尾狀態，AC-1～AC-4 與核准來源都沒動。

**紅燈基準**：reviewer 自己在舊程式上跑。做法是把 `e7064e9` 的 `src/` 和 `4b088e1` 的 `tests/` 組成一份 scratchpad 複本，再以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行。

- worker 測試是 `# tests 16`、`# pass 11`、`# fail 5`。10 個 AC-1 等價測試**全部通過**，所以它們的期望值確實就是舊版 `defaultHasPendingArchiveSessions()` 的行為，不是同義反覆。AC-2 的 3 個測試和改用新注入選項的既有測試 2、3 失敗。
- `memory-health.test.ts` 整個檔案因為缺少 `assessBackfillSource` 這個 export 而載入失敗。
- `memory-backfill.test.ts` 的 2 個 AC-4 測試失敗。

證據檔記的是 7 個失敗，失敗的既有測試是 1；reviewer 這邊是 8 個，失敗的是既有測試 2、3。差別在環境：證據檔的紅燈沒有加 `env -u`，舊程式的預設判定讀到了主機的 `MEMORIA_HOME`，判成 `pending`；reviewer 的環境是遠端模式，判成不執行。證據檔的註記已經主動揭露這件事，兩邊的結果都說得通。

**突變**：reviewer 在 `4b088e1` 的複本上做了 6 種，做完都還原，並用 `cmp` 確認和原檔相同。

| 突變 | 轉紅的測試 |
|---|---|
| M1：`>` 改成 `>=` | 等價測試「最新 session 與 checkpoint 相同」「checkpoint 前後有空白但時間相同」，以及 AC-1 六種狀態的測試 |
| M2：worker 的 `error` 改成只印訊息後 return | AC-2「封存讀取失敗照舊記 runtime issue 並呼叫 onAfterRun」 |
| M3：拿掉 `empty` 分支 | 等價測試「空封存且沒有 checkpoint」、AC-1 六種狀態 |
| M4：沒有 checkpoint 時改判 `up-to-date` | 等價測試「沒有 checkpoint」「checkpoint 時間是空白」、AC-1 六種狀態 |
| M5：CLI 改回 `sessions.db not found: <路徑>` | AC-4 兩個測試 |
| M6：啟動訊息拿掉 `source=` | AC-2「遠端模式用預設判定」 |

每種突變都被抓到。

**各條驗收條件**

| AC | 證據 | 結論 |
|---|---|---|
| AC-1 | `tests/memory-health.test.ts` 的六種狀態測試；`tests/memory-backfill-worker.test.ts` 的 10 個等價測試（在舊程式上全過，可作為獨立的真相來源）；M1、M3、M4 | 通過。少列的等價差異見 SHOULD FIX 1 |
| AC-2 | worker 的 3 個 AC-2 測試加上改寫的 3 個既有測試；M2、M6 | 通過 |
| AC-3 | `tests/memory-health.test.ts:554` 起（遠端與本機 `pending` 的 JSON 和 markdown）；`step2-cli.md`；reviewer 用編譯後的 CLI 在遠端模式重跑，看到 `Backfill Source State: remote-unsupported` | 通過 |
| AC-4 | `tests/memory-backfill.test.ts` 的 2 個測試；M5；reviewer 在暫存目錄重跑 `node dist/tools/memory-backfill-cli.js once --json`，exit 1，訊息說明是遠端模式，暫存目錄沒有出現 checkpoint 或報告檔 | 通過 |

**驗證命令**：reviewer 在 HEAD 上執行 `npm run build` 和 `npm run lint`，都是 exit 0。`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0，`# tests 516`、`# pass 516`、`# fail 0`。516 = 499 + 17，17 是本 issue 新增的測試（health 2 個、worker 13 個、backfill 2 個），和 step1 證據的數字相符。測試檔有 70 個，輸出中有 `tests/docker/` 的測試（L-01）。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| 缺 `events` 表 | 和舊版一樣，最後都記 runtime issue | 證據已揭露。舊版判 `pending` 後，真正的回填會在 `memory-backfill.ts:741` 讀 `events` 時失敗；reviewer 的 probe 裡注入的 `runBackfill` 不會失敗，所以看起來是「執行了」 | 可接受，已揭露 |
| `MAX(timestamp)` 是 NULL 或空字串，但有 session | 不執行（舊版行為） | 沒有測試；probe 顯示新版沒有 checkpoint 時會執行 | SHOULD FIX 1 |
| 時間戳是 INTEGER、`sessions` 缺 `id` 欄位 | — | probe 顯示有差異 | Memoria 寫不出這種資料。SHOULD FIX 1 建議記進已知差異 |
| checkpoint JSON 格式錯誤、是陣列、`lastProcessedTimestamp` 是 `null` | 和舊版相同 | probe：新舊版都判 `pending` 並執行（兩邊的 `readCheckpoint()` 程式碼相同，格式錯誤時回傳 `null`） | 等價 |
| checkpoint 的 `lastProcessedTimestamp` 是數字 | 和舊版相同 | probe：`runOnce()` 的結果新舊相同（runtime issue 加 `onAfterRun`），但新版的 `start()` 會 throw | SHOULD FIX 2 |
| `readArchive()` 多出的查詢失敗（`events`、`id`、近 24h） | — | 全部變成 `error` 並記 runtime issue，不 throw | 合理。實際的回填本來就需要這些表和欄位 |
| worker 的 `error`：在 try 內 throw，交給 catch | 和舊版讀取失敗時相同：記 `memory-backfill:worker`、呼叫 `onAfterRun`、釋放 `inFlight` | AC-2 的測試加 M2；probe 對損壞檔和缺 `sessions` 表的結果是 `after=1 issue=1`，新舊相同。`finally { this.inFlight = false }` 沒改；跳過的狀態走 `return`，同樣經過 `finally` | 相同。`inFlight` 會釋放 |
| 跳過的狀態（`remote-unsupported`／`unavailable`／`empty`／`up-to-date`） | 不呼叫 `onAfterRun`，和舊版的 `false` 分支相同 | probe 與 AC-2 測試 | 相同 |
| `start()` 讀封存的影響 | — | 每次啟動多一次同步讀取，緊接在 `writeContextSnapshotsFn()`（做同樣的讀取）之後；`readArchive()` 本身不 throw | 成本可以忽略；只有 checkpoint 欄位型別錯誤時會 throw（SHOULD FIX 2） |
| AC-4：`memory-backfill.ts` 的 throw 位置 | 仍在 `try` 之前，不記 runtime issue、不寫 checkpoint | 用 `git diff -a` 看，只改了 import 和第 865-866 行（加一行註解、換掉訊息）；throw 仍在 `try {` 之前，`catch` 裡的 `recordRuntimeIssue` 和寫失敗 checkpoint 的路徑碰不到。AC-4 測試與 CLI 實跑都確認了 | 正確 |
| 檔案在兩次 `existsSync` 之間才出現（TOCTOU） | — | `runMemoryBackfill()` 和 `readArchive()` 各檢查一次 | 只會影響錯誤訊息的文字，可以忽略 |
| 循環 import | — | `memory-backfill.ts` 對 `memory-health.ts` 的 import 從 type-only 改成 value import；`memory-health.ts` 不 import 任何 backfill 模組 | 沒有循環 |
| JSON 欄位 | 只新增欄位 | `backfill.sourceState`／`sourceDetail`；消費者與 issue 0017 相同，都原樣輸出 | 相容 |

### 需求、架構、安全、品質

- **需求**：決定何時執行回填的條件只有 SHOULD FIX 1 列的那些差異，dry-run 預設不變。GitHub #16 第二部分留在 TBD-1，並寫了追蹤去向。
- **架構**：判定集中在 `judgeBackfillSource()`，健康報告與 worker 共用。worker 原本那份 `readCheckpoint()` 和封存讀取是重複的，這次移除了，這是正面的簡化。`assessBackfillSource()` 透過注入選項 `assessArchiveSource` 讓 worker 可以測試，沿用了既有的注入風格。
- **安全**：`sourceDetail` 只帶判定原因、checkpoint 時間和封存路徑，路徑本來就在報告的 `paths` 欄位裡，沒有新的暴露面。
- **品質**：沒有過度設計。註解是繁體中文，密度和周邊相近。
- **文件**：`docs/configuration-reference.md` 寫的各狀態訊息、`remote-unsupported` 的格式、`memory:backfill` 失敗退出，都和程式一致。`docs/web-console-reference.md` 的欄位名稱、六種狀態的說明，以及「`lastRunStatus` 只記實際執行」都和程式一致；`pending` 的措辭見 NICE 2。
- **證據去敏（L-10）**：在 `docs/issues/issue-0016/` 下搜尋本機家目錄路徑、OS 帳號名、scratchpad 路徑、9～12 位數字 ID 和 token 格式，沒有命中。暫存路徑都換成了 `<tmp>`。
- **提交訊息**：`fix(memory-backfill): …`，沒有 AI 署名。

### 豁免、待確認與限制

- **Gate 豁免紀錄**：「不開 PR，改由獨立 subagent 在本機審查」已記錄，並附使用者的選項原文，格式和 issue 0014、0017 一致。
- **待確認事項**：TBD-1 是 `不影響本次交付`，追蹤去向是 GitHub #16，合法。
- **證據的流程揭露**：證據檔寫明紅燈階段的舊程式曾唯讀開啟主機 `MEMORIA_HOME` 指向的封存。這是實作者主動揭露，不構成缺失。之後的紅燈建議一開始就加 `env -u`。
- **reviewer 的限制**：
  - 差異 probe、紅燈基準與突變都在 scratchpad 複本上執行，複本以 `git archive` 取出，`node_modules` 用 symlink 共用。
  - 所有測試與 CLI 都加了 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 並用暫存 `DB_DIR`，沒有讀寫使用者的 Memoria 資料。
  - Memoria 的 schema 和寫入方式是從全域 npm 套件 `@raybird.chen/memoria` 1.28.1 的程式碼讀來的，沒有讀任何 Memoria 資料檔。
  - 只有 `npm run build` 會更新 `.gitignore` 排除的 `dist/`。
  - worker 在完整服務裡的實跑和實作者一樣沒有做，由單元測試與 probe 涵蓋。

## 流程判定

PASS：沒有 MUST FIX。AC-1～AC-4 都有測試，等價測試在舊程式上全過，可作為獨立的真相來源，6 種突變也全被抓到；build、lint 與全部 516 個測試都通過。兩項 SHOULD FIX（Memoria 寫不出的時間欄位異常會造成判定差異、`start()` 多了一條 throw 路徑）在現有支援設定下碰不到，建議在合併前或接著的提交裡處理。
