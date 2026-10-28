# 步驟 3：交付檢查

- 日期：2026-10-28

## 文件

| 檔案 | 更新 |
|------|------|
| `ARCHITECTURE.md` | `src/main.ts` 的釘選接線；新增 `src/services/pinned-status.ts` 條目 |
| `CLAUDE.md` | Key Modules 表的 `pinned-status-manager.ts` 一列 |
| `docs/configuration-reference.md` | 「Pinned 狀態訊息」：補上原本漏寫的 `request_error` 事件、定期更新，以及 `Recent errors (24h)` 的計算方式與舊版差異 |

`README.md` 的「釘選訊息即時顯示模型、排程數、異常數」仍然正確，沒有改。

`npx prettier --check CLAUDE.md ARCHITECTURE.md` 通過。`docs/configuration-reference.md` 在 main 上本來就不符合 prettier，只動了既有清單裡的三行，沒有重排整份檔案。

## 驗證

| 命令 | 結果 |
|------|------|
| `npm run build` | exit 0 |
| `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` | exit 0，`# tests 587`、`# pass 587`、`# fail 0` |
| `npm run lint` | exit 0 |

測試數與測試檔數相稱：`tests/` 下 73 個測試檔，v2.33.0 是 72 個檔、578 個測試，本 issue 新增 1 個檔、9 個測試。`tests/docker/` 也有跑到，例如 `ok 71 - release compose differs from dev compose only in build: vs image:`。

本 issue 沒有改 `scripts/install.sh` 與升級流程，不需要 `npm run test:installer`。
