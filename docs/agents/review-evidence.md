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
- 核准 commit 為 `待提交` 時，依 [acceptance.md](acceptance.md#規格修訂的查核)推導出的核准基線 SHA。

兩種保存方式皆失敗時回報 `UNPERSISTED` 並停止，不能把對話報告當成已持久化的 PASS。

### 審查之後的提交

報告綁定**被審查提交**，不填入尚未存在的報告提交 SHA。被審查提交之後的提交能否沿用原 PASS，一律以 review 技能的 `verify-artifact.py` 判定，依被審查提交上 `docs/AGENTS.md` 的流程契約分兩種：

**流程契約 2.4 起**，下列三項全部成立時原 PASS 沿用，不重跑審查與程式測試：

1. 被審查提交是目前 HEAD 的祖先，中間沒有 merge 提交。
2. 淨差異只有新增該次報告（本機保存時；新增後不再修改），以及該 issue `README.md` 的**記帳區段**：`## Timeline`、`## 待確認事項`、`## Gate 豁免紀錄` 三節的內容（後兩節可整節新增或刪除；節內有標題、code fence 或粗體開頭的行時整節增刪判定無效），與 `**狀態**`、`**核准 commit**` 兩個欄位的值。
3. `**核准 commit**` 的值只由 `待提交` 改成被審查提交或它的祖先。

記帳區段以外都是凍結內容：其他章節、所有 `##` 標題與其順序、code fence、其他粗體欄位（包括寫在記帳章節底下的 `**分級**`、`**風險**`）、implementation-plan.md、evidence、既有報告與 issue 目錄外的檔案；標題名稱與範本不同的章節同樣凍結。記帳章節內看起來像標題的行、引用或清單裡的 code fence、以粗體開頭的行，即使不是範本寫法也視為凍結內容。保存報告、記下使用者對 `需決策` 的答案、回填核准 commit 可以併在同一個提交。PR 證據與 review 記錄列出被審查 HEAD、目前 HEAD 與工具回報的變更區段。

**流程契約 2.3 以下**只接受單一報告提交：目前 HEAD 是被審查 SHA 的直接後繼、唯一一個非 merge 提交，唯一差異是新增這一份報告（`--name-status` 為 A、一般檔案模式）。PR 證據同時列出被審查 HEAD 與報告提交 HEAD。

不符合所屬條件的新提交、重寫歷史或範圍改變都重新審查。使用者明確決定不重新審查時，依 [docs/AGENTS.md](../AGENTS.md)「Gate 豁免紀錄」記錄未經審查的提交與殘餘風險；報告的 PASS 仍只標在被審查 SHA，PR 證據照列有效性檢查的結果並引用該豁免。

## 審查強度與流程判定

逐一核對需求、正確性、安全與權限、架構邊界、測試真偽、相關失敗路徑。邊界案例由實際變更與風險決定數量：每個已辨識的重要失敗面都有具體輸入／狀態、預期行為、覆蓋與結論；無適用面時記理由，不湊固定三個案例。

- `PASS`：獨立審查完成、報告已保存、無 MUST FIX，必要驗收及失敗面具證據或明確豁免。Gate 豁免紀錄明列接受不修的 MUST FIX 不阻擋 PASS，報告照列並註明依據的豁免。
- `RETURN TO execute-task`：有安全／邏輯錯誤、架構違規、不實回報、必要驗收或風險覆蓋缺口。
- 純可讀性建議與證據持久力改善不阻塞；揭露測試限制不構成缺失。

發現需要使用者決定需求邊界、接受風險或不修復才能處理時，在該項加註 `需決策`，寫明待決問題、可選做法與 reviewer 建議；判定仍依上列條件。協調者依 [acceptance.md](acceptance.md)「逐題確認」取得答案，結論記入 README `## 待確認事項`。

等待外部驗收窗需確認窗口前工作已完成；不修復審查的是決策來源、理由與殘餘影響。此類決策報告明列「決策審查」，不能拿來宣稱程式變更通過。
