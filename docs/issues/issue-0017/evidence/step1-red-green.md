# 步驟 1：報告的來源、狀態與一致性判定（AC-1～AC-5）

- **日期**：2026-10-20
- **對應**：AC-1、AC-2、AC-3、AC-4、AC-5
- **環境**：分支 `fix/issue-0017-memory-health-source`，基準 `e69ca9b`，工作區未提交；Node.js v22.20.0、tsx v4.21.0。
- **測試**：`tests/memory-health.test.ts` 新增 7 個測試（AC-5 以兩種讀取失敗各跑一次），既有 2 個測試不動。

## 層級選擇：單迴圈合併

三個出口（CLI、`GET /api/memory-health`、`memory-status.md`）都直接輸出 `collectMemoryHealthReport()` 的物件，或交給 `formatMemoryHealthMarkdown()` 原樣格式化，不會再加工任何欄位。所以測試這兩個函式，就是測試操作人員實際看到的內容，沒有另一層會改變結果的整合責任，外迴圈與單元測試因此合併。CLI 的實跑留在步驟 2，用來確認編譯後的入口沒有其他差異。

## 0. 改動前的影響分析

2026-10-20 改 `src/services/memory-health.ts` 前執行（審查 SHOULD FIX 2 指出原本沒有記錄，2026-10-20 補記）：

- `gitnexus_impact`（upstream）：`collectMemoryHealthReport` 風險 LOW，直接呼叫者 3 個（`startWebServer`、`writeContextSnapshots`、`memory-health-cli.ts`）；`collectConsistencyReport` 風險 LOW，唯一直接呼叫者是 `collectMemoryHealthReport`；`formatMemoryHealthMarkdown` 風險 LOW，但只回報 `memory-health-cli.ts` 一個呼叫者。
- `grep -rn "collectMemoryHealthReport\|formatMemoryHealthMarkdown" src tests scripts`：`formatMemoryHealthMarkdown` 另有 `src/services/context-snapshots.ts:159`，impact 漏報（與 project.md「GitNexus impact 會低報呼叫者」一致），以 grep 為準。三處呼叫端都原樣輸出報告：`src/web/server.ts:2017` 直接 `sendJson`、`context-snapshots.ts:159` 與 `memory-health-cli.ts:19` 交給 `formatMemoryHealthMarkdown()` 或 `JSON.stringify`。
- 前端 `src/web/public/app/services/status-service.js:9` 的 `getMemoryHealth()` 沒有呼叫端；`skills/`、`scripts/` 沒有讀這份報告。三個函式的名稱與簽名不變，呼叫端不必修改。

## 1. 紅燈

命令：`npx tsx --test tests/memory-health.test.ts`，exit 1，`# tests 9`、`# pass 2`、`# fail 7`。

| 測試 | 失敗原因 |
|---|---|
| AC-1 遠端模式 | `archive.source` 預期 `'remote'`，實際不存在 |
| AC-1 設定的路徑不存在 | `archive.source` 預期 `'local'`，實際不存在 |
| AC-2 遠端一致性 | `consistency.checks` 預期三項 `unsupported`，實際不存在 |
| AC-3 空封存 | `archive.source` 預期 `'local'`，實際不存在 |
| AC-4 沒有 checkpoint | `consistency.checks` 預期含 `skipped`，實際不存在 |
| AC-5 內容不是 SQLite | `collectMemoryHealthReport()` throw `file is not a database` |
| AC-5 缺少 sessions 表 | `collectMemoryHealthReport()` throw `no such table: sessions` |

既有的 `reports cross-db consistency drift` 與 LIKE 預篩等價測試通過。

AC-1～AC-4 的紅燈停在新欄位不存在的斷言，看不出舊判定本身錯在哪裡，所以另外用 [step1-scripts/old-vs-new-probe.mts](step1-scripts/old-vs-new-probe.mts) 在**舊程式**（`git stash` 暫存本次修改）上，以和 AC-2、AC-3 相同的資料印出判定結果：

```text
AC-2 remote      {"archive":{"exists":false,"totalSessions":0,"estimatedGapRecent24h":0},"consistency":{"ok":true,"sourceSessionTaggedObservations":1,"orphanSourceSessionObservations":0,"observationsMissingSourceSession":0,"checkpointAheadOfArchive":false,"checkpointSessionMissing":false}}
AC-3 empty local {"archive":{"exists":true,"totalSessions":0,"estimatedGapRecent24h":0},"consistency":{"ok":true,"sourceSessionTaggedObservations":1,"orphanSourceSessionObservations":0,"observationsMissingSourceSession":0,"checkpointAheadOfArchive":false,"checkpointSessionMissing":false}}
```

兩種情況都回報 `ok=true`、orphan 0，checkpoint 指向不存在的 session 也沒發現，就是 issue 描述的問題。

## 2. 最小實作後全綠

修改 `src/services/memory-health.ts`：

- 新增 `readArchive()`：判定來源，並在同一條連線讀出統計與 session ID 清單；讀取失敗時回傳 `error` 與錯誤訊息，不 throw，也不記 runtime issue。
- `collectConsistencyReport()` 依封存讀取狀態給出每一項檢查的狀態，`size > 0` 的條件改成「封存有讀到」。
- markdown 新增來源、狀態、原因與三項檢查狀態的欄位，`null` 顯示為 `unknown`。

命令同上，exit 0，`# tests 9`、`# pass 9`、`# fail 0`。`npx tsc --noEmit -p .` 無輸出。

同一份 probe 在新程式上的結果：

```text
AC-2 remote      {"archive":{"exists":false,"totalSessions":null,"estimatedGapRecent24h":null},"consistency":{"ok":null,"checks":{"orphanSourceSession":"unsupported","checkpointSession":"unsupported","checkpointAhead":"unsupported"},"sourceSessionTaggedObservations":1,"orphanSourceSessionObservations":null,"observationsMissingSourceSession":0,"checkpointAheadOfArchive":null,"checkpointSessionMissing":null}}
AC-3 empty local {"archive":{"exists":true,"totalSessions":0,"estimatedGapRecent24h":0},"consistency":{"ok":false,"checks":{"orphanSourceSession":"checked","checkpointSession":"checked","checkpointAhead":"checked"},"sourceSessionTaggedObservations":1,"orphanSourceSessionObservations":1,"observationsMissingSourceSession":0,"checkpointAheadOfArchive":true,"checkpointSessionMissing":true}}
```

## 3. 重構後全綠

code-simplify：`checkpointSessionMissing` 原本是兩層三元式，`checkpointAheadOfArchive` 是先宣告 `let` 再分支賦值，兩者改成同一種寫法，並在註解說明 `archiveSessionIds` 只有在封存讀到時才不是 `null`。語意不變。之後執行 `npx prettier --write` 格式化兩個檔案。

命令同上，exit 0，`# tests 9`、`# pass 9`、`# fail 0`；`npx tsc --noEmit -p .` 無輸出。
