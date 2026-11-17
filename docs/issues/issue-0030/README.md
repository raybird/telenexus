# Issue 0030 - Telegram Mini App 切換 provider／model

GitHub：https://github.com/raybird/telenexus/issues/30

## 目標
在 Telegram 私聊中按需開啟 Mini App，方便選擇 OpenCode 的 provider 與 model；部署沿用 Docker Compose，無須自有網域或固定 HTTPS 網址。

## 現況

**現行 review**: review-87b6cf6.md

| 外部狀態 | 查證命令 | 上次結果 | 查證日期 |
|---|---|---|---|
| GitHub issue #30 | `gh issue view 30 --repo raybird/telenexus --json state -q .state` | OPEN | 2026-11-17 |

## 需求來源與範圍
2026-11-15 討論：
- 使用者要求以 cloudflared 臨時 Tunnel 動態取得 HTTPS 網址，再更新 Telegram 入口。
- 必須能在目前 Docker Compose／container 架構運作。
- 使用者明確表示：「聊天串流與即時更新可以不用，然後主要是可以方便切換 provider 與 model」。
- 使用者要求「根據目前這樣的討論在 github 開此 issue」。
本 issue 記錄需求、規劃與實作證據；實作在分支 `feat/telegram-model-panel`，不代表已授權發版或修改正式部署。

## 文件清單

- [需求與現況分析](./requirement-analysis.md)
- [技術方案與取捨](./technical-analysis.md)
- [Implementation Plan（任務唯一來源）](./implementation-plan.md)

## 預期操作
/panel → 驗證管理員 → 建立或沿用健康 Tunnel → 驗證外部 HTTPS 可達 → 更新私聊「模型設定」Mini App 按鈕 → Telegram 登入驗證 → 選 provider／model → 套用或恢復預設。
用完可透過 /panel_close 關閉；閒置自動關閉的具體門檻列於待確認事項。

面板提供：
- 目前有效 provider／model，以及 base／override 來源。
- Provider 篩選、model 搜尋與完整模型 ID。
- 套用、恢復預設、手動重新整理清單。
- 清楚標示「全域設定；後續新呼叫生效；進行中任務不變」。
- 清單列出不代表認證、額度或模型服務已驗證可用；不得把列出狀態顯示成測試成功。

## 初始技術方案
- 新增獨立 tunnel-manager Compose 服務，管理程序常駐，cloudflared 子程序按需啟停。沿用主映像（Dockerfile 加入 cloudflared，換啟動命令），release.yml 不多建映像；這個容器不放 Bot Token、不掛 data（2026-11-17 Q2）。
- 透過 Docker 內部、具認證的受限 API 供 telenexus 呼叫；不公開管理埠，不掛載 Docker socket，不使用 privileged／host network。
- Tunnel 目標是 telenexus 另開的面板專用連接埠：只在 Docker 內網聽、不在 Compose `ports:` 對主機開放，只提供面板頁與面板 API；不接 3030，也不能用管理容器自己的 localhost（2026-11-17 Q1）。理由（2026-11-17 查證程式）：`isAuthorized()`（`src/web/server.ts`）在 `WEB_AUTH_TOKEN` 空白（Compose 預設）時放行；開啟 `WEB_TRUST_PRIVATE_NETWORK` 時，來源是私有 IP（可由 `X-Forwarded-For` 偽造）或 Host 是內網也放行。cloudflared 從 Docker 內網連入，接 3030 時只要部署屬於這兩種設定之一，`/api/chat`、`/api/memory/export`、排程 API 就對外公開。
- 只在網址健康後更新 setChatMenuButton；重複 /panel 沿用健康連線，啟動失敗不發布壞網址。
- 驗證原始 Telegram initData 簽章、auth_date 與 ALLOWED_USER_ID，換發短效憑證；API 以已驗證身分授權。
- 新管理 API 不得因缺少 WEB_AUTH_TOKEN 或代理／內網信任而放行；Bot Token、登入憑證不得置於公開網址。
- 模型讀取／列舉／套用／重設抽成共用服務，供原指令與 Web 使用；採驗證後的安全寫入，寫入失敗保留舊設定。
- `/model` 目前自己讀兩個設定檔（`src/core/command-router.ts`），與 `loadAiConfig()` 有兩處差異（2026-11-17 自 #29 TBD-1 併入，SCN-006）：`model` 不是字串時 `/model` 回「❌ 無法讀取設定檔」，`loadAiConfig()` 則忽略該值、改用另一個檔；`ai-config.yaml` 的位置 `/model` 以 `APP_PROJECT_DIR` 為準，`loadAiConfig()` 預設相對於目前目錄（正式映像兩者都是 `/app`）。改用共用服務後，指令、面板與實際呼叫看到的是同一個有效模型。
- 保留既有 Telegram long polling；不需要改成 webhook。前端與 API 同源並用相對路徑。
- 開發與 release Compose 同步；新增映像及部署檔須納入 release bundle／安裝升級機制。

## Gherkin 驗收劇本
```gherkin
Feature: 按需開啟的 Telegram 模型切換面板

  @SCN-001
  Scenario: 在無固定網域的 Compose 部署開啟面板
    Given Bot 正在運作且使用者為允許的管理員
    When 使用者輸入 /panel
    Then 系統建立或沿用健康 Tunnel 並提供可開啟的 HTTPS Mini App 按鈕
    And 不需要手動修改 BotFather 或重啟主服務
    And 啟動失敗時回報失敗且不發布無效的新入口
    And tunnel-manager 服務不存在或啟動逾時時回報原因，不發布新入口

  @SCN-002
  Scenario: 拒絕未授權的模型管理
    Given 使用者沒有有效登入憑證
    When 使用偽造或過期 initData 或非白名單帳號存取管理功能
    Then 登入或 API 操作被拒絕
    And 模型設定不變且不啟動未授權 Tunnel
    And 內網或反向代理路徑不能繞過授權
    And 從公開網址只取得到面板頁與面板 API，既有 Web Console 的頁面與 /api/* 一律取不到，不論 WEB_AUTH_TOKEN 與 WEB_TRUST_PRIVATE_NETWORK 怎麼設
    And 換新網址或入口關閉後，舊的登入憑證不能再使用

  @SCN-003
  Scenario: 選擇供應商與模型
    Given 管理員已登入面板
    When 載入清單並選擇 provider 與搜尋 model
    Then 面板顯示對應完整模型 ID 與目前有效設定及其來源
    And 清單失敗或為空時顯示明確結果
    And 不把清單存在視為實際呼叫成功

  @SCN-004
  Scenario: 套用與恢復全域模型設定
    Given 管理員已選擇模型且理解全域影響範圍
    When 套用模型或恢復預設
    Then 後續讀取共用設定的新呼叫使用選定模型或基礎預設
    And 不需要重啟容器且進行中的任務不被改換模型
    And 容器重建後保留設定
    And 無效輸入或寫入失敗時不破壞原設定

  @SCN-005
  Scenario: 關閉或重建動態入口
    Given Tunnel 已啟動
    When 管理員輸入 /panel_close、面板連續 30 分鐘沒有經過驗證的請求，或 Tunnel 意外退出
    Then 系統清除失效的啟用狀態並恢復一般選單
    And 正在寫入設定時不因閒置而關閉
    And 重新輸入 /panel 可取得健康入口
    And 不宣稱已送出的歷史按鈕會自動更新

  @SCN-006
  Scenario: 指令與面板顯示的有效模型與實際呼叫一致
    Given ai-config.yaml 與 data/ai-config.override.yaml 的 model 可能空白、不是字串或 YAML 壞掉
    When 使用者輸入 /model 或在面板查看目前設定
    Then 顯示的有效模型與來源，和後續新呼叫實際使用的模型相同
    And 某個檔的 model 不合法時照合併規則改用另一個檔，不回報「無法讀取設定檔」
```

## Gherkin 核准紀錄

- **核准 commit**: 2d23d19
- **核准來源**: 2026-11-15 使用者：「聊天串流與即時更新可以不用，然後主要是可以方便切換 provider 與 model」及「可以根據目前這樣的討論在 github 開此 issue」（授權建單）。2026-11-17 逐題確認：Q1 選「面板專用的連接埠」（建議，SCN-001、002、004）、Q2 選「新服務，沿用主映像」（建議，SCN-001）、Q3 選「30 分鐘無操作」（建議，SCN-005）、Q4 選「發版後用正式 Bot 驗」（SCN-001、002、005 的真機證據）；之後對修改後的 SCN-001～006（SCN-001 加 tunnel-manager 不存在／逾時、SCN-002 加公開網址只有面板與舊憑證失效、SCN-005 加 30 分鐘閒置關閉），連同工程預設與證據安排，回答「照草案核准」；發版後驗收的客戶端選 Android。

| Scenario | 核准日期 | 狀態 |
|---|---|---|
| SCN-001 | 2026-11-17 | 已核准 |
| SCN-002 | 2026-11-17 | 已核准 |
| SCN-003 | 2026-11-17 | 已核准 |
| SCN-004 | 2026-11-17 | 已核准 |
| SCN-005 | 2026-11-17 | 已核准 |
| SCN-006 | 2026-11-17 | 已核准 |

## 風險與首要驗證

- **最大風險**：未授權使用者或代理信任繞過管理驗證，讀寫全域模型設定。
- **風險等級與理由**：High；暫時公開管理入口且可修改後續聊天／排程模型。
- **首要驗證**：先建立登入與授權負向契約／整合測試，以及「公開連接埠只有面板路由」的測試；合併前用本機開發 stack 起一次真實 Quick Tunnel，從外部確認面板頁可達、既有 Web Console 的頁面與 API 取不到（合成資料，網址只開幾分鐘，不碰 Telegram）。Menu Button 與 Mini App 登入在發版、升級後以正式 Bot 於 Android 客戶端驗證（2026-11-17 Q4，沒有測試 Bot）。
- **選擇理由**：負向契約測試比直接開放完整面板更直接覆蓋越權風險；動態網域在 Telegram 客戶端可登入不能由 mock 推定，但使用者選擇不另建測試 Bot，這段改在外部驗收窗取得，合併前以外部可達性檢查與 initData 演算法測試降低風險。
- **完成證據**：偽造、過期、非白名單、無憑證與代理繞過均拒絕且設定未變；公開網址取不到既有 Web Console；健康新網址可開啟且換網域後可重新登入。前三項由 Task 1.2、Task 5.2 取得（見 implementation-plan.md）；換網域後在 Telegram 重新登入留給 Task 5.4（發版後）。

## 實作計畫

任務與證據僅維護於 [implementation-plan.md](./implementation-plan.md)。

## 不在本次範圍
- Mini App 聊天、SSE、即時更新。
- 排程管理、記憶管理、Docker 更新或重啟介面。
- API key 編輯、provider 登入／OAuth；沿用現有 OpenCode 認證。
- 新 agent 引擎、多使用者角色系統、固定網域／Main Mini App 設定。
- 自動模型測試或額外計費請求；手動模型探測按鈕僅為後續可選提案。

## 待確認事項
- TBD-4（已解決，2026-11-17）：SCN-001～006 修改後全部核准，見核准紀錄。
- TBD-1（已解決，2026-11-17 Q3）：面板連續 30 分鐘沒有經過驗證的請求就關閉 Tunnel；活動＝一筆通過驗證的面板 API 請求；正在寫入設定時不關。已寫入 SCN-005。
- TBD-2（已解決，2026-11-17 查證）：正式部署（opencode 1.18.34）的 `opencode models` 只列 nvidia（37 個，`auth.json` 有 API key）與 opencode（13 個，免費層不需憑證），也就是只列有憑證或內建免費的供應商；provider 取模型 ID 第一段。開面板與按「重新整理」時重跑 `opencode models`，不跨次快取；面板仍標示「列出不代表可呼叫」。
- TBD-3（已解決，2026-11-17 Q4）：不建測試 Bot。發版並升級正式部署後，以正式 Bot 在 Android 客戶端驗 /panel、登入、切換、還原、/panel_close 與換網域後重新登入；合併後這段以 `等待外部驗收窗` 記錄，判準即上列項目。發版與升級由使用者決定。
- 工程預設（2026-11-17 隨草案核准）：initData 的 `auth_date` 超過 10 分鐘拒絕登入；登入後換發的憑證只存在記憶體，入口關閉即失效；面板連接埠不對主機開放。
- 主機與整組 Compose 必須正在運行；不含從停機狀態遠端喚醒。
- 審查 review-87b6cf6 M1（已解決，2026-11-17 使用者決定）：`/panel`、`/panel_close` 只允許 Telegram 私聊；Web Console 不算面板的入口，送出時回覆只能在私聊使用。維持已核准的 SCN-002 與 Task 3.2，不修訂規格。
- 審查 review-87b6cf6 其餘發現（2026-11-17 使用者決定）：S1 與 N1～N10 在同一輪一起修正。

## 驗證策略
實作取得 Scenario 對應的紅綠重構證據，涵蓋驗證／權限、設定安全寫入、生命週期與 Web 整合；合併前以本機開發 stack 做一次真實 Quick Tunnel 外部可達性檢查，Telegram 客戶端實測在發版後的外部驗收窗進行（TBD-3）。
交付檢查 npm run build、npm run test、npm run lint；若改安裝升級流程加跑 npm run test:installer，並驗證 Compose parity、預建映像與 bundle。

## 涉及檔案

預計最小邊界，新增模組名稱於實作拆解時確定：
- `src/core/command-router.ts`、`src/core/config-loader.ts`、新共用模型設定服務：沿用指令及 override。
- `src/connectors/telegram.ts`、`src/main.ts`：管理入口與初始化。
- `src/web/server.ts`、`src/web/public/`：Telegram 登入、管理 API 與手機面板。
- tunnel-manager 程式（在 `src/` 內，沿用主映像）、`Dockerfile`（加入 cloudflared）、`docker-compose.yml`、`docker-compose.release.yml`：內部管理與 Tunnel 生命週期。
- `scripts/install.sh` 及既有 bundle 打包入口：新增服務的安裝升級交付，僅變更必要部分；release.yml 不多建映像（Q2）。
- `tests/`：授權、設定、生命週期、Web 與 Compose／bundle 整合驗證。
- `README.md`、`ARCHITECTURE.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`.env.example`、`docs/configuration-reference.md`、`docs/web-console-reference.md`、`docs/runtime-boundary-and-security.md`、`docs/installation.md`：依實際交付同步常青說明。
- `docs/README.md`：新增 issue 文件索引。
不變更排程／記憶管理功能、provider 認證儲存與正式部署資料。

實際交付（2026-11-17）與上列預估的差異：面板依 Q1 改用獨立的 `src/web/panel-server.ts` 與 `src/web/panel-public/`，Web Console 的 `src/web/server.ts`、`src/web/public/` 與 `docs/web-console-reference.md` 都沒有變更；`scripts/install.sh` 不必改。逐 Task 的檔案見 implementation-plan.md。

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-11-17 | 不開 PR；改由獨立 subagent 在本機審查 `main..HEAD`，合併由使用者決定 | 交付方式選「分支＋本機獨立審查 (Recommended)」 | 沒有 GitHub 上的 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|---|---|---|
| 2026-11-15 | 依對話建立 GitHub #30 與初始需求草案，未開始實作 | Codex |
| 2026-11-17 | 依使用者要求併入 #29 的 TBD-1（`/model` 與 `loadAiConfig()` 的解析差異）：新增 SCN-006（待核准），已查證現況補上差異 | 使用者 |
| 2026-11-17 | 逐題確認 Q1～Q4 並核准修改後的 SCN-001～006；TBD-1～4 解決；Tunnel 改接面板專用連接埠、tunnel-manager 沿用主映像；implementation-plan 拆成 Phase 1～5、Task 1.1～5.4 | 使用者 |
| 2026-11-17 | Task 1.1～5.3 完成；經使用者核准執行真實 Quick Tunnel 外部檢查並通過；實測發現 telenexus／agent-runner 缺 `KILL` 時 `docker stop` 收不到 SIGTERM（既有問題，不在本 issue 修）；交付方式選分支＋本機獨立審查 | Claude |
| 2026-11-17 | 獨立審查 review-87b6cf6 判定 RETURN TO execute-task；使用者決定 M1 照核准規格只允許 Telegram 私聊，S1 與 N1～N10 同一輪修正；KILL 問題另開 #31 | 使用者 |
| 2026-11-17 | 審查修正輪完成（M1、S1、N1～N10），證據見 implementation-plan.md「審查修正輪」 | Claude |

**建立日期**: 2026-11-15
**分級**: Large
**風險**: High
**狀態**: 實作中（分支 `feat/telegram-model-panel`；Task 1.1～5.3 完成；剩 Task 5.4 發版後驗收）

## 參考
- [Cloudflare Quick Tunnels 與限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [Telegram setChatMenuButton](https://core.telegram.org/bots/api#setchatmenubutton)
- [Telegram Mini App 登入驗證](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
