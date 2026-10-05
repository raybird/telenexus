# T2.1：HTTP 優先閱讀

日期：2026-10-04。責任驗收 SCN-001。

既有 OpenCode `webfetch` 已具備本項閱讀能力，不新增 HTTP 後端，也不假造缺少功能的紅燈。characterization 引用同一固定 OpenCode 1.18.34／映像、fake provider 契約與獨立 fixture 的 [matrix-static-v6.jsonl](./matrix-static-v6.jsonl)：真工具取得 `ISSUE10_HTTP_BODY_20261004`，最終 OpenCode 文字含正文與實際 loopback 來源，Chrome executable 啟動事件為 0。dynamic 同取數路徑的啟動事件為 1，證明不是觀測器永遠回零。

最小修改是 `skills/web-reading/SKILL.md`，沿用產品技能的 name／description 格式與既有同步入口。未改 skills 同步、使用者持久化內容或 runtime MCP 設定；舊後端退役與遷移留給相依 Task。

2026-10-04 人工分支檢查：

- 一般公開 URL：先 webfetch，正文足夠即附來源完成，不啟動 Chrome。
- HTTP 僅頁面殼層：轉本工作動態讀取工具，工具回傳正文與實際 URL 才完成。
- HTTP 認證錯誤／驗證碼：不誤判為渲染缺口或新增繞過授權。
- 工具失敗／正文不存在：明確失敗，不偽造內容；收尾由程式負責，不使用全域 close。

使用 writing-rules 將觸發條件放在 description，把分支完成條件留在正文；不增加 Codex 專用 UI metadata 或通用瀏覽器操作教學。`python3 /home/kevin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/web-reading`：exit 0、Skill is valid；格式驗證不等於模型自主路由品質驗收。指南不改既有 HTTP 實作，採分支人工查核加既有真工具 characterization；沒有不同底層行為需另造單元紅燈。code-simplify 為 no-op，沒有必要的額外抽象。

尚未驗證真認證模型會依新技能自主選 HTTP／MCP；fake provider 測試只證明真工具路徑。此限制持續揭露，T2.2／T2.3 與最終產品整合驗收仍未完成。
