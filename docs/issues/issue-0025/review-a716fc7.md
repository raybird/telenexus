# 審查報告
- 範圍：完整分支（`feat/issue-0025-skill-harvest`，依 README Gate 豁免紀錄不開 PR，本機審查）
- Reviewed BASE SHA：760775be7cf373df207efe152c9bdabad5ca98ec（與本機 `main` 的 merge-base，也是記錄核准的提交）
- Reviewed HEAD SHA：a716fc7c22ce21039e3f4709c988bd06b5f92e35
- Reviewed patch-id：b48fc491d015f66a884319cd94d69fe4976e0434（`git diff 760775b a716fc7 | git patch-id --stable`）
- 獨立 reviewer：Claude Code 獨立 subagent（未參與實作），2026-11-12
- Review artifact：docs/issues/issue-0025/review-a716fc7.md
- 規格基線：README `**核准 commit**` 為 `6b5392d`（不是 `待提交`，不需推導）

## 問題與風險

### MUST FIX

1. **`git ls-tree` 的路徑被 quotePath 引號包住，含非 ASCII 或 `"` 的檔名、技能名分類錯誤**：`scripts/harvest-skills.mjs:71-73`。`treeAt()` 解析 `git ls-tree -r` 的文字輸出，git 預設 `core.quotePath=true`，路徑含中文、`"`、`\` 或控制字元時輸出成 `"skills/x/\350\252\252..."`，`startsWith(prefix)` 不成立，那個檔案就從集合裡消失。`listFiles()` 拿到的是原始檔名，兩邊永遠對不上。在 scratchpad fixture 重現（HEAD 版腳本，與 skills/ 內容完全相同的副本）：
   - `skills/zh/說明.md`、`skills/q/we"ird.md`：列在「被改過的內建技能」，差異是空的（應為「與內建相同」，違反 SCN-004 第 2 列；舊版的情況同理違反 SCN-003）。
   - 技能名本身是中文（`skills/股票`）：列在「新技能」（違反 SCN-001 的 Given「名稱不在 skills/」），接著 `--promote 股票` 卻回「已存在」。
   - 同一 fixture 以 `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.quotePath GIT_CONFIG_VALUE_0=false` 執行，`股票` 就正確列為「與內建相同」，可見根因就是引號。

   目前 `skills/` 與正式部署的 workspace 都沒有非 ASCII 檔名（`LC_ALL=C find ... -name '*[^ -~]*'` 無輸出），所以這次唯讀掃描的結果正確。不過這是繁中專案，agent 做出中文檔名的技能、promote 進 `skills/` 之後，這個技能之後每次都會被誤判。建議：`ls-tree` 改用 `-z`，以 `\0` 分隔、以第一個 `\t` 切欄位（`-c core.quotePath=false` 不夠，`"` 與控制字元仍會被引號包住）；fixture 加一個含中文檔名、內容相同的技能，先紅後綠。

### SHOULD FIX

1. **Telegram bot token 最常見的寫法偵測不到**：`scripts/harvest-skills.mjs:153`。Telegram 那一段前面有 `\b`，`https://api.telegram.org/bot123456789:AA…/sendMessage` 裡 `t` 與數字之間不是字邊界，所以不警告（已重現：`TOKEN=<token>` 會警告，`bot<token>` URL 不會）。這是 Telegram bot 專案，token 寫在 API URL 裡是最可能出現的洩漏形態，`skills/` 又隨公開 repo 出貨。建議把 Telegram 那段改成 `(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}`，並在 SCN-009 加一列 URL 形態的測試。
2. **名稱含 `..` 的判定比核准文字窄**：`scripts/harvest-skills.mjs:173` 只拒絕整個名稱等於 `.` 或 `..`，以及含 `/`、`\` 的名稱。SCN-007 核准的列是「名稱含路徑分隔符號或 ..」，計畫也寫「名稱不得含 … `..`」，但 `--promote a..b` 會成功複製（已重現）。安全上沒有影響，target 仍是 `skills/` 的直接子目錄，問題在實作和核准文字不一致。`需決策`：待決問題是「含 ..」指路徑元件還是任何子字串。可選做法：(a) 程式改成拒絕任何含 `..` 的名稱，符合核准原文，不需重新核准；(b) 保留目前語意，SCN-007 該列改寫並標「待重新核准」。reviewer 建議 (a)，改一行，合法技能名幾乎不會用到 `..`。
3. **SCN-007 的拒絕測試沒有驗證「說明原因」**：`tests/harvest-skills.test.ts:195` 只斷言輸出有 `[harvest] ` 前綴。「複製失敗」那條路徑也會輸出這個前綴，所以 M8（拿掉名稱檢查）沒有轉紅，實作者已在 `evidence/step3-mutations.log` 揭露。目前每條拒絕訊息確實寫了原因（已核對 `scripts/harvest-skills.mjs:173-188`），所以不是假綠燈，屬證據持久力。建議每一列各自斷言自己的原因字樣（例如「不能含路徑」「已存在」「沒有 SKILL.md」「含 symlink」「沒有這個技能」），M8 就會轉紅。

### NICE TO HAVE

1. frontmatter 的 name 檢查（`scripts/harvest-skills.mjs:159-160`）：CRLF 換行的 `SKILL.md` 不會被解析，name 不同也不警告；`name: 'quoted'` 這類加引號的合法 YAML 會誤報「與目錄名不同」。兩者都已重現。
2. 分類比的是 `HEAD`（`treeAt(repo, 'HEAD', …)`），差異比的卻是 `skills/` 的工作樹（`:92`）。`skills/<名稱>` 有未提交的修改時（例如剛 `--promote --force` 還沒 commit），會出現「被改過」但差異是空的。
3. 列出模式附的差異會照原文印出疑似 token。這符合規格（SCN-009 只規範 promote 的警告），但正式部署的 workspace 被 agent 改過時，token 會出現在終端機輸出。可考慮套用同一個 pattern 遮罩，或在輸出開頭提醒。
4. `--from` 的相對路徑以 `process.cwd()` 解析（`:212`），而 `npm run` 的 cwd 是 repo 根目錄，從子目錄執行時相對路徑會落到別處（已重現；錯誤訊息會印出實際路徑，看得出來）。可改用 `process.env.INIT_CWD ?? process.cwd()`。
5. `historyOf()` 用預設的 history simplification（`:86`），只存在於被剪掉的側支的版本列舉不到。目前唯一的差別是 `tao-of-opencode` 的一個 merge，內容相同，沒有影響。加 `--full-history` 成本很低。
6. `retired` 的 `mkdtempSync` 在 `try` 外（`:192`），它失敗時 `staging` 不會被清掉。行程被 SIGKILL 時，`skills/.harvest-*` 也會留下來，而 `scripts/sync-skills.mjs` 會照樣同步點開頭的目錄。實際機率很低。

## 已查核維度

### 驗收與證據

| 編號 | 測試位置 | 證據 | 判定 |
|---|---|---|---|
| SCN-001 | `tests/harvest-skills.test.ts:82` | step2 紅燈 9/9 失敗→綠燈 | 通過；但技能名非 ASCII 時分類錯（MUST FIX 1） |
| SCN-002 | `:93` | 同上 | 通過 |
| SCN-003 | `:105`；突變 M4 轉紅 | 同上 | 通過；但檔名非 ASCII 時錯（MUST FIX 1） |
| SCN-004 symlink／與內建相同／已退役內建 | `:114` 三列 | 同上；M7 轉紅 | 三列都有測試；第 2 列遇非 ASCII 檔名時錯（MUST FIX 1） |
| SCN-005 | `:125`、`:138` | 同上 | 通過；另以 `--from ~/Documents/RunTelenexus/workspace` 唯讀重跑，結果與 README 現況表相同，`git status` 不變 |
| SCN-006 | `:161` | step3 紅燈 12 個失敗→綠燈 26/26 | 通過 |
| SCN-007 五列 | `:176-201`（另有「本身是 symlink」「名稱是 ..」兩列），`:245`、`:265` 測失敗回復 | 同上；M1、M2、M5、M9 轉紅，M8 未轉紅（已揭露） | 五列都有測試；「名稱含 ..」與核准原文不一致（SHOULD FIX 2），說明原因的斷言偏弱（SHOULD FIX 3） |
| SCN-008 | `:203` | 同上；M6 轉紅 | 通過：改一個檔案、刪一個檔案，斷言完全相同，也不留暫存 |
| SCN-009 三列 | `:216-242` | 同上；M3 轉紅 | 三列都有測試，行號期望值是人工推導的字面值；Telegram URL 形態有漏（SHOULD FIX 1） |
| SCN-010 | `tests/docker/dockerignore-workspace.test.ts`；`evidence/step1-dockerignore.md` | 探針改動前 6,587 個檔案、改動後 4 個；拿掉一條放行規則只剩 3 個；乾淨 checkout 與正式 Dockerfile 完整建置都是 4 個 | 通過（reviewer 依指示沒有執行 docker，採信已保存的探針證據；靜態測試已重跑通過） |

reviewer 重跑（2026-11-12，HEAD a716fc7，工作樹乾淨）：
- `npx tsx --test tests/harvest-skills.test.ts tests/docker/dockerignore-workspace.test.ts`：27/27 通過。
- `npm run test`：exit 0，`# tests 754`、pass 754；`tests/` 下有 89 個 `.test.ts`，與 step4-gates.log 相符（L-01）。
- `npm run lint`、`npx tsc --noEmit`：都是 exit 0。

### 規格基線比對（acceptance.md「規格修訂的查核」）

`git diff 6b5392d a716fc7 -- docs/issues/issue-0025/README.md` 在 Gherkin 區塊沒有任何差異。Gherkin 以外的變動：
- 概述多了一句「下表的 rag-skill 與 scheduler 正好各是一例」。
- 現況表的 scheduler 一列由「舊版內建」更正為「被改過」。
- 核准紀錄、步驟狀態、TBD-1 改為已解決、新增 Gate 豁免紀錄、Timeline、`**狀態**`。

現況表的更正已獨立查證：正式部署的 `scheduler/SKILL.md` 是 blob `15f041c1…`；`skills/scheduler` 歷史上只有 3 個版本（`b556791`、`0cb3ffe`、`f07deef`，SKILL.md blob 分別是 `723238c`、`d186932`、`b81d959`）；`git log --all --find-object=15f041c1…` 沒有輸出。rag-skill 的 6 個檔案 blob 與 `7e60af6` 的 `ls-tree` 逐一相同。Scenario 都是通用條件，SCN-006 的範例 stock-analysis 仍是新技能，所以這處更正沒有改變任何 Scenario 的條件、動作或結果，原核准有效。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| 檔名或技能名含非 ASCII、`"` | 與一般檔名相同 | 無測試；reviewer 重現錯誤 | MUST FIX 1 |
| 名稱 `../x`、`..`、`a/b` | 拒絕，不寫出 `skills/` | 有測試；`mkdtemp` 也會意外擋下 | 通過 |
| 名稱 `a..b` | 依核准原文應拒絕 | 無；實際被接受 | SHOULD FIX 2 |
| `skills/` 的同名項目是 symlink（`--force`） | 只搬走 symlink，不跟隨 | `renameSync` 不跟隨 symlink（讀程式碼） | 通過 |
| 複製失敗、換上失敗、`--force` 時舊版回復 | `skills/` 不變、不留暫存 | `:245`、`:265`；M5、M9 轉紅 | 通過 |
| 疑似 token 只印位置 | 不印原文 | `:231`；M3 轉紅 | 通過；Telegram URL 形態漏網（SHOULD FIX 1） |
| 本機 `/home/` 路徑 | 警告檔案與行號 | `:219` | 通過 |
| `--force` 單獨使用、參數缺值、未知參數 | 非 0 | 讀程式碼 | 通過（規格外的防呆） |
| 不在 git checkout 裡 | 非 0 並說明 | `:150` | 通過 |
| `.gitattributes`／autocrlf | blob id 與 ls-tree 可比 | repo 沒有 `.gitattributes`；`hash-object --no-filters` 對 LF 提交的內容正確 | 通過 |
| 合併提交讓歷史版本被剪掉 | 列舉每個版本 | 無；目前無影響 | NICE 5 |
| BuildKit 對「排除後再放行」的處理 | 只帶 4 個骨架檔，`opencode.json` 不遺失 | step1 探針、對照組與完整建置 | 通過；legacy builder 未測，已揭露。`.gitignore`、`*.md` 這類規則只錨定在根目錄，不會蓋掉 `workspace/` 的放行規則 |
| 日後新增 git 追蹤的 workspace 檔 | 放行清單跟著更新 | 靜態測試比對 `git ls-files workspace` | 通過 |

### 需求、架構、安全、品質
- **需求**：「不可觸及」的 `scripts/sync-skills.mjs`、`Dockerfile`、`docker-compose*.yml` 都沒有變動。新增的略過原因「目錄裡含 symlink」、`--help` 屬合理延伸，不衝突。
- **架構**：腳本只在主機執行。`Dockerfile` 會把 `scripts/` 複製進映像，但腳本需要 git checkout，在容器裡只會以非 0 結束，不在任何服務的執行路徑上。
- **安全**：`skills/` 以外寫不出去：名稱檢查之外，暫存目錄與 target 都是 `skills/` 的直接子項。token 警告不印原文，Telegram URL 形態有漏（SHOULD FIX 1）。證據檔已去敏：沒有 `/home/kevin`，也沒有真實 token 格式。
- **常青文件**：`CLAUDE.md` 的 Common Commands、`CONTRIBUTING.md` 的開發流程已更新，與程式行為一致。README「本機開發」的建置步驟沒有改變，不需要更新。`docs/README.md` 沒有新增 docs 文件，不需要更新。
- **重複與過度設計**：`listFiles()` 由分類與 promote 共用，沒有分歧的重複邏輯。暫存加回復的機制是為了滿足「skills/ 沒有任何變動」，份量合理。
- **提交訊息**：格式是 `type(scope): 中文摘要`，沒有 AI 署名。

### 豁免、待確認與限制
- Gate 豁免：不開 PR，改由本機獨立審查（README 已記錄）。
- reviewer 依指示沒有執行 docker，SCN-010 的 BuildKit 行為採信 `evidence/step1-dockerignore.md`。legacy builder 未實測，由實作者揭露。
- M8 未轉紅由實作者主動揭露，不構成缺失。
- 協調者保存本報告時，依流程契約 2.5 在 README `## 概述` 之後新增 `## 現況`，並寫入 `**現行 review**`：review-a716fc7.md。

## 流程判定
RETURN TO execute-task

理由：MUST FIX 1 是邏輯錯誤，遇到含非 ASCII 或 `"` 的檔名、技能名時，違反已核准的 SCN-001、SCN-003、SCN-004 第 2 列。修正後請連同 SHOULD FIX 1～3 一起處理（SHOULD FIX 2 先取得使用者決定），再送審。
