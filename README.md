<p align="center">
  <img src="docs/logo.png" alt="TeleNexus Logo" width="200" />
</p>

<p align="center">
  <strong>Local AI Control Plane for Telegram, CLI, Memory, and Scheduling</strong>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-v2.27.3-1f6feb">
  <img alt="stack" src="https://img.shields.io/badge/stack-Telegram%20%2B%20Runner%20%2B%20SAR-0f766e">
  <img alt="memory" src="https://img.shields.io/badge/memory-Summary--Aware%20Retrieval-c2410c">
  <img alt="release" src="https://img.shields.io/badge/release-commit%20%E2%86%92%20tag%20%E2%86%92%20push-6b21a8">
</p>

# TeleNexus

> 您的私人本地 AI 助理閘道器（Telegram → Local CLI Agent）

用 Telegram 控制本機 Opencode CLI，整合長對話記憶、排程、觀測與 runner 架構，作為可長期運作的個人 AI 控制平面。以 Docker Compose 部署，包含三個服務：`telenexus`（主服務）、`agent-runner`（執行 Opencode）與 `memoria`（長期記憶）。

## 核心能力

- **本地 CLI 執行**：Telegram / Web Console 直接驅動本機 Opencode，保留完整工具權限
- **長對話記憶**：Summary-Aware Retrieval (SAR) — 核心規則與決策跨 session 保留，不只抓近期訊息
- **長期記憶服務**：內建 Memoria 服務，每輪對話自動同步，之後的對話可召回相關記憶
- **排程系統**：內建 cron scheduler，定時任務與一般聊天走同一套可觀測模型
- **Runner 隔離執行**：AI 任務交給獨立的 `agent-runner` 容器，連續失敗時熔斷並自動退回本地執行
- **即時串流**：工具活動 emoji feed（🔍📖💻✏️🌐）+ MarkdownV2 渲染，對話感更即時
- **Pinned 狀態訊息**：釘選訊息即時顯示模型、排程數、異常數，不需打 `/status`
- **可觀測性**：`workspace/context/` 持續寫出 runtime / scheduler / error / runner 快照，並有事件流 `events.jsonl`
- **主動告警**：定期確認目前的模型仍可呼叫，上游回任何錯誤（模型下架、opencode 版本過舊、限流等）都會推 Telegram 通知，上游有回狀態碼時一併附上；同類錯誤短時間內重複發生也會推播
- **上游限流快速失敗**：上游回 429 時約 1 秒內中止並如實回報，不會讓任務空等到逾時
- **上游錯誤如實回報**：上游拒絕請求時，回覆會指出 HTTP 狀態碼與原因，並記為失敗，不會被當成空白的成功回覆
- **容器硬化**：非 root 執行、`cap_drop: ALL`、`no-new-privileges`，檔案擁有權自動對齊主機帳號

---

## 一鍵安裝（推薦）

不需要 clone 原始碼，本機也不需要 Node.js。映像由 CI 預建於 GHCR，安裝只下載部署檔並 `docker compose pull`。

事前準備：

- Docker 與 Docker Compose v2
- 一個 Telegram bot 的 token（向 [@BotFather](https://t.me/BotFather) 申請）與你自己的 Telegram 使用者 ID
- 可登入 opencode 的模型供應商帳號

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

以下步驟從原始碼建出正式映像並啟動。要邊改邊跑（熱重載）見下方「[本機開發](#本機開發)」。

### 1) 準備環境變數

複製 `.env.example`（開發）或 `.env.production.example`（保守上線），最低必要：

```env
TELEGRAM_TOKEN=your_bot_token
ALLOWED_USER_ID=your_telegram_user_id
DB_DIR=./data
```

### 2) 啟動服務

會建置並啟動 `telenexus`、`agent-runner`、`memoria` 三個容器：

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

| 指令                      | 說明                                               |
| ------------------------- | -------------------------------------------------- |
| `/start`                  | 顯示說明訊息與指令清單                             |
| `/reset`                  | 清除 AI 短期記憶（Context Window）                 |
| `/new`                    | 下一則訊息強制使用新 CLI session，不接續上一段對話 |
| `/abort`                  | 中止當前正在執行的 AI 任務並清空佇列               |
| `/send_file 路徑 \| 說明` | 把專案目錄內的檔案回傳到 Telegram                  |
| `/reflect`                | 手動觸發一次追蹤分析                               |

`/compress`、`/compact`、`/clear` 會原樣轉交給 Opencode CLI；可轉交的指令清單在 `ai-config.yaml` 的 `passthrough_commands`。

### 排程指令

| 指令                               | 說明                                                   |
| ---------------------------------- | ------------------------------------------------------ |
| `/add_schedule 名稱\|Cron\|提示詞` | 新增排程，例如 `/add_schedule 早安\|0 9 * * *\|說早安` |
| `/list_schedules`                  | 列出目前所有排程                                       |
| `/remove_schedule <ID>`            | 刪除指定排程，例如 `/remove_schedule 1`                |

### 排程管理（Docker CLI）

```bash
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js list
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js reload
docker compose exec telenexus node /app/dist/tools/scheduler-cli.js health
```

### 模型管理

| 指令                    | 說明                                          |
| ----------------------- | --------------------------------------------- |
| `/model`                | 顯示目前生效的模型及來源                      |
| `/models [provider]`    | 列出可用模型，可篩選 provider                 |
| `/set_model <model-id>` | 切換模型，下一則訊息立即生效                  |
| `/reset_model`          | 清除 override，恢復 `ai-config.yaml` 基礎設定 |

模型 override 寫入 `data/ai-config.override.yaml`，`ai-config.yaml` 維持唯讀不變動。

上游會下架模型，而 `opencode models` 仍會列出已下架的名稱。換模型前先實測：

```bash
docker compose exec agent-runner node scripts/probe-models.mjs        # 探測目前設定的模型
docker compose exec agent-runner node scripts/probe-models.mjs --all  # 探測所有可用模型
```

---

## 文件導覽

| 文件                                    | 內容                       |
| --------------------------------------- | -------------------------- |
| `docs/README.md`                        | 依任務查找文件的索引       |
| `docs/installation.md`                  | 一鍵安裝、升級與回滾       |
| `ARCHITECTURE.md`                       | 架構總覽與模組地圖         |
| `docs/configuration-reference.md`       | 所有環境變數與 runner 設定 |
| `docs/web-console-reference.md`         | Web Console API 與頁面說明 |
| `docs/summary-aware-retrieval-plan.md`  | 長對話記憶 SAR 設計        |
| `docs/scheduler-operation-runbook.md`   | 排程維運 runbook           |
| `docs/runtime-boundary-and-security.md` | 邊界與安全說明             |
| `docs/deployment-cutover-checklist.md`  | 部署 checklist             |
| `CHANGELOG.md`                          | 各版本的變更與背景         |
| `CONTRIBUTING.md`                       | 開發流程與提交規範         |

---

## 本機開發

開發時預設在容器內執行服務：工具鏈與正式映像相同（opencode、agent-browser、uv、Memoria），原始碼由主機掛載，存檔即重載。

```bash
npm run docker:dev   # 以 dev stage 啟動 telenexus、agent-runner、memoria（tsx watch）
```

同一台機器上已有另一份部署在跑時，開發用的 `.env` 要換成**另一個 bot** 的 `TELEGRAM_TOKEN`，`WEB_PORT` 也要錯開（例如 `3031`）。同一個 token 兩邊同時 poll，Telegram 會回 409，兩邊都收不到訊息。

`node_modules` 在映像內，改了 `package.json` 的依賴後重跑 `npm run docker:dev`（它帶 `--build`）。`package.json` 有任何變動時，重建會連全域 CLI 與 Chrome 一起重裝，需要幾分鐘。

開發容器以原始碼執行，沒有編譯後的 `/app/dist`。bot 內建的排程與記憶 skill 會呼叫 `dist/tools/` 下的 CLI，在開發 stack 內無法使用；要測這些流程，請用上方「從原始碼安裝」建出正式映像。

替代方式是直接在主機執行，需自備 opencode 等工具：

```bash
npm run dev          # 啟動主服務（tsx watch）
npm run dev:runner   # 啟動 agent-runner（tsx watch）
```

build、lint、test 在主機執行：

```bash
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

---

## 授權

[ISC License](LICENSE)
