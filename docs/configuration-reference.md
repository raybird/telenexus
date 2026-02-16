# Configuration Reference

## 推薦基線（單人使用）

```env
RUNNER_ENDPOINT=http://agent-runner:8787
SCHEDULE_USE_RUNNER=true

# 聊天流量（可先 10，再逐步提高）
CHAT_USE_RUNNER_PERCENT=100
CHAT_USE_RUNNER_ONLY_USERS=your_telegram_user_id

# runner 安全
RUNNER_SHARED_SECRET=change_this_to_a_long_random_secret

# runner 穩定性
RUNNER_FAILURE_THRESHOLD=3
RUNNER_COOLDOWN_MS=60000
RUNNER_SERIALIZE_GEMINI=true
RUNNER_ZOMBIE_WARN_THRESHOLD=8

# context 快照刷新
CONTEXT_REFRESH_MS=60000
```

備註：若未設定 `CHAT_USE_RUNNER_ONLY_USERS`，系統會預設使用 `ALLOWED_USER_ID`。

## ai-config.yaml（passthrough_commands）

可在 `ai-config.yaml` 設定要直通給底層 CLI/Agent 的 slash 指令：

```yaml
passthrough_commands:
  - /compress
  - /compact
  - /clear
```

補充：

- 若未設定，系統預設使用上述三個指令
- 命中白名單時，主程式會將原始指令直接送給底層 CLI
- passthrough 流程不會額外套 TeleNexus 摘要/上下文包裝
- 一般對話的記憶檢索由 TeleNexus 在分派前統一注入，與 provider hook 解耦

## Runner Session Context（重要）

目前預設聊天流量走 `agent-runner`（`CHAT_USE_RUNNER_PERCENT=100`）。
若要手動除錯並接續同一條 CLI context，請優先進 `agent-runner`。

```bash
# Gemini（接續 session）
docker compose exec agent-runner sh -lc "cd /app/workspace && gemini -r"

# Opencode（接續 session）
docker compose exec agent-runner sh -lc "cd /app/workspace && opencode run -c"
```

補充：

- 一般使用不需要手動進容器
- `/new` 會讓下一則一般對話訊息強制使用新 session
- 在 `telenexus` 容器手動執行 CLI，可能與 runner 實際脈絡不一致
- `RUNNER_SERIALIZE_GEMINI=true`（預設）：在 runner 內序列化 Gemini 任務，降低併發導致的 `SIGKILL` 風險
- `RUNNER_ZOMBIE_WARN_THRESHOLD=8`（預設）：寫入 `runner-status.md` 的殭屍進程告警門檻

## Memoria 自動同步

TeleNexus 會在每次成功對話後，背景嘗試呼叫 Memoria CLI 做增量同步。

可調整環境變數：

```env
MEMORIA_SYNC_ENABLED=auto
MEMORIA_HOME=/app/workspace/Memoria
MEMORIA_CLI_PATH=/app/workspace/Memoria/cli
MEMORIA_SYNC_TIMEOUT_MS=20000
MEMORIA_HOOK_QUEUE_ENABLED=false
MEMORIA_HOOK_QUEUE_FILE=/app/data/memoria-hook-queue.jsonl
MEMORIA_HOOK_FLUSH_SIGNAL=/app/data/memoria-hook-flush.signal
MEMORIA_HOOK_QUEUE_POLL_MS=5000
```

說明：

- `MEMORIA_SYNC_ENABLED=auto`：只有在 CLI 存在時才啟用；找不到會自動停用
- `MEMORIA_SYNC_ENABLED=on`：強制啟用（即使 CLI 缺失也會持續嘗試）
- `MEMORIA_SYNC_ENABLED=off`：完全停用同步
- 同步失敗只記錄 warning，不會中斷主對話流程
- `MEMORIA_HOOK_QUEUE_ENABLED=false`（預設）：完全 hook-free，只走 TeleNexus pipeline 同步
- 只有在 `MEMORIA_HOOK_QUEUE_ENABLED=true` 時，才會啟用 hook queue 檔案輪詢與 flush 訊號機制

## Telegram 檔案回傳

- 一般對話若要觸發檔案回傳，AI 需輸出：`[[SEND_FILE: workspace/temp/檔名 | 可選說明]]`
- 自動檔案回傳只允許 `workspace/temp/` 路徑
- 可用 `/send_file 路徑 | 說明` 手動回傳專案內檔案
- `SEND_FILE_STRICT_TEMP_ONLY=true`：啟用後，連 `/send_file` 也僅允許 `workspace/temp/`

## Telegram 訊息格式

- `TELEGRAM_FORMAT_MODE=auto|plain|html`（預設 `auto`）
- `auto`：偵測 Markdown/HTML 後優先用 `HTML parse_mode`，失敗自動降級純文字
- 超過 Telegram 單訊息長度而分段時，會自動改用純文字送出（避免分段破壞標記）
