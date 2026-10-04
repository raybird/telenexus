# Issue 0010 - 替換 agent-browser：HTTP 優先＋Chrome DevTools MCP

GitHub：[issue #10](https://github.com/raybird/telenexus/issues/10)

## 概述

以 HTTP 優先讀取公開網頁、Chrome DevTools MCP 按需處理 JavaScript 頁面，取代 agent-browser；同時補上容器程序回收與任務級收尾，防止殭屍及存活孤兒程序累積。

2026-10-04 使用者要求規劃與建立 GitHub issue，並於同日以「那文件規劃核准」核准本文件集合及 SCN-001～007，之後以 /dev-cycle 授權推進 Task 拆解、規格提交與隔離驗證。正式服務操作與發版仍不在本次授權範圍。

## 文件清單

- [requirement-analysis.md](./requirement-analysis.md)：現況與問題證據
- [technical-analysis.md](./technical-analysis.md)：選型與限制
- [implementation-plan.md](./implementation-plan.md)：唯一的階段、進度及驗證策略來源

## 快速導覽與關鍵差異

原方案透過 agent-browser daemon 保持跨指令瀏覽器，排程以全域 close --all 收尾，互動聊天不每輪關閉。新提案以 HTTP 為一般文件預設；需要 JS 渲染才使用工作專屬 MCP／Chrome／臨時 profile，結束時由程式回收，容器 init 處理被收養的程序。

2026-10-04 已核准本期不承諾沿用舊的跨回合 browser profile 或完整互動能力；實際依賴仍須盤點，不能默默移除使用者仍依賴的功能。若盤點發現與核准範圍不符的相容性缺口，先回報並處理必要的規格修訂。文字聊天 session、認證與其他使用者資料則必須保留。

## 涉及檔案

以下為核准後的候選最小邊界，不代表現在已修改；是否修改程序層由契約探測決定。

```text
.
├── Dockerfile                         # 候選：釘版 MCP／Chrome，移除舊 browser 安裝
├── docker-compose.yml                 # 候選：兩個執行服務 init，移除舊 env
├── docker-compose.release.yml         # 候選：與前者保持 parity
├── docker-compose.dev.yml             # 驗證：繼承相同 runtime 行為
├── src/core/opencode.ts               # 候選：MCP 設定整合與退役全域 close
├── src/core/cli-agent-base.ts          # 條件式：收尾契約不足才修改
├── src/core/process-runner.ts         # 條件式：只處理任務所有權／終止缺口
├── scripts/sync-skills.mjs            # 候選：識別舊內建技能的安全遷移
├── scripts/install.sh                 # 條件式：bundle 切換確實需要才修改
├── skills/agent-browser/              # 候選：退役產品內建舊技能
├── skills/                            # 候選：最小網頁閱讀指引，不改其他技能
├── tests/                             # 候選：契約、生命週期、parity、遷移與 fixture
├── docs/                              # 候選：安裝、設定、安全邊界與相關常青文件
├── README.md / CLAUDE.md / AGENTS.md   # 條件式：必要工具指引／入口說明才修改
├── workspace/ / data/                 # 不直接修改：只能在測試複本驗證遷移
└── memoria / Telegram 渲染 / 排程規則 # 不可觸及：不在本次替換範圍
```

MCP 設定落點由 Phase 0 確認，不預先假定可覆寫持久化的 OpenCode 設定檔。修改 symbol 前仍須 GitNexus impact 加實際呼叫點核對；修改 agent 指引／SKILL.md 時使用 writing-rules。

## Gherkin 驗收劇本

```gherkin
Feature: 可回收且隔離的網頁閱讀工具

  @SCN-001
  Scenario: 普通公開文件不啟動瀏覽器
    Given HTTP 即可取得正文的受控頁面
    When 經實際 OpenCode 工具路徑讀取內容
    Then 回覆包含獨立 fixture 定義的正文與來源網址
    And 沒有啟動該工作所屬的 Chrome

  @SCN-002
  Scenario: JavaScript 頁面使用按需瀏覽器
    Given 正文必須執行 JavaScript 才出現的受控頁面
    When 經實際 OpenCode MCP 工具路徑讀取
    Then 回覆包含已知正文與正確來源網址
    And 本次使用獨立的臨時瀏覽器環境

  @SCN-003
  Scenario Outline: 所有工作退出路徑皆回收自身瀏覽器
    Given 該工作正在建立或已建立 MCP 與瀏覽器資源
    When 發生 <結果>
    Then 工作結束後 15 秒內沒有屬於該工作的存活 MCP 或瀏覽器程序
    And 沒有新增且留存的瀏覽器殭屍程序或臨時 profile
    And 失敗狀態如實反映且收尾失敗可被追蹤
    Examples:
      | 結果 |
      | 正常完成 |
      | 啟動失敗或部分啟動失敗 |
      | 導覽逾時 |
      | 使用者取消 |
      | 上游模型失敗 |
      | OpenCode 被強制終止 |

  @SCN-004
  Scenario: 取消一個工作不干擾另一個
    Given 兩個工作同時讀取不同頁面並設定不同 cookie
    When 取消其中一個工作
    Then 另一個工作仍取得自己的預期正文
    And 兩者不共用 cookie、profile 或收尾目標
    And local 與 runner 同時執行時仍成立

  @SCN-005
  Scenario: 瀏覽器不可用時明確失敗而不破壞 HTTP 閱讀
    Given MCP 無法啟動或 Chrome binary 不可用
    When 讀取必須渲染的頁面
    Then 回報無法完成讀取而不是假裝成功
    And 後續普通文件閱讀仍可完成
    And 不留下部分啟動的程序或 profile

  @SCN-006
  Scenario: 遷移保留使用者資料且可重複執行
    Given 已存在 OpenCode 認證、聊天 session 及客製技能的測試部署
    When 套用遷移並再次執行同一遷移
    Then 新工具在 local 與 runner 均可用且不重複註冊
    And 使用者認證、聊天文字延續與客製技能保持不變
    And 已識別的舊內建 agent-browser 指引不再被載入
    And release 映像不再依賴 agent-browser

  @SCN-007
  Scenario: 重複執行不累積孤兒與殭屍程序
    Given 已用已知殭屍樣本驗證過的 /proc 觀測器及啟用 init 的拋棄式容器
    When 正常任務執行 20 次且各失敗路徑分別執行 5 次
    Then 每輪收尾 15 秒內瀏覽器相關殭屍數回到零
    And 已完成工作的存活程序與臨時 profile 殘留數為零
    And cgroup PID 數沒有隨完成輪次累積成長
```

SCN-003 的「啟動失敗」包含尚未建立完整瀏覽器的情況，仍檢查部分資源。SCN-007 以 fresh container 起始，執行 20 次正常及五種非正常結果各 5 次，共 45 次；期間每秒取樣，工作結束後給予固定 15 秒收尾窗。失敗列包含啟動失敗、導覽逾時、取消、上游失敗、強制終止。

## Gherkin 核准紀錄

- **核准 commit**: d345ba1bc3f391bd2038f8ca0341ccbf742490d0
- **需求來源**: 使用者於 2026-10-04 對話：「那能規劃新方案用來替換 agent -browser 造成的 殭屍進程 在github 開 issue」。
- **核准來源**: 使用者於 2026-10-04 對話：「那文件規劃核准」。
- **核准範圍**: 文件集合、既有 SCN-001～007、分階段計畫與本期相容性取捨；未新增或修改 Scenario 語意。2026-10-04 使用者另以 /dev-cycle 授權推進；正式服務操作、發版與部署仍需另行授權。

| Scenario | 核准日期 | 狀態 |
| --- | --- | --- |
| SCN-001 | 2026-10-04 | 已核准 |
| SCN-002 | 2026-10-04 | 已核准 |
| SCN-003 | 2026-10-04 | 已核准 |
| SCN-004 | 2026-10-04 | 已核准 |
| SCN-005 | 2026-10-04 | 已核准 |
| SCN-006 | 2026-10-04 | 已核准 |
| SCN-007 | 2026-10-04 | 已核准 |

## 步驟概要

Phase 0 契約探測 → Phase 1 容器回收 → Phase 2 工具與生命週期 → Phase 3 技能遷移／淘汰 → Phase 4 回歸與維運文件。
階段相依、產出與證據只維護在 [implementation-plan.md](./implementation-plan.md)。2026-10-04 已完成 Task 拆解；提交核准規格、回填基線後由 T0.1 開始，不另建第二份進度清單。

## 風險與首要驗證

- **最大風險**：OpenCode 1.18.34 的 MCP／Chrome 所有權與關閉契約尚未驗證；若依賴 daemon 或全域 profile，換後端仍可能留下活程序／殭屍，或取消一個工作時關掉另一個。移除既有跨回合狀態也可能破壞使用流程。
- **風險等級與理由**：High。核心外部行為未知，且瀏覽器設定涉及權限與認證邊界。
- **首要驗證**：規格核准後，先在隔離測試容器完成固定版本 OpenCode → MCP → Chrome 契約探測，以受控靜態／JS 頁面與強制終止案例測得真實結果；先用 no-init 已知殭屍對照組驗證觀測器，再比較 init 組。
- **選擇理由**：最大未知是外部程序契約；單元 mock、旗標存在或容器 healthy 回答不了實際退出及隔離行為。探測未通過就停止替換，不先大改實作。
- **完成證據**：記錄版本／平台、命令、退出結果、每秒程序樹與 /proc state、task ID／PID／啟動時間、profile 前後清單；成功與故意失敗對照能被區分。15 秒內無本工作存活 MCP／Chrome、無留下的 browser zombie／profile，另一併發工作不受影響。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
| --- | --- | --- | --- |
| TBD-1 | 核准 HTTP 優先、按工作臨時瀏覽器、遷移與驗收數字 | 已解決 | 2026-10-04 使用者「那文件規劃核准」，涵蓋 SCN-001～007 |
| TBD-2 | 盤點登入、完整互動及跨回合 browser 狀態使用情況 | 待確認 | 2026-10-04 已完成限定窗口唯讀盤點，2 次 click 用途未知；退役前待維護者確認是否需保留特定互動。證據與 gate 見 T3.1，不把未觀察到登入解讀為不存在 |
| TBD-3 | 固定 MCP／Chrome 相容版本、支援平台、工具旗標及 sandbox 可行性 | 已解決 | 2026-10-04 Phase 0／2 固定版本與 linux/amd64 真產品契約通過；使用 no-sandbox，保留容器硬化，不宣稱 Chrome sandbox 啟用。證據見 T0.2、T2.2 |
| TBD-4 | OpenCode 設定合併／任務所有權／強制終止與 15 秒收尾契約 | 已解決 | 2026-10-04 真產品退出／併發矩陣及清理失敗負對照通過，限制見 T2.2、T2.3；45 次最終回歸仍由 T4.1 負責 |
| TBD-5 | 正式部署切換與安全排空時機 | 待確認 | 由維護者另行決定；不阻塞建檔或隔離驗證 |

## Timeline

| 日期 | 異動 | 負責人 |
| --- | --- | --- |
| 2026-10-04 | 使用者授權規劃；建立 GitHub #10 及本機規格提案，詳細驗收待核准 | - |
| 2026-10-04 | 使用者以「那文件規劃核准」核准文件集合及 SCN-001～007；待 Task 拆解與核准規格提交，尚未實作 | - |
| 2026-10-04 | 使用者以 /dev-cycle 授權推進；完成 Task 拆解，準備提交核准基線與執行 Phase 0 | - |

---

**建立日期**: 2026-10-04

**分級**: Large

**風險**: High

**狀態**: Phase 0～2 完成；Phase 3 退役前互動用途待確認
