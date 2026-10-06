# 步驟 1：opencode 1.18.34 的 `-s` 行為

- **日期**：2026-10-06
- **對應**：SCN-001、SCN-002、SCN-003；TBD-1
- **環境**：`ghcr.io/raybird/telenexus:v2.28.0`（opencode 1.18.34），以 issue 0008 的 [step5-run-runner.sh](../../issue-0008/evidence/step5-run-runner.sh) 隔離啟動 agent-runner：暫存目錄、不掛 named volume、不發佈 port、不帶 Telegram token。正式部署全程沒有被碰到。驗證完容器已移除。
- **模型**：`opencode/big-pickle`（與正式部署相同）
- **執行方式**：[step1-run.sh](./step1-run.sh)，在容器內以 `node` 身分（runner 的實際身分）、`/app/workspace` 為 cwd 執行 `opencode run --format json --model opencode/big-pickle <參數> <prompt>`。

## 結果

依執行順序。session id 是這個一次性容器產生的，容器已刪除。

| 標籤 | 參數 | prompt | exit | 事件的 sessionID | 回覆 |
|---|---|---|---|---|---|
| A | （無） | 請記住代號 ALPHA-12。只回覆 OK | 0 | `ses_eefab1ab…`（新，下稱 S1） | `OK` |
| B | （無） | 只回覆 OK2 | 0 | `ses_eefab09b…`（新，下稱 S2） | `OK2` |
| C（對照） | `-c` | 我先前要你記住的代號是什麼？… | 0 | S2 | `UNKNOWN` |
| D | `-s S1` | 同 C | 0 | S1 | `ALPHA-12` |
| E | `-s ses_doesnotexist…` | 只回覆 OK3 | 1 | （stdout 0 行） | stderr：`Error: Session not found` |
| — | `opencode session delete S2` | | 0 | | `Session … deleted` |
| F | `-s S2`（已刪除） | 只回覆 OK4 | 1 | （stdout 0 行） | stderr：`Error: Session not found` |
| F2 | `-s ses_doesnotexist…` 加 `--print-logs --log-level ERROR` | 只回覆 OK5 | 1 | （stdout 0 行） | stderr：`Error: Session not found` |
| G、H 並行 | G：（無）；H：`-s S1`，G 啟動 1 秒後執行 | G：三句話介紹台北；H：再說一次代號… | 0、0 | G：新 session；H：S1 | G：正常回覆；H：`ALPHA-12-AGAIN` |

stderr 原文含 ANSI 色碼：`\e[91m\e[1mError: \e[0mSession not found`。不存在的 session 失敗得很快：同一指令以 `/usr/bin/time` 量得 0.90 秒，沒有送出上游請求。

並行前後各 session 的使用者訊息數（`opencode db` 查詢）：

| session | 前 | 後 |
|---|---|---|
| S1 | 2 | 3 |
| G 的新 session | — | 1 |
| 容器啟動時的另一個 session（標題 "Prompt testing with exact reply"，即 runner 啟動時的模型健康探針） | 1 | 1 |

## 結論

1. **`-c` 接的是最後被更新的 session**（C）：剛建立的 S2 搶走了接續，模型答不出 S1 的代號。這在乾淨環境重現了正式環境的問題。
2. **`-s <id>` 接續指定的 session，並帶入它的歷史**（D）：所有事件的 `sessionID` 都等於指定的 id，回覆引用了 S1 先前的內容。
3. **`-s` 不受並行影響**（G、H）：另一個 session 同時建立並在 H 之後才結束，H 仍落在 S1，只有 S1 的使用者訊息數加一。
4. **TBD-1：session 不存在時**（E、F、F2），不論從未存在或已被 `session delete` 刪除，行為都一樣：exit code 1、stdout 沒有任何事件、stderr 為 `Error: Session not found`，不到一秒就失敗。不會靜默開新 session，也不會卡住。所以 SCN-003 的偵測條件是：**exit code 非 0、沒有解析到任何事件、stderr（去除 ANSI 色碼後）含 `Session not found`**。實際送出的參數一律帶 `--print-logs --log-level ERROR`，F2 確認這組參數不改變這個 stderr。
5. **第一個事件（`step_start`）就帶有 `sessionID`**，所以回合中途失敗時，也能取得新 session 的 id 來更新綁定。
6. runner 啟動時的健康探針也會在同一個 opencode 資料庫建立 session，又多了一個會搶走 `-c` 的來源。
