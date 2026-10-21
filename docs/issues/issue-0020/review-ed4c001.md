# 審查報告
- 範圍：完整交付範圍（本機獨立審查，未開 PR）；`6b6eb1d..ed4c001` 共 3 個提交（`075b67e`、`badcd70`、`ed4c001`），16 個檔案
- Reviewed BASE SHA：6b6eb1d3af9e2553fd815a5ce543c029e37a00b4（main）
- Reviewed HEAD SHA：ed4c00197430d4cef09eb2f2cd3b27c9de3c1ee7
- Reviewed patch-id：248728c3e59e8a2bf593cb6de4238c86eeccfbb9（reviewer 以 `git diff -a 6b6eb1d ed4c001 | git patch-id --stable` 重算，與協調者提供的值一致）
- 審查日期：2026-10-21
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，不是本 issue 的實作者
- Review artifact：docs/issues/issue-0020/review-ed4c001.md

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

1. **「前一版依時間挑選」只靠 formatter 測試，SQL 的排序沒有被釘住**：`src/core/memory.ts:318`
   - 我把 `ORDER BY lastAt DESC` 改成 `ORDER BY version DESC`，16 個測試全部通過。原因是兩組測試資料裡，時間的先後和版本號的大小剛好一致：AC-2 的 2.30.1 → 2.31.0，formatter 測試的 2.29.0 → 2.30.1 → 2.31.0。
   - 影響：降版後又升版時，「最近」和「版本號最大」會選出不同的版本，這個行為目前沒有測試。字串排序還會把 `2.9.0` 排在 `2.10.0` 前面。
   - 現在的程式是對的，問題在證據持久力，不算假綠燈。
   - 建議：AC-2 的資料庫測試加一組時間順序和版本號相反的資料。例如先寫 2.31.0，之後降版寫 2.30.1，最後目前版本是 2.32.0，確認 `summarizeMemoriaRecallByVersion()` 的第一列是 2.30.1。
2. **第一個提交單獨檢出時，測試檔載入失敗**：`075b67e:tests/recall-metrics.test.ts:17-18`（`需決策`）
   - 實測：在 `075b67e` 上跑 `npx tsx --test tests/recall-metrics.test.ts`，結果是 `ERR_MODULE_NOT_FOUND ... src/utils/app-version.js`、`# tests 1 / # fail 1`。同一個檔案裡步驟 1 的 9 個 AC-1 測試因此都沒跑到。
   - 影響：最終樹沒有問題。但 #15 用的是 `git merge --ff-only`，照同樣方式合併的話，main 上會留下一個 `npm run test` 失敗的提交，`git bisect` 會被干擾。
   - 這個切分也和證據的時序不符：證據寫步驟 1 的紅燈只有 9 個測試，但提交裡已經是 16 個。
   - 待決問題：要不要修正歷史？可選做法：
     - (a) 改寫歷史，把步驟 2 的測試與 import 移到 `badcd70`；
     - (b) 合併時 squash；
     - (c) 接受現狀，在結案紀錄裡註明。
   - reviewer 建議：(a) 或 (b)。最終樹應與 `ed4c001` 完全相同，可以用 `git diff ed4c001 <新 HEAD>` 為空來確認。即使這樣，依 review-evidence.md，新 HEAD 也需要協調者重新核對範圍，PASS 不會自動沿用。
3. **常青文件沒有登記新模組與新資料表**：`ARCHITECTURE.md:108-109`、`CLAUDE.md:99`
   - 依 project.md 的「常青文件更新責任」，模組職責或資料流有變動時，要更新 `ARCHITECTURE.md` 與 `CLAUDE.md` 的 Key Modules 表。
   - 同樣仿照的對象 `issue-store.ts` 兩處都有登記；這次新增的 `src/services/recall-metrics-store.ts` 與 `memoria_recall_events` 表兩處都沒有。
   - 建議：在 `issue-store` 旁各補一行，寫明 30 天保留、每 6 小時清理。

### NICE TO HAVE

1. **scope 沒有冒號時會整串寫進資料表**：`src/core/memoria-recall.ts:134`
   - `scope.split(':')[0] ?? scope` 遇到不含 `:` 的 scope（例如裸 ID `12345`）會回傳整串，等於把 ID 寫進 `scope_kind`。`?? scope` 本身是死碼，只是為了滿足 `noUncheckedIndexedAccess`。
   - 目前唯一的呼叫點是 `src/prompt/builder.ts` 的 `` `user:${userId}` ``，一定有前綴，所以不構成現行的隱私問題。
   - 建議：沒有冒號時記成固定值（例如 `other`），讓欄位註解「不存 ID」不必依賴呼叫端。
2. **trace hook 的外層 catch 完全靜默**：`src/services/memoria-recall-telemetry.ts:58`
   - 步驟 1 的突變 M4 已經示範過這個情況：store 的 catch 區塊裡出現 `ReferenceError`，被外層吞掉，沒有留下任何痕跡。
   - 建議：外層至少 `console.warn` 一行，hook 的錯誤才看得到。這不會違反「不記 runtime issue」。
3. **6 小時的定期清理沒有測試**：`src/services/recall-metrics-store.ts:8`
   - 我把間隔改成 24 小時，測試仍然全過。AC-1 的檢查方式只要求「超過 30 天會被清掉」，啟動時的清理已經由突變 M3 證明。
   - 建議：可以用 `mock.timers` 補一個測試；不補也不影響本次驗收。
4. **「30 天」寫在兩個地方**：`src/services/memoria-status.ts:73` 的說明字串、`src/services/recall-metrics-store.ts:9` 的 `RETENTION_MS`。
   - 建議：匯出同一個常數，日後改保留期時兩邊才不會不一致。
5. **README 與 AC 的清理頻率寫法不一致**：`docs/issues/issue-0020/README.md:32` 的「涉及檔案」寫「每日清理」，AC-1 與程式都是每 6 小時。
6. **`Recalls` 計的是召回次數，不是訊息數，文件沒有寫明**：`src/core/message-pipeline.ts:280-281`、`:303`
   - 組裝 prompt 時正在接續 session、送出時綁定已經沒有或 session-missing 時，`rebuildForNewSession()` 會再召回一次，同一則訊息因此寫兩筆。前一筆的 prompt 沒有送出，但 `injected=1`。
   - 這符合 AC-1 的「每次 `recallWithMeta()` 結束寫一筆」，而且兩次是同一個問句，比例幾乎不受影響。
   - 建議：在 `docs/web-console-reference.md` 補一句「Recalls 是召回次數；同一則訊息改開新 session 時會召回兩次」。
7. **`readAppVersion()` 搬家後沒有直接的測試**：`tests/recall-metrics.test.ts:463,470`
   - 串接測試的輸入與期望值都來自 `readAppVersion()`。這只證明接線正確：即使它回傳 `unknown`，測試照樣通過。
   - 建議：加一個斷言，比對它的回傳值和 `package.json` 的 version，證據來源才是獨立的。

## 已查核維度

### 驗收與證據

| AC | 檢查方式 | 證據位置 | reviewer 查核 | 結論 |
|---|---|---|---|---|
| AC-1 | 假 Memoria 的 5 種情況寫入的欄位 | `tests/recall-metrics.test.ts:133-203`；`evidence/step1-red-green.md` | 期望值來自字面的 case 表，不是同義反覆。我自己做的突變：`injected` 不看 snippet 數 → 「成功零命中」轉紅；scope 整串寫入 → 6 個轉紅 | 通過 |
| AC-1 | 不存問句、snippet、使用者 ID | `tests/recall-metrics.test.ts:205-219` | 序列化整列後比對三個字串；scope 突變會讓這個測試轉紅 | 通過 |
| AC-1 | 重新開啟資料庫後資料仍在 | `:221-236`；`evidence/step3-delivery.md` 跨兩個程序實跑 | 第二個 `MemoryManager` 讀同一個 `DB_PATH` | 通過 |
| AC-1 | 超過 30 天的資料被清掉 | `:238-262` | 31 天與 29 天各一筆；把啟動時的清理註解掉 → 轉紅。6 小時的間隔沒有被測到（NICE TO HAVE 3） | 通過 |
| AC-1 | 寫入失敗只印 warn，不記 runtime issue | `:264-290` | 以壞掉的 MemoryManager 驗證：召回結果不受影響、有 warn、runtime issue 數不變 | 通過 |
| AC-2 | 兩個版本的各項數字 | `:334-377` | 期望值是人工推導的字面值。我重做 M7（`COUNT(*)`）、M8（降級不計），都轉紅。依時間排序沒有被釘住（SHOULD FIX 1） | 通過 |
| AC-3 | 0／19／20 筆 | `:395-422` | 門檻改成 `<=` → 20 筆的測試與串接測試轉紅；0 筆時寫明尚無樣本、不出現 `%` | 通過 |
| AC-4 | markdown 內容、讀取 throw 時不 throw | `:379-393`、`:424-473` | 讀取 throw 時有 `Status: error` 與原因，Sync Bridge、Recall Telemetry 照常產生；串接測試走真的 `writeContextSnapshots()` | 通過 |

證據裡自承的兩個弱點：

- **步驟 1 的紅燈靠空殼 store：可以接受。** 我在 `6b6eb1d` 放回空殼 `startRecallMetricsStore()` 與步驟 1 的 9 個測試重跑，結果是 `# tests 9 / # fail 9`。失敗原因是 `no such table` ×6、`appendMemoriaRecallEvent is not a function`、`summarizeMemoriaRecallByVersion is not a function`，以及沒有印出 warn，和證據逐條相符。這些都是缺少目標行為造成的失敗，不是語法錯誤或環境故障。空殼只是讓檔案能載入，沒有 mock 掉要驗收的行為。
- **步驟 2 的彙總測試在紅燈時已經通過，改用突變證明：可以接受。** 查詢在步驟 1 就寫了，這個測試不可能先紅。verification.md 不禁止這種情況，突變能證明斷言會和錯誤的實作不一致。我在 `badcd70` 的樹上把 formatter 換成回傳空字串的空殼重跑，結果是 `# tests 16 / # fail 6`：證據記錄的 5 個，加上後來補的串接測試。

### 「注入」判定是否等於實際進 prompt 的內容

- **定義**：`src/core/memoria-recall.ts` 的 `injected: !droppedLowConfidence && snippets.length > 0`。成功分支被門檻擋下時回傳 `snippets: []`；其他情況回傳的就是同一個 `snippets`。失敗分支固定是 `injected: false`。這和核准的定義 (a) 一致。
- **不呼叫 recall 的路徑**：
  - `minimal` mode：`shouldIncludeMemoryContext` 回傳 false，整段 memory context 都不組，也就不召回、不寫列。
  - `compact` mode 的短訊息：同上。
  - 這兩種情況都不會產生 `injected=1`。
- **組裝後是否保留**：`buildMemoryContextAsync` 在 snippet 非空時取前 3 筆（`semanticLimit`）放進「相關歷史摘要」。`applyContextBudget` 修剪時每節至少保留 1 行（`semanticMinLines: 1`），再把每行壓縮到 140、110 字。
  - 最壞情況是 1 + 1 + 4 行、每行 110 字，加上標題約 720 字，小於預算約 1480 字，最後的整段截斷不會觸發。
  - 所以 `injected=1` 時，至少一筆 snippet（可能被截短）一定進了 memory context。`buildChatPrompt` 在 full 與 compact 都會放入非空的 memoryContext。
- **反方向**：`injected=0` 時 snippet 是空的，builder 改用本機語意摘要，prompt 裡沒有 Memoria 的內容。沒有發現「實際注入卻記成 0」的路徑。
- **例外**：
  - 改開新 session 時會重組 prompt 並再召回一次，前一次召回的 prompt 沒有送出（NICE TO HAVE 6）；
  - 使用者在送出前取消，也會留下 `injected=1`。
  - 兩者都符合定義 (a) 的「回傳給 prompt 組裝」，不影響比例的意義。
- **文件**：`docs/web-console-reference.md` 寫「結果實際交給 prompt 組裝的比例：信心低於門檻而丟棄的不算」，與實作一致。

### 相關失敗面

| 失敗面 | 輸入／狀態 | 預期行為 | 現有覆蓋 | 判定 |
|---|---|---|---|---|
| Memoria HTTP 失敗 | 回 500 | 寫一筆 `ok=0`、`route_mode=error`，不注入 | AC-1 的 HTTP 失敗案例；突變 M2 | 通過 |
| 信心過低 | `confidence=0.1` | `dropped=1`、`injected=0`、`hit_count` 照實記錄 | AC-1；突變 M1 | 通過 |
| `confidence` 為 null 而且有命中 | 無法判斷的路由 | 照常注入 | 程式依 #12 的規則處理；本次沒有專屬測試，但「成功零命中」的案例用的是 null | 可接受 |
| 寫入失敗 | DB 鎖住或 throw | 召回結果不變、只印 warn、不記 runtime issue | AC-1；突變 M4 | 通過 |
| hook 的 catch 區塊本身出錯 | 例如 `ReferenceError` | 不影響聊天 | 外層 catch 吞掉，但完全沒有痕跡 | 可接受（NICE TO HAVE 2） |
| 讀取彙總失敗 | `read()` throw，或 stub 沒有這個方法 | 該節顯示 `Status: error`，不 throw，其他區塊照常 | AC-4；突變 M9 | 通過 |
| context-snapshots 測試的 `stubMemory` | 沒有 `summarizeMemoriaRecallByVersion` | 該節顯示 `Status: error: ... is not a function` | 正式環境的 `MemoryManager` 一定有這個方法；顯示 error 符合 (e) 的原則，那些測試也沒有斷言這一節 | 合理 |
| 版本讀不到 | 沒有 `package.json` | 記成 `unknown`，標題顯示 `Current Version: unknown` | 依 AC-1 的核准內容。正式映像的 `WORKDIR /app`、`npm start` 的 cwd 是 `/app`、`/app/package.json` 是 Dockerfile 在 base stage 複製的，讀得到正確版本 | 合理 |
| 降版或同一版本重新出現 | 2.31 → 2.30 → 2.31 | 前一版取「最後一筆最晚」的其他版本；同一版本的多個時段合併成一列，First/Last 顯示整個跨度 | formatter 的挑選有突變 M6；SQL 依時間排序沒有被釘住 | 程式正確（SHOULD FIX 1） |
| 目前版本沒有資料 | 剛升級、還沒有召回 | 目前版本顯示「尚無樣本」，前一版照常列出 | 「沒有資料」案例只測了兩邊都空；這個組合可以從程式直接看出 | 可接受 |
| 樣本門檻邊界 | 成功 19／20 次 | 19 次三個比例都是 `unknown（樣本不足，n=19）`，20 次顯示 `0.0% (0/20)` | AC-3；突變 M5、M10 | 通過 |
| 效能 | 每則訊息一次同步 INSERT；彙總查詢每 60 秒跑一次，事件觸發時另有節流 | 成本可以忽略 | 我實測 30,000 列（約每天 1,000 次召回、一個月的量）：INSERT 平均 0.031 ms，彙總查詢平均 8.7 ms。實際量級是幾千列，約 1 ms。現有的 `ts` 索引供清理使用，彙總不需要另加索引 | 通過 |
| purge 計時器 | 程序結束時 | 不阻擋程序結束 | `unref?.()`；`stop()` 會清掉計時器 | 通過 |
| 記錄後又進 catch | 成功分支在 `recordMemoriaRecallTrace` 之後 throw | 理論上會再寫一筆 `ok=0` | 之後呼叫的 `emitEvent`、`recordRuntimeIssue` 內部都有 try。這是既有的結構，記憶體裡的 trace 原本就有同樣的特性 | 風險低 |

### 需求、架構、安全、品質

- **需求**：GitHub #20 的範圍（召回次數、命中、注入、降級、跨重啟、不可判定不顯示 0%）都已涵蓋。「只計 `user:` 召回」目前由「唯一的呼叫點固定是 `user:`」保證，彙總查詢沒有用 `scope_kind` 過濾。核准的 AC 沒有要求過濾，日後新增其他 scope 的召回時再補即可。
- **隱私**：
  - 資料表只有 10 個欄位：時間、版本、scope 前綴，以及數值與布林欄位，沒有問句、snippet 或使用者 ID。
  - `scope_kind` 在現行呼叫下只會是 `user`；沒有冒號的情況見 NICE TO HAVE 1。
- **架構**：
  - store 的寫法與 `issue-store.ts` 相同：訂閱 hook、啟動時清理、定時清理。
  - hook 的 Set 與取消訂閱的寫法和 `event-bus` 一致。
  - `formatMemoriaStatusMarkdown()` 新增的參數是選用的，既有呼叫端不受影響。
  - `readAppVersion()` 原封搬到 `src/utils/app-version.ts`，只加了快取。Web Console 原本就只在 `startWebServer()` 啟動時呼叫一次，行為不變。
  - snapshot 與 store 用的是同一個快取值，寫入和呈現的「目前版本」一定一致。
- **`MemoriaRecallTrace` 的必填欄位**：建構點只有 `src/core/memoria-recall.ts` 的兩處，`tests/` 沒有直接建構，`tsc` 也通過，沒有漏改。
- **重複與過度設計**（依 code-simplify 的標準）：
  - `context-snapshots.ts` 把重複的 `formatMemoriaStatusMarkdown(...)` 呼叫收成 `??`，是簡化，而且行為等價。
  - 用 `RecallMetricsSource` 注入讀取函式，是為了 AC-4 的 throw 測試，不算過度設計。
  - `scope_kind` 存了但彙總沒有用到，這是 AC-1 核准的欄位。
  - 只有「30 天」重複寫了兩處（NICE TO HAVE 4）。
- **GitNexus**：我用 `detect_changes(scope=compare, base_ref=6b6eb1d)` 核實，結果是 risk `critical`、42 個 symbol 被標成 touched。
  - 原因有兩個：
    - `MemoryManager` 類別的範圍涵蓋整個檔案，三段新增都落在類別裡；
    - 索引停在 `9d6b8d3`（`.gitnexus/meta.json` 的 indexedAt 是 2026-10-05），行號已經對不上。所以 `syncSummaryFtsRow`、`encodeTagsForFts`、`writeSchedulerHealth`、`countBy` 等內容沒有改的 symbol 也被標成 touched。
  - `git diff --numstat` 的結果：`src/core/memory.ts` 新增 96 行、刪除 0 行；三個 hunk（`-54,0`、`-180,0`、`-226,0`）都是純新增；`memoria-recall-telemetry.ts` 也是刪除 0 行。
  - 實作者的說明成立。實際改到的既有 symbol 只有 `recallWithMeta`、`recordMemoriaRecallTrace`、`MemoriaRecallTrace`、`formatMemoriaStatusMarkdown`、`writeContextSnapshots`、`bootstrap`，以及 server.ts 裡被移除的 `readAppVersion`，都已逐一核對。
- **證據去識別化**：我在整份 diff 裡搜尋 `/home/`、OS 帳號名、`/tmp/claude`、8 位數以上的數字、bot token 樣式，都沒有命中。證據裡的路徑都是 repo 相對路徑（地雷 L-10）。

### 豁免、待確認與限制

- **Gate 豁免**：不開 PR、改由本機獨立審查（README「Gate 豁免紀錄」，2026-10-21）。本報告依這項豁免保存在 issue 目錄。
- **待確認事項**：README 寫「(無)」。
- **環境限制**：
  - 這台主機的 `/tmp` 是啟用 usrquota 的 tmpfs，用量 80%。第一次以預設的 `TMPDIR` 跑 `npm run test`，得到 `# fail 12`，錯誤全是 `Unknown system error -122` 或 `SQLITE_IOERR_WRITE`（EDQUOT），寫入暫存檔的測試都失敗。
  - 改把 `TMPDIR` 指到 ext4 的暫存目錄後，同一個 HEAD 全部通過（574/574）。這是環境問題，與本次變更無關。
  - 也因為 `/tmp` 配額已滿，worktree 沒有開在 scratchpad（它也在同一個 tmpfs），改開在家目錄 cache 下的暫存目錄。用完已經 `git worktree remove` 並刪掉整個暫存目錄。
- **未做的事**：沒有啟動服務、沒有實機驗證、沒有碰正式部署及其 volume、沒有網路寫入。

## 你自己跑過的命令與結果

以下測試都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行，`TMPDIR` 指到 ext4 的暫存目錄。

| 命令 | 結果 |
|---|---|
| `git diff -a 6b6eb1d ed4c001 \| git patch-id --stable` | `248728c3e59e8a2bf593cb6de4238c86eeccfbb9`，一致 |
| `npm run build`（HEAD） | exit 0 |
| `npm run lint`（HEAD） | exit 0 |
| `npm run test`（HEAD，預設 `TMPDIR=/tmp`） | exit 1，`# tests 574 / # fail 12`，全是 EDQUOT 或 `SQLITE_IOERR_WRITE`（環境問題，見上） |
| `npm run test`（HEAD，ext4 `TMPDIR`） | exit 0，`# tests 574 / # pass 574 / # fail 0`。`tests/` 下有 72 個測試檔；`tests/docker/` 4 個檔案的測試名稱都出現在輸出中 |
| worktree 檢出 `075b67e`：`npx tsx --test tests/recall-metrics.test.ts` | exit 1，`ERR_MODULE_NOT_FOUND .../src/utils/app-version.js`（SHOULD FIX 2） |
| worktree 檢出 `6b6eb1d`，加空殼 store 與步驟 1 的 9 個測試 | `# tests 9 / # fail 9`，原因與步驟 1 的證據相符 |
| worktree 檢出 `ed4c001`，formatter 換成空殼 | `# tests 16 / # fail 6`，與步驟 2 的證據相符（5 個 + 串接測試） |
| HEAD 的突變（每次只改一處，跑完 `git checkout -- src` 還原） | 基準 0 fail；M7 `COUNT(*)` → 1 fail；M8 降級不計 → 1 fail；`injected` 不看 snippet → 1 fail；scope 整串寫入 → 6 fail；M5 `<=` → 2 fail；M3 不在啟動時清理 → 1 fail；`ORDER BY version DESC` → **0 fail**（SHOULD FIX 1）；清理間隔改成 24 小時 → **0 fail**（NICE TO HAVE 3） |
| 小型效能測試（暫存 `DB_PATH`，30,000 列） | INSERT 平均 0.031 ms，`summarizeMemoriaRecallByVersion()` 平均 8.7 ms |
| GitNexus `detect_changes(compare, 6b6eb1d)` | critical、42 個 symbol 被標成 touched；以 `git diff --numstat` 與 hunk 標頭核實為誤報（見上） |
| `git diff 6b6eb1d ed4c001 \| grep -nE "/home/\|<帳號名>\|/tmp/claude\|[0-9]{8,}\|bot[0-9]+:"` | 沒有命中 |
| `gh issue view 20`（唯讀） | 讀取範圍與不在範圍內的項目 |
| `git worktree remove --force` 與 `git worktree prune`，刪除暫存目錄 | worktree 只剩主 checkout；`git status --short` 乾淨；沒有使用 `git stash` |

## 流程判定

**PASS**

- 沒有 MUST FIX。AC-1～AC-4 的每個檢查方式都有測試。紅燈由 reviewer 在舊版上重現，與證據相符；主要的突變都會轉紅。
- 「注入」判定與實際進 prompt 的內容一致，符合核准的定義 (a)。
- 三項 SHOULD FIX 都不阻擋：
  - 第 1 項是證據持久力，不是假綠燈；
  - 第 2 項是提交切分，最終樹沒有問題，處理方式 `需決策`；
  - 第 3 項是常青文件。
- 協調者處理後若產生新的 HEAD，需依 review-evidence.md 重新核對範圍。
