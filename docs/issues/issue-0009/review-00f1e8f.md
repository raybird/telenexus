# 審查報告

- 範圍：完整交付範圍（本機獨立審查，未開 PR；第二輪，接續 [review-a64e97c.md](./review-a64e97c.md)）
- Reviewed BASE SHA：db05c0afde5d5ffc57fedea110612cbe1e1344a9（main）
- Reviewed HEAD SHA：00f1e8f49a9c9810e14ff92846f97b29f7350f9a
- Reviewed patch-id：eb6c8f32ce183a1eb01fcf8d845c95ac5f9a6559（以 `git diff db05c0a 00f1e8f | git patch-id --stable` 重算，與交付紀錄一致）
- 審查日期：2026-10-16
- 獨立 reviewer：Claude Code 獨立 subagent（general-purpose），非原實作者
- Review artifact：docs/issues/issue-0009/review-00f1e8f.md

本輪重點是上一輪 HEAD `a64e97c` 之後的 4 個提交：

- `0cd0f81`：只新增上一輪的報告，以 `--stat` 確認只有這一個檔案。
- `1bf6427`、`f2e9fce`：修訂 SCN-001，並回填核准 commit。
- `00f1e8f`：修正本身。

上一輪已經審過的部分，在新 HEAD 上重新核對了一次。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

**S1：步驟 7 的紅綠重構證據缺少重構段**

- 位置：`docs/issues/issue-0009/implementation-plan.md` 步驟 7 的證據段落。
- 問題：步驟 7 記錄了紅燈（25 個測試中 5 個失敗，原因都是缺少目標行為）、最小實作後全綠（33 個），以及專案 gate。但沒有記錄「重構後全綠」，也沒有寫「重構為 no-op」及理由。依 verification.md，四段缺一段就算證據不完整。
- 為何不阻擋：修正只有一個提交 `00f1e8f`。最小實作後的綠燈對應的就是最終狀態，本輪也在這個 HEAD 獨立重跑了 gate（481/481）。缺的只是一行聲明，行為證據本身沒有缺口。
- 建議：在步驟 7 補上「重構：no-op（理由…）」，或補記重構後的測試結果。

### NICE TO HAVE

- **N1**：`src/services/opencode-session-retention.ts:368-382`。回 `Session not found` 的 session 會被算進 `deleted`。如果某版 opencode 的 `session delete` 只在目前 project 內查找，一個實際存在、但在其他 project 的 session 也會回 not found。它會被當成刪除成功，卻一直佔著最舊的名額，清理就會在沒有 runtime issue 的情況下停住。目前的情況：容器內所有 session 的 `project_id` 都是 `global`；主機上 repo 與 `workspace/` 屬於同一個 git project，刪除命令的 cwd 也在 repo 根目錄，所以實際風險很低。建議在 log 裡另外記一個 `alreadyGone` 計數，讓這種停滯看得出來。
- **N2**：`src/services/opencode-session-retention.ts:178-185`。「全庫 5 分鐘內沒有更新」這個條件，前提是 opencode 在任務執行期間會持續更新 `session.time_updated`，這點沒有實測。如果另一個服務的單一工具呼叫超過 5 分鐘都沒寫入 session，VACUUM 仍可能在它執行中進行。依步驟 1 的實測（220 MB 的 VACUUM 不到 1 秒，opencode 的 `busy_timeout=5000`），影響有限。建議在 configuration-reference 寫明這個條件是推估。
- **N3**：在主機上，`VACUUM` 作用的是使用者全域的 `opencode.db`，不只 TeleNexus 的資料。它不改資料內容，而且門檻是 freelist 達總頁數的 20%，以目前範圍內只有 11 個 session 來看幾乎不會觸發。可以考慮在文件提一句。
- 上一輪的 N2（綁定數極大時查詢輸出會超過約 64 KB）：計畫寫明不處理及理由。理由成立：這種失敗看得到，也不會誤刪。

## 已查核維度

### 驗收與證據

| SCN | 證據位置 | 結論 |
| --- | --- | --- |
| SCN-001（修訂） | `tests/opencode-session-retention-run.test.ts`：用假 opencode 驗證 SQL 帶有 `time_updated is not null` 與 `directory in (...)`，路徑含單引號時會正確跳脫；`resolveRetentionDirectories` 的測試；步驟 7 對正式部署與主機資料庫的唯讀計數；步驟 6 的 e2e | 有效，詳見下方「M1 的修正」。 |
| SCN-002 | 同上一輪，程式沒有變動 | 仍有效 |
| SCN-003 | 同上一輪 | 仍有效 |
| SCN-004 | 同上一輪，`model-health-check.ts` 沒有變動 | 仍有效 |
| SCN-005 | 新增：刪除回 `Session not found` 時視為完成，其他錯誤仍然拋出（`ses_fail` 的案例） | 有效 |
| SCN-006 | 新增：全庫 4 分鐘前有更新時判為 `busy`，6 分鐘前時判為 `reclaimed`；`parseSpaceStats` 能解析 `latest_session_update`，也接受 null | 有效。限制見 N2。 |

**M1 的修正（目錄範圍）**

- 測試與程式實際使用的目錄一致：`resolveRetentionDirectories()` 取 `APP_PROJECT_DIR`（未設時用 cwd）與其下的 `workspace`。opencode 的實際執行目錄是 `getWorkspacePath()`，也就是 `${APP_PROJECT_DIR}/workspace`，未設時是相對路徑 `workspace`，以 cwd 解析。探針與刪除命令則在服務的 cwd 執行。compose 對兩個服務都設了 `APP_PROJECT_DIR=/app`。
- 反向自檢，兩個方向都成立：
  - 不會漏刪：正式部署 3,716 個頂層 session 全部落在 `/app`、`/app/workspace` 範圍內。如果目錄比對和 opencode 實際記錄的 `directory` 不一致，這個數字會小於總數。
  - 能擋住其他目錄：主機上的全域資料庫原本會刪 621 個，加上目錄條件後剩 11 個，都在本 repo 目錄。如果條件沒有生效，數字不會下降。
- 比對失效時的方向是安全的：比對不到只會少刪，不會多刪。
- 本 repo 目錄裡開發者自己開的 11 個 session 仍在範圍內。configuration-reference 有寫明，核准紀錄中選的範圍是「服務的專案目錄與其下的 workspace」，涵蓋這一點。

**SQL 跳脫**：`sqlString()` 把單引號加倍，這是 SQLite 字串常值的正確跳脫方式。測試用 `/srv/tele'nexus` 驗證過。目錄值來自服務自己的設定，SQL 經 argv 傳給 opencode，不經 shell。LIMIT 是數值運算的結果。沒有注入面。

**S1 的修正（兩個服務同時清理）**

- `Session not found` 的判斷只在錯誤是 `ProcessError` 而且 stderr 符合 `/Session not found/` 時才吞下。逾時、signal 與其他 exit 1 都照樣拋出（`ses_fail` 的案例）。`OPENCODE_SESSION_NOT_FOUND_PATTERN` 原本就是聊天接續用的同一個樣式，這次只是改成匯出，沒有改行為。
- 5 分鐘閒置與 `isIdle` 是 AND 關係，兩者都成立才回收：本服務的工作由 `isIdle` 擋下，另一個服務的工作由全庫更新時間推估。
- 文件已改成實際行為：runner 一律清理；telenexus 只在沒有 `RUNNER_ENDPOINT` 時清理；兩邊可能同時清理，`Session not found` 視為已刪除。`configuration-reference.md`、`ARCHITECTURE.md`、`CLAUDE.md`、`.env.example` 四處說法一致。

**規格修訂查核**

- `git diff a64e97c 00f1e8f -- README.md` 的 Gherkin 只有 SCN-001 實質改變。`1bf6427` 之後沒有再動 Gherkin。
- 核准來源：README 記錄 2026-10-16 逐題確認 Q1（審查），使用者選擇「只刪 TeleNexus 目錄下的」，與 TBD-4、Timeline 互相對應。我看不到原始對話，只能核對文件之間是否一致，結論是一致。
- 核准表與現存 Scenario 集合完全相等，全部為已核准。
- S1 的決策（TBD-5）沒有改變 Scenario 的語意，只是補強 SCN-005、SCN-006 的實作方式，不需要重新核准。

**假綠燈與同義反覆**：沒有發現。新的斷言都是寫死的字面值，包括完整的 SQL 字串與時間點，沒有用和實作相同的方式重算。紅燈的五個失敗都是缺少目標行為造成的斷言失敗。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
| --- | --- | --- | --- |
| 主機執行，資料庫裡有其他專案的 session | 不刪 | SQL 測試與主機唯讀計數（621→11） | 已修正 |
| 目錄字串與 opencode 記錄的不一致（尾斜線、symlink） | 少刪，不會誤刪 | `path.resolve` 正規化有測試；正式部署全部在範圍內 | 安全 |
| 目錄含單引號 | 正確跳脫 | 測試 | 正確 |
| 兩個服務同時刪同一個 session | 後刪的那一方視為完成，不記錯 | 假 opencode，輸出與真實 1.18.34 的 `Error: Session not found: <id>` 一致 | 正確，觀察性見 N1 |
| 其他刪除錯誤 | 照樣記 `opencode-retention:delete` | 測試 | 正確 |
| 另一個服務正在執行任務時回收 | `busy` | 測試（4 分鐘與 6 分鐘） | 正確，限制見 N2 |
| `max(time_updated)` 為 null（空資料庫） | 退回只看 `isIdle` | parse 測試；真實 opencode 在空資料庫上實測 | 正確 |
| `time_updated` 為 NULL 佔住名額（上一輪 N1） | 不會佔 | SQL 測試 | 已修正 |
| 上一輪的其他失敗面（狀態檔毀損、無權限、不存在、輸出截斷、排程、`isIdle`、探針、子程序生命週期、L-06） | 程式沒有變動 | 同上一輪 | 仍成立 |

### 需求、架構、安全、品質

- 仍然只經 opencode CLI 操作，沒有直接寫 opencode 的資料表。新增的查詢是唯讀的 `max(time_updated)`。
- `opencode.ts` 只把常數改成匯出，行為沒有變。新增的跨模組依賴（保留期服務 → `core/opencode.js`）是合理的共用。
- runtime issue 的 scope 沒有變。
- 上一輪的 N3、N4、N5 都已處理：文件寫明狀態檔不存在時的前提與 VACUUM 的磁碟需求；README 的涉及檔案補上 `execution-queue.ts` 與 `opencode.ts`；空間查詢不再取 `page_size`。
- 公開 repo：新的變更裡沒有主機家目錄、使用者 ID、token 或新的 session ID。步驟 7 只記彙總數字。提交訊息沒有 AI 署名。

### 豁免、待確認與限制

- Gate 豁免（README）：不開 PR，改由本機獨立審查。本報告依此豁免作為審查紀錄。
- 計畫檢查清單中「發版說明提醒」尚未勾選，屬於發版時的事項。發版說明除了「預設啟用」，也應寫明「只清理 TeleNexus 目錄」。
- 本輪沒有啟動容器，也沒有讀取任何 opencode 資料庫。正式部署與主機的唯讀計數採信步驟 7 的紀錄。
- 呼叫者以 grep 核對：`createOpencodeRetentionDeps` 只有 `main.ts`、`runner.ts` 與測試使用，兩個生產呼叫點都用預設的目錄；`OPENCODE_SESSION_NOT_FOUND_PATTERN` 用在 `opencode.ts` 原本的位置與保留期服務。

### 獨立重跑的 gate 結果

在 HEAD `00f1e8f` 執行，工作區乾淨：

| 命令 | exit code | 摘要 |
| --- | --- | --- |
| `npm run build` | 0 | 成功 |
| `npm run test` | 0 | `# tests 481`、`# pass 481`、`# fail 0`、`# cancelled 0`、`# skipped 0` |
| `npm run lint` | 0 | 無錯誤 |

`find tests -name '*.test.ts' | wc -l` 是 70，與 481 個測試相稱，比上一輪多了 2 個測試。抽查確認本輪新增的測試都在輸出中且為 `ok`：「共用資料庫裡最近 5 分鐘內…」「TeleNexus 的目錄是專案目錄…」「只查 TeleNexus 目錄下的 session…」。結果與步驟 7 記錄的 `# tests 481` 一致。

## 流程判定

**PASS**

- 上一輪的 M1 與 S1 已依使用者的決策（TBD-4、TBD-5）修正，修訂後的 SCN-001 有核准來源。
- 所有驗收與重要失敗面都有有效證據，沒有 MUST FIX。
- S1（步驟 7 缺重構段的聲明）與 N1～N3 不阻擋判定，建議在合併前或後續補上。
