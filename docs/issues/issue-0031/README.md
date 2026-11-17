# Issue 0031 - telenexus／agent-runner 停止時收不到 SIGTERM，優雅關閉從未執行 (Small)

GitHub：[#31](https://github.com/raybird/telenexus/issues/31)

## 概述

`telenexus` 與 `agent-runner` 在 `docker stop`、升級時的 `docker compose up -d --force-recreate`、`docker compose down` 時，主程序都收不到 SIGTERM，`src/main.ts` 與 `src/runner.ts` 的關閉流程從來沒有執行：排程停止、`terminateAllChildren()` 收掉 detached 的 opencode／Chrome 子程序樹、關閉 Web Console 與面板伺服器。2026-11-17 在 #30 實作 tunnel-manager 時發現。

2026-11-17 規劃時用 `ghcr.io/raybird/telenexus:v2.40.0` 實測（`--network none`、套用與 compose 相同的 caps、`docker stop -t 5`），找到兩層原因：

| 主程序 | 現行 caps | 加上 `KILL` |
|---|---|---|
| 直接執行 `node`（agent-runner 的 `command: node dist/runner.js`、tunnel-manager） | exit 1，`[FATAL tini (1)] Unexpected error when forwarding signal: 'Operation not permitted'` | exit 0，handler 執行完 |
| 映像預設的 `npm start` → `sh -c "node scripts/sync-skills.mjs && node dist/main.js"`（telenexus） | exit 1，同上 | **exit 143，handler 沒有執行** |
| 同上，但 start 腳本最後一段改成 `exec node …` | — | exit 0；handler 延遲 4 秒時 npm 也會等它跑完（`docker stop -t 10` 花 4.0 秒） |
| 不經 npm，`sh -c '… && exec node …'` | — | exit 0 |

1. **缺 `CAP_KILL`**：兩個服務都設 `init: true`，PID 1 是以 root 執行的 tini；主程序由 entrypoint 以 `gosu node` 降成非 root。root 送訊號給不同 UID 的程序需要 `CAP_KILL`，compose 共用設定 `cap_drop: ALL` 後只加回 `CHOWN`、`SETUID`、`SETGID`、`FOWNER`、`DAC_OVERRIDE`。tini 轉送失敗就直接結束，容器內所有程序隨即被殺。
2. **telenexus 的訊號停在 dash**：就算補上 `KILL`，npm 會把 SIGTERM 轉給 `sh -c`，dash（`/bin/sh`，0.5.12）收到後自己結束，不會轉給正在執行的 `node dist/main.js`。

更正 GitHub #31 內文的一句：`memoria` 其實也設了 `init: true`，但它的映像是 `USER node`，tini 本身就以 node 執行，送訊號給同一個 UID 不需要 `KILL`，所以不受影響（`memoria-ui` 用同一個映像）。

另外，telenexus 關閉 Web Console 與面板伺服器的 `closeServers()` 沒有時間上限（runner 有 3 秒）。修好之後 handler 真的會執行，有連線卡住時，每次停止都會等滿 Docker 的 10 秒寬限再被 SIGKILL。

**不在範圍內**：
- 開發 stack（`docker-compose.dev.yml` 的 `npm run dev`／`tsx watch`）的訊號傳遞，見 TBD-1。
- 關閉流程本身做什麼（例如停止時把面板選單還原）；這次只讓既有的 handler 真的執行，並給伺服器關閉加上限。
- 升級正式部署：修好後要重建容器才生效，時機由使用者決定。

## 現況

| 外部狀態 | 查證命令 | 上次結果 | 查證日期 |
|---|---|---|---|
| GitHub issue #31 | `gh issue view 31 --repo raybird/telenexus --json state -q .state` | OPEN | 2026-11-17 |

## 涉及檔案

- `docker-compose.yml`、`docker-compose.release.yml` - 共用設定 `x-common-config` 的 `cap_add` 加 `KILL`，兩份同步
- `package.json` - `start`、`start:runner` 的最後一段改用 `exec node …`
- `src/main.ts` - SIGTERM／SIGINT 的 `closeServers()` 加 3 秒上限
- `tests/docker/` - KILL 與 `exec` 的靜態守門
- `docs/runtime-boundary-and-security.md`（Tier 2 硬化、子程序回收、模型面板一節的已知限制）、`CLAUDE.md`（tunnel-manager 段落）- 改成修好後的現況

## 驗收條件

以下的「分支映像」指從本 issue 分支以 `Dockerfile` 預設 target 建出的映像（與 release.yml 相同，production stage）；「compose 的 caps」指 `docker-compose.release.yml` 共用設定的 `security_opt`、`cap_drop`、`cap_add`，連同 `init: true`。容器一律 `--network none`，用假的 `TELEGRAM_TOKEN` 與合成的 `ALLOWED_USER_ID`，資料指到暫存目錄，不碰正式部署。

1. **AC-1（最大風險）**：分支映像以 compose 的 caps 啟動 telenexus（映像預設命令）與 agent-runner（`node dist/runner.js`），`docker stop`（預設 10 秒寬限）後兩者都在寬限內以 exit 0 結束，log 有各自的關閉紀錄：telenexus 是 `[System] Shutting down gracefully...`，agent-runner 是 `shutdown` 事件。— 檢查方式：`docker run`／`docker stop` 的命令、耗時、exit code 與 log 尾段記入完成證據。
   - 失敗路徑：出現 `[FATAL tini (1)]`、exit 1／143／137，或沒有關閉紀錄，都判定失敗。對照組：同樣步驟改用 `ghcr.io/raybird/telenexus:v2.40.0`，必須重現 exit 1 與 tini 的 FATAL 訊息，證明這個檢查分得出修好與沒修好。
2. **AC-2**：telenexus 停止時若有一條卡住的 Web Console 連線（例如送出不完整的請求標頭後不關閉），`docker stop` 仍在約 3 秒的上限後以 exit 0 結束，log 有關閉紀錄。— 檢查方式：同 AC-1 的分支映像，停止前開一條卡住的連線，記錄耗時與 exit code。
   - 失敗路徑：等滿寬限被 SIGKILL（exit 137、耗時約 10 秒）判定失敗。實作前先以「只修好訊號傳遞、還沒加上限」的狀態取得這個紅燈。
3. **AC-3**：靜態守門。兩份 compose 的 telenexus、agent-runner、tunnel-manager 最終的 `cap_add` 都含 `KILL`，且兩份一致（`compose-parity`）；`package.json` 的 `start`、`start:runner` 最後一段是 `exec node dist/main.js`／`exec node dist/runner.js`。memoria、memoria-ui 不加 `KILL`。拿掉任一項，測試會失敗。— 檢查方式：`tests/docker/` 的測試，加上逐項拿掉的變異檢查。
   - 失敗路徑：共用設定少了 `KILL`、只改一份 compose，或 start 腳本拿掉 `exec`，測試都要失敗。
4. **AC-4**：常青文件反映修好後的現況：`docs/runtime-boundary-and-security.md` 的 Tier 2 硬化與子程序回收兩節說明 `KILL` 的用途與範圍，模型面板一節刪掉「telenexus 與 agent-runner 缺 KILL」的已知限制；`CLAUDE.md` 的 tunnel-manager 段落同步。不宣稱正式部署已套用。— 檢查方式：`grep -rn "KILL" docs/runtime-boundary-and-security.md CLAUDE.md` 與審查。
   - 失敗路徑：文件仍寫兩個服務缺 `KILL`、收不到 SIGTERM，或宣稱正式部署已生效。

- **核准日期**: 2026-11-17
- **核准來源**: 規劃依據：使用者 2026-11-17 在本對話以 AskUserQuestion 回答 Q1「start 腳本最後加 exec」、Q2「加 3 秒上限」、Q3「分支＋本機獨立審查」（都是建議答案）。使用者同日對 AC-1～AC-4 草案（含 TBD-1 不在範圍內、風險 High）回答「照草案核准」。
- **核准 commit**: 待提交

## 風險與首要驗證

- **最大風險**：修好後才第一次真的執行的關閉流程，在容器裡跑不完或卡住，讓每次停止與升級都變成等滿寬限再被 SIGKILL，或在正式映像裡根本收不到訊號（規劃時已發現只加 `KILL` 對 telenexus 無效）。
- **風險等級與理由**：High。這次改的是容器的 Linux capability（權限面），而且會改變正式部署每次停止、升級時的行為；這段關閉流程在容器裡從來沒有執行過。
- **首要驗證**：第一步就以分支映像跑 AC-1 的實測，配 v2.40.0 的對照組，確認真的 `dist/main.js`、`dist/runner.js` 收到訊號並在寬限內 exit 0，之後才寫靜態守門與文件。
- **選擇理由**：問題出在映像、caps、npm、dash、tini 的組合。靜態測試只能確認設定字串存在，規劃時的實測正好證明「設定看起來對」（加了 `KILL`）仍可能沒用；只有實際的映像與真的進入點能證明訊號送得到。
- **完成證據**：AC-1 修好與對照組的兩組結果（exit code、耗時、log），以及 AC-2 加上限前的紅燈與加上限後的綠燈。

`KILL` 讓容器內以 root 執行的程序（只有 tini 與 entrypoint）可以送訊號給同一個容器內其他 UID 的程序，範圍限於容器的 PID namespace；`no-new-privileges` 與其他 caps 不變。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | 開發 stack 用 `npm run dev`（`tsx watch`），訊號經 npm、tsx 才到 node，這次沒有實測 | 不在範圍內，非阻塞 | 不影響 AC-1～AC-4；共用設定加了 `KILL` 後，dev 容器至少不會再出現 tini 的 FATAL |

## 實作與驗證步驟

1. 📝 **AC-1：分支映像實測訊號傳遞（首要驗證）** — 產出：`KILL` 加進兩份 compose 的共用設定，`start`、`start:runner` 改用 `exec`，建出分支映像，跑 AC-1 的修好組與 v2.40.0 對照組。相依：無。完成判準：兩個服務在寬限內 exit 0、有關閉紀錄；對照組重現 exit 1 與 tini FATAL。
2. 📝 **AC-2：關閉伺服器加 3 秒上限** — 產出：先以步驟 1 的映像加一條卡住的連線取得紅燈（約 10 秒、exit 137），再在 `src/main.ts` 的 `closeServers()` 加上限、重建映像取得綠燈。相依：步驟 1。完成判準：AC-2 的紅燈與綠燈都記入證據。
3. 📝 **AC-3：靜態守門** — 產出：`tests/docker/` 的 KILL 與 `exec` 斷言；逐項拿掉的變異檢查。相依：步驟 1。完成判準：變異各自失敗、還原後全綠。
4. 📝 **AC-4 與交付檢查** — 產出：更新 `docs/runtime-boundary-and-security.md`、`CLAUDE.md`；`npm run build`、`npm run test`（核對 `# tests`，地雷 L-01）、`npm run lint` 都 exit 0。相依：步驟 1～3。完成判準：文件 grep 與三項檢查通過。

## Gate 豁免紀錄

- **不開 PR**（2026-11-17，Q3「分支＋本機獨立審查」）：在分支實作，由獨立 subagent 在本機審查 `main..HEAD`，PASS 後由使用者決定合併、發版與升級正式部署。

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-11-17 | 建立 GitHub issue #31（#30 實作時發現） | 使用者 |
| 2026-11-17 | 建立 issue 文件；實測發現 telenexus 只加 `KILL` 無效（訊號停在 dash），Q1～Q3 照建議答案決定；AC-1～AC-4 照草案核准；交付方式：分支＋本機獨立審查 | 使用者 |

---
**建立日期**: 2026-11-17  
**分級**: Small — 一項 compose 設定、一行啟動腳本與一處關閉上限，其餘是測試與文件；邏輯直觀，不需要計畫檔  
**風險**: High — 改容器 capability，且改變正式部署停止與升級時的行為\
**狀態**: 待實作
