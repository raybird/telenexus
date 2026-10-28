# Issue 0023 - opencode 免費額度用完時快速失敗，並說清楚原因

GitHub：[#23](https://github.com/raybird/telenexus/issues/23)

## 文件清單
- [implementation-plan.md](./implementation-plan.md)

## 概述

opencode 免費層的用量額度用完時，上游每一次呼叫都回 `Free usage limit reached`。TeleNexus 認不得這句，所以聊天、排程和健康檢查都重試到逾時才失敗，告警也只顯示 `unknown` 或 `task-timeout`。

2026-10-28 在正式部署（v2.32.0、opencode 1.18.34、`opencode/big-pickle`）發現：
- 從 2026-10-27 09:00 UTC 起，opencode log 每一次呼叫都是 `level=ERROR message="stream error" … small=false agent=build … error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"`。
- 額度是整個帳號共用的：同時探測 `opencode/glm-5.3-flash-free`、`opencode/deepseek-v4.1-flash-free`，也是同一句。
- 到 2026-10-28 10:30（台北），排程有 13 次跑滿 30 分鐘才失敗，健康檢查有 18 次跑滿 120 秒逾時。

已確認的現況：
- 快速失敗靠 `src/core/rate-limit.ts` 的 `UPSTREAM_RATE_LIMIT_PATTERN`。它在 opencode 1.18 的分支只看主代理（`small=false`）那一行的 `error.error="AI_APICallError: …"`，而且只認 `Too Many Requests`、`rate limit`、`quota`、`429`。
- 非串流（`src/core/opencode.ts` 的 `abortOnStderr`）與串流（`src/core/cli-agent-base.ts` 的 `rateLimitPattern`）共用這個樣式。命中時中止子程序，回傳 `failure.kind = 'rate-limit'` 與固定訊息「⏳ Opencode 上游配額已達上限 (HTTP 429)…」，並記錄 runtime issue `opencode:rate-limit`。
- 健康檢查（`src/services/model-health-check.ts` 的 `defaultProbe()`）沒有中途中止：跑到逾時就回 `unknown`，不看 stderr。
- `scripts/probe-models.mjs` 有一份相同的 regex 副本，`tests/probe-models-script.test.ts` 要求兩份字串一致。
- 排程（`src/core/scheduler.ts`）只拿到回覆文字。限流這類降級結果會正常 resolve，所以排程把那段說明當成結果送到 Telegram、記 `schedule_done`、寫進記憶，只有真正 throw（例如逾時）才記 `schedule_fail`。429 現在就是這樣，額度用完沿用這個行為。
- runtime issue 記在實際執行 opencode 的服務。正式部署的聊天與排程都走 agent-runner（`CHAT_USE_RUNNER_PERCENT=100`），而 runner 沒有 `IssueStore` 與 `ErrorAlerter`，所以 telenexus 的 `error-summary.md` 看不到 runner 那邊的 `opencode:rate-limit`。這是既有限制，額度用完也一樣。使用者看得到的是回覆文字，以及 telenexus 的健康檢查告警。

**不在範圍內**：
- 其他上游的錯誤措辭。
- 斷路器與 `runner-audit.log` 的行為：沿用 `rate-limit` 這種失敗類型，兩者都不變。
- 排程把降級結果記成 `schedule_done` 並寫進記憶的既有行為（見上）。
- runner 的 runtime issue 不進 telenexus 觀測面的既有限制（見上）。
- 正式部署的 `MODEL_HEALTH_CHECK_ENABLED`：2026-10-28 依使用者指示暫時設成 `false`，要不要改回來由使用者決定。

## 快速導覽

### 當前流程
上游回 `Free usage limit reached` → 樣式不命中 → opencode 背景重試、stdout 空白 → 聊天與排程跑到 `OPENCODE_TASK_TIMEOUT_MS`／`SCHEDULE_TASK_TIMEOUT_MS`，記成逾時；健康檢查跑滿 120 秒，記成 `unknown`。

### 修正後流程
上游回同一句 → 樣式命中 → 約 1 秒內中止 → 聊天與排程回覆「免費額度已用完」，記錄 `opencode:quota-exhausted`；健康檢查立刻結束，告警寫明額度用完與處理方式。

## 關鍵差異

| 項目 | 變更前 | 變更後 |
|------|--------|--------|
| 聊天／排程 | 跑到逾時，回覆逾時訊息 | 約 1 秒內失敗，回覆額度用完的訊息 |
| runtime issue | `scheduler:task-timeout`、逾時 | `opencode:quota-exhausted` |
| 健康檢查 | 跑滿 120 秒，`unknown`，告警「無法確認模型可用性」 | 立刻結束，告警「免費額度已用完」 |
| `npm run models:probe` | `⛔ 逾時` | `⛔ 額度用完`，立刻結束 |
| 一般 429 | 快速失敗、訊息寫 HTTP 429 | 不變 |

## 涉及檔案

### 判定
- `src/core/rate-limit.ts` - 新增額度用完的樣式，併入快速失敗的樣式
- `scripts/probe-models.mjs` - 同步 regex 副本，新增「額度用完」判定並在命中時中止

### 聊天與排程
- `src/core/opencode.ts` - 非串流路徑命中時，依 stderr 選擇訊息與 runtime issue scope
- `src/core/cli-agent-base.ts` - 串流路徑同上

### 健康檢查
- `src/services/model-health-check.ts` - 新增 `quota-exhausted` 類別、stderr 命中時立刻結束探測、告警文字

### 觀測與文件
- `tests/` - SCN-001～008；`tests/fixtures/opencode/` 新增真實樣本
- `CLAUDE.md`（Upstream 429 fail-fast、Model health check）、`docs/configuration-reference.md`、`tests/fixtures/opencode/README.md`

## Gherkin 驗收劇本

```gherkin
Feature: opencode 免費額度用完時快速失敗並說清楚原因

  Background:
    Given 上游對主代理（small=false）的回應是 "AI_APICallError: Free usage limit reached. ..."
    And opencode 在 --print-logs 的 stderr 寫出這一行後持續背景重試

  @SCN-001
  Scenario: 聊天遇到額度用完，約 1 秒內失敗並說明原因
    When 使用者送出一則聊天（串流或非串流）
    Then opencode 子程序在 stderr 出現該行後就被中止，不等到 OPENCODE_TASK_TIMEOUT_MS
    And 使用者收到的回覆說明 opencode 免費額度已用完、同帳號的其他免費模型也會被擋，以及可以等額度恢復、訂閱 OpenCode Go 或換成其他 provider 的模型
    And 回覆不寫 HTTP 429
    And 執行 opencode 的服務記錄一筆 runtime issue，scope 是 opencode:quota-exhausted，取代 opencode:rate-limit
    And 這個回合的結果是失敗（failure kind 為 rate-limit，runner-audit.log 記 ok:false）

  @SCN-002
  Scenario: 排程遇到額度用完，不跑滿排程逾時
    When 排程任務觸發
    Then 任務在 stderr 出現該行後就結束，不等到 SCHEDULE_TASK_TIMEOUT_MS，不記成 scheduler:task-timeout
    And 使用者在 Telegram 收到這個排程的訊息，內容是 SCN-001 的額度用完說明，不是逾時訊息
    And 記錄的 runtime issue 是 opencode:quota-exhausted

  @SCN-003
  Scenario: 健康檢查遇到額度用完，立刻結束並告警
    When 模型健康檢查執行探測
    Then 探測在 stderr 出現該行後就結束，不等到 MODEL_HEALTH_CHECK_TIMEOUT_MS
    And 判定類別是 quota-exhausted，不是 unknown
    And Telegram 告警寫明「opencode 免費額度已用完」、同帳號的其他免費模型也會被擋，以及等額度恢復、訂閱 OpenCode Go 或換 provider
    And 之後每次探測都是同一個故障簽章，只依既有提醒間隔（MODEL_HEALTH_REMIND_MS）提醒，不每小時重新告警

  @SCN-004
  Scenario: models:probe 遇到額度用完，立刻結束並標示額度用完
    When 執行 npm run models:probe 探測一顆模型
    Then 該輪在 stderr 出現該行後就結束
    And 判定顯示為「⛔ 額度用完」，不是「⛔ 逾時」

  @SCN-005
  Scenario Outline: 認得 usage limit reached 的不同寫法
    Given 主代理那一行的 error.error 是 "AI_APICallError: <訊息>"
    When TeleNexus 判定這一行
    Then 判定為額度用完

    Examples:
      | 訊息 |
      | Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go |
      | Usage limit reached |
      | Monthly usage limit reached for this plan |

  @SCN-006
  Scenario Outline: 不在限定欄位內的同一串字不觸發
    Given stderr 只有 <行>
    When TeleNexus 判定這段輸出
    Then 不判定為額度用完，也不中止回合

    Examples:
      | 行 |
      | 標題代理（small=true）的 "AI_RetryError: Failed after 3 attempts. Last error: Free usage limit reached..." |
      | 不是 stream error 的 log 行裡出現 "usage limit reached" |
      | 正常回合的回覆文字或工具輸出裡出現 "usage limit reached" |

  @SCN-007
  Scenario: 一般 429 的行為不變
    Given 主代理那一行的 error.error 是 "AI_APICallError: rate limit exceeded" 或 "Too Many Requests"
    When 聊天、排程或健康檢查遇到它
    Then 仍然快速失敗，回覆沿用既有的「上游配額已達上限 (HTTP 429)」訊息，runtime issue 是 opencode:rate-limit
    And 健康檢查仍依既有規則判定：重試 RATE_LIMIT_DEGRADED_THRESHOLD 次以上才算 rate-limited，不因這次修改提早中止
```

## Gherkin 核准紀錄
- **核准 commit**: 待提交
- **核准來源**: 使用者於 2026-10-28 對話的逐題確認：
  - Q1「額度用完要怎麼歸類」選「快速失敗沿用限流，文字另寫（建議）」：內部走既有 rate-limit 的快速失敗路徑與 failure kind，斷路器與 runner-audit 行為不變；使用者訊息、runtime issue scope（`opencode:quota-exhausted`）與健康告警改成免費額度已用完、等恢復或訂閱／換 provider（SCN-001～003、SCN-007）。
  - Q2「要認哪些措辭」選「usage limit reached（建議）」：不分大小寫認 `usage limit reached`，仍只比對主代理 `small=false` 那一行的 `error.error` 欄位（SCN-005、SCN-006）。
  - Q3「健康檢查與 models:probe 遇到額度用完」選「看到就立刻中止並告警（建議）」：一般 429 的既有判定不變（SCN-003、SCN-004、SCN-007）。
  - 之後以一則總結確認推導出的行為 (a)～(c)，使用者選「全部照寫核准（建議）」：
    - (a) 聊天與排程的回覆文字：免費額度已用完、同帳號其他免費模型也會被擋、可等恢復／訂閱 OpenCode Go／換 provider，不寫 HTTP 429（SCN-001、002）；
    - (b) 排程沿用 429 的既有行為：說明當成排程結果送到 Telegram、記 `schedule_done`、寫進記憶（SCN-002，概述「不在範圍內」）；
    - (c) runtime issue 記在執行 opencode 的服務，runner 的 issue 不進 telenexus 觀測面是既有限制（SCN-001，概述「不在範圍內」）。

| Scenario | 核准日期 | 狀態 |
|----------|---------|------|
| SCN-001 | 2026-10-28 | 已核准 |
| SCN-002 | 2026-10-28 | 已核准 |
| SCN-003 | 2026-10-28 | 已核准 |
| SCN-004 | 2026-10-28 | 已核准 |
| SCN-005 | 2026-10-28 | 已核准 |
| SCN-006 | 2026-10-28 | 已核准 |
| SCN-007 | 2026-10-28 | 已核准 |

## 重構步驟概要
1. ⏳ **步驟 1** - 擷取真實樣本並確認現行樣式不命中（首要驗證）
2. ⏳ **步驟 2** - 判定樣式（SCN-005、006、007）
3. ⏳ **步驟 3** - 聊天與排程（SCN-001、002）
4. ⏳ **步驟 4** - 健康檢查（SCN-003）
5. ⏳ **步驟 5** - models:probe（SCN-004）
6. ⏳ **步驟 6** - 文件與交付檢查

## 風險與首要驗證

- **最大風險**：樣式誤判。快速失敗的樣式套用在每一次 opencode 呼叫上，比對範圍一旦太寬，就會中止正常的回合（[L-04](../../agents/landmines.md#l-04-錯誤樣式誤判一般文字)）；比對到的格式若和真實輸出不同，修了也不會生效（[L-03](../../agents/landmines.md#l-03-升級-opencode-釘版後判定悄悄失靈)）。
- **風險等級與理由**：Medium。改動集中在一個樣式與三條既有的快速失敗路徑，但每一輪聊天與排程都會經過；目前手上的樣本只有正式部署 log 裡的單行。
- **首要驗證**：在額度用完的期間，用 opencode 1.18.34 以 TeleNexus 相同的參數（`--format json --print-logs --log-level ERROR`）實跑一次，擷取完整的 stdout 與 stderr 存成樣本，確認現行樣式不命中、主代理行的格式和 log 相同，並記錄 stdout 有沒有 error 事件。
- **選擇理由**：判定與測試的期望值都來自這份樣本；先確認真實輸出，才知道要比對哪一行、哪個欄位。
- **完成證據**：`tests/fixtures/opencode/` 有真實樣本；證據檔記錄現行樣式不命中，以及主代理行與標題代理行各出現幾次。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | 額度恢復後，再擷取樣本就做不到；步驟 1 要在恢復前完成 | 待確認 | 步驟 1；若額度已恢復，改用正式部署 log 裡的真實行做樣本並揭露限制 |

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-28 | 不開 PR；改由獨立 subagent 在本機審查分支，PASS 且沒有要修的項目時以 `git merge --ff-only` 合併進 `main`，不推送、不發版 | 交付方式選「分支＋本機審查，PASS 後自動合併（建議）」 | 沒有 GitHub 上的 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-28 | 建立；逐題確認 Q1～Q3 與交付方式 | - |
| 2026-10-28 | SCN-001～007 核准；記錄不開 PR 的 Gate 豁免 | 使用者 |

---
**建立日期**: 2026-10-28  
**分級**: Medium  
**風險**: Medium\
**狀態**: 實作中
