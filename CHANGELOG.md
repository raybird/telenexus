# Changelog

> 更早的版本歷史見 [GitHub Releases](https://github.com/raybird/telenexus/releases) 與 git log。

## 2.21.0 — 2026-07-08

### 一鍵安裝與 GHCR 發佈機制

- **一鍵安裝/升級**：新增 `scripts/install.sh`，支援 `--version` / `--force` / `--upgrade` / `--dry-run`；使用者狀態（`.env`、`ai-config.yaml`、`data/`、`workspace/`）只在缺少時初始化，升級永不覆蓋
  ```bash
  curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash
  ```
- **GHCR 預建映像**：新增 `.github/workflows/release.yml`，tag push 時自動建置並推送 `ghcr.io/raybird/telenexus` 與 `ghcr.io/raybird/telenexus-memoria`，同時打包 `telenexus-docker-<版本>.tar.gz` 部署 bundle 上傳 Release；安裝端只需 `docker compose pull`，本機零建置
- **Runtime UID 對齊**：`PUID`/`PGID` 從 build args 改為 runtime 環境變數，由新的 `scripts/docker-entrypoint.sh` 在啟動時 remap `node` 使用者並以 `gosu` 降權，任意 host 帳號免手動 chown；compose 於 `cap_drop: ALL` 上補回最小 `cap_add` 集合
- 新增 `docker-compose.release.yml`（release 部署範本）、`docs/installation.md`（安裝/升級/回滾指南）、`LICENSE`（ISC）與 `scripts/test-installer-upgrade.sh` 靜態測試（`npm run test:installer`）
