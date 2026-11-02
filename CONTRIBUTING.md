## 貢獻指南

歡迎協助改進 TeleNexus。以下是建議的開發流程與規範。

### 開發流程

1. 安裝依賴
   ```bash
   npm install
   ```
2. 啟動開發模式（預設在容器內執行，存檔即重載；注意事項見 `README.md` 的「本機開發」）
   ```bash
   npm run docker:dev
   ```
   不經容器、直接在主機執行：`npm run dev`。
   Linux 上可選擇啟動本機記憶 UI。先依[安裝指南](docs/installation.md#memoria-本機記憶-ui)備份並初始化資料、確認主記憶服務健康，再執行 `docker compose --profile memory-ui up -d --build --wait --no-deps memoria-ui`，網址為 `http://127.0.0.1:3918/ui/`。請沿用相同 Compose 專案與記憶資料掛載；啟停、埠號及安全限制亦見安裝指南。
3. 確認型別與品質
   ```bash
   npm run build
   npm test
   npm run lint
   npm run format
   ```

### 程式碼規範

- TypeScript 嚴格模式已啟用，請避免使用 `any`。
- 優先使用小型、單一責任的模組或函式。
- 文件若涉及架構、runner、memory、web API，請同步對齊 `README.md`、`ARCHITECTURE.md` 與相關 `docs/` 參考頁。
- 變更行為需附上清楚的說明與測試步驟。

### Commit 建議

- 以動詞開頭，描述變更目的（例如：`add command router`）。
- 一次 commit 聚焦一個主題，避免混雜不相關變更。

### 回報問題

如果發現問題，請提供：

- 版本資訊與 OS
- 重現步驟
- 預期行為與實際行為
