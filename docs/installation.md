# 安裝與升級指南

> 最後更新：2026-10-04

TeleNexus 提供兩種安裝方式：**一鍵安裝**（下載預建映像，推薦）與**從原始碼安裝**（開發用，見 README）。本文說明一鍵安裝的機制、升級與回滾。

## 機制總覽

- 每次 release（`v*` tag）由 GitHub Actions 預建兩個映像推到 GHCR：
  - `ghcr.io/raybird/telenexus`（主服務 + agent-runner 共用）
  - `ghcr.io/raybird/telenexus-memoria`（記憶服務）
- Release 同時附上 `telenexus-docker-<版本>.tar.gz` **部署 bundle**，內含：
  `docker-compose.yml`（映像已釘版）、`.env.example`、`ai-config.example.yaml`、`AGENTS.md`、`skills/`、`scripts/install.sh`
- `install.sh` 把 bundle 解到當前目錄並初始化使用者狀態；啟動只需 `docker compose pull`，**本機不需要 Node.js、不需要建置**

### 檔案所有權劃分

| 類別 | 檔案 | 升級時 |
|---|---|---|
| 部署檔（release 擁有） | `docker-compose.yml`、`skills/`、`AGENTS.md`、`*.example*` | 隨 bundle 覆蓋更新 |
| 使用者狀態（永不觸碰） | `.env`、`ai-config.yaml`、`data/`、`workspace/`、named volumes | 完整保留 |

## 安裝

```bash
mkdir telenexus && cd telenexus
curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash
```

腳本流程：檢查 Docker / Compose v2 → 解析最新版本 → 下載並解壓 bundle → 建立 `.env`（自動寫入目前帳號的 `PUID`/`PGID`）與 `ai-config.yaml` → 詢問是否立即 `docker compose pull && up -d`。

安裝後：

```bash
# 1. 編輯 .env,至少填入
#    TELEGRAM_TOKEN=<bot token>
#    ALLOWED_USER_ID=<你的 Telegram user id>
# 2. 啟動
docker compose pull && docker compose up -d
# 3. 首次登入 opencode (認證存在 named volume,重建不消失)
docker compose exec telenexus opencode auth login
# 4. 健康檢查
curl -sf http://localhost:3030/api/health
```

## 升級

```bash
cd <部署目錄>
curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash -s -- --upgrade
```

`--upgrade` 會重新下載最新 bundle 覆蓋部署檔（`.env`、`ai-config.yaml`、`data/`、`workspace/` 完整保留），然後 `docker compose pull` 拉新映像並 `--force-recreate` 換上。

### mcp-memory-libsql 與記憶回填退役（issue 0022）

升級不需要手動步驟：

- `workspace/.opencode/opencode.json` 裡舊的 `mcp-memory-libsql` 條目會被 TeleNexus 停用，不必修改；
- `data/memory.db` 與回填的 checkpoint／報告檔原地保留，不再讀寫；
- `.env` 裡的 `MEMORY_BACKFILL_*` 可以順手刪掉，`MEMORY_BACKFILL_ENABLED` 留著開啟時，啟動 log 會提醒一行。

升級前怎麼確認這個 MCP 有沒有在用，以及想繼續用時怎麼設定，見 `docs/configuration-reference.md` 的「已退役：mcp-memory-libsql 與記憶回填」。

### 舊版記憶遷移（2026-08-14 以前的部署）

2026-08-14 以前同步到 Memoria 的對話都在 `project:TeleNexus` 分區，summary 也只是 `user=… platform=…` 這類 metadata。現在的聊天只查 `user:<id>`，所以這些舊記憶找不到。遷移工具依每筆對話事件記錄的 `platform` 與 `user_id`，把舊資料分到 `user:<id>`（Telegram、Web 對話與 passthrough 指令）或 `scheduler:<id>`（排程產出），並從事件重建 summary。歸屬不明的會留在原處，列在人工審閱清單。

以下命令都在部署目錄執行。`<專案>` 是 Compose 專案名稱，預設是部署目錄的名稱，可以用 `docker volume ls | grep memoria_data` 確認。

```bash
# 1. 預覽：只讀，不改任何東西，Memoria 不用停
docker compose run --rm --no-deps --user 1000:1000 -v <專案>_memoria_data:/memoria \
  telenexus node dist/tools/memoria-legacy-scope-cli.js --db /memoria/.memory/sessions.db

# 2. 停止整組服務；遷移期間的對話不會同步進 Memoria
docker compose stop

# 3. 寫入：先在 volume 內備份整個資料庫，再改寫並留下遷移紀錄
docker compose run --rm --no-deps --user 1000:1000 -v <專案>_memoria_data:/memoria \
  telenexus node dist/tools/memoria-legacy-scope-cli.js --db /memoria/.memory/sessions.db --write

# 4. 重建索引，再啟動
docker compose run --rm --no-deps memoria memoria index build
docker compose start
```

- **volume 一定要寫完整名稱**：寫成 `memoria_data:/memoria` 時，Compose 會另外建一個空的 volume，工具會因為找不到資料庫而結束。
- **`--user 1000:1000`**：Memoria 映像的檔案屬於 UID 1000；`.env` 的 `PUID` 不是 1000 時，沒加這個參數會寫不進去。
- **用 `docker compose run`**：工具寫入前會連 `MEMORIA_ENDPOINT` 確認 Memoria 已停止，連得上就拒絕寫入。單純 `docker run` 不在 Compose 的網路裡，做不了這個檢查。輸出「無法確認 Memoria 已停止」時，先用 `docker compose ps` 確認 memoria 不在執行，再重跑；工具不提供略過檢查的選項。
- **重跑安全**：已遷移的不會再處理；沒有可遷移的資料時不會產生新的備份。
- **輸出位置**：備份與遷移紀錄在 volume 的 `.memory/legacy-scope-migration/<時間戳>/`，檔名分別是 `sessions.backup.db` 與 `record.json`。工具輸出的路徑以 `/memoria/` 開頭（遷移時的掛載點）；在 Memoria 容器裡同一個位置是 `/data/`。遷移紀錄含 session ID，請留在部署機器上。
- **先重建索引再做其他維護**：寫入後到第 4 步 `memoria index build` 之前，遷移過的 session 暫時沒有索引來源，這段期間不要執行任何 `memoria prune`：`--stale-days` 與 `--all`（預設 180 天）都會把它們當成可刪除的對象。

要回復到遷移前，停止服務後把備份覆蓋回去。備份是寫入前那一刻的整個資料庫，遷移之後新增的記憶會一併消失：

```bash
docker compose stop
docker compose run --rm --no-deps memoria sh -c \
  'cp /data/.memory/legacy-scope-migration/<時間戳>/sessions.backup.db /data/.memory/sessions.db && rm -f /data/.memory/sessions.db-wal /data/.memory/sessions.db-shm /data/.memory/sessions.db-journal'
docker compose start
```

遷移後，無關問句的召回 confidence 會跟著語料變多而上升，可能讓不相關的舊對話被注入；門檻的重新校準另行處理（見 GitHub [#19](https://github.com/raybird/telenexus/issues/19)）。

## 指定版本與回滾

### 網頁工具切換邊界（2026-10-04）

新映像使用固定 Chrome DevTools MCP／Chrome，公開文件先走 HTTP，JS 正文才按需渲染。agent-browser 套件、下載步驟、`AGENT_BROWSER_ARGS` 及全域 close 已退役；不承諾沿用登入、自動點擊、完整表單或跨回合 browser profile。聊天文字 session、認證與 memory／自訂 MCP 仍保留。

部署切換需維護者另行核准，本次開發不自動操作正式環境：

技能同步啟動時會比對舊內建 `agent-browser` 的完整 10 檔 SHA-256 與目錄集合；完全相同且無 symlink 者，從各 `OPENCODE_SKILLS_DIRS` 移至其父目錄的 `retired-skills/agent-browser-04f5f2d`，保留完整備份但退出預設技能探索。重跑不新增備份，也不從升級解壓殘留的唯讀 source 重新同步舊技能。

有客製內容、額外檔案／目錄、symlink 或既有備份碰撞時，原地保留並警告「無法自動遷移／備份已存在，舊後端不可用」；客製舊技能仍可能被載入，維護者應自行評估改寫，不把保留等同新後端可執行。其他位置的副本與自訂 OpenCode skill paths 不會被自動掃描或刪除。新 `web-reading` 遵循既有「只補缺少目錄」策略，不覆寫同名客製版本。

1. 排空聊天與排程工作，記錄原映像／Compose 配置及程序基線。
2. 備份部署設定、workspace 技能與 OpenCode volumes；保留認證、文字 session、排程及 Memoria 資料。
3. 套用新映像與兩份一致的 Compose 配置，**重建** `telenexus`／`agent-runner` 才能套用 `init: true`；一般 restart 不會新增 init。Memoria 不需因瀏覽器替換而重建。
4. 確認兩服務 inspect Init=true，普通 HTTP／JS 閱讀可用，工作結束後 15 秒 live／Z／臨時 profile=0；healthy 不能替代這些判準。

2026-10-05：若維護者另行核准容器終止驗證，須在 runner 正持有真 MCP／Chrome 時查核 SIGTERM 與 deadline 強制終止，從宿主確認原 PID/starttime 消失且容器 cgroup 無殘留；不要以容器 stopped 當作應用程式完成收尾。強制終止可能留下停止容器可寫層的 `/tmp/tnb-*`，重啟原容器不保證刪除它；現有 runner `/tmp` 不在持久化掛載內，但自訂掛載者須另行評估。這不是清空 data／workspace／OpenCode volumes 的授權。

回退時復原舊映像與所需工具設定，但保留兩執行服務的 init；需要還原技能時先比對備份與目標，避免覆寫客製內容。一般指定舊 bundle 的操作可能帶回沒有 init 的 Compose，應由維護者查核後再套用。不要刪除使用者資料以「清乾淨」。

```bash
# 安裝/升級到指定版本
bash scripts/install.sh --upgrade --version v2.21.0

# 回滾:指回舊版本即可(部署檔與映像一起退回;data/ 內的資料不會自動降級)
bash scripts/install.sh --upgrade --version v2.20.0
```

`--dry-run` 可先預覽動作：

```bash
bash scripts/install.sh --upgrade --version v2.21.0 --dry-run
```

## UID/GID 對齊（runtime）

預建映像在容器啟動時由 entrypoint 讀取 `.env` 的 `PUID`/`PGID`（`install.sh` 首次安裝自動寫入 `id -u`/`id -g`），remap 容器內的 `node` 使用者後以 `gosu` 降權執行。bind mount（`data/`、`workspace/`）寫出的檔案在 host 上即為你的帳號所有，任何 host 帳號都不需要手動 `chown`。

## 疑難排解

- **`docker compose pull` 出現 denied**：GHCR package 需為 public；或 `docker login ghcr.io` 後再試
- **容器啟動即退出，log 出現權限錯誤**：確認 `.env` 的 `PUID`/`PGID` 與部署目錄擁有者一致；歷史部署若曾以 root 寫入 `data/`、`workspace/`，entrypoint 會自動修正頂層目錄，深層殘留可 `sudo chown -R $(id -u):$(id -g) data workspace`
- **升級後想確認版本**：Web Console `#/status` 的 `APP_GIT_SHA` / `APP_BUILD_TIME`，或 `docker compose images`
