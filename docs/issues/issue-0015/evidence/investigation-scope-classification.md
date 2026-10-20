# 調查：舊 project scope 封存的分類依據

- **日期**：2026-10-20
- **對應**：GitHub #15 重現步驟 3（區分 scope 不可達、內容索引與分類可信度）
- **資料**：另一台部署的 Memoria `sessions.db` 副本，以 `VACUUM INTO` 唯讀匯出。Memoria 1.28.1，`PRAGMA quick_check` 為 ok。副本放在 repo 之外，未改動正式資料。
- **方法**：只用 `sqlite3 -readonly` 查詢。使用者 ID 與 session ID 一律遮蔽，對話內容不列出。

## 分區現況

| scope | sessions | 期間 |
|---|---|---|
| `project:TeleNexus` | 2,301 | 2026-02-23 ～ 2026-08-14 |
| `scheduler:<id>` | 208 | 2026-08-14 ～ 2026-10-20 |
| `user:<id>` | 20 | 2026-08-15 ～ 2026-10-19 |

舊分區每個 session 剛好有一筆 `UserMessage` 與一筆 `ModelMessage`，沒有 `DecisionMade` / `SkillLearned`。模型回覆沒有一筆是空的。

## 分類依據：`events.metadata`

每筆 `UserMessage` 的 metadata 都帶有結構化的 `platform` 與 `user_id`，例如 `{"source":"telenexus","user_id":"<id>","platform":"telegram",…}`。
它和 session summary 字串裡的 `platform=` **完全一致（不一致 0 筆）**，所以不需要靠內容前綴猜。

| platform | 內容類型 | 筆數 | 歸屬 |
|---|---|---|---|
| telegram | 一般對話 | 950 | `user:<id>` |
| telegram | 以 `[` 開頭的一般對話 | 1 | `user:<id>` |
| console | 一般對話 | 8 | `user:<id>` |
| telegram | passthrough（`/compress` 55、`/compact` 7） | 62 | `user:<id>`（使用者決定，與現行同步行為一致） |
| scheduler | `[排程任務]` | 837 | `scheduler:<id>` |
| scheduler | `[追蹤提醒]` | 154 | `scheduler:<id>` |
| scheduler | `[排程任務失敗]` | 131 | `scheduler:<id>` |
| scheduler | `[每日摘要]` | 125 | `scheduler:<id>` |
| scheduler | `[追蹤檢查]` | 31 | `scheduler:<id>` |
| scheduler | `[追蹤提醒失敗]` | 1 | `scheduler:<id>` |
| （metadata 為 `{}`） | smoke test | 1 | 人工審閱，不遷移 |

合計：`user:` 1,021、`scheduler:` 1,279、人工審閱 1。

- **擁有者**：除了 smoke test 之外，`user_id` 都是同一個人，這份資料沒有跨使用者洩漏的風險。工具仍需依 `user_id` 分區，才能滿足多使用者隔離的驗收條件。
- **時間分布**：真人對話集中在 2026-02～05（870／959 筆），06 月之後以排程為主。

| 月份 | 真人對話 | 排程 |
|---|---|---|
| 2026-02 | 135 | 0 |
| 2026-03 | 452 | 21 |
| 2026-04 | 133 | 383 |
| 2026-05 | 150 | 272 |
| 2026-06 | 49 | 292 |
| 2026-07 | 32 | 253 |
| 2026-08 | 8 | 58 |

真人對話的欄位不含 passthrough，排程的欄位包含所有 scheduler 類型。

## 只改 scope 不夠：可檢索文字都是 metadata

舊分區 2,301 筆中有 **2,300 筆的 `sessions.summary` 是 `user=<id> platform=… source=pipeline passthrough=…`**，也就是 2026-08-14 修正前的寫法（見 `src/core/memoria-sync.ts` 的 `buildSummary()` 註解）。因此：

- `recall_fts` 的 session 列有 2,300 筆 body 是 metadata。
- `memory_nodes` 的 level-2 node title/summary 同樣是 metadata，2,221 筆只掛在 7 個 topic node 底下，因為 summary 全都相同。
- 另有 80 筆 session（2026-02-26 ～ 02-27）有 `memory_node_sources` 卻沒有 level-2 node。`/v1/stats` 的 `memoryIndex.missing` 看的是 sources，所以仍顯示 0。

遷移必須從 events 重建 summary，只改 scope 召回不到任何內容。實測見 [investigation-migration-simulation.md](investigation-migration-simulation.md)。
