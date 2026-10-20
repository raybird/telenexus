# 調查：在資料副本上模擬遷移

- **日期**：2026-10-20
- **對應**：GitHub #15 建議方案「以固定舊資料與問句驗證遷移前後的命中、實際 prompt 注入、排程污染及跨使用者洩漏」
- **資料**：與 [investigation-scope-classification.md](investigation-scope-classification.md) 同一份副本，再各複製一份做成三個版本，全部在 repo 之外。
- **Memoria**：本機全域安裝的 `@raybird.chen/memoria` 1.28.1，與那台部署的版本相同。每個版本各自以獨立的 `MEMORIA_HOME` 執行 `memoria serve`，跑完用 PID 停止。

## 三個版本

| 版本 | 做法 |
|---|---|
| A 遷移前 | 原樣 |
| B 只改 scope | [investigation-scripts/migrate.mjs](investigation-scripts/migrate.mjs) `rescope`：依 `events.metadata.platform` 改 scope，summary 不動 |
| C 改 scope 加重建 summary | 同上的 `full` 模式：再依 `buildSummary()` 的格式（`使用者 → 模型`，每側 240 字）從 events 重建 summary |

B 和 C 都會刪掉這些 session 的 `memory_node_sources` 與 level-2 node，以及因此失去來源的舊 topic 和 root node，再執行 `memoria index build`。
Memoria 只會重建沒有 sources 的 session（`buildMemoryIndex` 的 `id NOT IN (SELECT DISTINCT session_id FROM memory_node_sources)`），
所以不必手寫 `memory_nodes`。`sessions` 的 UPDATE 觸發器會自動重建 `recall_fts`。

遷移後檢查（B、C 相同）：`quick_check` 為 ok、events 筆數不變、session 與 node 的 scope 不一致 0 筆、缺 level-2 node 的 session 從 80 筆降為 0、
smoke test 1 筆留在原分區。C 的 `recall_fts` 中 metadata body 從 2,300 筆降為 0。

## 問句與判定

問句在執行前就凍結。原文含私人對話內容，不放進 repo，以下只列主題。

- **舊決策 10 題**：每題對應一筆只存在於舊分區的真人對話，用換句話說的方式問，不照抄原句。
  主題：工具使用後的清理規則、某 repo 改成 MCP 服務的設計取捨、某專案與 Memoria 的同步頻率、儀表板說明的字數要求、專案的 clone 目錄、agent 命名風格、策略文件缺漏數、某專案的資料來源、某專案的處置決定、歷史存檔規劃。
- **現有資料 2 題**：對應遷移前就在 `user:` 分區的對話（系統狀況的磁碟用量、殭屍程序檢查），檢查遷移後會不會被擠掉。
- **對照 4 題**：「今天晚餐吃什麼好」、「幫我算 17 乘以 23」、「推薦一部科幻電影」、「怎麼煮義大利麵」。

[investigation-scripts/run-recall.mjs](investigation-scripts/run-recall.mjs) 送出的 payload 與 `MemoriaRecallClient` 相同：
`scope=user:<id>`、`top_k=5`、`mode=hybrid`、`project=TeleNexus`。整次召回的 confidence 低於 0.2 時視為不注入（`DEFAULT_RECALL_MIN_CONFIDENCE`）。
「命中」指目標 session 出現在注入的結果中。

## 結果

| 版本 | 舊決策 10 題 | 現有資料 2 題 | 對照題被注入 | 注入排程內容 | 注入其他 scope |
|---|---|---|---|---|---|
| A 遷移前 | 0/10 | 2/2 | 1/4 | 0 | 0 |
| B 只改 scope | **0/10** | 2/2 | 1/4 | 0 | 0 |
| C 改 scope 加重建 summary | **7/10** | 2/2 | 2/4 | 0 | 0 |

- **B 與 A 完全相同**：summary 仍是 metadata，改 scope 只是讓聊天「看得到」，但沒有內容可以比對。
- **C 未命中的 3 題**：
  - 2 題注入的是同主題的其他對話（某工具留下的殘留程序與清理腳本、其他 repo 也 clone 到同一目錄），雖然不是目標那筆，但內容可以回答問題。
  - 1 題注入的都是同一專案的介紹類對話，沒有「後來怎麼處置」那筆決策，算真正漏掉。
- **路由**：C 的 12 題非對照題都走 `hybrid_fallback`，A 的現有資料題有 1 題走 `hybrid_tree`。

### confidence 門檻需要重新校準

| | A 遷移前 | C 遷移後 |
|---|---|---|
| 對照題（晚餐／17×23／電影／義大利麵） | 0.142 ／ 0.2 ／ 0 ／ 0 | 0.285 ／ 0.4 ／ 0.142 ／ 0.166 |
| 舊決策命中題 | — | 0.294 ～ 0.75 |

0.2 門檻是 issue 0012 在 `user:` 分區只有 15～20 筆時取樣定的（無關題最高 0.143）。語料擴大到 1,041 筆後，無關題的 confidence 上升，
「17 乘以 23」到 0.4，已經高於相關題的最低值 0.294，單靠門檻分不開。這題在遷移前就以 0.2 被注入，
注入的對話多半含數字（日期、時間、版本號、股票代號），推測是問句裡的數字 token 撞上這些數字，尚未查證。

## 對 #15 方案的影響

1. 遷移範圍是「重新分區 + 從 events 重建 summary + 刪除舊 node 與 sources 後重建索引」，不只是改 scope。
2. 分類可以完全依 `events.metadata.platform` 與 `user_id` 自動完成，需要人工審閱的只有 metadata 為空的資料。
3. 驗收要加上：遷移後依擴大的語料重新校準 `MEMORIA_RECALL_MIN_CONFIDENCE`，並把無關問句的注入率列為指標。
4. 正式工具還需要這次模擬沒做的部分：遷移前備份、可回復、可重跑（已遷移的不重複處理）、遷移紀錄（來源 ID、分類依據、統計）、資料不符預期時中止。
