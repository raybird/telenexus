# Issue 0028 - Telegram 回覆把模型的過程敘述與結論分開，過程預設摺疊

GitHub：[#28](https://github.com/raybird/telenexus/issues/28)

## 概述

模型在工具呼叫之間講的過程（「數據已到手。接著抓……仍被擋……改用……」）和最後的結論串成同一則回覆。2026-11-13 統計正式部署近 60 天的 873 則模型回覆，796 則以 `[Opencode]` 開頭，接著是這類過程敘述，真正的結論在後面。長回覆在 Telegram 要先捲過一大段過程才看得到重點。

這次把過程收進 Telegram 的可展開引言（預設摺疊），結論放在前面。過程與結論的分界看 opencode 的 step 結構，不看文字內容：一個回合由多個 step 組成，工具呼叫前講的話屬於以 `tool-calls` 結束的 step，結論在最後一個 step。現在 `src/core/cli-agent-base.ts` 把各段 `text` 事件不加分隔直接接起來，分界在組成回覆時就消失了。

另一個相關情況（issue 留言，#27 盤點時發現）：正式部署 2026-10-13～2026-10-22 有 22 則回覆含 think 結束標籤，標籤前是模型的英文推理文字，之後沒有再出現。#27 已讓兩個 think 標籤不輸出，但推理文字仍顯示在回覆裡；這次一併摺進過程。

**不在範圍內**：
- 排程任務送出的結果：走一般 `sendMessage`，不經 MarkdownV2，也不加 `[Opencode]` 前綴。
- Web Console 的聊天。
- 存進記憶、Memoria 與摘要追問的文字：維持現在的全文，只改 Telegram 上的呈現。
- MarkdownV2 轉換器漏內容的問題（#27 已處理）。

## 現況

| 外部狀態 | 查證命令 | 上次結果 | 查證日期 |
|---|---|---|---|
| GitHub issue #28 | `gh issue view 28 --repo raybird/telenexus --json state -q .state` | OPEN | 2026-11-16 |

## 文件清單
- [implementation-plan.md](./implementation-plan.md)

## 快速導覽

### 當前流程
opencode 各 step 的 `text` 事件 → `aggregatedText +=` 不加分隔接成一串 → 加 `[Opencode]` 前綴 → 解析 SEND_FILE 與 MEMORY_INTENT → `TelegramStreamRenderer.finalize()`（或非串流的 `deliverFinalResponse()`）以 MarkdownV2 送出整串文字。

### 調整後流程
opencode 各 step 的文字依 step 結束原因標成過程或結論 → structured 結果同時帶全文（儲存用，不變）與過程／結論兩部分（runner 一併傳回）→ Telegram 送出 `[Opencode]` 前綴＋結論，後面接第一行為「過程」的摺疊引言；超長時過程另起訊息。

## 關鍵差異
| 項目 | 變更前 | 變更後 |
|------|--------|--------|
| 回覆開頭 | `[Opencode]` 後接過程敘述 | `[Opencode]` 後接結論 |
| 過程敘述 | 與結論連成一串，全部展開 | 摺疊在結論後面，各段各自成一段 |
| think 標籤前的推理文字 | 照常顯示 | 摺進過程 |
| 超過 4096 字 | 整串依行切成多則 | 結論照現有方式切段；過程另起一或多則摺疊引言 |
| 儲存的文字 | 全文 | 不變 |

## 涉及檔案
### opencode 輸出解析
- `src/core/cli-agent-base.ts`：串流路徑依 step 記錄各段文字與結束原因，組出過程與結論。
- `src/core/opencode.ts`：非串流路徑同樣組出過程與結論；`cleanOutput` 逐段套用。
- `src/core/opencode-event-parser.ts`：`interpretEvent()` 帶出 `step_finish` 的結束原因（若現有欄位不足）。
- `src/core/agent-result.ts`：`AgentStructuredResult` 新增過程／結論欄位。
- `src/core/agent.ts`：`fromRunnerStructured()` 帶上新欄位；`[Opencode]` 前綴加在結論前。

### 回覆組裝與送出
- `src/core/message-pipeline.ts`、`src/core/message-pipeline-chat.ts`：從過程與結論兩部分移除 SEND_FILE、MEMORY_INTENT，交給 Telegram 送出；儲存仍用全文。
- `src/core/telegram-stream-renderer.ts`：`finalize()` 收過程與結論，組成摺疊版面。
- `src/core/message-pipeline-helpers.ts`：非串流的 `deliverFinalResponse()` 同上。
- `src/telegram/render/markdown-v2.ts`、`src/telegram/render/chunker.ts`：可展開引言的輸出與切段，每則都是完整的引言。
- `src/connectors/telegram.ts`：MarkdownV2 被拒收時的純文字退回版本不帶引言標記。

### 測試與文件
- `tests/` 下對應的測試檔（`opencode-structured-output`、`dynamic-agent-runner-stream`、`telegram-stream-renderer-finalize`、`telegram/render-*` 等）。
- `CLAUDE.md` 的 Key Modules 表、`ARCHITECTURE.md` 的訊息流程、`README.md` 的功能說明。

## Gherkin 驗收劇本

```gherkin
Feature: Telegram 聊天回覆把過程敘述摺疊起來，結論放在前面

  Background:
    Given 使用者在 Telegram 私聊對 bot 發問
    And opencode 的一個回合由一或多個 step 組成
    And 「過程」指以工具呼叫結束（tool-calls）的 step 產生的文字
    And 「結論」指最後一個 step 產生的文字

  @SCN-001
  Scenario: 有過程的回覆，結論在前、過程摺疊在後
    Given 一個回合有兩個以上 step，以 tool-calls 結束的 step 有文字，最後一個 step 也有文字
    When bot 送出這個回合的回覆
    Then 訊息開頭是 `[Opencode]` 前綴，接著是結論全文
    And 結論後面接一段預設摺疊的可展開引言，引言第一行是「過程」
    And 過程裡每個 step 的文字各自成一段，依產生順序排列，不與其他段直接相接

  @SCN-002
  Scenario: 沒有過程的回覆維持現狀
    Given 一個回合只有一個 step，或以 tool-calls 結束的 step 都沒有文字
    When bot 送出這個回合的回覆
    Then 送出的訊息與變更前逐字相同，沒有摺疊引言

  @SCN-003
  Scenario: 最後一個 step 沒有文字時不摺疊
    Given 一個回合以 tool-calls 結束的 step 有文字，最後一個 step 沒有文字
    When bot 送出這個回合的回覆
    Then 不產生摺疊引言，這些文字照變更前的方式全部顯示

  @SCN-004
  Scenario: 過長時過程另起訊息，不截斷
    Given 一個有過程的回覆，結論加過程超過 Telegram 單則 4096 字
    When bot 送出這個回合的回覆
    Then 結論照變更前的方式送出（必要時切成多則）
    And 過程接在結論之後，以一或多則訊息送出，每則都是完整、預設摺疊、第一行為「過程」的可展開引言
    And 把所有訊息的文字合起來，結論與過程的每個字詞都還在

  @SCN-005
  Scenario: think 標籤前的推理文字摺進過程
    Given 某個 step 的文字含 think 結束標籤，標籤前是模型的推理文字
    When bot 送出這個回合的回覆
    Then 標籤前的推理文字出現在摺疊的過程裡，不出現在結論裡
    And 輸出不含兩個 think 標籤本身
    And 推理文字的內容沒有被刪掉

  @SCN-006
  Scenario: Telegram 拒收 MarkdownV2 時的純文字退回不帶引言標記
    Given 一個有過程的回覆
    When Telegram 以 parse error 拒收 MarkdownV2 版本
    Then bot 改送純文字版本：結論在前，過程以一般文字接在結論後面
    And 純文字版本不含 `**>`、`||` 這類可展開引言的標記

  @SCN-007
  Scenario: 降級訊息維持原樣
    Given 回合被使用者中止，或逾時、上游限流、上游錯誤
    When bot 送出這個回合的回覆
    Then 送出的訊息與變更前相同，沒有摺疊引言

  @SCN-008
  Scenario: 既有的回覆處理不變
    Given 一個有過程的回覆，過程或結論裡含 SEND_FILE 指令或 MEMORY_INTENT 標記
    When bot 送出這個回合的回覆
    Then 兩種標記都不出現在任何一則訊息裡
    And SEND_FILE 指定的檔案照常送出，MEMORY_INTENT 照常記錄
    And 聊天由 runner 或本機執行、走串流或非串流，送出的版面都相同

  @SCN-009
  Scenario: 儲存的文字不變
    Given 一個有過程的回覆
    When 回覆存進聊天記憶、同步到 Memoria、觸發摘要追問
    Then 寫入與送去摘要的文字與變更前相同

  @SCN-010
  Scenario: Telegram 實際接受並摺疊顯示
    Given 用開發用 bot 對維護者的聊天送出有過程的回覆樣本，涵蓋過程裡有清單、粗體、程式碼，以及 SCN-004 的超長情況
    When 呼叫 Bot API `sendMessage`（parse_mode 為 MarkdownV2）
    Then 每一則都回 `ok: true`
    And 使用者在手機上看到過程預設摺疊、可以展開，結論在前
```

## Gherkin 核准紀錄
- **核准 commit**: 待提交
- **核准來源**: 使用者於 2026-11-16 對話逐題回答，全部選建議答案：Q1 以 step 結構分界（tool-calls 的 step 文字為過程、最後一個 step 為結論），步驟 1 先唯讀盤點正式部署的 opencode.db，比例偏高時回來修規格（SCN-001～SCN-003）；Q2 結論在前、過程摺疊在後，引言第一行寫「過程」，沒有過程時與現在相同，超過 4096 字時過程另起一或多則完整的摺疊引言，不截斷、不丟內容（SCN-001、SCN-002、SCN-004）；Q3 think 標籤前的推理文字一併摺進過程（SCN-005）；Q4 只做 Telegram 聊天回覆的串流與非串流路徑，排程、Web Console 不在範圍，記憶、Memoria 與摘要追問的文字維持全文（SCN-008、SCN-009）；Q5 照寫：最後一個 step 沒有文字時不摺疊、過程各段各自成段、MarkdownV2 被拒收時的純文字退回不帶引言標記、降級訊息維持原樣（SCN-001、SCN-003、SCN-006、SCN-007）；Q6 盤點正式 opencode.db 到步驟 1 再問使用者授權；Q7 用開發用 bot 實測，時機由使用者決定（SCN-010）。

全部 Scenario 於 2026-11-16 核准。

## 重構步驟概要

任務的唯一來源是 [implementation-plan.md](./implementation-plan.md#實作步驟)。

## 風險與首要驗證

- **最大風險**：「最後一個 step 的文字就是結論」這個假設不成立。模型可能先寫完結論，再呼叫工具（例如存檔、寫記憶），最後只補一句「已存好」；照 step 結構切，真正的結論會被摺起來，比現在更難找到。次要風險是可展開引言的 MarkdownV2 寫法（`**>` 開頭、`||` 結尾、引言裡的清單與程式碼、切段）被 Telegram 拒收；#27 實測過官方文件沒寫的行為。
- **風險等級與理由**：Medium。兩項未知都會造成有限度的返工：分界錯了要回頭修規格與實作，寫法被拒收時退回純文字。不涉及資料遺失、安全或不可逆操作；內容只是被摺疊，沒有刪除；改回舊版即可恢復。
- **首要驗證**：步驟 1 唯讀盤點正式部署 opencode.db 近 30 天（session 保留期）的聊天回合：有過程的回合數、最後一段的長度分布，以及最後一個 step 前一個 step 帶工具呼叫且最後一段很短的回合，抽樣檢查最後一段是不是結論。步驟 2 用開發用 bot 對 Bot API 實測可展開引言的寫法。兩步都在主要實作之前。
- **選擇理由**：分界假設取決於正式資料的實際樣態，資料盤點最能直接驗證；寫法能不能用由 Telegram 決定，最小真實請求比讀文件可靠。
- **完成證據**：`evidence/step1-inventory.md` 記錄統計數字與抽樣判定（不含回覆原文），由使用者判斷是否修規格；`evidence/step2-telegram-probe.md` 記錄每種寫法的 Bot API 回應。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | 步驟 1 盤點後，最後一段不是結論的比例是否高到要修改分界規則 | 待確認 | 步驟 1 完成後由使用者判斷；影響 SCN-001、SCN-003 與步驟 3 |
| TBD-2 | 開發用 bot 的 token 與實測時機 | 待確認 | 由使用者提供與決定；影響步驟 2、步驟 5 與 SCN-010 |
| TBD-3 | 交付方式：在分支實作後開 PR，或照 #27 的做法本機獨立審查、不開 PR | 待確認 | 不影響規格；在步驟 3 開工前決定 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-11-13 | 建立 GitHub issue #28；同日補充 think 標籤推理文字的留言 | 使用者 |
| 2026-11-16 | 建立 issue 文件，全部 Scenario 依 Q1～Q7 的答案核准 | 使用者 |

---
**建立日期**: 2026-11-16  
**分級**: Medium — 跨 opencode 輸出解析、runner 結果、回覆組裝與 Telegram 渲染，但不涉及 schema 或架構調整  
**風險**: Medium\
**狀態**: 待實作（步驟 1 等待使用者授權盤點正式 opencode.db）
