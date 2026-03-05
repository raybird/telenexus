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

## Timezone

- 系統時區以容器環境變數 `TZ` 為唯一來源（預設 `Asia/Taipei`）
- `ai-config.yaml` 不再建議設定 `timezone`

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
MEMORIA_HOOK_QUEUE_ENABLED=true
MEMORIA_HOOK_QUEUE_FILE=/app/data/memoria-hook-queue.jsonl
MEMORIA_HOOK_FLUSH_SIGNAL=/app/data/memoria-hook-flush.signal
MEMORIA_HOOK_QUEUE_POLL_MS=5000
```

說明：

- `MEMORIA_SYNC_ENABLED=auto`：只有在 CLI 存在時才啟用；找不到會自動停用
- `MEMORIA_SYNC_ENABLED=on`：強制啟用（即使 CLI 缺失也會持續嘗試）
- `MEMORIA_SYNC_ENABLED=off`：完全停用同步
- 同步失敗只記錄 warning，不會中斷主對話流程
- `MEMORIA_HOOK_QUEUE_ENABLED=true`（預設）：啟用 hook queue 輪詢；即使沒有 hook 輸入也不影響主流程
- 設為 `false` 可切回完全 hook-free，只走 TeleNexus pipeline 同步

## Telegram 檔案回傳

- 一般對話若要觸發檔案回傳，AI 需輸出：`[[SEND_FILE: workspace/temp/檔名 | 可選說明]]`
- 自動檔案回傳只允許 `workspace/temp/` 路徑
- 可用 `/send_file 路徑 | 說明` 手動回傳專案內檔案
- `SEND_FILE_STRICT_TEMP_ONLY=true`：啟用後，連 `/send_file` 也僅允許 `workspace/temp/`

## Telegram 訊息格式

- `TELEGRAM_FORMAT_MODE=auto|plain|html`（預設 `auto`）
- `auto`：偵測 Markdown/HTML 後優先用 `HTML parse_mode`，失敗自動降級純文字
- 超過 Telegram 單訊息長度而分段時，會自動改用純文字送出（避免分段破壞標記）
- `TELEGRAM_TABLE_RENDER_MODE=auto|card|code`（預設 `auto`）
  - `auto`：小表格轉 monospace code table；寬表/長欄位轉比較卡片
  - `card`：所有 Markdown table 一律轉卡片式條列
  - `code`：所有 Markdown table 一律轉 monospace code block

## Telegram API 穩定性

- `TELEGRAM_API_TIMEOUT_MS`（預設 `15000`）
- `TELEGRAM_API_RETRY_COUNT`（預設 `1`）
- `TELEGRAM_API_RETRY_DELAY_MS`（預設 `800`）
- `TELEGRAM_LAUNCH_TIMEOUT_MS`（預設 `20000`）
- `TELEGRAM_LAUNCH_RETRY_BASE_MS`（預設 `2000`）
- `TELEGRAM_LAUNCH_RETRY_MAX_MS`（預設 `60000`）
- 輪播 placeholder 的 `editMessage` 會使用單一 in-flight 更新，避免舊請求晚到覆蓋最終回覆
- 最終 AI 回覆預設採用 `sendMessage`；為降低重複回覆風險，timeout 可設定為不重試
- Telegram 啟動遇到網路暫時異常（如 `ETIMEDOUT` / `EAI_AGAIN`）會自動退避重試，不會直接結束程序

## Log 降噪與除錯

- `OPENCODE_VERBOSE_STDERR=true|false`（預設 `false`）
- 預設只輸出 opencode stderr 摘要（首行 + 長度）
- 若 stderr 含錯誤關鍵字（error/fatal/failed...）會自動升級輸出
- 需要完整 stderr 時可臨時設 `OPENCODE_VERBOSE_STDERR=true`

## 對話排隊與 Prompt 注入

- `CHAT_FULL_PROMPT_EVERY`（預設 `6`）：每 N 則對話注入一次完整 system prompt，其餘使用 compact prompt
- 聊天請求與 scheduler 任務共用同一條 user execution queue
- queue priority：`chat > chat-summary > scheduler`
- 聊天遇到排隊時會先回覆等待提示，避免和背景任務重疊衝突

## Telegram 圖片接收

- `TELEGRAM_IMAGE_MAX_BYTES`（預設 `20971520`，20MB）
- `IMAGE_ATTACHMENT_PENDING_TTL_MS`（預設 `600000`，10 分鐘）
- 使用者若先只上傳圖片，系統會暫存附件並提示下一則文字；後續文字會自動合併該附件送入 prompt

## 回覆後補充摘要

- `SUMMARY_FOLLOWUP_ENABLED=true|false`（預設 `true`）
- `SUMMARY_FOLLOWUP_MIN_LENGTH`（預設 `500`）：主回覆超過此長度才會背景補一則摘要
- `SUMMARY_FOLLOWUP_MAX_LENGTH`（預設 `320`）：補充摘要最大字數（超出會截斷）
- 補充摘要在主回覆送出後非阻塞執行，不影響首則回覆速度
