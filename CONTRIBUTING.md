## 貢獻指南

歡迎協助改進 TeleNexus。以下是建議的開發流程與規範。

### 開發流程
1. 安裝依賴
   ```bash
   npm install
   ```
2. 啟動開發模式
   ```bash
   npm run dev
   ```
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
