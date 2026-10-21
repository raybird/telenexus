# 步驟 3：交付檢查

- **日期**：2026-10-21

## 編譯後的程式實跑

`npm run build` 之後，用一支 scratchpad 裡的腳本直接載入 `dist/` 的 `MemoryManager`、`startRecallMetricsStore`、`MemoriaRecallClient`、`writeContextSnapshots`，對假 Memoria 服務做 25 次召回。假服務的規則：
- 第 7、14、21 次回 HTTP 500；
- 其餘每第 3 次回 `confidence=0.1`，低於門檻；
- 其他回 `0.5`。

暫存的 `APP_PROJECT_DIR` 與 `DB_PATH` 下跑了兩個程序：

| 程序 | 做什麼 | 結果 |
|---|---|---|
| 第一個 | 召回 25 次，寫 snapshot | exit 0 |
| 第二個（模擬重啟） | 不召回，只寫 snapshot | exit 0 |

第二個程序產生的 `memoria-status.md`：

```
## Recall Metrics by Version

- 保留 30 天；比例只計成功的召回，成功少於 20 次時顯示 unknown

### Current Version: 2.31.0
- Recalls: 25（成功 22、失敗 3）
- Hit Rate: 100.0% (22/22)
- Injected Rate: 68.2% (15/22)
- Degraded Rate: 0.0% (0/22)

### Previous Version
- (保留期內沒有其他版本的資料)
```

資料庫裡是 25 筆：成功 22、注入 15、因信心過低丟棄 7，和假服務的規則相符。第二個程序沒有召回，仍讀得到這些資料，所以指標跨重啟保留。log 裡沒有 `[recall-metrics]` 的 warn。

## 交付檢查（提交前的工作區）

- `npm run build` exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0：`# tests 574`、`# pass 574`、`# fail 0`。比 #18 結束時的 558 多 16 個，就是本 issue 新增的測試數；`tests/` 下 72 個測試檔，`tests/docker/` 的 4 個檔案都出現在輸出中（地雷 L-01）。
- `npm run lint` exit 0；異動與新增的 TypeScript 檔都通過 `prettier --check`。
- 文件：`docs/web-console-reference.md` 補上這一節的判讀；`docs/configuration-reference.md` 在召回設定下補上資料表、保留期與寫入失敗的行為。
