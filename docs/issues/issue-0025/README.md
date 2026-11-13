# Issue 0025 - 技能收成命令，以及本機建置不再打包工作中的 workspace

GitHub：[#25](https://github.com/raybird/telenexus/issues/25)

## 文件清單
- [implementation-plan.md](./implementation-plan.md)

## 概述

`./workspace` 以 bind mount 掛進容器。agent 在容器裡摸索出可以固定下來的做法，會寫成 skill 放進 `workspace/.opencode/skills/`，維護者在主機上就拿得到，這是刻意的設計。收成時卻得自己判斷哪些是新的，因為這個目錄混著內建技能、agent 做的技能、已退役的技能與 symlink。另外，`scripts/sync-skills.mjs` 只補缺少的目錄，所以和 `skills/` 不同的副本可能只是舊版內建，不代表有人改過；下表的 rag-skill 與 scheduler 正好各是一例。

本 issue 做兩件事：
- 新增主機端的收成命令 `npm run skills:harvest`。它把技能分類列出，並可用 `--promote` 把技能收進 repo 的 `skills/`。
- `.dockerignore` 只讓 `workspace/` 的骨架檔進入建置內容。

已確認的現況（2026-11-12，唯讀查核正式部署的 `workspace/.opencode/skills`）：

| 技能 | 與 repo `skills/` 比對 | 實際身分 |
|---|---|---|
| bmad-astrology-expert、memory、skill-creator、tao-of-opencode、web-reading | 相同 | 內建 |
| rag-skill | 不同（frontmatter `name` 是 `kb-retriever`） | 舊版內建：與 `7e60af6` 的 `skills/rag-skill` 完全相同 |
| scheduler | 不同 | 被改過：`SKILL.md`（git blob `15f041c1`）不在 `skills/scheduler` 的任何歷史版本裡；多了要求排程用 agent-browser 抓即時資料、各排程的 Prompt 範本等段落 |
| stock-analysis（21 個檔案）、skill-linker | `skills/` 沒有，也從未出現在 `skills/` 的歷史 | agent 做的 |
| memoria-memory-sync | symlink | 指向 Memoria 的技能 |

repo 自己的 `workspace/.opencode/skills` 另有 `agent-browser`：它在 `04f5f2d`～`718cc8b` 之間存在於 `skills/`，現在已退役。

建置方面：
- git 追蹤的 `workspace/` 只有 4 個檔案：`.gitignore`、`.opencode/opencode.json`、`.opencode/skills/.gitkeep`、`projects/.gitkeep`。
- `.dockerignore` 只排除 `workspace/temp/`。本機 `docker build .` 會把整個工作中的 `workspace/` 打包進映像，2026-11-12 量到 144 MB。
- `release.yml` 從乾淨的 checkout 建置，GHCR 映像不受影響。

**不在範圍內**：
- 改變 bind mount 或 agent 寫技能的位置。
- 自動 promote 或自動 commit。
- 改變啟動時的技能同步策略。
- 讀取 named volume 裡的全域技能目錄（Q1）。

## 現況

**現行 review**: review-6b43d9c.md

| 外部狀態 | 查證命令 | 上次結果 | 查證日期 |
|---|---|---|---|
| GitHub issue #25 | `gh issue view 25 --repo raybird/telenexus --json state -q .state` | CLOSED（使用者同意關閉） | 2026-11-13 |
| origin 的 main 含本 issue | `git merge-base --is-ancestor 90ce534 origin/main && echo yes` | yes | 2026-11-13 |
| 併入 main | `git branch --list main --contains feat/issue-0025-skill-harvest` | main（2026-11-13 快轉到 90ce534；分支本身不推送） | 2026-11-13 |

## 快速導覽

### 當前流程
維護者自己列出 `workspace/.opencode/skills`，逐一和 `skills/` 比對，判斷哪些是新的，再手動複製。和 `skills/` 不同的副本，看不出是舊版還是被改過。

### 重構後流程
維護者執行 `npm run skills:harvest`，或加 `--from <部署的 workspace>`。命令列出三類：新技能、被改過的內建技能（附差異）、略過（附原因）。看完後用 `--promote <名稱>` 收進 `skills/`，自己檢查內容後再 commit。

## 關鍵差異
| 項目 | 變更前 | 變更後 |
|------|--------|--------|
| 找出 agent 做的技能 | 人工比對目錄 | 命令列出「新技能」 |
| 和 `skills/` 不同的副本 | 分不出舊版或被改過 | 比對 `skills/` 的 git 歷史後分類 |
| 收進 `skills/` | 手動複製 | `--promote`，同名需 `--force`，含檢查與警告 |
| 本機 `docker build .` 的 `/app/workspace` | 整個工作目錄 | 只有 4 個骨架檔，與 CI 相同 |

## 涉及檔案

```text
.
├── scripts/harvest-skills.mjs   # 新增：收成命令，主機端執行，不進映像的執行路徑
├── package.json                 # 可改：新增 skills:harvest script
├── .dockerignore                # 可改：workspace/ 只放行 4 個骨架檔
├── tests/                       # 新增：收成命令測試、.dockerignore 規則測試
├── CLAUDE.md                    # 可改：Common Commands 加 skills:harvest
├── CONTRIBUTING.md              # 可改：開發流程補上收成與本機建置說明
├── scripts/sync-skills.mjs      # 不可觸及：啟動同步策略不變
├── Dockerfile                   # 不可觸及：COPY workspace 照舊，由 .dockerignore 限縮內容
└── docker-compose*.yml          # 不可觸及
```

## Gherkin 驗收劇本

```gherkin
Feature: 從 workspace 收成 agent 做出的技能

  Background:
    Given 在 TeleNexus 的 git checkout 裡執行 npm run skills:harvest
    And 被掃描的是 <workspace>/.opencode/skills，<workspace> 預設為 repo 的 workspace/

  @SCN-001
  Scenario: 列出新技能
    Given workspace 有一個技能目錄，名稱不在 skills/，也從未出現在 skills/ 的 git 歷史
    When 執行收成命令
    Then 它列在「新技能」，附檔案數
    And 命令以結束碼 0 結束，repo 的檔案沒有任何變動

  @SCN-002
  Scenario: 被改過的內建技能附差異
    Given workspace 的某個技能與 skills/ 同名，內容和 skills/ 該技能在 git 歷史上的每個版本都不同
    When 執行收成命令
    Then 它列在「被改過的內建技能」，並附上與目前 skills/ 版本的差異

  @SCN-003
  Scenario: 舊版內建技能不算被改過
    Given workspace 的某個技能與 skills/ 同名，內容和目前版本不同，但與 git 歷史上的某個版本完全相同
    When 執行收成命令
    Then 它列在「略過」，原因寫明是舊版內建、未被修改，並標出相符的版本

  @SCN-004
  Scenario Outline: 其他情況列在略過並寫明原因
    Given workspace 的某個技能是 <情況>
    When 執行收成命令
    Then 它列在「略過」，原因是「<原因>」

    Examples:
      | 情況                                  | 原因       |
      | symlink                               | symlink    |
      | 與目前 skills/ 版本完全相同            | 與內建相同 |
      | 不在目前的 skills/，但出現在 git 歷史  | 已退役內建 |

  @SCN-005
  Scenario: 指定其他 workspace
    When 以 --from 指向另一個部署的 workspace 執行
    Then 掃描的是該處的 .opencode/skills，比對基準仍是本 repo 的 skills/ 與其歷史
    And --from 指向的路徑沒有 .opencode/skills 時，命令以非 0 結束碼結束並說明找不到

  @SCN-006
  Scenario: promote 新技能
    Given 「新技能」裡有 stock-analysis，目錄裡有 SKILL.md、沒有 symlink
    When 執行收成命令並加 --promote stock-analysis
    Then skills/stock-analysis 與 workspace 的副本內容完全相同
    And 輸出提醒 commit 前先自己檢查內容
    And 不會建立 git commit，也不會改動 skills/ 以外的檔案

  @SCN-007
  Scenario Outline: promote 拒絕不安全或會覆寫的情況
    Given 要 promote 的技能是 <情況>
    When 執行收成命令並加 --promote 該名稱，不加 --force
    Then 命令以非 0 結束碼結束並說明原因，skills/ 沒有任何變動

    Examples:
      | 情況                              |
      | skills/ 已有同名技能              |
      | 目錄裡沒有 SKILL.md               |
      | 目錄裡含 symlink                  |
      | workspace 沒有這個名稱            |
      | 名稱含路徑分隔符號或 ..           |

  @SCN-008
  Scenario: 以 --force 覆寫同名內建技能
    Given skills/ 已有同名技能，workspace 的版本少了一個檔案、改了另一個檔案
    When 執行收成命令並加 --promote 該名稱 --force
    Then skills/ 該技能與 workspace 的副本完全相同，少掉的檔案也從 skills/ 移除

  @SCN-009
  Scenario Outline: promote 照樣複製但提出警告
    Given 要 promote 的技能 <情況>
    When 執行收成命令並加 --promote 該名稱
    Then 照樣複製進 skills/，輸出警告指出 <警告內容>

    Examples:
      | 情況                                     | 警告內容                         |
      | SKILL.md frontmatter 的 name 與目錄名不同 | 兩個名稱                         |
      | 內容疑似含 token                         | 檔案與行號，不印出疑似 token 本身 |
      | 內容含本機絕對路徑（/home/ 開頭）        | 檔案與行號                       |

  @SCN-010
  Scenario: 本機建置不打包工作中的 workspace
    Given 工作目錄的 workspace/ 有同步出來的技能、context 與其他執行期資料
    When 在工作目錄以 Docker 建置，建置內容套用 .dockerignore
    Then 建置內容裡的 workspace/ 只有 .gitignore、.opencode/opencode.json、.opencode/skills/.gitkeep、projects/.gitkeep
```

## Gherkin 核准紀錄
- **核准 commit**: 6b5392d
- **核准來源**: 使用者於 2026-11-12 對話回「照建議」（Q1～Q5：掃描範圍、分類方式、同名處理、promote 檢查、`.dockerignore` 範圍），之後對 SCN-001～010 回「照寫核准」。

| Scenario | 核准日期 | 狀態 |
|----------|---------|------|
| SCN-001 | 2026-11-12 | 已核准 |
| SCN-002 | 2026-11-12 | 已核准 |
| SCN-003 | 2026-11-12 | 已核准 |
| SCN-004 | 2026-11-12 | 已核准 |
| SCN-005 | 2026-11-12 | 已核准 |
| SCN-006 | 2026-11-12 | 已核准 |
| SCN-007 | 2026-11-12 | 已核准 |
| SCN-008 | 2026-11-12 | 已核准 |
| SCN-009 | 2026-11-12 | 已核准 |
| SCN-010 | 2026-11-12 | 已核准 |

## 重構步驟概要
1. ✅ **`.dockerignore` 限縮 workspace**（SCN-010，首要驗證）
2. ✅ **收成命令：列出與分類**（SCN-001～005）
3. ✅ **收成命令：promote**（SCN-006～009）
4. ✅ **常青文件與交付檢查**

細節見 [implementation-plan.md](implementation-plan.md)。

## 風險與首要驗證

- **最大風險**：`.dockerignore` 的放行規則沒照預期生效：骨架檔被排除，映像少了 `opencode.json`；或排除沒生效，問題照舊。Docker 對「排除目錄後再放行其中檔案」的處理，和 `.gitignore` 不完全一樣。
- **風險等級與理由**：Low。收成命令只在主機執行，不進入任何服務的執行路徑；promote 只寫 `skills/`，由維護者 commit。`.dockerignore` 只影響建置內容，正式部署的 `/app/workspace` 由 bind mount 蓋過。
- **首要驗證**：用同一份 `.dockerignore`，以只做 `COPY workspace` 的最小 Dockerfile 在工作目錄建置，列出映像裡的檔案。
- **選擇理由**：Docker 實際套用的規則只有建置看得到；最小 Dockerfile 幾秒就跑完，不必建整個映像。
- **完成證據**：建置內容的 `workspace/` 正好是 4 個骨架檔；拿掉放行規則時，結果會不同。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | SCN-001～010 推導出的行為等待核准：結束碼（列出 0、promote 被拒或 --from 找不到時非 0）、三類輸出、略過的原因字樣、警告內容不印出疑似 token 本身 | 已解決（2026-11-12）：使用者回「照寫核准」，照寫 | SCN-001～010 |
| TBD-2 | 審查 review-a716fc7.md 的 S2：promote 只拒絕整個名稱等於 `..`，`a..b` 會被複製，但 SCN-007 核准的是「名稱含路徑分隔符號或 ..」 | 已解決（2026-11-13）：使用者選 (a)，名稱含 `..` 一律拒絕，符合核准原文，不需重新核准 | SCN-007 |
| TBD-3 | 重新審查 review-6b43d9c.md 的 SHOULD FIX：單一技能檔案多到上萬時，`git hash-object` 參數過長（實測 15,001 個失敗、8,001 個正常），列出命令印錯誤並結束 | 不影響本次交付（2026-11-13）：使用者選 (a) 記為殘餘風險。追蹤：無——失敗時有明確錯誤、不分錯類、不改檔案，兩個部署最大的技能是 21 個檔案；真的遇到時改成分批呼叫 | SCN-001～005 |

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-11-12 | 不開 PR；實作在 `feat/issue-0025-skill-harvest` 分支，由獨立 subagent 在本機審查，合併由使用者決定 | 對「實作會在 `feat/issue-0025-skill-harvest` 分支上做，和 #24 一樣由本機獨立審查，不開 PR」回「照寫核准」 | GitHub 上沒有 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-11-12 | 建立 GitHub issue #25 | 使用者 |
| 2026-11-12 | Q1～Q5 回「照建議」；建立 issue 文件，SCN-001～010 待核准 | 使用者 |
| 2026-11-12 | SCN-001～010 核准（「照寫核准」）；實作在 `feat/issue-0025-skill-harvest` 分支，本機獨立審查，不開 PR | 使用者 |
| 2026-11-12 | 更正概述的現況表：scheduler 是被改過，不是舊版內建。當初手動查證時把另一條命令的輸出誤當成 `--find-object` 的結果；步驟 2 的收成命令與重新查證都顯示 blob `15f041c1` 不在歷史裡。Scenario 不受影響 | - |
| 2026-11-12 | 獨立審查 review-a716fc7.md 判定 RETURN TO execute-task：MUST FIX 含中文或引號的檔名比對錯誤；SHOULD FIX 3 項，其中 S2 需決策 | - |
| 2026-11-13 | 使用者對 S2 選 (a)：名稱含 `..` 一律拒絕（TBD-2） | 使用者 |
| 2026-11-13 | 重新審查 review-6b43d9c.md 判定 PASS，有 1 項 SHOULD FIX（技能檔案上萬時 hash-object 參數過長）。保存報告後，kit main（b5b5bec）的 verify-artifact.py 判定 OK；全域安裝的舊版（2026-09-14）不認得流程契約 2.5 的現行 review，判定 INVALID | - |
| 2026-11-13 | 使用者對重新審查的 SHOULD FIX 選 (a)，記為殘餘風險（TBD-3）；同意快轉併入 main 並推送 | 使用者 |
| 2026-11-13 | 分支快轉併入 main（90ce534）並推送 origin main；GitHub #25 仍開著，未發版 | 使用者 |
| 2026-11-13 | 結案：關閉 GitHub #25，依 Gate 豁免不開 PR，以快轉合併為結案依據；暫不發版 | 使用者 |

---
**建立日期**: 2026-11-12
**分級**: Medium
**風險**: Low
**狀態**: 已完成
