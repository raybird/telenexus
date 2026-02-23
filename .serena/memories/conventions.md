# 開發慣例與風格

## 命名規範
- **類別 (Classes)**: 使用 PascalCase (例如 `TelegramConnector`, `GeminiAgent`)。
- **變數與函式**: 使用 camelCase (例如 `bootstrap`, `onMessage`)。
- **常數**: 使用 SCREAMING_SNAKE_CASE (例如 `TELEGRAM_TOKEN`)。

## 代碼風格
- 使用 TypeScript 強型別，盡量避免 `any`。
- 異步操作優先使用 `async/await`。
- 錯誤處理應包含適當的 `try/catch` 並提供使用者反饋。

## UX 模式
- 實作 "Thinking..." 佔位訊息模式，確保使用者知道 AI 正在處理中。
- 提供 `/reset` 指令來清除記憶。

## 工具調用
- 下層 AI 引擎應開啟 `--yolo` 模式以支援自動化操作。
