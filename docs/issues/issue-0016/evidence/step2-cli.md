# 步驟 2：編譯後的 CLI 實跑（AC-3、AC-4）

- **日期**：2026-10-20
- **對應**：AC-3、AC-4
- **環境**：步驟 1 完成後的工作區，`npm run build` exit 0。以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB -u MEMORY_BACKFILL_ENABLED` 執行，`DB_DIR`、`MEMORY_BACKFILL_CHECKPOINT_FILE`、`MEMORY_BACKFILL_REPORT_FILE` 指向空的暫存目錄，也就是官方 Compose 的遠端模式。
- **完整輸出**：[step2-cli-output.txt](step2-cli-output.txt)（暫存路徑以 `<tmp>` 取代）。檔案裡每段的 `exit=` 是整條命令的結束碼；前三段接了管線（`| node -e`、`| grep`），所以是最後一個命令的結果，`memory:backfill` 本身的結束碼看第四段（exit 1）

| 命令 | 結果 |
|---|---|
| `node dist/tools/memory-health-cli.js --json` | exit 0；`archive.source=remote`、`status=unavailable`；`backfill.enabled=false`、`sourceState=remote-unsupported`，`sourceDetail` 說明是遠端模式（AC-3：回填沒啟用也顯示） |
| `node dist/tools/memory-health-cli.js`（markdown） | exit 0；有 `- Backfill Source State: remote-unsupported` 與 `- Backfill Source Detail: …` 兩行 |
| `node dist/tools/memory-backfill-cli.js once --json` | exit 1；`Error: memory backfill: 遠端 Memoria 模式：回填只讀本機的 sessions.db，目前不支援遠端封存`（AC-4） |

執行後暫存目錄只有 `data/`，沒有 checkpoint 或報告檔，`memory:backfill` 失敗時不寫 checkpoint 的行為不變。

worker 要在完整的 telenexus 服務裡才會啟動（需要 Telegram token），本步驟沒有實跑；它的預設判定在遠端模式下的行為由步驟 1 的「遠端模式用預設判定」測試涵蓋。
