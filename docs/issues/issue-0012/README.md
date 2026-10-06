# Issue 0012 - 聊天綁定自己的 session，記憶注入排除排程輸出並設相關度門檻

GitHub：[issue #12](https://github.com/raybird/telenexus/issues/12)

## 概述

聊天以 `opencode run -c` 接續 session，但 `-c` 接的是「最後被更新的 session」。排程、摘要呼叫與追蹤提醒都會建立或更新 session，runner 的 interactive 與 scheduled 兩條 lane 也會並行，所以聊天常接進別人的 session。本 issue 讓聊天綁定並接續自己的 session，並修正記憶注入的兩個問題：「近期對話」混入排程輸出，以及 Memoria 召回沒有相關度門檻。

起因：2026-10-06 Wukong 的記憶重複注入問題（raybird/Wukong#9）交叉檢查。原本以為「近期對話」與 session 重複，查正式環境的 opencode.db 後發現前提不成立：聊天接到的 session 本來就不對，「近期對話」反而是聊天唯一可靠的上下文。現況證據見 [implementation-plan.md 的「現況」](./implementation-plan.md#現況)。

## 文件清單

- [implementation-plan.md](./implementation-plan.md)

## 快速導覽

### 當前流程

聊天、passthrough 指令、`tool_only` 追問與追蹤提醒都用 `-c`，接續 opencode 最後被更新的 session。排程與摘要每次開新 session，所以下一則聊天常接進排程或摘要的 session。「近期對話」固定取最近 10 則訊息，不分聊天與排程輸出。Memoria 召回有結果就注入，不看 confidence。

### 變更後流程

TeleNexus 為每位使用者記住聊天 session 的 id，聊天與 passthrough 指令用 `-s <id>` 接續；`/new` 或首次對話開新 session 後改綁。`tool_only` 追問送進該回合自己的 session。追蹤提醒改開新 session。接續自己的 session 時不注入「近期對話」；開新 session 時照舊注入，而且只取聊天訊息。Memoria 召回信心低於門檻時不注入。

## 關鍵差異

| 項目 | 變更前 | 變更後 |
|------|--------|--------|
| 聊天接續的 session | 最後被更新的 session（可能是排程或摘要） | 該使用者綁定的聊天 session |
| `tool_only` 追問 | `-c`，排程回合（新 session）的追問會接到別處 | 送進該回合的 session |
| 追蹤提醒 | `-c`，接進最後被更新的 session | 開新 session，prompt 已自帶對話紀錄 |
| 「近期對話」段 | 每次注入最近 10 則，含排程輸出 | 接續自己的 session 時不注入；開新 session 時注入，只含聊天訊息 |
| Memoria 召回 | 有結果就注入前 3 筆 | 信心低於門檻時不注入 |

## 涉及檔案

```text
src/
├── core/opencode.ts               # 可改：聊天參數改用 -s；追問帶回合 session
├── core/cli-agent-base.ts          # 可改：tool_only 追問送進該回合的 session
├── core/agent.ts                   # 可改：把 session id 傳給 runner 與本機執行
├── runner.ts                       # 可改：RunnerRequest 接受 session id
├── core/message-pipeline*.ts       # 可改：取用、更新聊天 session 綁定
├── services/chat-session-store.ts  # 新增：每位使用者的聊天 session 綁定（data/ 下的檔案）
├── core/scheduler.ts               # 可改：追蹤提醒開新 session；排程輸出加標記
├── core/memory.ts                  # 可改：近期對話排除排程輸出；舊資料回填標記
├── prompt/builder.ts               # 可改：接續時省略近期對話；confidence 門檻
├── core/memoria-recall.ts          # 可改：門檻設定
├── main.ts                         # 可改：buildPrompt 帶入是否接續
├── services/model-health-check.ts  # 不可觸及：探針本來就開新 session
└── core/memoria-sync.ts            # 不可觸及：Memoria 寫入內容不在範圍
tests/                              # 可改：新增與更新測試
docs/、.env.example                 # 可改：常青文件（見計畫「常青文件」）
Dockerfile、docker-compose*.yml      # 不可觸及：不升 opencode 釘版、不改 compose
```

## Gherkin 驗收劇本

```gherkin
Feature: 聊天接續自己的 session，記憶注入只放相關內容

  @SCN-001
  Scenario: 聊天不被其他 session 搶走
    Given 使用者已有綁定的聊天 session
    And 之後有排程、摘要呼叫或追蹤提醒建立或更新了其他 session
    When 使用者傳一般訊息或 passthrough 指令
    Then 這一回合接續綁定的聊天 session
    And 其他 session 中沒有這一回合的內容

  @SCN-002
  Scenario: 開新 session 後改綁
    Given 使用者首次對話、沒有綁定的 session，或傳了 /new
    When 下一則一般訊息執行完成
    Then 這一回合在新的 session 執行
    And 之後的聊天接續這個新 session

  @SCN-003
  Scenario: 綁定的 session 已不存在
    Given 綁定的聊天 session 已被刪除，或在執行端不存在
    When 使用者傳一般訊息
    Then 這一回合仍然完成並回覆使用者
    And 系統改開新 session 並改綁到它
    And 記錄一筆 runtime issue

  @SCN-004
  Scenario: tool_only 追問送進該回合的 session
    Given 一個回合（聊天或排程）只有工具呼叫、沒有文字回覆
    When 系統送出「請整理你剛才工具執行的結果並回答原問題」追問
    Then 追問在該回合的同一個 session 執行

  @SCN-005
  Scenario: 追蹤提醒不接續其他 session
    Given 追蹤提醒觸發
    When 追蹤提醒執行
    Then 它在新的 session 執行
    And 聊天 session 與排程 session 中沒有追蹤提醒的 prompt

  @SCN-006
  Scenario Outline: 依是否接續決定注入近期對話
    Given 這一回合<接續狀態>
    When 組裝聊天 prompt
    Then 記憶區塊<近期對話>

    Examples:
      | 接續狀態                     | 近期對話             |
      | 接續綁定的聊天 session         | 不含「近期對話」段     |
      | 開新 session（首次、/new、改綁） | 含「近期對話」段       |

  @SCN-007
  Scenario: 近期對話只含聊天訊息
    Given 訊息紀錄中聊天訊息與排程輸出交錯，包含本 issue 上線前的既有資料
    When 組裝含「近期對話」段的 prompt
    Then 「近期對話」只列出聊天的使用者訊息與回覆
    And 不列出排程輸出

  @SCN-008
  Scenario: Memoria 召回信心過低時不注入
    Given Memoria 召回回傳結果，且 confidence 低於設定的門檻
    When 組裝含記憶的 prompt
    Then 「相關歷史摘要」段不含這次 Memoria 召回的結果
    And 門檻可用環境變數設定
```

## Gherkin 核准紀錄

- **核准 commit**: 待提交
- **核准來源**: 2026-10-06 對話。我列出三項改善方向後，使用者回覆「那開 issue」。我回報 (1) 的前提不成立，並建議「聊天改綁自己的 session（記下 session id，用 `-s` 接續），不再被排程或摘要搶走；確認接續成功後才縮減『近期對話』。再加上 (2) 排除排程輸出、(3) confidence 門檻」，使用者同日選擇此方案。SCN-001、002、007、008 是該方案原文的結果；SCN-003～006 是我補上的具體行為，原文沒有涵蓋；同日我逐項列出後，使用者回覆「核准」。

| Scenario | 核准日期 | 狀態 |
|----------|---------|------|
| SCN-001 | 2026-10-06 | 已核准 |
| SCN-002 | 2026-10-06 | 已核准 |
| SCN-003 | 2026-10-06 | 已核准 |
| SCN-004 | 2026-10-06 | 已核准 |
| SCN-005 | 2026-10-06 | 已核准 |
| SCN-006 | 2026-10-06 | 已核准 |
| SCN-007 | 2026-10-06 | 已核准 |
| SCN-008 | 2026-10-06 | 已核准 |

## 風險與首要驗證

- **最大風險**：opencode 1.18.34 的 `-s` 行為未經確認：指定的 session 會不會真的帶入先前的對話、session 不存在時是報錯、靜默開新 session 還是卡住。判斷錯了，聊天會失去上下文，或整回合失敗。
- **風險等級與理由**：Medium。有一項重要的外部契約未知，但改動可回復（退回 `-c`），也不碰資料庫 schema 與正式資料。
- **首要驗證**：契約探測。用正式映像在隔離的容器跑 opencode（暫存資料目錄、不發佈 port、不帶 Telegram token），測四種情況：`-s` 有效 id、`-s` 不存在的 id、`-s` 已刪除的 id，以及 `-s` 執行期間另一個 session 被更新。
- **選擇理由**：這是 opencode 的行為，只有實際執行才能確定；單元測試只能驗證我們傳了 `-s`，驗證不了 opencode 會接到哪個 session。
- **完成證據**：`evidence/` 中有四種情況的事件輸出（`sessionID`、`error` 事件、exit code）。有效 id 的回合能引用前一回合的內容；opencode.db 中該 session 的使用者訊息數加一，其他 session 不變。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | `-s` 指定不存在的 session 時 opencode 的行為 | 待確認 | 決定 SCN-003 的偵測方式（error 事件、exit code，或事件中的 sessionID 與要求的不同）；由計畫步驟 1 解決 |
| TBD-2 | confidence 門檻的預設值，以及 confidence 為 null（該路由無法判斷）時注入與否 | 待確認 | SCN-008；正式環境近 7 天沒有 memoria_recall 事件，需在快照複本上抽樣決定（計畫步驟 6） |
| TBD-3 | 既有資料中排程輸出的辨識規則 | 待確認 | SCN-007 的「既有資料」部分；由計畫步驟 5 在資料庫複本上盤點 |
| TBD-4 | SCN-003～006 的核准 | 已解決 | 使用者 2026-10-06 回覆「核准」 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-06 | 建立 GitHub issue #12 與本文件；SCN-001、002、007、008 依對話核准 | - |
| 2026-10-06 | SCN-003～006 核准 | - |

---
**建立日期**: 2026-10-06  
**分級**: Medium — 跨 telenexus 與 agent-runner 兩個服務，不改資料庫 schema  
**風險**: Medium\
**狀態**: 待實作
