# 步驟 4：以編譯後的程式端到端確認

- **日期**：2026-10-21
- **對應**：AC-2、AC-4

## 端到端

- **做法**：先 `npm run build`，再用 [scripts/verify-client.mjs](scripts/verify-client.mjs) 載入 `dist/core/memoria-recall.js`，以 `MemoriaRecallClient.recallWithMeta(問句, scope)` 對資料副本的 Memoria 服務跑全部題目。服務是步驟 1 的同一個容器。
- **比對**：逐題比對「是否注入」，對象是 `evaluate.mjs` 用第二版判準（`strip-function-words-v2`、門檻 0.2、`minMatched=2`、`snippet-top`）對同一份原始回應的離線結果。
- **範圍**：舊的 100 題加上全新驗收集的 34 題，共 134 題。
- **環境**：`MEMORIA_RECALL_MIN_CONFIDENCE` 未設定，用預設 0.2。`APP_PROJECT_DIR` 指向暫存目錄，事件不會寫進 repo。

結果：`比對 134 題，不一致 0 題`。

所以 TypeScript 實作的判斷與步驟 2 的離線計算完全相同，步驟 2 的數字就是實作的數字。

這次比對會對驗收集再發一次 recall。目的是比對實作和離線計算，判準在比對前就已經定案，沒有依結果調整，所以不算第二次驗收。

## 文件（AC-4）

| 檔案 | 內容 |
|---|---|
| `docs/configuration-reference.md` | `MEMORIA_RECALL_MIN_CONFIDENCE` 的新意義：兩個條件、問句改寫、Memoria 召回紀錄存改寫後的問句。另外寫明原因、量測結果、已知限制，以及新的事件欄位 |
| `docs/current-chat-prompt.md` | 「相關歷史摘要」不用 Memoria 結果的條件 |
| `docs/summary-aware-retrieval-plan.md` | 同上 |
| `docs/web-console-reference.md` | `Injected Rate` 不計入的召回，包括內容 token 不足而被擋下的 |
| `ARCHITECTURE.md`、`CLAUDE.md` | 登記 `src/core/memoria-recall-query.ts` |
