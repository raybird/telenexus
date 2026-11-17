# Issue 0030 Implementation Plan

## 設計方案
流程與權限邊界見 [技術分析](./technical-analysis.md)；風險與首要驗證唯一來源見 [README](./README.md#風險與首要驗證)。2026-11-17 核准的決策（Q1～Q4、工程預設）記在 README 的核准紀錄與待確認事項，本檔不重複。

- **公開面**：telenexus 另開面板專用 HTTP 伺服器（新連接埠，只在 Docker 內網，不列入 Compose `ports:`），只掛面板頁、面板靜態檔與 `/panel-api/*`；其他路徑一律 404。既有 Web Console（3030）的程式與授權不動。
- **登入**：前端把 `Telegram.WebApp.initData` 原文送到登入 API；伺服器依 Telegram 文件驗 HMAC（`WebAppData` 推導的金鑰）、`auth_date` 不超過 10 分鐘、`user.id` 等於 `ALLOWED_USER_ID`，通過後換發只存在記憶體的隨機憑證。憑證綁定目前的 Tunnel 世代，入口關閉或換網址就全部失效。授權只看這張憑證，不看來源 IP、`X-Forwarded-For`、Host 或 `WEB_AUTH_TOKEN`。
- **模型設定服務**：讀取有效設定與來源（與 `loadAiConfig()` 同一套合併規則，不再自己讀 YAML）、列舉 `opencode models`、套用完整模型 ID、清除 override。寫入用 `yaml.dump` 寫暫存檔再 `rename`，任何失敗都保留舊檔。`/model`、`/set_model`、`/reset_model`、`/models` 與面板共用。
- **tunnel-manager**：沿用主映像、換啟動命令的 Compose 服務，不放 Bot Token、不掛 data。只提供啟動／狀態／停止／活動回報四個內部 API，目標固定是 telenexus 的面板連接埠，不接受任意代理目標。內部 API 的認證不需使用者設定（例如由 tunnel-manager 產生隨機金鑰、放在只有兩個服務掛載的 volume），實作時決定；沒有金鑰時拒絕，不放行。cloudflared 以參數陣列啟動，不經 shell。
- **Bot 入口**：`/panel`、`/panel_close` 只接受私聊與 `ALLOWED_USER_ID`。Tunnel 就緒且外部 HTTPS 健康檢查通過後，才以 `setChatMenuButton` 設定該私聊的 `web_app` 按鈕；關閉或 Tunnel 退出時改回 `default`。

## Phase 與 Task（唯一任務來源）

依 README 風險策略，授權負向契約（Phase 1）先於所有會開放公開面的實作。

### Phase 1 — 公開面只有面板，且未授權一律拒絕

#### Task 1.1 — Telegram initData 驗證與面板憑證
- 產出與範圍：新模組（`src/web/` 下）負責驗 initData 簽章、`auth_date`、白名單，以及憑證的換發、查驗、依 Tunnel 世代整批作廢。不碰 HTTP。
- 相依：無
- 驗收編號：SCN-002（支援）
- 完成判準：正確簽章且在時效內的白名單帳號通過；改任一欄位、錯的 Bot Token、`auth_date` 超過 10 分鐘或在未來、非白名單、缺 `hash`、空字串都拒絕；世代變更後舊憑證失效。
- 驗證：單元測試。簽章期望值來自獨立的真相來源：用測試外的工具（例如 Python `hmac`）依 Telegram 文件算出的字面值，不在測試裡用同一段 Node 程式重算。
- 狀態：✅ 已完成（2026-11-17）
- 證據：
  - 產出：`src/web/panel-auth.ts`（`verifyInitData()`、`PanelSessions`）、`tests/web/panel-auth.test.ts`（11 支，皆標 SCN-002）。簽章期望值是 Python `hmac` 依 Telegram 文件另外算出的字面值，不在測試裡重算。
  - 單迴圈理由：本 Task 只有函式層行為，沒有 HTTP 或整合責任；SCN-002 的外迴圈（真實 HTTP 拒絕、設定未變）由 Task 1.2 負責。
  - 紅燈 1（allow-all 樁，全部放行）：`npx tsx --test tests/web/panel-auth.test.ts` exit 1，`# fail 9`。拒絕類 9 支失敗，原因是偽造、過期、非白名單、未設定都被放行、憑證作廢無效；只有 2 支正面案例通過。
  - 紅燈 2（deny-all 樁，全部拒絕）：同命令 exit 1，`# fail 9`。正面的 2 支（正確簽章、signature 兩種讀法）失敗。兩次合起來，每一支測試都至少紅過一次。
  - 綠燈：同命令 exit 0，`# tests 11`、`# pass 11`。
  - 變異檢查（各自還原後重跑）：拿掉重複欄位檢查、時效差一秒、拿掉未來時間檢查、拿掉 signature 的第二種算法、拿掉白名單、拿掉未設定檢查、`revokeAll()` 不清空，7 種都有 1 支失敗。
  - 重構：code-simplify 檢查後沒有實質改善（no-op），綠燈即最終狀態。
  - 交付檢查：`npm run build` exit 0；`npm run lint` exit 0；`npm run test` exit 0，`# tests 852`、`# pass 852`、`# fail 0`，比前一版 841 多 11 支，測試檔 95 個（多 1 個），相符（L-01）。
  - 殘餘風險：Telegram 文件沒有說清楚 bot 端的 hash 要不要納入 `signature`，所以兩種都接受，兩種都需要 Bot token。真實 initData 要到 Task 5.4（發版後）才驗得到。

#### Task 1.2 — 面板專用伺服器與授權邊界
- 產出與範圍：面板 HTTP 伺服器的骨架（登入 API、憑證檢查 middleware、未知路徑 404），在 `src/main.ts` 啟動；尚無模型 API。
- 相依：Task 1.1
- 驗收編號：SCN-002（責任）
- 完成判準：真實 HTTP 請求下，偽造／過期／非白名單 initData 登入失敗；沒帶憑證、偽造憑證、舊世代憑證、帶 `X-Forwarded-For: 127.0.0.1` 或內網 Host 的請求都被拒絕；`/api/chat`、`/api/memory/export`、`/api/schedules`、`/` 等既有 Web Console 路徑都是 404，不論 `WEB_AUTH_TOKEN` 是否空白、`WEB_TRUST_PRIVATE_NETWORK` 是否為 true；被拒的請求沒有改動 override 檔。
- 驗證：整合測試起真伺服器打 HTTP（外迴圈），Task 1.1 為內迴圈；設定未變以讀檔比對。
- 狀態：✅ 已完成（2026-11-17）
- 證據：
  - 產出：
    - `src/web/panel-server.ts`（`startPanelServer()`）。`POST /panel-api/login` 換發憑證，其他 `/panel-api/*` 先驗 Bearer 憑證，其餘路徑 404。
    - `src/main.ts` 以 `PANEL_ENABLED`（預設 true）、`PANEL_BIND`（預設 127.0.0.1，Compose 在 Task 5.1 設 0.0.0.0）、`PANEL_PORT`（預設 3040）啟動。啟動失敗記 `panel:start-failed`，不影響 Bot。關閉時一併收掉。
    - `tests/web/panel-server.test.ts`：8 支，皆標 SCN-002，以真實 HTTP 驗證。
  - 雙迴圈：外迴圈是本檔的真實 HTTP 測試，內迴圈是 Task 1.1 的單元測試。
  - 外迴圈紅燈 1（allow-all 樁，任何請求回 200 並附憑證）：`npx tsx --test tests/web/panel-server.test.ts` exit 1，`# fail 8`。偽造登入、沒帶憑證、偽造 `X-Forwarded-For`、舊 Web Console 路徑都拿到 200。
  - 外迴圈紅燈 2（deny-all 樁，一律 404）：同命令 exit 1，`# fail 8`。有效登入拿不到憑證，拒絕回 404 而不是 401。
  - 綠燈：同命令 exit 0，`# tests 8`、`# pass 8`。
  - 變異檢查（各自還原後重跑）：4 種都被抓到。
    - 接受網址參數裡的憑證：1 支失敗
    - 信任 `X-Forwarded-For: 127.0.0.1`：2 支失敗
    - 未登入時先回 404 再驗授權（洩漏路徑是否存在）：1 支失敗
    - 拿掉 body 大小上限：1 支失敗
  - 重構：code-simplify 檢查後沒有實質改善（no-op）。
  - 交付檢查：
    - `npm run build` exit 0；`npm run lint` exit 0。
    - `npm run test` exit 0，`# tests 860`、`# pass 860`，比 Task 1.1 後的 852 多 8 支；測試檔 96 個（多 1 個），相符（L-01）。
  - 限制：
    - 「被拒的請求不改動設定」目前只證明到「未登入的寫入路徑都 401、檔案不變」。這時還沒有寫入 API，Task 4.1 加上套用與重設後，要重跑這個斷言。
    - `src/main.ts` 的啟動接線沒有自動化測試（要真的 Bot token），留給 Task 5.2 的實際 stack 驗證。

### Phase 2 — 共用模型設定

#### Task 2.1 — 模型設定服務
- 產出與範圍：新服務模組，提供讀取有效設定與來源、列舉模型（provider 取第一段）、套用、重設；安全寫入。
- 相依：無（可與 Phase 1 並行，但面板 API 要等 Task 1.2）
- 驗收編號：SCN-004（責任）、SCN-003（支援：清單解析與空清單／命令失敗）
- 完成判準：套用後 `loadAiConfig()` 讀到新模型，重設後回到 base；無效 ID（空白、含換行或空白、不在目前清單內）被拒且檔案不變；寫入中途失敗（暫存檔或 rename 失敗）舊檔原樣保留；`opencode models` 失敗或為空時回傳可區分的結果。進行中任務不換模型沿用現有語意（每次新呼叫才讀設定），以測試證明服務沒有快取有效模型。
- 驗證：隔離 data 目錄的單元／整合測試；opencode 用假執行檔（沿用 `tests/probe-models-script.test.ts` 的做法）。
- 狀態：📝 待實作
- 證據：

#### Task 2.2 — 既有指令改用共用服務
- 產出與範圍：`src/core/command-router.ts` 的 `/model`、`/set_model`、`/reset_model`、`/models` 改呼叫 Task 2.1，移除自己的 YAML 解析與路徑推導；回覆文字盡量不變。
- 相依：Task 2.1
- 驗收編號：SCN-006（責任）
- 完成判準：`model` 空白、不是字串、YAML 壞掉、引號、只有其中一個檔等組合下，`/model` 顯示的有效模型與來源都和 `loadAiConfig()` 相同，不回「❌ 無法讀取設定檔」；`ai-config.yaml` 位置與 `loadAiConfig()` 一致；`/set_model` 寫出的檔能被 `loadAiConfig()` 讀回同一個 ID。
- 驗證：以 `loadAiConfig()` 為對照的組合測試（同 #29 的 parity 做法），期望值來自 loader 這條獨立路徑。
- 狀態：📝 待實作
- 證據：

### Phase 3 — Tunnel 生命週期與 Bot 入口

#### Task 3.1 — tunnel-manager 程式
- 產出與範圍：新進入點（`src/` 下，編譯進主映像），狀態機（停止／啟動中／就緒／失敗）、cloudflared 子程序、從輸出取得 `trycloudflare.com` 網址、外部 HTTPS 健康檢查、30 分鐘閒置計時與寫入中保護、子程序退出清理、內部 API 認證。
- 相依：無（介面先定，與 Phase 2 並行）
- 驗收編號：SCN-001、SCN-005（支援）
- 完成判準：並行的啟動請求只開一個 cloudflared；健康檢查失敗或逾時回報失敗且不給網址；子程序意外退出時狀態回停止、世代遞增；閒置 30 分鐘停止、期間有活動則延後、寫入中不停；沒有或錯誤的內部金鑰被拒。
- 驗證：單元測試用假 cloudflared 腳本與可控時鐘；不連外。
- 狀態：📝 待實作
- 證據：

#### Task 3.2 — `/panel`、`/panel_close` 與選單按鈕
- 產出與範圍：Tunnel 客戶端、兩個指令、`setChatMenuButton` 的設定與還原、Tunnel 退出／閒置關閉時還原選單並作廢憑證、面板請求回報活動。
- 相依：Task 1.2、Task 3.1
- 驗收編號：SCN-001（責任）、SCN-005（責任）
- 完成判準：健康後才設定 `web_app` 按鈕；重複 `/panel` 沿用同一網址；tunnel-manager 不存在、拒絕或逾時時回報原因且不呼叫 `setChatMenuButton`；`/panel_close`、閒置與意外退出三種情況都還原成 `default` 並使舊憑證失效；之後再 `/panel` 能取得新入口；回覆不宣稱已送出的舊按鈕會更新；非私聊或非白名單不啟動 Tunnel。
- 驗證：pipeline／指令層整合測試，Telegram API 與 tunnel-manager 用假的（記錄呼叫順序），tunnel-manager 也以 Task 3.1 的真程式搭假 cloudflared 跑一次端對端。
- 狀態：📝 待實作
- 證據：

### Phase 4 — Mini App 模型面板

#### Task 4.1 — 面板 API 與手機頁面
- 產出與範圍：`/panel-api/` 的狀態、清單、套用、重設端點（呼叫 Task 2.1），與一頁手機表單（provider 篩選、搜尋、完整 ID、目前有效設定與來源、全域影響說明、「列出不代表可呼叫」、套用／恢復預設／重新整理）。前端與 API 同源、相對路徑；寫入請求期間標記為寫入中。
- 相依：Task 1.2、Task 2.1、Task 3.2（活動回報）
- 驗收編號：SCN-003（責任）、SCN-004（支援：經 API 套用與重設）、SCN-006（支援：面板顯示同一個有效模型）
- 完成判準：登入後取得清單與目前設定；provider 篩選與搜尋結果正確；清單失敗與空清單顯示明確訊息；套用與重設經 API 改動設定、無效輸入回錯誤且檔案不變；頁面沒有任何字眼把「列出」說成「可用」。
- 驗證：API 整合測試；前端以 DOM 層的最小測試或手動截圖（實作時依現有 Web Console 的測試方式決定），真 Telegram 客戶端留給 Task 5.4。
- 狀態：📝 待實作
- 證據：

### Phase 5 — 部署整合、外部證據與文件

#### Task 5.1 — 映像、Compose 與 bundle
- 產出與範圍：`Dockerfile` 加入釘版並驗證雜湊的 cloudflared；`docker-compose.yml` 與 `docker-compose.release.yml` 同步新增 tunnel-manager 服務與面板連接埠（不對主機開放）；`.env.example`；必要時調整 `scripts/install.sh`（升級時 bundle 已覆蓋 `docker-compose.yml`，預期不必改）。
- 相依：Task 3.1
- 驗收編號：SCN-001（支援）、SCN-004（支援：設定在 `data/`，重建後保留）
- 完成判準：compose parity 測試通過且新服務沒有 `ports:`、沒有 Bot Token 與 data 掛載、不是 privileged、沒有 Docker socket；release.yml 的 sed 會把新服務的映像一起釘版；改到 install.sh 時 `npm run test:installer` 通過。
- 驗證：擴充 `tests/docker/` 的靜態測試；`docker build` 確認 cloudflared 可執行。
- 狀態：📝 待實作
- 證據：

#### Task 5.2 — 合併前的真實 Quick Tunnel 外部檢查
- 產出與範圍：在本機起 tunnel-manager 與一個只有面板伺服器、不開 Telegram polling 的 telenexus（避免與正式 Bot 409），開一次真實 Quick Tunnel，從外部 `curl`。資料全為合成，網址只開幾分鐘；啟動時機由使用者決定。
- 相依：Task 1.2、Task 3.1、Task 5.1
- 驗收編號：風險證據（README 首要驗證）；SCN-001、SCN-002 的外部面
- 完成判準：公開網址的面板頁回 200；`/api/chat`、`/api/memory/export`、`/` 回 404；未登入呼叫 `/panel-api/*` 被拒；`/panel_close` 等效操作後網址失效。
- 驗證：觀測式證據，記命令與狀態碼（不記網址）；反向自檢：先確認同一組 `curl` 對 3030 的 Web Console 會回 200，證明判準抓得到失敗。
- 狀態：📝 待實作
- 證據：

#### Task 5.3 — 常青文件
- 產出與範圍：依 project.md「常青文件更新責任」更新 `README.md`、`ARCHITECTURE.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`.env.example`、`docs/configuration-reference.md`、`docs/runtime-boundary-and-security.md`（公開面與授權模型）、`docs/installation.md`、`docs/README.md`；`docs/web-console-reference.md` 只在動到 Web Console 時更新。
- 相依：Task 3.2、Task 4.1、Task 5.1
- 驗收編號：交付成果
- 完成判準：文件描述與實際行為一致，不宣稱正式部署已上線。
- 驗證：靜態檢查（`prettier --check`、連結）。
- 狀態：📝 待實作
- 證據：

#### Task 5.4 — 發版後以正式 Bot 驗收（外部驗收窗）
- 產出與範圍：使用者發版並升級正式部署後，在 Android 客戶端驗 `/panel`、登入、切換、恢復預設、`/panel_close`、再 `/panel` 換網域後重新登入；資料只記結果與統計。
- 相依：Task 1.1～5.3 合併；發版與升級（使用者決定）
- 驗收編號：SCN-001、SCN-002、SCN-005 的真機證據（TBD-3）
- 完成判準：上列操作都成功，換網域後舊頁面不能操作；任何一項失敗即回到 execute-task。
- 驗證：觀測式證據，合併後以 `等待外部驗收窗` 記錄。
- 狀態：⏳ 等待發版（合併前不執行）
- 證據：

## 責任對照

| 驗收／交付 | 責任 Task |
|---|---|
| SCN-001 | 3.2 |
| SCN-002 | 1.2 |
| SCN-003 | 4.1 |
| SCN-004 | 2.1 |
| SCN-005 | 3.2 |
| SCN-006 | 2.2 |
| 風險證據：公開面外部檢查 | 5.2 |
| 映像／Compose／bundle | 5.1 |
| 常青文件 | 5.3 |
| 真機證據（外部驗收窗） | 5.4 |

建議執行順序：1.1 → 1.2 → 2.1 → 2.2 → 3.1 → 3.2 → 4.1 → 5.1 → 5.2 → 5.3；5.4 在合併、發版後。

## 使用方式對照
原本：/models → 複製完整 ID → /set_model；恢復使用 /reset_model。
目標：/panel → Mini App provider／model 選擇 → 套用／恢復；原指令保留。

## 測試策略
- 行為實作依 verification.md 保存紅綠重構證據；純文件使用靜態檢查。
- 最終依序執行 `npm run build`、`npm run test`（核對 `# tests`，L-01）、`npm run lint`；改 installer 加 `npm run test:installer`。
- 修改 symbol 前 GitNexus impact 並以 grep 交叉核對呼叫者；提交前 detect_changes 與 `git diff --stat`。
- 證據檔只放統計或合成內容（L-10），不放 Tunnel 網址、token、聊天 ID。
