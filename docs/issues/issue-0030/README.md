# Issue 0030 - Telegram Mini App 切換 provider／model

GitHub：https://github.com/raybird/telenexus/issues/30

## 目標
在 Telegram 私聊中按需開啟 Mini App，方便選擇 OpenCode 的 provider 與 model；部署沿用 Docker Compose，無須自有網域或固定 HTTPS 網址。

## 需求來源與範圍
2026-11-15 討論：
- 使用者要求以 cloudflared 臨時 Tunnel 動態取得 HTTPS 網址，再更新 Telegram 入口。
- 必須能在目前 Docker Compose／container 架構運作。
- 使用者明確表示：「聊天串流與即時更新可以不用，然後主要是可以方便切換 provider 與 model」。
- 使用者要求「根據目前這樣的討論在 github 開此 issue」。
本 issue 記錄需求與初始規劃，尚未實作，不代表已授權發版或修改正式部署。

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
- 新增獨立 tunnel-manager Compose 服務，管理程序常駐，cloudflared 子程序按需啟停。
- 透過 Docker 內部、具認證的受限 API 供 telenexus 呼叫；不公開管理埠，不掛載 Docker socket，不使用 privileged／host network。
- Tunnel 目標使用 http://telenexus:3030，不能使用管理容器自己的 localhost。
- 只在網址健康後更新 setChatMenuButton；重複 /panel 沿用健康連線，啟動失敗不發布壞網址。
- 驗證原始 Telegram initData 簽章、auth_date 與 ALLOWED_USER_ID，換發短效憑證；API 以已驗證身分授權。
- 新管理 API 不得因缺少 WEB_AUTH_TOKEN 或代理／內網信任而放行；Bot Token、登入憑證不得置於公開網址。
- 模型讀取／列舉／套用／重設抽成共用服務，供原指令與 Web 使用；採驗證後的安全寫入，寫入失敗保留舊設定。
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

  @SCN-002
  Scenario: 拒絕未授權的模型管理
    Given 使用者沒有有效登入憑證
    When 使用偽造或過期 initData 或非白名單帳號存取管理功能
    Then 登入或 API 操作被拒絕
    And 模型設定不變且不啟動未授權 Tunnel
    And 內網或反向代理路徑不能繞過授權

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
    When 管理員輸入 /panel_close 或 Tunnel 意外退出
    Then 系統清除失效的啟用狀態並恢復一般選單
    And 重新輸入 /panel 可取得健康入口
    And 不宣稱已送出的歷史按鈕會自動更新
```

## Gherkin 核准紀錄

- **核准 commit**: 待提交
- **核准來源**: 2026-11-15 使用者：「聊天串流與即時更新可以不用，然後主要是可以方便切換 provider 與 model」及「可以根據目前這樣的討論在 github 開此 issue」。已授權建單；完整 Scenario 含工程推導的失敗行為，暫列草案，未宣稱逐項核准或授權實作。

| Scenario | 核准日期 | 狀態 |
|---|---|---|
| SCN-001 | - | 待核准 |
| SCN-002 | - | 待核准 |
| SCN-003 | - | 待核准 |
| SCN-004 | - | 待核准 |
| SCN-005 | - | 待核准 |

## 風險與首要驗證

- **最大風險**：未授權使用者或代理信任繞過管理驗證，讀寫全域模型設定。
- **風險等級與理由**：High；暫時公開管理入口且可修改後續聊天／排程模型。
- **首要驗證**：先建立登入與授權負向契約／整合測試，再使用獨立測試 Bot 驗證真實 Tunnel、Menu Button 與 Mini App。
- **選擇理由**：負向契約測試比直接開放完整面板更直接覆蓋越權風險；真實最小切片另確認動態網域在 Telegram 客戶端可登入，不能由 mock 推定。
- **完成證據**：偽造、過期、非白名單、無憑證與代理繞過均拒絕且設定未變；健康新網址可開啟且換網域後可重新登入。上述均尚未執行。

## 實作計畫

任務與證據僅維護於 [implementation-plan.md](./implementation-plan.md)。

## 不在本次範圍
- Mini App 聊天、SSE、即時更新。
- 排程管理、記憶管理、Docker 更新或重啟介面。
- API key 編輯、provider 登入／OAuth；沿用現有 OpenCode 認證。
- 新 agent 引擎、多使用者角色系統、固定網域／Main Mini App 設定。
- 自動模型測試或額外計費請求；手動模型探測按鈕僅為後續可選提案。

## 待確認事項
- TBD-4：SCN-001～005 完整草案待核准；依 acceptance.md，在主要成功及重要失敗路徑核准前不得開始依賴它們的實作。
- TBD-1：閒置自動關閉的預設時間、活動定義及進行中設定操作的保護；實作此行為前確認，暫不列已核准 Scenario。
- TBD-2：OpenCode 清單如何辨識已認證供應商、快取與刷新方式，實作前查證；UI 不得把目錄清單當認證成功。
- TBD-3：真實驗證用獨立測試 Bot 與 iOS／Android 客戶端窗口；不得與正式 Bot 共用 polling token。
- 主機與整組 Compose 必須正在運行；不含從停機狀態遠端喚醒。

## 驗證策略
實作取得 Scenario 對應的紅綠重構證據，涵蓋驗證／權限、設定安全寫入、生命週期與 Web 整合；實機驗證使用隔離測試 Bot。
交付檢查 npm run build、npm run test、npm run lint；若改安裝升級流程加跑 npm run test:installer，並驗證 Compose parity、預建映像與 bundle。

## 涉及檔案

預計最小邊界，新增模組名稱於實作拆解時確定：
- `src/core/command-router.ts`、`src/core/config-loader.ts`、新共用模型設定服務：沿用指令及 override。
- `src/connectors/telegram.ts`、`src/main.ts`：管理入口與初始化。
- `src/web/server.ts`、`src/web/public/`：Telegram 登入、管理 API 與手機面板。
- 新 `tunnel-manager/` 服務目錄、`docker-compose.yml`、`docker-compose.release.yml`：內部管理與 Tunnel 生命週期。
- `.github/workflows/release.yml`、`scripts/install.sh` 及既有 bundle 打包入口：新增服務的映像與安裝交付，僅變更必要部分。
- `tests/`：授權、設定、生命週期、Web 與 Compose／bundle 整合驗證。
- `README.md`、`ARCHITECTURE.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`.env.example`、`docs/configuration-reference.md`、`docs/web-console-reference.md`、`docs/runtime-boundary-and-security.md`、`docs/installation.md`：依實際交付同步常青說明。
- `docs/README.md`：新增 issue 文件索引。
不變更排程／記憶管理功能、provider 認證儲存與正式部署資料。

## Timeline

| 日期 | 異動 | 負責人 |
|---|---|---|
| 2026-11-15 | 依對話建立 GitHub #30 與初始需求草案，未開始實作 | Codex |

**建立日期**: 2026-11-15
**分級**: Large
**風險**: High
**狀態**: 已建單；驗收草案待核准，尚未實作

## 參考
- [Cloudflare Quick Tunnels 與限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [Telegram setChatMenuButton](https://core.telegram.org/bots/api#setchatmenubutton)
- [Telegram Mini App 登入驗證](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
