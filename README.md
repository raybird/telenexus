<p align="center">
  <img src="docs/logo.png" alt="TeleNexus Logo" width="200" />
</p>

<p align="center">
  <strong>Local AI Control Plane for Telegram, CLI, Memory, and Scheduling</strong>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-v2.20.0-1f6feb">
  <img alt="stack" src="https://img.shields.io/badge/stack-Telegram%20%2B%20Runner%20%2B%20SAR-0f766e">
  <img alt="memory" src="https://img.shields.io/badge/memory-Summary--Aware%20Retrieval-c2410c">
  <img alt="release" src="https://img.shields.io/badge/release-commit%20%E2%86%92%20tag%20%E2%86%92%20push-6b21a8">
</p>

# TeleNexus

> 您的私人本地 AI 助理閘道器（Telegram → Local CLI Agent）

用 Telegram 控制本機 Opencode CLI，整合長對話記憶、排程、觀測與 runner 架構，作為可長期運作的個人 AI 控制平面。

## 核心能力

- **本地 CLI 執行**：Telegram / Web Console 直接驅動本機 Opencode，保留完整工具權限
- **長對話記憶**：Summary-Aware Retrieval (SAR) — 核心規則與決策跨 session 保留，不只抓近期訊息
- **排程系統**：內建 cron scheduler，定時任務與一般聊天走同一套可觀測模型
- **即時串流**：工具活動 emoji feed（🔍📖💻✏️🌐）+ MarkdownV2 渲染，對話感更即時
- **Pinned 狀態訊息**：釘選訊息即時顯示模型、排程數、異常數，不需打 `/status`
- **可觀測性**：`workspace/context/` 持續寫出 runtime / scheduler / error / runner 快照

---

## 一鍵安裝（推薦）

不需要 clone 原始碼。映像由 CI 預建於 GHCR，安裝只下載部署檔並 `docker compose pull`：

```bash
mkdir telenexus && cd telenexus
curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash
```

安裝後編輯 `.env` 填入 `TELEGRAM_TOKEN` 與 `ALLOWED_USER_ID`，啟動並登入 opencode：

```bash
docker compose pull && docker compose up -d
docker compose exec telenexus opencode auth login
```

升級到新版本（保留 `.env`、`ai-config.yaml`、`data/`、`workspace/`）：

```bash
curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash -s -- --upgrade
```

詳細說明（指定版本、回滾、離線重跑）見 [docs/installation.md](docs/installation.md)。

---

## 從原始碼安裝（開發，5 分鐘上手）

### 1) 準備環境變數

複製 `.env.example`（開發）或 `.env.production.example`（保守上線），最低必要：

```env
TELEGRAM_TOKEN=your_bot_token
ALLOWED_USER_ID=your_telegram_user_id
DB_DIR=./data
```

### 2) 啟動雙服務

```bash
docker compose up -d --build
```

### 3) 確認狀態

```bash
docker compose ps
docker compose logs -f telenexus
```

### 4) 打開 Web Console（預設 port 3030）

`http://127.0.0.1:3030`

---

## 指令速查

### 基本指令

| 指令 | 說明 |
|------|------|
| `/start` | 顯示說明訊息與指令清單 |
| `/reset` | 清除 AI 短期記憶（Context Window） |
| `/new` | 下一則訊息強制使用新 CLI session，不接續上一段對話 |
| `/abort` | 中止當前正在執行的 AI 任務並清空佇列 |
| `/send_file 路徑 \| 說明` | 把專案目錄內的檔案回傳到 Telegram |

### 排程指令

| 指令 | 說明 |
|------|------|
| `/add_schedule 名稱\|Cron\|提示詞` | 新增排程，例如 `/add_schedule 早安\|0 9 * * *\|說早安` |
| `/list_schedules` | 列出目前所有排程 |
| `/remove_schedule <ID>` | 刪除指定排程，例如 `/remove_schedule 1` |

### 排程管理（Docker CLI）

```bash
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js list
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js reload
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js health
```

### 模型管理

| 指令 | 說明 |
|------|------|
| `/model` | 顯示目前生效的模型及來源 |
| `/models [provider]` | 列出可用模型，可篩選 provider |
| `/set_model <model-id>` | 切換模型，下一則訊息立即生效 |
| `/reset_model` | 清除 override，恢復 `ai-config.yaml` 基礎設定 |

模型 override 寫入 `data/ai-config.override.yaml`，`ai-config.yaml` 維持唯讀不變動。

---

## 文件導覽

| 文件 | 內容 |
|------|------|
| `docs/README.md` | 架構設計、維護規則、深入說明 |
| `docs/configuration-reference.md` | 所有環境變數與 runner 設定 |
| `docs/web-console-reference.md` | Web Console API 與頁面說明 |
| `docs/summary-aware-retrieval-plan.md` | 長對話記憶 SAR 設計 |
| `docs/scheduler-operation-runbook.md` | 排程維運 runbook |
| `docs/runtime-boundary-and-security.md` | 邊界與安全說明 |
| `docs/deployment-cutover-checklist.md` | 部署 checklist |

---

## 本機開發

```bash
npm run dev          # 啟動主服務（tsx watch）
npm run dev:runner   # 啟動 agent-runner（tsx watch）
npm run build        # TypeScript 編譯
npm run lint         # ESLint
npm run test         # 執行全部測試
```

---

## 免責聲明

本專案支援高權限 Agent 操作流程。請務必妥善保護：

- `TELEGRAM_TOKEN`
- `RUNNER_SHARED_SECRET`
- `ALLOWED_USER_ID`
