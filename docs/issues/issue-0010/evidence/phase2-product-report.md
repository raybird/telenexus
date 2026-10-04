# Phase 2 真產品整合驗證

日期：2026-10-04。T2.2、T2.3；SCN-001～005。使用實際 Dockerfile runtime 映像 `sha256:058cb99a2038b54c3cc5db8e9bae341d3176e868ac4bda4c22ee7a8c755f22f8`，固定 OpenCode 1.18.34、Chrome DevTools MCP 1.10.1、Chrome 154.0.8037.92。來源雜湊、build 命令與 exit 0 見 [產品建置 v2](phase2-product-build-v2.json) 及原始 log。

## 產品矩陣

命令：`node docs/issues/issue-0010/evidence/run-product-matrix.mjs v3`，exit 0。[逐輪命令／雜湊／結果](product-matrix-v3-summary.json) 及對應 `product-*-v3.jsonl` 保存完整紀錄。10 個 fresh、init=true、network=none、非 root、cap-drop ALL、no-new-privileges、pids-limit 1024 的測試容器；沒有正式資料、憑證或對外 port。

- 靜態 HTTP、動態 JS、binary 缺少、導覽逾時、取消、上游失敗、OpenCode process group 強制終止：非串流互動共 7 輪。
- 動態 JS：另涵蓋串流互動、非串流排程、串流排程 3 輪。
- **10／10 通過**。每輪退出後逐秒觀察至第 15 秒，工作活程序、Z、profile、launcher root 均為 0，量測完成時容器仍活著，再停止具名測試容器。既有 memory MCP 可用，持久設定檔 byte-identical。
- HTTP 正文／來源來自真 webfetch，Chrome 啟動數 0；JS 正文／來源來自真 MCP navigate/evaluate，透過 `/proc/PID/exe` 及 starttime 驗證 Chrome 啟動。fixture provider 只指定工具呼叫，不提供網頁答案。

早期 [v1 觀測器診斷](product-observer-v1-diagnosis.md) 誤把 MCP argv 中 binary 路徑算為 Chrome；[v2 契約診斷](product-contract-v2-diagnosis.md) 誤要求強制終止仍回 structured result。兩輪原始失敗保留，不作通過證據。v3 僅修正 fixture 的獨立身份觀測與既有 hardkill 拋錯契約，沒有弱化殘留判準。

## 同環境 HTTP 恢復（SCN-005）

2026-10-04 執行：

```bash
docker run --detach --init --network none --cap-drop ALL --security-opt no-new-privileges --memory 2g --pids-limit 1024 --name issue10-http-recovery-v1-20261004 --mount type=bind,src=/home/kevin/Documents/RCodes/moltbot-lite/docs/issues/issue-0010/evidence,dst=/probe,readonly --user node --entrypoint node issue10-product:20261004 /probe/product-http-recovery.mjs
docker exec --user root issue10-http-recovery-v1-20261004 mv /opt/telenexus/chrome/chrome-linux64/chrome /opt/telenexus/chrome/chrome-linux64/chrome-fixture-disabled
node docs/issues/issue-0010/evidence/save-product-probe.mjs issue10-http-recovery-v1-20261004 product-http-recovery-v1
docker stop --time 2 issue10-http-recovery-v1-20261004
```

四命令 exit 0；最後一個只停止測試容器、未刪除。相同容器、相同環境與工作根目錄，第一回真 JS tool 明確回 `Browser was not found at the configured executablePath`，沒有偽造正文；第二回真 webfetch 回獨立 `ISSUE10_RECOVERY_HTTP_BODY_20261004` 與實際 URL。**Chrome 始終缺少，沒有偷偷恢復 binary。** 兩回 Chrome 啟動 0，各自 15 秒內工作 live／Z／profile／root=0、memory 設定不變。證據：[摘要](product-http-recovery-v1-summary.json)、[36 筆採樣及工具結果](product-http-recovery-v1.jsonl)。

## Local／runner 所有權（SCN-004）

`product-runner-concurrency.mjs` 使用實際 DynamicAIAgent 與 `/app/dist/runner.js`，同源網站兩 cookie A／B，各工作獨立 profile；取消 A 後等待 15 秒，B 再次真 evaluate 仍取得自己的 cookie、正文與 URL。四個案例均使用上述產品映像：

| entry／lane | 取消位置 | 結果證據 |
| --- | --- | --- |
| structured／interactive | local | [摘要](runner-concurrent-structured-local-v2-summary.json) |
| stream／scheduled | local | [摘要](runner-concurrent-stream-local-v2-summary.json) |
| stream／interactive | runner | [摘要](runner-concurrent-stream-runner-v2-summary.json) |
| structured／scheduled | runner | [摘要](runner-concurrent-structured-runner-v2-summary.json) |

四輪均通過：A root 消失而 B 可再讀；最終工作 live／Z／profile／root=0，memory 設定未變，runner PID/starttime 在最終量測仍存活。各摘要含容器命令、image、Init 與 raw JSONL，並非藉關閉 runner／容器清零。

實際 runner 取消紅燈曾留下 live=31、roots=2（含刻意存活的 B），A root 未消失：[紅燈摘要](runner-cancel-red-v1-summary.json)。修復原生 HTTP AbortSignal 傳遞及 runner response close→工作取消後，四輪均綠。內層 HTTP disconnect／真 runner 子程序紅綠及呼叫影響見 [取消報告](phase2-runner-cancel-report.md)。

## 清理失敗可追蹤的負對照（SCN-003／005）

[真產品 audit 負對照](product-audit-negative-v1-summary.json) 在真 JS 正文成功後，只把該工作的 `/tmp/tnb-*` 改為 0500，製造 EACCES。第 15 秒活程序與 Z=0，但 root／profile 非零；因此 **cleanupPassed=false**，不是清理通過。產品注入的 `data/browser-lifecycle.jsonl` 確實保存 `browser-mcp-cleanup-failed`、root、launcher PID、errorCode=EACCES、remaining=[]。完整 [raw](product-audit-negative-v1.jsonl) 同時記負對照成功與清理失敗，證明即使 OpenCode 遮蔽 stderr 仍可追蹤，不把回答文字成功當資源收尾成功。

## 內層、精煉與限制

- [設定／安裝紅綠](phase2-config-report.md)、[launcher 真程序紅綠](phase2-launcher-report.md)、[HTTP 指引查核](phase2-http-report.md) 補足外層不同的失敗面，未以 mock 取代 browser 契約。
- [完整專案 gate](phase2-project-gates.json)：依序 build、356 tests／356 pass／0 fail／0 skipped（55 測試檔）、lint，均 exit 0；原始三份 log 同目錄。
- 2026-10-04 code-simplify 檢查此次 source diff：原生 HTTP signal、限定 OpenCode env override 與所有權 launcher 已是必要最小邊界；未發現可證明安全且實質簡化的改動，no-op，重用同一版本綠燈。
- 2026-10-04 提交前 GitNexus detect_changes：86 檔、443 個 touched symbols（包含測試／文件／fixture）、47 個流程，risk=critical；產品變更限 OpenCode env、DynamicAIAgent HTTP 取消及 runner 工作取消，聊天／排程共享呼叫影響已在實作前揭露並納入回歸。四份 terminal log 僅移除行尾空白、lint log 移除末尾空行，不改內容、exit 或斷言；JSONL／摘要與來源雜湊保持原樣。
- fake provider 證明工具／正文／生命週期整合，**不證明真模型自主選工具品質**。未登入、未提交表單、不承諾跨回合 browser state。
- Chrome 在容器內使用 `--no-sandbox`；保留非 root 與既有容器硬化，不聲稱 Chrome sandbox 已啟用。launcher 自身被 SIGKILL 仍無法執行清理，PID/starttime 檢查也不等同 pidfd 原子身份保證；不擴大承諾。
- 這不是 Phase 4 的 45 次最終回歸，不是 SCN-006 遷移通過，不是獨立 review。舊 agent-browser／全域 close 尚保留，正式服務、資料與版本均未變更。
