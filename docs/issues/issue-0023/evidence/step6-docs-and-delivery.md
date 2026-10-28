# 步驟 6：文件與交付檢查

- 日期：2026-10-28

## 文件

- `CLAUDE.md`：
  - **Upstream 429 fail-fast**：補上額度用完的措辭、專用回覆與 `opencode:quota-exhausted` scope，`failure.kind` 不變；腳本的 `QUOTA_EXHAUSTED_PATTERN` 副本也要同步。
  - **Model health check**：補上額度用完最先判、立刻中止、簽章穩定，以及 `models:probe` 顯示 `⛔ 額度用完`、一般 429 不提早中止。
  - 原本寫「探針結束後一律刪 session」，修正為：stdout 沒有事件時（逾時、額度用完）取不到 session id（TBD-2）。
- `docs/configuration-reference.md`「Rate-limit 計數」：
  - `opencode:quota-exhausted` 不算進 `Rate-limit Issues (24h)`，要看 `Past 24h by Scope (persisted)`；
  - 健康檢查記成 `model-health:quota-exhausted`。
- `tests/fixtures/opencode/README.md`：已在步驟 1 加上新樣本那一列。

## 交付檢查

- `npm run build`：exit 0。
- `npm run lint`：exit 0。
- `npx prettier --check CLAUDE.md`：通過。docs 與 issue README 在 main 上原本就不符合 prettier，本次沒有改格式。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test`：exit 0，`# tests 618`、`# pass 618`、`# fail 0`。
  - `tests/` 下有 76 個測試檔，main 有 73 個。新增的三個是 `opencode-quota-exhausted`、`opencode-quota-failfast`、`model-health-quota`。
  - 本 issue 新增 29 個測試：步驟 2 有 15 個，步驟 3 有 4 個，步驟 4 有 7 個，步驟 5 有 3 個。main 的 589 加 29 就是 618，數字對得上。

## 沒有做的驗證

- 沒有在正式部署跑新版本。正式部署仍是 v2.32.0，升級由使用者決定。
- 子程序測試用的是步驟 1 擷取的真實 stderr，加上假的 `opencode`。
