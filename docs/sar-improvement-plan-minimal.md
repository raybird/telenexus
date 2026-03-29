# SAR Improvement Plan (Minimal Changes)

這份文件定義 TeleNexus 現階段對 `Summary-Aware Retrieval (SAR)` 的保守改進路線。

它的角色是 roadmap，不是現況主文件。

- 想看目前實作與校準：請先看 `docs/summary-aware-retrieval-plan.md`
- 想看固定保留的高價值規則：請看 `docs/canonical-sar-anchors.md`
- 想知道這份文件的用途：它主要回答「下一步還值得做什麼」

目標不是重做整個 memory / retrieval 架構，而是先以低風險方式補強三件事：

- 文件與現況一致
- 長期 anchor 穩定性提升
- prompt regression 有最基本的測試護欄

## 目前判斷

這份文件建立於 `v2.6.19` 附近，後續多項項目已陸續完成；因此它適合保留作為最小改進思路，不適合單獨當成最新現況說明。

建立當時的實作狀態：

- `impact_level` / `tags` schema 已存在
- `buildMemoryContext(...)` 已採三層 SAR 組裝
- metadata inference 已存在於寫入流程與 backfill 腳本
- canonical anchor seed、acceptance checklist、validation report 都已具備

但目前仍有三個主要缺口：

1. 文件仍混有「尚未實作」的舊敘述
2. anchor 候選池偏短，canonical 規則可能隨時間掉出主要命中層
3. SAR regression 仍主要依賴人工驗證

## 實作原則

- 優先修正文件與規格認知落差
- 先做小幅 retrieval 調整，不先進行新一輪 DB migration
- 先補最小可用測試，不直接上完整 e2e regression framework
- 以不破壞既有 prompt 體感為前提，逐步收斂 budget 與 ranking

## Phase 1 - 文件校準

### 目標

- 讓 SAR 文件能正確反映目前程式狀態
- 降低未來維護者誤讀風險

### 範圍

- 更新 `docs/summary-aware-retrieval-plan.md`
- 在 `docs/sar-retrieval-spec-v1.md` 標記為早期草案
- 在 `docs/sar-validation-report-v2.6.18.md` 補充人工 regression 現況

### 完成標準

- 文件不再宣稱 `impact_level` / `tags` 尚未存在
- 文件清楚標註現行實作與原規劃的差異
- 文件索引可導向這份改進計畫

## Phase 2 - Anchor 穩定化

### 目標

- 降低 canonical / 高價值規則隨時間掉出候選池的風險

### 最小改動方向

- 擴大 anchor 候選池，不只看最近 12 筆 summaries
- 保留 recency bias，但不要讓它成為 canonical 的硬門檻
- 保持現有 `impactLevel` / `tags` / alias normalization 設計不大改

### 完成標準

- 問 `gemini / web / release / scheduler` 類問題時，長期規則仍可穩定命中
- recent summaries 增加後，canonical 命中率不明顯退化

## Phase 3 - Budget 與 Trimming 收斂

### 目標

- 讓實作行為與文件規格一致
- 降低 recent 長輸出或 generic 大摘要吃掉 context 預算的風險

### 最小改動方向

- 決定正式 trimming 順序並文件化
- 保留 recent continuity 的最低筆數
- 避免最後整段硬截斷破壞 section 結構

### 完成標準

- `【核心決策回顧】`、`【相關歷史摘要】`、`【近期對話】` 結構穩定
- 相同案例重跑時，不會因 budget trimming 產生過大波動

## Phase 4 - 最小 Regression 護欄

### 目標

- 讓 SAR 核心行為至少有基本自動化守門

### 最小改動方向

- 補 prompt builder / memory retrieval 層級的測試
- 至少覆蓋：
  - `【SAR 使用規則】` 有注入
  - 相關 query 可產生 `【核心決策回顧】`
  - anchor / semantic 不重複注入

### 完成標準

- 調整 `src/prompt/builder.ts` 後，可透過 `npm test` 快速偵測核心 regression

## 暫不納入本輪

- summary 專用 FTS migration
- 大型 ranking 重寫
- 完整 e2e SAR regression runner
- memory CLI 體驗重構

## 建議執行順序

1. 文件校準
2. anchor 穩定化
3. budget / trimming 收斂
4. 最小 regression 護欄

## 後續擴充入口

若最小改動版穩定後，再往下考慮：

- 抽出共用 metadata inference 模組
- 讓檢索真正以 `summary + tags` 為主
- 建立 script 化 SAR regression runner
