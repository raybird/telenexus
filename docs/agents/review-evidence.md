# PR 與 review 證據

建立 PR、審查或判斷既有 review 是否有效時讀本檔。驗收核准依 [acceptance.md](acceptance.md)，測試有效性依 [verification.md](verification.md)。

## 固定交付範圍

協調者取得 PR 的目標分支與 source HEAD，解析成固定 SHA，計算 `git merge-base` 得到 BASE，記錄 TARGET、BASE、HEAD。審查 diff、Proof of Test 與 patch-id 都針對同一個 `BASE..HEAD`。本地 HEAD 與 PR source HEAD 不同時，先指出差異，不能拿本地審查代表遠端 PR。

獨立呼叫時優先讀使用者指定範圍，其次現有 PR 與 project.md；無法辨認 base 才詢問。`review N` 相容舊用法，以 HEAD~N 作 BASE 並明列這是局部審查；只有確認範圍覆蓋完整 PR 才能作為閉環通過證據。工作區有未提交交付內容時先提交或完成隔離，避免把舊 HEAD 的證據套到新內容。

```bash
git diff "${base_sha}" "${head_sha}"
git diff "${base_sha}" "${head_sha}" | git patch-id --stable
```

使用固定 BASE 保留可重現的原始範圍。patch-id 是輔助識別，會忽略部分差異（如空白），且 base 變動、衝突解法或實質改寫可能改變 patch；相同 patch-id **不自動放行新 HEAD**。rebase 等操作後重新核對規格、測試與完整變更範圍，必要時重審。

## Proof of Test

每個核准且未豁免的驗收編號都需一列，集合完全相等。每列包含可觀察結果摘要、固定版本的規格連結、測試／等價證據連結與結果。證據需包含實際命令、被測版本及成功輸出，按 verification.md 判斷是否仍有效；多個編號可以引用同一份測試紀錄，毋須重跑或複製輸出。

平台無固定版本連結時，以 `commit:path` 與驗收編號定位，可用 `git show` 取回原文。PR 不複製整份 Gherkin；若證據只在對話中，先保存於任務紀錄或 artifact。豁免項目與尚未解決的待確認事項另列，維持 README 的原狀態及理由。

## Review artifact 的存放

獨立 reviewer 必須不是原實作者；可使用宿主隔離 subagent／task，或專案的外部 reviewer。只有自我重讀時回報能力阻塞，不冒充獨立審查；使用者明確豁免時依 AGENTS.md 留痕。

報告優先保存於 PR review／MR discussion 等平台。純本機流程保存為 `docs/issues/issue-{ID}/review-{被審查 HEAD 前 7 碼}.md`。必備欄位：

- Reviewed BASE SHA、Reviewed HEAD SHA、Reviewed patch-id。
- 獨立 reviewer 識別、審查範圍與風險、證據及發現。
- `PASS`／`RETURN TO execute-task` 判定與 artifact URL／路徑。

兩種保存方式皆失敗時回報 `UNPERSISTED` 並停止，不能把對話報告當成已持久化的 PASS。

### 本機 artifact 提交後的有效性

報告綁定**被審查提交**，不填入尚未存在的報告提交 SHA。完成審查後，可以新增一個只加入該報告的提交：

1. 目前 HEAD 必須是被審查 SHA 的直接後繼，且是唯一一個非 merge 的報告提交；報告可用 `git show HEAD:報告路徑` 讀取。
2. 比較被審查 SHA 與目前 HEAD，唯一差異必須是新增這一份報告；以 `--name-status` 確認為 A，並確認一般檔案模式。既有報告被修改、其他文件、測試、設定或程式變更都不符合。
3. 後續 PR 證據與 review 記錄同時列出被審查 HEAD 與報告提交 HEAD，讓讀者知道額外提交的用途。

三項全成立，原 PASS 仍有效；單純報告提交不重跑程式測試。其餘新提交、重寫歷史或範圍改變都重新審查。這條例外只接受該次報告的新增，不概括豁免 docs/ 或測試檔案。

## 審查強度與流程判定

逐一核對需求、正確性、安全與權限、架構邊界、測試真偽、相關失敗路徑。邊界案例由實際變更與風險決定數量：每個已辨識的重要失敗面都有具體輸入／狀態、預期行為、覆蓋與結論；無適用面時記理由，不湊固定三個案例。

- `PASS`：獨立審查完成、報告已保存、無 MUST FIX，必要驗收及失敗面具證據或明確豁免。
- `RETURN TO execute-task`：有安全／邏輯錯誤、架構違規、不實回報、必要驗收或風險覆蓋缺口。
- 純可讀性建議與證據持久力改善不阻塞；揭露測試限制不構成缺失。

等待外部驗收窗需確認窗口前工作已完成；不修復審查的是決策來源、理由與殘餘影響。此類決策報告明列「決策審查」，不能拿來宣稱程式變更通過。
