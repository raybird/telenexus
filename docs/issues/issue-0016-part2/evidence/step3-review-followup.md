# 審查後續（review-3dc3f44）

- **日期**：2026-10-21
- **審查**：[review-3dc3f44.md](../review-3dc3f44.md)，PASS，SHOULD FIX 1 項。依 Gate 豁免紀錄，有要修的項目時不自動合併，所以先修再複審。

| 審查項目 | 處理 |
|---|---|
| SHOULD FIX：遠端 AC-2 測試分不出「啟動時警告一次」和「每輪都警告」（M6 存活），也沒有檢查警告裡的「每輪只會印 skipped」（M9 存活） | 測試在 worker 啟動後再跑一輪 `runOnce('interval')`，確認 warn 仍然只有 1 次、startup 與 interval 各印一行 skipped，並補上 `/每輪只會印 skipped/` 的比對。重跑後 M6（把警告移到每輪執行的地方）、M9（拿掉這句）都讓這個測試轉紅。 |
| NICE：`docs/web-console-reference.md` 的 `remote-unsupported` 說明 | 補上「遠端模式正式不支援回填」，並指向 `configuration-reference.md`。 |
| NICE：`src/services/memory-backfill.ts` 有 NUL 位元組，`grep` 會跳過它 | 在 step2 註明。這不是這次造成的，所以不改。 |
| NICE：`CHANGELOG.md` 2.31.0 段落 | 已經發版的紀錄，不改。step2 已註明，下一版的 release notes 要寫明已定案。 |

**驗證**
- 3 個目標測試檔 48/48 通過。
- `npm run lint` exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm test` exit 0，`# tests 598`、`# pass 598`、`# fail 0`。

M6、M9 的做法和步驟 1 相同：取代一次，跑 `tests/memory-backfill-worker.test.ts`，從備份複製回來，再以 `diff -q` 確認。
