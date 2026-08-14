# Changelog

> 更早的版本歷史見 [GitHub Releases](https://github.com/raybird/telenexus/releases) 與 git log。

## 2.23.0 — 2026-08-14

### Memoria 長期記憶一直召不回任何東西

正式環境從 2026-06-01 起同步了 905 個 session、1810 筆對話事件，每次 `remember` 都回 `ok:true`，而**任何查詢的召回結果都是 0 筆**。三個各自獨立、都足以致命的原因疊在一起：

- **`summary` 送的是 metadata**。Memoria 的關鍵字召回語料只有 `sessions.summary` 加上 `DecisionMade` / `SkillLearned` 事件（FTS trigger 的 DDL 寫死 `WHEN new.event_type IN (...)`），而我們只產 `UserMessage` / `ModelMessage` —— 所以 `summary` 是唯一搜得到的欄位，裡面卻裝著 `user=… platform=… source=…`。`recall_fts` 的 905 列 body 全是這串字。改放使用者訊息與回覆（各截 240 字），診斷欄位移到事件的 `metadata`。
- **payload 沒帶 `scope`**，被預設成 `project:TeleNexus`，但召回端傳的是 `user:<id>`，而 Memoria 的 scope 是**等值比對** —— 就算語料正常也必定 0 筆。
- **整句中文送去查詢**。Memoria 的查詢 tokenizer 把 CJK 連續字串視為單一 token，`recall_fts` 雖然是 trigram 索引、有能力配連續中文子字串，但整句餵進去會讓匹配退化成「整串必須連續出現」。同一份語料實測：「幫我看一下排程設定」0 筆、「排程 設定」2 筆。查詢送出前改切成重疊 2-gram（先用停用詞斷句，避免「一下」+「排程」黏成「下排」這種跨語意的假相鄰）。

| 情境 | 修復前 | 修復後 |
| --- | --- | --- |
| 對照查詢（拋棄式 Memoria 1.27.0） | 0/7 命中 | 4/7 |
| 完整鏈路（真實中文訊息 → 注入） | 1/3 | 3/3 |
| route / basis | `hybrid_fallback` / `no_hits` | `hybrid_tree` / `lexical_coverage` |

三個都是 fail-open 的靜默失效：寫入回 `ok:true`、召回回 `ok:true` 加空陣列，沒有任何一層會出聲。已寫入的舊記憶原始對話完整保留在 `events` 裡，可另行回填。

已知取捨：2-gram 必然帶噪音（「排程設定」會產生「程設」），而 Memoria 的 `relevance` 是「命中 token 數 / 查詢 token 數」。分母對同一次查詢的所有候選是常數，**排序不受影響**，但回報的 `confidence` 會系統性偏低 —— 遙測與 UFL 校準的數字都要照這個折扣讀。另外 2 字詞低於 `FTS_MIN_TERM_LEN=3`，實際走的是 tree route 而非 bm25。

### 排程產出寫進獨立的 `scheduler` 分區

修好 `summary` 之後浮現的第二個問題：正式資料 905 筆記憶裡 **752 筆是排程任務，且只有 5 種**，光 Crypto Monitor 就 548 筆（六成）。讓這些近乎逐字重複的自動報告進入聊天召回語料，任何與市場或技術相關的查詢都會被它們塞滿，真人對話（15 次）被 5:1 稀釋 —— 而且每天新增約 7 筆，會持續惡化。

利用 scope 是等值比對這點，排程輪次改寫入 `scheduler:<id>`，聊天召回只查 `user:<id>`。**內容完整保留、換個 scope 就查得到**，但不佔用真人對話的召回名額。端對端實測（8 份排程報告 + 2 次真人對話）：「市場 行情 分析」在聊天分區回的是「市場回覆要附資料來源」那條規則、排程外洩 0 筆，同一查詢在排程分區回 3 筆報告。

`console` 與 `telegram` 都算真人對話，一律走 `user:<id>`。

### Memoria 召回遙測

`/v1/recall` 回應 `meta` 的 `route_mode` / `fallback_used` / `confidence` / `confidence_basis` 原本整包丟棄，對召回品質形同全盲 —— 上面那個 0 筆問題正是加了這個之後才浮出來的。

- `memoria-status.md` 新增 `## Recall Telemetry` 區塊（原內容收進 `## Sync Bridge`），滾動 50 筆：路由分布、信心基準分布、平均延遲與命中數
- 每次召回 emit `memoria_recall` 事件到 `events.jsonl`
- `route_mode` 為 `vector_unavailable` / `vector_timeout` 時（語意索引服務不了、實際端出字面結果）發 `recordRuntimeIssue`，不讓它靜默降級
- 平均 confidence 只採計 `lexical_coverage` 樣本並印出 `n`：`confidence` 為 `null` 代表該路由無法判斷，當成 0 計算會製造假數字

Memoria 釘選同時升到 1.27.0（已實際建映像驗證 `memoria --version`）。

## 2.22.3 — 2026-08-13

### SAR summary 查詢改用部分索引

SAR 每輪對話都會呼叫 `getRecentSummaries`，但生產資料裡只有 2.3% 的訊息帶 summary。既有的 `(user_id, impact_level, timestamp)` 索引無法表達「有 summary」這個條件，SQLite 得把該使用者所有訊息取回逐列判斷 `TRIM(summary) != ''`，再做 TEMP B-TREE 排序。

新增 `idx_messages_summary_lookup`（部分索引，`WHERE summary IS NOT NULL AND TRIM(summary) != ''`）後，以 115K 訊息實測：

| 路徑 | 修復前 | 修復後 |
| --- | --- | --- |
| `getRecentSummaries` | 74.05ms | 6.93ms |
| `searchSummaries` 的 LIKE 後備 | 74.31ms | 5.23ms |
| `buildMemoryContext`（每輪對話） | 46.63ms | 6.99ms |

索引建置一次 41ms，DB 大小不變。附斷言 query plan 的迴歸測試 — 部分索引的 `WHERE` 必須與查詢完全一致才會被採用，查詢條件一改就會靜默退回整表候選。

### runner-audit.log 補上輪替與保留期

先前是 append-only 且沒有任何清理機制，正式環境實測 6 個月累積 2,096 行 / 424KB 且只會單調成長。它位在 `workspace/context/` 底下 — 也就是 agent 會讀的目錄 — 無上限成長不只是磁碟問題。

- 改為日輪替（`runner-audit-YYYY-MM-DD.log`）+ 7 天保留，與 event-bus 的 `events.jsonl` 同策略
- 輪替邏輯抽成 `src/services/audit-log.ts`；`runner.ts` 在 module top-level 就 `server.listen()`，邏輯留在裡面就無法在不啟動 HTTP 服務的情況下測試
- 目錄只在路徑變動時 `mkdir`，不再每寫一行就發一次 syscall

> 這兩項都是成長曲線問題，不是當下的瓶頸：以目前 12.6 則/天的速度，資料量要 2 年才會到 5×。

## 2.22.2 — 2026-08-13

### Context snapshot 的整表掃描與事件放大

`writeContextSnapshots` 是同步的，成本隨資料量線性成長，而八種生命週期事件每一個都各觸發一次完整快照。以生產資料副本放大實測，單次成本 4.4ms → 12.7ms → 28.6ms → **61.5ms**（2.3K / 11.5K / 46K / 115K 則訊息）。

- **`messages` 補上 `(role, timestamp)` 索引**：memory-health 的 24h 統計以 `role` 過濾但不帶 `user_id`，既有兩個索引都是 `user_id` 開頭而幫不上忙，query plan 退化成 `SCAN messages` — 115K 列時單次 40.21ms，佔整份快照成本三分之二。補索引後同一句降到 2.18ms，DB 大小不變；升級後首次啟動會自動建索引（115K 列約 252ms）
- **一致性稽核不再搬運整張表的內容**：改先用 `LIKE` 篩掉不可能命中的列（`LIKE` 對 ASCII 不分大小寫，是 regex `/i` 命中的超集），命中的才跑原本的 regex。生產資料實測 100% 的列屬於前者。已用邊界內容（大小寫、空標記、未閉合、含空白、NULL、多重標記）× 三種 archive 情境驗證新舊結果完全等價
- **事件觸發的快照改為合併寫出**：leading edge + trailing，預設最小間隔 1s，可用 `CONTEXT_EVENT_MIN_INTERVAL_MS` 調整。一次排程任務會連續送出 `schedule_fire` → `runner_request_done` → `schedule_done`，先前各寫一輪快照。合併後不會少寫，最後一個事件永遠會被寫出
- **修正 `recordRuntimeIssue` 的 dedupe 失效**：命中時就地改寫 `timestamp` 卻讓該筆留在原位，破壞了「陣列依 timestamp 遞增」這個反向掃描提前 `break` 的前提；後方若有更舊的項目，下一次掃描會在那裡誤判超出視窗而 break，掃不到仍在視窗內的同類項，於是重複發出 `runtime_issue` — 而每個這種事件又再觸發一輪快照，形成「錯誤 → 阻塞 → 更多錯誤」的迴圈

整體：115K 訊息下單次快照 **61.5ms → 8.9ms**，成長曲線由 14× 壓到 4×。

### 驗證缺口

- **`npm test` 只跑到 38 個測試檔中的 4 個**：glob 未加引號，而 bash 預設 `globstar` 是關的，`tests/**/*.test.ts` 退化成只匹配一層子目錄 — 所有頂層測試檔從未被 `npm test` 執行。加引號後 194 個測試全數執行
- `memory.ts` 的 fingerprint 分隔符直接嵌入 NUL 位元組，使 git 將整個檔案判為二進位而顯示不出 diff；改為跳脫序列，已驗證寫入 DB 的值逐位元組相同

## 2.22.1 — 2026-08-13

### Memoria 記憶服務升級至 v1.25.0

- `docker/memoria.Dockerfile` 的 `@raybird.chen/memoria` 由浮動 range `^1.11` 改為釘死 `1.25.0`；浮動 range 會讓同一個 TeleNexus tag 在不同時間建出不同的 Memoria（v2.22.0 映像實測帶的是 1.20.0），映像不再可重現
- 1.20.0 → 1.25.0 對 TeleNexus client 無破壞性影響：`memoria-recall.ts` 只讀 `data[].id` / `data[].snippet` / `meta.recall_id`，未使用 1.25.0 改為可 `null` 的 `meta.confidence`；`mode:'hybrid'` 與 `/v1/recall`、`/v1/remember`、`/v1/recall/:id/outcome`、`/v1/health` 四條路由維持不變
- 升級後既有 `memoria_data` volume 會自動跑 migration 14/15（長期記憶標記表、重建 `recall_fts` 清除 re-sync 造成的重複索引列）
- 需一次性維運動作：Memoria 1.24.0 修好「git 促升記憶未進 tree index」，既有 DB 的缺口要在容器內跑一次 `memoria index build` 才會補上

## 2.22.0 — 2026-07-17

### Telegram 原生草稿串流

- Telegram 私聊改用 Bot API `sendMessageDraft`，同一輪 reasoning、工具狀態與 liveness 共用固定 draft ID，完成或失敗時再送出正式訊息
- 群組、頻道、缺少 Telegram metadata 或 draft API 失敗時，自動退回單一可編輯 placeholder；中途失敗只切換一次，不產生重複狀態訊息
- 支援 `message_thread_id` 傳遞、20 秒 draft 保活、4 秒 typing 更新，以及 3900 UTF-16 code units 的安全進度上限
- 最終訊息確認送達後才清除 fallback；若 final 傳送失敗，保留進度訊息供錯誤復原
- 補齊 private draft、supergroup fallback、長 reasoning、錯誤終止與 final delivery failure 的測試

## 2.21.1 — 2026-07-08

### Docker image 瘦身

- Runtime image 改用 `npm ci --omit=dev` 安裝 production dependencies，不再複製 builder 的 dev `node_modules`
- 移除 Debian `chromium`，改由 `agent-browser install` 提供 Chrome，並補齊必要 shared libraries
- 新增 Dockerfile hygiene test，防止 dev dependencies 或雙瀏覽器重新進入 runtime image

## 2.21.0 — 2026-07-08

### 一鍵安裝與 GHCR 發佈機制

- **一鍵安裝/升級**：新增 `scripts/install.sh`，支援 `--version` / `--force` / `--upgrade` / `--dry-run`；使用者狀態（`.env`、`ai-config.yaml`、`data/`、`workspace/`）只在缺少時初始化，升級永不覆蓋
  ```bash
  curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash
  ```
- **GHCR 預建映像**：新增 `.github/workflows/release.yml`，tag push 時自動建置並推送 `ghcr.io/raybird/telenexus` 與 `ghcr.io/raybird/telenexus-memoria`，同時打包 `telenexus-docker-<版本>.tar.gz` 部署 bundle 上傳 Release；安裝端只需 `docker compose pull`，本機零建置
- **Runtime UID 對齊**：`PUID`/`PGID` 從 build args 改為 runtime 環境變數，由新的 `scripts/docker-entrypoint.sh` 在啟動時 remap `node` 使用者並以 `gosu` 降權，任意 host 帳號免手動 chown；compose 於 `cap_drop: ALL` 上補回最小 `cap_add` 集合
- 新增 `docker-compose.release.yml`（release 部署範本）、`docs/installation.md`（安裝/升級/回滾指南）、`LICENSE`（ISC）與 `scripts/test-installer-upgrade.sh` 靜態測試（`npm run test:installer`）
