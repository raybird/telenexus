# Issue 0030 Implementation Plan

## 設計方案
流程與權限邊界見 [技術分析](./technical-analysis.md)；風險與首要驗證唯一來源見 [README](./README.md#風險與首要驗證)。2026-11-17 核准的決策（Q1～Q4、工程預設）記在 README 的核准紀錄與待確認事項，本檔不重複。

- **公開面**：telenexus 另開面板專用 HTTP 伺服器（新連接埠，只在 Docker 內網，不列入 Compose `ports:`），只掛面板頁、面板靜態檔與 `/panel-api/*`；其他路徑一律 404。既有 Web Console（3030）的程式與授權不動。
- **登入**：前端把 `Telegram.WebApp.initData` 原文送到登入 API；伺服器依 Telegram 文件驗 HMAC（`WebAppData` 推導的金鑰）、`auth_date` 不超過 10 分鐘、`user.id` 等於 `ALLOWED_USER_ID`，通過後換發只存在記憶體的隨機憑證。憑證綁定目前的 Tunnel 世代，入口關閉或換網址就全部失效。授權只看這張憑證，不看來源 IP、`X-Forwarded-For`、Host 或 `WEB_AUTH_TOKEN`。
- **模型設定服務**：讀取有效設定與來源（與 `loadAiConfig()` 同一套合併規則，不再自己讀 YAML）、列舉 `opencode models`、套用完整模型 ID、清除 override。寫入用 `yaml.dump` 寫暫存檔再 `rename`，任何失敗都保留舊檔。`/model`、`/set_model`、`/reset_model`、`/models` 與面板共用。
- **tunnel-manager**：沿用主映像、換啟動命令的 Compose 服務，不放 Bot Token、不掛 data。只提供啟動、狀態、停止三個內部 API，目標固定是 telenexus 的面板連接埠，不接受任意代理目標。內部 API 以 `x-tunnel-key` 認證：tunnel-manager 每次啟動時產生隨機金鑰，寫進只有它與 telenexus 掛載的 volume（檔案 0600），不需使用者設定；沒有金鑰或不符一律拒絕。cloudflared 以參數陣列啟動，不經 shell。
- **閒置關閉放在 telenexus**（2026-11-17 實作 Task 3.1 時調整，行為與核准的 SCN-005 相同）：只有 telenexus 知道面板有沒有經過驗證的請求、是否正在寫入，所以 30 分鐘計時由 Task 3.2 負責，tunnel-manager 不提供活動回報 API。telenexus 重啟時記憶體憑證已全部失效，啟動時先停掉殘留的 Tunnel 並還原選單。
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
    - 「被拒的請求不改動設定」目前只證明到「未登入的寫入路徑都 401、檔案不變」。這時還沒有寫入 API，Task 4.1 加上套用與重設後，要重跑這個斷言。（2026-11-17 已在 Task 4.1 重跑通過，見該節證據。）
    - `src/main.ts` 的啟動接線沒有自動化測試（要真的 Bot token），留給 Task 5.2 的實際 stack 驗證。

### Phase 2 — 共用模型設定

#### Task 2.1 — 模型設定服務
- 產出與範圍：新服務模組，提供讀取有效設定與來源、列舉模型（provider 取第一段）、套用、重設；安全寫入。
- 相依：無（可與 Phase 1 並行，但面板 API 要等 Task 1.2）
- 驗收編號：SCN-004（責任）、SCN-003（支援：清單解析與空清單／命令失敗）
- 完成判準：套用後 `loadAiConfig()` 讀到新模型，重設後回到 base；無效 ID（空白、含換行或空白、不在目前清單內）被拒且檔案不變；寫入中途失敗（暫存檔或 rename 失敗）舊檔原樣保留；`opencode models` 失敗或為空時回傳可區分的結果。進行中任務不換模型沿用現有語意（每次新呼叫才讀設定），以測試證明服務沒有快取有效模型。
- 驗證：隔離 data 目錄的單元／整合測試；opencode 用假執行檔（沿用 `tests/probe-models-script.test.ts` 的做法）。
- 狀態：✅ 已完成（2026-11-17）
- 證據：
  - 產出：
    - `src/core/config-loader.ts`：合併規則抽成 `describeAiConfigModel()`（多回傳來源與兩個檔各自的值）與 `readOverrideModel()`；`loadAiConfig()` 改成呼叫它。行為不變，影響分析見下方。
    - `src/core/model-config.ts`：`readModelState()`、`listModels()`、`isModelId()`、`applyModel()`、`resetModel()`。
    - `tests/model-config.test.ts`：21 支，標 SCN-003／004／006。有效模型的期望值是依 README 合併規則手寫的字面值，不拿 `loadAiConfig()` 當對照。
  - 影響分析：
    - GitNexus 把 `loadAiConfig` 評為 CRITICAL：3 個直接呼叫者（`DynamicAIAgent.loadProviderConfig`、`runner.ts` 的 `loadProviderConfig`、`main.ts` 的 `bootstrap`），影響 5 個流程。grep 也只找到同樣 3 個生產檔案。
    - 改動只抽出函式，回傳值不變。佐證有兩項：#29 的 13 組 parity 測試（`tests/probe-models-script.test.ts`）照樣通過；本檔 9 組組合同時斷言 `loadAiConfig().model` 等於手寫期望值。
  - 單迴圈理由：服務層就是可觀察的行為（檔案內容、`loadAiConfig()` 讀回的值），以隔離的 `APP_PROJECT_DIR` 與真實檔案系統驗證，沒有另一層整合責任。經 API 套用的部分由 Task 4.1 負責。
  - 紅燈：樁實作（讀取一律回 `none`、寫入什麼都不做、清單一律空）下，`npx tsx --test tests/model-config.test.ts` exit 1，`# fail 20`。
    - 唯一通過的是「兩個檔都沒有 model」，因為期望值剛好等於樁的回傳。變異「base 優先」下它照樣有覆蓋（見下）。
  - 綠燈：首次執行 exit 0 前，有 1 支失敗：「YAML 特殊字元」的測試值 `'mock/a: b'` 含空白，本來就是核准規則下的無效 ID，屬於測試本身的錯。改成 `'mock/a:b'` 後 exit 0，`# tests 21`、`# pass 21`。
  - 重構：把「只讀 override」的寫法從 `describeAiConfigModel({ basePath: '\0' })` 改成 `readOverrideModel()`。重跑本檔與 `tests/probe-models-script.test.ts`：`# tests 54`、`# pass 54`。
  - 變異檢查（各自還原後重跑），5 種都被抓到：
    - base 優先於 override：7 支失敗
    - 直接覆寫目標檔、不經暫存檔：6 支失敗
    - 不清暫存檔：1 支失敗
    - 不檢查可用清單：1 支失敗
    - 用字串拼 YAML：3 支失敗
  - 交付檢查：
    - `npm run build` exit 0；`npm run lint` exit 0。
    - `npm run test` exit 0，`# tests 881`、`# pass 881`，比 Task 1.2 後的 860 多 21 支；測試檔 97 個（多 1 個）（L-01）。
  - 限制：「目錄唯讀」那支以 root 執行時會略過。主機上以一般使用者執行，有實際驗證到。

#### Task 2.2 — 既有指令改用共用服務
- 產出與範圍：`src/core/command-router.ts` 的 `/model`、`/set_model`、`/reset_model`、`/models` 改呼叫 Task 2.1，移除自己的 YAML 解析與路徑推導；回覆文字盡量不變。
- 相依：Task 2.1
- 驗收編號：SCN-006（責任）
- 完成判準：`model` 空白、不是字串、YAML 壞掉、引號、只有其中一個檔等組合下，`/model` 顯示的有效模型與來源都和 `loadAiConfig()` 相同，不回「❌ 無法讀取設定檔」；`ai-config.yaml` 位置與 `loadAiConfig()` 一致；`/set_model` 寫出的檔能被 `loadAiConfig()` 讀回同一個 ID。
- 驗證：以 `loadAiConfig()` 為對照的組合測試（同 #29 的 parity 做法），期望值來自 loader 這條獨立路徑。
- 狀態：✅ 已完成（2026-11-17）
- 證據：
  - 產出：
    - `src/core/command-router.ts`：四個指令改呼叫 `model-config`，拿掉自己的 YAML 解析、`resolveConfigPath()`、`resolveOverridePath()`。一般情況的回覆文字不變。
    - `/set_model` 的 ID 不合 `isModelId()`（含空白、換行、沒有 `/`）時回原本的「❌ 格式錯誤」。
  - 測試：`tests/command-router-model.test.ts`，9 支。cwd 與 `APP_PROJECT_DIR` 分在兩個目錄，才看得出 `ai-config.yaml` 讀的是哪一個。期望值是手寫字面值。
  - 影響分析：GitNexus 對 `registerDefaultCommands` 評為 LOW，只有 `CommandRouter` 的 constructor 一個呼叫者。
  - 單迴圈理由：指令層就是使用者看到的回覆；底層合併規則已由 Task 2.1 的單元測試保障，這裡驗的是指令改走同一條路，沒有另一層整合責任。
  - 紅燈：在舊版 `command-router.ts`（`git show HEAD:` 暫時放回，跑完還原）上執行 `npx tsx --test tests/command-router-model.test.ts`，exit 1，`# fail 6`。失敗的情況：
    - `model: 123`、`ai-config.yaml` 壞掉、base 的 model 是清單，都回「❌ 無法讀取設定檔」。
    - `ai-config.yaml` 讀成 `APP_PROJECT_DIR` 底下的那份。
    - `/set_model [mock]/x` 寫出不合法的 YAML。
    - 含換行的 ID 被直接寫進檔案。

    另外 2 支是回覆文字的回歸守門，舊版也通過。
  - 綠燈：exit 0，`# pass 9`。過程中改了一個測試值：`mock/it's` 透過指令送不出去，因為 `handleMessage` 原本就會移除引號與反引號（既有行為），屬於測試設計錯誤，所以從清單拿掉，留下 `[mock]/x`、`mock/x:y`。
  - 回歸守門：`/models` 的回覆格式與 provider 篩選，用 PATH 上的假 `opencode` 驗證，新舊版都通過。
  - 重構：把 `/models` 改寫時留下的多餘區塊拿掉，重跑同組測試仍綠。
  - 交付檢查：
    - `npm run build` exit 0；`npm run lint` exit 0。
    - `npm run test` exit 0，`# tests 890`、`# pass 890`，比 Task 2.1 後的 881 多 9 支；測試檔 98 個（多 1 個）（L-01）。
  - 行為差異（揭露）：
    - `/models` 現在會略過不像模型 ID 的行，例如 opencode 印出的警告。
    - `/set_model` 現在會拒絕含空白或換行的 ID；以前會把它寫進檔案，讓設定檔壞掉。

### Phase 3 — Tunnel 生命週期與 Bot 入口

#### Task 3.1 — tunnel-manager 程式
- 產出與範圍：新進入點（`src/` 下，編譯進主映像），狀態機（停止／啟動中／就緒／失敗）、cloudflared 子程序、從輸出取得 `trycloudflare.com` 網址、外部 HTTPS 健康檢查、子程序退出清理、內部 API 認證。閒置計時改由 Task 3.2 負責（見設計方案）。
- 相依：無（介面先定，與 Phase 2 並行）
- 驗收編號：SCN-001、SCN-005（支援）
- 完成判準：並行的啟動請求只開一個 cloudflared；健康檢查失敗或逾時回報失敗且不給網址；子程序意外退出時狀態回停止、世代遞增；啟動中被停止不會變成就緒；沒有或錯誤的內部金鑰被拒。
- 驗證：單元測試用假 cloudflared 腳本與可控時鐘；不連外。
- 狀態：✅ 已完成（2026-11-17）
- 證據：
  - 產出：
    - `src/tunnel/tunnel-manager.ts`（`TunnelManager`）
    - `src/tunnel/tunnel-api.ts`（`ensureTunnelKey()`、`startTunnelApi()`）
    - `src/tunnel-manager.ts`（進入點，環境變數 `TUNNEL_KEY_FILE`、`TUNNEL_API_HOST`／`PORT`、`TUNNEL_TARGET_URL`、`CLOUDFLARED_BIN`、`TUNNEL_START_TIMEOUT_MS`）
    - `src/web/panel-server.ts` 加上不需登入的 `GET /panel/health`，供健康檢查確認打到的是面板。
  - 測試：
    - `tests/tunnel/tunnel-manager.test.ts`：13 支，用真實 spawn 的假 cloudflared 腳本，健康檢查用注入的。
    - `tests/web/panel-server.test.ts`：加 1 支。
  - 單迴圈理由：狀態機與內部 API 都以真實子程序和真實 HTTP 驗證，就是這個服務對外的可觀察行為。telenexus 端的整合由 Task 3.2 負責。
  - 紅燈：
    - 樁實作（start 不 spawn 直接回就緒、API 不驗金鑰）下，`npx tsx --test tests/tunnel/tunnel-manager.test.ts` exit 1，`# fail 13`。
    - `/panel/health` 的新測試在舊版 panel-server 上 `# fail 1`（回 404）。
  - 綠燈：
    - `tests/tunnel/tunnel-manager.test.ts` exit 0，`# pass 13`，連跑 3 次結果相同，結束後沒有殘留的假 cloudflared 程序。
    - `tests/web/panel-server.test.ts` `# pass 9`。
  - 變異檢查（各自還原後重跑），5 種被抓到：
    - 不共用並行啟動：1 支失敗
    - 意外結束時世代不遞增：1 支失敗
    - 跳過健康檢查：3 支失敗
    - 不驗內部金鑰：1 支失敗
    - 就緒時不沿用：1 支失敗

    「健康檢查後不檢查 attempt」沒被抓到，當時判定為等價變異。**這個判定不成立**（review-87b6cf6 S1）：真的 cloudflared 收到 SIGTERM 後有收尾期，健康檢查可能在 `exited` 還是 false 時先回成功，拿掉檢查就會在停止後變成就緒。原測試在子程序已結束後才放行健康檢查，所以抓不到；守門測試見「審查修正輪」。
  - 冒煙：`node dist/tunnel-manager.js`（`CLOUDFLARED_BIN=/bin/false`，不連外）。
    - 沒帶金鑰回 401；帶金鑰查狀態回 `stopped`；啟動回 502 並附「在取得網址前結束」。
    - 金鑰檔權限 600，目錄 700。
    - 收到 SIGTERM 後 exit 0。
  - 重構：假腳本改用 `exec sleep`，避免 sh 被終止後 sleep 留下來。產品碼沒有其他精簡空間（no-op）。
  - 交付檢查：
    - `npm run build` exit 0；`npm run lint` exit 0。
    - `npm run test` exit 0，`# tests 904`、`# pass 904`，比 Task 2.2 後的 890 多 14 支；測試檔 99 個（多 1 個）（L-01）。
  - 交給 Task 5.1：
    - 金鑰 volume 在容器內要歸 node 使用者（PUID/PGID 對齊，L-08）。
    - telenexus 以唯讀掛載同一個 volume。

#### Task 3.2 — `/panel`、`/panel_close` 與選單按鈕
- 產出與範圍：Tunnel 客戶端、兩個指令、`setChatMenuButton` 的設定與還原、30 分鐘閒置計時（寫入中不算閒置）、Tunnel 退出或閒置關閉時還原選單並作廢憑證、面板請求回報活動、服務啟動時收掉殘留入口。
- 相依：Task 1.2、Task 3.1
- 驗收編號：SCN-001（責任）、SCN-005（責任）
- 完成判準：健康後才設定 `web_app` 按鈕；重複 `/panel` 沿用同一網址；tunnel-manager 不存在、拒絕或逾時時回報原因且不呼叫 `setChatMenuButton`；`/panel_close`、閒置與意外退出三種情況都還原成 `default` 並使舊憑證失效；之後再 `/panel` 能取得新入口；回覆不宣稱已送出的舊按鈕會更新；非私聊或非白名單不啟動 Tunnel。
- 驗證：pipeline／指令層整合測試，Telegram API 與 tunnel-manager 用假的（記錄呼叫順序），tunnel-manager 也以 Task 3.1 的真程式搭假 cloudflared 跑一次端對端。
- 狀態：✅ 已完成（2026-11-17）
- 證據：
  - 產出：
    - `src/tunnel/tunnel-client.ts`（`TunnelClient`，失敗分 unreachable／unauthorized／failed／timeout／bad-response）
    - `src/services/panel-controller.ts`（`PanelController`：open／close／touch／beginWrite／checkIdle／poll／boot、30 秒的檢查計時）
    - `src/core/command-router.ts` 的 `/panel`、`/panel_close`（`setPanel()`、私聊與管理員檢查、`/start` 說明）
    - `TelegramConnector.setPanelMenuButton()`（web_app／default，網址必須是 HTTPS）
    - `panel-server` 的 `onActivity`
    - `src/main.ts` 接線：`TUNNEL_MANAGER_URL` 預設 `http://tunnel-manager:8790`，`TUNNEL_KEY_FILE` 預設 `/run/telenexus-tunnel/key`。Telegram 就緒後先 `boot()` 再開計時。
  - 測試（共 26 支）：
    - `tests/panel-controller.test.ts` 16 支。最後兩支是端對端：真的 `TunnelManager`、內部 API、`TunnelClient`，搭假 cloudflared。
    - `tests/command-router-panel.test.ts` 6 支
    - `tests/telegram/connector-panel-menu.test.ts` 3 支，參數形狀依 Bot API 文件
    - `tests/web/panel-server.test.ts` 加 1 支
    - 共用的假 cloudflared 移到 `tests/fixtures/tunnel/fake-cloudflared.sh`，Task 3.1 的測試改讀它，仍 13 支全過。
  - 雙迴圈：
    - 外迴圈是指令層測試與控制器端對端，內迴圈是控制器、客戶端、connector 的單元測試。
    - 閒置與狀態檢查以注入時鐘直接呼叫 `checkIdle()`、`poll()`，不等真實計時器。
  - 紅燈（每段都是目標行為缺失）：
    - 控制器與客戶端：樁實作（open 一律成功、什麼都不呼叫）下 `# fail 15`。
    - 指令：先放 no-op 的 `setPanel()`，`# fail 6`，回覆是「❌ 未知指令」。
    - 選單按鈕：先放 no-op 方法，`# fail 3`。
    - 活動回報：`# fail 1`，計數停在 0。
  - 綠燈：
    - `tests/panel-controller.test.ts` 加 `tests/command-router-panel.test.ts`：`# pass 21`
    - connector：`# pass 3`
    - panel-server：`# pass 10`
  - 變異檢查（各自還原後重跑），8 種都被抓到：
    - 換網址不作廢憑證：1 支失敗
    - 閒置不看寫入中：1 支失敗
    - 狀態查詢第一次失敗就關：1 支失敗
    - 選單設定失敗不停 Tunnel：1 支失敗
    - 閒置差一毫秒：2 支失敗
    - 不檢查私聊：1 支失敗
    - 不檢查管理員：1 支失敗
    - 不檢查就緒狀態：一開始沒被抓到，補上「有網址但狀態不是就緒」那支後，1 支失敗
  - 重構：`boot()` 改成不經 `close()`，因為沒部署 tunnel-manager 時停止必然失敗，不應每次啟動都記 runtime issue 觸發告警。重跑仍綠。
  - 交付檢查：
    - `npm run build` exit 0；`npm run lint` exit 0。
    - `npm run test` exit 0，`# tests 930`、`# pass 930`，比 Task 3.1 後的 904 多 26 支；測試檔 102 個（多 3 個）（L-01）。
  - 限制：
    - `src/main.ts` 的接線與真的 Telegram `setChatMenuButton` 沒有自動化測試，前者由 Task 5.2 驗證，後者由 Task 5.4 驗證。
    - `/panel` 的成功回覆不含網址，入口只有選單按鈕，所以沒有會過期的歷史按鈕。

### Phase 4 — Mini App 模型面板

#### Task 4.1 — 面板 API 與手機頁面
- 產出與範圍：`/panel-api/` 的狀態、清單、套用、重設端點（呼叫 Task 2.1），與一頁手機表單（provider 篩選、搜尋、完整 ID、目前有效設定與來源、全域影響說明、「列出不代表可呼叫」、套用／恢復預設／重新整理）。前端與 API 同源、相對路徑；寫入請求期間標記為寫入中。
- 相依：Task 1.2、Task 2.1、Task 3.2（活動回報）
- 驗收編號：SCN-003（責任）、SCN-004（支援：經 API 套用與重設）、SCN-006（支援：面板顯示同一個有效模型）
- 完成判準：登入後取得清單與目前設定；provider 篩選與搜尋結果正確；清單失敗與空清單顯示明確訊息；套用與重設經 API 改動設定、無效輸入回錯誤且檔案不變；頁面沒有任何字眼把「列出」說成「可用」。
- 驗證：API 整合測試；前端以 DOM 層的最小測試或手動截圖（實作時依現有 Web Console 的測試方式決定），真 Telegram 客戶端留給 Task 5.4。
- 狀態：✅ 完成（2026-11-17）
- 證據：
  - 測試：`tests/web/panel-api.test.ts`（9 支），以真實 HTTP 打 `startPanelServer()`。暫存專案同時是 cwd 與 `APP_PROJECT_DIR`，期望值是手寫字面值，套用或重設後再用 `loadAiConfig()` 讀回，確認與實際呼叫是同一個值。只注入 `opencode models` 的結果。
  - 端點：`GET state`、`GET models`（附 provider 依出現順序去重）、`POST apply`（先驗格式，再取清單，清單取不到回 502 不寫；只套用清單內的 ID）、`POST reset`。套用與重設期間呼叫 `beginWrite()`，`src/main.ts` 接到 `PanelController.beginWrite()`，寫入中不算閒置（SCN-005）。
  - 靜態頁：`src/web/panel-public/`（`index.html`、`app.js`、`app.css`），`/panel/<檔名>` 只服務 `^[a-z0-9-]+\.(html|js|css)$` 的檔名，不解碼。CSP 為 `default-src 'none'`，script 只允許同源與 `https://telegram.org`，`connect-src 'self'`，沒有 inline script 或 style。`scripts/copy-web-assets.mjs` 改為複製 `public/` 與 `panel-public/`，`dist/web/panel-public/` 由編譯後的伺服器服務（已用 `dist/` 實測 200／404）。
  - 紅燈：`# tests 9`、`# fail 8`；唯一通過的是未登入一律 401，Task 1.2 已有這個行為。
  - 綠燈：`panel-api` 加 `panel-server` 共 `# pass 19`。
  - 被拒的請求不改動設定（Task 1.2 留下的斷言）：重跑通過，有兩支測試證明。
    - 已登入時，不在清單內、格式不合、型別錯誤、缺欄位、body 不是 JSON、清單取不到，6 種情況都不改動 override 檔，寫入標記也都有成對釋放。
    - 未登入時，套用、重設、狀態、清單四個端點都回 401，檔案不變。
  - 變異檢查（各自還原後重跑），6 種都被抓到：
    - 不比對清單：1 支失敗
    - 套用後不釋放寫入標記：2 支失敗
    - 不檢查方法：1 支失敗
    - 不送 CSP：1 支失敗
    - 清單失敗仍寫入：1 支失敗
    - 不驗憑證：1 支失敗
  - 重構：精煉時發現路由表是一般物件，`/panel-api/constructor`、`__proto__` 會取到原型成員而回 405。先把測試補到 404 取得紅燈（`405 !== 404`），再改用 `Map`，重跑轉綠。順手把 `serveStatic` 的 try／throw 改成直接判斷。
  - 前端實測：用 Chrome headless 與 playwright-core，在 scratchpad 跑，不進 repo，全部用合成資料。`telegram-web-app.js` 換成帶測試 initData 的樁。在 390×844 淺色與 360×640 深色兩種環境下，逐步檢查：
    - 載入後顯示 33／33 筆。
    - 選 provider 並搜尋後剩 1／33 筆。
    - 套用長模型 ID 後，override 檔內容正確，「恢復預設」變成可按。
    - 恢復預設後 override 檔被刪除。
    - 頁面沒有水平溢出、沒有 console 錯誤。原本有一次 `/favicon.ico` 404，補了 `data:` 圖示後消失。
    - 沒有 initData 時顯示「請從 Telegram 私聊的『模型設定』選單按鈕開啟」。
    - Playwright 的字串求值被頁面 CSP 擋下，反過來證明 CSP 確實生效；改從 Node 端輪詢。
    - 截圖人工檢視：長 ID 完整換行，目前模型標示與全域說明都看得到。
  - 用語：頁面與前端程式沒有「可用」「available」字樣；說明寫的是「列出不代表可以呼叫」。
  - 交付檢查：
    - `npm run build` exit 0；`npm run lint` exit 0。
    - `npm run test` exit 0，`# tests 939`、`# pass 939`，比 Task 3.2 後的 930 多 9 支；測試檔 103 個（多 1 個）（L-01）。
  - 限制：真的 Telegram 客戶端（主題變數、initData、選單按鈕開啟）沒有測，留給 Task 5.4；經 Tunnel 的同源存取由 Task 5.2 驗證。

### Phase 5 — 部署整合、外部證據與文件

#### Task 5.1 — 映像、Compose 與 bundle
- 產出與範圍：`Dockerfile` 加入釘版並驗證雜湊的 cloudflared；`docker-compose.yml` 與 `docker-compose.release.yml` 同步新增 tunnel-manager 服務與面板連接埠（不對主機開放）；`.env.example`；必要時調整 `scripts/install.sh`（升級時 bundle 已覆蓋 `docker-compose.yml`，預期不必改）。
- 相依：Task 3.1
- 驗收編號：SCN-001（支援）、SCN-004（支援：設定在 `data/`，重建後保留）
- 完成判準：compose parity 測試通過且新服務沒有 `ports:`、沒有 Bot Token 與 data 掛載、不是 privileged、沒有 Docker socket；release.yml 的 sed 會把新服務的映像一起釘版；改到 install.sh 時 `npm run test:installer` 通過。
- 驗證：擴充 `tests/docker/` 的靜態測試；`docker build` 確認 cloudflared 可執行。
- 狀態：✅ 完成（2026-11-17）
- 證據：
  - 產出：
    - `Dockerfile` base stage 安裝 cloudflared 2026.11.0（linux-amd64），同一條 RUN 先 `sha256sum -c` 再 `install` 到 `/usr/local/bin/cloudflared`。雜湊經兩方對照相同：GitHub release asset 公布的 digest，與本機下載後 `sha256sum` 的結果。
    - `docker-compose.yml` 與 `docker-compose.release.yml` 同步新增 `tunnel-manager` 服務：沿用主映像，命令 `node dist/tunnel-manager.js`，不讀 `.env`，只掛 `tunnel_key` volume，沒有 `ports:`，有 `no-new-privileges`、`cap_drop: ALL`，`mem_limit` 256m、`pids_limit` 256，並設 healthcheck，以「沒帶金鑰回 401」判定在線。
    - telenexus 的 Compose 設定：面板設 `PANEL_BIND=0.0.0.0`、`PANEL_PORT=3040`，只在容器網路上，`ports:` 仍只有 Web Console；以唯讀掛 `tunnel_key`。因為自己列 volumes 會蓋掉共用清單，所以重列全部共用掛載，由測試核對一個都沒少。
    - `docker-compose.dev.yml`：tunnel-manager 以 `npx tsx src/tunnel-manager.ts` 執行，因為 dev stage 沒有 `dist/`。
    - `scripts/docker-entrypoint.sh`：設有 `TUNNEL_KEY_FILE` 時，把金鑰目錄交給 node；唯讀掛載時 chown 失敗會略過。這是 Task 3.1 交接的 L-08。
    - `.env.example`：加入 `PANEL_ENABLED`，並說明 3040 由 compose 固定。
    - `install.sh` 不必改：升級時以 bundle 覆蓋 `docker-compose.yml`，再執行 `up -d`，不逐一列出服務。`npm run test:installer` 通過。
  - 測試：`tests/docker/tunnel-manager-compose.test.ts`（10 支），以 js-yaml 解析兩份 compose。檢查項目：
    - Dockerfile 的釘版、驗雜湊順序，不用 latest，不用 `curl | sh`。
    - 新服務的邊界。
    - telenexus 的面板設定與金鑰掛載。
    - agent-runner 拿不到金鑰。
    - 模擬 `release.yml` 的 sed 之後，所有 `image:` 都已釘版，tunnel-manager 也一起釘。
    - entrypoint 的金鑰目錄處理。
    - `.env.example`。
  - 紅燈：`# tests 10`、`# fail 10`。綠燈：`tests/docker/*.test.ts` 共 `# pass 50`；`docker compose config -q` 對三種組合都通過：dev、release、dev 加上 dev overlay。
  - 變異檢查（還原後 `cmp` 確認相同），8 種都被抓到，各 1 支失敗：
    - tunnel-manager 開主機連接埠
    - tunnel-manager 讀 `.env`
    - tunnel-manager 掛 data
    - telenexus 可寫金鑰
    - telenexus 漏掉共用掛載
    - 面板只聽 loopback
    - Tunnel 接 3030
    - 拿掉 KILL
  - 映像實測：`docker build` exit 0。以與 compose 相同的 caps 用 `docker run` 檢查，暫存 volume，不用 compose、不開 Telegram：
    - `cloudflared --version` 輸出 2026.11.0。
    - tunnel-manager 主程序以 PUID 對齊後的 node 執行；金鑰目錄與檔案都屬 node，檔案權限 600。
    - healthcheck 命令 exit 0（401）；帶金鑰查狀態回 `{"status":"stopped","generation":0}`。
    - 唯讀掛載的另一個容器以 node 讀得到 43 bytes 的金鑰，寫不進去；沒掛 volume 的容器沒有金鑰。
  - 實測發現：
    - 原本照其他服務的 cap 集合，以 root 執行的 tini 無法把 SIGTERM 轉給非 root 主程序：`[FATAL tini (1)] … Operation not permitted`，`docker stop` exit 1，cloudflared 會被直接殺掉。tunnel-manager 因此多給 `KILL`；加上後 `docker stop` exit 0，耗時 0.08 秒。
    - 同一個問題也存在於既有的 telenexus 與 agent-runner：同樣 caps，以最小程式重現 exit 1；加上 `KILL` 後收到 SIGTERM、exit 0。這不在本 issue 範圍，沒有修改，已回報使用者。對本 issue 的影響是 telenexus 停止時不會還原選單按鈕；重啟時的 `boot()` 會還原。
  - 交付檢查：
    - `npm run build` exit 0；`npm run lint` exit 0。
    - `npm run test` exit 0，`# tests 949`、`# pass 949`，比 Task 4.1 後的 939 多 10 支；測試檔 104 個（多 1 個）（L-01）。
  - 限制：沒有用 compose 起完整 stack。容器之間的連線（telenexus:3040、tunnel-manager:8790）與真實 Quick Tunnel 留給 Task 5.2。

#### Task 5.2 — 合併前的真實 Quick Tunnel 外部檢查
- 產出與範圍：在本機起 tunnel-manager 與一個只有面板伺服器、不開 Telegram polling 的 telenexus（避免與正式 Bot 409），開一次真實 Quick Tunnel，從外部 `curl`。資料全為合成，網址只開幾分鐘；啟動時機由使用者決定。
- 相依：Task 1.2、Task 3.1、Task 5.1
- 驗收編號：風險證據（README 首要驗證）；SCN-001、SCN-002 的外部面
- 完成判準：公開網址的面板頁回 200；`/api/chat`、`/api/memory/export`、`/` 回 404；未登入呼叫 `/panel-api/*` 被拒；`/panel_close` 等效操作後網址失效。
- 驗證：觀測式證據，記命令與狀態碼（不記網址）；反向自檢：先確認同一組 `curl` 對 3030 的 Web Console 會回 200，證明判準抓得到失敗。
- 狀態：✅ 完成（2026-11-17，使用者核准當天執行）
- 證據：
  - 做法調整：計畫原本要起「不開 Telegram polling 的 telenexus」，但 `src/main.ts` 沒有只開面板的模式，所以改在主機上直接啟動實際元件，效果相同，也不會與正式 Bot 產生 409：
    - 測試腳本放在 scratchpad，不進 repo，因為裡面有本機路徑。腳本內以真實的 `startPanelServer()` 起面板，使用合成 Bot Token、合成模型清單與暫存設定目錄，不碰 repo 的 `data/` 與正式部署。
    - 以 `npx tsx src/tunnel-manager.ts` 起真的 tunnel-manager 進入點，cloudflared 用 Task 5.1 驗過 sha256 的 2026.11.0。
    - 以真的 `TunnelClient` 經內部 API 啟停 Tunnel。全程不連 Telegram。
  - 反向自檢：同一組 curl 判準先套在「所有路徑都回 200」的合成服務上（模擬 Tunnel 接到沒有保護的服務），11 項中有 9 項判 FAIL，判準抓得到失敗。計畫原本要對 3030 的 Web Console 做這一步，改用合成服務是為了不碰正式部署的資料。
  - 公開網址：`tunnel start` 回 ready（generation=1），耗時 7.4 秒，網址形式為 `https://<隨機>.trycloudflare.com`，網址不記錄。從主機經 Cloudflare 執行 `curl`，11 項全部符合：
    - `GET /panel/`、`GET /panel/health`：200
    - `GET /`、`POST /api/chat`、`GET /api/memory/export`、`GET /api/health`：404
    - 未登入的 `GET /panel-api/state`、`POST /panel-api/apply`、帶假 Bearer、`?token=` 網址參數、`/panel-api/constructor`：401
  - 經公開網址的完整流程：以合成 initData 登入 200，帶憑證讀 state 200，套用 `mock/b` 200，暫存目錄的 override 檔內容為 `model: mock/b`。
  - 關閉：`tunnel stop` 回 stopped（generation=2）。5 秒後同一網址 `GET /panel/health` 回 530（Cloudflare 找不到 Tunnel），網址已失效。`pgrep` 確認 cloudflared 程序為 0，腳本結束後也沒有殘留 tunnel-manager。暫存目錄、金鑰與含網址的 log 都已刪除。
  - 過程中的錯誤（都出在測試腳本，產品程式沒有改）：
    - 第一次執行用同步的 `execFileSync` 呼叫 curl，卡住同一程序裡面板與合成服務的事件迴圈，全部逾時；腳本又被外層 timeout 中止，留下 tunnel-manager 與 cloudflared。以 `pgrep -af` 逐一確認 PID 屬於本次測試後，對它們的程序群組送 SIGTERM，清理乾淨。
    - 第二次執行判準全部正確，但「殘留 cloudflared」的檢查讓 `pgrep -f` 比對到自己的 `sh -c` 命令列，誤報 1。改用 `[c]` 寫法後第三次執行，總判定 PASS。
    - 每次執行都只開一個網址，都在 1 分鐘內關閉。
  - 限制：沒有經過 Telegram 客戶端（initData 是合成的），容器網路上的 compose 連線（`telenexus:3040`、`tunnel-manager:8790`）沒有在 compose stack 中實測，都留給 Task 5.4 發版後以正式 Bot 驗收。

#### Task 5.3 — 常青文件
- 產出與範圍：依 project.md「常青文件更新責任」更新 `README.md`、`ARCHITECTURE.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`.env.example`、`docs/configuration-reference.md`、`docs/runtime-boundary-and-security.md`（公開面與授權模型）、`docs/installation.md`、`docs/README.md`；`docs/web-console-reference.md` 只在動到 Web Console 時更新。
- 相依：Task 3.2、Task 4.1、Task 5.1
- 驗收編號：交付成果
- 完成判準：文件描述與實際行為一致，不宣稱正式部署已上線。
- 驗證：靜態檢查（`prettier --check`、連結）。
- 狀態：✅ 完成（2026-11-17）
- 證據：
  - 更新：
    - `README.md`：核心能力、模型管理指令表加 `/panel`、`/panel_close` 與面板說明，本機開發補 tunnel-manager。順手把 `/models`「列出可用模型」改成「列出不代表可以呼叫」。
    - `ARCHITECTURE.md`：互動層、`main.ts` 啟動順序、新增「模型設定與面板」模組節、資料流「4. 模型面板」、Runner 模式補輔助服務。
    - `CLAUDE.md`：服務拓撲補 tunnel-manager 與 KILL 的理由；Key Modules 加 `model-config`、`panel-server`、`panel-auth`、`panel-controller`、`src/tunnel/*`。
    - `CONTRIBUTING.md`：開發流程補 tunnel-manager 與 `panel-public` 的建置。
    - `docs/configuration-reference.md`：「model 切換」一節原本還寫 `/set_model` 直接改 `ai-config.yaml`，已依 #29／#30 後的實際行為重寫；新增「模型面板」一節與變數表。
    - `docs/runtime-boundary-and-security.md`：新增「模型面板與 Quick Tunnel」一節，涵蓋公開面、授權、生命週期、tunnel-manager 邊界與已知限制；Tier 2 硬化補 tunnel-manager。
    - `docs/installation.md`：映像共用說明；升級一節補 tunnel-manager、預設啟用與停用方式。
    - `docs/README.md`：Telegram UX 加面板文件指引，移除「尚未實作」的舊條目。
    - `.env.example`：Task 5.1 已更新。
    - 不更新的文件：`docs/web-console-reference.md`，Web Console 沒有變動。
  - 內容核對：面板回覆、選單按鈕文字、閒置與中斷通知、30 分鐘、10 分鐘與 60 秒、`/models` 最多 40 個，都從原始碼取值。文件沒有宣稱正式部署已上線（`git diff` 新增行 grep「已上線、已部署、已發版」無結果），安全一節不描述任何正式部署的設定。
  - 靜態檢查：
    - `prettier --check`：HEAD 時已經乾淨的 `README.md`、`ARCHITECTURE.md`、`CONTRIBUTING.md`、`docs/runtime-boundary-and-security.md`、`docs/README.md` 全部通過。
    - `CLAUDE.md`、`docs/configuration-reference.md`、`docs/installation.md` 在 HEAD 就不符合 prettier，沒有整檔重排，以免把無關的格式差異混進來。
    - 相對連結與錨點：以腳本檢查 7 份文件，沒有失效，包含新加的 `#模型面板與-quick-tunnelissue-0030`。
  - 限制：Task 5.2 的真實 Tunnel 檢查若發現行為差異，要回頭修這些文件。

#### 審查修正輪（review-87b6cf6，2026-11-17）
- 範圍：review-87b6cf6 的 M1、S1、N1～N10，使用者 2026-11-17 決定同一輪處理（README 待確認事項）。不改核准的 Scenario。
- 紅燈（先寫測試，在 87b6cf6 的程式上跑）：`npx tsx --test tests/command-router-panel.test.ts tests/panel-controller.test.ts tests/tunnel/tunnel-manager.test.ts` 41 支 5 支失敗；`tests/web/panel-server.test.ts tests/web/panel-api.test.ts` 21 支 2 支失敗。
  - M1：Web Console 形狀的 `/panel`、`/panel_close`（`platform: 'console'`、沒有 `telegram`），以及沒有 `chatType` 的訊息，要回覆只能在私聊使用、不呼叫 open／close。失敗。
  - N1：`menu.show` 進行中與 `client.start` 進行中各被 `/panel_close` 一次，開啟結果要是失敗、不留下已發布的入口、選單最後是一般選單，之後的輪詢不發中斷通知。兩支都失敗。
  - N2：沿用入口時要重送一次選單（既有測試的期望呼叫順序加一筆 show）。失敗。
  - N9：假 cloudflared 先印含 `https://api.trycloudflare.com/...` 的錯誤訊息，再印真網址，取到的要是真網址。失敗。
  - N6：登入失敗的回應要剛好是 `{ ok: false, error: 'unauthorized' }`。失敗。
  - N7：`/panel-api/session` 登入後也要 404。失敗。
  - S1、N3、N4、N5：產品程式原本就正確，新測試直接綠燈，以下方突變確認測試抓得到。
    - S1：假 cloudflared `slow-term` 模式 `trap` SIGTERM、1 秒後才退出，stop 期間健康檢查回成功。
    - N3：狀態查詢進行中被關閉，查詢回來後不再處理也不丟錯。
    - N4：自訂 staticDir 放隱藏檔、子目錄、大寫、`.txt` 與含 `%2f` 的 `.js` 路徑，都要 404 且讀不到內容。
    - N5：body 超過上限只接受 413。
- 修正：
  - M1：`src/core/command-router.ts` 的 `panelDenied()` 改成只看 `msg.telegram?.chatType === 'private'`，沒有 telegram 欄位的訊息一律拒絕。
  - N1、N2：`src/services/panel-controller.ts` 加 `closes` 計數，`close()` 與 `boot()` 遞增；`doOpen()` 在 `start` 之後、`show` 之後各比對一次，被關閉就放棄並在 show 之後再還原選單。沿用時也重送 `show`；`show` 失敗一律作廢憑證與已發布狀態再停 Tunnel。
  - N6：`src/web/panel-server.ts` 登入失敗只回 `unauthorized`，原因用 `console.warn` 記錄。
  - N7：移除 `session` 路由與路由 context 的 `userId`；伺服器測試改用 `state` 當受保護路由。
  - N8：新增 `src/web/panel-paths.ts`（`PANEL_PATH`、`HEALTH_PATH`、`PANEL_SERVICE`），panel-server、panel-controller、tunnel-manager 進入點共用。
  - N9：`src/tunnel/tunnel-manager.ts` 的 `URL_PATTERN` 排除 `api.` 子網域。
  - N10：`docs/configuration-reference.md` 改寫 `.env` 與 compose 固定值的說明；README 兩段過時文字改成現況。另在 `docs/runtime-boundary-and-security.md` 補「登入失敗不透露原因」。
- 突變（各自還原後重跑，以 `git diff --quiet` 確認還原）：
  - M1 條件還原成審查前的 `msg.telegram && chatType !== 'private'`：1 支失敗。
  - N1 拿掉 start 後的比對：1 支失敗；拿掉 show 後的比對：1 支失敗；show 後被關閉時不再還原選單：1 支失敗（測試在 show 完成時才記錄呼叫，模擬 Telegram 實際套用的時間點）。
  - N2 沿用時不重送：1 支失敗。
  - N3 拿掉 poll 在 await 之後的重新檢查：1 支失敗。
  - S1 拿掉健康檢查後的 attempt 比對：1 支失敗。
  - N4 白名單放寬成 `/^[A-Za-z0-9.\/%-]+\.(html|js|css)$/`：1 支失敗。
- 重構：Prettier 格式化；`resetMenu()` 由 `close()` 與開啟途中被關閉兩處共用。其餘 no-op。
- 影響範圍：GitNexus 索引早於本分支，新符號查不到，改以 grep 核對。`panelDenied` 只有 `/panel`、`/panel_close` 兩個呼叫點；`PanelController.open／close` 只經 `src/main.ts` 接到 router；前端 `app.js` 沒有用到 `reason` 或 `session`。
- 交付檢查：
  - `npm run lint` exit 0；`npm run build` exit 0。
  - `npm run test` exit 0，`# tests 957`、`# pass 957`，比 87b6cf6 的 949 多 8 支（router 1、controller 3、tunnel-manager 2、panel-api 2）；測試檔仍 104 個（L-01）。

#### 第二修正輪（review-6d0d27c NICE TO HAVE，2026-11-17）
- 範圍：使用者決定修 N1'、補 N2' 的守門測試；N3' 不處理（README 待確認事項）。
- 紅燈（先寫測試，在 6d0d27c 的程式上跑）：`npx tsx --test tests/panel-controller.test.ts` 22 支 2 支失敗。
  - 換新入口時選單設定失敗：停掉 Tunnel 後要呼叫 reset。失敗（原本不還原）。
  - 沿用入口時重送選單失敗：回報入口仍有效，不呼叫 stop、reset，既有憑證仍有效。失敗（原本拆掉入口）。
  - N2'：start 進行中呼叫 `boot()`，開啟失敗、不呼叫 show。原程式就正確，直接綠燈，以突變確認。
  - 另補一支：沿用入口重送選單期間被關閉，即使重送失敗也不能回報入口有效。
- 修正：`src/services/panel-controller.ts` 的 show 失敗處理。沿用且期間沒被關閉時，只記 `panel:menu-button`、更新活動時間，回報沿用；否則照舊作廢憑證、停 Tunnel，再多呼叫一次 `resetMenu()`。
- 突變（各自還原後重跑）：沿用失敗照舊拆掉入口：1 支失敗；沿用失敗不比對關閉：1 支失敗；換新入口失敗不還原選單：1 支失敗；`boot()` 不遞增計數：1 支失敗。
- 重構：Prettier 格式化，其餘 no-op。
- 交付檢查：`npm run lint` exit 0；`npm run build` exit 0；`npm run test` exit 0，`# tests 961`、`# pass 961`，比 6d0d27c 的 957 多 4 支；測試檔仍 104 個（L-01）。

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
