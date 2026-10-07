# 步驟 8：端到端驗證

- **日期**：2026-10-07
- **對應**：SCN-001、SCN-002、SCN-003、SCN-006
- **映像**：以分支 `feat/issue-0012-chat-session-binding` 在 `f75fafc` 時建置的正式映像（`docker build`，Dockerfile 最後一個 stage；opencode 1.18.34）。
- **環境**：`docker run` 單一容器啟動 telenexus：暫存的 `data`／`workspace`／`ai-config.yaml`、不掛 named volume、不發佈 port，安全設定與 `docker-compose.yml` 相同。`CHAT_USE_RUNNER_PERCENT=0`，聊天在同一個容器內執行。`TELEGRAM_TOKEN` 是假值：Telegram 回 401，`bootstrap()` 只記錄錯誤，在那之前就已監聽的 Web Console 照常運作，不會與正式的 bot 搶 polling。Memoria 同步與召回都關閉。模型是 `opencode/big-pickle`。驗證完容器、映像與暫存目錄都已移除。
- **驅動方式**：在容器內以 Web Console 的 `POST /api/chat`（non-stream 路徑）與 `POST /api/chat/stream`（stream 路徑）送訊息。排程以 `opencode run --format json`（不帶接續參數）模擬，與排程任務在 opencode 層的行為相同：開一個新 session，成為「最後被更新的 session」。

## 順序與回覆

| # | 動作 | 路徑 | 回覆 |
|---|---|---|---|
| 1 | 「請記住代號 E2E-ALPHA。只回覆 OK」 | plain | `OK` |
| 2 | 模擬排程「只回覆 SCHEDULE-OK」 | opencode | `SCHEDULE-OK` |
| 3 | 「我先前要你記住的代號是什麼？…不知道就回覆 UNKNOWN」 | stream | `E2E-ALPHA` |
| 4 | `/new` | plain | 已建立新會話 |
| 5 | 「請記住代號 E2E-BETA。只回覆 OK」 | plain | `OK` |
| 6 | 「我剛才要你記住的代號是什麼？…」 | stream | `E2E-BETA` |
| 7 | 以 `opencode session delete` 刪除綁定的 session 後送「只回覆 RECOVERED」 | stream | `RECOVERED` |

變更前，第 3 步的 `-c` 會接到第 2 步的排程 session，答案會是 `UNKNOWN`。步驟 1 的乾淨環境對照組已證實這一點（[step1-session-flag-probe.md](./step1-session-flag-probe.md) 的 C 列）。

## opencode.db

第 6 步之後，每個 session 的使用者訊息：

| session | 建立時間 | 使用者訊息 |
|---|---|---|
| `ses_eebdc342…` | 10:14:12 | 第 1、3 步 |
| `ses_eebdc232…` | 10:14:17 | 第 2 步（模擬排程） |
| `ses_eebdc045…` | 10:14:24 | 第 5、6 步 |

此時綁定檔 `data/chat-session-state.json` 指向 `ses_eebdc045…`。

每則送出的 prompt（從 opencode.db 的 part 讀出）：

| 步驟 | session | 含「近期對話」 | 含記憶區塊 | prompt 長度 |
|---|---|---|---|---|
| 1 | `ses_eebdc342…`（新） | 是 | 是 | 905 |
| 3 | `ses_eebdc342…`（接續） | 否 | 否 | 242 |
| 5 | `ses_eebdc045…`（`/new` 後的新 session） | 是 | 是 | 1,104 |
| 6 | `ses_eebdc045…`（接續） | 否 | 否 | 242 |

第 7 步之後：`ses_eebdc045…` 已刪除；回合在新 session `ses_eebdb29d…` 執行並回覆，綁定檔改指向它；`events.jsonl` 有一筆 `runtime_issue`，scope 是 `chat-session:missing`，訊息為「bound session ses_eebdc045… not found; started a new session」。

## 結論

- **SCN-001**：模擬排程在兩則聊天之間開了新 session，第 3 步仍接續第 1 步的 session，答出先前的代號。排程 session 中沒有任何聊天訊息。
- **SCN-002**：`/new` 之後在新 session 執行，之後的聊天接續這個新 session。
- **SCN-003**：綁定的 session 被刪除後，回合照常回覆、改綁到新 session，並記一筆 runtime issue。使用者看不到「找不到 session」的訊息。
- **SCN-006**：接續的回合不含「近期對話」，開新 session 的回合含有。

反向自檢：如果聊天仍用 `-c`，第 3 步會落在排程 session（使用者訊息數會變成 2）並答 `UNKNOWN`；如果綁定沒有更新，第 6 步會接回 `ses_eebdc342…` 並答 `E2E-ALPHA`。兩者都與觀測結果不同，所以這些判準抓得到失敗。
