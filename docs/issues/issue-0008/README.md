# Issue 0008 - opencode 被免費層以 426 拒絕且無告警：升釘版並結構化判定上游錯誤

GitHub：<https://github.com/raybird/telenexus/issues/8>

## 概述

映像釘的 `opencode-ai@1.15.10` 自 2026-09-17 起被上游免費層以 HTTP 426 拒絕，所有聊天與排程都沒有產出，而每一個觀測面都顯示正常。本 issue 做兩件事：升釘版讓服務恢復，以及把「上游回了錯誤事件」改成結構化判定，讓這類失效不論狀態碼是什麼都會被記為失敗並告警。

## 文件清單

- [implementation-plan.md](./implementation-plan.md)

## 快速導覽

### 當前流程

1. opencode 收到上游錯誤（410、426 等）時仍以 exit 0 結束，stdout 只有一個 `error` 事件。
2. `interpretEvent()` 不處理 `error` 事件，回合沒有文字輸出，被轉成「沒有任何輸出」的友善訊息後正常結束。
3. `opencode_done` 的 `upstreamInvalid` 由 stderr 比對樣式決定，樣式只認 410 與 model not found。426 沒命中，回合被當成真實成功。
4. 真實成功會讓模型健康檢查跳過探測；探測時 exit 0 且未命中樣式也判為健康。

### 重構後流程

1. `interpretEvent()` 辨識 `error` 事件，取出 `statusCode`、名稱與訊息。
2. 回合帶上「上游錯誤」的失敗種類：使用者看到含狀態碼的說明，runner audit 記為失敗，並寫入 runtime issue。
3. 有上游錯誤的回合不算真實成功，不會讓健康檢查跳過探測。
4. 健康檢查探針依錯誤事件判定，任何上游錯誤都視為不健康並告警。

## 關鍵差異

| 項目                   | 變更前                         | 變更後                                  |
| ---------------------- | ------------------------------ | --------------------------------------- |
| opencode 釘版          | 1.15.10（被免費層拒絕）        | 上游接受且經相容性驗證的版本            |
| 上游錯誤的判定依據     | stderr 文字比對特定狀態碼      | stdout 的 `error` 事件與其 `statusCode` |
| 426 這類未列舉的狀態碼 | 記為成功，成功率 100%          | 記為失敗，寫入 runtime issue            |
| 使用者看到的訊息       | 「Opencode 沒有任何輸出」      | 指出上游錯誤與狀態碼                    |
| 模型健康檢查           | 被假成功餵養而跳過，或判為健康 | 判為不健康並推播                        |

## 涉及檔案

```text
.
├── Dockerfile                          # 可改：opencode-ai 的釘版
├── src/core/opencode-event-parser.ts   # 可改：辨識 error 事件
├── src/core/opencode.ts                # 可改：非串流路徑的失敗判定、opencode_done 的旗標
├── src/core/cli-agent-base.ts          # 可改：串流路徑的失敗判定
├── src/core/agent-result.ts            # 可改：新增失敗種類
├── src/core/rate-limit.ts              # 可改：與結構化判定的分工
├── src/services/model-health-check.ts  # 可改：探針與真實成功的判定
├── scripts/probe-models.mjs            # 可改：與上面同步（CLAUDE.md 要求兩處一起改）
├── tests/                              # 可改：對應的測試與 fixture
├── CLAUDE.md                           # 可改：Observability 的相關段落
├── docs/configuration-reference.md     # 可改：有新增設定時
├── src/core/run-outcome.ts             # 不可觸及：斷路器不因上游錯誤觸發的語意維持
├── docker-compose.yml                  # 不可觸及
├── docker-compose.release.yml          # 不可觸及
└── .github/workflows/release.yml       # 不可觸及
```

## Gherkin 驗收劇本

```gherkin
Feature: 上游錯誤被如實判定，服務在升版後恢復

  @SCN-001
  Scenario: 上游回錯誤事件的回合被判為失敗
    Given opencode 以 exit 0 結束，stdout 只有一個帶 statusCode 426 的 error 事件
    When TeleNexus 處理這個回合
    Then 使用者收到的訊息指出上游錯誤與狀態碼
    And runner audit 記錄這次執行為失敗，並帶有上游錯誤的失敗種類
    And 有一筆 scope 含狀態碼的 runtime issue
    And 這個回合不被健康檢查當成真實成功

  @SCN-002
  Scenario: 串流與非串流路徑的判定一致
    Given 同一個只含 error 事件的 opencode 輸出
    When 分別經由串流與非串流路徑處理
    Then 兩條路徑得到相同的失敗種類與狀態碼

  @SCN-003
  Scenario: 健康檢查對上游錯誤告警
    Given 目前的模型每次呼叫都得到上游錯誤事件，且 opencode 以 exit 0 結束
    When 模型健康檢查執行探測
    Then 探測結果為不健康，並推播含狀態碼的告警
    And 狀態碼為 426 時，告警指出需要升級 opencode

  @SCN-004
  Scenario: 既有的 429 與 410 行為不退化
    Given 上游回 429，或模型已下架回 410
    When TeleNexus 處理這個回合或健康檢查執行探測
    Then 429 仍在約 1 秒內中止並判為限流
    And 410 仍判為模型失效

  @SCN-005
  Scenario: 正常回合不受影響
    Given opencode 輸出含文字的正常回合，文字內容中出現 "426" 與 "error" 字樣
    When TeleNexus 處理這個回合
    Then 回合被判為成功，回覆內容完整送出

  @SCN-006
  Scenario: 升版後的映像能完成一次真實呼叫
    Given 映像內的 opencode 是升版後的版本
    When 經由 agent-runner 以免費層模型執行一次真實請求
    Then 得到含文字的回覆
    And 過程中沒有 426

  @SCN-007
  Scenario: 模型探針工具能辨識上游錯誤
    Given 某個模型的呼叫得到上游錯誤事件
    When 執行 scripts/probe-models.mjs 探測該模型
    Then 輸出標示該模型不可用並列出狀態碼，而不是歸類為空輸出
```

## Gherkin 核准紀錄

- **核准 commit**: 待提交
- **核准來源**: 使用者於 2026-10-01 對話同意開 issue（「好開 issue」），並在範圍選項中選定「升版＋結構化判定上游錯誤」：升 opencode 釘版恢復服務，並把任何上游 error 事件（依 statusCode）都判為失敗回合、觸發健康告警。SCN-007 依 `CLAUDE.md` 既有要求（`probe-models.mjs` 與 TypeScript 端的判定要一起改）納入同一範圍。

全部 Scenario 於 2026-10-01 核准。

## 重構步驟概要

任務清單、狀態與證據只維護在 [implementation-plan.md](./implementation-plan.md) 的「實作步驟」：

1. 新版 opencode 的相容性探測與 fixture
2. 事件解析與回合失敗判定
3. 健康檢查與真實成功的判定
4. `probe-models.mjs` 同步
5. 升釘版並以真實呼叫驗證
6. 文件更新

## 風險與首要驗證

- **最大風險**：新版 opencode 的對外行為尚未確認。TeleNexus 依賴它的 JSON 事件格式、`-c` 與 `--model` 等參數、`--print-logs` 的 stderr 內容（429 快速中止靠它）。從 1.15 跳到 1.18 若有任何一項改變，升版後可能換成另一種全面失效，或 429 快速中止悄悄失靈。
- **風險等級與理由**：High。核心外部行為尚未確認，且影響每一次聊天與排程。
- **首要驗證**：動任何程式之前，先以候選版本的 opencode 實際執行，擷取正常回合、上游錯誤回合的 stdout 與 stderr，逐項對照現有解析器、樣式與參數的假設。
- **選擇理由**：風險來源是外部契約未知，最直接的手段是契約驗證與最小真實請求。先寫程式再升版，等於拿未經確認的事件格式當設計依據。
- **完成證據**：候選版本的事件樣本與參數行為都有紀錄；與現有假設的每一項差異都已列出並決定處理方式；樣本以去敏的 fixture 形式保存，供後續步驟的測試使用。

## 待確認事項

| 編號  | 事項                                                                          | 狀態   | 影響                                                  |
| ----- | ----------------------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| TBD-1 | 釘到哪一個版本。npm 上的最新版在 2026-10-01 是 1.18.34，上游要求至少 1.18.0。 | 待確認 | 由步驟 1 的探測結果決定，不需使用者回答；影響 SCN-006 |
| TBD-2 | 正式部署在本 issue 發版前要不要先用 `/set_model` 換到非免費層的模型止血。     | 待確認 | 不影響本 issue 的實作與驗收；屬維護者的營運決定       |

## Timeline

| 日期       | 異動                                          | 負責人 |
| ---------- | --------------------------------------------- | ------ |
| 2026-10-01 | 建立；SCN-001 至 SCN-007 依使用者同日對話核准 | -      |

---

**建立日期**: 2026-10-01  
**分級**: Medium  
**風險**: High\
**狀態**: 待實作
