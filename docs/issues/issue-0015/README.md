# Issue 0015 - 舊版 project scope 記憶無法由聊天召回：分類遷移工具

GitHub：[#15](https://github.com/raybird/telenexus/issues/15)

## 文件清單
- [implementation-plan.md](./implementation-plan.md)

## 概述

2026-08-14 以前，TeleNexus 同步到 Memoria 的每個 session 都落在 `project:TeleNexus` 分區，summary 只是 `user=… platform=…` 這類 metadata。之後的版本把聊天寫進 `user:<id>`、排程寫進 `scheduler:<id>`，summary 改放對話內容，聊天召回也只查 `user:<id>`。升級上來的部署因此留著一整區聊天看不到、也搜不到內容的舊記憶。另一台部署有 2,301 筆這樣的資料（[分類調查](evidence/investigation-scope-classification.md)）。

本 issue 提供一個遷移工具，依每個 session 事件裡記錄的 `platform` 與 `user_id` 把舊資料分到 `user:` 或 `scheduler:` 分區，從事件重建 summary，並移除這些 session 的舊索引節點，交給 Memoria 重建。在資料副本上的模擬顯示，只改 scope 召回 0/10，改 scope 加重建 summary 為 7/10（[模擬遷移](evidence/investigation-migration-simulation.md)）。

**範圍**：工具、操作文件，以及在資料副本上量測遷移前後的召回。不包含：
- 召回門檻或排序的重新校準。模擬顯示遷移後無關問句的 confidence 會升到 0.285～0.4，高於相關題最低的 0.294，這件事另開 issue，見 TBD-1。
- 在正式部署上執行遷移。要不要執行，由使用者看量測結果決定。
- GitHub #15 提到的「獨立呈現升級後的召回指標」，見 TBD-2。

## 快速導覽

### 當前流程
舊 session 留在 `project:TeleNexus`，summary 是 metadata。聊天以 `user:<id>` 召回，Memoria 的 scope 是等值比對，所以永遠查不到這些資料。即使改查這個分區，也沒有內容可以比對。

### 遷移後流程
停止 Memoria，然後用 telenexus 映像執行遷移工具。工具預設只預覽；加上 `--write` 才會先備份整個資料庫、在同一個 transaction 裡改寫，並留下遷移紀錄。接著以 Memoria 容器重建索引，再啟動 Memoria。之後聊天就能用 `user:<id>` 召回舊的真人對話，排程內容則留在 `scheduler:<id>`。

## 關鍵差異
| 項目 | 變更前 | 變更後 |
|------|--------|--------|
| 舊真人對話的 scope | `project:TeleNexus` | `user:<user_id>` |
| 舊排程產出的 scope | `project:TeleNexus` | `scheduler:<user_id>` |
| 舊 session 的 summary | `user=… platform=… source=pipeline passthrough=…` | 與目前同步相同的格式：`使用者 → 模型`，每邊最多 240 字 |
| 無法確認歸屬的 session | 留在舊分區 | 仍留在舊分區，並列入人工審閱清單 |
| 回復方式 | 無 | 寫入前自動產生的資料庫備份 |

## 涉及檔案
### 遷移工具
- `src/tools/memoria-legacy-scope-cli.ts` - 新增 CLI，隨 release 映像出貨（`dist/tools/`）
- `src/services/memoria-legacy-scope.ts` - 新增分類、預覽、備份、改寫與紀錄的邏輯
- `src/core/memoria-sync.ts` - 匯出現有的 summary 組法給遷移重用，行為不變
- `package.json` - 新增 npm script

### 文件
- `docs/installation.md` - 「升級」下新增舊記憶遷移的操作步驟與回復方式
- `docs/configuration-reference.md` - 視需要補上工具的選項說明

### 測試
- `tests/memoria-legacy-scope.test.ts` - 新增；以 Memoria 1.28.1 的資料表結構建立合成資料

## Gherkin 驗收劇本

```gherkin
Feature: 把舊版 project scope 的 Memoria 記憶分類遷移到聊天與排程分區

  Background:
    Given 一個 Memoria 1.28.1 的 sessions.db，含有 project:TeleNexus 分區的舊 session
    And 每個 session 的 UserMessage 事件 metadata 記有 platform 與 user_id

  @SCN-001
  Scenario: 預設只預覽，不改動資料
    When 操作人員不加 --write 執行遷移工具
    Then 輸出依目標分區列出預計遷移的筆數，以及人工審閱的筆數與原因
    And 資料庫檔案內容與執行前相同
    And 沒有產生備份檔或遷移紀錄

  @SCN-002
  Scenario: 寫入時依事件記錄的來源分區並重建 summary
    When 操作人員加上 --write 執行遷移工具
    Then platform 為 scheduler 的 session 移到 scheduler:<user_id>
    And platform 為 telegram 或 console 的 session 移到 user:<user_id>，passthrough 指令也一樣
    And 每個遷移的 session 的 summary 由它的 UserMessage 與 ModelMessage 重建，格式與目前同步寫入的相同
    And 這些 session 的舊索引節點已移除，交給 Memoria 重建
    And 所有事件的筆數與內容不變，session ID 不變

  @SCN-003
  Scenario: 寫入前備份並留下遷移紀錄
    When 操作人員加上 --write 執行遷移工具
    Then 改寫之前已產生整個資料庫的備份檔
    And 產生一份遷移紀錄，逐筆列出 session ID、原 scope、新 scope 與分類依據，並附各分區與人工審閱的統計
    And 輸出寫明備份檔與遷移紀錄的位置

  @SCN-004
  Scenario: 無法確認歸屬的 session 不遷移
    Given 有 session 缺少 user_id、platform 不是 telegram／console／scheduler、沒有 UserMessage 或有多筆 UserMessage，或 UserMessage 與 ModelMessage 記錄的 platform 或 user_id 不一致
    When 操作人員加上 --write 執行遷移工具
    Then 這些 session 的 scope 與 summary 維持不變
    And 它們以 session ID 與原因列在人工審閱清單

  @SCN-005
  Scenario: 多位使用者各自分區
    Given 舊分區裡有兩位不同 user_id 的對話與排程產出
    When 操作人員加上 --write 執行遷移工具，再以 Memoria 重建索引
    Then 以其中一位的 user scope 召回，只會得到他自己的對話
    And 以 user scope 召回不會得到任何排程產出

  @SCN-006
  Scenario: 重跑不重複處理
    Given 已經成功執行過一次 --write
    When 操作人員再次加上 --write 執行遷移工具
    Then 遷移 0 筆，已遷移的 session 不變
    And 沒有可遷移的 session 時不產生新的備份檔，只回報剩下的人工審閱清單

  @SCN-007
  Scenario: Memoria 服務仍在執行時拒絕寫入
    Given 遷移工具能連上設定的 Memoria 服務
    When 操作人員加上 --write 執行遷移工具
    Then 工具以非 0 結束，說明要先停止 Memoria
    And 資料庫沒有改動，也沒有產生備份檔

  @SCN-008
  Scenario: 資料不符預期時中止
    Given 資料庫的完整性檢查沒有通過，或缺少遷移需要的資料表或欄位
    When 操作人員執行遷移工具，不論有沒有 --write
    Then 工具以非 0 結束並說明原因
    And 資料庫沒有改動，也沒有產生備份檔

  @SCN-009
  Scenario: 改寫中途失敗時整批回滾
    Given 改寫進行到一半時發生錯誤
    When 遷移工具結束
    Then 工具以非 0 結束並說明原因
    And 資料庫內容與執行前相同

  @SCN-010
  Scenario: 依文件以備份回復
    Given 已經執行過 --write
    When 操作人員依文件停止 Memoria，並以備份檔覆蓋資料庫
    Then 資料庫內容與遷移前相同

  @SCN-011
  Scenario: 依文件在 Docker Compose 部署上完成整個流程
    Given 一個以 release 映像運作的 Compose 部署，Memoria 的 volume 裝著舊資料的副本
    When 操作人員依文件停止 Memoria、以 telenexus 映像執行遷移、以 Memoria 映像重建索引、再啟動 Memoria
    Then 每一步都成功，Memoria 的健康檢查通過
    And 聊天使用的 user scope 召回得到遷移過來的舊真人對話

  @SCN-012
  Scenario: 在資料副本上量測遷移前後的召回
    Given 另一台部署的資料副本，以及執行前就凍結的問句：舊決策 10 題、遷移前就存在的資料 2 題、無關的對照 4 題
    When 分別在遷移前與遷移後，以聊天相同的 payload 召回
    Then 證據列出每組問句在遷移前後的命中數、實際會注入的題數與 confidence
    And 遷移後舊決策的命中數高於遷移前
    And 遷移前就存在的資料遷移後仍然命中
    And 注入的結果裡沒有排程產出，也沒有其他 scope 的資料
    And 無關問句的注入率照實列出，不設通過門檻
```

## Gherkin 核准紀錄
- **核准 commit**: ee4340b
- **核准來源**: 使用者 2026-10-21 對話的逐題確認。Q1「遷移工具要在哪裡、以什麼方式執行」選「telenexus 映像內的腳本（建議）」（SCN-011）。Q2「遷移後無關問句的 confidence 上升，要在本 issue 處理嗎」選「本 issue 只量測，校準另開（建議）」（SCN-012、TBD-1）。Q3「出錯時要怎麼回復」選「寫入前自動備份整個 DB（建議）」（SCN-003、SCN-010）。之後列出 SCN-001～SCN-012 請使用者確認，選「全部照寫核准（建議）」。

全部 Scenario 於 2026-10-21 核准。

## 重構步驟概要
1. ✅ **步驟 1** - 在拋棄式 Compose 部署上驗證操作路徑
2. ✅ **步驟 2** - 遷移工具的分類、預覽與防護
3. ⏳ **步驟 3** - 寫入、備份、紀錄與回滾
4. ⏳ **步驟 4** - 在資料副本上端到端量測
5. ⏳ **步驟 5** - 操作文件與常青文件

詳細步驟見 [implementation-plan.md](implementation-plan.md)。

## 風險與首要驗證

- **最大風險**：在正式的 Memoria 資料庫上改寫，造成資料遺失或索引損壞，而且無法回復。另外，操作路徑有多個沒驗證過的前提：Compose 怎麼把 named volume 掛進 telenexus 容器、容器使用者對資料檔有沒有寫入權限、映像的 entrypoint 會不會干擾、Memoria 1.28.1 容器能不能在唯讀 rootfs 下跑 `memoria index build`、以備份覆蓋後 Memoria 能不能正常啟動。
- **風險等級與理由**：High。這是對正式資料的寫入操作，出錯不能靠重跑修正；操作在遠端模式的容器之間進行，前提都還沒實際跑過。
- **首要驗證**：主要實作之前，先在拋棄式 Compose 專案上，用資料副本與 release 映像實際跑一次完整路徑：停 Memoria、掛 volume、備份、以調查腳本改寫、重建索引、啟動 Memoria、召回，再以備份覆蓋、確認回復。
- **選擇理由**：工具的邏輯可以用單元測試涵蓋，但上面那些前提只有實際跑一次才知道；如果其中一項不成立，工具的介面（資料庫路徑、備份位置、服務檢查）就得改，所以要排在寫工具之前。
- **完成證據**：步驟 1 的證據列出每個命令與結果；回復後資料庫各資料表的筆數與遷移前相同，Memoria 健康檢查通過。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | 遷移後的召回門檻或排序重新校準 | 不影響本次交付 | 使用者 2026-10-21 選「本 issue 只量測，校準另開」。步驟 4 量測完成後，以量測結果另開 GitHub issue。 |
| TBD-2 | GitHub #15 提到的「獨立呈現升級後的召回指標」 | 不影響本次交付 | 本 issue 只在資料副本上量測（SCN-012），不新增執行期的指標。結案時一併回報，由使用者決定要不要另開。 |

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-10-21 | 不開 PR；改由獨立 subagent 在本機審查 `main..HEAD`，合併由使用者決定 | 交付方式選「分支＋本機審查（建議）」 | 沒有 GitHub 上的 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-20 | 調查分類依據並在資料副本上模擬遷移（evidence/） | - |
| 2026-10-21 | 建立；逐題確認執行方式、門檻校準範圍與回復方式 | 使用者 |
| 2026-10-21 | SCN-001～SCN-012 核准；記錄不開 PR 的 Gate 豁免 | 使用者 |

---
**建立日期**: 2026-10-21  
**分級**: Medium  
**風險**: High\
**狀態**: 進行中
