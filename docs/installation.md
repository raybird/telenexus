# 安裝與升級指南

> 最後更新：2026-07-08

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

## 指定版本與回滾

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
