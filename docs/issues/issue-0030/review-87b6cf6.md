# 審查報告
- 範圍：完整分支 diff `main..feat/telegram-model-panel`（43 個檔案、+4834/−168、11 個提交；Large／High）。本機獨立審查，依 README `## Gate 豁免紀錄` 不開 PR。
- Reviewed BASE SHA：2d23d1995831c820b6a7088f6654cb201e11de54
- Reviewed HEAD SHA：87b6cf6038d70e785f44702e2ec3fa95f6fb94e2
- Reviewed patch-id：daaaf308f00928b4ae83e4bde4268a29c8591257（已用 `git diff BASE HEAD | git patch-id --stable` 重算，結果相同）
- 獨立 reviewer：Claude（Opus 5.5）的隔離 subagent，沒有參與實作。全程唯讀，只做暫時突變並逐一還原。
- Review artifact：docs/issues/issue-0030/review-87b6cf6.md

## 問題與風險

### MUST FIX

**M1. `/panel` 的「只限私聊」檢查對非 Telegram 訊息放行。Web Console 的 `/api/chat` 可以開 Tunnel，未授權時也行。** `需決策`
- 位置：`src/core/command-router.ts:54-60`。條件 `if (msg.telegram && msg.telegram.chatType !== 'private')` 只擋「非私聊的 Telegram 訊息」，沒有 `msg.telegram` 的訊息會直接通過私聊檢查。
- 呼叫路徑：Web Console 的 `/api/chat`（`src/web/server.ts:1874` 起）與 `/api/chat/stream` 建立的 `UnifiedMessage` 沒有 `telegram`。它的 `sender.id` 是 `WEB_USER_ID`，沒設時就是 `ALLOWED_USER_ID`（`src/main.ts:236`）。訊息經 `runCommandPreflight` 進到 `CommandRouter`，管理員檢查也會通過。
- 實證：在 scratchpad 寫了一支測試，送出 `platform: 'console'`、沒有 `telegram` 的 `/panel`。結果 `calls=["open"]`，回覆是「模型設定面板已開啟」。
- 影響：
  - Compose 預設 `WEB_AUTH_TOKEN` 空白，`isAuthorized()` 會放行（`src/web/server.ts:227`）；開啟 `WEB_TRUST_PRIVATE_NETWORK` 時，`X-Forwarded-For` 也可偽造。這兩種情況下，連得到主機 3030 的人都能開一個公開的 Quick Tunnel，並改掉管理員私聊的選單按鈕。
  - 這違反 SCN-002「不啟動未授權 Tunnel」與 Task 3.2 的完成判準「非私聊或非白名單不啟動 Tunnel」。
  - 也和常青文件的說法相反：`docs/runtime-boundary-and-security.md:224`「只有在私聊由管理員輸入 `/panel` 才會開 Tunnel」、`README.md:149`、`docs/configuration-reference.md:81`。
  - 實際傷害有限：開出來的面板仍要 Bot Token 簽的 initData 才能登入；而且能用 Web Console 的人本來就能 `/set_model`。但授權規則的實作與核准規格、安全文件不一致，所以列 MUST FIX。
- 現有覆蓋：`tests/command-router-panel.test.ts:105-116` 只測了 supergroup 與非管理員。所有 `makeMsg` 都帶 `telegram`、`platform: 'telegram'`，測不到這條路徑。
- 建議：把條件改成要求 `msg.sender.platform === 'telegram' && msg.telegram?.chatType === 'private'`，並補一支 console 形狀訊息的負向測試（scratchpad 那支可以直接改寫進 repo）。
- 待決問題：Web Console 算不算可以開面板的管理入口？
  - (a) 照核准規格只允許 Telegram 私聊（建議）：一行修正加一支測試。
  - (b) 允許 Web Console 開啟：要修訂 SCN-002 與 Task 3.2 的判準並重新核准，三份常青文件也要改，而且等於接受「Web Console 沒有 token 時，任何人都能開 Tunnel」。

### SHOULD FIX

**S1. Task 3.1 把「健康檢查後不檢查 attempt」判為等價變異，這個判定不成立。**
- 位置：`docs/issues/issue-0030/implementation-plan.md:162`、`src/tunnel/tunnel-manager.ts:107`。
- 理由：`stop()` 送出 SIGTERM 後要等子程序結束，最多 3 秒才 SIGKILL。真的 cloudflared 收到 SIGTERM 有收尾期，健康檢查可能在這段時間先回 true。這時 `exited` 還是 false，如果拿掉 attempt 檢查，狀態會在停止之後變成 `ready`。
- 實證：在 scratchpad 寫了一支測試，假 cloudflared `trap` SIGTERM 後延遲 1 秒才退出，並在 stop 期間讓健康檢查回 true。原程式通過；拿掉 `:107` 的檢查後 `# fail 1`。現有 `tests/tunnel/tunnel-manager.test.ts:188-224` 在子程序已結束後才 release，所以抓不到。
- 產品程式碼本身正確（檢查還在），實作者也有主動揭露，所以不算假綠燈。問題在證據說明有誤，「停止中的 start」也缺少真正的回歸守門。
- 建議：把這種情境（子程序延遲結束）補進 `tests/tunnel/tunnel-manager.test.ts`，並更正計畫裡的等價說法。

### NICE TO HAVE

- **N1. 開啟與關閉的競態。** `src/services/panel-controller.ts:96-111`：`await menu.show()` 期間收到 `/panel_close`，`show` 回來後仍會設 `published`。結果最多 30 秒內狀態指向已停止的 Tunnel，之後 `poll()` 會發出不實的「Tunnel 已中斷」通知。可以在 `show` 前後比對一個開啟序號，或在 close 時作廢進行中的 open。
- **N2. 沿用入口時不重設選單。** `panel-controller.ts:90-92` 的 reuse 路徑只 `touch()`。如果選單按鈕被別處重設（例如啟動時 `boot()` 與第一個 `/panel` 交錯），使用者會被告知「入口仍然有效」，選單卻是預設。reuse 時重送一次 `show`（冪等）比較穩。
- **N3. `poll()` 在 await 之後的重新檢查沒有測試守門。** `panel-controller.ts:163` 拿掉後 16 支測試照樣全過。少了它，關閉與輪詢交錯時，`this.published.generation` 會丟 TypeError，最後記成 `panel:timer`。
- **N4. 靜態檔路徑穿越測試沒有打到白名單 regex。** `tests/web/panel-api.test.ts:263-271` 的 `../panel-server.ts` 會先被 fetch 正規化；`%2e%2e/panel-auth.ts` 的副檔名本來就不在白名單內。把 `STATIC_FILE` 放寬成允許 `.`、`/`、`%`，測試仍然全綠。實際防護來自 WHATWG URL 的正規化與不解碼，目前沒有漏洞，屬於證據持久力的問題。可以補一個 `.js`／`.html` 結尾、含 `%2f` 的案例。
- **N5. body 上限測試同時接受 400。** `tests/web/panel-server.test.ts:87` 接受 413 或 400，可以收斂成 413。
- **N6. 登入失敗回傳 `reason`。** `src/web/panel-server.ts:148` 對未登入的請求回 `not-configured`、`expired` 等原因。`not-allowed` 要先有正確簽章才會出現，不構成破解線索，但 `not-configured` 會洩露設定狀態。公開面可以只回 `unauthorized`，原因改記在 log。
- **N7. 未文件化的 `/panel-api/session` 路由。** `panel-server.ts:192-198` 有 `session`（回傳 userId），前端沒用到，只供測試。安全文件列出的路由清單沒有它，建議刪掉或寫進文件。
- **N8. 小型重複。** `src/tunnel-manager.ts:222,228` 寫死了 `/panel/health` 與 `'telenexus-panel'`，`panel-server.ts` 已經 export `HEALTH_PATH`。`panel-controller.ts:47` 的 `PANEL_PATH` 與 `panel-server.ts:53` 的 `PANEL_PREFIX` 是同一個值。目前還沒有分歧。
- **N9. URL 樣式可能抓到錯誤訊息裡的網址。** `src/tunnel/tunnel-manager.ts:33` 的 `URL_PATTERN` 也會符合 `https://api.trycloudflare.com`。cloudflared 申請 Quick Tunnel 失敗時的錯誤訊息可能含這個網址（推測，未實測）。健康檢查會擋下，不會發布錯誤網址，但回報的原因會變成「健康檢查期間結束」，而不是「取得網址前結束」。可以排除 `api.` 子網域。
- **N10. 文件小落差。**
  - `docs/configuration-reference.md:101` 寫「`PANEL_*` 寫在 `.env`」，但 `PANEL_BIND`、`PANEL_PORT` 被 compose 的 `environment:` 寫死，`.env` 蓋不過去。同一節表格寫的「compose 固定」才是對的。
  - issue README 的 `:14`「尚未實作」與 `:122`「上述均尚未執行」已經過時（Task 5.2 已執行）。

## 已查核維度

- **驗收與證據**（責任對照見 `implementation-plan.md:375-388`）：
  - SCN-001（Task 3.2，支援 3.1、5.1、5.2）：tunnel-manager 不存在、拒絕、逾時、選單設定失敗都不發布入口；並行開啟共用；端對端用真的 `TunnelManager` 搭假 cloudflared。成立，但 M1 是這個 Scenario 前提「允許的管理員」的缺口。
  - SCN-002（Task 1.2，支援 1.1、5.2）：
    - initData 的 HMAC 字面值已用 Python `hmac` 獨立重算，`PLAIN` 與 `WITH_SIG_INCLUDED` 兩組都相符，不是同義反覆。
    - 既有 Web Console 路徑在面板連接埠上都是 404，與兩個 WEB_* 設定的組合無關；舊憑證會失效；內網、XFF、Host 都繞不過。
    - Task 5.2 的真實 Tunnel 外部檢查有做反向自檢。
    - 「不啟動未授權 Tunnel」因 M1 不成立。
  - SCN-003（Task 4.1）：清單、provider 去重、空清單與失敗可區分；前端只用 textContent，用語不把「列出」說成「可用」。成立。
  - SCN-004（Task 2.1，支援 4.1、5.1）：暫存檔加 rename、失敗保留舊檔、只接受清單內 ID、被拒的請求不改設定、`data/` 是 bind mount（重建後保留）、沒有快取。成立。
  - SCN-005（Task 3.2）：閒置用 `>=`、寫入中不關閉、連續兩次查詢失敗才關、換代或非就緒就關、`boot()` 收尾。成立，有 N1、N3 兩個小缺口。
  - SCN-006（Task 2.2，支援 4.1）：`/model` 與面板都走 `describeAiConfigModel()`。telenexus、runner、agent 的 basePath 都是相對 cwd 的 `ai-config.yaml`，override 都用 `resolveOverridePath()`；紅燈是在舊版 router 上取得的。成立。
  - 測試數（L-01）：
    - `npm run test` exit 0，`# tests 949`、`# pass 949`；測試檔 104 個。
    - 10 個新測試檔逐一實跑，分別是 10、21、9、16、6、10、9、13、3、11 支，合計 108 支，與 841 + 108 = 949 一致。
    - `npm run lint` exit 0，`npx tsc --noEmit -p .` exit 0。
  - 突變抽查：
    - 抓到：拿掉重複鍵檢查（1 支失敗）；活動回報移到驗證之前（1 支）；拿掉管理員檢查（1 支）；不清暫存檔（1 支）；apply 不呼叫 beginWrite（1 支）；close 不 revokeAll（2 支）。
    - 沒抓到：tunnel-manager 的兩處 attempt 檢查（`:97` 是冗餘，`:107` 見 S1）；`poll` 在 await 之後的重新檢查（N3）；放寬靜態 regex（N4）。
    - 每次突變後都已還原，並以 `git diff --quiet` 確認。

- **相關失敗面**：

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|---|---|---|---|
| 偽造 hash、錯的 Bot token、竄改欄位、多一個欄位 | 401 bad-hash | `tests/web/panel-auth.test.ts:44-59` | 通過 |
| 重複的 `hash` 或 `user` 鍵 | malformed | `:61-75`，突變驗證過 | 通過 |
| `auth_date` 剛好 600 秒／601 秒；未來 60 秒／61 秒 | 接受／拒絕 | `:77-85` | 通過 |
| 有 `signature` 欄位，hash 納入或不納入 signature | 兩種都接受（都要 Bot token） | `:39-42` | 通過；真實 initData 留給 5.4 |
| 憑證放在網址參數、只帶憑證不帶 Bearer、XFF 127.0.0.1、Host localhost | 401 | `tests/web/panel-server.test.ts:93-122` | 通過 |
| 未登入探測 `/panel-api/constructor` 等路徑 | 401，不透露路徑是否存在 | `panel-server.test.ts:191-214`；`panel-api.test.ts:230` | 通過 |
| `/panel/` 路徑穿越（`..`、`%2e%2e`、子目錄） | 404 | URL 正規化加白名單；測試沒打到 regex | 實際安全，見 N4 |
| body 超過 16 KB | 413 | 測試接受 400 或 413 | 通過，見 N5 |
| Web Console `/api/chat` 送 `/panel` | 不開 Tunnel | 無覆蓋 | **失敗（M1）** |
| 群組或非管理員送 `/panel` | 不開 Tunnel | `command-router-panel.test.ts:105` | 通過 |
| tunnel-manager 不存在、金鑰不符、逾時、啟動失敗 | 回報原因、不設選單 | `panel-controller.test.ts:101,243` | 通過 |
| 選單設定失敗 | 停掉 Tunnel、不算開啟 | `:122` | 通過 |
| 停止中又有 start；健康檢查在子程序退出前回 true | 不變成 ready | 只覆蓋子程序已退出的情況 | 程式正確，覆蓋不足（S1） |
| cloudflared 意外結束 | 世代遞增，下一次 poll 關閉入口 | 單元測試加端對端 | 通過 |
| 查詢偶發失敗一次 | 不關；連續兩次才關 | `:209` | 通過 |
| 寫入中達到閒置門檻 | 不關，寫完重新計時 | `:176`，突變驗證過 | 通過 |
| `/panel_close` 與開啟中的 `menu.show` 交錯 | 不殘留已發布狀態 | 無 | 會自行恢復（N1） |
| tunnel-manager 重啟（換金鑰、世代歸零） | 每次呼叫重讀金鑰；網址不同視為新入口 | `tunnel-client.ts:56`；`panel-controller.ts:90` 同時比對世代與網址 | 通過（審閱判定） |
| override 檔 rename 失敗或目錄唯讀 | 保留舊檔、不留暫存檔 | `model-config.test.ts`；唯讀那支以 root 執行會略過，有揭露 | 通過 |
| 兩個設定檔的 model 是非字串、空白、壞掉的 YAML | 照合併規則改用另一個檔 | `command-router-model.test.ts:91-123` | 通過 |

- **需求、架構、安全、品質**：
  - 公開面：面板伺服器獨立，Web Console 程式完全沒動。CSP 是 `default-src 'none'`、`frame-ancestors https://*.telegram.org`、`connect-src 'self'`，沒有 inline 內容。
  - 雜湊比較：`timingSafeEqual` 前先比長度；`toLowerCase` 改變長度只會讓比較失敗，不會丟例外。
  - 憑證：32 bytes 隨機值，只在記憶體；換代、關閉、重啟都會作廢。
  - tunnel-manager 邊界：
    - `docker compose config` 解析 dev 加 overlay 的結果：沒有 env_file 帶進來的 Token，只掛 `tunnel_key`，沒有 `ports:`。
    - 有 `no-new-privileges`、`cap_drop: ALL`；多出的 `KILL` 只有以 root 執行的 tini 用得到，理由有記錄。
    - telenexus 以 `:ro` 掛 `tunnel_key`；agent-runner 沿用共用清單，沒有掛它。金鑰檔 0600、目錄 0700，屬於以 PUID 對齊後的 node（兩個服務的 PUID 都由同一個 `.env` 插值）。
    - cloudflared 以參數陣列啟動，目標固定，不接受外部指定。
  - 部署：
    - cloudflared 釘 2026.11.0，同一條 RUN 先 `sha256sum -c` 再安裝。只有 amd64，與既有的 Chrome、Moli 一致，release 也沒有建多架構。
    - release.yml 的 sed 沒有 `g` 旗標，但每個 `image:` 各佔一行，tunnel-manager 也會一起釘版（有測試）。
    - compose parity 測試在全套內通過；dev overlay 的 volume 依 target 合併，沒有蓋掉 `tunnel_key`。
    - 升級影響：`PANEL_ENABLED` 預設 true，3040 只在容器網路上。每次啟動 `boot()` 會把管理員私聊的選單重設成 `default`，這不會破壞任何設定（回到 bot 層級的預設選單）。`installation.md` 都有說明。
  - 跨 Task 重複：模型 ID 驗證、設定路徑解析、模型清單解析各只有一份（`isModelId`、`resolveOverridePath`、`listModels`），沒有分歧。`probe-models.mjs` 的複本是既有的刻意複本，parity 測試照樣通過。HTTP JSON 讀取與 `sendJson` 在 panel-server、web/server、runner 各有一份，但三個伺服器上限不同、用途獨立，面板刻意不共用 Web Console 的程式，判定合理。其餘小重複見 N8。
  - 過度設計：TunnelClient 的五種失敗分類直接對應 SCN-001 要回報的原因，不算過度。只有 `session` 路由多餘（N7）。
  - L-10：diff 裡沒有本機絕對路徑、真實 Telegram user id 或 token。已把 `.env` 的 `ALLOWED_USER_ID`、`TELEGRAM_TOKEN` 值拿來比對 diff，兩者都是 0 筆。Tunnel 網址都是合成的。
  - 常青文件：沒有宣稱正式部署已上線，安全一節沒有正式部署的設定；與行為不符的地方見 M1、N10。

- **豁免、待確認與限制**：
  - 豁免只有一項「不開 PR、本機獨立審查」，本審查照它執行，豁免沒有涵蓋任何 MUST FIX。
  - 待確認事項 TBD-1～4 都已解決，維持原狀；核准後 Gherkin 沒有被修改（BASE..HEAD 的 README diff 只動記帳與涉及檔案的段落）。`**核准 commit**` 是 2d23d19，等於 BASE。
  - 已揭露的限制，判定都誠實：
    - Task 5.2 改在主機上直接跑真實元件，沒有用 compose stack。容器網路上的 `telenexus:3040` 與 `tunnel-manager:8790` 連線還沒在 compose 裡實測。使用者已選擇不另建測試 Bot，由 Task 5.4 承擔。
    - telenexus 與 agent-runner 缺 `KILL`，所以收不到 SIGTERM。這是既有問題，不在本 issue 修。
    - `main.ts` 的接線沒有自動化測試。
    - 唯讀目錄那支測試以 root 執行時會略過。
  - Task 5.4 是發版後的外部驗收窗，合併前不要求它的結果。
  - 唯一不準確的揭露是 S1 的等價變異判定。
  - 流程提醒：README 目前沒有 `## 現況`。依流程契約 2.5，保存本報告的同一個提交要在 `## 概述` 之後建立它，並把 `**現行 review**` 指向這份報告。

## 流程判定
RETURN TO execute-task

理由：M1 是授權閘門的邏輯錯誤，違反核准的 SCN-002 與 Task 3.2 完成判準，也讓安全文件的說法不實。修正前需要使用者先就 `需決策` 選定 (a) 或 (b)。S1 與 NICE TO HAVE 不阻擋判定，建議在同一輪一起處理 S1。
