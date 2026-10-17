# 步驟 1：在資料庫複本上確認 VACUUM 與 WAL 截斷的行為

- **日期**：2026-10-18
- **對應**：AC-1、AC-2 的前提；README 的 TBD-1
- **環境**：`ghcr.io/raybird/telenexus:v2.30.0`，opencode 1.18.34（與正式環境同版）。以 [step1-scripts/oc.sh](step1-scripts/oc.sh) 啟動拋棄式容器：只掛複本，不帶 auth、不發佈 port。
- **複本**：取自正式部署 2026-10-18 升級 v2.30.0 前、服務停止後打包的 opencode 資料 volume 備份，解壓到 repo 之外的暫存目錄，排除 `auth.json`。正式部署沒有被讀寫。複本在驗證後刪除。
- **紀錄範圍**：只記檔案大小、頁數與 opencode 的輸出，不記 session ID、標題、對話內容或本機路徑。腳本是 [step1-scripts/wal.cjs](step1-scripts/wal.cjs)。

## opencode 結束時不刪除 WAL（TBD-1）

複本解壓後主檔 228,745,216 bytes、WAL 4,923,432 bytes。在容器內執行一次 `opencode db --format json "select count(*) as n from session"`（exit 0）之後：

| | 執行前 | 執行後 |
|---|---|---|
| `opencode.db` | 228,745,216 | 228,892,672 |
| `opencode.db-wal` | 4,923,432 | 4,923,432 |

主檔變大，代表 opencode 把 WAL 的內容 checkpoint 回主檔；但 WAL 檔沒有被刪除，大小也沒變。SQLite 在最後一個連線正常關閉時才會刪除 WAL，所以 opencode 結束時沒有正常關閉連線。正式環境的 WAL 在 03:31 回收後一直維持 173 MB，不需要假設有常駐的連線也能解釋。

`opencode db` 連線的設定（`select * from pragma_journal_mode(), pragma_journal_size_limit(), pragma_busy_timeout()`）：`journal_mode=wal`、`journal_size_limit=-1`、`busy_timeout=5000`。

## 量測

先以 better-sqlite3 在複本上刪除最舊的 300 個頂層 session（`foreign_keys=ON`，相關資料連帶刪除），讓可回收頁數達到兩成：55,882 頁中 11,641 頁可回收（20.8%）。刪除只是為了製造可回收頁數，被測對象是之後的 `VACUUM` 與截斷。接著執行 `node /work/wal.cjs run`，每個時間點的結果：

| 時間點 | opencode 的命令與輸出 | 主檔 bytes | WAL bytes |
|---|---|---|---|
| 刪除後 | — | 228,892,672 | 0 |
| 回收 | `opencode db VACUUM`：exit 0、1,000 ms、無輸出 | 172,851,200 | **173,864,032** |
| 截斷 | `opencode db --format json "PRAGMA wal_checkpoint(TRUNCATE)"`：exit 0、725 ms、`[{"busy":0,"log":0,"checkpointed":0}]` | 172,851,200 | **0** |
| 再回收一次 | `opencode db VACUUM`：exit 0、1,008 ms | 172,851,200 | 173,864,032 |
| 另一個連線持有讀取交易時截斷 | 同上的截斷命令：**exit 0**、5,671 ms、`[{"busy":1,"log":42200,"checkpointed":42200}]` | 172,851,200 | 173,864,032 |
| 讀取交易結束、該連線關閉後 | — | 172,851,200 | 173,864,032 |
| 再截斷一次 | 同上的截斷命令：exit 0、700 ms、`[{"busy":0,"log":0,"checkpointed":0}]` | 172,851,200 | 0 |

- **問題重現**：`VACUUM` 之後 WAL 比主檔還大一點（173.9 MB 對 172.9 MB），合計 346.7 MB，比回收前的 228.9 MB 多。這和正式環境的觀察一致。issue 0009 [step1 實測](../../issue-0009/evidence/step1-delete-vacuum-probe.md)記錄的「220,889,088 降到 168,755,200 bytes」只量了主檔。
- **截斷有效**：`busy` 為 0 時 WAL 縮回 0 bytes，合計從回收前的 228.9 MB 降到 172.9 MB。
- **有讀取者時截斷沒完成，但 exit 仍是 0**：`busy` 為 1，WAL 大小不變。opencode 等滿 `busy_timeout` 的 5 秒才回傳。`log` 與 `checkpointed` 相等，代表內容都已寫回主檔，只是檔案沒有截斷。所以判斷截斷是否完成，只能看輸出的 `busy`，不能看 exit code。
- **讀取者離開後重試就會成功**。只靠讀取連線關閉，WAL 不會變小。
- **反向自檢**：截斷沒有作用時，WAL 會維持在約 173 MB，就像有讀取者的那一列；判準（WAL bytes 與 `busy`）在成功和失敗時的數值不同。

## 結論

- 修法方向（AC-1）成立：`VACUUM` 之後以 `opencode db --format json "PRAGMA wal_checkpoint(TRUNCATE)"` 截斷，可以讓 WAL 縮回 0。
- 實作要解析輸出：是含一列的 JSON 陣列，欄位 `busy`、`log`、`checkpointed`。只有 `busy === 0` 才算截斷完成；`busy` 不為 0、輸出無法解析、exit 不為 0 或逾時，都是 AC-2 的「截斷沒完成」。
- 有讀取者時，這個命令最多會等 5 秒（opencode 連線的 `busy_timeout`），現有 opencode 命令的 60 秒逾時足夠。
- TBD-1：複本上 opencode 結束時不刪除 WAL，所以正式環境 WAL 一直維持在 173 MB 的現象不需要常駐連線來解釋。正式環境若真有常駐的讀取者，截斷會一直回傳 `busy`，AC-2 的 runtime issue 會把它顯示出來。
