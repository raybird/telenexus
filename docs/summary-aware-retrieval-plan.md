# Summary-Aware Retrieval (SAR) Implementation Plan

> 狀態：已部分落地，本文同時保留原始規劃脈絡與目前實作校準。
>
> 若要看本輪保守改進路線，請搭配 `docs/sar-improvement-plan-minimal.md`。

## 維護者先看這裡

這份文件是給維護者看的設計與校準文件，不是首頁型介紹。

如果你只想快速理解現況，先看這三點：

- 已完成：三層長對話記憶檢索、impact/tag schema、核心規則記憶 seed、基本 regression 護欄
- 正在收斂：anchor 穩定性、budget trimming、一致化的記憶治理規則
- 還可再做：更完整的自動 regression、更加 `summary + tags` 優先的 retrieval、進一步 ranking 治理

建議閱讀順序：

1. `0. 目前實作校準`
2. `2. 目前系統現況`
3. `4. 檢索架構`
4. `9. 驗收標準`

## 0. 目前實作校準

截至目前版本，以下能力已存在，不再屬於純規劃：

- `messages` 已包含 `summary`、`impact_level`、`tags`
- `src/core/memory.ts` 已提供 recent conversation / summaries / summary search API
- `src/prompt/builder.ts` 已實作三層 SAR context 組裝
- `src/core/message-pipeline.ts` 已有 summary metadata inference
- canonical anchor seed、acceptance checklist、validation report 已建立

目前仍待補強的主要項目：

- 文件仍有部分段落停留在「尚未實作」時期
- anchor 候選池與 canonical 命中穩定性仍可提升
- SAR regression 尚未完整自動化

已知實作與原規劃差異：

- budget trimming 的實際順序與本文早期版本不同
- anchor 候選主要仍偏向近期 summaries，而非真正全域長期層
- canonical-first 已部分落地，但保底效果仍可再強化

## 1. 目標

SAR 要解決 TeleNexus 在長對話下的三個核心問題：

- 對話變長後，AI 容易只看見最近幾輪，忽略早期重大決策。
- 同一背景資訊需要反覆被搜尋或重述，浪費 token 與回應時間。
- 系統缺少「營運憲法 / 技術地板」等高優先級記憶層，導致回答因果不穩定。

本計畫採用「分層混合檢索」而非單純擴大 recent window，讓 prompt 在有限預算內同時保有：

- 近期連貫性
- 關鍵決策穩定性
- 專案語意補全能力

---

## 2. 目前系統現況

### 2.1 現有能力

- `messages` 已有 `summary` 欄位：`src/core/memory.ts`
- 目前已有 recent retrieval：`memory.getRecentMessages(...)`
- 目前已有 FTS 檢索：`memory.search(...)`
- prompt 組裝入口在：`src/main.ts` → `buildMemoryContext(...)` → `buildChatPrompt(...)`
- user / model 端皆已有 summary 生成流程：`src/core/message-pipeline.ts`

### 2.2 現有限制

- `buildMemoryContext(...)` 已改為三層 SAR 組裝，但 ranking 與 budget 行為仍有再調校空間。
- `summary` 已有 `impact_level` 與 `tags`，但 metadata 推論與治理仍以 heuristics 為主。
- anchors 目前仍偏向從近期 summaries 中挑選，長期穩定層仍可再硬化。
- FTS 已用於 SAR semantic retrieval，但目前命中仍偏向 content，尚未完全成為 `summary + tags` 優先的檢索層。

---

## 3. 設計原則

- **先做 MVP，再做治理**：先在現有 `summary` 基礎上做 retrieval layer，不先硬改所有資料流程。
- **控制總預算**：不要把所有摘要都塞進 prompt，必須有筆數與字數上限。
- **先摘要、後原文**：長距離記憶預設優先注入摘要，不直接堆原文。
- **避免重複注入**：同一事件若已在 causal anchors 中出現，不應再重複出現在 semantic 層。
- **recent context 不被取代**：SAR 是補強，不是替代近期原始對話。

---

## 4. 檢索架構

### 階層一：Immediate Context

- 內容：最近 `10` 則原始對話
- 目的：保留語氣、對話流、短期上下文
- 規則：保持時間順序，由舊到新注入

### 階層二：Causal Anchors

- 內容：高價值 summary
- 預設配額：最多 `4` 筆
- 預設來源：
  - Phase 1：`summary IS NOT NULL` 的近期高價值摘要候選
  - Phase 2：`impact_level >= 2`
- 目的：讓 AI 永遠看見重要決策、限制與操作規則

### 階層三：Semantic Refinement

- 內容：與使用者當前問題語意相關的歷史摘要
- 預設配額：最多 `3` 筆
- 來源：FTS 搜尋 + 摘要回查
- 目的：對特定專案、特定主題補齊長距離背景

### 總預算

- 預設上限：`1200 ~ 1800 chars`
- 建議初版上限：`1500 chars`
- 若超出預算，優先裁剪順序：
  1. semantic
  2. anchors
  3. recent 不裁，只縮短單筆摘要顯示長度

---

## 5. 權重設定（採納版本）

- `10 recent`
- `4 anchors`
- `3 semantic`
- `總字數上限`

這組權重的理由：

- `10 recent` 足以保留短期對話流，不會過度吃掉 prompt 空間。
- `4 anchors` 足以放入營運憲法級決策，但不至於變成大型歷史 dump。
- `3 semantic` 可作為 query-aware 補強，不會把 prompt 拉成搜尋結果列表。
- `總字數上限` 是必要保險，避免長摘要把 context 壓爆。

---

## 6. Prompt 組裝格式

建議輸出結構如下：

```text
【核心決策回顧】
- [2026-03-18] Docker 重啟後，Git 身份需透過 bootstrap.sh 修復
- [2026-03-18] Gemini compression failure 先 /compress，再考慮 /new

【相關歷史摘要】
- [gemini] runner 常見 429 為 MODEL_CAPACITY_EXHAUSTED，優先考慮 fallback model/provider
- [web] chat history 已改為 cursor-based loading，避免 offset 漂移

【近期對話】
- [User] ...
- [AI] ...
```

組裝規則：

- `核心決策回顧` 放最前面，作為高權重 reinforcement
- `相關歷史摘要` 放中間，依 query 相關性決定是否注入
- `近期對話` 放最後，維持 conversation continuity

---

## 7. 實作階段

### Phase 1：SAR MVP（不改 schema）

目標：在不調整 DB schema 的前提下，先做可運作的分層檢索。

#### 修改點

- `src/core/memory.ts`
  - 新增 `getRecentConversation(userId, limit)`
  - 新增 `getRecentSummaries(userId, limit)`
  - 新增 `searchSummaries(userId, query, limit)`
- `src/prompt/builder.ts`
  - 重構 `buildMemoryContext(...)`
  - 增加三層 context 組裝
  - 增加 budget trimming、去重、單筆摘要截斷
- `src/main.ts`
  - 入口不變，沿用 `buildMemoryContext(memory, userId, userMessage)`

#### Phase 1 檢索邏輯

1. 取最近 `10` 則原始對話
2. 從 `summary IS NOT NULL` 的近期記錄中，挑最多 `4` 筆 anchors 候選
3. 用 user message 關鍵字或 FTS 取最多 `3` 筆 semantic summaries
4. 去重、裁剪、套用總字數上限
5. 以固定段落格式注入 prompt

#### Phase 1 不做的事

- 不新增 DB 欄位
- 不做 impact 自動判級
- 不做 tags governance
- 不改動 summary 生產提示詞以外的大流程

註：以上為原始 Phase 1 規劃。實際上目前已完成 schema hardening 與基礎 impact/tag 寫入。

### Phase 2：Schema Hardening

目標：讓高價值記憶能被穩定標記與檢索。

#### DB 欄位

- `impact_level INTEGER DEFAULT 1`
  - `1`: 一般摘要
  - `2`: 重要決策
  - `3`: 營運憲法 / 技術地板
- `tags TEXT DEFAULT NULL`
  - 初版用逗號分隔或 JSON array，依現有 migration 難易度決定

#### 修改點

- `src/core/memory.ts`
  - migration 邏輯
  - 新增 impact / tags 讀寫方法
- `src/core/message-pipeline.ts`
  - summary 產生後可補上預設 impact/tag
- `src/prompt/builder.ts`
  - anchors 改以 `impact_level >= 2` 為主來源

狀態更新：此階段核心能力已完成，但 retrieval 與 ranking 仍未完全達到最終治理目標。

### Phase 3：標註與治理

目標：建立真正的「營運憲法」層。

#### 建議自動標記類型

- release / deployment SOP
- Gemini / runner / provider fallback 準則
- Docker / Git / bootstrap 修復慣例
- scheduler 管理原則
- 使用者明確偏好與長期決策

#### 手動標記入口

- 使用 `memory-cli summaries` 檢視近期已摘要記憶與其 `impact_level/tags`
- 使用 `memory-cli tag <id> --impact <1|2|3> --tags <tag1,tag2>` 人工提升真正的營運憲法級記憶
- 使用 `npm run memory:seed-sar-anchors` 寫入已確認的 canonical anchors（具 idempotent 行為）
- 適合手動升級的對象：
  - 發版與部署 SOP
  - Gemini / runner 故障處置準則
  - Web / chat 歷史載入等技術地板
  - 使用者明確指定要長期保留的決策

#### Canonical Anchor Seed

- 文件位置：`docs/canonical-sar-anchors.md`
- 目的：把近期最關鍵、最常被問到、且不應被舊摘要稀釋的規則，固化為高品質 seed anchors
- 初版收錄：
  - Gemini recovery rule
  - Web chat history rule
  - Release workflow rule
  - Scheduler CLI management rule

#### 建議 tags 初始集合

- `release`
- `web`
- `scheduler`
- `gemini`
- `runner`
- `memory`
- `infra`

### Phase 4：檢索優化

目標：提升相關性，降低噪音。

#### 優化項目

- relevance score 改善
- 同事件摘要去重
- anchors / semantic 交叉去重
- 時間衰減
- 專案權重與 topic boost
- canonical-first 保底命中（若 query 命中 canonical topic，至少保留 1 筆 canonical anchor）
- recency bias（近期 7 / 14 / 30 天的治理決策優先）
- query alias normalization（如「發版」對應 release workflow、「上滑載入」對應 chat history / cursor）

狀態更新：canonical-first、recency bias、query alias normalization 已部分落地；後續重點轉為穩定化與 regression 自動驗證。

---

## 8. 具體工程任務拆分

### 8.1 `src/core/memory.ts`

Phase 1：

- 新增查詢方法：最近原始對話
- 新增查詢方法：有 summary 的近期記錄
- 新增查詢方法：summary-aware FTS retrieval

Phase 2：

- migration：補 `impact_level`、`tags`
- 新增 impact/tag 更新與查詢 API

### 8.2 `src/prompt/builder.ts`

需要重構為：

- keyword extraction
- semantic retrieval
- anchor selection
- budget control
- context formatting

建議新增函式：

- `buildSarContext(...)`
- `selectCausalAnchors(...)`
- `selectSemanticSummaries(...)`
- `applyContextBudget(...)`

### 8.3 `src/core/message-pipeline.ts`

短期：

- 沿用既有 `userSummary` / `chat-followup-summary`

中期：

- 對 summary 做 impact/tag 自動標記
- 針對特定系統事件提升重要性

---

## 9. 驗收標準

### 功能驗收

- 長對話超過數百則後，AI 仍能回答先前的重要決策
- 問及特定主題（如 Gemini、scheduler、web）時，會引用對應歷史摘要
- 最近對話仍保持連續性，不因 anchors 介入而變得跳脫

### 具體測試案例

- 問：「之前 Gemini 常壞是怎麼處理的？」
  - 應能提到 `/compress`、`/new`、`RESOURCE_EXHAUSTED` 差異
- 問：「chat history 上滑載入最後怎麼修的？」
  - 應能提到 cursor-based loading / incremental prepend
- 問：「現在 release SOP 是什麼？」
  - 應能提到 command workflow 與 patch release 流程
- 重啟後詢問營運約定
  - AI 不應回到完全失憶狀態

### 工程驗收

- `npm run build` 通過
- `npm run lint` 通過
- prompt 長度有穩定控制，沒有明顯膨脹
- 沒有同一摘要重複注入兩次以上

補充固定化 regression 測試案例請見：`docs/sar-acceptance-checklist.md`

目前 `v2.6.18` 的實際驗證結果請見：`docs/sar-validation-report-v2.6.18.md`

---

## 10. 風險與對策

### 風險 1：summary 品質不穩

- 影響：會把低品質抽象放到高權重區
- 對策：Phase 1 先保守使用數量，Phase 2 再做 impact governance

### 風險 2：anchors 膨脹

- 影響：系統 prompt 變成歷史 dump
- 對策：限制最多 `4` 筆 + 總字數上限

### 風險 3：FTS 命中但因果不相關

- 影響：semantic 層變噪音
- 對策：先只注入 `3` 筆，並要求命中摘要優先

### 風險 4：實作過大影響現有穩定性

- 影響：prompt regression
- 對策：先走 Phase 1 MVP，逐步演進

---

## 11. 推薦實作順序

1. 文件化 SAR 設計（本文件）
2. 實作 Phase 1 MVP
3. 以真實對話驗證 3~5 天
4. 決定 `impact_level` / `tags` migration 細節
5. 實作 Phase 2 與 Phase 3
6. 進行權重與 retrieval tuning

---

## 12. 最終建議

對 TeleNexus 而言，SAR 的正確落地方式不是一次全面升級，而是：

- 先把既有 `summary`、recent、FTS 組成可控的三層 retrieval
- 用小配額 + 總字數預算避免 prompt 膨脹
- 之後再讓 `impact_level` 與 `tags` 成為治理層

因此本計畫採納的預設權重為：

- `10 recent`
- `4 anchors`
- `3 semantic`
- `總字數上限`

這會是 TeleNexus SAR v1 的基準配置。
