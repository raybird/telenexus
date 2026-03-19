# Canonical SAR Anchors

這份文件記錄 TeleNexus 目前已固化的高價值 canonical anchors，作為 SAR 記憶治理的 seed 基準。

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

如需將 canonical anchors 重新寫入資料庫，可使用：

```bash
npm run memory:seed-sar-anchors
```

只檢查不寫入：

```bash
npm run memory:seed-sar-anchors -- --dry-run
```

## 維護原則

- 只有真正跨版本、跨 session、跨上下文仍需保留的決策才應成為 canonical anchor
- 以「技術地板 / 營運憲法 / 故障處置準則 / 發版規則」優先
- 一次保持少量高品質，避免 anchor 池再次膨脹成歷史 dump
