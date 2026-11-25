# PR 與 review 證據

建立 PR、審查或判斷既有 review 是否有效時讀本檔。驗收核准依 [acceptance.md](acceptance.md)，測試有效性依 [verification.md](verification.md)。

## 固定交付範圍

開 PR 前，協調者依使用者指定或 project.md 確認目標分支，以已提交的交付分支 HEAD 為 source HEAD。已有 PR 時讀取平台目標與 source HEAD；準備更新 PR 時，以已提交且預計推送的版本為待審 HEAD，更新後核對平台版本。project.md 登記不開 PR 時，推送後以遠端分支 HEAD 核對待審 HEAD，並重新取得目標分支確認 merge-base 未變。將目標與待審版本解析成固定 SHA，計算 `git merge-base` 得到 BASE，記錄 TARGET、BASE、HEAD。審查 diff、Proof of Test 與 patch-id 都針對同一個 `BASE..HEAD`。本地 HEAD 與 PR source HEAD 不同時，先指出差異，不能拿本地審查代表遠端 PR。

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

開 PR 前與純本機流程，報告保存為 `docs/issues/issue-{ID}/review-{被審查 HEAD 前 7 碼}.md`；已有 PR 時優先保存於 PR review／MR discussion 等平台。必備欄位：

- Reviewed BASE SHA、Reviewed HEAD SHA、Reviewed patch-id。
- 獨立 reviewer 識別、審查範圍與風險、證據及發現。
- `PASS`／`RETURN TO execute-task` 判定；保存在平台時另記連結（本機報告的路徑就是檔案本身，不另寫）。
- 核准 commit 為 `待提交` 時，依 [acceptance.md](acceptance.md#規格修訂的查核)推導出的核准基線 SHA。

流程契約 2.5 起，保存報告的同一個提交把 issue README `## 現況` 的 `**現行 review**` 改成這份報告的檔名或平台連結；README 還沒有 `## 現況` 時，依 [document-types.md](document-types.md#readmemd必備) 在 `## 概述` 之後建立。報告保存在平台時，由更新 README 的那個提交寫入平台連結。讀者以這個欄位找現行報告，舊報告留在原處作為歷史。

兩種保存方式皆失敗時回報 `UNPERSISTED` 並停止，不能把對話報告當成已持久化的 PASS。

### 審查之後的提交

報告綁定**被審查提交**，不填入尚未存在的報告提交 SHA。流程契約 2.4 起，被審查提交之後，下列內容可以照常提交，原 PASS 沿用，不重跑審查與程式測試（2.3 以下只接受單一報告提交，見下方）：

- 新增本次報告（本機保存時；新增後不再修改）。
- issue `README.md` 的**記帳區段**：`**狀態**`、`**核准 commit**` 兩個欄位的值，`## Timeline`、`## 待確認事項`、`## Gate 豁免紀錄` 三節的內容（後兩節可整節新增或刪除）；流程契約 2.5 起另含 `## 現況`，可整節新增或刪除，節內的一般行、表格列與一行 `**現行 review**` 可改。

記帳區段依 [docs/AGENTS.md](../AGENTS.md#待確認事項)「待確認事項」的寫法書寫：一般段落、表格列與清單，照範本寫成的表格直接補列。保存報告、記下使用者對 `需決策` 的答案、回填核准 commit 可以併在同一個提交。其他內容都是凍結內容：其他章節、所有 `##` 標題與其順序、code fence、其他粗體欄位（包括寫在記帳章節底下的 `**分級**`、`**風險**`）、implementation-plan.md、evidence、既有報告與 issue 目錄外的檔案；標題名稱與範本不同的章節同樣凍結。

能否沿用一律以 review 技能目錄下的 `scripts/verify-artifact.py` 判定（參數見 review 技能步驟 5；不知道技能目錄時載入 review 技能取得），依被審查提交上 `docs/AGENTS.md` 的流程契約：

**流程契約 2.4 起**，下列三項全部成立時沿用：

1. 被審查提交是目前 HEAD 的祖先，中間沒有 merge 提交。
2. 淨差異只在上列可以改的內容之內。
3. `**核准 commit**` 的值只由 `待提交`（帶反引號或附註也算）改成被審查提交或它的祖先。

`## 現況` 從流程契約 2.5 起才屬記帳區段，2.4 的專案屬凍結章節。檢查器不驗證整節新增的 `## 現況` 是否位在 `## 概述` 之後，reviewer 核對變更區段時一併確認位置。

**流程契約 2.3 以下**只接受單一報告提交：目前 HEAD 是被審查 SHA 的直接後繼、唯一一個非 merge 提交，唯一差異是新增這一份報告（`--name-status` 為 A、一般檔案模式）。PR 證據同時列出被審查 HEAD 與報告提交 HEAD。

verify-artifact 判需重審時，依它指出的行對照 review 技能的 `references/frozen-content.md`：記帳章節裡看起來像標題、以粗體或 `[` 開頭、含 `<` 的行與 code fence，以及與它們同段落或同表格的內容，都會被當成凍結內容。PR 證據與 review 記錄列出被審查 HEAD、目前 HEAD 與工具回報的變更區段。

PASS 之後才發現凍結內容寫錯（例如 `## 關鍵差異` 或計畫）時，先告知使用者修改會讓 PASS 失效，由使用者選：把更正記在待確認事項，PASS 沿用；或修正後重新審查，符合下節條件時做增量覆審。

不符合所屬條件的新提交、重寫歷史或範圍改變都重新審查。在被審查分支做這類提交之前，先依 [docs/AGENTS.md](../AGENTS.md#agent-工作流程與時序保留-workflow--timeline-tracking)「Agent 工作流程與時序保留」第 6 項告知使用者。使用者明確決定不重新審查時，依 [docs/AGENTS.md](../AGENTS.md)「Gate 豁免紀錄」記錄未經審查的提交與殘餘風險；報告的 PASS 仍只標在被審查 SHA，PR 證據照列有效性檢查的結果並引用該豁免。

### 增量覆審

流程契約 2.6 起，被審查提交 H1 之後的修正需要重新審查時，下列三項都成立就做增量覆審。修正來源不限：審查的退回或建議、使用者的決定、外部 reviewer 的要求都一樣。

1. H1 有一份綁定 H1、記完整交付範圍的持久化報告（判定 PASS 或 RETURN TO execute-task；局部審查的報告不算），H1 是新 HEAD 的祖先，H1 之後沒有改寫歷史。
2. 目標分支與新 HEAD 的 merge-base 仍是那份報告的 Reviewed BASE。
3. 協調者把那份報告與新範圍一起交給獨立 reviewer，不限原 reviewer。

報告照完整範圍記：Reviewed BASE 是原 BASE，Reviewed HEAD 是新 HEAD，patch-id 依 `BASE..新 HEAD` 計算，所以它就是完整範圍的審查證據。另記上一份報告、增量範圍 `H1..新 HEAD`、重新查核的項目與沿用的結論。流程契約 2.8 起，「已查核維度」與「限制」只寫本輪查核的項目、結論與新增的限制，加一行寫明其餘沿用上一份報告的檔名，不重抄上一份的內容。

reviewer 讀上一份報告與增量 diff，增量範圍內每個變動檔案都給結論，上一份報告的 MUST FIX 與決定要修的建議逐項確認已修好。變動會影響未改動的程式或上一份報告的結論時——例如呼叫被修改函式的程式、依賴被修改的設定或資料格式的程式、前提被改變的測試——在整個新 HEAD 找出這些地方並重新查核，寫明理由；只有確認不受影響的結論才寫為沿用。受影響的測試在新 HEAD 重跑並引用輸出。

流程契約 2.8 起，上一份報告判 PASS、增量範圍只為處理它的建議（使用者選了修正的項目）時，reviewer 逐項確認這些建議已修好，並照上段查核受影響之處；新提出的 SHOULD FIX／NICE TO HAVE 只限增量引入的問題，沒動到也不受影響的內容不再提新建議。MUST FIX 等級的問題不受此限，照常列出並寫明在上一個 HEAD 就已存在。增量同時夾帶其他修改時照一般增量覆審；保存上一份報告、記錄建議結論這類記帳提交不算其他修改。

任一條件不成立就完整審查，報告寫明不採增量的原因。只把上一個 HEAD 記為 Reviewed BASE 的報告屬於局部審查。

## 審查強度與流程判定

逐一核對需求、正確性、安全與權限、架構邊界、測試真偽、相關失敗路徑。邊界案例由實際變更與風險決定數量：每個已辨識的重要失敗面都有具體輸入／狀態、預期行為、覆蓋與結論；無適用面時記理由，不湊固定三個案例。

- `PASS`：獨立審查完成、報告已保存、無 MUST FIX，必要驗收及失敗面具證據或明確豁免。Gate 豁免紀錄明列接受不修的 MUST FIX 不阻擋 PASS，報告照列並註明依據的豁免。
- `RETURN TO execute-task`：有安全／邏輯錯誤、架構違規、不實回報、必要驗收或風險覆蓋缺口。
- 純可讀性建議與證據持久力改善不阻塞；揭露測試限制不構成缺失。
- 流程契約 2.8 起，issue 文件的格式、措辭與欄位寫法列 SHOULD FIX 或 NICE TO HAVE。以下才列 MUST FIX：缺少新行為的核准來源或必要證據、不實回報，或會讓 verify-artifact、dev-cycle、懸置掃描判斷錯誤的寫法（例如狀態值、`**核准 commit**`、`## 現況` 的 `**現行 review**`、待確認事項或計畫任務的狀態寫錯）。

發現需要使用者決定需求邊界、接受風險或不修復才能處理時，在該項加註 `需決策`，寫明待決問題、可選做法與 reviewer 建議；判定仍依上列條件。協調者依 [acceptance.md](acceptance.md)「逐題確認」取得答案，結論記入 README `## 待確認事項`。

等待外部驗收窗需確認窗口前工作已完成；不修復審查的是決策來源、理由與殘餘影響。此類決策報告明列「決策審查」，不能拿來宣稱程式變更通過。
