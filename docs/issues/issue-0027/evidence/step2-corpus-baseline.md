# 步驟 2：舊轉換器的實際資料基線（2026-11-13）

## 資料與方法

- 資料：正式部署 `data/moltbot.db` 的 `messages`，`role = 'model'`，時間 2026-09-14 至 2026-11-13，共 881 則。以 `sqlite3 -readonly` 取出，原文與輸出只放在 session 暫存目錄，不進 repo。
- 轉換器：`git show 8945e22:src/telegram/render/markdown-v2.ts`（改動前的 main）。每則先經 `TelegramConnector.normalizeMarkdownTables()`，與正式路徑 `renderForMarkdownV2()` 相同。
- 缺字詞的判定（[corpus-check.ts](corpus-check.ts)）：解析後的 mdast 中，每個節點的 `value`、`alt` 與連結網址依空白切成字詞；轉換後的輸出去掉 MarkdownV2 跳脫後，字詞不是它的子字串就算缺。只檢查有沒有出現，不檢查次數，所以重複出現的字詞若只丟一份測不到。
- AC-6 類：沒有標題、沒有編號清單、沒有子清單，清單項目與引言裡只有段落的回覆。

## 結果

```
{"renderer":"old","replies":881,"lossyReplies":130,"missingTokens":8203,"ac6Replies":444}
```

缺字詞的 130 則依原因分類（同一則可能有兩種原因）：

| 原因 | 則數 |
|---|---|
| 清單項目裡的子清單被丟掉 | 108 |
| 行內 HTML 被丟掉 | 15 |
| 兩者都有 | 7 |

子清單合計 115 則，與 issue 建立時的統計相同。行內 HTML 共 22 則、90 處，全部是 `</think>` 標籤：出現在 2026-10-13 至 2026-10-22 的回覆，標籤前是模型的英文推理文字，2026-10-22 之後沒有再出現。
