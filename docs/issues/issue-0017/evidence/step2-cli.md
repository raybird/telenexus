# 步驟 2：編譯後的 CLI 實跑（AC-1）

- **日期**：2026-10-20
- **對應**：AC-1（同時看得到 AC-2、AC-4 的欄位）
- **程式**：分支 `fix/issue-0017-memory-health-source` 的工作區（基準 `e69ca9b` 加上步驟 1 的修改），`npm run build` exit 0。
- **方法**：每種設定用一個空的暫存 `DB_DIR` 與 checkpoint 路徑，以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 清掉主機 shell 的設定，各跑一次 `node dist/tools/memory-health-cli.js --json` 與不帶 `--json` 的 markdown。repo 的 `.env` 只設定了 `DB_DIR`，已由明確指定的值覆蓋（dotenv 不覆寫已存在的變數）。
- **原始輸出**：[step2-cli-output.txt](step2-cli-output.txt)，暫存目錄與 repo 路徑已換成 `<tmp>`、`<repo>`。

## 結果

四次執行都是 exit 0。

| 欄位 | 不設定封存變數 | `MEMORIA_ARCHIVE_DB` 指向不存在的檔案 |
|---|---|---|
| `archive.source` | `remote` | `local` |
| `archive.status` | `unavailable` | `unavailable` |
| `archive.detail` | 遠端 Memoria 模式：封存在 memoria 服務的 volume，本服務不讀取 | 找不到 MEMORIA_ARCHIVE_DB 設定的封存路徑 |
| `totalSessions`／`totalEvents`／`sessions24h`／`lastSessionAt`／`estimatedGapRecent24h` | 全部 `null` | 全部 `null` |
| markdown 的這些欄位 | `unknown` | `unknown` |
| `consistency.ok` | `null`（markdown `unknown`） | `null`（markdown `unknown`） |
| `consistency.checks` | orphan `unsupported`；兩項 checkpoint `skipped`（沒有 checkpoint） | 同左 |

暫存 `DB_DIR` 是空的，所以這裡看不到 issue 概述裡「17 則模型回應造成的假缺口」。那個情境（近 24h 有模型回應而封存讀不到）由步驟 1 的 AC-1 單元測試覆蓋：`modelResponses24h=1` 時 `estimatedGapRecent24h` 是 `null`。
