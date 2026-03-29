# Canonical SAR Anchors

這份文件列出 TeleNexus 目前固定保留的核心規則記憶。

你可以把它理解成：

- 不論對話多久、session 怎麼切，系統都應該盡量記得的關鍵做法
- 已經反覆驗證、值得長期保留的操作規則
- 可用來 seed 回資料庫的高價值記憶清單

如果你只是想知道「目前 AI 應該記住哪些固定規則」，看這份就夠了。

## 目前收錄

### 1. Gemini Recovery Rule

- 主題：`gemini`, `runner`, `memory`, `infra`
- 目的：穩定 Gemini 對話與 runner 執行路徑
- 核心規則：
  - `INVALID_ARGUMENT` + compression signature：先 `/compress`，失敗再考慮 `/new`
  - `RESOURCE_EXHAUSTED` / `MODEL_CAPACITY_EXHAUSTED`：不是 session 壞掉，不靠 `/new` 解決，優先等待重試或 fallback model/provider

### 2. Web Chat History Rule

- 主題：`web`, `memory`
- 目的：改善 chat 歷史上滑載入體驗
- 核心規則：
  - 採用 `cursor-based loading`
  - 採用 `incremental prepend`
  - 保留 `top-anchor scroll preserve`
  - 避免 offset pagination 與全量 re-render 造成閃爍與跳位

### 3. Release Workflow Rule

- 主題：`release`, `memory`
- 目的：固化 TeleNexus release SOP
- 核心規則：
  - 指令：`npm run release:patch -- -m "<commit message>"`
  - 流程固定：`commit > npm version > tag > push`
  - 發版時保留本地 `ai-config.yaml` 與 `workspace/` 測試檔不入版

### 4. Scheduler CLI Management Rule

- 主題：`scheduler`, `memory`
- 目的：固化 TeleNexus scheduler 管理與 reload 驗證方式
- 核心規則：
  - 以 `scheduler-cli` 作為主要治理入口
  - 支援：`list / add / update / remove / reload / health`
  - schedule 更新後優先走 HTTP reload，失敗才 fallback signal
  - 在 Docker Compose 環境應優先用 `docker compose exec telenexus ...` 執行

## Seed 指令

如需將這批核心規則記憶重新寫入資料庫，可使用：

```bash
npm run memory:seed-sar-anchors
```

只檢查不寫入：

```bash
npm run memory:seed-sar-anchors -- --dry-run
```

## 維護原則

- 只有真正跨版本、跨 session、跨上下文仍需保留的規則，才應放進這份清單
- 優先收錄：故障處置準則、發版規則、固定操作流程、重要技術邊界
- 保持少量高品質，避免這份清單再次膨脹成歷史筆記 dump
