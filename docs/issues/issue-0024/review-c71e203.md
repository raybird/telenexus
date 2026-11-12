# 審查報告
- 範圍：完整 PR（分支 `feat/issue-0024-moli-web-reading` 對 main 的 merge-base；依 Gate 豁免紀錄不開 PR，改本機獨立審查）。這是修正之後的重新審查，涵蓋整個 632fef5..c71e203，不只上一份報告之後的兩個提交
- Reviewed BASE SHA：632fef57da87e9b7f7b532022d1eeb8e0f16bebb
- Reviewed HEAD SHA：c71e203f7f6b79706934d663c6fbd5641fda15d9
- Reviewed patch-id：d95bdf27ec28434f33add340da7804a67d895f11（`git diff 632fef5 c71e203 | git patch-id --stable`）
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，2026-11-12；沒有參與本 issue 的實作，也不是上一份報告的 reviewer 本身（上一份報告只當作待查核的輸入）
- Review artifact：docs/issues/issue-0024/review-c71e203.md

審查日期：2026-11-12。審查依據：dev-rules-kit v4.10.0 試用版 `skills/review/SKILL.md`、本 repo 的 docs/AGENTS.md（流程契約 2.5）、docs/agents/project.md、acceptance.md、verification.md、review-evidence.md，以及 issue 0024 的 README、implementation-plan.md 與 evidence。`**核准 commit**` 是 `aae0a8d`，不是 `待提交`，所以本報告不另記推導的核准基線。

## 上一份報告（review-778ed0c.md）各項的處理結果

| 項目 | 結論 | 依據 |
|------|------|------|
| S1 升級例外中止整個技能同步 | **已解決** | `scripts/sync-skills.mjs:137` 在來源沒有 `web-reading` 時直接返回；`:186-193` 把每個目標的升級包在 try/catch，失敗時警告並繼續一般同步。reviewer 把新增的 3 個測試套在 778ed0c 的 `sync-skills.mjs` 上重跑，3 個都失敗，原因是 `[SkillSync] Failed: ENOENT … lstat '<tmp>/source/web-reading'` 與 `ENOTDIR`，和 `review1-s1-red.log` 相同；在 c71e203 上 24/24 通過。另外自己做了一個突變（只拿掉 `:137` 的檢查），2 個測試轉紅，與 `review1-s1-mutations.log` 的 M1 相同。殘留的訊息不精確見 N-A |
| S2 核准 commit 沒有涵蓋 SCN-009 | **已解決** | README:177 改成 `aae0a8d`，`:189` 寫明理由。`aae0a8d` 是 HEAD 的祖先；`d7edd4e` 到 c71e203 之間的 Gherkin 區塊只多了 SCN-009，`aae0a8d` 到 c71e203 之間完全沒有變。SCN-001～008 的核准仍有效 |
| S3 步驟 7 證據與計畫同步 | **大致解決** | 新增 `evidence/step7-gates.log`（build、lint exit 0，test 725/725，87 個檔），計畫的檢查清單已勾選、測試策略補上 SCN-009（`implementation-plan.md:112`），README「涉及檔案」補上 `src/prompt/builder.ts`。殘留：計畫第 3 行與第 122 行仍只寫「SCN-001～008 已核准」（N-C）；log 沒有記被測提交（S-B） |
| S4 內網封鎖的文件措辭 | **已解決** | `docs/runtime-boundary-and-security.md:194-195` 改成「直接指向……實測都會被拒絕。轉址、頁面 JavaScript 發出的子請求與 DNS rebinding 沒有驗證過」，並另寫一條「這不是 TeleNexus 的內網安全邊界」，點名 webfetch、Chrome、YOLO bash 都沒有這層限制。與 configuration-reference.md、Q5 的決定一致 |
| N1～N9 | **未處理**（`scripts/moli-fetch.sh` 自 778ed0c 起沒有變更） | reviewer 重現了 N1：呼叫端帶 `MOLI_BIN=x` 時，stderr 出現 `unset: MOLI_BIN: cannot unset: readonly variable`，Moli 的環境裡仍有 `MOLI_BIN`。其餘各項的理由仍成立，等級不變，列在下方 |

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

**S-A. `docs/current-chat-prompt.md` 沒有反映【網頁讀取】段落（常青文件漏改）**
- 位置：`docs/current-chat-prompt.md:31-80`（full 的結構範本與 compact、minimal 的差異說明）；對應程式 `src/prompt/builder.ts:541-544`、`:567`、`:613`。
- 現象：docs/agents/project.md 的「常青文件更新責任」規定「聊天 prompt 組裝」要更新 `docs/current-chat-prompt.md`。SCN-009 讓 full、compact、minimal 都多一段【網頁讀取】（full／compact 放在【可用能力提示】之後、【檔案回傳協議】之前；minimal 放在使用者訊息之前），但這份文件的結構範本沒有這段，minimal 仍寫「不放 memory policy／workspace policy／file return policy」而沒有提到新段落。本 diff 改了 CLAUDE.md 的 Prompt Modes、ARCHITECTURE.md、configuration-reference.md，唯獨漏了 project.md 指定的這一份；計畫步驟 7 的「做法」清單也沒有列它。上一份報告沒有指出這一點。
- 影響：只影響文件。這份文件開頭寫「實際來源以程式碼為準」，但它是維護者查提示詞結構的入口，看文件的人會以為 minimal 模式沒有額外段落。
- 建議：在 full 範本的【可用能力提示】與【檔案回傳協議】之間加入【網頁讀取】，compact、minimal 的差異說明各補一句「仍帶【網頁讀取】」，並註明排程任務的提示詞沒有這段。

**S-B. S1 修正的證據沒有記命令與被測版本，issue 文件也沒有連到它**
- 位置：`docs/issues/issue-0024/evidence/review1-s1-red.log`、`review1-s1-green.log`、`review1-s1-mutations.log`、`step7-gates.log`。
- 現象：verification.md「證據重用」要求每筆證據記命令、結果、時間、驗收編號與被測提交。三個 `review1-s1-*` 檔只有 TAP 輸出，沒有寫跑了什麼命令、紅燈對的是哪個版本；README、計畫與 `step4-skill-upgrade.md` 都沒有連到它們（`grep -rn review1-s1 docs/` 在 evidence 目錄外沒有結果）。步驟 2～4 的證據都有一份 `.md` 寫明命令與結果，這次沒有。`step7-gates.log` 只寫「審查 S1、S4 修正之後」，沒有 SHA。
- 影響：不構成假綠燈。reviewer 已獨立重現：(1) 新測試套在 778ed0c 的同步腳本上 3 個失敗，失敗原因與目標行為直接相關；(2) M1 突變 2 個失敗；(3) 在 c71e203 上 `npm run test` 725/725、87 個檔，與 step7 log 的數字相同。所以這一項不阻擋判定，屬於證據持久力與可追溯性。
- 建議：在 `step4-skill-upgrade.md` 補一節「審查 S1 修正」，寫明命令（`npx tsx --test tests/skill-web-reading-upgrade.test.ts tests/skill-browser-migration.test.ts`）、紅燈對的是 778ed0c 的 `sync-skills.mjs`、綠燈對的是 672b86d，以及兩個突變的內容；`step7-gates.log` 補上被測 SHA。

### NICE TO HAVE

- **N-A** `scripts/sync-skills.mjs:178`、`:191`：升級在改名備份之後才失敗時（例如 `fs.cpSync` 遇到 ENOSPC），警告說「保留原本的版本」，實際上原本的版本已經搬到 `retired-skills/`。reviewer 以 `node --import` 預先載入一個讓第一次 `cpSync(…/web-reading)` 拋 ENOSPC 的模組重現：同步沒有中止，後面的一般同步補上了新版，結果是新版加一份備份，正確；只有訊息錯了。如果 `cpSync` 寫到一半才失敗，留下的半份目錄之後會被當成「有自訂內容」一直保留。這條路徑在 778ed0c 就存在，S1 修正沒有讓它更糟。建議依失敗發生在改名前或改名後給不同訊息；`docs/installation.md:177` 也可以補上這個新的警告字串。
- **N-B** `scripts/sync-skills.mjs:184`：web-reading 的升級現在會隔離失敗，`retireBuiltinBrowser()` 改名遇到 EXDEV、EACCES 時仍會中止整個同步。這是 issue 0010 留下的行為，不在本 diff 內，也不是新的退步；兩個遷移的失敗處理方式從這裡開始不同，可以之後一起用同一個 try/catch 包起來（與上一份的 N7 有關）。
- **N-C** `docs/issues/issue-0024/implementation-plan.md:3`、`:122`：仍只寫「SCN-001～008 已核准（2026-11-12）」，沒有 SCN-009。核准狀態以 README 的表為準（SCN-009 已核准），不影響判定。
- **N-D** `src/prompt/builder.ts:543`：【網頁讀取】每回合都送，不檢查 wrapper 存不存在。在主機上 `npm run dev` 時沒有 `telenexus-moli-fetch`，bash 會回 127，依指引就退到下一層，行為仍正確，只是多一次工具呼叫。可接受，記為已知限制即可。
- 上一份的 **N1～N9** 照舊成立，內容見 review-778ed0c.md：N1 `MOLI_BIN` 與 `MOLI_*` 清除互相衝突（已重現）；N2 `TELENEXUS_MOLI_BIN` 是未標明的測試掛鉤；N3 exit 137 一律回報逾時；N4 trap 安裝前有幾毫秒的空窗；N5 單引號網址會讓命令斷掉；N6 輸出沒有大小上限；N7 兩套並行改名寫法；N8 SCN-005 的時間窗斷言對負載敏感；N9 3c219cf（dev-rules-kit 更新）與本 issue 無關但在同一分支。

## 已查核維度

### 驗收與證據

所有 Scenario 都是「已核准」（README 表格，SCN-001～009），沒有豁免的驗收項目。

| 編號 | 證據位置 | 結論 |
|------|----------|------|
| SCN-001 | `evidence/step6-opencode-path.md` 第四輪、`step6/results-round4/analysis.json` s1：只用 webfetch，fixture 只記到一般請求，沒有 wrapper 與 Chrome | 支持 |
| SCN-002 | 第四輪 s2：webfetch 只拿到殼層 → wrapper exit 0 讀到正文，fixture 記到 Moli 的請求，沒有 Chrome 程序 | 支持 |
| SCN-003 四例 | 第四輪 s3a～s3d（Moli 內部逾時、exit 22、只有殼層、內網被擋，都退到 Chrome；s3d 原始那次因測試 client 逾時失敗，保留在 `*.timeout`）。第 1 例在真 Moli 上先到的是 Moli 自己的 10 秒期限，30 秒硬逾時只由假 moli 測試驗證，證據已揭露 | 支持 |
| SCN-004 | 第四輪 s4：三層都只有殼層，回覆明確說讀取失敗，沒有捏造 | 支持 |
| SCN-005 四例 | `tests/moli-fetch-wrapper.test.ts` 的收尾測試（正常、30 秒逾時、不理 SIGTERM 時 35 秒 SIGKILL、wrapper 收到 SIGTERM、整個 group SIGKILL、只有 wrapper 被 SIGKILL）；step6 的 `/proc` 採樣（取消時 wrapper 被收養到 pid 1，Moli 在 10 秒內結束並清掉暫存目錄） | 支持 |
| SCN-006 七例 | wrapper 測試涵蓋沒有參數、兩個網址、`file:`、`data:`、`--dump html`（另加 `javascript:`）；映像內真 Moli（`step3/results4.jsonl`）的 loopback、localhost、RFC1918、`memoria`、metadata 都 exit 1 | 支持（範圍限直接網址，文件已寫明） |
| SCN-007 | `tests/docker/moli-install.test.ts`（3 個）；`step2-images.log`：dev 與正式映像 `moli 1.1.23`、`root:root 755`、不在 PATH；`step2-badsha.log` 雜湊錯誤時建置失敗 | 支持 |
| SCN-008 四例 | `tests/skill-web-reading-upgrade.test.ts`（現有 12 個，每列同步兩次，另含 symlink、備份已存在、並行 5 輪，以及 S1 的 3 個）；step6 每個容器的 `*-sync.log` 都有 `Upgraded builtin web-reading` | 支持 |
| SCN-009 三例 | `tests/web-reading-route-hint.test.ts`（full、compact、minimal；斷言段落存在、順序 webfetch → Moli → Chrome、在 `User Message:` 之前）；`step6b-*.log` 紅燈 3/3、4 個突變全紅；第四輪真模型只跑 full | 支持；compact、minimal 只有單元測試，已揭露 |

reviewer 在 c71e203（工作區乾淨，HEAD 即 c71e203）重跑：`npm run test` exit 0，`# tests 725`、pass 725、fail 0，`tests/` 下 87 個測試檔，與 step7 log 相同（725 = 上一份的 722 加 S1 的 3 個）；`npm run lint` exit 0；`npx tsc --noEmit -p tsconfig.json` exit 0；`bash -n scripts/moli-fetch.sh` 通過；技能同步兩個測試檔 24/24。沒有跑 `npm run build`（會寫 `dist/`），本 diff 沒有動建置資產流程，`tsc --noEmit` 已涵蓋型別檢查。step6 第四輪所用映像來自 859331a；之後產品程式只有 672b86d 改了 `scripts/sync-skills.mjs` 的失敗處理，正常路徑（舊版換新版）的行為不變，step6 對 SCN-001～005、009 的結論仍適用。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|------------|------|----------|------|
| 同步：來源沒有 `web-reading` | 其他技能照常複製，不警告 | S1 測試；reviewer 在 778ed0c 上重現紅燈 | 通過 |
| 同步：內建技能來源目錄整個不存在 | 印 `Builtin skills source not found`，不中止 | S1 測試 | 通過，與 BASE 行為相同 |
| 同步：備份路徑的上層是檔案（lstat 得到 ENOTDIR） | 警告、舊版原地保留、其他技能照常 | S1 測試 | 通過 |
| 同步：改名之後 `cpSync` 失敗（ENOSPC） | 不中止，最終狀態一致 | reviewer 以預先載入的模組模擬 | 不中止、最終是新版；訊息不精確見 N-A |
| 同步：`agent-browser` 改名遇到 EXDEV | 其他技能照常 | 沒有測試 | 仍會中止整個同步，與 BASE 相同，見 N-B |
| 同步：沒有、舊版、客製、新版、symlink、備份已存在、兩個程序並行 | 依 SCN-008 | 測試 | 通過 |
| 同步：判定之後、改名之前被另一個程序搶先 | 直接返回 | 沒有測試（M6 已揭露）；reviewer 推演 ENOENT／ENOTEMPTY 兩種交錯，兩個程序不可能都改名成功 | 推論可接受 |
| wrapper：0 個或 2 個參數、`file:`、`data:`、`javascript:`、Moli 旗標 | exit 2，不啟動 Moli | wrapper 測試 | 通過 |
| wrapper：呼叫端帶 `MOLI_*` 環境變數 | 不影響固定參數 | 測試；`MOLI_BLOCK_PRIVATE_NETWORKS=0` 時映像內真 Moli 仍擋 | 通過；`MOLI_BIN` 例外已重現（N1） |
| wrapper：Moli 掛住、不理 SIGTERM、各種 SIGKILL 組合、使用者取消 | 45 秒內沒有程序與 `tnm-*` | 假 moli 測試、突變、step6 實測 | 通過 |
| wrapper：轉址或子請求指向內網 | 未驗證 | 沒有證據 | 文件已明寫沒有驗證，且依 Q5 本來就可退到 Chrome，不是新的暴露 |
| 映像：固定版本網址、先驗 sha256 再解開、不用 latest／`curl \| sh`、root 擁有、不在 PATH | 符合 | 靜態測試、突變、實際建置、雜湊錯誤時建置失敗 | 通過；reviewer 不能連外網，沒有另外核對上游 digest |
| 提示詞：full／compact／minimal | 帶【網頁讀取】，在使用者訊息之前 | 單元測試 | 通過 |
| 提示詞：passthrough 與排程 | 不帶 | `buildChatPrompt` 只在 `src/main.ts:279` 被呼叫（Telegram 與 Web 共用的聊天 pipeline） | 與 CLAUDE.md、configuration-reference.md 一致 |
| 提示詞：沒有 Moli 的執行環境（主機 `npm run dev`） | 退到下一層 | 依指引，非 0 結束就換下一層 | 可接受，見 N-D |

### 需求、架構、安全、品質（含跨 Task 重複與過度設計）

- **需求**：Q1～Q8、Q13、Q14 的決定都有對應實作。`src/core/opencode.ts`、`scripts/browser-mcp-launcher.mjs`、`docker-compose*.yml` 在 632fef5..c71e203 都沒有改動，符合「不可觸及」。`src/prompt/builder.ts` 由 SCN-009 授權，README「涉及檔案」已補上。
- **架構**：wrapper 透過 bash 呼叫，不是 MCP，與 issue 0010 的 Chrome 收尾互不干涉。Dockerfile 的 Moli 安裝在 base stage，正式 stage 仍在最後。S1 修正只在 `syncBuiltinSkills()` 的呼叫端加上隔離，沒有改動升級判定本身。
- **安全**：釘版、雜湊驗證、root 擁有的執行檔都成立。文件已改成「這不是內網安全邊界」，與實際可存取範圍（webfetch、Chrome、YOLO bash 都沒有這層限制）一致。新提交的證據檔已去敏（以 `<repo>`、`<tmp>` 取代路徑）；reviewer 以 grep 掃過 778ed0c..c71e203 的 `/home/`、`nvapi-`、`sk-`、`Bearer`、`ghp_` 與作者信箱，沒有發現外洩（唯一一筆是舊報告描述掃描的文字）。
- **測試真偽**：S1 的 3 個測試期望值來自規格（「其他技能照常同步」以 `scheduler/SKILL.md` 是否存在判定，「沒有新版可換不是錯誤」以沒有警告判定），不是重算實作；紅燈原因與目標行為直接相關（`[SkillSync] Failed: ENOENT/ENOTDIR`）。第 3 個測試的 `/web-reading/` 比對看起來寬鬆，但在 target[1] 沒有任何輸出會含這個字，拿掉警告時它會轉紅，不是空斷言。其餘測試沿用上一份報告的查核結論，reviewer 抽查過提示詞、指引、映像三個測試檔，斷言用的都是字面字串與順序。沒有發現假綠燈。
- **觀測式驗收（step6）的反向自檢**：模型沒用 Moli 時，fixture 不會記到 Moli 的請求，採樣器也看不到 wrapper，判準會是紅的；觀測器先以正負對照驗過（`step6/results/control-analysis.jsonl`）。各輪重跑都對應使用者在 Q11～Q14 的決定，作廢與失敗的結果都保留。
- **文件一致性**：CLAUDE.md、ARCHITECTURE.md、configuration-reference.md、installation.md、runtime-boundary-and-security.md 與程式一致；`docs/current-chat-prompt.md` 漏改（S-A）；N1、N2 的文件說法與 wrapper 行為不一致仍在。
- **重複與過度設計**：S1 修正只多 10 行，沒有過度設計。`scanDirectory()`、`matchesManifest()` 的抽取合理。兩套並行改名寫法（N7）與兩個遷移的失敗處理方式不同（N-B）尚未分歧成錯誤的行為，列為建議。

### 豁免、待確認與限制

- Gate 豁免：2026-11-11 不開 PR，改本機獨立審查；只適用這一項。
- 待確認事項：TBD-1、TBD-2、TBD-3 都是「已解決」，結論與證據連結齊全，維持原狀態。
- 上一份報告在被審查提交之後多了程式與證據的提交，`verify-artifact.py --reviewed 778ed0c --head c71e203 --artifact docs/issues/issue-0024/review-778ed0c.md` 回報 `INVALID`（`review1-s1-green.log` 不屬於記帳區段），所以需要本次重新審查；本報告取代它成為現行報告。
- 已揭露的限制（不構成缺失）：每個情境每輪只跑一次；第四輪只用 `nvidia/z-ai/glm-5.3-flash` 的 full 模式；compact、minimal 與排程沒有真模型實測；30 秒硬逾時沒有在真 Moli 上觸發過；轉址、子請求與 DNS rebinding 沒有驗證；arm64 不在範圍內。
- reviewer 沒有做的：沒有執行 docker、沒有連外網、沒有呼叫模型、沒有跑 `npm run build`。故障模擬只在 scratchpad 的暫存目錄進行，沒有改動 repo。
- 流程契約 2.5 的記帳：保存本報告的提交要把 README `## 現況` 的 `**現行 review**` 從 `review-778ed0c.md` 改成 `review-c71e203.md`。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
