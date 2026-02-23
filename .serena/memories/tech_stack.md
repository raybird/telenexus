# Moltbot Lite 技術棧

## 語言與環境
- **Runtime**: Node.js
- **語言**: TypeScript
- **模組系統**: CommonJS (根據 `package.json` 的 `"type": "commonjs"`)

## 主要框架與函式庫
- **Telegraf**: Telegram Bot 框架，用於處理通訊。
- **Better-SQLite3**: 用於本地資料存儲，效能優異且支援同步操作。
- **RxJS**: 響應式編程函式庫（雖然在 `main.ts` 中尚未明顯看到大規模使用）。
- **Dotenv**: 管理環境變數。
- **TSX / TypeScript**: 用於開發環境的運行與編譯。

## 核心工具
- **Gemini CLI**: 作為 AI 引擎，負責理解自然語言、搜尋網路以及執行自動化工具。
