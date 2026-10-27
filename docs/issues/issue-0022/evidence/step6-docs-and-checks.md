# 步驟 6：文件與交付檢查（SCN-009）

- 日期：2026-10-27

## 文件改動

| 文件 | 改動 |
|------|------|
| `docs/configuration-reference.md` | 「Sessions archive / memory backfill」整段改寫成「已退役：mcp-memory-libsql 與記憶回填」：退役原因、停用條目的作用、既有檔案原地保留、升級不需要手動步驟、想保留 MCP 時 `OPENCODE_CONFIG_CONTENT` 的完整寫法、另一台部署升級前的唯讀檢查命令。開頭的 MCP 說明補上停用條目一行；ErrorAlerter 的 scope 範例拿掉 `memory-backfill:worker` |
| `.env.example` | 拿掉 `MEMORY_BACKFILL_*` 區塊，換成兩行退役註解；`MEMORIA_ARCHIVE_DB` 的註解原本說「讓 memory backfill 直接讀」，改成「讓記憶健康報告直接讀」，因為健康報告仍會讀封存 |
| `.env.production.example` | 拿掉 `MEMORY_BACKFILL_*` 區塊，換成同樣兩行退役註解 |
| `docs/web-console-reference.md` | API 清單拿掉 `/api/memory-backfill/report`；memory-status 的說明拿掉 retrieval、一致性、`backfill.sourceState` 與 Recent Backfill Runs，運作資料庫一段改成單獨描述；另加一行，說明報告只剩兩個區塊、端點回 404 |
| `docs/installation.md` | 「升級」底下新增「mcp-memory-libsql 與記憶回填退役（issue 0022）」，內容是不需要手動步驟、什麼原地保留，並指向設定參考 |
| `docs/runtime-boundary-and-security.md` | `memory-status.md` 的描述改成「運作資料庫與 Memoria 封存」；問題判讀拿掉 `memory.db` |
| `ARCHITECTURE.md` | 模組清單把 `memory-backfill-worker.ts` 換成 `memory-health.ts`，附退役說明；擴充建議拿掉「backfill 驗證」 |
| `CLAUDE.md` | Common Commands 拿掉兩個 `memory:backfill:` 命令 |
| `docs/README.md` | 操作索引拿掉兩個回填命令；歷史文件清單的 `sessions-db-backfill-implementation-plan.md` 標上「已退役，issue 0022」 |

`project.md` 常青文件表裡的其他文件都掃過，沒有相關字樣：`README.md`、`CONTRIBUTING.md`、`ai-config.example.yaml`、`docs/summary-aware-retrieval-plan.md`、`docs/current-chat-prompt.md`、`docs/scheduler-operation-runbook.md`。

### 檢查命令的驗證

文件裡「升級前確認有沒有在用」的命令，在本機正式部署上執行過一次。執行方式是 `docker compose exec`，只用 `readonly` 連線讀 opencode.db：

```text
{ calls: 0, last: null }
```

同一條連線用 `bash%` 當對照，數到 2917 次呼叫。這證明查詢確實讀到 tool part，`0` 不是查詢寫錯造成的。

第一版命令把 SQL 寫在 `node -e '…'` 裡，字串用雙引號。better-sqlite3 會把雙引號當成識別字，所以改成 heredoc，字串一律用單引號，文件也寫明了這一點。

## SCN-009 逐項對照

| 條件 | 位置 |
|------|------|
| 寫明 mcp-memory-libsql 與回填已退役 | `configuration-reference.md` 退役段落第一段；`web-console-reference.md`；`installation.md`；`.env.example` |
| `data/memory.db` 原地保留、升級不需要手動步驟 | `configuration-reference.md`「既有檔案」與「升級不需要手動步驟」；`installation.md` |
| 另一台部署升級前的檢查方式 | `configuration-reference.md`「升級前確認有沒有在用」 |
| 想保留 MCP 時怎麼在 `OPENCODE_CONFIG_CONTENT` 設定 | `configuration-reference.md` 的 env 範例。範例條目和 v2.32.0 repo 的舊設定相同；步驟 2 的 SCN-003 測試證明 inline 自訂條目會原樣保留 |
| 文件沒有留下回填的設定說明與 npm scripts | 下方 grep |

## grep 常青文件

```bash
git ls-files '*.md' '*.example' '*.yml' '.env*' | grep -v -E "^(docs/issues/|CHANGELOG|workspace/)" \
  | xargs grep -n -E "MEMORY_BACKFILL_|memory:backfill:"
```

命中分成兩類。

**退役說明本身**，這些是刻意寫的：

- `docs/configuration-reference.md`（2 行）
- `docs/installation.md`（1 行）

**歷史文件**，依 `project.md` 維持原樣：

- `docs/2026-08-16-runtime-resource-handover.md`
- `docs/migration-log.md`
- `docs/sessions-db-backfill-implementation-plan.md`

另外兩份歷史文件有提到 `memory.db` 或 backfill，但沒有命中上面兩個樣式，同樣維持原樣：

- `docs/memory-system-analysis-2026-03-30.md`
- `docs/memory-v3-architecture-plan.md`

`memory:backfill-summary-metadata` 是 SAR summary metadata 的回填，和本 issue 無關，所以保留。它不會命中 `memory:backfill:`。

## 交付檢查

- `npm run build`：exit 0。
- `npm run test`（以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行）：exit 0，`# tests 569`、`# pass 569`、`# fail 0`，`tests/` 下有 72 個測試檔（L-01）。
  - 步驟 4 後是 568 個，加上步驟 5 的靜態測試，一共 569 個。
  - v2.32.0 是 598 個。差異如下：刪掉 28 個回填測試和 10 個健康報告測試，新增 9 個（步驟 2 兩個、步驟 3 五個、步驟 4 一個、步驟 5 一個）。598 − 38 + 9 = 569。
- `npm run lint`：exit 0。
- `npm run test:installer`：exit 0。
- `npx prettier --check`：
  - `configuration-reference.md` 與 `installation.md` 在 main 上本來就不符合 Prettier，原因是既有的表格對齊；
  - 這次新增的段落已經補到符合，剩下的差異都是既有內容，不在本 issue 範圍內；
  - 其他文件都通過。

## 去敏（L-10）

`grep -rn -E "/home/|<使用者名稱>|<email>|<bot token 樣式>|ALLOWED_USER_ID=<數字>" docs/issues/issue-0022`：沒有命中。

證據檔記錄的內容只有這幾類：
- 暫存目錄裡的假資料；
- 容器內的路徑（`/app`、`/tmp/probe`）；
- 呼叫次數。

正式部署的 `memory.db` 與對話內容沒有寫進 repo。

## 精煉

這一步只改文件，沒有程式可以精煉，記為 no-op。
