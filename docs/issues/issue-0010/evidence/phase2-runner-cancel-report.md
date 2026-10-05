# T2.2：runner 取消訊號修復

日期：2026-10-04。責任驗收 SCN-003；支援 SCN-004。

## 真實缺口與紅燈

產品 runner 的 `/run` 與 `/run/stream` 未將回應連線中斷轉成 AbortSignal；DynamicAIAgent 的 HTTP 入口也沒有傳入 options.signal。這會讓使用者取消後的 OpenCode／Chrome 繼續執行；不是只靠上游 MCP EOF 清理就能修復。

2026-10-04 `npx tsx --test tests/dynamic-agent-runner-cancel.test.ts`：exit 1、2 fail。真 HTTP server 未收到中斷，一般入口還進入 local fallback；本地 fallback stub 僅用來確認沒有額外工作，不 mock 目標 HTTP 傳輸。200ms fixture 保險絲讓原版結束，紅燈原因為斷線 assertion false，不是測試逾時。

2026-10-04 `npx tsx --test tests/runner-disconnect-cancel.test.ts`：exit 1、2 fail。真 runner 在暫存目錄運行，沒有 Telegram 憑證；假 opencode 是真實常駐子程序，先以 PID marker 證明啟動，再 destroy HTTP，2 秒後程序仍活。finally 僅清除自身子程序與 runner。這層驗證訊號傳遞，不能取代 Chrome 收尾。

外層使用初版真產品映像 `sha256:c515f7d592bba00c5e16b6562c5e4a9c31e7c40ebe45ba7c4d48a50487eee249`，受控 browser 設 cookie 與回傳正文後，中斷 runner stream HTTP。命令：

```bash
docker run --detach --init --network none --cap-drop ALL --security-opt no-new-privileges --user node --memory 2g --pids-limit 1024 --name issue10-runner-cancel-red-v1-20261004 --mount type=bind,src=/home/kevin/Documents/RCodes/moltbot-lite/docs/issues/issue-0010/evidence,dst=/probe,readonly --entrypoint node issue10-product:20261004 /probe/product-runner-concurrency.mjs stream interactive runner
```

2026-10-04 最後 a-cleanup-15 樣本：兩個工作 root／profile 均存在、live=31、Z=0，其中 B 是刻意仍執行的對照，A 的 root 亦未清理。assert「取消 A 必須清除自己的 root」失敗，容器之後因 observer assertion exit 1 結束；**不是用已停止容器的 0 程序宣稱成功**。18 個原始樣本與失敗診斷保存於 [runner-cancel-red-v1.jsonl](./runner-cancel-red-v1.jsonl)、[stderr](./runner-cancel-red-v1.stderr.log)、[summary](./runner-cancel-red-v1-summary.json)。

## 最小修復與底層綠燈

GitNexus callRunner／DynamicAIAgent.executeTask 風險 CRITICAL（聊天、摘要、排程等共用流程），修改前已警告。callRunnerStream、runner.executeTask／executeTaskStream 為 LOW；`rg` 補確認各自真實呼叫點。API impact 無法辨識原生 http route，故以兩個 handler 與呼叫者原始碼補查，未把查無 route 當作無影響。

HTTP 客戶端沿用 Node 的原生 request signal，不自建事件管理器。取消前／取消後都在共用入口檢查 signal，取消結果不觸發 runner failure circuit 或 local fallback。

runner 以 `res.close && !res.writableEnded` 驅動工作 AbortController，不用正常讀完 body 也會發生的 req.close。queued 工作開始前 throwIfAborted，不 spawn 已取消工作；執行中 signal 傳到產品 agent，finally 移除 response listener。取消後不得記 success audit；HTTP 回應格式沒有改動。

2026-10-04 合跑上述兩檔與 `tests/dynamic-agent-runner-stream.test.ts`：exit 0、5 tests／5 pass／0 fail。build／lint exit 0。另補兩個 pre-aborted case，最終完整 gate 為 [phase2-project-gates.json](./phase2-project-gates.json)：build→356 tests／0 fail→lint，均 exit 0。

code-simplify：no-op；已使用原生 HTTP signal，兩個局部 response listener 為不同 handler 的必要同型邏輯，沒有新增通用 manager 或變更認證／lane 序列化策略。外層 Chrome 綠燈仍須新映像並行測試，完成前不以本報告宣稱 T2.2／T2.3 通過。
