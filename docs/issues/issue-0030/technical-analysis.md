# Issue 0030 技術分析

## 技術可行性
- 新增獨立 tunnel-manager Compose 服務，管理程序常駐，cloudflared 子程序按需啟停；沿用主映像、換啟動命令，不放 Bot Token、不掛 data（2026-11-17 Q2）。
- 透過 Docker 內部、具認證的受限 API 供 telenexus 呼叫；不公開管理埠，不掛載 Docker socket，不使用 privileged／host network。
- Tunnel 目標是 telenexus 的面板專用連接埠（只在 Docker 內網、只有面板頁與面板 API），不接 3030 的 Web Console，也不能用管理容器自己的 localhost（2026-11-17 Q1，理由見 README）。
- 只在網址健康後更新 setChatMenuButton；重複 /panel 沿用健康連線，啟動失敗不發布壞網址。
- 驗證原始 Telegram initData 簽章、auth_date 與 ALLOWED_USER_ID，換發短效憑證；API 以已驗證身分授權。
- 新管理 API 不得因缺少 WEB_AUTH_TOKEN 或代理／內網信任而放行；Bot Token、登入憑證不得置於公開網址。
- 模型讀取／列舉／套用／重設抽成共用服務，供原指令與 Web 使用；採驗證後的安全寫入，寫入失敗保留舊設定。
- 保留既有 Telegram long polling；不需要改成 webhook。前端與 API 同源並用相對路徑。
- 開發與 release Compose 同步；新增映像及部署檔須納入 release bundle／安裝升級機制。

## 方案選型與取捨
- 固定網域／Named Tunnel 對比 Quick Tunnel：使用者目前無固定 HTTPS 網域，採後者；接受網址會變、沒有可用性保證，透過 /panel 重新取得入口。
- 主容器直接執行 cloudflared 對比獨立管理容器：採獨立服務，隔離子程序與依賴，保留 Bot 及 Runner 職責。Bot 不透過 Docker socket 控制容器。獨立服務沿用主映像而非另建映像，release.yml 不多一條建置（2026-11-17 Q2）。
- 每次改 ai-config.yaml 對比沿用 override：採現有 data override，避免寫入唯讀 base 掛載；與 Telegram 原有指令共用服務，避免兩套設定規則。
- SSE 對比一般 HTTP：使用者已排除聊天串流及即時更新，只需查詢、手動刷新、套用及重設；不新增輪詢聊天或背景 AI 工作。

## 架構影響
Bot 增加受限 Tunnel 客戶端；Web 增加 Telegram 登入與模型 API；Compose 增加內部管理服務及發版映像。不更換 agent 引擎、不重構排程或記憶流程。全域 model 同時影響共用設定的聊天與排程，面板須明示。

## 實作細節與待釐清
- 狀態至少能辨識停止、啟動中、就緒、失敗；並行 /panel 應共用啟動流程。有效網址僅健康後發布。
- 僅驗證後的帳號可操作；空 Web token、Host／轉送 IP 不得成為新 API 的授權途徑。
- 寫入應驗證並避免半寫入／競態；不可透過任意 shell 字串執行模型或 Tunnel 命令。
- 前端與 API 同源，相對路徑適應換網域；不把舊網域的登入狀態視為可繼承。
- 公開面只有面板專用連接埠，既有 Web API 不在上面；測試要證明該連接埠對既有路由一律回 404（SCN-002）。
- 待決項集中於 [README 的待確認事項](./README.md#待確認事項)，不在此建立平行決策清單。

## 外部契約
- [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [setChatMenuButton](https://core.telegram.org/bots/api#setchatmenubutton)
- [initData 驗證](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
