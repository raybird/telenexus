# 步驟 1：在拋棄式 Compose 部署上驗證操作路徑

- **日期**：2026-10-21
- **對應**：README「風險與首要驗證」；SCN-010、SCN-011 的前提
- **環境**：
  - Compose 檔：`docker-compose.release.yml`，映像改成 `ghcr.io/raybird/telenexus:v2.30.1` 與 `ghcr.io/raybird/telenexus-memoria:v2.30.1`（Memoria 1.28.1，Node 22.23.3）。
  - 專案名稱：`tn15probe`，目錄在 repo 之外。只啟動 Memoria，telenexus 只用 `run`，沒有 Telegram token。
  - 沒有碰 `~/Documents/RunTelenexus` 的部署和它的 volume。
- **資料**：與調查相同的資料副本，放進 `tn15probe_memoria_data` 的 `/data/.memory/sessions.db`。
- **改寫**：這一步還沒有正式工具，改寫用調查腳本 [migrate.mjs](investigation-scripts/migrate.mjs) 的 `full` 模式，備份用 `VACUUM INTO`。

以下命令中，`$DC` 代表 `docker compose --project-directory <probe> -f <probe>/docker-compose.yml`。

## 結果

| 前提 | 結果 | 對設計的影響 |
|---|---|---|
| `docker compose run -v memoria_data:/memoria telenexus …` 會掛到專案的 volume | **不成立**。Compose 另外建立了一個空的全域 volume `memoria_data`，沒有加專案前綴，容器裡看不到資料庫。改用完整名稱 `tn15probe_memoria_data` 才掛到正確的 volume。（這個空 volume 是本次新建的，確認是空的之後已刪除。） | 文件要寫完整名稱 `<專案名稱>_memoria_data`，並以 `docker volume ls` 確認。掛錯時資料庫不存在，工具會以前置檢查失敗結束。 |
| 容器使用者寫得進 Memoria 的檔案 | 預設 `PUID=1000` 時可以。**`PUID=1001` 時 `Permission denied`**：entrypoint 把 node 改成 PUID，但 Memoria 映像的檔案屬於 UID 1000。加上 `--user 1000:1000` 後，entrypoint 跳過 remap 直接執行，可以寫入。 | 文件一律寫 `--user 1000:1000`。這樣也避免以 root 執行而留下 root 擁有的檔案。 |
| Memoria 停止時，run 容器連不上服務 | `fetch($MEMORIA_ENDPOINT/v1/health)` 失敗（`EAI_AGAIN`）。 | 服務檢查「連得上就拒絕」可行。 |
| Memoria 執行中時，run 容器連得上服務 | `/v1/health` 回 200。 | 同上；前提是用 `docker compose run`，在專案網路裡才解析得到 `memoria`。單純 `docker run` 偵測不到，文件要寫明。 |
| 能用檔案鎖偵測執行中的 Memoria | **不成立**。資料庫是 `journal_mode=delete`。Memoria 執行中且處理過請求後，`locking_mode=EXCLUSIVE` 加上 `BEGIN EXCLUSIVE` 仍然拿得到鎖，因為閒置的連線不持有鎖。 | 只能靠服務檢查與操作文件。改寫用 `BEGIN IMMEDIATE`，至少不會和進行中的寫入交錯。 |
| Memoria 容器在唯讀 rootfs 下能跑 `memoria index build` | 可以。`$DC run --rm --no-deps memoria memoria index build` 輸出 `sessions considered: 2300`、`sessions indexed: 2300`、`nodes upserted: 6900`、`source links upserted: 4600`。 | 文件照這個命令寫。 |
| 以備份覆蓋後 Memoria 能正常啟動 | 可以。停 Memoria，把備份複製回 `sessions.db`，刪除 `-wal`／`-shm`，再啟動：健康檢查通過，`/v1/stats` 回 `sessions=2529`、`events=5058`、`memoryIndex.missing=0`。 | 回復步驟照這個寫。 |

## 遷移與回復前後的資料指紋

每張表依主鍵排序後，對整列內容計算 SHA-256，取前 16 碼。指紋都在 Memoria 停止時計算。

| 資料表 | 遷移前 | 遷移並重建索引後 | 回復後與遷移前相同 |
|---|---|---|---|
| `sessions` | 2,529 列 `313f1826d951b4eb` | 2,529 列 `576d24d4574b1eb0` | 是 |
| `events` | 5,058 列 `370ce14caa13221a` | 5,058 列 `370ce14caa13221a`（不變） | 是 |
| `memory_nodes` | 2,506 列 `a77a897a913f8676` | 3,752 列 | 是 |
| `memory_node_sources` | 4,978 列 `07bc4dc812e1bfc4` | 5,058 列 | 是 |
| `memory_utility` | 11 列 `b567655f7a211d0d` | 11 列（不變） | 是 |
| `recall_fts_content` | 2,529 列 `e5869dc0b5b435ae` | 2,529 列 `343f677272e23c31` | 是 |
| scope 分布 | `project:TeleNexus` 2,301、`scheduler:` 208、`user:` 20 | `project:TeleNexus` 1、`scheduler:` 1,487、`user:` 1,041 | 是 |
| summary 是 metadata 的 session | 2,300 | 0 | 是 |
| `PRAGMA quick_check` | ok | ok | 是 |

遷移後 `memory_node_sources` 是 5,058 列，等於每個 session 的 2 個來源；遷移前少的 80 列就是調查時發現沒有 level-2 node 的那 80 筆，重建後已補齊。

## 召回抽查

Memoria 重新啟動後，從 run 容器經專案網路，以調查時凍結的問句與相同的 payload 召回：舊決策 7/10、遷移前就存在的資料 2/2、對照題被注入 2/4，注入的排程內容 0、其他 scope 0。結果和調查時的版本 C 相同。完整量測在步驟 4 以正式工具重做。

## 對計畫的修訂

- 文件的命令一律用 `docker compose run --rm --no-deps --user 1000:1000 -v <專案名稱>_memoria_data:/memoria telenexus node dist/tools/memoria-legacy-scope-cli.js --db /memoria/.memory/sessions.db …`。run 容器沒有 `MEMORIA_HOME`，所以 `--db` 要明寫。
- 服務檢查維持只用 HTTP；不另做檔案鎖檢查。
- 以上都在原有 Scenario 的範圍內，不需要修訂驗收劇本。
