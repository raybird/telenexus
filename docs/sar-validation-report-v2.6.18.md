# SAR Validation Report v2.6.18

這份文件記錄 TeleNexus 在 `v2.6.18` 時點對 `Summary-Aware Retrieval (SAR)` 進行的實際驗收結果。

## 結論

- SAR 主線驗收通過
- canonical anchors、recency bias、query alias normalization 已生效
- `gemini / web chat history / release / scheduler` 四類核心問題均能命中正確 anchor
- 目前已達可用且穩定的第一階段營運狀態

## 驗收範圍

- build / lint
- canonical anchor seed
- summary metadata backfill dry-run
- memory CLI
- prompt 注入
- query regression cases

## 工程驗收結果

### Build / Lint

執行：

```bash
npm run build
npm run lint
```

結果：

- `npm run build` ✅
- `npm run lint` ✅

### Canonical Anchor Seed

執行：

```bash
npm run memory:seed-sar-anchors -- --dry-run
```

結果：

- `Inserted: 0`
- `Skipped existing: 4`

判讀：

- seed script 具 idempotent 行為
- 目前 canonical anchors 已存在，不會重複寫入

### Backfill Dry-Run

執行：

```bash
npm run memory:backfill-summary-metadata -- --dry-run --limit 200
```

結果：

- `Scanned: 12`
- `Changed: 0`

判讀：

- 現有高價值記憶 metadata 已與當前規則一致
- 這輪沒有需要再回填的差異

### Memory CLI

執行：

```bash
npm run memory:cli -- summaries --impact 3 --limit 12
```

結果：

- 可正常列出 critical summaries
- 可看到四筆主要 canonical anchors：
  - Gemini Recovery Rule
  - Web Chat History Rule
  - Release Workflow Rule
  - Scheduler CLI Management Rule

## Prompt 注入驗收

驗證方式：使用 `buildMemoryContext(...)` 與 `buildChatPrompt(...)` 檢查輸出。

結果：

- full prompt 含 `【SAR 使用規則】` ✅
- memory context 含 `【記憶參考（TeleNexus SAR）】` ✅
- 有相關 query 時會出現 `【核心決策回顧】` ✅

## Query Regression Results

### 1. Gemini Recovery

問題：

```text
之前 Gemini 常壞是怎麼處理的？
```

結果：

- 第一筆命中 `Gemini Recovery Rule` ✅
- 內容正確提到：
  - `/compress`
  - `INVALID_ARGUMENT`
  - `RESOURCE_EXHAUSTED`
  - capacity failure 不應只靠 `/new`

### 2. Web Chat History

問題：

```text
chat history 上滑載入最後怎麼修的？
```

結果：

- 第一筆命中 `Web Chat History Rule` ✅
- 內容正確提到：
  - `cursor-based loading`
  - `incremental prepend`
  - `top-anchor scroll preserve`

### 3. Release SOP

問題：

```text
現在 release SOP 是什麼？
```

結果：

- 第一筆命中 `Release Workflow Rule` ✅
- 內容正確提到：
  - `npm run release:patch -- -m "<commit message>"`
  - `commit > npm version > tag > push`
  - `ai-config.yaml` 不入版

### 4. Scheduler CLI

問題：

```text
scheduler CLI 現在的管理方式是什麼？
```

結果：

- 第一筆命中 `Scheduler CLI Management Rule` ✅
- 內容正確提到：
  - `scheduler-cli`
  - `list / add / update / remove / reload / health`
  - HTTP reload 優先，失敗再 fallback signal

### 5. Alias Query Regression

問題：

```text
發版流程現在怎麼走？
Gemini 壓縮壞掉時怎麼救？
聊天往上滾動載入最後怎麼穩住？
```

結果：

- alias query 皆可召回對應 canonical rule ✅
- query alias normalization 已實際生效 ✅

## 目前仍可補強之處

### 1. 近期對話仍偏長

- `【近期對話】` 區塊仍可能帶入較長的 Gemini 任務輸出
- 雖不影響第一筆 anchor 命中，但會吃掉 context 預算

### 2. Generic 大摘要仍可能占據次位

- 第一筆 anchor 現已正確，但第二、三筆仍可能混入較舊、較泛的大型摘要
- 特別在 `web` 類問題較明顯

### 3. Regression 仍屬人工執行

- 目前已有 checklist，但尚未變成 script 化自動驗證
- 未來建議補一個 SAR regression runner

## 目前判定

在 `v2.6.18`：

- SAR 主線功能已完成
- SAR 四大核心場景驗收通過
- 已可作為 TeleNexus 的穩定長期記憶檢索基礎

## 建議下一步

1. 進一步壓縮 `【近期對話】` 的長度
2. 對 generic 大摘要再做降權
3. 製作自動化 SAR regression script
