# 建議開發指令

## 開發運行
- **啟動開發模式 (監測更動)**:
  ```bash
  npm run dev
  ```
- **手動編譯專案**:
  ```bash
  npm run build
  ```
- **啟動正式環境 (需先 build)**:
  ```bash
  npm start
  ```

## 系統工具
- **查看檔案列表**: `ls -R`
- **搜尋代碼**: `grep -r "pattern" src/`
- **管理 Git**: `git status`, `git add`, `git commit`

## 環境設定
- 需在 `.env` 中設定 `TELEGRAM_TOKEN` 與 `ALLOWED_USER_ID`。
