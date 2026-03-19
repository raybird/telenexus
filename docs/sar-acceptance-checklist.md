# SAR Acceptance Checklist

這份文件提供 TeleNexus `Summary-Aware Retrieval (SAR)` 的固定驗收與 regression 測試清單。

目的：

- 驗證 SAR 檢索是否仍能命中關鍵長期記憶
- 驗證 prompt 是否仍正確注入 SAR 規則
- 驗證 canonical anchors、backfill、人工標記工具是否可用
- 在調整 prompt / memory / retrieval ranking 後快速發現退化

## 驗收前置條件

- 已完成 build：`npm run build`
- lint 通過：`npm run lint`
- DB 已具備 SAR schema：`impact_level`、`tags`
- canonical anchors 已存在；若不確定，先執行：

```bash
npm run memory:seed-sar-anchors
```

- 若需回填舊資料 metadata：

```bash
npm run memory:backfill-summary-metadata
```

## A. 工程驗收

### A1. Build / Lint

應通過：

```bash
npm run build
npm run lint
```

驗收標準：

- 無 TypeScript compile error
- 無 ESLint error

### A2. Canonical Anchor Seed

檢查 seed script 是否可重複執行且不重複插入：

```bash
npm run memory:seed-sar-anchors -- --dry-run
```

驗收標準：

- dry-run 可執行
- 若 anchors 已存在，應顯示 `Inserted: 0`
- 不應重複寫入同一批 canonical anchors

### A3. Memory CLI

檢查人工治理入口：

```bash
npm run memory:cli -- summaries --impact 3 --limit 10
```

驗收標準：

- 可正常列出高 impact summaries
- 可看到 canonical anchors 與既有人工提升記憶

## B. Prompt 注入驗收

### B1. SAR 規則是否進入 Chat Prompt

檢查 `buildChatPrompt(...)` 的輸出。

驗收標準：

- prompt 中包含 `【SAR 使用規則】`
- prompt 中包含 `【記憶參考（TeleNexus SAR）】`
- prompt 中包含至少一個 `【核心決策回顧】` 區塊（當有相關記憶時）

### B2. 預算控制

驗收標準：

- memory context 長度維持在可控範圍
- 沒有大量重複摘要
- 沒有 semantic / anchor 重複注入同一事件

## C. Query Regression Cases

以下案例是目前的核心 regression set。

### C1. Gemini Recovery

問題：

```text
之前 Gemini 常壞是怎麼處理的？
```

期望命中：

- `Gemini Recovery Rule`
- 關鍵詞：
  - `/compress`
  - `INVALID_ARGUMENT`
  - `RESOURCE_EXHAUSTED`
  - `MODEL_CAPACITY_EXHAUSTED`
  - `fallback model/provider`

可接受回答特徵：

- 能區分 compression failure 與 capacity failure
- 不會把所有 Gemini 問題都誤判成只要 `/new`

### C2. Web Chat History

問題：

```text
chat history 上滑載入最後怎麼修的？
```

期望命中：

- `Web Chat History Rule`
- 關鍵詞：
  - `cursor-based loading`
  - `incremental prepend`
  - `top-anchor scroll preserve`
  - 避免 `offset pagination`
  - 避免全量 re-render 閃爍

可接受回答特徵：

- 能指出這是 UX / 滾動穩定性修正
- 不應只回答舊的 generic web 架構摘要

### C3. Release SOP

問題：

```text
現在 release SOP 是什麼？
```

期望命中：

- `Release Workflow Rule`
- 關鍵詞：
  - `npm run release:patch -- -m "<commit message>"`
  - `commit > npm version > tag > push`
  - `ai-config.yaml` 不入版

可接受回答特徵：

- 能描述 command workflow
- 不應退回成過於抽象的「一般發版流程」

### C4. Scheduler CLI

問題：

```text
scheduler CLI 現在的管理方式是什麼？
```

期望命中：

- `scheduler-cli` 兩階段治理或近期 CLI 管理規則
- 關鍵詞：
  - `scheduler-cli`
  - `update`
  - `reload`
  - `CLI tool`

可接受回答特徵：

- 能提到 CLI 管理與 reload 機制

## D. 記憶治理驗收

### D1. Backfill

執行：

```bash
npm run memory:backfill-summary-metadata -- --dry-run --limit 200
```

驗收標準：

- 能正常掃描舊摘要
- 能輸出 impact/tag 分布統計

### D2. 手動提升

範例：

```bash
npm run memory:cli -- tag 1400 --impact 3 --tags release,scheduler,gemini,memory
```

驗收標準：

- metadata 可更新
- 不會清空原 summary（未帶 `--summary` 時）

## E. 退化判定

出現以下任一情況即視為 SAR regression：

- 問 Gemini 處置時，第一優先不再命中 `/compress` / `RESOURCE_EXHAUSTED` 分流
- 問 chat history 修正時，第一優先不再命中 cursor-based loading 規則
- 問 release SOP 時，回答不再能穩定提到 command workflow
- prompt 中缺失 `【SAR 使用規則】`
- anchors 開始被大量舊的泛化摘要淹沒

## F. 建議執行時機

- 每次調整 `src/prompt/builder.ts` 後
- 每次調整 summary prompt 後
- 每次改動 `src/core/memory.ts` retrieval 邏輯後
- 每次新增 canonical anchors 後
- 每次大版本 release 前

## G. 維護建議

- regression set 至少保留 `gemini / web / release / scheduler` 四類問題
- 若近期出現新的高頻故障模式，應新增對應 canonical anchor 與 regression case
- 保持少量、高價值、可重複驗證的問題，不要讓 checklist 膨脹成長篇測試腳本
