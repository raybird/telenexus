# Streaming Rollout Note 2026-04-04

## 範圍

本輪完成 TeleNexus 從 CLI 純文字整合，演進到結構化結果與多通道 streaming 的主要骨架，包含：

- Gemini structured output
- Opencode structured output
- Web true streaming
- runner streaming
- Opencode true streaming
- Telegram throttled streaming

## 已完成項目

### Provider 層

- `GeminiAgent` 已支援：
  - `chatStructured()`
  - `streamChat()`
- `OpencodeAgent` 已支援：
  - `chatStructured()`
  - `streamChat()`

### 標準化模型

- 新增 `AgentStructuredResult`
- 新增 `AgentEvent`

### Runner

- `/run` 已可回傳 `structured`
- `/run/stream` 已可提供 SSE streaming
- `DynamicAIAgent` 已可消費 runner streaming

### Web

- `/api/chat/stream` 已改成真正 provider-driven streaming
- 不再是完整回覆後再切假 chunk

### Telegram

- 已新增 `TelegramStreamRenderer`
- Telegram chat 可選擇啟用節流式 streaming
- 中途使用 plain text edit
- 完成時以 final text 對齊
- 長訊息可退為提示 + 分段送出

## 目前 Telegram 實際設定

目前在 `.env` 採用：

```text
TELEGRAM_STREAMING_ENABLED=true
TELEGRAM_STREAM_EDIT_THROTTLE_MS=1000
TELEGRAM_STREAM_MIN_DELTA_CHARS=40
TELEGRAM_STREAM_FORCE_FLUSH_MS=2500
TELEGRAM_STREAM_EARLY_FLUSH_CHARS=120
TELEGRAM_STREAM_MAX_EDIT_FAILURES=3
```

這組值是根據實際體感調整後的平衡版，不是最激進設定。

## 驗證結果

- `npm test` 通過
- `npm run build` 通過
- Web streaming integration test 已存在
- runner streaming test 已存在
- Telegram streaming pipeline test 已存在

## 部署注意事項

若 `.env` 新增或修改環境變數，`docker compose restart` 不足以讓新 env 生效。

本輪已確認需要：

```bash
docker compose up -d --force-recreate telenexus
```

否則容器會沿用舊環境變數，導致功能看似未啟用。

## 觀測方式

目前 Telegram streaming 可透過以下 log 觀察：

- `telegram-stream stream.started`
- `telegram-stream stream.first-delta`
- `telegram-stream stream.flush`
- `telegram-stream stream.finalizing`
- `telegram-stream stream.finalized-via-edit`
- `telegram-stream stream.finalized-via-send`
- `telegram-stream stream.failed`

建議觀察命令：

```bash
docker compose logs -f telenexus
```

## 已知注意事項

- MemoryBackfillWorker 目前仍可能出現與 dotenv stdout 混雜導致的 JSON parse 警告
- 這不屬於本輪 streaming 主題，但後續可獨立處理
- Telegram streaming 中途一律 plain text，final 才走既有格式能力

## 建議後續

1. 觀察 Telegram 實際使用幾輪後，再決定是否需要微調節流值
2. 補更多 Telegram renderer 單元測試，特別是 edit 失敗與長訊息情境
3. 若要正式發版，建議把這份 rollout note 作為變更摘要參考
