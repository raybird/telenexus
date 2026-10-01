# 步驟 5：以升版後的映像做真實呼叫

- 執行日期：2026-10-01（UTC 07:52 至 07:58）
- 被測提交：`984c5b0`（`docker build -t telenexus-issue0008:984c5b0 .`，預設 target，也就是正式 stage）
- 驗收編號：SCN-006；對照組同時是 SCN-001 與 SCN-003 在真實上游上的觀察
- 使用者於 2026-10-01 同意以隔離方式執行（「同意，隔離執行」）

## 方法

以 [step5-run-runner.sh](./step5-run-runner.sh) 用 `docker run` 只啟動 agent-runner：獨立容器名、不發佈 port、沒有 Telegram token、`data`／`workspace`／`ai-config.yaml` 掛到暫存目錄、不掛任何 named volume。安全設定（`no-new-privileges`、`cap_drop: ALL` 加五個 capability、`PUID`／`PGID`）與 `docker-compose.yml` 相同。正式部署的容器與資料卷全程沒有被碰到。模型是免費層的 `opencode/big-pickle`。

請求一律在容器內發出：

```bash
docker exec <容器> sh -c 'curl -s -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" -H "x-runner-token: $RUNNER_SHARED_SECRET" \
  -d "{\"task\":\"chat\",\"input\":\"Reply with exactly: PONG-0008\"}"'
```

對照組是同一個映像再加一層 `RUN npm install -g opencode-ai@1.15.10`：TeleNexus 的程式完全相同，只有 opencode 換回舊版。

驗證後三個容器與兩個映像都已移除。

## 判準與反向自檢

通過的判準：`/run` 的回覆是模型產出的文字、`structured.failure` 不存在、事件裡有 `text` 且 `opencode_done` 的 `upstreamError` 為 `false`。

呼叫失敗時這個判準不會是綠的：對照組以同樣的方式打同一個端點，得到的是 `failure.kind = upstream-error`、`statusCode = 426`、沒有任何 `text` 事件、`upstreamError: true`。兩組的差別只有 opencode 的版本。

## 結果

| 項目                              | 新映像（opencode 1.18.34）                      | 對照組（opencode 1.15.10）                                                                                                                         |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 映像內 `opencode --version`       | `1.18.34`                                       | `1.15.10`                                                                                                                                          |
| `/health`                         | 啟動 2 秒後 200                                 | 200                                                                                                                                                |
| `/run` 的 `output`                | `PONG-0008`（另兩次：`B1`、`B2`）               | `⚠️ 上游拒絕了這次請求 (HTTP 426)：opencode 版本過舊，需要升級 opencode …`                                                                         |
| `structured.failure`              | 無                                              | `{ kind: 'upstream-error', statusCode: 426, message: 'Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier' }` |
| 事件型別                          | `step_start` 1、`text` 1、`step_finish` 1       | 沒有可渲染的事件（stdout 只有一個 `error` 事件）                                                                                                   |
| `events.jsonl` 的 `opencode_done` | `outputLen: 919`～`929`、`upstreamError: false` | `outputLen: 736`、`upstreamError: true`、`statusCode: 426`                                                                                         |
| `runner-audit.log`                | `ok: true`                                      | `ok: false`、`failureKind: "upstream-error"`                                                                                                       |
| `runner-status.md`                | 3 次請求、Success Rate 100.0%                   | 3 次請求、Success Rate 0.0%                                                                                                                        |
| runtime issue                     | 無                                              | `opencode:upstream-error:426`、`model-health:client-outdated`                                                                                      |
| `model-health-state.runner.json`  | `healthy`                                       | `failing`，簽章 `client-outdated:426:160781252`                                                                                                    |

對照組的 `outputLen: 736` 就是事故期間 `events.jsonl` 每一筆的指紋。同樣的輸出，在 v2.27.3 被記成 `ok: true`、成功率 100%、健康檢查 `healthy`；在這個提交上是右欄的結果。

runner 在 `data/` 與 `workspace/context/` 寫出的檔案屬於主機上的使用者帳號，entrypoint 的 `PUID`／`PGID` 對齊在新映像上照常生效。

## 觀察到但不屬於本 issue 的行為

第一次對新映像發請求時，容器才啟動約 1 秒，啟動時的健康探針還在執行。那次 `/run` 的回覆是 `OKOKOKOK`：探針與 `/run` 落在同一個 opencode session，兩個 opencode 行程同時推進它，產生了多則助理訊息。等探針結束後再發的請求都只有一則回覆，上表用的是這些。

追查的結果：

- agent-runner 經 `/run` 建立的 session，在 opencode 的資料庫裡 `directory` 是 `/app`，與健康探針建立的 session 相同，儘管 runner 是以 `cwd=/app/workspace` 啟動 opencode。
- 因此 `/run` 的 `-c`（接續上一個 session）會接到最近一次探針的 session：實驗中先跑一次探針、再打 `/run`，`/run` 用的就是探針剛建立的 session。
- **新舊兩個映像的行為相同**（對照組：探針的 session 之後，`/run` 的 error 事件帶的是同一個 `sessionID`；再跑一次探針，下一次 `/run` 就換到新的那個）。所以這不是升版造成的，升版也沒有改變它。

它的影響是：每次健康探針實際執行之後，下一則聊天會接在探針的 session 上，而不是原本的對話；探針與聊天恰好同時進行時，會像上面那樣互相干擾。探針在一小時內有真實成功流量時會被豁免，所以平常不容易遇到。成因（為什麼 `cwd=/app/workspace` 的行程會把 session 記在 `/app`）沒有查明：在主機上以同樣的目錄結構手動執行 opencode 時，兩個目錄的 session 是分開的。這需要另外開 issue 處理。
