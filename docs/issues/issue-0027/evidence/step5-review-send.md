# 審查修正後實機送樣本（2026-11-13）

樣本由 [step5-samples.ts](step5-samples.ts) `--review` 產生：review-6436089.md 的 M1、M2、S1、N1 各一則，加上改了寫法的標題（原樣本 4、9）。送法同 [步驟 1](step1-telegram-probe.md)。

## 修正後的輸出

```
sample 1: ok=True
sample 2: ok=True
sample 3: ok=True
sample 4: ok=True
sample 5: ok=True
sample 6: ok=True
```

## 修正前的輸出（對照）

直接送修正前轉換器的三種輸出：M1 的 `*__標題 _強調___*`、M2 的引言內兩個引言符號、S1 的引言內 fence。

```
sample 1: HTTP 400 Bad Request: can't parse entities: Can't find end of Bold entity at byte offset 20
sample 2: ok=True
sample 3: ok=True
```

M1 確認被 Telegram 拒收。M2、S1 的修正前輸出 Telegram 接受（審查報告「必定回 400」不成立），兩則測試訊息因此送到維護者的聊天；修正後的攤平寫法同樣被接受，保留修正。
