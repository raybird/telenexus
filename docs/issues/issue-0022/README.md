# Issue 0022 - 退役 memory.db 這條路：停用 mcp-memory-libsql、移除記憶回填 (Medium)

GitHub：[#22](https://github.com/raybird/telenexus/issues/22)

## 文件清單
- [implementation-plan.md](./implementation-plan.md)
- [review-4e99ceb.md](./review-4e99ceb.md)：第一輪本機審查（rebase 前的 HEAD），提出 TBD-2
- [review-f15dd15.md](./review-f15dd15.md)：第二輪本機審查，PASS

## 概述

`data/memory.db` 這條路還在維護、每輪都有成本，但沒有人在用。2026-10-22 在正式部署上的唯讀查詢：

- **agent 不呼叫**：opencode 透過 `mcp-memory-libsql`（`workspace/.opencode/opencode.json`，`LIBSQL_URL=file:../data/memory.db`）讀寫 `memory.db`。v2.32.0 映像裡這個 MCP 能正常連上，但近 30 天（opencode session 保留期）的工具呼叫中，它是 0 次。
- **原因是刻意的**：
  - 2026-03-29 的 `6b77b19` 從程式內建的預設 prompt 拿掉了知識圖譜指示，`tests/ai-config.test.ts` 也防止加回去。
    - 這只對預設值成立。出貨的 `ai-config.example.yaml` 仍有三行條列，點名 `create_entities`、`create_relations`、`search_entities`；正式部署的 `ai-config.yaml` 是從範例複製的，同樣帶著這三行。
    - `src/prompt/builder.ts` 的知識管理標題也還寫「你有 MCP Memory 工具」。
    - 這是本機審查（2026-10-27）發現的缺口，見待確認事項 TBD-2。
  - workspace 的 AGENTS.md 與 `skills/memory` 指向 `memory-cli.js`，它讀的是 `moltbot.db`。
  - 2026-05-23 起，長期記憶改由 Memoria 負責。
- **回填從沒寫進正式部署**：
  - `memory.db` 最後一次寫入是 2026-05-15，裡面的 observation 全是 agent 透過 MCP 寫的，帶回填標記的是 0 筆。
  - 另一台部署開著回填，但只開了 dry-run，不寫入。
  - 遠端 Memoria 模式也已經正式不支援回填（#16）。
- **只有舊部署帶著這份 MCP 設定**：release bundle 與 `install.sh` 都不發 `workspace/.opencode/opencode.json`，升級也不覆蓋 `workspace/`。
- **現狀的成本**：
  - 每次執行 opencode 都會啟動這個 MCP，工具定義也會送進 prompt。
  - 健康報告把 `memory.db` 叫做「檢索資料庫」，看起來像聊天檢索會用到。
  - 回填的 worker、CLI、Web API 與一致性檢查，維護的都是一份沒人讀的資料。

已確認的現況（2026-10-22～27 讀碼與實測）：
- TeleNexus 只在 `OpencodeAgent.getEnv()`（`src/core/opencode.ts`）組 `OPENCODE_CONFIG_CONTENT`。聊天與排程（串流和非串流）都經過它，而且 cwd 是 `workspace/`，所以會讀到 workspace 的 `opencode.json`。
  - 摘要（`summarize`）、模型健康探針與 `scripts/probe-models.mjs` 的 cwd 不是 `workspace/`，不會讀到這份設定。
- v2.32.0 映像（opencode 1.18.34）的 `opencode mcp list` 實測，`OPENCODE_CONFIG_CONTENT` 加上 `{"mcp":{"mcp-memory-libsql":{"enabled":false}}}` 之後：
  - 有舊設定的 workspace 顯示 `○ mcp-memory-libsql disabled`，和舊設定合併後只覆蓋 `enabled`。
  - 沒有舊設定的 workspace 顯示 `No MCP servers configured`，exit 0。
  - `opencode run` 還沒實測（見「風險與首要驗證」）。
- 健康報告裡，`archive`（Memoria 封存、同步缺口、同步失敗數）與 `operational`（`moltbot.db`）不依賴回填；`retrieval`、`backfill`、`consistency` 三個區塊只為回填存在。

**範圍**（使用者 2026-10-22 選「1 退役」，Q1～Q5 的答案見核准紀錄）：
- 停用並移除 MCP：
  - 舊部署留著的 MCP 設定，由 TeleNexus 在交給 opencode 的設定裡停用；
  - 映像不再安裝這個 MCP，repo 的 workspace 設定也拿掉它。
- 移除回填的程式、CLI、npm scripts、Web API 與環境變數。
- 健康報告只留運作資料庫與封存兩個區塊。

**不在範圍內**：
- 刪除或修改既有的 `memory.db`、回填 checkpoint 和報告 JSON。這些檔案都原地保留。
- 匯出 `memory.db`，或把它併進 Memoria（Q2）。
- `moltbot.db`、SAR、Memoria 召回與同步。
- `docs/` 下「歷史提案／研究文件」的回填規劃（`docs/sessions-db-backfill-implementation-plan.md` 等）。依 project.md 維持原樣。

## 快速導覽

### 當前流程
1. 舊部署的 workspace 有 `mcp-memory-libsql` 設定，每次執行 opencode 都會啟動它（映像有全域安裝）。
2. `MemoryBackfillWorker` 依 `MEMORY_BACKFILL_*` 排程掃描 Memoria 封存，寫入 `memory.db`。
3. `memory-status.md` 與 `/api/memory-health` 會讀 `memory.db`，報告檢索資料庫、回填與一致性；Web Console Status 頁顯示回填欄位與 Recent Backfill Runs。

### 退役後流程
1. TeleNexus 交給 opencode 的設定把 `mcp-memory-libsql` 標成 `enabled:false`，舊設定不再啟動 MCP，映像也不再安裝它。
2. 服務不再排程回填。`MEMORY_BACKFILL_ENABLED=true` 時只在啟動印一行警告。
3. 健康報告只有運作資料庫與封存，不讀 `memory.db`。

## 關鍵差異
| 項目 | 變更前 | 變更後 |
|------|--------|--------|
| 舊部署的 `mcp-memory-libsql` | 每輪啟動 | 停用；使用者自己在 `OPENCODE_CONFIG_CONTENT` 設定時保留使用者的設定 |
| 映像 | 全域安裝 `mcp-memory-libsql` | 不安裝 |
| 回填 | worker、CLI、`npm run memory:backfill:*`、`GET /api/memory-backfill/report` | 全部移除，API 回 404 |
| `MEMORY_BACKFILL_ENABLED=true` | 排程回填 | 啟動時 warn 一行，說明回填已移除、變數不再有作用 |
| 健康報告 | 運作資料庫、檢索資料庫、封存、回填、一致性 | 運作資料庫、封存 |
| `data/memory.db` | 回填與健康報告會讀寫 | TeleNexus 不再讀寫，檔案原地保留 |
| prompt 的知識管理段落 | 標題寫「你有 MCP Memory 工具」；範例設定點名 MCP 工具 | 標題不提 MCP；範例改用預設條列；`ai-config.yaml` 和舊範例一字不差時換成預設條列，啟動 warn 一行 |

## 涉及檔案

```text
src/
├── config/ai-config.ts               # 可改：舊範例條列換成預設條列、啟動警告
├── core/opencode.ts                  # 可改：getEnv() 注入停用
├── main.ts                           # 可改：拿掉 worker，加啟動警告
├── prompt/builder.ts                 # 可改：只改知識管理段落的標題（SCN-010）
├── services/
│   ├── memory-backfill.ts            # 刪除
│   ├── memory-backfill-worker.ts     # 刪除
│   ├── memory-health.ts              # 可改：只留 operational 與 archive
│   └── context-snapshots.ts          # 可改：只在需要時配合 memory-health 的介面
├── tools/memory-backfill-cli.ts      # 刪除
├── utils/paths.ts                    # 可改：拿掉只給回填用的路徑函式
└── web/
    ├── server.ts                     # 可改：拿掉 /api/memory-backfill/report
    └── public/app/                   # 可改：Status 頁、Dashboard 警告、status-service
Dockerfile                            # 可改：不再全域安裝 mcp-memory-libsql
workspace/.opencode/opencode.json     # 可改：拿掉 mcp 區塊，model 不動
ai-config.example.yaml                # 可改：memory_policy_lines 改成和預設條列相同
package.json                          # 可改：拿掉 memory:backfill:dry-run／write
tests/                                # 可改：回填測試刪除，health／snapshot／opencode 設定測試修改或新增
.env.example、.env.production.example # 可改：拿掉 MEMORY_BACKFILL_*
docs/                                 # 可改：常青文件（見實作計畫步驟 6）
src/core/memoria-*.ts、src/core/memory.ts             # 不可觸及：Memoria 召回／同步與 moltbot.db
src/prompt/ 的其他部分                                # 不可觸及：prompt 模式與組裝順序
docs/sessions-db-backfill-implementation-plan.md 等歷史文件  # 不可觸及
```

`scripts/backfill-summary-metadata.ts`（`npm run memory:backfill-summary-metadata`）處理的是 `moltbot.db` 的摘要 metadata，和本 issue 無關，不動。

## Gherkin 驗收劇本

```gherkin
Feature: 退役 memory.db 這條路

  Background:
    Given TeleNexus 以 OpencodeAgent 執行聊天或排程任務，opencode 的 cwd 是 workspace/

  @SCN-001
  Scenario: 舊部署的 workspace 設定不再啟動 mcp-memory-libsql
    Given workspace/.opencode/opencode.json 設定了 enabled 的 mcp-memory-libsql
    And 使用者沒有在 OPENCODE_CONFIG_CONTENT 設定 mcp-memory-libsql
    When TeleNexus 執行一次 opencode run
    Then opencode 不啟動 mcp-memory-libsql
    And 這次 run 和沒有該 MCP 時一樣正常完成

  @SCN-002
  Scenario: 沒有舊設定的部署照常執行
    Given workspace 沒有任何 mcp-memory-libsql 設定
    When TeleNexus 執行一次 opencode run
    Then run 正常完成，沒有設定驗證錯誤
    And 內建的 telenexus_browser MCP 照常注入

  @SCN-003
  Scenario: 使用者自己設定的 mcp-memory-libsql 保留原樣
    Given 使用者在 OPENCODE_CONFIG_CONTENT 設定了 mcp-memory-libsql
    When TeleNexus 組出交給 opencode 的設定
    Then mcp-memory-libsql 的條目和使用者設定的內容相同

  @SCN-004
  Scenario: 映像與 repo 不再提供 mcp-memory-libsql
    When 以 Dockerfile 建出 production 映像
    Then 映像裡沒有全域安裝的 mcp-memory-libsql
    And repo 的 workspace/.opencode/opencode.json 沒有 mcp-memory-libsql
    And 舊設定加上新映像執行 opencode run 時，不會透過 npx 下載 mcp-memory-libsql

  @SCN-005
  Scenario: 回填功能已移除
    Given 服務以 v2.32.0 的任何 MEMORY_BACKFILL_* 設定啟動
    When 服務運作
    Then 不會排程或執行回填，也不寫入 data/memory.db、回填 checkpoint 或報告檔
    And npm scripts 沒有 memory:backfill:dry-run 與 memory:backfill:write
    And GET /api/memory-backfill/report 回 404

  @SCN-006
  Scenario Outline: 仍然設定回填時，啟動時提示
    Given MEMORY_BACKFILL_ENABLED 是 <值>
    When 服務啟動
    Then 啟動 log <結果>

    Examples:
      | 值     | 結果                                                     |
      | true   | 以 warn 印一行，說明回填已移除、這個變數不再有作用 |
      | false  | 沒有回填相關的訊息                                       |
      | 未設定 | 沒有回填相關的訊息                                       |

  @SCN-007
  Scenario: 健康報告只含運作資料庫與封存
    Given data/memory.db 存在
    When 產生 memory-status.md 或呼叫 GET /api/memory-health
    Then 報告有運作資料庫與封存的內容，數值和判定與 v2.32.0 相同
    And 報告沒有檢索資料庫、回填與一致性的欄位，也沒有 memory.db 與 checkpoint 的路徑
    And data/memory.db 的大小與修改時間不變

  @SCN-008
  Scenario: Web Console 不再顯示回填
    When 打開 Web Console 的 Status 頁與 Dashboard
    Then Status 頁沒有回填欄位與 Recent Backfill Runs，也不呼叫 /api/memory-backfill/report
    And Dashboard 不再出現 backfill 的警告

  @SCN-009
  Scenario: 文件寫明退役與升級方式
    When 維護者閱讀設定參考、Web Console 參考、安裝文件與 .env.example
    Then 文件寫明 mcp-memory-libsql 與回填已退役
    And 寫明 data/memory.db 原地保留、升級不需要手動步驟
    And 寫明另一台部署升級前的檢查方式，以及想保留 MCP 時怎麼在 OPENCODE_CONFIG_CONTENT 設定
    And 文件裡沒有留下回填的設定說明與 npm scripts

  @SCN-010
  Scenario: prompt 不再指示已退役的 MCP Memory 工具
    When 組出 full prompt
    Then 知識管理段落沒有「你有 MCP Memory 工具」這句
    And ai-config.example.yaml 的 memory_policy_lines 不提 create_entities、create_relations、search_entities

  @SCN-011
  Scenario Outline: 使用者設定的 memory_policy_lines
    Given ai-config.yaml 的 memory_policy_lines 是 <內容>
    When 組出 full prompt
    Then 知識管理段落使用 <結果>

    Examples:
      | 內容 | 結果 |
      | 和舊範例的三行完全相同 | 預設條列，服務啟動時 warn 一行 |
      | 使用者改過的條列 | 使用者的條列原樣 |
      | 未設定 | 預設條列，不 warn |
```

SCN-011 的「舊範例的三行」是 v2.32.0 以前 `ai-config.example.yaml` 唯一出貨過的有效條列（`fc0d60f` 起都相同）：

```yaml
memory_policy_lines:
  - 當對話包含重要資訊時，主動使用 create_entities 儲存
  - 當發現實體間關係時，使用 create_relations
  - 需要回想時，使用 search_entities
```

比對時每行去掉頭尾空白，順序與行數都要相同。只要改過一個字、多一行或少一行，就視為使用者自訂。

## Gherkin 核准紀錄
- **核准 commit**: 44a2107
- **核准來源**:
  - 2026-10-22：使用者選「1 退役」。
  - 2026-10-22：Q1「程式注入停用（建議）」、Q2「原地保留（建議）」、Q3「直接移除（建議）」、Q4「留運作庫與封存（建議）」。
  - 2026-10-27：Q5「不阻塞，升級前再查（建議）」、Q6「分支＋本機審查，PASS 後自動合併（建議）」。
  - 2026-10-27：Scenario 總結確認，使用者選「全部核准（建議）」。
  - 2026-10-27（規格修訂）：本機獨立審查（review-4e99ceb.md）發現 TBD-2。使用者選「擴大 #22（建議）」，再選「程式自動替換舊範例（建議）」，SCN-010、SCN-011 依該選項的劇本核准。
- **修訂核准 commit**: 2580117

| Scenario | 核准日期 | 狀態 |
|----------|---------|------|
| SCN-001 | 2026-10-27 | 已核准 |
| SCN-002 | 2026-10-27 | 已核准 |
| SCN-003 | 2026-10-27 | 已核准 |
| SCN-004 | 2026-10-27 | 已核准 |
| SCN-005 | 2026-10-27 | 已核准 |
| SCN-006 | 2026-10-27 | 已核准 |
| SCN-007 | 2026-10-27 | 已核准 |
| SCN-008 | 2026-10-27 | 已核准 |
| SCN-009 | 2026-10-27 | 已核准 |
| SCN-010 | 2026-10-27 | 已核准 |
| SCN-011 | 2026-10-27 | 已核准 |

## 重構步驟概要

見 [implementation-plan.md](./implementation-plan.md)。

## 風險與首要驗證

- **最大風險**：注入的 `{"enabled":false}` 在 `opencode run` 會出問題。只有 `opencode mcp list` 實測過。可能的情況有兩種：
  - 沒有舊設定的部署（新安裝），只有 `enabled`、沒有 `type`／`command` 的條目在 `opencode run` 驗證失敗，導致所有聊天與排程都失敗；
  - 有舊設定的部署，`run` 仍然啟動 MCP。
- **風險等級與理由**：High。opencode 對這個核心外部行為的處理還沒確認，而失敗會波及每個部署的每一輪 opencode 執行。
- **首要驗證**：在主要實作之前，用 v2.32.0 映像（opencode 1.18.34）做契約探測。
  - 把 workspace 裡的 MCP 指令換成「被啟動就寫一個標記檔」的假指令，模型用 issue 0008 的假上游。
  - 分三組跑 `opencode run`：舊設定且不注入（對照組）、舊設定加注入、沒有舊設定加注入。
- **選擇理由**：單元測試只看得到 TeleNexus 組出的 JSON，看不到 opencode 怎麼合併、驗證和啟動 MCP。標記檔可以直接觀察 MCP 有沒有被啟動，對照組則證明這個觀察方式抓得到啟動。
- **完成證據**：
  - 對照組有標記檔；
  - 兩組注入都沒有標記檔；
  - 三組 run 都從假上游拿到回覆、exit 0，沒有設定錯誤。
  - 探測不成立時停止實作，回報後重新決定 Q1。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | 另一台部署有沒有在用 `mcp-memory-libsql`。那台開著回填 dry-run，2026-10-03 起刻意停擺，從本機查不到。升級那台之前，由使用者執行實作計畫步驟 6 寫進文件的唯讀檢查命令；有在用的話，在那台的 `OPENCODE_CONFIG_CONTENT` 設定這個 MCP（SCN-003 會保留它） | 待確認 | 不阻塞本次交付（Q5）；影響那台升級後是否保留 MCP |
| TBD-2 | 本機審查 `review-4e99ceb.md` S1：prompt 標題、`ai-config.example.yaml` 與正式部署的 `ai-config.yaml` 仍指示 agent 使用 MCP Memory 工具；`configuration-reference.md` 新寫的「2026-03-29 起 prompt 就不再指示」不正確 | 已解決：使用者選擇擴大 #22，新增 SCN-010、SCN-011，文件一併更正（SCN-009） | 退役後指示會指向不存在的工具；4e99ceb 不合併，補實作後重新審查 |

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-27 | 不開 PR，改由獨立 subagent 在本機審查 `main..HEAD`；審查 PASS 而且沒有要修的項目時，以 `git merge --ff-only` 自動合併 | Q6 選「分支＋本機審查，PASS 後自動合併（建議）」 | GitHub 上沒有 PR 紀錄，審查報告保存在本 issue 目錄；合併前使用者不會再看一次 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-22 | 在正式部署唯讀查詢 MCP 與 `memory.db` 的使用情況；使用者選擇退役，開 GitHub #22；Q1～Q4 回答 | - |
| 2026-10-27 | Q5、Q6 回答；建立 issue 文件；SCN-001～009 全部核准 | 使用者 |
| 2026-10-27 | 步驟 1～6 完成（分支 4e99ceb）；本機獨立審查 PASS 但有一項需決策（TBD-2）；使用者選擇擴大範圍，SCN-010、SCN-011 核准 | 使用者 |
| 2026-10-27 | 步驟 7 完成（f15dd15）；第二輪本機獨立審查 [review-f15dd15.md](./review-f15dd15.md) PASS，沒有要修的項目；依 Gate 豁免以 `git merge --ff-only` 合併到 main（90ad876），未推送、未發版 | - |

---
**建立日期**: 2026-10-27  
**分級**: Medium  
**風險**: High\
**狀態**: 已完成（2026-10-27 合併到 main 的 90ad876；未推送、未發版；TBD-1 待那台部署升級前確認）
