# 審查報告

- 範圍：完整交付範圍（本機獨立審查，未開 PR）。包含 `4451564`（實作，上一輪已審，報告為 [review-4451564.md](review-4451564.md)）、`c08cf64`（只新增上一輪報告）、`43877b3`（審查後續修正，本輪重點）。
- Reviewed BASE SHA：e69ca9bce356ad8bfae6907823068dfc6454e406（main）
- Reviewed HEAD SHA：43877b3be70c666a26d50e5291b328851cb71629
- Reviewed patch-id：`e280a986260485edd2c7d0afa573431d8d1e89cc`（reviewer 以 `git diff e69ca9b 43877b3 | git patch-id --stable` 重算，與協調者提供的值一致）
- 審查日期：2026-10-20
- 獨立 reviewer：Claude Code 獨立 subagent（general-purpose），非原實作者
- Review artifact：docs/issues/issue-0017/review-43877b3.md

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

無。

### NICE TO HAVE

1. **`checkCheckpointField()` 同時收 `archive` 和 `archiveCheck`**（`src/services/memory-health.ts:257-266`）。`archiveCheck` 可以由 `archive.status` 推出來，同一件事有兩個參數；呼叫端目前只有 `collectConsistencyReport()` 一處，而且傳入的值一致，沒有實際風險。
2. **AC-2 修訂多寫了「值為 `false`」**（`docs/issues/issue-0017/README.md:34`）。使用者的決定只說「有 checkpoint 時才標 `unsupported`」。`skipped` 時值是 `false`，這是 `4451564` 就有的行為，AC-4 也說 `skipped`「不影響判定」，新測試另外鎖住了這個值。它描述的是既有行為，沒有夾帶新的語意，記在這裡只是讓使用者知道修訂文字多了這個細節。
3. **README 頁尾的 `**狀態**: 待重新審查`** 不是 `docs/AGENTS.md` 定義的狀態詞，其他 issue 的終態都是 `已完成`。本輪 PASS 之後依實際交付方式更新即可。TBD-2 還是 `待確認`，結案前要有結論（另開 issue，或寫明不追蹤的理由）。它是既有行為，不在 AC 範圍內，不擋本次交付。

## 已查核維度

### 驗收與證據

**範圍與歷史**

- `git log e69ca9b..43877b3` 只有三個提交。`c08cf64` 只新增了 `review-4451564.md`（`--name-status` 為 `A`）。工作區的這份檔案和 `c08cf64` 中的版本完全相同，上一輪報告沒有被改過。

**AC-2 修訂文字**（`git diff c08cf64 43877b3 -- docs/issues/issue-0017/README.md`）

- AC-2 改了三個地方：
  - orphan 檢查維持 `unsupported`／`null`。
  - checkpoint 兩項檢查改成「有對應欄位時才標 `unsupported`／`null`，沒有時依 AC-4 標 `skipped`」。
  - 「不論哪種組合，`ok` 都是 `null`」由原本的 `ok=null` 擴寫而來，因為 orphan 一定是 `unsupported` 或 `error`。
- 檢查方式多了「遠端＋沒有 checkpoint」的測試。
- AC-1、AC-3、AC-4、AC-5 和原核准來源一個字都沒動。另外新增了一段「規格修訂（2026-10-20）」，記下審查來源與使用者的原話。
- 結論：修訂只依使用者的決定改寫，沒有夾帶其他語意變更。唯一多出的細節見 NICE 2。

**各條驗收條件的覆蓋**

| AC | 證據 | 結論 |
|---|---|---|
| AC-1 | `tests/memory-health.test.ts:268-342`。「設定的路徑不存在」改成 `MEMORIA_ARCHIVE_DB`／`MEMORIA_HOME` 各跑一次，補上 `exists`、`sessions24h`、`lastSessionAt` 與 markdown 的斷言；步驟 2 的 CLI 證據沿用 | 通過，上一輪 NICE 6 已處理 |
| AC-2（修訂後） | `:344-368`（有 checkpoint）、`:371-388`（遠端＋沒有 checkpoint） | 通過 |
| AC-3 | `:390-` 與既有的 drift 測試、LIKE 等價測試 | 通過 |
| AC-4 | 既有的 AC-4 測試 | 通過 |
| AC-5 | 兩種讀取失敗各一個測試 | 通過 |

**突變核對**（reviewer 自己在 `43877b3` 的 scratchpad 複本上重做，做完已還原並用 `cmp` 確認和原檔相同）

| 突變（`checkCheckpointField` 的第一行，`!value` 分支） | 結果 |
|---|---|
| 無（基準） | `# tests 11`、`# pass 11` |
| M1：status 跟著封存狀態，problem 維持 `false`（協調者做的版本） | `# fail 2`：新的「AC-2／AC-4 遠端＋沒有 checkpoint」測試與 AC-4 測試轉紅 |
| M2：AC-2 修訂前的字面解讀（status 跟著封存狀態，沒讀到時 problem 是 `null`） | `# fail 2`，失敗的是同兩個測試 |
| M3：status 維持 `skipped`，沒讀到時只把 problem 改成 `null` | `# fail 1`，只有新測試轉紅 |

新測試擋得住兩種方向的回歸，M3 那種只有它抓得到。期望值都是字面值，沒有同義反覆。這個測試鎖的是既有行為，所以本來就不會有紅燈；證據檔也這樣寫，並改用突變證明它有效，合乎 verification.md 的規定。

**SHOULD FIX 2（影響分析紀錄）**

- `step1-red-green.md` 補了「0. 改動前的影響分析」。
- reviewer 用 `gitnexus_impact` 重跑 `formatMemoryHealthMarkdown`（upstream）：只回報 `memory-health-cli.ts` 一個呼叫者，風險 LOW。這和補記的內容一致，也一樣漏掉了 grep 找到的 `context-snapshots.ts:159`。
- 補記的段落標了「補記」日期，沒有冒充是當時寫下的紀錄。

**驗證命令**

- reviewer 在 HEAD 上執行 `npm run build` 和 `npm run lint`，都是 exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0，`# tests 499`、`# pass 499`、`# fail 0`。測試檔仍是 70 個，輸出中有 `tests/docker/` 的測試（L-01）。
- 499 這個數字的來源：`tests/memory-health.test.ts` 從 9 個測試變成 11 個。AC-1「設定的路徑不存在」拆成兩個，多 1 個；新增「遠端＋沒有 checkpoint」，再多 1 個。497 + 2 = 499，和 `step4-review-followup.md` 的說明一致。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| NICE 3 的重構（`checkCheckpointField()` 取代巢狀三元式、`exists` 併入 `readArchive()` 的回傳值）是否等價 | 每個欄位的值都不變 | reviewer 寫了一份狀態矩陣 probe：封存 7 種狀態（remote、設定的路徑不存在、空封存、非空封存、timestamp 全 NULL、損壞、sentinel 存在）× checkpoint 9 種（沒有、空物件、只有 session、session 不存在、只有時間、時間超前、兩者都有、兩者都異常、空白字串）× 觀察 3 組，共 189 組。在 `4451564` 和 `43877b3` 上各跑一次，輸出完整的 `archive`／`consistency` JSON 和 markdown（去掉時間戳和暫存路徑），`diff` 完全相同 | 等價。`exists` 從呼叫兩次 `fs.existsSync` 改成用一次的結果，連 JSON 欄位順序都一樣 |
| 舊 helper `withHealthEnv` 沒清 `MEMORIA_ARCHIVE_DB`（上一輪 NICE 1） | 主機有設這個變數時，測試也不受影響 | reviewer 把 `MEMORIA_ARCHIVE_DB` 和 `MEMORIA_HOME` 指向 scratchpad 的假路徑後執行，`# pass 11`（上一輪同樣條件下有 2 個失敗）；`finally` 會還原這個變數 | 已修正 |
| `withArchiveEnv` 加上 `for (const envKey …)` 產生的兩個測試互相汙染 | 每個測試開始時 env 都是乾淨的 | 測試內設定的 `process.env[envKey]` 屬於 `ARCHIVE_ENV_KEYS`，`finally` 會還原 | 沒有汙染 |
| 遠端＋沒有 checkpoint（正式部署的預設） | `unsupported`／`skipped`／`skipped`，`ok=null` | 新測試加上 M1～M3 的突變 | 已鎖住 |
| 上一輪的其他失敗面（sentinel 存在、`MEMORIA_HOME` 是空白、timestamp 全 NULL、沒有 events 表、`memory.db` 損壞、三態邏輯、runtime issue 的核准依據、`null` 欄位的消費者、AC-1 的網路測試） | — | 矩陣 probe 涵蓋前四項，兩個版本的輸出相同；其餘兩版本之間沒有變化 | 結論沿用 [review-4451564.md](review-4451564.md)。NICE 2、4 不處理的理由合理：改 `paths.ts` 的介面超出範圍，而 Memoria 的 schema 是 `NOT NULL`；NICE 5 已轉成 TBD-2 |

### 需求、架構、安全、品質

- **需求**：`43877b3` 沒有改變任何產品行為。src 的改動經矩陣 probe 證實和 `4451564` 等價，其餘只改了測試與文件。
- **品質**：`checkCheckpointField()` 把兩段重複的「沒有欄位→skipped／沒讀到→null／讀到→判定」收成一個函式，三層巢狀三元式也消失了，可讀性變好。剩下的小重複見 NICE 1。新增的註解是繁體中文，密度和周邊相近。
- **安全**：沒有新增對外暴露的資料。
- **證據去敏（L-10）**：在 `docs/issues/issue-0017/` 下搜尋本機家目錄路徑、OS 帳號名、scratchpad 路徑、8～12 位數字 ID、token 格式，`step4-review-followup.md` 和 step1 的補記段落都沒有命中。
- **提交訊息**：`fix(memory-health): …` 加上 `Refs: #17`，沒有 AI 署名。

### 豁免、待確認與限制

- **Gate 豁免紀錄**：README 新增一列「不開 PR；改由獨立 subagent 在本機審查 `main..HEAD`」，引用使用者的選項原文「分支＋本機審查（建議）」，殘餘風險寫的是沒有 GitHub PR 紀錄。格式和 issue 0014 一致，符合 `docs/AGENTS.md` 對「Gate 豁免紀錄」的要求。
- **待確認事項**：TBD-1 維持 `不影響本次交付`，有結論與理由。TBD-2 是 `待確認`，屬於非阻塞的既有行為，不影響 AC-1～AC-5，結案前要有結論（見 NICE 3）。
- **reviewer 的限制**：
  - 突變和矩陣 probe 都在 scratchpad 複本上執行，複本用 `git archive` 取出 `src/`、`tests/`、`package.json`、`tsconfig.json`，`node_modules` 以 symlink 共用。
  - 所有 memory-health 相關的執行都加了 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 並用暫存 `DB_DIR`，沒有讀寫使用者的 Memoria 資料。
  - 只有 `npm run build` 會更新 `.gitignore` 排除的 `dist/`。

## 流程判定

PASS：完整範圍內沒有 MUST FIX 或 SHOULD FIX。AC-2 依使用者的決定修訂，新測試經三種突變證明擋得住回歸。重構以 189 組狀態矩陣證實和被審查的 `4451564` 完全等價，build、lint 與全部 499 個測試都通過。
