# Issue 0030 需求與現況分析

## 需求描述
在 Telegram 私聊中按需開啟 Mini App，方便選擇 OpenCode 的 provider 與 model；部署沿用 Docker Compose，無須自有網域或固定 HTTPS 網址。

需求與核准狀態以 [README](./README.md) 為準；不增加聊天、即時更新或認證管理範圍。

## 現況分析
- TeleNexus 執行引擎固定為 opencode；此處 provider 指 OpenCode 模型供應商，不是新增其他 agent 引擎。
- 現有 /models 呼叫 opencode models，/set_model 寫入 data/ai-config.override.yaml，/reset_model 清除 override。
- 模型設定每次新呼叫重新讀取；override 為全域設定，可能影響後續聊天與排程，不能宣稱僅影響當前 Telegram 對話。
- 主服務與 agent-runner 已共用 data/；ai-config.yaml 是唯讀掛載，應沿用可寫 override。
- 現有 Web API 使用共用 token 與固定使用者，尚無 Telegram initData 登入。
- 目前主映像沒有 cloudflared。
- Quick Tunnel 的隨機 HTTPS 網址可動態更新到 Telegram 私聊 Menu Button，但不支援 SSE，且無可用性保證。

原始碼依據：command-router 的 models／set_model／reset_model、config-loader 的 loadAiConfig、DynamicAIAgent 的每次呼叫讀取與 Runner model 傳遞、Web isAuthorized、Dockerfile 與 Compose 掛載。此為 2026-11-15 本機工作區查證，實作前需重新核對。

## 問題點總結
使用者目前須記住完整模型 ID 並輸入指令；現有 Web 無對應模型管理 API 或 Telegram 身分登入。無固定網域，必須管理臨時 HTTPS 網址與 Telegram 入口的同步。模型目錄並非認證／額度／可呼叫性證明。

## 目標
將既有全域模型切換能力提供為 Telegram 手機表單，保留下一次呼叫生效、無需容器重啟與重建後保留的語意。Tunnel 按需對外連通，管理操作持續需要驗證。
