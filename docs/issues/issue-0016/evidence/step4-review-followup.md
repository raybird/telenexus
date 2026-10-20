# 步驟 4：審查後續（SHOULD FIX 1、2）

- **日期**：2026-10-20
- **對應**：AC-1、AC-2；[review-4b088e1.md](../review-4b088e1.md) 的 SHOULD FIX 1、2 與 NICE TO HAVE 2、3、4
- **環境**：分支 `fix/issue-0016-backfill-source-state`，基準 `7aa7933`（被審查提交 `4b088e1` 加上審查報告），工作區未提交；Node.js v22.20.0、tsx v4.21.0。測試一律以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行。

## SHOULD FIX 1：session 沒有時間時的等價

`MAX(timestamp)` 為空字串或 NULL、但封存有 session 時，舊版不執行回填；`4b088e1` 在沒有 checkpoint 時判 `pending`，會多跑一次。`judgeBackfillSource()` 在 `empty` 之後加一個分支：`lastSessionAt` 是空的就判 `up-to-date`，原因寫「封存的 session 都沒有時間，無從比較」。

新增等價案例「session 的時間是空字串且沒有 checkpoint → 不執行回填」。

| 程式 | 結果 |
|---|---|
| 舊程式（以 `git show e7064e9:<路徑>` 寫出三個 `src` 檔） | 新案例與其餘 10 個等價案例都通過，預期值就是舊行為 |
| `4b088e1` | 新案例失敗（回填被執行） |
| 修正後 | 通過 |

### 已知差異（補記）

審查的 probe 另外找到兩種差異。Memoria 的寫入端都寫 ISO 字串、`id` 是主鍵，所以實際資料碰不到；回填預設是 dry-run。照審查建議只記錄，不改程式：

| 資料 | 舊版 | 新版 |
|---|---|---|
| `sessions.timestamp` 存成 INTEGER | 對數字呼叫 `trim()` 而 throw，記 runtime issue | `readArchive()` 讀不到字串時間，判 `up-to-date`，不記 issue |
| `sessions` 表缺 `id` 欄位 | 只查 `MAX(timestamp)`，判定後執行回填 | `readArchive()` 查 `id` 失敗，判 `error` 並記 runtime issue |

步驟 1 已記的「缺 `events` 表」差異不變。

## SHOULD FIX 2：`start()` 的 throw

`4b088e1` 的啟動訊息為了印 `source=` 呼叫完整判定。checkpoint 的 `lastProcessedTimestamp` 不是字串時會丟 TypeError，`start()` 跟著 throw，`bootstrap()`（`src/main.ts`）reject，後面的初始化都不會執行。

修正：`memory-health.ts` 匯出 `currentArchiveSource()`，只看設定和檔案是否存在，不開資料庫、不會 throw；`readArchive()` 和它共用同一個來源判斷 `archiveSourceOf()`。啟動訊息改用它。`runOnce()` 遇到同樣的 checkpoint 仍會 throw，由原本的 catch 記 runtime issue 並呼叫 `onAfterRun`，和舊版相同。

新增測試「checkpoint 的處理時間不是字串時 start() 不 throw，runOnce() 照舊記 runtime issue」：

| 程式 | 結果 |
|---|---|
| 舊程式 | 失敗，只因為舊版啟動訊息沒有 `source=`；`start()` 本身不 throw |
| `4b088e1` | 失敗，`start()` throw |
| 修正後 | 通過 |
| 突變：啟動訊息改回 `this.assessArchiveSource().source` | 只有這個測試轉紅（`# pass 17`、`# fail 1`），還原後以 `cmp` 確認 |

## NICE TO HAVE

| 項目 | 處理 |
|---|---|
| 1 worker 每輪讀封存的成本比舊版高 | 不處理：`readArchive()` 和每 60 秒的 context snapshot 是同一份讀取，worker 每 5 分鐘一次 |
| 2 `pending` 的措辭 | 已處理：`docs/web-console-reference.md` 改成「回填有啟用時，worker 下一輪會執行」 |
| 3 AC-3 測試沒清 `MEMORY_BACKFILL_ENABLED` | 已處理：加進 `tests/memory-health.test.ts` 的 `ARCHIVE_ENV_KEYS` |
| 4 `step2-cli-output.txt` 的 `exit=0` 容易誤讀 | 已處理：[step2-cli.md](step2-cli.md) 說明管線的結束碼 |
| 5 worker 的 error 只保留訊息 | 不處理：`readArchive()` 本來就只保存錯誤訊息，原始 stack 在那裡就沒有了；訊息已寫明原因 |
| 6 更正 issue 0017 審查的 NOT NULL 說法 | 不在本 issue 修改：那是 issue 0017 的審查紀錄，結論不變；更正已寫在本 issue 的審查報告 |

## 意外操作與還原

為了在舊程式上跑測試，曾執行 `git stash push -- src`。當時 `src/` 已全部提交，沒有東西可存，接著的 `git stash pop` 套用了 repo 裡原有的另一個 stash（建在 `main` 的 `cb5f582` 上），並在 `.serena/project.yml` 衝突。`src/` 沒有被改動。pop 之前 `.serena/project.yml` 與 HEAD 相同，所以以 `git checkout HEAD -- .serena/project.yml` 還原；那個 stash 因衝突仍保留在清單裡，沒有遺失。之後執行舊程式一律用 `git show <基準>:<路徑>`。

## 交付檢查

見 README 步驟 4 的完成證據。
