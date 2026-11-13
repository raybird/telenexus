# 步驟 5：完工後實機送樣本（2026-11-13）

樣本由 [step5-samples.ts](step5-samples.ts) 以新轉換器產生，涵蓋 AC-1～AC-4 的每一種結構，另加一則模擬市場報告與一則特殊字元。以正式 bot 的 token 呼叫 Bot API `sendMessage`（`parse_mode: MarkdownV2`）送到維護者的聊天，送法同 [步驟 1](step1-telegram-probe.md)。

## API 回應

```
sample 1: ok=True
sample 2: ok=True
sample 3: ok=True
sample 4: ok=True
sample 5: ok=True
sample 6: ok=True
sample 7: ok=True
sample 8: ok=True
sample 9: ok=True
sample 10: ConnectionResetError（TLS handshake 時連線被重設，請求沒有送到 Telegram）
# 只重送第 10 則
sample 10: ok=True
```

10 則都回 `ok: true`，沒有 `can't parse entities`。
