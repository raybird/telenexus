# 步驟 4：實際資料的新舊對照（2026-11-13）

資料與缺字詞的判定同 [步驟 2](step2-corpus-baseline.md)，腳本 [corpus-check.ts](corpus-check.ts)、[corpus-compare.ts](corpus-compare.ts)。依 AC-4 的規格修訂，`<think>`、`</think>` 不算缺字詞，所以舊版從步驟 2 的 130 則變成 115 則：只有 think 標籤被丟掉的 15 則不再算缺。

```
{"renderer":"old","replies":881,"lossyReplies":115,"missingTokens":8113,"ac6Replies":444}
{"renderer":"new","replies":881,"lossyReplies":0,"missingTokens":0,"ac6Replies":444}
{"replies":881,"outputChanged":436,"ac6Replies":444,"ac6Identical":444}
```

- AC-4：新版缺字詞 0 則（舊版 115 則，全部是子清單）。
- AC-6：不含標題、編號清單、子清單，清單項目與引言裡只有段落的 444 則，新舊輸出逐字相同。輸出有變的 436 則都在 AC-6 類之外。
