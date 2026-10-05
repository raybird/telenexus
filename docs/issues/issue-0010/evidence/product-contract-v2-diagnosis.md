# 產品矩陣 v2 強制終止契約診斷

日期：2026-10-04。此紀錄修正 fixture 對既有產品契約的錯誤假設，不是產品行為紅燈，也不將 v2 整個矩陣列為通過。

`node docs/issues/issue-0010/evidence/run-product-matrix.mjs v2` 的 groupkill 最後因「產品入口必須回傳結構化結果」斷言失敗，見 [raw](product-groupkill-structured-interactive-v2.jsonl)、[stderr](product-groupkill-structured-interactive-v2.stderr.log) 與 [矩陣摘要](product-matrix-v2-summary.json)。真工具已取得正文；fixture 隨後對 OpenCode PGID 22 送 SIGKILL，launcher PGID 39 獨立。產品回傳 product-error：`Error calling Opencode: Process terminated with signal SIGKILL`，client exit code=1。退出後第 0～15 秒 live／Z／profile／launcher root 均為零，但沒有完成 measurement-complete，因此不補造整輪成功紀錄。

2026-10-04 檢查 `src/core/opencode.ts` 的 runChatStructured：EABORTED、ETIMEDOUT／SIGTERM 與已辨識的上游 error 各有結構化結果；未歸類的程序錯誤仍重新拋出 ProcessError，SIGKILL 屬此既有契約。product-agent-client 正確捕獲例外並 exit 1，不是吞掉失敗。fixture 錯在要求這個分支也必須有 structured result。

修正只限 groupkill：必須已注入真 OpenCode PGID SIGKILL、client exit=1、錯誤原文完全相符、沒有 product-result 或成功真正文；其餘六個分支仍要求結構化結果及原有專屬斷言。measurement-complete 另保存 productError，讓強制終止與成功輸出可分辨，資源收尾判準不變。

修改前 `gitnexus_impact` 對新 fixture 回 Target not found／UNKNOWN，未修改產品 symbol。`node --check docs/issues/issue-0010/evidence/product-opencode-contract.mjs` exit 0。尚未執行 v3；需依新映像與完整矩陣重跑結果判定，不沿用部分 v2 結果作最終交付證據。
