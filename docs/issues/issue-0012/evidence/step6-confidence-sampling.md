# 步驟 6：Memoria confidence 門檻的抽樣

- **日期**：2026-10-07
- **對應**：SCN-008；TBD-2
- **資料**：正式部署 Memoria volume 的快照。以唯讀掛載 volume、在一次性容器內複製到 repo 之外的暫存目錄，`PRAGMA quick_check=ok`。抽樣完快照、原始結果與容器都已刪除。repo 是公開的，所以本檔只記數值與相關與否的判定，不記召回內容。
- **執行個體**：同一個映像 `ghcr.io/raybird/telenexus-memoria:v2.28.0`，以 `docker run --network none` 隔離啟動，資料指向快照。正式的 Memoria 容器與 volume 都沒有被寫入。
- **請求**：與正式環境相同：`POST /v1/recall`，`project: "TeleNexus"`、`scope: "user:<正式使用者>"`、`top_k: 5`、`mode: "hybrid"`。

## 問題集（執行前凍結）

相關與否是依快照中已知的對話主題預先標記的，執行前寫死。

| ID | 預期 | 問題 |
|---|---|---|
| R1 | 相關 | 之前殭屍程序的問題後來怎麼處理？ |
| R2 | 相關 | git pull 要輸入密碼的設定你上次怎麼改的 |
| R3 | 相關 | Crypto Monitor 排程現在用哪些資料來源？ |
| R4 | 相關 | skill-linker 的發版流程是什麼 |
| R5 | 相關 | 盤前台股催化劑分析的排程時間是幾點 |
| R6 | 相關 | 你的記憶系統目前狀況如何 |
| U1 | 無關 | 推薦一本適合週末看的推理小說 |
| U2 | 無關 | 手沖咖啡的水溫應該幾度 |
| U3 | 無關 | 幫我想三個貓咪的名字 |
| U4 | 無關 | 怎麼把襯衫上的咖啡漬洗掉 |
| U5 | 無關 | 日文的謝謝怎麼說 |
| U6 | 無關 | 今天晚餐吃什麼好 |

## 結果

「相關命中」是逐筆閱讀召回內容後，判定與問題有關的筆數。

| ID | route_mode | confidence | basis | 命中 | 相關命中 |
|---|---|---|---|---|---|
| R1 | hybrid_tree | 0.286 | lexical_coverage | 3 | 2 |
| R2 | hybrid_fallback | 0.375 | lexical_coverage | 5 | 3 |
| R3 | hybrid_fallback | 0.250 | lexical_coverage | 5 | 3 |
| R4 | hybrid_fallback | 0.111 | lexical_coverage | 4 | 1 |
| R5 | hybrid_tree | 0.438 | lexical_coverage | 5 | 1 |
| R6 | hybrid_fallback | 0.364 | lexical_coverage | 5 | 3 |
| U1 | hybrid_tree | 0.077 | lexical_coverage | 1 | 0 |
| U2 | hybrid_tree | 0.100 | lexical_coverage | 2 | 0 |
| U3 | hybrid_tree | 0.111 | lexical_coverage | 2 | 0 |
| U4 | hybrid_fallback | 0 | no_hits | 0 | 0 |
| U5 | hybrid_fallback | 0 | no_hits | 0 | 0 |
| U6 | hybrid_tree | 0.143 | lexical_coverage | 1 | 0 |

現行行為下，無關問題 U1、U2、U3、U6 的 6 筆命中全都會被注入。

## 結論（TBD-2）

- **預設門檻 0.2**：無關問題的最高值是 0.143，相關問題（R4 以外）的最低值是 0.25，0.2 落在兩者之間，兩邊都有餘裕。這個門檻會擋下 U1、U2、U3、U6 的 6 筆無關命中，以及 R4 的 4 筆命中。R4 的 4 筆中只有 1 筆與問題有關，所以只損失 1 筆有關內容。被擋下時改用既有的本機語意摘要，與 Memoria 回傳 0 筆時相同。
- **confidence 為 null 時照常注入**：null 代表該路由無法判斷匹配品質（`confidence_basis: unavailable`），與 0 的意思不同。擋掉它等於在無法判斷時靜默丟棄，所以維持變更前的行為。
- **限制**：
  - 這是 12 題的小樣本，門檻做成 `MEMORIA_RECALL_MIN_CONFIDENCE`，可以調整。被擋下時會在 `memoria_recall` 事件中帶 `dropped_low_confidence` 與 `min_confidence`，可在 `events.jsonl` 觀察實際比例。
  - confidence 衡量的是問題字詞的覆蓋率，不是每一筆命中的相關度（R5 的 confidence 最高，但 5 筆中只有 1 筆有關）。門檻只能擋掉「整次召回都沾不上邊」的情況，不能取代排序。
