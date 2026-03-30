# 記憶系統實作分析報告

> 分析日期：2026-03-30
> 範圍：記憶系統全鏈路（Backfill、Retrieval、Governance）

> 更新狀態：截至目前，P0、P1 已完成；P2 已完成 checkpoint 原子寫入、worker timeout、idle-skip、scheduler -> memory loop；P3 已完成 telemetry 與跨 DB 一致性檢查，其餘治理項仍待實作。

---

## 1. 架構總覽

### 1.1 三個資料庫

| 資料庫        | 路徑                                    | 用途                     | 現有規模                                     |
| ------------- | --------------------------------------- | ------------------------ | -------------------------------------------- |
| `moltbot.db`  | `data/moltbot.db`                       | 對話訊息、排程（交易層） | 3,717 messages, 11 schedules                 |
| `memory.db`   | `data/memory.db`                        | MCP 語意圖譜（檢索層）   | 259 entities, 629 observations, 22 relations |
| `sessions.db` | `workspace/Memoria/.memory/sessions.db` | 長期事件歸檔（歷史層）   | 614 sessions, 1,228 events                   |

### 1.2 資料流向

```
User Message → moltbot.db → memoria-sync → sessions.db
                    ↑              ↑
                    └── backfill → memory.db
```

---

## 2. 嚴重問題

### 2.1 Backfill 候選提取效能極低

614 個 session 僅產出 **3 筆** observation（0.5% 成功率）。

| 原因       | 細節                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| 關鍵字過窄 | 硬編碼中文 regex，preference 類型命中 **0 次**                                           |
| 只取首筆   | 每類別用 `.find()` 取第一筆，長對話中後面的決策遺失                                      |
| Bug        | Rule 第一層提取**跳過** `isHighQualityCandidateText`，導致 markdown 表格混入 `memory.db` |

**Bug 詳細**（`src/services/memory-backfill.ts` 第 477-481 行）：

第一層 rule 提取僅檢查關鍵字存在與否，未呼叫 `isHighQualityCandidateText`：

```typescript
const ruleSource =
  userTexts.find(
    (text) =>
      /都要|必須|只能|不要再|務必|每次.+都要/i.test(text) &&
      !isQuestionLike(text) &&
      !/我認為/.test(text)
  ) ||
  userTexts.find(
    (text) =>
      looksPolicyOrRule(text) &&
      isHighQualityCandidateText(text) && // <-- 僅第二層檢查品質
      !isLowSignalPrompt(text) &&
      !/我認為/.test(text)
  );
```

**生產環境證據**：其中一筆回填的 observation 內含 markdown 表格（`| 專案 | 狀態 |`），本應被 `hasStructuralNoise` 攔截。

### 2.2 Memoria 同步失敗時資料永久丟失

- `finally` 區塊**不論成功失敗都刪除 payload**
- `.catch()` 僅 log console，**不呼叫** `recordRuntimeIssue()`，健康系統看不到失敗
- 24h 內有 **18 個 session gap**（未同步到 archive）
- 失敗的 payload 沒有 retry queue，資料永久遺失

### 2.3 記憶檢索無信心度篩選

- Backfill 有 confidence 標記（0.76~0.94），但**寫入後完全不使用**
- 任何 observation 進入 `memory.db` 後，retrieval 端無法區分「高信度」vs「低信度」
- SAR 檢索路徑（`src/prompt/builder.ts`）僅依賴 impact level、關鍵字、時間，無 confidence 參與

---

## 3. 中度問題

### 3.1 FTS5 索引不含 summary + tags

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_id, role, content, timestamp
)
```

`searchSummaries()` 退化為 FTS 搜 content + LIKE 搜 summary/tags，語意匹配品質差。

### 3.2 兩套獨立評分系統

| 函式                         | 位置                           | 用途            |
| ---------------------------- | ------------------------------ | --------------- |
| `scoreSummary()`             | `src/prompt/builder.ts:95-129` | Prompt 層級排名 |
| `scoreSummarySearchResult()` | `src/core/memory.ts:219-243`   | Search 層級排名 |

兩者對相同訊號（impact level、recency、keyword）給予不同權重，維護風險高。

### 3.3 Budget 壓力下 semantic 層全被砍

`applyContextBudget()` 修剪順序：semantic → anchor → recent。在重度壓力下 semantic 層可被完全移除，導致查詢無相關記憶。

### 3.4 Checkpoint 寫入非原子性

`fs.writeFileSync` 崩潰時檔案損毀。`readCheckpoint()` 在 parse error 時回傳 `null`，下次從頭跑。

### 3.5 Worker 無 timeout

`inFlight` flag 無逾時釋放機制。掛起的 run 永久阻塞後續排程。

### 3.6 排程產出未納入記憶閉環

scheduler 結果存入 `moltbot.db`（`scheduler.ts:348,357`），但不回流 `memory.db`。backfill 只從 `sessions.db` 讀取，不處理 `moltbot.db` 中的排程輸出。

> 已修復：scheduler 輸出現已補上 `inferSummaryMetadata(...)` 並接入 `enqueueMemoriaSync(...)`，會回流 archive / backfill 鏈路。

---

## 4. 低度問題

### 4.1 無語意去重

同一語意但不同表達（如「請用繁中」vs「以後都用繁體中文」）視為不同 observation，造成重複儲存。

`estimateExistingDuplicates` 僅檢查最近 2000 筆（`LIMIT 2000 ORDER BY id DESC`），成長後可能遺漏。

### 4.2 無 TTL 自動過期

三個 DB 持續膨脹，無時間-based 的自動清理或歸檔機制。

### 4.3 無隱私標記

- 無 ephemeral flag 標記不可持久化資料
- `memory clear` 為全有全無式刪除，無範圍 forget（by tag / topic / time range）
- 無 PII 偵測

### 4.4 無遥測指標

- 無候選類型命中率統計（preference / decision / task / rule）
- 無信心度分佈追蹤
- 無提取模式 rejection 原因記錄
- 無 processing latency 量測

> 已修復：`memory-backfill` report 已新增 `candidateTypes`、`confidenceBuckets`、`rejectionReasons`、`modelFallbackCandidates`、`extractionMs`。

### 4.5 無跨 DB 一致性檢查

- 無 orphaned records 偵測
- 無 moltbot.db ↔ sessions.db ↔ memory.db 交叉驗證
- 健康報告僅有 `estimatedGapRecent24h`（計算值），無實際 reconcilation

> 已修復：`memory-health` 已新增 consistency 區塊，會檢查 orphan observations、缺 `source_session` observation、checkpoint 漂移與 checkpoint 指向不存在 session。

---

## 5. Memoria 同步詳細分析

### 5.1 同步流程

| 階段       | 實作                                                              |
| ---------- | ----------------------------------------------------------------- |
| Enqueue    | `enqueueTurn()` 序列化 JSON payload 到 temp 目錄                  |
| Dedup      | SHA-256 hash（`user + "---" + model`），10 分鐘 TTL in-memory Map |
| 執行       | Serial queue，spawn Memoria CLI                                   |
| Hook queue | 可選輪詢 `memoria-hook-queue.jsonl`（5s 週期）                    |

### 5.2 失敗模式

| 情境                 | 行為                   | 問題                              |
| -------------------- | ---------------------- | --------------------------------- |
| CLI 缺失             | `auto` 模式靜默停用    | 無錯誤通知                        |
| Timeout              | SIGTERM 後 reject      | payload 在 finally 刪除，資料丟失 |
| 模式 `on` + CLI 缺失 | log warning 但繼續排隊 | 不設 `disabled`，持續失敗         |

### 5.3 18-session gap 成因

1. Memoria sync 失敗（CLI 缺失 / timeout / payload 被刪）
2. `auto` 模式靜默停用
3. 無 retry 機制
4. `.catch()` 不回報 `recordRuntimeIssue()`，健康系統不可見

---

## 6. 候選提取模式分析

### 6.1 四類候選

| 類型       | 來源                 | 信心度      | 偵測關鍵字                                                                                |
| ---------- | -------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| preference | 使用者文字           | 0.94        | `請用\|請以\|主要用\|以後都\|之後都\|預設用\|繁體中文\|繁中\|台灣用語\|不要用`            |
| decision   | 使用者優先，模型回退 | 0.86 / 0.78 | `決定\|改成\|改用\|統一\|採用\|定案\|之後就\|接下來都\|我認為\|建議\|就用\|可以使用`      |
| task       | 使用者文字           | 0.76        | `待辦\|記得\|之後要\|需要補\|請幫我\|幫我整理\|幫我規劃\|下一步`                          |
| rule       | 使用者優先，模型回退 | 0.82 / 0.76 | `都要\|必須\|只能\|不要再\|務必\|每次.+都要` / `原則\|規則\|政策\|禁止\|不可\|必須\|只能` |

### 6.2 品質篩選

- `isHighQualityCandidateText`：拒絕問題、結構噪音（表格/清單/URL/多行/過長）、過短文字
- `isLowSignalPrompt`：過濾模糊對話開場（`那\|所以\|然後\|可以\|幫我\|你\|目前\|現在`）

### 6.3 弱點

1. 硬編碼中文，無法偵測英文
2. 同義詞遺漏（`應該用` 不在 preference list，`我想用` 不在 decision list）
3. `.find()` 只取首筆，多 fact 對話遺失
4. 第一層 rule 提取跳過品質檢查

---

## 7. SAR 檢索分析

### 7.1 三層混合檢索

| 層       | 來源                                                             | 限制                        |
| -------- | ---------------------------------------------------------------- | --------------------------- |
| 近期脈絡 | 最近 10 筆 raw messages                                          | 無                          |
| 因果錨點 | 高 impact summaries（`impact >= 2`）+ canonical（`impact >= 3`） | 最多 4 筆，canonical 至少 1 |
| 語意精煉 | 關鍵字重疊 + FTS5/LIKE search                                    | 最多 3 筆                   |

### 7.2 評分機制

**`scoreSummary()`（Prompt 層）**：

```
+ length bonus（min(length/140, 3)）
+ (impactLevel - 1) * 3
+ recency boost（8/7d, 5/14d, 3/30d, 1/90d）
+ 2 if matches important pattern（/decision|SOP|fallback|bootstrap|runner|Gemini/i）
+ 2 if tags contain important tags（release, gemini, runner）
+ 1 if role === 'model'
+ 5 per matching query tag
+ 2 per matching keyword
```

**`scoreSummarySearchResult()`（Search 層）**：

```
+ 10 if full query matches summary
+ 4 if full query matches content
+ 4 per token in summary, 1 per token in content
+ 5 per token in tags
+ (impactLevel - 1) * 2
+ 2 if within 7 days, 1 if within 30 days
```

### 7.3 預算控制

`applyContextBudget()` 總字元預算 ~1500 chars。修剪順序：

1. Semantic summaries 先砍
2. Causal anchors 次砍
3. Recent messages 最後（保留最少 4 行）

---

## 8. 現有優勢

| 項目                      | 說明                                                       |
| ------------------------- | ---------------------------------------------------------- |
| 三層檢索結構              | 解決「近期記憶失憶」問題                                   |
| Canonical anchors         | impact_level=3 + tag 檢索對已知領域有效                    |
| 查詢別名正規化            | 「發版」→ release、「上滑載入」→ chat history 橋接詞彙差距 |
| Checkpoint-based backfill | 支援斷點續跑                                               |
| 品質篩選                  | 問句、結構噪音、過短文字過濾                               |
| 非阻塞設計                | backfill 失敗不影響主對話                                  |

---

## 9. 優化建議優先順序

### 9.0 目前進度

| 階段 | 狀態        | 已完成項目                                                                                 |
| ---- | ----------- | ------------------------------------------------------------------------------------------ |
| P0   | ✅ 完成     | rule quality filter、Memoria 失敗 payload 保留、runtime issue 記錄                         |
| P1   | ✅ 完成     | backfill 關鍵字擴充與多筆提取、`summary/tags` FTS、semantic 最低保留、summary scoring 統一 |
| P2   | 🟡 部分完成 | checkpoint 原子寫入、worker timeout、checkpoint idle-skip、scheduler -> memory loop        |
| P3   | 🟡 部分完成 | telemetry、一致性檢查已完成；TTL、隱私標記仍待實作                                         |

### P0 — 立即修復

| #   | 改動                                      | 檔案                     | 狀態    | 收益             |
| --- | ----------------------------------------- | ------------------------ | ------- | ---------------- |
| 1   | Rule 提取加 `isHighQualityCandidateText`  | `memory-backfill.ts:477` | ✅ 完成 | 防止噪音資料污染 |
| 2   | Memoria 失敗時保留 payload 到 retry queue | `memoria-sync.ts`        | ✅ 完成 | 消除 session gap |
| 3   | `.catch()` 呼叫 `recordRuntimeIssue()`    | `memoria-sync.ts:296`    | ✅ 完成 | 健康系統可見失敗 |

### P1 — 短期改善

| #   | 改動                                                    | 檔案                       | 狀態    | 收益                     |
| --- | ------------------------------------------------------- | -------------------------- | ------- | ------------------------ |
| 4   | 擴充候選關鍵字 + 多筆提取（`.filter()` 取代 `.find()`） | `memory-backfill.ts`       | ✅ 完成 | 從 0.5% 提升到合理命中率 |
| 5   | FTS5 增加 `summary_fts` 虛擬表（索引 summary + tags）   | `memory.ts`                | ✅ 完成 | 大幅提升 SAR 搜尋品質    |
| 6   | Semantic 層加最低保留（至少 1 筆）                      | `builder.ts`               | ✅ 完成 | 防止查詢盲區             |
| 7   | 統一兩套評分系統                                        | `builder.ts` + `memory.ts` | ✅ 完成 | 降低維護風險             |

### P2 — 中期強化

| #   | 改動                                         | 檔案                        | 狀態    | 收益         |
| --- | -------------------------------------------- | --------------------------- | ------- | ------------ |
| 8   | Checkpoint 原子寫入（write tmp → rename）    | `memory-backfill.ts`        | ✅ 完成 | 崩潰安全     |
| 9   | Worker timeout（子程序 + 60s 預設 timeout）  | `memory-backfill-worker.ts` | ✅ 完成 | 防止永久阻塞 |
| 10  | 排程結果回流 memory pipeline                 | `scheduler.ts` + backfill   | ✅ 完成 | 補上閉環缺口 |
| 11  | 空跑優化（比對 checkpoint vs MAX timestamp） | `memory-backfill-worker.ts` | ✅ 完成 | 減少無謂 I/O |

### P3 — 長期治理

| #   | 改動                                      | 狀態    | 收益         |
| --- | ----------------------------------------- | ------- | ------------ |
| 12  | 語意去重（`normalizeSummary` 跨 session） | ⏳ 待做 | 避免重複儲存 |
| 13  | TTL 自動過期 + 分層 retention             | ⏳ 待做 | 控制 DB 膨脹 |
| 14  | 隱私標記（ephemeral flag）+ 範圍 forget   | ⏳ 待做 | 資料治理合規 |
| 15  | 提取遥測指標（命中率、信心度分佈）        | ✅ 完成 | 可觀測性     |
| 16  | 跨 DB 一致性檢查                          | ✅ 完成 | 偵測 drift   |

---

## 10. 相關檔案

| 檔案                                     | 用途                                      |
| ---------------------------------------- | ----------------------------------------- |
| `src/services/memory-backfill.ts`        | Backfill 候選提取、去重、衝突解決、寫入   |
| `src/services/memory-backfill-worker.ts` | 背景 worker（週期執行 backfill）          |
| `src/services/memory-health.ts`          | 健康報告收集                              |
| `src/core/memoria-sync.ts`               | Memoria 同步橋接                          |
| `src/core/memory.ts`                     | MemoryManager、FTS5 索引、searchSummaries |
| `src/prompt/builder.ts`                  | SAR context 組裝、評分、預算控制          |
| `src/core/sar-policy.ts`                 | SAR 常數、tag 規則、評分配置              |
| `src/core/summary-metadata.ts`           | Metadata 自動推斷                         |
| `src/core/message-pipeline.ts`           | Pipeline 編排                             |
| `src/core/message-pipeline-chat.ts`      | Prompt 準備、訊息持久化                   |
| `src/tools/memory-cli.ts`                | 記憶 CLI（search/stats/forget/clear）     |
| `src/tools/memory-backfill-cli.ts`       | Backfill CLI                              |
| `src/tools/memory-health-cli.ts`         | 健康報告 CLI                              |
