# 文件類型與內容規範

> 本檔依 AGENTS.md 按需載入；核准與驗證語意依 acceptance.md、verification.md，版本相容性依流程契約。

各文件的用途、標記與「應包含的內容」；是否建立則依 `docs/AGENTS.md`「文件動態分級規範」。

## 文件類型與內容規範

各文件的用途、標記與「應包含的內容」皆以本節為單一依據（是否建立則依「文件動態分級規範」）：

### README.md（必備）

議題的入口文件。所有分級都必須包含：

- 議題概述
- 驗收標準（Small 為輕量驗收條件；Medium / Large 為具唯一 Scenario ID 的 Gherkin 與核准紀錄）
- 涉及檔案清單
- 風險與首要驗證
- 可執行步驟或其權威來源
- Timeline
- 分級、風險與狀態 metadata

Medium / Large 另須包含文件清單（連結到實際建立的文件即可）；「快速導覽」與「關鍵差異」只在有新舊行為或流程對照時撰寫（重構、遷移、行為變更類 issue），沒有對照可寫時不硬填這兩節。Small 採輕量級格式，不補入這些非必要章節。

### requirement-analysis.md（Large，觸發條件成立時）

應包含：
- 需求描述
- 現況分析（詳細說明現有程式碼邏輯）
- 問題點總結
- 目標

涉及檔案清單只維護在 README 的 `## 涉及檔案`，本檔不另行複寫。

### technical-analysis.md（Large，觸發條件成立時）

閱讀程式碼後撰寫，應包含：
- 技術可行性分析
- 方案選型與取捨
- 架構影響評估
- 實作細節與待釐清項目

### implementation-plan.md（Medium / Large 適用）

應包含：
- 設計方案（函式簽名、流程設計）
- 實作步驟（分階段，標記完成狀態）
- 使用方式對照（變更前後）
- 測試策略
- 驗收編號對應的測試層級與策略（同層可合併，不改變行為者記等價證據）
- Large 的 Phase / Task 直接細化在本檔；進度與證據維持同一份清單
- 風險與首要驗證：引用 README 的 `## 風險與首要驗證`，不另行複寫五項欄位
- 檢查清單

**實作步驟的排序原則**：依「風險優先決策流程」先選擇能直接降低最大風險的驗證手段，再排列主要實作。README 的 `## 待確認事項` 與需求文件中標注的未知都是判斷依據，但不得未經比較就預設採用垂直切片。

### 其他專項文件（明確需要時）

下列文件不屬於 `new-issue` 依分級建立的初始必要集合。只有使用者明確要求，或後續實作已確認有獨立維護需求時才建立；不得為了補齊範例而在初建時自動產生。

- `refactoring-notes.md` - 檔案重構說明，應包含：重構時間、重構內容、重構緣由（詳細說明）、檔案結構變更、程式碼變更細節、驗證結果、影響範圍
- `migration-plan.md` - 遷移計劃
- `test-cases.md` - 測試案例
- 等等

## 邊界與方案的視覺形式

文字敘述可以含糊而不報錯——「相關的 session 模組」讀起來像有邊界，實際上沒有。下列兩種形式把含糊處逼成具體值，各對應一個分支：

**淺層檔案樹——邊界含不可觸及區域時。** 用於 README 的 `## 涉及檔案`（界定最小邊界的產出）。深度維持在目錄或單一檔案這一層：

```text
src/
├── commands/       # 可改：新增 handler
├── sessions/       # 可改：擴充 state 欄位
└── transport/      # 不可觸及：本 issue 不動傳輸層
```

**diff——方案差異落在同一個既有形狀上時。** 用於需要比較有實質取捨的方案時，以及 `technical-analysis.md` 的「方案選型與取捨」。diff 的對象是那個形狀本身，檔案配置、狀態流、呼叫順序都成立，不限於原始碼：

```diff
 on(save)
-  write content
+  if content is unchanged
+    return cached result
+  write new content
```

順序與互動類的圖沿用 `docs/_templates/` 既有的 Mermaid，本節不另立形式。

issue 文件的圖一律以純文字或 Mermaid 呈現，維持可被 `git diff` 讀出差異、可被 agent 直接讀取。驗收標準維持 Gherkin 或輕量驗收條件的文字形式——它是可執行契約，形式的單一真相來源在 `docs/AGENTS.md`。

**一份 issue 通常只有一處值得畫。** 選出最能減少來回確認的那一處；每張圖都答得出它取代了哪一段容易含糊的敘述，答不出來就改用文字。

## 常見文件類型範例

> [!NOTE]
> 本節屬【應客製】：下方組合為範例，請替換成專案實際出現過的議題類型與文件組合。

以下是既有 issue 或使用者明確要求專項文件時的可能組合，不代表 `new-issue` 的初始必要集合；初建文件仍以分級規範為準。

### 重構類議題

- README.md - 概述與快速導覽
- requirement-analysis.md - 現況分析
- implementation-plan.md - 實作計劃
- refactoring-notes.md - 重構說明

### 遷移類議題

- README.md - 概述與流程對照
- requirement-analysis.md - 需求分析
- migration-plan.md - 遷移策略
- implementation-guide.md - 實作指南

### 分析類議題

- README.md - 文件索引
- {topic}-flow-analysis.md - 流程分析
- {topic}-blocking-factors.md - 阻擋因素
- flow-diagram.md - 流程圖
- simplified-guide.md - 簡化說明
