# Sessions DB Backfill Implementation Plan

## 1) 目標

- 將 `workspace/Memoria/.memory/sessions.db` 明確定位為 archive source，而不是主聊天查詢庫。
- 建立 `sessions.db -> memory.db` 的增量回填流程，讓長期事件能轉成可檢索知識。
- 保持主聊天流程低延遲：回填失敗不可阻塞 `moltbot.db` 寫入與 AI 回覆。
- 先補可觀測與對帳，再開啟實際寫入 `memory.db`。

---

## 2) 角色分工

- `data/moltbot.db`
  - Operational truth
  - 提供即時訊息、排程、短中期上下文
- `workspace/Memoria/.memory/sessions.db`
  - Archive truth
  - 提供完整 session/turn 事件歸檔與回填上游資料
- `data/memory.db`
  - Retrieval truth
  - 提供 MCP/長期記憶檢索

原則：

- 不用 `sessions.db` 直接支撐 chat prompt 熱路徑
- 不將 archive 全量鏡像到 `memory.db`
- 只回填高價值、可重用、低噪音的知識單位

---

## 3) 目標資料流

```text
User / Telegram / Web
        |
        v
   TeleNexus pipeline
        |
        +--> data/moltbot.db
        |     - 即時訊息
        |     - 排程
        |     - SAR / recent context
        |
        +--> Memoria sync
              |
              v
   workspace/Memoria/.memory/sessions.db
        |
        +--> reconciliation / coverage check
        +--> candidate extraction
        +--> backfill worker
              |
              v
          data/memory.db
          - 長期知識
          - semantic retrieval
          - user / project preferences
```

---

## 4) 實作範圍

本輪包含：

- `sessions.db` 健康度與覆蓋率可觀測
- 回填 checkpoint 機制
- 候選知識抽取與去重策略
- dry-run 模式
- 增量寫入 `memory.db` 的 worker 規劃

本輪不包含：

- 直接改寫 chat prompt 讓其查 `sessions.db`
- 大規模 archive 全量索引
- 完整 forget / TTL 操作面
- 複雜 UI，先以 CLI + snapshot + API 為主

---

## 5) Phase 拆分

### Phase 1：Archive Health（先可觀測）

目的：先回答「資料有沒有進 archive、archive 是否落後」。

建議新增：

- `workspace/context/memory-status.md`
- `GET /api/memory-health`（後續 Web dashboard 可接）
- `node dist/tools/memory-health-cli.js` 或整合進現有 CLI

最少指標：

- `archive_enabled`
- `archive_total_sessions`
- `archive_last_session_at`
- `archive_last_sync_success_at`
- `archive_sync_failures_24h`
- `archive_estimated_gap_recent_24h`
- `backfill_last_run_at`
- `backfill_last_success_at`
- `backfill_checkpoint`

驗收：

- 能判斷最近 24h 對話是否有成功落進 archive
- 能看出最近是否有 sync failure 或明顯缺洞

### Phase 2：Checkpoint + Reconciliation

目的：建立增量回填骨架，避免全量反覆掃描。

建議新增 checkpoint 檔：

- `data/memory-backfill-checkpoint.json`

建議欄位：

```json
{
  "lastProcessedSessionId": "...",
  "lastProcessedTimestamp": "2026-03-29T00:00:00.000Z",
  "lastRunAt": "2026-03-29T00:10:00.000Z",
  "lastSuccessAt": "2026-03-29T00:10:02.000Z",
  "lastRunStatus": "success",
  "lastError": ""
}
```

對帳重點：

- `moltbot.db` 最近 N 小時 turn 數量
- `sessions.db` 最近 N 小時 session / event 數量
- 差距是否超過閾值
- 同步最老缺口時間

驗收：

- worker 可從 checkpoint 續跑
- worker 中斷後可重啟，不需全量重掃

### Phase 3：Candidate Extraction（高價值抽取）

目的：不是把 archive 原文複製進 `memory.db`，而是抽取值得長期保存的知識。

候選類型：

- 使用者偏好
- 專案決策
- 穩定事實
- 待辦承諾
- 重複出現的營運規則

排除類型：

- 寒暄
- 一次性 debug 雜訊
- 無結論的中間推理
- 太短、太泛、無法重用的內容

建議輸出結構：

```json
{
  "type": "preference|decision|fact|task|rule",
  "summary": "使用者偏好以繁體中文回覆",
  "details": "...",
  "tags": ["language", "preference"],
  "confidence": 0.92,
  "userId": "...",
  "source": {
    "store": "sessions.db",
    "sessionId": "...",
    "timestamp": "2026-03-29T00:00:00.000Z"
  }
}
```

抽取策略：

- 初版可先 rule-based + heuristic
- 後續再評估是否加 LLM summarizer / classifier
- 現行實作優先採用 user-authored 指令/偏好/決策，盡量避免把冗長 model 回覆直接回填成長期記憶

驗收：

- dry-run 可輸出候選知識清單
- 噪音率可人工抽查控制在可接受範圍

### Phase 4：Dedup / Conflict Handling

目的：避免 `memory.db` 被重複偏好、舊決策、互相衝突內容污染。

建議去重鍵：

- `normalized_summary`
- `type + userId + primary tags`
- `source fingerprint`

處理規則：

- 完全重複：跳過
- 高相似：更新 `last_seen_at`
- 新版覆蓋舊版：標記舊版 `superseded`
- 明顯衝突：兩者並存，但舊版降 confidence

驗收：

- 同一偏好或規則不會被每輪對話重複灌入
- 發生衝突時可追溯來源 session

### Phase 5：Write Path to `memory.db`

目的：讓 `sessions.db` 成為 `memory.db` 的安全上游。

建議模式：

- 小批次寫入
- 每批獨立失敗可重試
- 寫入成功後才推進 checkpoint
- 失敗只記錄，不阻塞主流程

建議 worker 模式：

- 手動執行：`memory-backfill --once`
- 排程執行：每 5~15 分鐘一批
- dry-run：`memory-backfill --dry-run`

驗收：

- 實際寫入 `memory.db` 後，能在 MCP retrieval 端看見新增長期知識
- backfill 失敗不影響 chat / scheduler 主流程

---

## 6) 建議新增元件

### 後端

- `src/services/memory-health.ts`
  - 統一彙整 `moltbot.db` / `sessions.db` / checkpoint 健康度
- `src/services/memory-backfill.ts`
  - archive 掃描、候選抽取、去重、寫入編排
- `src/tools/memory-health-cli.ts`
  - 顯示 archive/backfill 指標
- `src/tools/memory-backfill-cli.ts`
  - `--once` / `--dry-run` / `--from-checkpoint`

### Context / Snapshot

- `workspace/context/memory-status.md`
  - 給 Web dashboard 與運維直接讀

### Web API

- `GET /api/memory-health`
  - dashboard 指標
- 後續視需要新增 `GET /api/memory-backfill/report`

---

## 7) `memory-status.md` 建議欄位

```text
# Memory Status

- archive_enabled: true
- archive_total_sessions: 1284
- archive_last_session_at: 2026-03-29T01:23:45.000Z
- archive_sync_failures_24h: 0
- backfill_enabled: false
- backfill_last_run_at: 2026-03-29T01:25:00.000Z
- backfill_last_success_at: 2026-03-29T01:25:02.000Z
- backfill_candidates_last_run: 14
- backfill_written_last_run: 6
- backfill_duplicates_last_run: 8
- backfill_checkpoint: 2026-03-29T01:20:00.000Z
- archive_gap_recent_24h: 0
```

---

## 8) 推薦環境變數

```env
MEMORY_BACKFILL_ENABLED=false
MEMORY_BACKFILL_DRY_RUN=true
MEMORY_BACKFILL_INTERVAL_MS=300000
MEMORY_BACKFILL_BATCH_SIZE=50
MEMORY_BACKFILL_MAX_CANDIDATES_PER_RUN=20
MEMORY_BACKFILL_CHECKPOINT_FILE=/app/data/memory-backfill-checkpoint.json
MEMORY_BACKFILL_MAX_LAG_WARN_MINUTES=30
```

原則：

- 預設先 `disabled` 或 `dry-run`
- 先觀察品質，再逐步開正式寫入

---

## 9) Rollout 建議

### Step A：只上可觀測

- 新增 `memory-status.md`
- 新增 `/api/memory-health`
- 不寫入 `memory.db`

### Step B：啟用 dry-run backfill

- 掃描 `sessions.db`
- 輸出候選知識與去重結果
- 人工抽樣驗證品質

### Step C：小流量正式寫入

- 限制 batch size
- 每次只寫少量高信心候選
- 觀察重複率、衝突率、檢索命中率

### Step D：常態化排程

- 固定增量回填
- 補 dashboard 呈現 archive/backfill 健康度

目前落地狀態（2026-03-29）：

- 已有 `MemoryBackfillWorker`
- 啟用 `MEMORY_BACKFILL_ENABLED=true` 時，會依 `MEMORY_BACKFILL_INTERVAL_MS` 定期跑增量 backfill
- worker 會自動保存 checkpoint，並在每輪後刷新 `memory-status.md`

---

## 10) 成功標準

- 回填失敗 0 次阻塞主聊天流程
- archive 缺口可在 5 分鐘內被觀測到
- `sessions.db -> memory.db` 回填可斷點續跑
- 候選知識重複率可控
- 長期知識檢索品質有可觀察提升

---

## 11) 實作檢查清單

- [ ] 新增 `memory-status.md` 快照產生器
- [ ] 新增 `memory-health` service 與 API
- [ ] 新增 backfill checkpoint 機制
- [ ] 新增 backfill dry-run CLI
- [ ] 實作候選知識抽取規則
- [ ] 實作 dedup / conflict handling
- [ ] 串接 `memory.db` 寫入層
- [ ] 新增 dashboard 指標卡與告警閾值
- [ ] 補 runbook 與回退策略

---

## 12) 回退策略

- `MEMORY_BACKFILL_ENABLED=false`
- `MEMORY_BACKFILL_DRY_RUN=true`
- 保持 `MEMORIA_SYNC_ENABLED` 與 backfill 解耦
- 回填 worker 故障時，只停用回填，不影響聊天與 archive sync

---

## 13) 相關檔案

- `src/core/memoria-sync.ts`
- `src/core/message-pipeline-chat.ts`
- `src/main.ts`
- `src/web/server.ts`
- `src/core/memory.ts`
- `docs/memory-v3-architecture-plan.md`
- `docs/configuration-reference.md`
