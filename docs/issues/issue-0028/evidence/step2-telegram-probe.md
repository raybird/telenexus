# 步驟 2：Telegram 可展開引言的實測（2026-11-16）

## 送法

樣本由 [step2-samples.ts](step2-samples.ts) 產生：結論用現有轉換器 `renderMarkdownV2()` 渲染；過程第一行是「過程」，每段也用同一個轉換器渲染後在每行前加 `>`，第一行改成 `**>`，最後一行結尾加 `||`。

找不到開發用 bot 的 token，使用者同日改選「改用正式 bot 直接呼叫」：以正式 bot 的 token 直接呼叫 Bot API `sendMessage`（`parse_mode: MarkdownV2`），送到維護者的聊天，不 poll、不停正式服務。token 與聊天 ID 只在命令內從部署的 `.env` 讀出，不記錄。

Node 的 `fetch` 連 api.telegram.org 時，第一次在雙棧自動選擇的 250ms 內逾時，關掉自動選擇後又在 TLS 握手時被重設（#27 步驟 5 也遇過）；改用 curl（token 經 `--config` 傳入，不出現在參數），每則最多重試 3 次，實際都一次成功。

## 樣本與 API 回應

| # | 內容 | 長度（MarkdownV2 原文字元） | 回應 |
|---|---|---|---|
| 1 | 最小：兩段過程，段落之間用空的引言行（`>`） | 177 | ok=true |
| 2 | 同上，段落之間不空行 | 174 | ok=true |
| 3 | 過程裡有二級標題（`__*…*__`）、清單、粗體、行內程式碼 | 246 | ok=true |
| 4 | 過程以程式碼區塊結尾（`` >```|| ``） | 182 | ok=true |
| 5 | 只有過程的訊息（超長時另起的那則） | 63 | ok=true |
| 6 | 第一行是排程標頭「🕐 \[排程: Crypto Monitor\]」，接 `[Opencode]` 與結論 | 185 | ok=true |
| 7 | 接近上限：結論約 3,000、過程約 1,000 字 | 4,063 | ok=true |
| 8 | 刻意寫錯：引言裡的 `.` 沒有跳脫 | 51 | error_code=400 `Bad Request: can't parse entities: Character '.' is reserved and must be escaped with the preceding '\'` |

第 8 則的錯誤描述含 `can't parse entities`，符合 `TelegramConnector.isParseModeError()` 的判斷（400 加上該字串），純文字退回會照常觸發（SCN-006）。

## 使用者確認

使用者 2026-11-16 在手機上看過第 1～7 則：過程都預設摺疊、可以展開，結論在前（「都正常」）。段落之間的寫法選第 1 則「留空行（建議）」。

## 定案的寫法

- 第一行 `**>過程`，之後每行前加 `>`，最後一行結尾加 `||`。
- 過程裡各段之間放一個空的引言行 `>`；段落內原本的空行同樣寫成 `>`。
- 引言裡的標題、清單、粗體、行內程式碼、程式碼區塊都照現有轉換器的輸出，不必另外處理；程式碼區塊在最後時，`||` 直接接在結尾的 fence 後面。
