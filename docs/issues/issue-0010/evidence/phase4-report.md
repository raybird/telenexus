# Phase 4 最終回歸

日期：2026-10-05。T4.1／SCN-007，整合 SCN-001～006。最終映像 `sha256:445ce68d079d87c65a11bde4d9effcad26b2e1b6a0e2a4723a8557428cdbefb0`，版本／來源見 [建置紀錄](phase2-product-build-phase3-v3.json)。沒有改版、發佈、清除正式殭屍或重啟正式服務。

## 同一容器 45 輪

命令：`node docs/issues/issue-0010/evidence/run-product-cycles.mjs v1`，exit 0。[容器命令／ID／映像／fixture 雜湊與逐輪摘要](product-cycles-v1-summary.json)、[完整工具及每秒 PID/starttime 採樣](product-cycles-v1.jsonl)。只用單一容器，init=true、network none、非 root、cap-drop ALL、no-new-privileges，沒有正式掛載或對外 port。

正常動態讀取 20 次，啟動失敗、導覽逾時、使用者取消、上游 401、OpenCode process-group SIGKILL 各 5 次。每輪 15 秒窗內 live／Z／profile／launcher root 全部歸零，Chrome 實際程序對照符合預期；缺 binary 5 輪啟動 0，其餘輪次均觀測到真 Chrome。正文／URL 由真 MCP 工具提供，不由 provider 假造；失敗輪次如實報告失敗，取消與 SIGKILL 不拿成功正文冒充結果。

觀測器沿用 [Phase 0 已知 Z／活程序／profile 正負對照](phase0-report.md)，每輪保留原始固定 baseline 與後續所有 PID/starttime，前輪殘留不能被新 baseline 排除。cgroup 正對照包含本容器 PID1 及觀測器，完整路徑／mount 證據在原始紀錄。

2026-10-05 另從 raw JSONL 取出全部 45 筆 second=15，獨立斷言 liveMax=0、ZMax=0、profileMax=0、rootMax=0；核對六種模式數量完全相符。從摘要逐項核對 45 輪 baseline/final 都是 8、初始與最後也是 8，趨勢為固定平臺，沒有累積。[獨立計數](phase4-independent-counts.json)。這是實際趨勢查核，不以 `cleanupPassed` 單一旗標代替 cgroup 判準。

最終量測時容器／觀測器仍存活；保存證據後才停止該測試容器。5 次缺 binary 只在這個具名容器 `mv` 固定 Chrome binary 並逐次復原，完整命令已記錄；未刪容器，未對正式 binary 操作。

## 新版並行矩陣與完整 gate

命令：`node docs/issues/issue-0010/evidence/run-final-concurrency.mjs v1 sha256:445ce68d079d87c65a11bde4d9effcad26b2e1b6a0e2a4723a8557428cdbefb0`，exit 0。[四組完整摘要與命令](final-concurrency-v1-summary.json)。structured／interactive 取消 local、stream／scheduled 取消 local、stream／interactive 取消 runner、structured／scheduled 取消 runner 均 PASS。同源 cookie A/B 隔離，A 收尾後 B 再讀正文／cookie 成功；量測時 runner 仍活著，最終工作 live／Z／profile=0，memory MCP 設定不變。

[2026-10-05 最終專案 gate](phase3-project-gates.json)：build、370 tests／0 fail、lint、installer 均 exit 0，57 個測試檔與完整巢狀 glob 相稱。其後只新增／修正文書與測試證據，產品來源與映像雜湊未變，重用同版 gate；沒有新功能重構，精煉 no-op。

常青配置／安全／安裝／架構／開發指引已更新，安裝指南記排空、備份、重建套用 init 與保留 init 的回退方式；正式部署時機仍由維護者另行核准。2026-10-05 靜態本機連結查核 31 個有效、diff --check exit 0；提交前 GitNexus 索引更新，detect_changes 的 Medium 集中於技能遷移，補以真呼叫點、12 項安全遷移及獨立預審查核，不把圖譜模糊關聯當作新增產品路徑。

## 限制

2026-10-05 暫存後完整 whitespace 查核發現工具輸出中的 CR／行尾空白；提交前的工作區查核未涵蓋當時未追蹤的 logs。後續僅對本階段新增 `.log` 做行尾空白正規化，保留訊息、結果與 exit，不改 JSONL、歷史 logs、legacy fixture bytes 或產品來源；重新查核完整交付 diff，不把第一次查核當成全範圍通過。

證據為固定 linux/amd64 工具／版本與隔離容器；fake provider 只驅動工具流程，不代表真模型自主路由品質。Chrome 使用 no-sandbox，容器硬化不是瀏覽器 sandbox。launcher 自身 SIGKILL、stat/kill TOCTOU、自訂同名 backend 或技能路徑及並行人工修改遷移資料，仍有已揭露限制。這些不擴張為新的保證。獨立最終 review 與 PR 在本報告產生時尚待完成。
