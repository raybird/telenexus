# 審查報告
- 範圍：完整 PR（分支 `feat/issue-0024-moli-web-reading` 對 main 的 merge-base；依 Gate 豁免紀錄不開 PR，改本機獨立審查）。這是第三次審查，涵蓋整個 632fef5..aacbacc，不只 c71e203 之後的 4 個提交
- Reviewed BASE SHA：632fef57da87e9b7f7b532022d1eeb8e0f16bebb
- Reviewed HEAD SHA：aacbacc2fbdf47d73dbb05d5bcbf8d3e688b0b8b
- Reviewed patch-id：aa0d166309e5e5fc1e4415d5f7948201b4d87676（`git diff 632fef5 aacbacc | git patch-id --stable`）
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，2026-11-12；沒有參與本 issue 的實作，也不是前兩份報告的 reviewer（前兩份報告只當作待查核的輸入）
- Review artifact：docs/issues/issue-0024/review-aacbacc.md

審查日期：2026-11-12。審查依據：dev-rules-kit v4.10.0 試用版 `skills/review/SKILL.md`、本 repo 的 docs/AGENTS.md（流程契約 2.5）、docs/agents/project.md、acceptance.md、verification.md、review-evidence.md，以及 issue 0024 的 README、implementation-plan.md 與 evidence。`**核准 commit**` 是 `aae0a8d`，不是 `待提交`，所以本報告不另記推導的核准基線。

## 上一份報告（review-c71e203.md）各項的處理結果

| 項目 | 結論 | 依據 |
|------|------|------|
| S-A `docs/current-chat-prompt.md` 漏改 | **已解決** | `docs/current-chat-prompt.md:52-53` 在【可用能力提示】與【檔案回傳協議】之間加入【網頁讀取】，與 `src/prompt/builder.ts:609-619` 的順序相同；`:78`（compact）、`:87`（minimal）各補一句；`:89` 寫明 passthrough 與排程不帶。reviewer 核對 `buildChatPrompt` 只在 `src/main.ts:279` 被呼叫，排程不經過它。順手補上的【系統狀態】、【可用技能索引】也與 `builder.ts:601-607`、`main.ts:257-268` 相符（只有 full、內容含「最近 15 分鐘異常」）。「20 回合有 9 回合沒載入」與 `evidence/step6-opencode-path.md:78` 相同 |
| S-B S1 證據沒有命令與被測版本 | **已解決** | 三個 `review1-s1-*.log` 第 1 行補了命令與被測版本，`step7-gates.log` 補了被測狀態，計畫 `implementation-plan.md:100` 連到它們。紅燈寫的被測版本是 fd7d78e，reviewer 確認 `scripts/` 在 778ed0c 與 fd7d78e 之間沒有差異，並以 `git archive fd7d78e scripts` 加上 aacbacc 的測試檔在 scratchpad 重跑：3 個 S1 測試失敗（10、11、12），換成 aacbacc 的 `sync-skills.mjs` 後 12/12 通過。建議的做法是在 `step4-skill-upgrade.md` 補一節，實作改成在 log 檔頭與計畫裡記錄，效果相同 |
| N-A 升級失敗的警告與實際狀態不符 | **部分解決**，見 S-C | `scripts/sync-skills.mjs:192-194` 依 `web-reading` 還在不在選訊息。改名之後、還沒寫入任何東西就失敗時，訊息改對了；但 `cpSync` 寫到一半才失敗時，半份目錄還在，訊息仍說「保留原本的版本」，而原本的版本已經在 `retired-skills/`。reviewer 在非 root 下以兩種方式重現，實作者「找不到穩定的注入方式」的說法不成立 |
| N-C 計畫沒有寫 SCN-009 已核准 | **已解決** | `implementation-plan.md:3`、`:122` 都改成涵蓋 SCN-009，與 README 核准表一致 |
| N-B、N-D、N1～N9 | **未處理**，與使用者選的範圍（S-A、S-B、N-A、N-C）一致 | `scripts/moli-fetch.sh`、Dockerfile、`src/`、`skills/` 自 778ed0c 起沒有變更，各項理由照舊成立，等級不變 |

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

**S-C. web-reading 升級在複製到一半時失敗，會留下截斷的技能並一直保留；N-A 的修正沒有涵蓋這個狀態，也沒有測試** `需決策`
- 位置：`scripts/sync-skills.mjs:171-179`（先改名備份，再 `cpSync`），`:189-195`（N-A 的訊息判斷）；計畫 `implementation-plan.md:100` 的「在非 root 下找不到穩定讓複製失敗的注入方式」。
- 重現一（實際檔案系統、不改程式）：在 scratchpad 建一個來源 `SKILL.md` 約 6.8 KB 的 fixture，workspace 放已出貨舊版，以 `ulimit -f 2` 執行 `node scripts/sync-skills.mjs`。結果：
  - 警告是 `web-reading 未升級，保留原本的版本（…）：EFBIG, File too large`；
  - 實際上舊版已在 `retired-skills/web-reading-718cc8b`，`skills/web-reading/SKILL.md` 只剩 2048 bytes；
  - 一般同步看到目錄已存在就跳過（`copied=0, skipped=1`）。
  - 拿掉限制再同步一次，訊息變成「web-reading 有自訂內容，已保留」，之後每次啟動都一樣，截斷的技能永遠不會被換掉。
- 重現二（`node --import` 預先載入一個讓第一次 `cpSync(…/web-reading)` 拋 ENOSPC 的模組，與 review-c71e203.md N-A 用的方法相同）：警告說「舊版已備份到 …/retired-skills，新版沒有裝上」，同一次執行接著的一般同步卻裝上了新版（`copied=1`）。訊息在印出時是對的，同一次執行的結局卻與它相反。
- 影響：
  - 觸發條件是第一次升級時磁碟寫入失敗，例如 ENOSPC 或檔案大小限制，很少見。
  - 發生後模型讀到的是截斷的 `web-reading`，可能少了第 3 層或「讀取失敗」的指引。【網頁讀取】常駐提示（SCN-009）仍帶著讀取順序，而且每次啟動都會出現「有自訂內容」警告，維護者看得到，可以手動復原。
  - 這條路徑在步驟 4（f435404）就存在，S1 與 N-A 都沒有讓它更糟。但 N-A 的修正是新的產品程式變更，沒有紅綠燈證據，而且修正後的訊息在半份目錄的狀態下仍然錯誤。
- 對「找不到注入方式」這個說法的判斷：揭露限制本身不構成缺失（verification.md），但這個說法不成立。
  - `ulimit -f`：非 root 可用，不需要改程式，而且正好打到最該測的「寫到一半」。
  - `node --import <模組>` 改寫 `fs.cpSync`：前一份報告已經用過，也寫在報告裡。
  - 兩種都能放進現有測試的 `spawnSync`，例如改成 `spawnSync('bash', ['-c', 'ulimit -f 2; exec "$0" "$1"', process.execPath, syncScript])`。所以「只以程式閱讀確認」不能接受為這次修正的唯一證據。
- 建議：
  - 讓 `upgradeBuiltinWebReading()` 自己處理複製失敗：先複製到同一個檔案系統上、不在技能目錄裡的暫存位置（例如 `retired-skills/` 底下），完成後再改名到 `web-reading`；失敗時刪掉暫存並把備份改名回原處。這樣訊息可以照實寫「保留原本的版本」，也不會留下半份目錄。
  - 補兩個測試：`ulimit -f` 的寫到一半、`--import` 的立刻失敗。斷言最終目錄內容與警告字串。
- 待決問題：這一項要在合併前處理，還是接受並記錄殘餘風險？
  - 做法 1：照上面的建議修正，再審一次。
  - 做法 2：不修，在 README 記下殘餘風險，並把計畫第 100 行的說法改正。不過改計畫不屬於記帳區段，會讓本報告的 PASS 失效。
  - reviewer 建議做法 1：改動集中在 `upgradeBuiltinWebReading()` 一個函式，測試方式已經驗證可行。

### NICE TO HAVE

- **N-E** `tests/skill-web-reading-upgrade.test.ts` 的 S1 第 12 個測試只比對 `/web-reading/`，不檢查警告的內容。把 `:193` 的兩種訊息對調，這個測試仍會通過。修 S-C 時可以順便斷言「保留原本的版本」。
- **N-F** `docs/installation.md:177` 只寫了「新版網頁閱讀指引未套用」，沒有寫「web-reading 未升級，…」這個新警告與它代表的狀態，前一份 N-A 的建議也提過。與 S-C 一起處理即可。
- **N-G** `scripts/sync-skills.mjs:193` 在呼叫端重組 `retired-skills` 路徑，與 `:135` 的 `backup` 重複，訊息也只寫目錄、沒寫備份名稱。改成由 `upgradeBuiltinWebReading()` 回報狀態（S-C 的做法），這段重複就不需要了。
- 上一份的 **N-B、N-D** 與再上一份的 **N1～N9** 照舊成立，內容見 review-c71e203.md 與 review-778ed0c.md。其中 N1 是 `MOLI_BIN` 與清除 `MOLI_*` 的衝突，N9 是 3c219cf 的 dev-rules-kit 更新與本 issue 無關。

## 已查核維度

### 驗收與證據

所有 Scenario 都是「已核准」（README 表格，SCN-001～009），沒有豁免的驗收項目。核准 commit `aae0a8d` 是 HEAD 的祖先；`git diff aae0a8d aacbacc -- README.md` 的差異只在 `## 現況`、涉及檔案、核准紀錄的說明行、步驟狀態、Timeline 與 `**狀態**`，Gherkin 區塊沒有變更，核准仍有效。

| 編號 | 證據位置 | 結論 |
|------|----------|------|
| SCN-001 | `evidence/step6-opencode-path.md` 第四輪；`step6/results-round4/analysis.json` 的 s1 | 支持 |
| SCN-002 | 第四輪 s2：webfetch 只拿到殼層，wrapper exit 0 讀到正文，沒有 Chrome 程序 | 支持 |
| SCN-003 四例 | 第四輪 s3a～s3d。第 1 例在真 Moli 上先到的是 Moli 自己的 10 秒期限，30 秒硬逾時只由假 moli 測試驗證，證據已揭露 | 支持 |
| SCN-004 | 第四輪 s4：回覆明確說讀取失敗，沒有捏造 | 支持 |
| SCN-005 四例 | `tests/moli-fetch-wrapper.test.ts` 的收尾測試；step6 的 `/proc` 採樣 | 支持 |
| SCN-006 七例 | wrapper 測試；映像內真 Moli 的 `step3/results4.jsonl` | 支持，範圍限直接網址，文件已寫明 |
| SCN-007 | `tests/docker/moli-install.test.ts`；`step2-images.log`；`step2-badsha.log` | 支持 |
| SCN-008 四例 | `tests/skill-web-reading-upgrade.test.ts`（12 個）；step6 各容器的 `*-sync.log` | 支持。四列都是正常路徑；升級途中失敗的狀態見 S-C |
| SCN-009 三例 | `tests/web-reading-route-hint.test.ts`；`step6b-*.log`；第四輪真模型只跑 full | 支持；compact、minimal 只有單元測試，已揭露 |

reviewer 在 aacbacc（工作區乾淨）重跑的結果：
- `npm run test`：exit 0，`# tests 725`、pass 725、fail 0，`tests/` 下 87 個測試檔，與 `step7-gates-2.log`（被測 ad2947e，aacbacc 只多了那份 log）相同；
- `npm run lint`、`npx tsc --noEmit -p tsconfig.json`：exit 0；
- `bash -n scripts/moli-fetch.sh`：通過。

沒有跑 `npm run build`，因為它會寫 `dist/`。`tsc --noEmit` 已涵蓋型別檢查。

step6 第四輪所用映像來自 859331a；之後產品程式只有 672b86d 與 9e2e595 改了 `scripts/sync-skills.mjs` 的失敗處理與警告文字，正常路徑不變，step6 的結論仍適用。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|------------|------|----------|------|
| 同步：建備份目錄失敗（舊版仍在原處） | 警告「保留原本的版本」，其他技能照常 | S1 第 12 個測試（不檢查訊息內容，N-E） | 行為正確，訊息正確 |
| 同步：改名之後、寫入任何東西之前 `cpSync` 失敗 | 不中止、訊息與最終狀態一致 | reviewer 以 `--import` 重現 | 不中止，最終裝上新版；訊息說「新版沒有裝上」，與結局相反（S-C） |
| 同步：`cpSync` 寫到一半失敗 | 不留下半份技能，或訊息照實說明 | reviewer 以 `ulimit -f 2` 重現 | 留下 2048 bytes 的截斷技能，訊息說「保留原本的版本」，之後永遠判成「有自訂內容」（S-C） |
| 同步：來源沒有 `web-reading`、來源目錄不存在 | 不中止、不警告 | S1 測試；reviewer 在 fd7d78e 上重現紅燈 | 通過 |
| 同步：沒有、舊版、客製、新版、symlink、備份已存在、兩個程序並行 | 依 SCN-008 | 測試 | 通過 |
| 同步：`agent-browser` 改名遇到 EXDEV | 其他技能照常 | 沒有測試 | 仍會中止，與 BASE 相同（N-B） |
| wrapper：參數、scheme、`MOLI_*`、逾時、SIGKILL 組合、取消 | 依 SCN-005、006 | 測試、突變、step6 實測 | 通過；`MOLI_BIN` 例外（N1） |
| 映像：釘版、先驗 sha256、不用 latest 或 `curl \| sh` | 符合 | 靜態測試、實際建置、雜湊錯誤時建置失敗 | 通過；reviewer 不能連外網，沒有另外核對上游 digest |
| 提示詞：full、compact、minimal 帶；passthrough、排程不帶 | 符合 | 單元測試；`buildChatPrompt` 唯一呼叫點 `src/main.ts:279` | 通過 |
| 文件：`current-chat-prompt.md` 的範本順序 | 與程式一致 | reviewer 逐段比對 `builder.ts:577-634` | 通過 |

### 需求、架構、安全、品質（含跨 Task 重複與過度設計）

- **需求**：Q1～Q8、Q13、Q14 都有對應實作。`src/core/opencode.ts`、`scripts/browser-mcp-launcher.mjs`、`docker-compose*.yml` 在 632fef5..aacbacc 都沒有改動，符合「不可觸及」。
- **架構**：本輪只改了 `syncBuiltinSkills()` 呼叫端的訊息，沒有新的模組邊界變化。訊息靠呼叫端事後探測檔案系統來判斷升級失敗在哪個階段，這個判斷不可靠（S-C），應由升級函式自己回報。
- **安全**：本輪沒有安全面的變更。對新提交以 grep 掃過 `/home/`、`nvapi-`、`sk-`、`Bearer`、`ghp_` 與個人識別字串，沒有外洩。整個範圍內也沒有 `nvapi-`、`ghp_` 形式的 token。
- **測試真偽**：
  - 沒有發現假綠燈。
  - N-A 的修正沒有測試；這是證據缺口，不是假綠燈。
  - S1 第 12 個測試的訊息斷言太寬（N-E），屬於證據持久力。
  - S1 三個測試的紅燈由 reviewer 獨立重現，失敗原因與目標行為直接相關。
- **文件與程式一致（依 project.md 常青文件責任表）**：
  - 「聊天 prompt 組裝」→ `docs/current-chat-prompt.md`：本輪補齊。
  - 「模組職責」→ ARCHITECTURE.md 與 CLAUDE.md：已更新。
  - 「容器權限、runtime 邊界」→ `runtime-boundary-and-security.md`：已更新。
  - 「安裝、升級」→ `installation.md`：已更新，但缺新的升級失敗警告（N-F）。
  - 「環境變數」：本 issue 沒有新增環境變數，`.env.example` 與 `ai-config.example.yaml` 不需要改。
  - 「使用者可見的功能」→ README.md：沒有更新。網頁讀取是模型內部的工具選擇，不是使用者指令，可以接受。
  - 「新增 `docs/` 文件」：沒有新增常青文件，issue 目錄不在 `docs/README.md` 的索引範圍。
- **重複與過度設計**：本輪只多 3 行，沒有過度設計。重複的 `retired-skills` 路徑組合列為 N-G。兩套並行改名寫法（N7）與兩個遷移的失敗處理方式不同（N-B），都還沒有分歧成錯誤的行為。

### 豁免、待確認與限制

- Gate 豁免：2026-11-11 不開 PR，改本機獨立審查；只適用這一項。
- 待確認事項：TBD-1～3 都是「已解決」，維持原狀態。S-C 標了 `需決策`，答案由協調者記入 README `## 待確認事項`。
- `verify-artifact.py --reviewed c71e203 --head aacbacc --artifact docs/issues/issue-0024/review-c71e203.md` 回報 `INVALID`，原因是 `docs/current-chat-prompt.md` 不屬於記帳區段，所以需要本次重新審查；本報告取代它成為現行報告。
- 已揭露的限制（不構成缺失）：
  - 每個情境每輪只跑一次；
  - 第四輪只用 `nvidia/z-ai/glm-5.3-flash` 的 full 模式；
  - 30 秒硬逾時沒有在真 Moli 上觸發過；
  - 轉址、子請求與 DNS rebinding 沒有驗證；
  - arm64 不在範圍內；
  - N-A 只以程式閱讀確認（這個說法的判斷見 S-C）。
- reviewer 沒有做的事：
  - 沒有執行 docker、沒有連外網、沒有呼叫模型、沒有跑 `npm run build`；
  - 故障重現只在 scratchpad 的暫存目錄進行，沒有改動 repo。
- 流程契約 2.5 的記帳：保存本報告的提交，要把 README `## 現況` 的 `**現行 review**` 從 `review-c71e203.md` 改成 `review-aacbacc.md`。`## 現況` 已位在 `## 概述` 之後（README:8、:29）。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
