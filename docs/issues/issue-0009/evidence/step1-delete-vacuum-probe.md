# 步驟 1：在資料庫複本上驗證 opencode 的刪除與回收行為

- **日期**：2026-10-16
- **對應**：SCN-001、SCN-002、SCN-006；README 的 TBD-1、TBD-2
- **環境**：`ghcr.io/raybird/telenexus:v2.29.0`，opencode 1.18.34（與 `Dockerfile` 目前的釘版相同）。以 [step1-scripts/oc.sh](step1-scripts/oc.sh) 啟動拋棄式容器：只掛複本，不帶 auth、不發佈 port。免費模型 `opencode/big-pickle` 不需要 auth，所以可以實際執行 `opencode run`。
- **複本**：在正式部署的 agent-runner 容器內，以 better-sqlite3 的唯讀連線呼叫 `backup()` 取得一致的快照，再連同 `storage/` 複製到 repo 之外的暫存目錄。容器內的暫存檔取出後即刪除；正式部署只被讀取。複本在驗證後刪除。
- **紀錄範圍**：只記彙總數字，不記 session ID、標題、對話內容或本機路徑。腳本在 [step1-scripts/](step1-scripts/)。`contend.cjs` 與 `vacrace.cjs` 會在複本裡建立 `probe_tmp` 表，只用於製造寫入。

## 複本的基準

| 項目 | 數值 |
| --- | --- |
| 檔案大小 | 220,868,608 bytes（53,928 頁 × 4,096），WAL 模式，`auto_vacuum=0`，`freelist_count=0` |
| session | 3,754 個，其中 42 個是子 session；`/app` 3,692 個、`/app/workspace` 62 個，`project_id` 都是 `global` |
| 依最後更新時間 | 早於 30 天的 2,363 個，早於 90 天的 710 個 |
| 相關資料表 | message 19,101、part 66,942、event 44,063（`data` 約 45 MB）、event_sequence 787、todo 191；session_message、session_input、session_context_epoch、session_share、permission 都是 0 |
| `storage/session_diff/` | 2,898 個檔案，約 11.6 MB |

指向 session 的外鍵都是 `ON DELETE CASCADE`：message、todo、session_share、session_message、session_input、session_context_epoch 指向 session，part 指向 message，event 指向 event_sequence。event 以 `aggregate_id` 對應 session，但兩者之間沒有外鍵。

## 刪除的語意（SCN-001）

命令：`node /work/probe.cjs delete1 <id>`，記錄刪除前後該 session 的各表筆數與全庫總數的差異。

| 樣本 | 刪除前 | 刪除後 | 全庫差異 | 耗時 |
| --- | --- | --- | --- | --- |
| 90 天前、沒有子 session、有片段 | message 45、part 143、diff 檔 1 | 都是 0，diff 檔仍在 | session −1、message −45、part −143，其他表 0 | 863 ms |
| 1.18 期間建立、有 event | message 2、part 4、event 16、event_sequence 1 | 都是 0 | event −16、event_sequence −1 | 861 ms |
| 有 13 個子 session 的父 session | message 155、part 523、子 session 13 | 子 session 0 | session −14、message −201、part −669 | 918 ms |

- 被刪 session 的訊息、片段、事件與子 session 一併刪除，其他 session 的筆數不變（全庫差異只等於被刪的那些）。
- `storage/session_diff/<id>.json` 不會被刪。刪除數百個 session 後，孤立的 diff 檔有 335 個，合計約 1 KB；11.6 MB 幾乎都屬於仍存在的 session，所以不處理。
- 刪除後頁數不變，只有 `freelist_count` 增加，檔案不會自己縮小。
- 反向自檢：刪除沒有生效時，「刪除後」一欄不會是 0，全庫差異也會是 0，和上表不同。

## `session list` 與 `opencode db` 的輸出（SCN-001）

- `session list --format json` 只列頂層 session（子 session 不列）。不分目錄：從 `/app` 或 `/app/workspace` 執行，結果相同。排序依 `updated` 由新到舊；`updated`、`created` 與資料表的 `time_updated`、`time_created` 逐筆相等（100/100）。預設只回傳最新的 100 個，`-n` 可以放大。欄位：`id`、`title`、`directory`、`projectId`、`created`、`updated`。
- **輸出經 pipe 會被截斷，exit 仍是 0**。`-n 100000` 經 pipe 只拿到 196,608 bytes；由 node `spawn` 讀取時只拿到 163,840 bytes，JSON 都不完整。同一個命令在容器內重導到檔案，則每次都是完整的 808,437 bytes（3,710 筆）。`opencode db --format json` 也一樣：全部頂層 session 拿到 143,175 bytes、JSON 無效；加上 `limit 100` 時是 8,703 bytes、JSON 有效。`session list` 預設的 100 筆約 21.5 KB，經 pipe 完整。
- `session delete` 一次只接受一個 ID，給兩個會印出用法並失敗，兩個都沒刪。

## 刪除耗時（TBD-1）

| 情境 | 結果 |
| --- | --- |
| 連續刪除 100 個最舊的頂層 session | 79,791 ms，失敗 0；單次 p50 785 ms、p95 890 ms、最大 966 ms；連同子 session 共減少 108 個 |
| 連續刪除 30 個（兩次） | 23,605 ms 與 22,881 ms，失敗 0 |
| 連續刪除 60 個 | 47,278 ms，失敗 0 |

耗時幾乎都花在啟動 opencode 行程上，與 session 大小無關（有 13 個子 session 的樣本也只要 918 ms）。

## 有任務執行時刪除（SCN-005 的前提）

- 先開始連續刪除 60 個，3 秒後在另一個容器對同一份複本執行 `opencode run -m opencode/big-pickle --format json "Reply with exactly: OK"`。run 的時間窗（7.1 秒，含建立 session 與寫入訊息）完全落在刪除的時間窗（47.5 秒）內。結果：run exit 0、回覆 `OK`、stderr 為空；刪除 60 個、失敗 0。
- 第一次嘗試是在背景子殼執行 `opencode run`，結果 5 分鐘沒有任何輸出，也沒有建立 session。原因是背景的 stdin 沒有關閉，`opencode run` 會讀 stdin；改成 `</dev/null` 後 10 秒內就開始輸出。這是測試方式的問題，不是鎖定，該次結果已捨棄。實作時，呼叫 opencode 的子程序要把 stdin 設成 ignore。

## 空間回收（SCN-006、TBD-2）

- 經 `opencode db "VACUUM"` 執行可行，exit 0。在 freelist 為 10,757 頁時：檔案從 220,889,088 降到 168,755,200 bytes，含容器與行程啟動共 1,222 ms。在 freelist 為 512 頁時：頁數從 41,219 降到 40,691，freelist 歸零，含行程啟動共 1,093 ms。實際 VACUUM 不到 1 秒，其餘是啟動時間。
- 回收期間的其他連線（`vacrace.cjs`，每 20 ms 各試一次，共 50 輪）：
  - 唯讀查詢 50/50 成功。WAL 模式下讀取不受影響。
  - `busy_timeout=0` 的寫入 49 成功、1 次 `SQLITE_BUSY`。
  - `busy_timeout=5000` 的寫入 50/50 成功，最長等待 390 ms。
- opencode 自己的連線是 `busy_timeout=5000`、`synchronous=1`、`wal_autocheckpoint=1000`。回收期間的 opencode 寫入會等待，而不是失敗；另一次在回收後緊接執行的 `opencode run` 也正常回覆 `OK`。
- 回收期間會暫時多佔一份資料庫大小的磁碟空間（SQLite 的 VACUUM 機制），本次沒有實測磁碟峰值。

## 綁定 session 的接續（SCN-002）

- 取一個 129 天前更新、有 5 則訊息的頂層 session 模擬綁定（正式部署目前沒有 `data/chat-session-state.json`：升到 v2.29.0 之後還沒有聊天）。刪除它周圍 50 個早於 30 天的頂層 session，刪除後已經沒有比它更舊的頂層 session，失敗 0。
- `opencode run -s <綁定 id>` 的結果：exit 0，所有事件的 `sessionID` 都是綁定的 session；該 session 的訊息從 5 筆變 7 筆，全庫 session 數仍是 3,422，沒有新增。
- 對照組：對剛刪除的 session 執行 `opencode run -s`，exit 1、stdout 0 bytes，stderr 含 `Session not found`。這與 `src/core/opencode.ts` 的 `OPENCODE_SESSION_NOT_FOUND_PATTERN` 及 issue 0012 的實測一致。
- 反向自檢：如果綁定的 session 被刪，接續會得到上面對照組的結果；如果 `-s` 沒有接續，事件的 `sessionID` 會不同，session 數也會增加。兩者都和實際觀察不同。

## 子 session 的時間

19 個子 session 裡有 4 個的 `time_updated` 晚於父 session，最多晚 56 秒，而且沒有孫 session。以父 session 的更新時間判斷是否過期，誤差遠小於保留期。

## 結論

- **TBD-1**：每小時執行一次，每次最多刪 100 個頂層 session，最舊的優先。這樣每次約 80 秒；以 10-16 正式部署的量（早於 30 天約 2,300 個），積壓約一天清完。之後每小時的新增量只有個位數，負擔可以忽略。候選以 `opencode db --format json` 的 `SELECT … ORDER BY time_updated LIMIT 100` 取得，只讀不寫。輸出必須能完整解析為 JSON，解析失敗就當作清理失敗，不能用部分結果去刪。不使用 `session list`：它由新到舊排序，要取得最舊的就得列出全部，而輸出會被截斷。
- **TBD-2**：以 `opencode db "VACUUM"` 回收。條件是沒有 opencode 任務在執行、`freelist_count` 達到 `page_count` 的 20% 以上，而且當天還沒回收過。20% 是本次刪除約 380 個 session 後的比例（10,757／53,928），代表約 40 MB 可回收。平時刪除空出的頁面會被重複使用，所以通常只有首次清理完積壓後才會觸發。`page_count` 與 `freelist_count` 經 `opencode db "pragma …"` 讀取。
- 已確認的實作限制：只選頂層 session（子 session 會連帶刪除）；`storage/session_diff/` 不處理；呼叫 opencode 時 stdin 設為 ignore；`session delete` 每次只能刪一個。
