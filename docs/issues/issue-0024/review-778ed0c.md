# 審查報告
- 範圍：完整 PR（分支 `feat/issue-0024-moli-web-reading` 對 main 的 merge-base；依 Gate 豁免紀錄不開 PR，改本機獨立審查）
- Reviewed BASE SHA：632fef57da87e9b7f7b532022d1eeb8e0f16bebb
- Reviewed HEAD SHA：778ed0cf90cedd615c6c8ef08d0e3a3a2a28f4c3
- Reviewed patch-id：76c75b812cf39354a3bce849a73e71c71311d281（`git diff 632fef5 778ed0c | git patch-id --stable`）
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，2026-11-12；沒有參與本 issue 的實作
- Review artifact：docs/issues/issue-0024/review-778ed0c.md

審查日期：2026-11-12。審查依據：dev-rules-kit v4.10.0 試用版 `skills/review/SKILL.md`、本 repo 的 docs/AGENTS.md（流程契約 2.5）、docs/agents/acceptance.md、verification.md、review-evidence.md，以及 issue 0024 的 README、implementation-plan.md 與 evidence。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

**S1. `upgradeBuiltinWebReading()` 的例外會中止整個技能同步（行為退步）**
- 位置：`scripts/sync-skills.mjs:136`（`const current = scanDirectory(source)`）、`:183`（在 `:184` 檢查來源存在之前呼叫）、`:170-174`（改名只吞 ENOENT／ENOTEMPTY／EEXIST）。
- 現象：`scanDirectory()` 對不存在的路徑會從 `fs.lstatSync` 拋 ENOENT。來源目錄沒有 `web-reading` 時，例外往上傳到 `syncBuiltinSkills()`，後面的「補缺少的技能目錄」整段不會執行；腳本仍然 exit 0，只留下一行 `[SkillSync] Failed: ENOENT ... /web-reading`。reviewer 在 scratchpad 重現過：`BUILTIN_SKILLS_DIR` 指向只有 `other/` 的目錄，`other` 沒有被複製。被審查的 BASE（632fef5）在來源不存在時會印 `Builtin skills source not found` 再正常結束，所以這是新引入的退步。改名遇到 EXDEV、EACCES 這類錯誤時也一樣會中止整個同步（agent-browser 退役沿用的是同樣的寫法）。
- 影響：預設出貨的映像一定有 `web-reading`，所以 SCN-008 不受影響。但部署是以 `./skills:/app/skills:ro` 掛載主機目錄（docker-compose.release.yml:34），維護者只要刪掉或改名主機上的 `skills/web-reading`，之後所有內建技能都同步不到新的 workspace，而且服務照常啟動，不會有人發現。
- 建議：`source` 沒有 `web-reading` 時直接 return；把 `upgradeBuiltinWebReading()` 的非預期例外改成 `console.warn` 後繼續後面的同步，不要中止。補一個「來源缺 web-reading 時其他技能仍會複製」的測試。

**S2. `**核准 commit**` 沒有涵蓋 SCN-009** `需決策`
- 位置：`docs/issues/issue-0024/README.md:174`（`d7edd4e`）。
- 現象：d7edd4e 裡沒有 SCN-009。SCN-009 第一次出現是在 aae0a8d，之後內容沒有改過（`git diff aae0a8d 778ed0c` 在驗收區塊只有核准來源續行的增補）。acceptance.md 規定新增核准之後要更新「基線提交」。SCN-001～008 自 d7edd4e 起沒有語意改動，原核准有效。核准來源的推導命令仍會得到 d7edd4e，因為 aae0a8d 只改了續行，沒有動欄位那一行。
- 待決問題：審查之後把 `d7edd4e` 改成 `aae0a8d`，不符合 review-evidence.md「審查之後的提交」第 3 項（只允許由 `待提交` 改成被審查提交或它的祖先），會讓本次 PASS 失效。
- 可選做法：(a) README 維持原樣，以本報告記錄 SCN-009 的核准基線是 aae0a8d；(b) 等下一次本來就要做的修正提交（例如修 S1）時一起改，屆時本來就要重審。
- reviewer 建議：要修 S1 就選 (b)，不修就選 (a)。

**S3. 步驟 7 的完成證據沒有保存，計畫的文字與狀態沒有同步**
- 位置：`docs/issues/issue-0024/implementation-plan.md:122-124`（檢查清單仍未勾選）、步驟 7（標了 ✅，但沒有證據連結）、`:3`（只寫 SCN-001～008 已核准）、測試策略表（`:105-110` 沒有 SCN-009 那一列）；README「涉及檔案」（`:55` 起）沒有列出 `src/prompt/builder.ts`。
- 現象：步驟 7 的完成判準是 build、test、lint 都 exit 0，並核對 `# tests` 與測試檔數，但 evidence 底下沒有步驟 7 的紀錄。依 verification.md，只有狀態符號不構成證據。
- reviewer 已在 778ed0c 重跑以補上這一段：`npm run test` 有 87 個測試檔、`# tests 722`、pass 722、fail 0、exit 0；`npm run lint` exit 0；`npx tsc --noEmit -p tsconfig.json` exit 0。`npm run build` 會寫出 `dist/`，所以沒有跑；本次 diff 沒有動 build 的資產複製流程。因為已重現，不阻擋判定。
- 建議：下次修正時補上 `evidence/step7-*.log`，勾選檢查清單，並在計畫與「涉及檔案」補上 SCN-009 與 `builder.ts`。

**S4. 內網封鎖的覆蓋範圍與安全文件的措辭**
- 位置：`docs/runtime-boundary-and-security.md:194`。
- 現象：實測只涵蓋直接網址（`127.0.0.1`、`localhost`、RFC1918、服務名稱 `memoria`、`169.254.169.254`，見 evidence/step3/results4.jsonl）。公開網址 302 轉址到內網、頁面 JavaScript 對內網發 fetch／XHR、DNS rebinding 都沒有驗。文件寫「都會被拒絕」，讀者容易以為轉址也包括在內。
- 另外，第四輪的 fixture 紀錄顯示 `webfetch` 本身會讀內網位址（`results-round4/fixture-requests.jsonl`，`172.21.0.2` 那一列）。而模型的 bash 是 YOLO，可以直接執行 `/opt/telenexus/moli/...` 或 `curl`。所以 wrapper 只是「照指引走的那條路」上的防護，不是安全邊界。
- 影響：依 Q5，被擋的網址本來就可以退回 Chrome 讀取，因此實際可存取的範圍與已接受的風險相同，屬於文件精確度問題，不是新的漏洞。
- 建議：在該段寫明「只驗證過直接網址；webfetch、Chrome 與模型的 bash 都沒有這層限制」。也可以用步驟 1 的 fixture 補一次轉址與子資源的探測，再把結果寫進文件。

### NICE TO HAVE

- **N1** `scripts/moli-fetch.sh:10`：內部變數 `MOLI_BIN` 也符合 `^MOLI_` 前綴。呼叫端環境本來就 export 了 `MOLI_BIN` 時，第 29 行的 `unset` 會失敗（stderr 出現 `unset: MOLI_BIN: cannot unset: readonly variable`），`MOLI_BIN` 就被帶進 Moli 的環境，與文件「清掉 `MOLI_*` 環境變數」的說法不符（reviewer 以假 moli 重現過）。改用小寫的 `moli_bin` 之類的名稱即可。
- **N2** `scripts/moli-fetch.sh:5,10`：`TELENEXUS_MOLI_BIN` 可以換掉執行檔，與註解「不開放覆寫」、configuration-reference.md:9「參數全部寫死，沒有設定旋鈕」不一致。建議在註解或文件標明這是測試用掛鉤。因為模型本來就有完整的 bash，這不是新的權限。
- **N3** `scripts/moli-fetch.sh:67`：137 一律回報「逾時」。Moli 被 OOM killer 殺掉時（runner 有 `--memory 2g`），訊息會不對。結束碼仍是非 0，退回 Chrome 的行為不受影響。
- **N4** `scripts/moli-fetch.sh:32-61`：TERM／INT／HUP 的 trap 是在 Moli 與清理程序都啟動之後才裝。mktemp 到啟動清理程序之間收到訊號，會留下 `tnm-*`；這個時間窗只有幾毫秒。把 trap 移到 mktemp 之後即可補上。
- **N5** `src/prompt/builder.ts:544`、`skills/web-reading/SKILL.md:25`：兩處都教模型寫 `telenexus-moli-fetch '網址'`。網址含單引號時命令會斷掉，或被拼出額外的命令。可以加一句「網址裡的 `'` 改成 `%27`」。
- **N6** `scripts/moli-fetch.sh:79`：輸出沒有大小上限，超大頁面會整份灌進 bash 工具的輸出。
- **N7** `scripts/sync-skills.mjs`：`retireBuiltinBrowser()` 與 `upgradeBuiltinWebReading()` 處理並行改名的方式不同：前者用 `anotherWorkerFinished()`，後者直接忽略錯誤碼；`isMissing()` 也只有新函式在用。reviewer 推演過兩者目前都安全，還沒有分歧成錯誤的行為。可以抽成一個共用的「改名到備份」輔助函式。
- **N8** `tests/moli-fetch-wrapper.test.ts`：SCN-005 用 29～35 秒、34～40 秒的時間窗斷言，機器負載高時可能誤判（證據持久力）。
- **N9** 3c219cf（dev-rules-kit 更新到 v4.10.0）與 issue 0024 的產品行為無關，卻在同一個分支、標了 `Refs: #24`，合併時會一起進 main。這只涉及文件，可以接受，建議合併說明裡揭露。

## 已查核維度

### 驗收與證據

所有 Scenario 都是「已核准」；沒有豁免的驗收項目。Gate 豁免只有「不開 PR」這一項。

| 編號 | 證據位置 | 結論 |
|------|----------|------|
| SCN-001 | evidence/step6-opencode-path.md 第四輪、`step6/results-round4/analysis.json` s1：工具只有 webfetch，fixture 只記到 `other:page`，`wrapperSeen`、`chromeSeen` 都是 null | 支持 |
| SCN-002 | 第四輪 s2：webfetch 讀到殼層 → wrapper exit 0 讀到正文；fixture 記到 `moli:page`、`moli:api`，沒有 Chrome 程序 | 支持 |
| SCN-003 四例 | 第四輪 s3a（Moli 10 秒內部逾時 exit 1 → Chrome）、s3b（exit 22 → Chrome）、s3c（exit 0 但只有殼層 → Chrome）、s3d（內網被封鎖 → Chrome；原始那次因測試 client 300 秒逾時失敗，保留在 `*.timeout`，重跑時改用沒有逾時的 client）。第 1 例在真 Moli 上是 Moli 自己的 10 秒先到，30 秒硬逾時只由假 moli 測試驗證，證據已揭露 | 支持 |
| SCN-004 | 第四輪 s4：三層都只有殼層，回覆「讀取失敗（無正文）」，沒有捏造內容 | 支持 |
| SCN-005 四例 | `tests/moli-fetch-wrapper.test.ts` 的 5 個收尾測試（正常、30 秒逾時、不理 SIGTERM 時 35 秒 SIGKILL、wrapper 收到 SIGTERM、整個 group SIGKILL、只有 wrapper 被 SIGKILL）；step6 的 `/proc` 採樣（第一輪與第四輪的取消：wrapper 被收養到 pid 1，Moli 在 wrapper 啟動後 10.0 秒結束並清掉暫存目錄）；每個情境的檢查點與最後一列都是空的 | 支持 |
| SCN-006 七例 | wrapper 測試：沒有參數、兩個網址、file、data、`--dump html`，另加 `--layout`、`javascript:` 兩列；映像內真 Moli（`step3/results4.jsonl`）：loopback、localhost、RFC1918、服務名稱 `memoria`、metadata 都 exit 1，stderr 是 `blocked private network address`，`data:` 由 wrapper 以 exit 2 擋下 | 支持（範圍見 S4） |
| SCN-007 | `tests/docker/moli-install.test.ts`（3 個）；step2：dev 與正式映像的 `moli --version` 都是 1.1.23、雜湊改錯時建置 exit 1（`step2-badsha.log`）、6 個突變都轉紅 | 支持 |
| SCN-008 四例 | `tests/skill-web-reading-upgrade.test.ts`（9 個，每列都同步兩次，另含 symlink、備份已存在、並行 5 輪）；step6 每個容器的 `*-sync.log` 都有 `Upgraded builtin web-reading`，`*-skill.txt` 的雜湊與 repo 相同 | 支持（缺漏面見 S1） |
| SCN-009 三例 | `tests/web-reading-route-hint.test.ts`（full、compact、minimal；紅燈 3/3 失敗、4 個突變全紅，見 `step6b-*.log`）；第四輪真模型只跑 full 模式 | 支持；compact、minimal 只有靜態證據，證據已揭露 |

reviewer 在 778ed0c 重跑：與本 issue 相關的 6 個測試檔，`# tests 45`，全部通過；`npm run test` 722/722；`npm run lint` exit 0；`npx tsc --noEmit` exit 0；`bash -n scripts/moli-fetch.sh` 通過。工作區乾淨，HEAD 就是 778ed0c。step6 第四輪所用映像來自 859331a，`git diff 859331a 778ed0c` 在 `scripts/`、`src/`、`skills/`、`Dockerfile`、`tests/` 都沒有差異，證據對被審查版本仍然有效。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|------------|------|----------|------|
| 0 個或 2 個參數、`file:`、`data:`、`javascript:`、Moli 旗標當成網址 | exit 2，不啟動 Moli | wrapper 測試 | 通過 |
| `HTTP://` 大寫 scheme | 接受 | wrapper 測試 | 通過 |
| 網址含換行、只有 `https://` | 交給 Moli 判定 | reviewer 手動測：wrapper 接受，網址放在 `--` 之後，不會被當成參數 | 可接受 |
| 呼叫端帶 `MOLI_BLOCK_PRIVATE_NETWORKS=0` 等環境變數 | 不影響 Moli | 測試＋映像內真 Moli 仍擋 | 通過；`MOLI_BIN` 例外見 N1 |
| Moli 掛住或不理 SIGTERM | 30 秒 TERM、35 秒 KILL，exit 124，沒有殘留 | 假 moli 測試 | 通過 |
| wrapper 收到 SIGTERM、整個 group 收到 SIGKILL、只有 wrapper 收到 SIGKILL | 45 秒內沒有 Moli、沒有 `tnm-*` | 假 moli 測試；突變 M3、M4、M5、M9 都轉紅 | 通過 |
| 使用者取消（真實路徑） | 45 秒內收尾 | step6 第一輪與第四輪 | 通過；取消訊號不會傳到 wrapper，已記錄於 TBD-2 與安全文件 |
| 輸出時 stdout 被關閉（SIGPIPE） | 暫存目錄仍會刪除 | 沒有測試；依程式推論，獨立 session 的清理程序會在 wrapper 結束後刪除 | 推論可接受 |
| 多個 wrapper 同時執行 | 各自獨立 | 各自 mktemp，依設計成立 | 可接受 |
| 直接網址指向內網 | Moli exit 1 | 映像內真 Moli | 通過 |
| 轉址或頁面子請求指向內網 | 未定義 | 沒有證據 | 見 S4 |
| 供應鏈：固定版本網址、先驗 sha256 再解開、不用 latest 或 `curl \| sh`、不放進 PATH、root 擁有 755 | 符合 | 靜態測試、突變、雜湊錯誤時建置失敗 | 通過；reviewer 不能連外網，沒有另外核對上游公布的 digest，以步驟 1 的紀錄為準 |
| 同步：沒有、舊版、客製、新版、symlink、備份已存在、兩個程序並行 | 依 SCN-008 | 測試 | 通過 |
| 同步：來源缺 `web-reading`、改名遇到 EXDEV | 其他技能照常同步 | 沒有測試 | **不通過**，見 S1 |
| 同步：判定之後到改名之前被另一個程序搶先（ENOENT、ENOTEMPTY） | 直接返回，不破壞內容 | 沒有測試（突變 M6 已揭露）；reviewer 逐一推演各種交錯順序，結果都是新版且只有一份備份 | 推論可接受 |
| 正式部署的兩個同步目標 | 改名在同一個檔案系統內 | bind mount `./workspace` 與 named volume `opencode_config` | 通過 |
| 提示詞：passthrough 與排程 | 不帶【網頁讀取】 | `buildChatPrompt` 只被 `src/main.ts:279` 呼叫 | 與文件一致 |

### 需求、架構、安全、品質（含跨 Task 重複與過度設計）

- **需求**：Q1～Q8、Q13 的決定都有對應實作。`src/core/opencode.ts`、`scripts/browser-mcp-launcher.mjs`、compose 都沒有改動，符合「不可觸及」。`src/prompt/builder.ts` 不在原本的涉及檔案清單，由 Q13 新增的 SCN-009 授權（文件補記見 S3）。
- **架構**：wrapper 不是 MCP，透過 bash 呼叫，與 issue 0010 的 Chrome 收尾機制互不干涉。正式 stage 仍在 Dockerfile 最後。
- **安全**：釘版與雜湊驗證完整；`--block-private-networks` 只在 wrapper 這條路上生效，文件已寫明 Chrome 沒有這層限制，精確度問題見 S4、N1、N2、N5。證據裡沒有 token、key 或本機路徑（以 grep 掃過 `nvapi-`、`sk-`、`Bearer`、`api_key`、`/home/`、`ghp_`）。
- **測試真偽**：期望值都來自獨立的來源：假 moli 的行為照步驟 1 對真 Moli 的實測；舊版 fixture 的 sha256 經 reviewer 以 `git show 718cc8b:skills/web-reading/SKILL.md | sha256sum` 獨立核對相同；提示詞測試用的是字面字串與順序。沒有發現同義反覆或 mock 掉核心行為。突變紀錄裡斷言的目標與突變內容對得上，沒有擋下的 M6（wrapper）與 M6（同步）都已揭露並說明。不構成假綠燈。
- **觀測式驗收（step6）的反向自檢**：如果模型沒有用 Moli，fixture 就不會記到 Moli 的 UA，採樣器也看不到 wrapper，判準會是紅的。觀測器先用正負對照驗過（`results/control-analysis.jsonl`）。前三輪的重跑都是使用者在 Q11～Q14 做決定之後，針對實質變更（措辭、擬真頁面、常駐規則、換模型）重跑，作廢與失敗的結果都保留下來，不是「重試到成功為止」。
- **文件一致性**：CLAUDE.md、ARCHITECTURE.md、configuration-reference.md、installation.md、runtime-boundary-and-security.md 的描述與程式一致；例外見 N1（MOLI_ 清除）、N2（覆寫掛鉤）、S3（計畫與涉及檔案）。
- **重複與過度設計**：`scanDirectory()`、`matchesManifest()` 抽成共用函式是合理的重構。並行改名的處理有兩套寫法，見 N7，目前沒有分歧成錯誤。wrapper 的獨立 session 清理程序有對應的失敗面與突變證據，不算過度設計。

### 豁免、待確認與限制

- Gate 豁免：2026-11-11 不開 PR，改本機獨立審查。只適用於這一項。
- 待確認事項：TBD-1、TBD-2、TBD-3 都是「已解決」，結論與證據連結齊全，維持原狀態。
- 已揭露的限制（不構成缺失）：每個情境每輪只跑一次；第四輪只用 `nvidia/z-ai/glm-5.3-flash` 的 full 模式；compact、minimal 與排程沒有真模型實測；30 秒硬逾時沒有在真 Moli 上觸發過；arm64 不在範圍內。
- reviewer 沒有做的：沒有執行 docker、沒有連外網、沒有呼叫模型、沒有跑 `npm run build`。
- 流程契約 2.5 要求的記帳：README 已有 `## 現況`，位置在 `## 概述` 之後，但還沒有 `**現行 review**` 這一行。保存本報告的提交要依 review-evidence.md 補上，指向 `review-778ed0c.md`。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
