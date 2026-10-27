# 步驟 4：健康報告與 Web Console（SCN-007、SCN-008）

- 日期：2026-10-27

## 改動

- `src/services/memory-health.ts`：
  - `MemoryHealthReport` 拿掉 `retrieval`、`backfill`、`consistency`，`paths` 只留 `operationalDb`、`archiveDb`。
  - 一併刪除只服務這三個區塊的型別與函式：`BackfillCheckpoint`、`ConsistencyCheckStatus`、`BackfillSourceState`、`BackfillSourceAssessment`、`readCheckpoint`、`readRetrievalRows`、`extractSourceSessionId`、`currentArchiveSource`、`judgeBackfillSource`、`assessBackfillSource`、`checkCheckpointField`、`collectConsistencyReport`。另外，`ArchiveRead` 的 `sessionIds` 只給一致性檢查用，也拿掉了，`readArchive` 因此少了一次 `SELECT id FROM sessions`。
  - `formatMemoryHealthMarkdown` 拿掉對應的行。operational 與 archive 的行原文和順序都不變。
  - `countRecentMemoriaIssues` 的比對從 `/memoria|memory-backfill/`（scope）與 `/memoria|backfill/`（message）改成只比 `memoria`。回填移除後已經沒有程式會記 `memory-backfill:*` 的 runtime issue，所以 `syncFailures24h` 的值不變。
  - `collectMemoryHealthReport` 上方註解原本說 FTS5 表在 `memory.db`，實際上在 `moltbot.db`（`src/core/memory.ts:150`），已改正，並拿掉已移除的 `memory:backfill`。
- `src/utils/paths.ts`：拿掉 `resolveMemoryDbPath`、`resolveMemoryBackfillCheckpointPath`，`resolveMemoriaSessionsDbPath` 的註解改成「讓健康報告自動跳過 archive」。
- Web Console：
  - `views/status.js`：拿掉 Recent Backfill Runs 區塊與 `renderBackfillReport`、`Backfill Status`／`Backfill Written` 兩張卡；
  - `services/status-service.js`：拿掉 `getBackfillReport`；
  - `main.js`：拿掉 backfill 警告。

## 測試的變更

### 新增

- `tests/memory-health.test.ts`：`issue 0022 SCN-007 健康報告只有運作資料庫與封存，memory.db 存在時不讀也不改`。
  - 頂層鍵與 `paths` 的鍵是字面值清單；
  - markdown 的欄位名稱與順序和字面值清單 `REPORT_MARKDOWN_KEYS` 完全相同，清單由 v2.32.0 的 operational／archive 行抄錄，不從實作推算；
  - `memory.db` 的大小與 `mtimeMs` 在產生報告前後相同。

### 改寫

依 verification.md，這屬於「核准的行為已變更」（SCN-007）。

- `tests/context-snapshots.test.ts` 的 `AC-3：檢索資料庫不是 SQLite 時 memory-status 照常更新並標 error…`：原本斷言 `Retrieval Status: error`。現在改成：
  - `memory.db` 是壞檔時，`memory-status.md` 照常寫出；
  - 內容不出現 `Retrieval`、`memory.db`、`retrieval_db`；
  - 其他 snapshot 檔照常寫入（原有斷言保留）。
- 下面這些測試留著它們對 operational／archive 的斷言，只拿掉對 retrieval／consistency 的斷言，以及不再需要的 `writeRetrievalDb`／`writeCheckpoint` 呼叫：
  - `AC-3`：改名為「空的本機封存照樣讀取，統計是 0 而不是 null」；
  - `AC-5`（兩個）；
  - `AC-1：運作資料庫不存在時…`；
  - `AC-1／AC-2：運作資料庫…是 error`（兩個）；
  - `AC-1：運作資料庫可讀時…`：原名「兩個本機資料庫都可讀時…」。

### 刪除

刪除 10 個測試，它們只驗證被移除的區塊：
- `collectMemoryHealthReport reports cross-db consistency drift`
- `一致性稽核以 LIKE 預篩後，結果與逐列 regex 掃描等價`
- `AC-2：遠端模式的一致性三項都是 unsupported…`
- `AC-2／AC-4：遠端模式且沒有 checkpoint…`
- `AC-4：沒有 checkpoint 時兩項 checkpoint 檢查是 skipped…`
- `issue 0016 AC-1：回填來源判定分成六種狀態…`
- `issue 0016 AC-3：健康報告的 backfill 區塊…`
- `AC-1／AC-2：檢索資料庫不是 SQLite 檔時是 error…`
- `AC-1／AC-2：檢索資料庫不存在時是 unavailable…`
- `issue 0016 第二部分 AC-1：遠端模式的原因說明是正式的不支援…`

測試裡的輔助函式也一併整理：
- `withHealthEnv` 只給前兩個測試用，刪除；
- `writeCheckpoint` 刪除；
- `ARCHIVE_ENV_KEYS` 拿掉兩個回填變數；
- `writeRetrievalDb` 改名為 `writeLegacyMemoryDb`。

## 紅燈（實作前）

```text
$ env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test --test-name-pattern "issue 0022" tests/memory-health.test.ts
not ok 1 - issue 0022 SCN-007 健康報告只有運作資料庫與封存，memory.db 存在時不讀也不改
    + actual - expected
    +   'backfill',
    +   'consistency',
    +   'retrieval',
# fail 1

$ env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test --test-name-pattern "memory.db 不是 SQLite" tests/context-snapshots.test.ts
not ok 1 - AC-3：data/memory.db 不是 SQLite 時 memory-status 照常更新、不提它，其他檔案也都寫入
    The input was expected to not match the regular expression /Retrieval|memory\.db|retrieval_db/.
```

兩個失敗的原因都是報告還有被移除的區塊，也就是目標行為。

## 綠燈

- `tests/memory-health.test.ts` 加上 `tests/context-snapshots.test.ts`：`# tests 18`、`# pass 18`、`# fail 0`。
- `npm run build`：exit 0。
- 全套 `npm run test`：exit 0，`# tests 568`、`# pass 568`、`# fail 0`，`tests/` 下 72 個測試檔。
  - 和步驟 3 的 577 個相比：刪掉 10 個，新增 1 個。577 − 10 + 1 = 568。
- `npm run lint`：exit 0。
- `npx prettier --check`：改到的檔案都通過。

## 突變

| 突變 | 結果 |
|------|------|
| 在 markdown 的 operational 行後面加回 `- Retrieval DB Exists: false` | `not ok 3 - AC-3：data/memory.db 不是 SQLite…` 與 `not ok 18 - issue 0022 SCN-007…`，`# fail 2` |

突變後已還原。

## Web Console（SCN-008）

前端沒有測試框架，改用兩項檢查：

1. **靜態檢查**：`grep -rn -i backfill src/web/public` 沒有任何命中（exit 1）；`node --check` 檢查三個改過的 JS 檔，語法都正常。
2. **實跑**：以編譯後的 `dist/` 啟動 Web server。暫存 `APP_PROJECT_DIR`，`data/memory.db` 放一個非 SQLite 的舊檔，`memory-status.md` 由編譯後的 `collectMemoryHealthReport` 產生。輸出如下：

```text
memory keys: updated, archive_enabled, archive_source, archive_status, archive_detail, archive_db_exists, archive_total_sessions, archive_total_events, archive_last_session_at, archive_sessions_24h, archive_sync_failures_24h, archive_estimated_gap_recent_24h, operational_db_exists, operational_status, operational_detail, operational_total_messages, operational_total_schedules, operational_last_message_at, operational_model_responses_24h, operational_db, archive_db
backfill keys: 0
memory-health report keys: ok, timestamp, generatedAt, paths, operational, archive
backfill report status: 404
```

結論：`/api/status` 的 `memory` 物件沒有 `backfill_*` 鍵；Dashboard 的 backfill 警告依賴 `backfill_enabled`／`backfill_last_written`，程式與資料都已經不存在。

## 其他

- `tsc` 不會清掉已刪除來源的輸出，本機 `dist/` 原本還留著 `services/memory-backfill*.js` 與 `tools/memory-backfill-cli.js`，已手動刪除。映像不受影響：`.dockerignore` 排除了 `dist/`，`Dockerfile` 在 builder stage 會重新 `npm run build`。
- 刪除後，用 `grep -rn -E "memory-backfill|MemoryBackfill|MEMORY_BACKFILL_|resolveMemoryDbPath|BackfillCheckpoint|assessBackfillSource|currentArchiveSource|retrievalDb|consistency"` 掃 `src tests scripts package.json`，扣掉啟動警告本身之後沒有命中。

## 精煉

改動以刪除為主，留下的 operational／archive 程式維持原樣。這一步唯一新增的實作是 `orUnknown` 的參數型別從 `number | boolean | null` 縮成 `number | null`。沒有可再簡化的部分，記為 no-op，沿用上面的綠燈。
