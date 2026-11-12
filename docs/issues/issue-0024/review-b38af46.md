# 審查報告
- 範圍：完整 PR（分支 `feat/issue-0024-moli-web-reading` 對 main 的 merge-base；依 Gate 豁免紀錄不開 PR，改本機獨立審查）。這是第四次審查，涵蓋整個 632fef5..b38af46，不只 aacbacc 之後的 4 個提交
- Reviewed BASE SHA：632fef57da87e9b7f7b532022d1eeb8e0f16bebb
- Reviewed HEAD SHA：b38af46ef5cc41a27a26393d9ad973f6c0cd01cf
- Reviewed patch-id：759bd02020905b0ae847c666aaf9ecc039733a6b（`git diff 632fef5 b38af46 | git patch-id --stable`）
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，2026-11-12；沒有參與本 issue 的實作，也不是前三份報告的 reviewer（前三份報告只當作待查核的輸入）
- Review artifact：docs/issues/issue-0024/review-b38af46.md

審查日期：2026-11-12。審查依據：dev-rules-kit v4.10.0 試用版 `skills/review/SKILL.md`、本 repo 的 docs/AGENTS.md（流程契約 2.5）、docs/agents/project.md、acceptance.md、verification.md、review-evidence.md，以及 issue 0024 的 README、implementation-plan.md 與 evidence。`**核准 commit**` 是 `aae0a8d`，不是 `待提交`，所以本報告不另記推導的核准基線。

## 上一份報告（review-aacbacc.md）各項的處理結果

| 項目 | 結論 | 依據 |
|------|------|------|
| S-C 複製到一半失敗會留下截斷的技能 | **已解決** | `scripts/sync-skills.mjs:177-197` 先 `mkdtemp` 到 `retired-skills/.web-reading-new-*`、完整複製，再兩次改名；換上失敗時 `:192` 把舊版移回，`:196` 一律刪掉暫存。reviewer 把 b38af46 的測試套在 e0908f4 的同步腳本上，重現 2 個紅燈（13、14），失敗原因與目標行為直接相關（13：原處只剩截斷的新版；14：舊程式沒有「換上」這一步，回滾不存在）；換回 b38af46 的腳本 14/14 通過。另外抽驗 M2（拿掉回滾）、M3（不刪暫存）兩個突變，失敗的測試與 `review3-sc-mutations.log` 記錄的相同 |
| N-E S1 第 12 個測試不檢查警告內容 | **已解決** | `tests/skill-web-reading-upgrade.test.ts` 的 S1 第 12 個測試改成斷言 `/web-reading 未升級，保留原本的版本/`；M4（兩種訊息對調）讓它轉紅 |
| N-F `installation.md` 沒寫升級失敗的警告 | **已解決** | `docs/installation.md:177` 補上「web-reading 未升級，保留原本的版本」與它代表的狀態。只在回滾也失敗時才出現的另一種訊息（「舊版在 …，原處由接下來的同步補上新版」）沒有寫，這條路徑要兩次改名都失敗，可以接受 |
| N-G 呼叫端重組 `retired-skills` 路徑 | **已解決** | 抽出 `retiredSkillsDir()`（`:129-131`），兩處共用，重複已消除。呼叫端仍以「原處有沒有 web-reading」推斷狀態（`:211`），改成先複製到暫存之後，這個推斷在單一程序下都準確；只有兩個程序剛好交錯在回滾那一步才會不準（見 N-J） |
| N-A、N-C | 前一輪已解決，本輪沒有退步 | `implementation-plan.md:356` 已更正「找不到注入方式」的說法 |
| N-B、N-D、N1～N9 | **未處理**，與使用者選的範圍（S-C、N-E、N-F、N-G）一致 | `scripts/moli-fetch.sh`、Dockerfile、`src/`、`skills/` 自 859331a 起沒有變更，各項理由照舊成立。N1 由 reviewer 在 b38af46 再重現一次：呼叫端 export `MOLI_BIN` 時，第 29 行印出 `unset: MOLI_BIN: cannot unset: readonly variable`，Moli 的環境裡仍有 `MOLI_BIN` |

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

**S-D. 兩個服務同時第一次升級時，常會誤報「有自訂內容／備份已存在，新版網頁閱讀指引未套用」，而實際上新版已經換上** `需決策`
- 位置：
  - `scripts/sync-skills.mjs:154-155`：對同一個目錄先後掃兩次，一次比新版、一次比舊版；
  - `:161-168`：兩個警告分支；
  - `:137` 的註解「改名是兩者之間唯一的競爭點」。
- 機制：
  - 程序 B 第一次掃描時看到的是舊版，所以不符合新版。程序 A 接著用兩次改名，幾乎瞬間換上新版。B 第二次掃描時看到的是新版，所以也不符合舊版，就落到「有自訂內容」。
  - 另一種情況：B 判定符合舊版之後，A 才完成第一次改名。B 接著看到備份已存在，就落到「備份已存在」。
  - 兩種情況的最終狀態都正確，只有訊息錯。
- 重現：
  - 定點重現：在 scratchpad 以 `node --import` 載入一個模組，讓 B 第二次讀 `skills/web-reading/SKILL.md` 前暫停 0.8 秒，0.3 秒後啟動 A。A 印出 `Upgraded builtin web-reading`；B 印出 `web-reading 有自訂內容，已保留 …；新版網頁閱讀指引未套用，請人工比對 …`。最後原處的 SHA-256 與 `skills/web-reading/SKILL.md` 相同（`25594abe…`）。
  - 統計：兩個目標目錄、兩個程序同時跑，重複 200 輪，不注入延遲。最終狀態 200/200 正確：新版、一份備份、沒有暫存殘留、其他技能都在。誤報「有自訂內容」9 次、「備份已存在」5 次（共 800 次程序×目標）。另外 150 輪每次 fs 呼叫前後加 0～10 ms 隨機延遲，最終狀態全部正確，各誤報 1 次。
  - 對照：同樣 200 輪套在 aacbacc 的腳本上，「有自訂內容」0 次、「備份已存在」7 次。舊寫法改名之後還要複製，B 第二次掃描多半看到 ENOENT 而安靜結束；新寫法換上幾乎是瞬間，第二次掃描就多半看到新版。所以這是 S-C 修正讓已有的競爭變得常見，不是全新的錯誤。
- 影響：
  - 觸發點就在正常升級路徑：compose 同時啟動 telenexus 與 agent-runner，兩者共用 `./workspace` 與 `opencode_config`（`docker-compose.yml:23-31`、`:55`）。依上面的統計，每個部署第一次升級時，約有幾個百分點的機會出現一次誤報。
  - `docs/installation.md:177` 說這個警告代表「新版網頁閱讀指引未套用，維護者需自行比對」。看到誤報的維護者會去比對，然後發現原處已經是新版。資料不受影響，下次啟動也不再出現。
  - 現有的並行測試（`同時同步`，5 輪）只檢查最終狀態、不檢查輸出，所以擋不住。
- 建議：
  - `upgradeBuiltinWebReading()` 只掃描 `candidate` 一次，用同一份掃描結果比對新版與舊版；
  - 「有自訂內容」與「備份已存在」兩個分支在警告前再看一次原處，已經是新版就安靜結束；
  - 改正 `:137` 的註解；
  - 以上面的 `--import` 延遲做法補一個定點測試，斷言 B 不輸出這兩種警告。改動約 10 行。
- 待決問題：合併前要修，還是接受並記錄？
  - 做法 1：照建議修，再審一次。
  - 做法 2：不修，在 README `## 待確認事項` 記下「第一次並行升級可能誤報一次，最終狀態正確」，之後另開 issue。待確認事項屬於記帳區段，本報告的 PASS 仍有效。
  - reviewer 建議做法 2：最終狀態在 700 次並行執行中全部正確，誤報只出現一次、不會造成錯誤操作，而修正會再要一輪完整審查。若使用者希望升級的警告一律可信，就選做法 1。

### NICE TO HAVE

- **N-H** 行程在兩次改名之間被 SIGKILL 時的狀態（reviewer 以 `--import` 在第一次改名後自我 SIGKILL 重現）：
  - 原處沒有 `web-reading`；
  - `retired-skills/web-reading-718cc8b` 是完整的舊版；
  - `retired-skills/.web-reading-new-XXXXXX` 留下完整的新版暫存。

  下次同步（或同時在跑的另一個服務）在 `:147-150` 看到原處不存在就返回，由一般同步補上新版，最終狀態正確，reviewer 已驗證 SHA-256。不過有兩點：
  - 暫存目錄永遠不會被清掉。在複製到暫存的途中被殺也一樣，每次都會多一個，各只有幾 KB。
  - 恢復走的是一般同步的 `cpSync`，不是原子操作；恢復時若又遇到磁碟寫滿，會回到 S-C 的截斷狀態。這是兩次故障疊加，一般同步本身是 BASE 就有的寫法。

  可以在升級開始時刪掉超過一定時間的 `.web-reading-new-*`；也可以在 `installation.md` 註明被強制終止時可能留下這類目錄、可以手動刪除。`installation.md:177`「不留下寫到一半的檔案」講的是失敗的情況，不涵蓋被殺。
- **N-J** `:188-193`：換上新版遇到 ENOTEMPTY／EEXIST 以外的錯誤時，如果另一個服務的一般同步剛好已在原處補上新版，回滾的改名會拋 ENOTEMPTY，蓋掉原本的錯誤。呼叫端看到原處有東西，就印「保留原本的版本」，實際上是新版。這要兩種錯誤同時發生，只記錄不建議處理。
- **證據的被測版本**：`review3-sc-green.log`、`review3-sc-mutations.log` 的被測版本寫「未提交的工作樹」，沒有 SHA。`step7-gates-3.log` 在 fecc5d3 跑過全套，`scripts/` 與 `tests/` 在 11a9cc9 之後沒有再變更，reviewer 也在 b38af46 重跑，所以可以追溯，不影響判定。
- 上一份的 **N-B、N-D** 與更早的 **N1～N9** 照舊成立，內容見 review-c71e203.md 與 review-778ed0c.md：
  - N1：`MOLI_BIN` 與清除 `MOLI_*` 互相衝突，本輪再重現；
  - N2：`TELENEXUS_MOLI_BIN` 是沒有標明的測試掛鉤；
  - N3：exit 137 一律回報逾時；
  - N4：trap 安裝之前有幾毫秒的空窗；
  - N5：網址含單引號時命令會斷掉；
  - N6：輸出沒有大小上限；
  - N7：兩套並行改名的寫法；
  - N8：SCN-005 用時間窗斷言，對負載敏感；
  - N9：3c219cf 與本 issue 無關。

## 已查核維度

### 驗收與證據

所有 Scenario 都是「已核准」（README 表格，SCN-001～009），沒有豁免的驗收項目。核准 commit `aae0a8d` 是 HEAD 的祖先；`git diff aae0a8d b38af46 -- README.md` 在 Gherkin 區塊沒有差異，其他差異是 `## 現況`、待確認事項 TBD-4 與 Timeline，所以核准仍有效。

| 編號 | 證據位置 | 結論 |
|------|----------|------|
| SCN-001 | `evidence/step6-opencode-path.md` 第四輪；`step6/results-round4/analysis.json` 的 s1 | 支持 |
| SCN-002 | 第四輪 s2：webfetch 只拿到殼層，wrapper exit 0 讀到正文，沒有 Chrome 程序 | 支持 |
| SCN-003 四例 | 第四輪 s3a～s3d；第 1 例在真 Moli 上先到的是 Moli 自己的 10 秒期限，30 秒硬逾時只由假 moli 測試驗證，已揭露 | 支持 |
| SCN-004 | 第四輪 s4：明確說讀取失敗，沒有捏造 | 支持 |
| SCN-005 四例 | `tests/moli-fetch-wrapper.test.ts` 的收尾測試；step6 的 `/proc` 採樣 | 支持 |
| SCN-006 七例 | wrapper 測試；映像內真 Moli 的 `step3/results4.jsonl` | 支持，範圍限直接網址，文件已寫明 |
| SCN-007 | `tests/docker/moli-install.test.ts`；`step2-images.log`；`step2-badsha.log` | 支持 |
| SCN-008 四例 | `tests/skill-web-reading-upgrade.test.ts`（14 個，含 S-C 兩個）；step6 各容器的 `*-sync.log`；reviewer 的並行壓測 | 支持。最終狀態全部正確；並行時的警告文字見 S-D |
| SCN-009 三例 | `tests/web-reading-route-hint.test.ts`；`step6b-*.log`；第四輪真模型只跑 full | 支持；compact、minimal 只有單元測試，已揭露 |

step6 的映像來自 859331a。之後產品程式只有 `scripts/sync-skills.mjs` 改過：672b86d、9e2e595 改失敗處理與訊息，11a9cc9 改換上的方式。升級的正常路徑結果不變（新版加一份備份），所以 step6 的 `*-sync.log` 結論仍適用。

reviewer 在 b38af46（工作區乾淨）重跑的結果：
- `npm run test`：exit 0，`# tests 727`、pass 727、fail 0，`tests/` 下 87 個測試檔，與 `step7-gates-3.log`（被測 fecc5d3）相同；
- `npx tsx --test tests/skill-web-reading-upgrade.test.ts tests/skill-browser-migration.test.ts`：26/26；
- `npm run lint`、`npx tsc --noEmit -p tsconfig.json`：exit 0；
- `bash -n scripts/moli-fetch.sh`：通過。

沒有跑 `npm run build`，因為它會寫 `dist/`，`tsc --noEmit` 已涵蓋型別檢查。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|------------|------|----------|------|
| 複製到暫存寫到一半失敗（`ulimit -f 2`） | 舊版在原處、沒有備份、沒有暫存、下次升級成功 | S-C 第 13 個測試；reviewer 在 e0908f4 重現紅燈 | 通過 |
| 舊版已備份、換上新版失敗 | 舊版移回、沒有暫存、訊息「保留原本的版本」 | S-C 第 14 個測試；M2 突變 | 通過 |
| 建暫存或備份目錄失敗（`retired-skills` 是一般檔案） | 舊版在原處、其他技能照常 | S1 第 12 個測試，已斷言訊息 | 通過 |
| 換上與回滾都失敗 | 原處空著，由一般同步補上新版，訊息照實說明 | 沒有測試；依程式推演 | 行為正確 |
| 兩次改名之間被 SIGKILL | 下次同步恢復成新版加備份 | reviewer 以 `--import` 自我 SIGKILL 重現 | 恢復正確；暫存殘留（N-H） |
| 複製到暫存途中被 SIGKILL | 原處仍是舊版，下次再試 | 依程式推演（第一次改名之前，原處沒被動過） | 行為正確；暫存殘留（N-H） |
| telenexus 與 agent-runner 同時第一次升級 | 新版、一份備份、沒有殘留、不誤報 | 既有測試 5 輪；reviewer 350 輪壓測（含隨機延遲）與定點重現 | 最終狀態 700/700 正確；警告誤報（S-D） |
| 另一個服務的一般同步在兩次改名之間補上新版 | A 的換上遇到 ENOTEMPTY，安靜結束 | 壓測中出現；依程式推演 | 通過 |
| 一般同步的 `cpSync` 在內部 stat 與 mkdir 之間被 A 搶先換上 | — | 時間窗只有微秒，沒有重現 | BASE 就有的競爭；最壞情況是該程序這次少複製其他技能，另一個程序會完成同一組共用目錄 |
| 目標目錄本身是掛載點（改名遇到 EXDEV） | 不破壞原處 | 依程式推演：第一次改名就失敗，原處沒被動過，訊息「保留原本的版本」 | 行為正確 |
| 備份位置含 symlink、備份已存在、客製、新版、沒有 web-reading、來源缺 web-reading | 依 SCN-008 與 S1 | 測試 | 通過 |
| wrapper：參數、scheme、`MOLI_*`、逾時、SIGKILL 組合、取消 | 依 SCN-005、006 | 測試、突變、step6 實測；全套測試在 b38af46 通過 | 通過；`MOLI_BIN` 例外（N1，再重現） |
| 映像：釘版、先驗 sha256、不用 latest 或 `curl \| sh` | 符合 | 靜態測試、實際建置、雜湊錯誤時建置失敗 | 通過；reviewer 不能連外網，沒有另外核對上游 digest |
| 提示詞：full、compact、minimal 帶；passthrough、排程不帶 | 符合 | 單元測試；`buildChatPrompt` 的唯一呼叫點 `src/main.ts:279`；`builder.ts:567`（minimal）、`:613`（full／compact） | 通過 |

### 需求、架構、安全、品質（含跨 Task 重複與過度設計）

- **需求**：Q1～Q8、Q13、Q14 都有對應實作，TBD-4 的決定（修 S-C）已實作。`src/core/opencode.ts`、`scripts/browser-mcp-launcher.mjs`、`docker-compose*.yml` 在 632fef5..b38af46 都沒有改動，符合「不可觸及」。
- **架構**：暫存放在 `retired-skills/` 底下，與目標目錄在同一個 volume（`./workspace`、`opencode_config`），兩次改名不會跨檔案系統；不在 opencode 探索的 `skills/` 裡，殘留的暫存不會被當成技能載入。升級失敗只影響 web-reading，其他技能照常同步。
- **安全**：
  - 本輪沒有安全面的變更。
  - 以 grep 掃過整個範圍的 `nvapi-`、`ghp_`、`Bearer`、`sk-` 形式 token，以及新證據檔的 `/home/`、`/tmp/claude`、使用者名稱，都沒有外洩；唯一的命中是舊報告描述掃描的文字。
  - 新證據檔以 `<repo>`、`<tmp>` 取代路徑。
- **測試真偽**：
  - 沒有發現假綠燈。
  - S-C 兩個測試的紅燈由 reviewer 獨立重現，M2、M3 突變也重現。
  - 第 14 個測試的注入條件綁在「改名到 `/skills/web-reading`」這個實作細節上，在舊程式上轉紅是因為錯誤根本沒注入。斷言要求輸出含 `EIO`，所以之後換掉換上的方式、注入不再觸發時，測試會轉紅，不會默默變綠。回滾本身由 M2 證明有被擋住。
  - 並行測試不檢查輸出，所以擋不住 S-D，屬於覆蓋缺口與證據持久力，不是假綠燈。
- **文件與程式一致（依 project.md 常青文件責任表）**：
  - 「安裝、升級」→ `installation.md:177`：已補上新的失敗警告；S-D 的誤報與 N-H 的殘留沒有寫。
  - 「模組職責」→ ARCHITECTURE.md、CLAUDE.md：已更新。
  - 「聊天 prompt 組裝」→ `current-chat-prompt.md`：已更新。
  - 「容器權限、runtime 邊界」→ `runtime-boundary-and-security.md`：已更新。
  - 計畫 `implementation-plan.md:309`、`:356` 與實作一致。
  - 本 issue 沒有新增環境變數或常青文件。
- **重複與過度設計**：
  - 換上的流程約 20 行（暫存、兩次改名、回滾、清理），與 S-C 要解決的問題相稱，沒有過度設計。
  - `retiredSkillsDir()` 消除了 N-G 的重複。
  - `retireBuiltinBrowser()` 與 `upgradeBuiltinWebReading()` 的並行處理方式仍然不同（N7、N-B）。兩者目前都不會造成錯誤狀態，所以維持改善建議。

### 豁免、待確認與限制

- Gate 豁免：2026-11-11 不開 PR，改本機獨立審查；只適用這一項。
- 待確認事項：TBD-1～4 都是「已解決」，維持原狀態。TBD-4 的修正經本次審查確認成立。S-D 標了 `需決策`，答案由協調者記入 README `## 待確認事項`。
- `verify-artifact.py --reviewed aacbacc --head b38af46 --artifact docs/issues/issue-0024/review-aacbacc.md` 回報 `INVALID`（`docs/installation.md` 不屬於記帳區段），所以需要本次重新審查；本報告取代它成為現行報告。
- 已揭露的限制（不構成缺失）：
  - 每個情境每輪只跑一次；
  - 第四輪只用 `nvidia/z-ai/glm-5.3-flash` 的 full 模式；
  - 30 秒硬逾時沒有在真 Moli 上觸發過；
  - 轉址、子請求與 DNS rebinding 沒有驗證；
  - arm64 不在範圍內。
- reviewer 沒有做的事：
  - 沒有執行 docker、沒有連外網、沒有呼叫模型、沒有跑 `npm run build`；
  - 故障注入、並行壓測與被殺重現都只在 scratchpad 的暫存目錄進行，repo 只新增本報告。
- 流程契約 2.5 的記帳：保存本報告的提交，要把 README `## 現況` 的 `**現行 review**` 從 `review-aacbacc.md` 改成 `review-b38af46.md`。`## 現況` 已位在 `## 概述` 之後（README:8、:29）。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
