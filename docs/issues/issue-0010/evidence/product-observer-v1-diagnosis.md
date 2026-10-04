# 產品觀測器 v1 偽陽性診斷

日期：2026-10-04。此紀錄是測試觀測器修正，不是產品行為紅燈或 Scenario 通過證據。

`node docs/issues/issue-0010/evidence/run-product-matrix.mjs v1` 首輪 static 在「Chrome 真程序正／負對照」斷言失敗：actual=true、expected=false。見 [stderr](product-static-structured-interactive-v1.stderr.log)、[原始逐秒資料](product-static-structured-interactive-v1.jsonl) 與 [矩陣命令／映像／程式雜湊](product-matrix-v1-summary.json)。未完成 measurement-complete；容器因此退出，不把既有工具正文與最後零殘留當成整輪通過。

v1 的 `observe()` 以 `argv.includes('/opt/telenexus/chrome/chrome-linux64/chrome')` 識別 Chrome。但 raw 的 PID 41、starttime `23365753`、comm=node 是產品 launcher，其命令只透過 `--executable-path` 參數攜帶該路徑；它不是 Chrome executable。舊判準把這個 Node 程序誤計為 Chrome。static 真工具結果是 webfetch 正文，沒有 browser tool 呼叫；這些資料可解釋偽陽性，但舊觀測器不足以獨立證明 Chrome 未啟動，因此仍須重跑。

2026-10-04 修正：讀取 `/proc/PID/exe`，並重讀 stat 確認 PID＋starttime 身分一致，只在 exe 與固定 Chrome binary 完全相等時計數。每筆 sample 保留 exe，首次真 Chrome 身分另保存 browser-observed event。static 負對照與 dynamic 正對照使用同一管道；正對照仍必須真實觀測到 Chrome，不能只靠工具名稱推斷。

修改前 `gitnexus_impact` 對 observe 回 Target not found／UNKNOWN；這是新增未索引的 fixture，不把 UNKNOWN 當 LOW。`rg` 確認 observe 只由本檔 sample 與 50ms watcher 使用，未改產品 symbol。`node --check docs/issues/issue-0010/evidence/product-opencode-contract.mjs` exit 0。尚未重跑 Docker；v2 是否通過須以新 raw 判定。
