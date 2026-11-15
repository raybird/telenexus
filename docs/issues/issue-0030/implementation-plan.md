# Issue 0030 Implementation Plan

## 設計方案
流程與權限邊界見 [技術分析](./technical-analysis.md)；風險與首要驗證唯一來源見 [README](./README.md#風險與首要驗證)。
模型設定服務提供讀取有效設定、列舉模型、套用完整 model ID、清除 override；函式簽名在拆解時依現有型別確定。管理服務只提供啟動／狀態／停止，目標為固定的 Compose Web 服務，不接受任意代理目標。

## 初始實作步驟（唯一任務來源）
目前 SCN-001～005 為待核准草案；下列為初始 Phase 規劃，均非已授權可執行 Task。完成核准及必要決策後，由 decompose 在本檔細化，不另建 task 清單。

| Phase | 狀態 | 驗收 | 產出 | 相依 | 完成判準 |
|---|---|---|---|---|---|
| P1 安全與外部契約驗證 | 📝 待核准 | SCN-001、002 | 授權失敗測試、隔離 Bot 的 Tunnel／Mini App 契約證據 | 規格核准、測試窗口 | 偽造／過期／越權／缺憑證／代理繞過皆拒絕且設定不變；網址更新與換網域登入實證 |
| P2 共用模型設定 | 📝 待核准 | SCN-003、004 | 讀取／列舉／套用／重設服務及原指令整合 | P1 安全契約、清單語意查證 | 正確顯示來源；無效輸入與寫入失敗保留舊值；既有指令相容 |
| P3 Tunnel 生命週期及 Bot 入口 | 📝 待核准 | SCN-001、002、005 | 管理服務及 /panel、/panel_close | P1 | 並行請求不重複啟動、健康後發布、停止／崩潰清理、舊網址可恢復 |
| P4 Mini App 模型面板 | 📝 待核准 | SCN-002、003、004 | 登入、模型 API、手機表單 | P1、P2、P3 | Telegram 登入後可切換／還原，顯示全域影響；不依賴 SSE |
| P5 Compose 與交付整合 | 📝 待核准 | SCN-001～005 | parity、預建映像／bundle、隔離驗收及常青文件 | P2～P4、測試窗口 | 容器重建保留設定，主服務／Runner 後續呼叫一致，所有必要檢查通過 |

## 使用方式對照
原本：/models → 複製完整 ID → /set_model；恢復使用 /reset_model。
目標：/panel → Mini App provider／model 選擇 → 套用／恢復；原指令保留。

## 測試策略
- SCN-001、005：管理程序狀態與子程序生命週期單元測試，加 Bot API／容器整合；另取真實外部 HTTPS 與 Telegram 客戶端證據。
- SCN-002：簽章、時效與白名單單元測試，加真實 HTTP 管理端點負向測試；檢查代理信任及既有公開 API，確認設定未變。
- SCN-003：獨立 fixtures 驗證 provider 篩選及模型 ID；涵蓋空清單／命令失敗與前端錯誤顯示。
- SCN-004：隔離 data 目錄驗證套用／重設／失敗保留，整合主服務到 Runner 的設定傳遞與新舊任務邊界。
- 行為實作依 verification.md 保存紅綠重構證據；純文件使用靜態檢查。此階段沒有任何實作測試已通過的宣告。
- 最終依序執行 npm run build、npm run test、npm run lint；改 installer 加 npm run test:installer。Docker／Telegram 實測需隔離資料、不同 token 與埠，依 project.md 決定窗口。

## 檢查清單
- [ ] SCN 核准及必要決策完成，Large Task 在本檔拆解
- [ ] 修改 symbol 前 GitNexus impact 並交叉核對呼叫者；提交前 detect_changes
- [ ] 授權與公開 API 邊界證據齊備
- [ ] 模型設定、生命週期、容器及客戶端證據齊備
- [ ] README 涉及的常青文件依實際變更更新，未宣稱正式環境已部署
