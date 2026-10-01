# Issue 0009 - opencode session 保留期清理：避免 opencode.db 無限成長

GitHub：<https://github.com/raybird/telenexus/issues/9>

## 概述

opencode 把每一次執行的對話與工具輸出存進 `opencode.db`，TeleNexus 從不清理，檔案隨運行時間持續變大。本 issue 加入保留期清理：定期刪除過期的 session、探針用完即刪、並在適當時機回收檔案空間。TeleNexus 自己另外保存對話紀錄，不會讀取舊的 opencode session。

## 文件清單

- [implementation-plan.md](./implementation-plan.md)

## 涉及檔案

```text
.
├── src/services/                       # 可改：新增 session 保留期清理的服務
├── src/runner.ts                       # 可改：掛載清理
├── src/main.ts                         # 可改：未使用 runner 的部署由主服務掛載
├── src/services/model-health-check.ts  # 可改：探針刪除自己建立的 session
├── tests/                              # 可改：對應的測試
├── .env.example                        # 可改：新增設定
├── docs/configuration-reference.md     # 可改：新增設定的說明
├── CLAUDE.md                           # 可改：模組表與相關段落
├── docker-compose.yml                  # 不可觸及：設定經 env_file 傳入，不需要改 compose
├── docker-compose.release.yml          # 不可觸及
└── opencode.db 的資料表結構            # 不可觸及：只透過 opencode 的 CLI 操作，不直接改寫資料表
```

## Gherkin 驗收劇本

```gherkin
Feature: opencode session 的保留期清理

  @SCN-001
  Scenario: 超過保留期的 session 被刪除
    Given opencode.db 中有最後更新時間早於保留期的 session，也有保留期內的 session
    When 清理執行
    Then 過期的 session 及其訊息與片段都被刪除
    And 保留期內的 session 完全不變

  @SCN-002
  Scenario: 最新的聊天 session 一律保留
    Given 最近一次使用的 session 已經超過保留期
    When 清理執行
    Then 這個 session 不被刪除
    And 之後以 -c 接續對話仍接得上它

  @SCN-003
  Scenario: 保留期可設定，清理可停用
    Given 以環境變數設定保留天數，或停用清理
    When 服務啟動並到達清理時間
    Then 清理依設定的天數執行；停用時不刪除任何 session
    And 未設定時預設保留 30 天

  @SCN-004
  Scenario: 健康檢查探針不留下 session
    Given 模型健康檢查執行了一次探測
    When 探測結束
    Then 該次探測建立的 session 已被刪除

  @SCN-005
  Scenario: 清理失敗不影響服務
    Given 清理時 opencode 指令失敗或資料庫被鎖定
    When 清理執行
    Then 失敗被記為 runtime issue，並在下一次清理時重試
    And 進行中的聊天與排程照常完成

  @SCN-006
  Scenario: 刪除後回收檔案空間
    Given 清理刪除了大量 session，資料庫內有可回收的空間
    When 沒有任務在執行，且可回收空間超過門檻
    Then 執行空間回收，資料庫檔案變小
    And 有任務在執行時不進行空間回收
```

## Gherkin 核准紀錄

- **核准 commit**: 待提交
- **核准來源**: 使用者於 2026-10-01 對話詢問 opencode.db 肥大的改善方式；我提出的做法是定期以 `opencode session delete` 刪除超過 N 天的 session（天數做成環境變數、預設 30 天）、刪除後以 `VACUUM` 回收空間、健康檢查探針跑完就刪掉自己的 session，並建議聊天 session 輪替另行評估。使用者同日回覆「好開 issue」。SCN-002 與 SCN-005 是上述做法的安全條件：最新的聊天 session 由 `-c` 沿用（`docs/configuration-reference.md` 的「Runner Session Context」），清理屬背景維護，不應影響服務。

全部 Scenario 於 2026-10-01 核准。

## 重構步驟概要

任務清單、狀態與證據只維護在 [implementation-plan.md](./implementation-plan.md) 的「實作步驟」：

1. 在資料庫複本上驗證 opencode 的刪除與回收行為
2. 挑選待刪 session 的邏輯
3. 清理的執行、排程與設定
4. 探針 session 用完即刪
5. 空間回收
6. 複本上的端到端驗證與文件

## 風險與首要驗證

- **最大風險**：刪除不可逆，而 `opencode session delete` 的實際行為尚未確認。未知包括：是否連同訊息、片段與子 session 一併刪除；有任務在寫入時刪除會不會失敗或弄壞資料；首次要刪上千個 session 需要多久；`VACUUM` 需要多少時間與鎖定。任何一項判斷錯誤，後果是刪掉還在用的對話，或讓執行中的任務失敗。
- **風險等級與理由**：High。涉及資料刪除與不可逆操作，且核心外部行為（opencode 的刪除語意）尚未確認。
- **首要驗證**：寫任何清理程式之前，先把一份真實的 `opencode.db` 複製到 repo 之外，在拋棄式容器裡對複本實際執行 `session list`、`session delete` 與空間回收，量測並記錄結果。
- **選擇理由**：風險來自外部工具的行為與既有資料的樣態，兩者都只能靠對真實資料的小樣本試跑確認。以空資料庫或 mock 測試，回答不了串聯刪除與耗時的問題。
- **完成證據**：刪除前後各資料表筆數的差異符合預期（被刪 session 的訊息與片段歸零、其他 session 不變）；單次刪除與批次刪除的耗時；有任務執行時刪除的結果；空間回收前後的檔案大小、耗時，以及回收期間其他連線的行為。證據只記彙總數字，不含對話內容。

## 待確認事項

| 編號  | 事項                                                                            | 狀態   | 影響                                                           |
| ----- | ------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| TBD-1 | 每次清理最多刪幾個 session、多久執行一次。首次清理可能有上千個待刪。            | 待確認 | 由步驟 1 量到的耗時決定，不需使用者回答；影響 SCN-001、SCN-005 |
| TBD-2 | 空間回收的觸發門檻與做法。                                                      | 待確認 | 由步驟 1 的實測決定，不需使用者回答；影響 SCN-006              |
| TBD-3 | 與 issue 0008 的先後。兩者都會改健康檢查探針，0008 較急且會讓探針改為解析事件。 | 待確認 | 步驟 4 排在 0008 的探針變更之後；其餘步驟不受影響              |

## Timeline

| 日期       | 異動                                          | 負責人 |
| ---------- | --------------------------------------------- | ------ |
| 2026-10-01 | 建立；SCN-001 至 SCN-006 依使用者同日對話核准 | -      |

---

**建立日期**: 2026-10-01  
**分級**: Medium  
**風險**: High\
**狀態**: 待實作
