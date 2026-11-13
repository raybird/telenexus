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

## 使用者確認

使用者 2026-11-13 在手機上看完 10 則後回覆：第 8 則（不認得的節點與 think 標籤）的 `<b>粗</b>` 與 `![圖說](https://...)` 照原文顯示，問這樣是否正確，「其他都正常」。照原文顯示是 AC-4 的設計（舊版會讓兩者消失）；近 60 天的回覆中除 think 標籤外的 HTML 與圖片都是 0 則，使用者選擇「維持原文顯示（建議）」。
