# 審查報告
- 範圍：issue 0031（GitHub #31），分支 `fix/container-sigterm`，`BASE..HEAD` 共 1 個提交、8 個檔案：`docker-compose.yml`、`docker-compose.release.yml`、`package.json`、`src/main.ts`、`tests/docker/container-signals.test.ts`、`docs/runtime-boundary-and-security.md`、`CLAUDE.md`、`docs/issues/issue-0031/README.md`。風險 High：改的是容器 capability，也改變正式部署停止與升級時的行為。
- Reviewed BASE SHA：fea4b6059e259a4b619e6cbaa0f9bd91ff0adf44
- Reviewed HEAD SHA：fec9420049cedbc69b686195aeb5924d768569ef
- Reviewed patch-id：174a6aaf79ef99b01fb6b612efa3d4e8ee89a9aa（自行重算，與協調者提供的一致）
- 獨立 reviewer：Claude subagent（獨立審查 agent，不是實作者；全程只讀，2026-11-17）
- Review artifact：docs/issues/issue-0031/review-fec9420.md

## 問題與風險

**MUST FIX**：無。

**SHOULD FIX**
- S1 `docs/runtime-boundary-and-security.md:173`（`docs/issues/issue-0031/README.md:69` 也有同一句）：「容器裡以 root 執行的只有 init 與 entrypoint」這句不精確。
  - 正式 stage 沒有 `USER`，所以 compose 的 `healthcheck`（`node -e fetch(...)`）以 root 執行，`docker exec` 預設也是 root。實測 `docker exec` 的程序是 uid=0，`CapEff=0xeb`，包含 KILL。
  - 實際影響很小，理由有兩個：
    - 降權後的 node 程序 `CapEff=0`，node 對 PID 1 送訊號得到 `EPERM`，opencode 的 YOLO bash 拿不到 KILL。
    - 容器內的 root 本來就有 `SETUID`，可以先切成 node 再送訊號，KILL 幾乎沒有增加新能力。
  - 建議改寫：以 root 執行的有 init、entrypoint、healthcheck 與 `docker exec` 的預設 session，降權後的 node 程序有效 capability 為空；並補一句「root 本來就有 SETUID，KILL 的增量很小」。不影響行為，不阻擋 PASS。

**NICE TO HAVE**
- N1 `docs/runtime-boundary-and-security.md:179`：「v2.40.0 以前的映像」可能被讀成不含 v2.40.0。對照組證明 v2.40.0 本身就有這個問題，建議寫成「v2.40.0 及更早」。
- N2 `src/main.ts:432-433`：`process.on` 不是 `once`，這是既有寫法；runner 用的是 `once`。收到第二次訊號時 `shutdown` 會再跑一次，log 會多印一行，`scheduler.shutdown()` 與 `terminateAllChildren()` 也會重跑。實測連送兩次 SIGTERM 時 exit 0、3.04 秒結束，沒有提早切斷收尾。可以考慮加冪等旗標，非必要。
- N3：AC-2 的 3 秒上限（`src/main.ts:413`）沒有自動化回歸測試，拿掉 `Promise.race` 時 `npm run test` 仍然全綠。這符合 AC-2 核准的檢查方式（實際映像測試），我也用實際映像重現了紅燈與綠燈，所以只是揭露限制。
- N4（不在範圍內，既有行為）：runner 在執行中被停止時，被收掉的 opencode 會以 `run_done … degraded=timeout` 記入 audit，把「因關機中止」算成逾時。以前容器被直接殺掉，什麼紀錄都不會留下。
- N5（替代做法，供參考）：更窄的做法是把 tini 裝進映像，由 entrypoint 以 `gosu node tini -s -- …` 啟動並拿掉 `init: true`，讓 init 與主程序同一個 UID，就不需要 KILL。這要改映像、entrypoint 與 PID 1 的身分，改動比較大。KILL 的增量權限見 S1，接近零，所以現行做法是合理的最小改動。

## 已查核維度

### 驗收與證據

我用 `git archive fec9420 | docker build` 自建 `telenexus:issue31-review` 重跑實測，確認映像內容對應 HEAD：`package.json` 的 `start`、`start:runner` 以 `exec node …` 結尾，`dist/main.js` 有 `Promise.race([closing, limit])`。

所有容器都是 `--network none`、假 Token、`ALLOWED_USER_ID=424242`、`PANEL_ENABLED=false`，不掛主機目錄。caps 照 release compose 設定：`--init`、`no-new-privileges`、`cap-drop ALL`，加回 CHOWN、SETUID、SETGID、FOWNER、DAC_OVERRIDE、KILL。實作者的 `telenexus:issue31-check` 沒有 git SHA 標記，但 start 腳本與 race 程式碼相同；我的結論以自建映像為準。

- **AC-1（README 步驟 1）**：通過，可重現。
  - 分支映像：telenexus（映像預設的 `npm start`）exit 0，log 有 `[System] Shutting down gracefully...` 與 `[scheduler] INFO shutdown.started`；agent-runner（`node dist/runner.js`）exit 0，log 有 `[Runner] INFO shutdown signal=SIGTERM terminatedChildren=0`。兩者都約 0.05 秒結束。
  - 對照組 `ghcr.io/raybird/telenexus:v2.40.0`：兩個服務都是 exit 1，log 有 `[FATAL tini (1)] Unexpected error when forwarding signal: 'Operation not permitted'`。
  - 另外做了交叉對照，證明兩個修正缺一不可：v2.40.0 加上 KILL 後 telenexus exit 143，只有 exec、沒有 handler；分支映像拿掉 KILL 後 exit 1，出現 tini FATAL。
- **AC-2（步驟 2）**：通過，可重現。
  - 綠燈：容器內以 node 身分對 3030 送出不完整的請求標頭並保持連線，`docker stop` 在 3.04 秒內 exit 0，log 有關閉紀錄。
  - 紅燈：同一個映像在容器內用 sed 把 `return Promise.race(...)` 改成 `return closing;`（只改容器內的檔案），結果 exit 137、10.0 秒，log 只有關閉紀錄的開頭。這證明我建的卡住連線確實會讓 `server.close()` 一直等。
- **AC-3（步驟 3）**：通過。
  - `tests/docker/container-signals.test.ts` 有 8 支測試；跑它與 `compose-parity` 時基準是 9 支全過。
  - 變異測試，每次改完都複製回原檔並確認 `git diff --quiet`：
    - 開發 compose 共用設定拿掉 KILL → 2 支失敗
    - release compose 共用設定拿掉 KILL → 2 支失敗
    - 兩份 compose 同時拿掉 → 2 支失敗
    - `start` 拿掉 exec → 1 支失敗
    - `start:runner` 拿掉 exec → 1 支失敗
    - 只拿掉開發 compose 的 tunnel-manager KILL → 2 支失敗
    - agent-runner 改成 `npm run start:runner` → 2 支失敗
    - memoria 加上 KILL → 2 支失敗
    - telenexus 設 `init: false` → 2 支失敗
    - telenexus 自訂一份沒有 KILL 的 `cap_add` 覆蓋共用設定 → 2 支失敗
  - 實作者記錄的變異結果與我的一致。
- **AC-4（步驟 4）**：通過，附 S1、N1 兩個措辭建議。
  - `docs/runtime-boundary-and-security.md` 的 Tier 2 硬化（:173）與子程序回收（:179）兩節都說明了 KILL 的用途、範圍與 exec 的原因。
  - 模型面板一節（:251）已刪掉「telenexus 與 agent-runner 缺 KILL」的限制。
  - `CLAUDE.md:74` 已同步。
  - 用 grep 確認常青文件裡沒有「缺 KILL」「still lack」的說法。
  - 文件寫的是「已建立的正式容器要重建才會套用」，沒有宣稱正式部署已套用。
- **交付檢查**：`npm run build` exit 0；`npm run lint` exit 0；`npm run test` exit 0，`# tests 969`、`# pass 969`、`# fail 0`。`find tests -name '*.test.ts'` 有 105 個檔，比 BASE 多 1 個；961 加新增的 8 支等於 969，數字相稱（L-01）。
- **L-10**：`.env` 裡 `ALLOWED_USER_ID`（9 字元）與 `TELEGRAM_TOKEN`（46 字元）的實際值在 diff 中各出現 0 次，值只在命令內比對，沒有印出。diff 裡沒有 `/home/` 或帳號名，也沒有 bot token 格式的字串。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|---|---|---|---|
| `docker stop`，沒有連線 | 兩個服務都 exit 0、有關閉紀錄 | AC-1 實測，我重跑過 | 通過 |
| 停止時 Web Console 有卡住的連線 | 約 3 秒後 exit 0 | AC-2 紅燈與綠燈，我重跑過 | 通過 |
| 停止時 runner 正在執行 opencode，程序樹包含 opencode、browser-mcp-launcher、chrome-devtools-mcp | 收掉子程序後 exit 0 | 我實測：`terminatedChildren=1`，exit 0，3.04 秒（client 的 HTTP 連線還開著，由 runner 既有的 3 秒上限結束） | 通過；audit 記成 timeout，見 N4 |
| 停止時 telenexus 本機正有聊天或排程在跑 | 停排程、SIGTERM 子程序樹，最多 3 秒後 exit；剩下的子程序由 `exit` handler SIGKILL | 讀程式碼確認（`terminateAllChildren` 與 runner 是同一個函式）；沒有實際跑真的聊天（沒有網路與 Telegram） | 可接受。以前容器直接被殺，現在是更溫和的收尾；可能多送一則失敗回覆，屬殘餘風險 |
| 連續兩次 SIGTERM | 不提早結束、exit 0 | 我實測：`docker kill -s TERM` 送兩次，exit 0，3.04 秒，關閉 log 印兩次 | 通過，見 N2 |
| 主機上 `npm start` 按 Ctrl-C（整個 process group 收到 SIGINT） | node 執行 handler 後結束 | 我在容器內對 npm 的 process group 送 SIGINT 模擬：分支映像 exit 0，關閉 log 1 行；v2.40.0 是 exit 130 | 通過，比以前好 |
| `docker compose down`、`up -d --force-recreate` | 與 `docker stop` 相同：SIGTERM，10 秒寬限 | 機制與 `docker stop` 相同；`install.sh --upgrade` 會用 bundle 覆蓋 `docker-compose.yml`，KILL 會隨升級套用 | 通過。升級當下停掉的舊容器還沒有 KILL，第一次停止仍是舊行為（文件已寫要重建才套用） |
| 開發 overlay（`npm run dev`、`tsx watch`） | 不在範圍內（TBD-1） | 開發 overlay 繼承共用設定的 KILL，至少不會再出現 tini FATAL | 豁免，見 TBD-1 |
| memoria、memoria-ui | 不加 KILL（映像是 `USER node`） | 靜態測試，加上 `docker/memoria.Dockerfile` 的 `USER node` 斷言 | 通過 |
| tunnel-manager | 已經有自己的 KILL，這次只改註解 | 靜態測試 | 通過 |
| 降權後的程序是否拿到 KILL | node 程序 `CapEff=0` | 我實測：npm 與 node 都是 `CapEff=0000000000000000`；node 對 PID 1 送訊號得到 `EPERM` | 通過 |
| 處理器註冊前、sync-skills 執行中收到 SIGTERM | node 的預設終止，或 dash 自己結束；tini 隨 npm 結束 | 讀程式碼確認 | 可接受，與以前相同 |

### 需求、架構、安全、品質
- **需求**：根因判斷正確且完整。訊號路徑是 tini（root）→ entrypoint `exec gosu node` → `npm start` → `sh -c` → `exec node dist/main.js`。我從 `/proc` 確認，修好後 node 的父程序是 npm，中間不再有 sh。agent-runner 由 compose 直接執行 `node dist/runner.js`，只需要 KILL。KILL 加在 `x-common-config`，兩份 compose 同步。memoria、memoria-ui、tunnel-manager 與開發 overlay 都沒有漏改或改錯。
- **架構**：`closeServers()` 的 3 秒上限與 runner 一致。計時器有 `unref`，但 `server.close()` 卡住時代表還有 ref 的 socket，event loop 不會提早結束；`bootstrap()` 不是 top-level await，不會出現 exit 13。Panel server 用 `closeAllConnections()`，Node 22 的 `server.close()` 會關掉閒置的 keep-alive 連線，平常不會等滿 3 秒。`process.exit(0)` 的時機和以前一樣，都在伺服器關閉之後，只是多了上限。把 SIGINT、SIGTERM 合併成同一個 `shutdown` 是等價重構。
- **安全**：見 S1 與 N5。`no-new-privileges` 與其他 caps 不變；KILL 只作用在容器自己的 PID namespace 內。
- **品質**：沒有重複程式碼，也沒有過度設計。測試把 Dockerfile 最後一個 `CMD` 寫死為 `["npm", "start"]`，這是刻意記錄前提的寫法，可以接受。

### 豁免、待確認與限制
- Gate 豁免：不開 PR，改成本機獨立審查（Q3），本報告就是這次審查。
- TBD-1（開發 stack 的訊號傳遞）不在範圍內，非阻塞，維持原樣。
- 限制：
  - 沒有實際跑過 Telegram 聊天或排程進行中的停止，因為沒有網路與 Token。
  - Windows 主機的 npm 用 cmd.exe，不支援 `exec`，但專案沒有宣稱支援 Windows。
  - 正式部署（`~/Documents/RunTelenexus`）完全沒有碰，結束時 4 個容器仍持續運行。
- 我建的容器（`rv31-*`）與映像 `telenexus:issue31-review` 都已刪除。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
