# 步驟 4：健康檢查（SCN-003，含 SCN-007 對照）

- 日期：2026-10-28
- 改動：`src/services/model-health-check.ts`
  - `FailureCategory` 加 `quota-exhausted`
  - `classifyFailure()` 與 `interpretProbeOutput()` 最先判額度用完；訊息只取主代理 `error.error` 裡的上游那句（`quotaExhaustedMessage()`）
  - `defaultProbe()` 的 stderr 一出現額度用完，就 `terminateProcessTree(child)` 並結束
  - 告警文字加 `quota-exhausted` 分支
- 新檔：`tests/model-health-quota.test.ts`

## 影響分析

- `gitnexus_impact`（repo telenexus）：`interpretProbeOutput`、`defaultProbe` 都回報 LOW，0 個上游。這和實際不符（GitNexus 的 impact 會漏報呼叫者，先前的 issue 已遇過），所以另外用 grep 查：
  - `defaultProbe` 是 `startModelHealthCheck` 的預設 probe；`main.ts` 與 `runner.ts` 各啟動一次，runner 不推播。
  - `interpretProbeOutput`、`classifyFailure` 只有 `defaultProbe` 和測試使用。
- 比對 `FailureCategory` 的分支（`grep -rn "'rate-limited'\|'client-outdated'\|category ===" src`）只在 `model-health-check.ts`：
  - `buildAlertText()` 的各類別分支已補上 `quota-exhausted`；
  - `failureSignature()` 只特判 `rate-limited`，額度用完沿用一般規則（類別＋訊息前段）；
  - runtime issue scope 是 `model-health:${category}`，會自動變成 `model-health:quota-exhausted`。
- `gitnexus_detect_changes`（unstaged）：變更只在 `model-health-check.ts` 一個檔，受影響流程都是 `defaultProbe` 與 `startModelHealthCheck` 的 runOnce 路徑。

## 紅燈（最小實作前）

`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/model-health-quota.test.ts`，exit 1：

```text
not ok 1 - issue 0023 SCN-003 額度用完判成 quota-exhausted，訊息是上游那句
not ok 2 - issue 0023 SCN-003 額度用完的行重複出現時，不被數成限流
ok 3 - issue 0023 SCN-007 一般 429 的判定不變
ok 4 - issue 0023 SCN-003 每次探測都是同一個故障簽章，只在提醒間隔後提醒
not ok 5 - issue 0023 SCN-003 Telegram 告警說明額度用完與處置方向
not ok 6 - issue 0023 SCN-003 defaultProbe 看到額度用完就結束，不等到逾時
ok 7 - issue 0023 SCN-007 defaultProbe 遇到一般 429 不提早中止
# tests 7
# pass 3
# fail 4
```

- 1、2：類別是 `rate-limited`，不是 `quota-exhausted`。
- 5：告警走 `rate-limited` 分支，沒有「opencode 免費額度已用完」。
- 6：探針等到逾時。
- 3、7：一般 429 的對照（SCN-007），先綠。
- 4（簽章穩定）先綠：實作前會被歸成 `rate-limited`，那個類別的簽章本來就不看訊息。這條擋的是實作後簽章帶進易變欄位，由 H6、H7 證明。

## 綠燈

同一命令：`# tests 7`、`# pass 7`。加上既有的 `tests/model-health-*.test.ts` 共 `# tests 60`、`# pass 60`。

## 突變

| 突變 | 結果 |
|------|------|
| H1：探針看到額度用完不中止 | 6 轉紅 |
| H2：`interpretProbeOutput()` 不先判額度用完 | 1、2 轉紅 |
| H3：訊息取整段輸出 | 1 轉紅 |
| H4：告警沒有 `quota-exhausted` 分支 | 5 轉紅 |
| H5：探針遇到一般 429 也中止 | 7 轉紅 |
| H6：額度用完的簽章每次都不同 | 4、5 轉紅 |
| H7：訊息取整段輸出，且簽章不去除易變欄位 | 1、4 轉紅 |

- 第一次跑 H5 時，`re.sub` 把替換字串裡的 `\&` 寫進程式，整個檔案無法載入。那次的「轉紅」無效，改用字串取代重跑，上表是重跑的結果。
- 第一次跑 H6 時，亂數接在訊息後面，被簽章的 120 字截斷切掉了，突變沒有生效。改把亂數放在前面重跑。
- 每個突變後都還原檔案並以 `cmp` 確認，還原後全綠。

## 限制

額度用完時 stdout 沒有任何事件，`findProbeSessionId()` 取不到 session id，所以探針建立的 session 不會被刪掉，要等保留期清理（預設 30 天）。探針逾時的既有路徑也一樣。session id 其實在 stderr 的 `session.id=` 欄位裡，但改從 stderr 取不在核准範圍內，已記為 README 的 TBD-2。健康檢查在正式部署已暫停（`MODEL_HEALTH_CHECK_ENABLED=false`），目前不會累積。

## 其他檢查

- `npm run build`、`npm run lint`：exit 0。
- `npx prettier --check`：兩個檔都通過。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test`：exit 0，`# tests 615`、`# pass 615`、`# fail 0`。

## 精煉

`classifyFailure()` 與 `interpretProbeOutput()` 各判一次額度用完：
- 前者是匯出的分類函式，只回類別；
- 後者要組訊息，而且必須在 error 事件與限流計數之前判斷。

兩者沒有可合併的重複。記為 no-op。
