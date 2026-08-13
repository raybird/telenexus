# Changelog

> 更早的版本歷史見 [GitHub Releases](https://github.com/raybird/telenexus/releases) 與 git log。

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
