# 步驟 4：在資料副本上端到端量測

- **日期**：2026-10-21
- **對應**：SCN-005 的召回部分、SCN-007、SCN-010、SCN-011、SCN-012、SCN-013
- **映像**：
  - telenexus 以本分支建出：`docker build -t telenexus:issue-0015 .`，production stage。
  - Memoria 是 `ghcr.io/raybird/telenexus-memoria:v2.30.1`（Memoria 1.28.1）。
  - 第二輪量測的映像建在 `cf5cbff`（含 SCN-013 的修正）的工作區上，以 `grep` 確認 `dist/core/memoria-sync.js` 已帶有修正。
- **環境**：與步驟 1 相同的拋棄式 Compose 專案（`tn15probe`），以及另一個只放合成資料的專案（`tn15probe2`）。都在 repo 之外，沒有碰 `~/Documents/RunTelenexus` 的部署和它的 volume，也沒有啟動 telenexus 服務本身。
- **命令**：照 `docs/installation.md`「舊版記憶遷移」的命令執行。`docker compose` 換成指向拋棄式專案的 `docker compose --project-directory <probe> -f <probe>/docker-compose.yml`，`<專案>` 換成 `tn15probe`。
- **去識別化**：輸出裡的 user ID 換成 `<id>`，smoke test 的 session ID 換成 `<smoke-session>`。問句原文與資料副本不放進 repo。

## SCN-011、SCN-007、SCN-006：照文件跑完整流程（第二輪）

| 文件步驟 | 結果 |
|---|---|
| 1. 預覽（Memoria 執行中） | exit 0。舊分區 2,301 筆，可遷移 2,300 筆（`user:<id>` 1,021、`scheduler:<id>` 1,279），人工審閱 1 筆（`<smoke-session>`：缺少 user_id）。與調查的分類相同。 |
| 在 Memoria 執行中時加 `--write`（SCN-007） | exit 1，`Memoria 服務仍在執行（http://memoria:3917），請先停止 Memoria 再寫入`，volume 裡沒有新檔案。 |
| 2. `docker compose stop` | 成功。 |
| 3. `--write` | exit 0。`服務檢查：http://memoria:3917 連不上，視為 Memoria 已停止`、`已遷移：2300 筆`，並列出 `legacy-scope-migration/<時間戳>/` 下的備份與遷移紀錄。 |
| 再跑一次 `--write`（SCN-006） | exit 0，`可遷移：0 筆`、`已遷移：0 筆`，沒有備份與紀錄；之後列出 `legacy-scope-migration/` 只有一個目錄。 |
| 4. `memoria index build` | `sessions considered: 2300`、`sessions indexed: 2300`、`nodes upserted: 6900`、`source links upserted: 4600`。 |
| `docker compose start` | Memoria 健康檢查通過。 |

第一輪用修正前的映像跑同一份流程，數字完全相同。

遷移紀錄（第一輪讀出）：`totals` 是 `candidates 2301`、`migrate 2300`、`review 1`；`migrated` 有 2,300 筆，每筆的欄位是 `sessionId`、`fromScope`、`toScope`、`basis`。

## SCN-010：依文件以備份回復

照文件的回復命令，停止服務後以備份覆蓋 `sessions.db`，刪除 `-wal`／`-shm`／`-journal`，再啟動。Memoria 健康檢查通過，`/v1/stats` 回 `sessions=2529`、`events=5058`、`memoryIndex.missing=0`。指紋的算法同步驟 1，都在 Memoria 停止時計算。

| 資料表 | 寫入前 | 遷移並重建索引後 | 回復後與寫入前相同 |
|---|---|---|---|
| `sessions` | 2,529 列 `313f1826d951b4eb` | 2,529 列 `149ec975a4a68f5e` | 是 |
| `events` | 5,058 列 `370ce14caa13221a` | 5,058 列 `370ce14caa13221a`（不變） | 是 |
| `memory_nodes` | 2,506 列 `a77a897a913f8676` | 3,752 列 | 是 |
| `memory_node_sources` | 4,978 列 `07bc4dc812e1bfc4` | 5,058 列 | 是 |
| `memory_utility` | 11 列 `b567655f7a211d0d` | 11 列（不變） | 是 |
| `recall_fts_content` | 2,529 列 `e5869dc0b5b435ae` | 2,529 列 `84b93176c37537f7` | 是 |
| scope 分布 | `project:TeleNexus` 2,301、`scheduler:` 208、`user:` 20 | `project:TeleNexus` 1、`scheduler:` 1,487、`user:` 1,041 | 是 |
| summary 是 metadata 的 session | 2,300 | 0 | 是 |
| `PRAGMA quick_check` | ok | ok | 是 |

## SCN-012：凍結問句在遷移前後的召回

問句與 payload 同調查（`scope=user:<id>`、`top_k=5`、`mode=hybrid`、`project=TeleNexus`；confidence 低於 0.2 視為不注入）。遷移前在寫入之前量，遷移後在重建索引並啟動之後量。

| | 遷移前 | 遷移後 |
|---|---|---|
| 舊決策 10 題命中 | 0/10 | **7/10** |
| 遷移前就存在的資料 2 題命中 | 2/2 | 2/2 |
| 對照 4 題被注入 | 1/4 | 2/4 |
| 注入的結果總數 | 12 | 68 |
| 注入的排程產出 | 0 | 0 |
| 注入的其他 scope 資料 | 0 | 0 |

每題的 confidence：

| 題目 | 遷移前 | 遷移後 | 遷移後命中 |
|---|---|---|---|
| 舊決策 1 | 0.091 | 0.364 | 否 |
| 舊決策 2 | 0.118 | 0.294 | 是 |
| 舊決策 3 | 0.182 | 0.455 | 是 |
| 舊決策 4 | 0.077 | 0.385 | 是 |
| 舊決策 5 | 0 | 0.375 | 否 |
| 舊決策 6 | 0.077 | 0.308 | 是 |
| 舊決策 7 | 0.067 | 0.533 | 是 |
| 舊決策 8 | 0.182 | 0.545 | 是 |
| 舊決策 9 | 0.077 | 0.538 | 否 |
| 舊決策 10 | 0.083 | 0.750 | 是 |
| 現有資料 1 | 0.308 | 0.308 | 是 |
| 現有資料 2 | 0.500 | 0.500 | 是 |
| 對照：晚餐 | 0.143 | 0.286（注入） | — |
| 對照：17×23 | 0.200（注入） | 0.400（注入） | — |
| 對照：電影 | 0 | 0.143 | — |
| 對照：義大利麵 | 0 | 0.167 | — |

- 舊決策命中數高於遷移前；遷移前就存在的資料仍然命中；排程與其他 scope 的注入為 0。SCN-012 的判準都成立。
- 無關問句的注入率由 1/4 升到 2/4，「17×23」的 0.4 高於相關題最低的 0.294。這與調查時的版本 C 相同，依核准範圍不在本 issue 處理，見 README TBD-1。
- 未命中的 3 題與調查時相同：2 題注入的是同主題的其他對話，1 題真正漏掉。
- 這是 16 題的小樣本，只用來比對遷移前後，不能當成召回品質的基準。

## SCN-005：兩位使用者的隔離（合成資料）

在 `tn15probe2` 的空 Memoria 上，以 2026-08-14 以前的同步寫法寫入 6 筆合成對話：不帶 scope、summary 是 metadata。使用者 u1、u2 各有兩筆真人對話與一筆排程產出，排程內容刻意提到同一隻寵物。Memoria 1.28.1 把它們都放進 `project:TeleNexus`，與舊版行為相同。

照文件預覽：可遷移 6 筆（`user:u1` 2、`user:u2` 2、`scheduler:u1` 1、`scheduler:u2` 1），人工審閱 0 筆。接著停止、寫入、重建索引（`sessions indexed: 6`）、啟動，再以聊天相同的 payload 召回：

| scope | 問句 | 遷移前注入 | 遷移後注入 |
|---|---|---|---|
| `user:u1` | 我的貓叫什麼名字 | 無 | u1 的貓 |
| `user:u1` | 部署資料夾放在哪裡 | 無 | u1 的資料夾 |
| `user:u2` | 我的狗叫什麼名字 | 無 | u2 的狗、u2 的資料夾 |
| `user:u2` | 伺服器資料夾放在哪裡 | 無 | u2 的資料夾 |
| `user:u2` | 我的貓叫什麼名字 | 無 | 無（不會拿到 u1 的貓） |
| `user:u1` | 散步提醒 | 無 | 無（不會拿到排程產出） |

遷移後預期的 4 題都命中，注入其他使用者的資料 0 筆，注入排程產出 0 筆。

## SCN-013：截斷切開 emoji 的發現與修正

第一輪結束後，我拿工具和調查腳本在同一份副本上的結果比對，有 3 筆 summary 不同。原因是 `truncateForSummary` 在第 239 個 UTF-16 單位截斷時，切到 emoji 的 surrogate pair 中間。調查腳本（`node:sqlite`）把落單的前半存成 U+FFFD；工具（better-sqlite3，Memoria 用的也是它）寫出 `ED A0 BD`，這不是合法的 UTF-8。目前同步寫入的 228 筆裡還沒有這種資料，只是截斷點還沒落在 emoji 上。

使用者選擇修共用的截斷函式（README 規格修訂）。修正與測試在 `cf5cbff`：
- **紅燈**：`tests/memoria-sync-payload.test.ts` 新增的測試在修正前失敗（`不能有落單的前半`），其他 13 個通過。
- **綠燈**：修正後同步與遷移的 3 個測試檔共 38/38。
- **重驗**：以修正後的程式在副本上重跑寫入，資料庫裡沒有 `ED A0`～`ED BF` 開頭的位元組；那 3 筆改成在 emoji 前截斷。

## 交付檢查（`cf5cbff`）

- `npm run build` exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0：`# tests 540`、`# pass 540`、`# fail 0`，比步驟 3 多 1 個（SCN-013）。
- `npm run lint` exit 0。
