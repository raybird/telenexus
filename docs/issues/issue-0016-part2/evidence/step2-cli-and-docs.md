# 步驟 2：編譯後實跑與文件（AC-1、AC-3）

- **日期**：2026-10-21
- **環境**：`npm run build` 之後執行。
  - 用 scratchpad 的暫存目錄當 `DB_DIR`，`MEMORY_BACKFILL_CHECKPOINT_FILE` 也指到暫存目錄。
  - 以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 去掉兩個封存變數，也就是遠端模式。

## CLI

| 命令 | exit | 輸出 |
|---|---|---|
| `node dist/tools/memory-backfill-cli.js once --json` | 1 | `Error: memory backfill: 遠端 Memoria 模式不支援回填：回填只讀本機的 sessions.db（MEMORIA_ARCHIVE_DB 或 MEMORIA_HOME 指向的檔案），請把 MEMORY_BACKFILL_ENABLED 設為 false`；暫存目錄沒有寫出 checkpoint |
| `node dist/tools/memory-health-cli.js` | 0 | `- Backfill Source State: remote-unsupported`；`- Backfill Source Detail:` 後面是同一句 |
| `node dist/tools/memory-health-cli.js --json` | 0 | `backfill.sourceState` 是 `remote-unsupported`，`backfill.sourceDetail` 是同一句 |

`memory:backfill` 失敗退出的方式（未捕捉的 throw、exit 1）和第一部分相同，只有訊息換了。

## 文件

- `docs/configuration-reference.md` 的回填段落寫明了以下幾點：
  - 回填只適用於本機 `sessions.db` 的部署；
  - 遠端模式正式不支援，不是暫時的限制；
  - 原因是 Memoria 沒有可分頁、可 checkpoint 的 session 列出 API；
  - 不建議共享 Memoria 可寫的 `sessions.db`；
  - 遠端部署保持 `MEMORY_BACKFILL_ENABLED=false`；
  - 開了的話，worker 啟動時 warn 一次，每輪照印 skipped，CLI 會失敗退出，健康報告的狀態是 `remote-unsupported`。
- `.env.example` 的回填區塊加了一行註解。
- 以 `grep -rn "目前不支援\|不支援遠端封存" docs/*.md .env.example src` 檢查：沒有結果。
- `docs/configuration-reference.md` 在 main 上本來就有 Prettier 警告，這次沒有重排整份檔案。
