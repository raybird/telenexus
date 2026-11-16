# 步驟 4：本機語料檢查（2026-11-16）

以步驟 1 的 opencode.db 快照（只在本機 scratchpad，2026-10-17 起，排除健康探針）跑新的分段與組版，只記數字，不記原文（地雷 L-10）。

## 做法

1. 從快照的 `message`／`part` 表依 `parentID` 取出每個回合各 assistant 訊息（step）的文字，排除探針後 438 個回合。
2. [step4-corpus-check.ts](step4-corpus-check.ts) 以實際的 `StepTextCollector` 分出過程與結論（最後一個 step 以外都當成 `tool-calls`），結論前加 `[Opencode] `，加上排程標頭，交給 `buildFoldedMessages()`，渲染用與 `TelegramConnector` 相同的 `normalizeMarkdownTables()` + `renderMarkdownV2()`。
3. 字詞保留沿用 #27 的檢查：以 remark 解析結論與每段過程取出字詞，逐一確認出現在所有訊息合起來、去掉跳脫後的文字裡（think 標籤依 #27 不輸出，不算缺）。另檢查每則長度、引言結構（`**>` 之後每行以 `>` 開頭、最後一行以 `||` 結尾），以及純文字版本是否含引言標記。

## 結果

```
{"turns":391,"scheduled":386,"withProcess":85,"messages":404,"multiMessageTurns":8,"lossyTurns":0,"missingTokens":0,"overLimitMessages":0,"brokenQuoteMessages":0,"plainWithQuoteMarkup":0}
```

- 有文字的回合 391 個（386 個排程），其中 85 個有過程，與步驟 1 的統計相同。
- 送出 404 則，8 個回合超過一則。
- 缺字詞的回合 0、超過 4096 字的訊息 0、引言不完整的訊息 0、純文字版本含引言標記 0（SCN-004、SCN-006、SCN-012）。

## 反向自檢

把腳本複製一份，送進組版的過程改成少第一段（`process.slice(1)`），其餘不變：

```
{"turns":391,"scheduled":386,"withProcess":85,"messages":403,"multiMessageTurns":7,"lossyTurns":85,"missingTokens":460,"overLimitMessages":0,"brokenQuoteMessages":0,"plainWithQuoteMarkup":0}
```

85 個有過程的回合全部被判為缺字詞，檢查確實抓得到遺漏。複製的腳本跑完即刪除。
