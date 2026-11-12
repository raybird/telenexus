# Issue 0024 - 網頁閱讀加一層 Moli：JS 頁面先用 moli fetch，失敗才退回 Chrome MCP

GitHub：[#24](https://github.com/raybird/telenexus/issues/24)

## 文件清單
- [implementation-plan.md](./implementation-plan.md)

## 概述

issue 0010 之後，`web-reading` 技能分兩層：一般頁面用 `webfetch`；正文要跑 JavaScript 才出現時，用 `telenexus_browser`，也就是 `chrome-devtools-mcp@1.10.1` 加上 Chrome for Testing 154，由 `scripts/browser-mcp-launcher.mjs` 負責每個工作的收尾。只為了讀一段 JS 渲染出來的正文就開一整個 Chrome，成本很高。

[Moli](https://github.com/lexmount/moli) 是 Rust 寫的 headless 瀏覽器（Apache-2.0/MIT，2026-11-09 發布 v1.1.23），有一次性的 `moli fetch --dump markdown`。依它公布的數據，抓公開網頁的成功率和 Chrome headless 相近（53.6% 對 52.6%），中位數 RSS 是 73 MiB，Chrome 是 773 MiB。抓完程序就結束。這些數字是上游自己公布的，我們的環境還沒有實測。

本 issue 採方案 A：在 `webfetch` 和 Chrome MCP 之間加一層 Moli，Chrome 只在 Moli 失敗時使用。

已確認的現況（2026-11-11）：
- `skills/web-reading/SKILL.md` 從 2026-10-05（`718cc8b`）起只有一個版本，sha256 是 `03821d8d10abfb032b28abe8cb1127c93d80618a49ae49f6e434fbe70b9c1ed3`，維護者正式部署的 workspace 副本也是同一個雜湊。
- `scripts/sync-skills.mjs` 只複製 workspace 還沒有的技能目錄，所以現有部署升級後拿不到新版的 `web-reading`。`agent-browser` 的退役用的是雜湊比對（`scripts/retired-agent-browser.json`、`retireBuiltinBrowser()`）。
- 模型透過 opencode 的 bash 工具執行指令；runner 設定裡沒有限制 bash 權限。
- `.github/workflows/release.yml` 沒有設定 `platforms`，映像只建 linux/amd64。
- Moli 的 `fetch` 有 `--block-private-networks`；官方安裝方式是 `curl | sh` 抓 latest，release 也提供 `moli-x86_64-unknown-linux-gnu.tar.gz`（45 MB）。

**不在範圍內**：
- 用 Moli 取代 Chrome，或讓 `chrome-devtools-mcp` 改連 `moli serve`（方案 B）。
- 替 Chrome MCP 加內網或 scheme 限制。Moli 拒絕的網址照常可以退回 Chrome（Q5）。
- 登入、表單、跨回合瀏覽器狀態（沿用 issue 0010 的範圍）。
- arm64 映像。

## 現況

**現行 review**: review-b38af46.md

| 外部狀態 | 查證命令 | 上次結果 | 查證日期 |
|---|---|---|---|
| GitHub issue #24 | `gh issue view 24 --repo raybird/telenexus --json state -q .state` | OPEN | 2026-11-12 |
| 分支推送到 origin | `git ls-remote --heads origin feat/issue-0024-moli-web-reading` | 沒有輸出（未推送） | 2026-11-12 |
| 併入 main | `git branch --list main --contains feat/issue-0024-moli-web-reading` | 沒有輸出（未併入） | 2026-11-12 |

## 快速導覽

### 當前流程
`webfetch` 讀到正文就結束 → 只拿到殼層時，用 `telenexus_browser_navigate` 加 `telenexus_browser_evaluate` 開 Chrome 讀取 → 都失敗就明確回報讀取失敗。

### 修改後流程
`webfetch` 讀到正文就結束 → 只拿到殼層時，執行 `telenexus-moli-fetch <網址>`（固定參數、30 秒硬逾時、封鎖內網）→ wrapper 結束碼非 0，或讀到的內容沒有所需正文時，才開 Chrome → 都失敗就明確回報讀取失敗。

## 關鍵差異

| 項目 | 變更前 | 變更後 |
|------|--------|--------|
| JS 頁面的第一選擇 | Chrome MCP | Moli wrapper |
| Chrome MCP | JS 頁面一律使用 | 只在 Moli 失敗時使用；設定與收尾不變 |
| 內網位址 | Chrome 可讀 | Moli 拒絕，之後照常退回 Chrome |
| 現有部署的 `web-reading` | 升級不更新 | 跟已出貨舊版雜湊相符時換新並備份；有客製內容就保留並警告 |
| 映像 | Chrome、chrome-devtools-mcp | 另外加上釘版的 Moli 與 wrapper |

## 涉及檔案

```text
.
├── Dockerfile                          # 可改：base stage 以 tarball + sha256 釘版安裝 Moli，COPY wrapper
├── scripts/
│   ├── moli-fetch.sh                   # 新增：wrapper，安裝成 /usr/local/bin/telenexus-moli-fetch
│   ├── sync-skills.mjs                 # 可改：雜湊相符的舊版 web-reading 換新並備份
│   ├── retired-web-reading.json        # 新增：已出貨舊版的檔案雜湊
│   └── browser-mcp-launcher.mjs        # 不可觸及：Chrome 收尾維持 issue 0010 的行為
├── skills/web-reading/SKILL.md         # 可改：加入 Moli 層與退回規則（改動時用 writing-rules）
├── src/core/opencode.ts                # 不可觸及：telenexus_browser 的 MCP 設定不變
├── src/prompt/builder.ts               # 可改：三種聊天提示詞加上網頁讀取順序（SCN-009，Q13 新增）
├── docker-compose*.yml                 # 不可觸及：不新增服務或環境變數
├── tests/                              # 新增：wrapper、映像釘版、技能升級的測試
└── docs/ / CLAUDE.md / ARCHITECTURE.md # 可改：依常青文件責任更新（見 implementation-plan 步驟 7）
```

## Gherkin 驗收劇本

```gherkin
Feature: JS 正文先用 Moli 讀取，失敗才開 Chrome

  @SCN-001
  Scenario: 一般公開頁面仍只用 webfetch
    Given HTTP 就能取得正文的受控頁面
    When 經實際 OpenCode 工具路徑讀取
    Then 回覆包含 fixture 預先定義的正文與來源網址
    And 這個工作沒有執行 Moli wrapper，也沒有啟動 Chrome

  @SCN-002
  Scenario: JS 頁面由 Moli 讀到正文，不啟動 Chrome
    Given 正文必須執行 JavaScript 才出現、Moli 能渲染的受控頁面
    When 經實際 OpenCode 工具路徑讀取
    Then 回覆包含 fixture 預先定義的正文與來源網址
    And 這個工作執行過 Moli wrapper，而且沒有啟動 Chrome

  @SCN-003
  Scenario Outline: Moli 失敗時退回 Chrome
    Given 正文必須執行 JavaScript 才出現的受控頁面，而 <情況>
    When 經實際 OpenCode 工具路徑讀取
    Then Moli wrapper 以非 0 結束，或輸出不含所需正文
    And 接著使用 telenexus_browser，回覆包含 fixture 預先定義的正文與來源網址

    Examples:
      | 情況 |
      | 頁面超過 30 秒仍未完成載入 |
      | Moli 以非 0 結束 |
      | Moli 的 Markdown 輸出是空的，或只有頁面殼層 |
      | 網址是 Moli 封鎖的內網位址 |

  @SCN-004
  Scenario: Moli 與 Chrome 都讀不到時明確回報失敗
    Given Moli 與 Chrome 都讀不到正文的受控頁面
    When 經實際 OpenCode 工具路徑讀取
    Then 回覆明確說明讀取失敗，不捏造正文

  @SCN-005
  Scenario Outline: Moli wrapper 在每種結束路徑都不留下程序與暫存檔
    Given Moli wrapper 正在讀取一個受控頁面
    When 發生 <結果>
    Then wrapper 啟動後 45 秒內，容器裡沒有這次執行留下的 moli 程序或 zombie
    And 沒有這次執行留下的暫存目錄或 profile

    Examples:
      | 結果 |
      | 正常完成 |
      | 超過 30 秒硬逾時 |
      | Moli 以非 0 結束 |
      | 使用者取消這個聊天回合 |

  @SCN-006
  Scenario Outline: Moli wrapper 只接受一個 http/https 網址，並封鎖內網
    When 以 <參數> 執行 telenexus-moli-fetch
    Then wrapper 以非 0 結束，stdout 沒有頁面內容，stderr 說明原因

    Examples:
      | 參數 |
      | （沒有參數） |
      | 兩個網址 |
      | file:///etc/hostname |
      | data:text/html,<p>x</p> |
      | --dump html https://example.com |
      | 指向 127.0.0.1 的網址 |
      | 指向容器網路服務名稱（例如 memoria）的網址 |

  @SCN-007
  Scenario: 映像內建釘版的 Moli
    Given 從 Dockerfile 建出的 dev 與正式映像
    Then 兩者的 moli --version 都等於 Dockerfile 釘的版本
    And Dockerfile 以 sha256 驗證下載的 tarball，雜湊不符時建置失敗
    And Dockerfile 不使用 latest 或 curl | sh 的安裝方式

  @SCN-008
  Scenario Outline: 技能同步把 web-reading 送到新舊部署
    Given workspace 的技能目錄 <狀態>
    When 執行技能同步
    Then <結果>
    And 再同步一次，結果不變

    Examples:
      | 狀態 | 結果 |
      | 沒有 web-reading | 複製新版 web-reading |
      | 有 web-reading，內容和已出貨的舊版雜湊完全相同 | 換成新版，舊版備份到 retired-skills |
      | 有 web-reading，內容被改過或多了檔案 | 原地保留並輸出警告，不覆寫 |
      | 已經是新版 web-reading | 不變 |

  @SCN-009
  Scenario Outline: 聊天提示詞帶著網頁讀取順序
    When TeleNexus 以 <模式> 組出聊天提示詞
    Then 提示詞在使用者訊息之前寫明：先用 webfetch，讀到所需正文就以它回答；只取得殼層時以 bash 執行 telenexus-moli-fetch；仍讀不到才用 telenexus_browser

    Examples:
      | 模式 |
      | full |
      | compact |
      | minimal |
```

## Gherkin 核准紀錄
- **核准 commit**: aae0a8d
- **核准來源**: 使用者於 2026-11-11 對話要求「先以 a 方案開 github issue」，並在逐題確認中全部選建議答案：
  - Q1「Moli 失敗才退回 Chrome」：順序是 webfetch → Moli → Chrome，技能仍只做公開唯讀閱讀（SCN-001～004）。
  - Q2「包一支固定參數的腳本」：模型只傳網址（SCN-005、SCN-006）。
  - Q3「封鎖內網」：Moli 加 `--block-private-networks`（SCN-006）。
  - Q4「分支＋本機獨立審查」：見 Gate 豁免紀錄。
  - Q5「照常退回 Chrome」：Moli 封鎖的網址照常退回 Chrome（SCN-003 第 4 例）。
  - Q6「30 秒，寫死」：wrapper 硬逾時 30 秒，不開環境變數（SCN-003 第 1 例、SCN-005）。
  - Q7「雜湊相符才自動換新」（SCN-008）。
  - Q8「只收 http/https」（SCN-006）。
  - 2026-11-12 使用者以「照寫核准」確認推導出的行為（TBD-3）：收尾窗口「wrapper 啟動後 45 秒內」（30 秒硬逾時加 issue 0010 的 15 秒收尾標準）、Markdown 輸出是空的也算 Moli 失敗、SCN-007 的映像釘版規則。
  - 2026-11-12 步驟 6 實測後的逐題確認：Q9 選「只用真模型」；Q11 選「改指引措辭後，用正式提示詞重測」；Q12 選「改成擬真頁面後重跑」；Q13 選「加常駐規則，額度恢復後重測」，該選項寫明在 full／compact／minimal 都加一行網頁讀取順序，新增 SCN-009。Q14 回「那使用容器內的 nvidia 提供的呢？」：第四輪改用正式部署 override 的 Nvidia 模型。
  - 核准 commit：SCN-001～008 的規格在 d7edd4e，SCN-009 在 aae0a8d 加入，因此取 aae0a8d（2026-11-12 審查 S2）。

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

## 重構步驟概要

步驟、產出與完成判準的唯一來源是 [implementation-plan.md](./implementation-plan.md) 的「實作步驟」。

1. ✅ **步驟 1** - 在拋棄式容器實測釘版 Moli（首要驗證）
2. ✅ **步驟 2** - 映像釘版安裝（SCN-007）
3. ✅ **步驟 3** - Moli wrapper（SCN-005、SCN-006）
4. ✅ **步驟 4** - 技能同步升級（SCN-008）
5. ✅ **步驟 5** - web-reading 指引（SCN-001～004）
6. ✅ **步驟 6** - 實際 OpenCode 工具路徑整合（SCN-001～005、SCN-009）
7. ✅ **步驟 7** - 常青文件與交付檢查

## 風險與首要驗證

- **最大風險**：釘版的 Moli 在我們的映像裡（`node:22-slim`、非 root、容器內沒有原生 sandbox）跑不起來，或讀不到 JS 渲染的正文。另一個風險是 `--block-private-networks` 把 loopback 上的 fixture 也擋掉，導致 SCN-002 在容器內沒有合法的驗證方式。只要其中一項成立，wrapper 和指引都白做，模型每一輪都會先多等一次失敗才開 Chrome。
- **風險等級與理由**：Medium。有一項重要未知（外部 binary 在本環境的相容性與行為），但 Chrome MCP 不變、失敗時仍會退回，影響有限而且容易回復；不涉及資料遷移或不可逆操作。技能同步會動到 workspace，但只換雜湊完全相符的舊版，而且先備份。
- **首要驗證**：主要實作前，在用現行映像建出的拋棄式容器裡，以 node 使用者執行釘版的 Moli tarball。確認以下幾點：`moli --version`、動態連結的相依是否齊全、issue 0010 的 HTTP 與 JS fixture 讀不讀得到預先定義的正文、`--block-private-networks` 對 loopback／RFC1918／容器服務名稱的行為與結束碼、逾時被 `timeout` 終止後有沒有殘留程序，以及 `fetch` 會不會寫入 `HOME`／`XDG_*`／`/tmp`。
- **選擇理由**：後續每一步（安裝方式、wrapper 的參數與暫存目錄、測試 fixture 放哪裡）都依賴這些答案。用契約探測直接驗外部 binary，比先寫 wrapper 再除錯更直接。
- **完成證據**：`docs/issues/issue-0024/evidence/step1-moli-probe.md` 記錄版本、tarball sha256、`ldd` 輸出、每個 fixture 的實際輸出與結束碼、封鎖行為對照表、逾時後的 `/proc` 採樣，以及檔案系統前後差異；並寫明 TBD-1、TBD-2 的結論。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | `--block-private-networks` 會擋 loopback，JS fixture 要放在哪裡，SCN-002 才能在不關掉封鎖的情況下驗證（例如拋棄式容器網路內的非保留位址、受控的公開頁面）；wrapper 不為測試開放關閉封鎖的參數 | 已解決（2026-11-12）：封鎖不擋非保留網段，fixture 放在拋棄式 Docker 網路的 `45.67.89.0/24`；內網的例子用同一個 fixture 的 RFC1918 位址與服務名稱（[步驟 1](evidence/step1-moli-probe.md#對-tbd-的結論)） | SCN-002、SCN-003、SCN-005 的驗證方式 |
| TBD-2 | 使用者取消時，opencode 的 bash 工具另開 session，wrapper 和 Moli 可能不會收到訊號，只能靠 30 秒硬逾時結束。另外 wrapper 本身被 SIGKILL 時，清理暫存目錄的 trap 不會執行 | 已解決（2026-11-12）：步驟 6 實測，取消時 runner 只終止 opencode，wrapper 被收養到 pid 1 繼續執行，Moli 自己的 10 秒逾時到了才結束並清掉暫存目錄（最壞情況靠 30 秒硬逾時），仍在 45 秒窗口內（[步驟 6](evidence/step6-opencode-path.md#收尾scn-005)）。取消訊號不會傳到 wrapper，維持現行設計 | SCN-005 |
| TBD-3 | 推導出的行為等待確認：收尾窗口「wrapper 啟動後 45 秒內」、Markdown 輸出是空的也算失敗、SCN-007 的釘版規則 | 已解決（2026-11-12）：使用者回「照寫核准」，三項照寫 | SCN-001～008 |
| TBD-4 | 第三次審查 S-C：web-reading 升級時新版複製到一半失敗，原處會留下截斷的技能，之後一直被判成客製內容 | 已解決（2026-11-12）：使用者選方案 1「修，再審一次」；改成先複製到暫存再換上，失敗時舊版移回原處 | SCN-008 |
| TBD-5 | 第四次審查 S-D、N-H：telenexus 與 agent-runner 第一次同時升級 web-reading 時，可能誤報「有自訂內容」或「備份已存在」、說新版未套用，實際已換上新版（200 輪 14 次）；升級在兩次改名之間被殺時，`retired-skills/.web-reading-new-*` 暫存目錄不會被清掉 | 不影響本次交付（2026-11-12）：使用者選方案 1「不修，記為殘餘風險」；最終狀態都正確，誤報每個部署最多一次。追蹤：https://github.com/raybird/telenexus/issues/26 | SCN-008 |

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-11-11 | 不開 PR；實作在 `feat/issue-0024-moli-web-reading` 分支，由獨立 subagent 在本機審查，合併由使用者決定 | Q4 選「分支＋本機獨立審查 (Recommended)」 | GitHub 上沒有 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-11-11 | 建立 GitHub issue #24 與本文件；逐題確認 Q1～Q8；SCN-001～008 待核准（TBD-3） | - |
| 2026-11-12 | 使用者回「照寫核准」：SCN-001～008 核准，TBD-3 解決 | 使用者 |
| 2026-11-12 | 步驟 2～5 完成並提交到分支；步驟 6 三輪真模型實測，TBD-2 解決；Q13 新增 SCN-009 並實作 | - |
| 2026-11-12 | 步驟 6 第四輪（常駐規則、擬真頁面、Nvidia 模型）8 個情境全部符合，步驟 6 完成 | - |
| 2026-11-12 | 步驟 7 完成；獨立審查 review-778ed0c.md 判定 PASS，有 4 項 SHOULD FIX | - |
| 2026-11-12 | 使用者選方案 1：修 S1（技能同步不因 web-reading 升級中止）、S4（內網封鎖的文件範圍），補 S3 證據，核准 commit 改為 aae0a8d（S2），之後重新審查 | 使用者 |
| 2026-11-12 | 重新審查 review-c71e203.md 判定 PASS，有 2 項 SHOULD FIX；使用者選方案 1：補 S-A、S-B、N-A、N-C 後再審一次 | 使用者 |
| 2026-11-12 | 第三次審查 review-aacbacc.md 判定 PASS，有 1 項 SHOULD FIX（S-C）；使用者選方案 1：修 S-C 並處理 N-E、N-F、N-G 後再審一次 | 使用者 |
| 2026-11-12 | 第四次審查 review-b38af46.md 判定 PASS，有 1 項 SHOULD FIX（S-D）；使用者選方案 1：S-D、N-H 記為殘餘風險（TBD-5），之後另開 issue | 使用者 |
| 2026-11-12 | 開 GitHub issue #26 追蹤 TBD-5；本機建置打包 workspace 的問題併入新功能 issue #25 | 使用者 |

---
**建立日期**: 2026-11-11  
**分級**: Medium  
**風險**: Medium\
**狀態**: 待審查
