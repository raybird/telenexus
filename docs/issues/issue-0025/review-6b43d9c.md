# 審查報告
- 範圍：完整分支（`feat/issue-0025-skill-harvest`，依 README Gate 豁免紀錄不開 PR，本機審查）。這是 review-a716fc7.md 判定 RETURN 之後的完整重審，範圍是整個 `760775b..6b43d9c`，不只 a716fc7 之後的修正
- Reviewed BASE SHA：760775be7cf373df207efe152c9bdabad5ca98ec（與本機 `main` 的 merge-base）
- Reviewed HEAD SHA：6b43d9c776e35559d283a90b725b60704ce6e2c5
- Reviewed patch-id：d083a7ef60e47de3463234c2cdb6722c19d3ff07（`git diff 760775b 6b43d9c | git patch-id --stable`）
- 獨立 reviewer：Claude Code 獨立 subagent（未參與實作，也沒有參與上一輪審查），2026-11-13
- Review artifact：docs/issues/issue-0025/review-6b43d9c.md
- 規格基線：README `**核准 commit**` 是 `6b5392d`，不是 `待提交`，不需推導。另依 acceptance.md 的命令推導，最後修改 `**核准來源**` 的提交是 `760775b`（記錄核准的提交）。兩者之間 Gherkin 區塊沒有差異

## 問題與風險

### MUST FIX
無。

### SHOULD FIX

1. **技能目錄檔案很多時，列出模式整個當掉**：`scripts/harvest-skills.mjs:63`。`blobMap()` 把技能的所有檔案路徑一次塞進 `git hash-object` 的命令列參數。檔案數超過系統的參數長度上限時，`execFileSync` 丟出 `spawnSync git E2BIG`，沒有被接住，整個命令印出 Node 的 stack trace 並以 1 結束。所以只要有一個技能太大，其他技能也全部列不出來。
   - 重現：scratchpad fixture 的單一技能有 15,001 個檔案時 E2BIG，8,001 個時正常。scratchpad 路徑比正式部署長，實際門檻大約在一兩萬個檔案。
   - 觸發條件：一個技能裡要有上萬個一般檔案，而且沒有 symlink。有 symlink 的技能在 `listFiles()` 就被略過，不會跑到 hash-object。npm 的 `node_modules/.bin`、pnpm、Python venv 都含 symlink，所以實際的觸發來源主要是 agent 在技能目錄累積的資料檔，例如快取的股價 CSV。
   - 不列 MUST FIX 的理由：失敗時有明顯的錯誤，不會分錯類，也不會改到檔案。目前兩個部署都沒有這麼大的技能，正式部署最大的 stock-analysis 是 21 個檔案。
   - 建議：分批呼叫 hash-object，例如每 500 個路徑呼叫一次。不建議改用 `--stdin-paths`，它以換行分隔，含換行的檔名會出錯，而目前的寫法正確處理了這種檔名（見下方失敗面表）。

### NICE TO HAVE

上一份報告的 6 項 NICE TO HAVE 都沒有處理，`implementation-plan.md` 寫明「留在審查報告」。本輪逐項確認程式沒有變，仍然成立：

1. `scripts/harvest-skills.mjs:161-163`：CRLF 換行的 SKILL.md 不會解析 frontmatter；`name: 'quoted'` 這種加引號的寫法會誤報名稱不同。
2. 分類比對的是 `HEAD`（`:119`），差異比對的卻是 `skills/` 的工作樹（`:93`）。
3. 列出模式附的差異會照原文印出疑似 token（`:145`）。
4. `--from` 的相對路徑以 `process.cwd()` 解析（`:215`）。
5. `historyOf()` 沒有加 `--full-history`（`:87`）。
6. `retired` 的 `mkdtempSync` 寫在 `try` 外面（`:195`）。

本輪新增：

7. `sk-` 規則會誤報一般英文詞（`:155`），例如 `sk-learn-model-selection-guide` 也會被當成 token 警告。這只會多出一條警告，不會擋下複製。可以改成要求 `sk-` 後面的字串夠長而且混有數字，或乾脆接受誤報。
8. `CLAUDE.md:50` 的範例寫死維護者自己的部署路徑 `~/Documents/RunTelenexus/workspace`，CONTRIBUTING.md 用的則是 `<部署的 workspace>`。這個路徑已經出現在 `docs/2026-08-16-runtime-resource-handover.md`，不算新的洩漏。不過 CLAUDE.md 是公開 repo 的通用說明，改成佔位字串會比較一致。
9. 在還沒有任何 commit 的 git repo 執行時，`git ls-tree HEAD` 失敗，命令印出 stack trace。TeleNexus checkout 不會遇到這種情況，只是錯誤訊息不友善。

## 上一份報告（review-a716fc7.md）各項的處理

| 項目 | 修正 | reviewer 獨立確認 | 判定 |
|---|---|---|---|
| MUST FIX：`ls-tree` 替含中文或 `"` 的路徑加引號 | `treeAt()` 改成 `ls-tree -r -z`，以 `\0` 切分，regex 加 `s` 旗標（`:71-73`） | 自做突變 X1，改回不帶 `-z` 的輸出：3 個新測試轉紅（`tests/harvest-skills.test.ts:303`、`:312`、`:321`）。scratchpad fixture 另外驗證了檔名含換行的 `nl/line⏎break.md`，以及 `[ab]`、`a*`、`-dash`、`sp ace` 這些技能名，都正確分為「與內建相同」或「舊版內建」。`git ls-tree` 會關掉 pathspec 萬用字元，再加上 `startsWith(prefix)` 的字面比對，`git log` 用萬用字元多抓到的提交會因為樹是空的被濾掉 | 已解決 |
| S1：Telegram token 寫在網址裡偵測不到 | Telegram 那段移出 `\b` 群組，改成 `(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])`（`:155`）；新增 URL 形態的測試（`:224`），並斷言輸出沒有 token 原文 | 自做突變 X4，改回 `\b` 的寫法：該測試轉紅。實測 `bot<id>:<35 字元>/getMe`、`TOKEN="…"`、`TELEGRAM_TOKEN=…` 都會警告。11 位數的 id、或冒號後超過 35 個字元的字串不會警告，這符合 Telegram 的格式 | 已解決 |
| S2（`需決策`，使用者 2026-11-13 選 a）：名稱含 `..` | 改成 `name.includes('..')`（`:176`）；新增「名稱中間含 ..」測試（`:187`） | 自做突變 X2，改回 `name === '..'`：該測試轉紅。實作符合 SCN-007 核准原文「名稱含路徑分隔符號或 ..」。README TBD-2 已記下使用者的決定，結論寫明不需重新核准，理由成立 | 已解決 |
| S3：拒絕測試要逐列斷言原因 | refusals 每列加上自己的原因 regex（`:176-198`） | 自做突變 X3，只拿掉 `/[/\\]/` 檢查：「名稱含路徑分隔符號」轉紅，因為輸出變成「沒有 SKILL.md」，比對不到「不能含路徑」。實作者的 M8（拿掉整條名稱檢查）上一輪沒轉紅，這一輪有 3 個測試失敗（`evidence/review1-mutations.log`） | 已解決 |

修正有沒有帶進新問題：`-z` 搭配 `s` 旗標，也能正確處理含換行的路徑。Telegram 規則的 lookbehind 只限制前一個字元不能是數字，不影響其他 token 規則。`includes('..')` 也會擋下 `...` 這類名稱，屬於核准範圍。沒有發現回歸。

## 已查核維度

### 驗收與證據

| 編號 | 測試位置 | 證據 | 判定 |
|---|---|---|---|
| SCN-001 | `tests/harvest-skills.test.ts:82`；中文技能名 `:312` | step2 紅燈 9/9 失敗→綠燈；review1 紅燈→綠燈 | 通過。限制見 SHOULD FIX 1 |
| SCN-002 | `:93` | step2 | 通過 |
| SCN-003 | `:105`；中文檔名的舊版 `:321` | step2、review1；突變 M4 轉紅 | 通過 |
| SCN-004 symlink／與內建相同／已退役內建 | `:114` 三列；含中文、引號檔名 `:303` | step2、review1；M7 轉紅 | 三列都有測試，通過 |
| SCN-005 | `:125`、`:138` | step2 | 通過。reviewer 以 `--from ~/Documents/RunTelenexus/workspace` 唯讀重跑：新技能 skill-linker（1）、stock-analysis（21）；被改過 scheduler；略過 7 個，其中 rag-skill 是舊版內建（與 7e60af6 相同）。結果與 README 現況表相同，執行前後 `git status --porcelain --ignored` 不變 |
| SCN-006 | `:161` | step3 | 通過：內容相同、提醒先檢查、HEAD 不變、只多 `?? skills/newskill/` |
| SCN-007 五列 | `:176-204`（另有「本身是 symlink」「名稱是 ..」「以 .. 指向外部」「中間含 ..」）；失敗回復 `:251`、`:270` | step3、review1、review1-s2；M1、M2、M5、M8、M9、X2、X3 轉紅 | 五列都有測試，每列都斷言原因，通過 |
| SCN-008 | `:206` | step3；M6 轉紅 | 通過 |
| SCN-009 三列 | `:220-247`（另有 Telegram URL 一列） | step3、review1；M3、X4 轉紅 | 三列都有測試；行號期望值是人工推導的字面值；斷言沒有印出 token 原文，通過 |
| SCN-010 | `tests/docker/dockerignore-workspace.test.ts`；`evidence/step1-dockerignore.md` | 探針改動前 6,587 個檔案、改動後 4 個；拿掉一條放行規則只剩 3 個；乾淨 checkout 與完整建置都是 4 個 | 通過。reviewer 依指示沒有執行 docker，採信已保存的 BuildKit 證據；靜態測試重跑通過 |

reviewer 重跑（2026-11-13，HEAD 6b43d9c，工作樹乾淨）：
- `npx tsx --test tests/harvest-skills.test.ts tests/docker/dockerignore-workspace.test.ts`：32/32 通過。
- `npm run test`：exit 0，`# tests 759`、pass 759、fail 0。`tests/` 下有 89 個 `.test.ts`，與 `evidence/step4-gates-2.log` 相同（L-01）。
- `npm run lint`、`npx tsc --noEmit`：exit 0。
- 突變 X1～X4：在 scratchpad 以 `git archive 6b43d9c` 解出的副本上做，repo 沒有被修改；跑完以 `cmp` 確認還原。

證據查核：
- 紅綠燈：review1-red（f0b7ec5 的程式加新測試，4 個失敗：Telegram URL 與 3 個非 ASCII 測試）→ review1-green 30/30；review1-s2-red（edc985d，1 個失敗）→ review1-s2-green 31/31。每段都記了命令、被測版本與 exit code。
- S3 加的是斷言，舊程式本來就會印出原因，所以沒有紅燈。它的效果由 M8 證明，M8 這一輪會轉紅。
- step4-gates-2.log 驗的是 7c58619。7c58619 到 6b43d9c 只多了 log 與文件，與程式無關。
- 證據去敏：evidence 裡沒有 `/home/kevin`；token 樣式只有測試用的假值 `A1b2C3d4E5…`、`AbCdEfGhIj…`。

### 規格基線比對（acceptance.md「規格修訂的查核」）

`git diff 6b5392d 6b43d9c -- docs/issues/issue-0025/README.md` 的 Gherkin 區塊（SCN-001～010 與各 Outline 的 Examples）沒有任何差異。其他變動都不改條件、動作或結果：
- 概述多了一句「下表的 rag-skill 與 scheduler 正好各是一例」。
- 現況表的 scheduler 更正為「被改過」。上一輪已獨立查證；本輪的唯讀掃描也把它列為「被改過」。
- 新增 `## 現況`，位在 `## 概述` 之後、`## 快速導覽` 之前，位置正確。
- 核准紀錄、步驟狀態、TBD-1 與 TBD-2、Gate 豁免紀錄、Timeline、`**狀態**: 待審查`。

TBD-2 採 (a)，讓實作向核准原文看齊，不是修改規格，所以不需要重新核准。結論：原核准有效，SCN-001～010 都是 `已核准`。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| 檔名或技能名含中文、`"` | 與一般檔名相同 | `:303`、`:312`、`:321`；X1 轉紅 | 通過 |
| 檔名含換行；技能名含 `[`、`*`、前置 `-`、空白 | 正確分類 | reviewer 的 scratchpad fixture | 通過（沒有寫成測試，屬罕見情況） |
| 單一技能有上萬個一般檔案 | 正常列出 | 無；reviewer 重現 E2BIG | SHOULD FIX 1 |
| 名稱 `a..b`、`..`、`../x`、`a/b`、`.` | 拒絕，`skills/` 不變 | refusals 各列；X2、X3、M8 轉紅 | 通過 |
| 名稱 `--promote ''` 或缺值、`--force` 單獨使用、未知參數 | 非 0 | 讀程式碼（`:20`、`:27`、`:29`） | 通過（規格外的防呆） |
| 複製失敗、換上失敗、`--force` 時把舊版移回 | `skills/` 不變、不留暫存 | `:251`、`:270`；M5、M9 轉紅 | 通過 |
| `skills/` 的同名項目是 symlink 或檔案（`--force`） | 只搬走該項目，不跟隨連結 | `renameSync` 不跟隨 symlink（讀程式碼） | 通過 |
| 疑似 token（含 Telegram 網址形態） | 只印檔案與行號 | `:222`、`:224`；M3、X4 轉紅 | 通過；`sk-` 會誤報（NICE 7） |
| frontmatter 是 CRLF 或加引號 | 正確比對 name | 無 | NICE 1（沿用） |
| 分類用 HEAD、差異用工作樹 | 一致 | 無 | NICE 2（沿用） |
| 列出模式的差異含 token | 不在規格範圍 | 無 | NICE 3（沿用） |
| 歷史裡被 merge 簡化掉的版本 | 列舉每個版本 | 無；目前沒有影響 | NICE 5（沿用） |
| `.gitattributes`、autocrlf | blob id 與 ls-tree 可比 | repo 沒有 `.gitattributes`；`hash-object --no-filters` | 通過 |
| tree 裡的 symlink（120000）、submodule（160000） | 不造成誤判 | workspace 端遇到 symlink 先略過；submodule 不符合 `blob` regex | 通過 |
| BuildKit 對「排除後再放行」的處理 | 只帶 4 個骨架檔，`workspace` 目錄本身仍在 | step1 探針與對照組。`workspace/**` 不會匹配 `workspace` 目錄本身，`COPY workspace` 不會因此找不到來源。根目錄的 `.gitignore`、`*.md` 規則只錨定在根目錄 | 通過；legacy builder 未測，已揭露 |
| 日後新增 git 追蹤的 workspace 檔 | 放行清單跟著更新 | 靜態測試比對 `git ls-files workspace` | 通過 |

### 需求、架構、安全、品質
- **需求**：「不可觸及」的 `scripts/sync-skills.mjs`、`Dockerfile`、`docker-compose*.yml` 在整個範圍都沒有變動（`git diff --stat` 查核）。不自動 commit、不自動 promote、不讀 named volume，都符合「不在範圍內」。
- **架構**：腳本只在主機執行。映像會帶 `scripts/`，但腳本需要 git checkout，在容器裡只會以非 0 結束，不在任何服務的執行路徑上。
- **安全**：寫入只限 `skills/` 的直接子項：名稱檢查之外，暫存目錄與 target 都是 `path.join(repo, 'skills', …)`。token 警告不印原文。`.dockerignore` 讓本機映像不再帶進 `workspace/` 的執行期資料（Memoria、projects、技能），這同時降低了把私人資料打包進映像的風險。
- **常青文件**：`CLAUDE.md` 的 Common Commands、`CONTRIBUTING.md` 的開發流程（新增第 3 步，原第 3 步改為第 4 步，編號連續）與程式行為一致。沒有新增 docs 文件，`docs/README.md` 不需要更新。README「本機開發」的命令沒有改變。
- **重複與過度設計**：`listFiles()` 由分類與 promote 共用；`TOKEN_PATTERN` 在 `src/`、`scripts/` 沒有其他副本，沒有分歧的重複邏輯。暫存加回復的機制是為了滿足 SCN-007「skills/ 沒有任何變動」，份量合理。
- **提交訊息**：都是 `type(scope): 中文摘要`，沒有 AI 署名。

### 豁免、待確認與限制
- Gate 豁免：不開 PR，改由本機獨立審查（README 已記錄）。
- 待確認事項：TBD-1、TBD-2 都已解決，結論與日期齊全。
- reviewer 依指示沒有執行 docker，SCN-010 採信 `evidence/step1-dockerignore.md`；legacy builder 未實測，已由實作者揭露。
- 上一輪的 6 項 NICE TO HAVE 是實作者明說不處理，不構成缺失。
- 協調者保存本報告時，依流程契約 2.5 把 README `## 現況` 的 `**現行 review**` 改成 `review-6b43d9c.md`。

## 流程判定
PASS

理由：上一份報告的 MUST FIX 與 S1～S3 都已解決，而且由突變獨立確認。全範圍沒有新的 MUST FIX。SCN-001～010 與每一列 Outline 都有先紅後綠或等價的證據，規格基線沒有變。SHOULD FIX 1（大量檔案時 E2BIG）與 NICE TO HAVE 不阻擋本次交付。
