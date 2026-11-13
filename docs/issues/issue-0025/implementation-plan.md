# Issue 0025 實作計畫

驗收劇本、風險與首要驗證、涉及檔案都在 [README.md](README.md)。本檔是實作步驟的唯一來源。SCN-001～010 已於 2026-11-12 核准。

## 已決定的設計（2026-11-12，Q1～Q5 回「照建議」）

| 題號 | 決定 | 對應 |
|------|------|------|
| Q1 | 只掃 `<workspace>/.opencode/skills`（bind mount、主機看得到）；named volume 裡的全域技能目錄不在範圍內 | SCN-001～005 |
| Q2 | 和 `skills/` 不同時，比對 `skills/<名稱>` 在 git 歷史的每個版本：和某版完全相同是「舊版內建」，都不同才是「被改過」 | SCN-002、003 |
| Q3 | promote 新技能直接複製；`skills/` 已有同名時拒絕，加 `--force` 才覆寫，舊版可從 git 找回 | SCN-006～008 |
| Q4 | promote 拒絕沒有 `SKILL.md`、含 symlink；`name` 與目錄名不同、疑似 token、本機絕對路徑只警告；一律提醒自己檢查後再 commit；不自動 commit | SCN-006、007、009 |
| Q5 | `.dockerignore` 讓 `workspace/` 只放行 git 追蹤的 4 個骨架檔 | SCN-010 |

## 設計方案

### `.dockerignore`（SCN-010）

在既有的 `workspace/temp/` 規則處改成：

```text
workspace/**
!workspace/.gitignore
!workspace/.opencode/opencode.json
!workspace/.opencode/skills/.gitkeep
!workspace/projects/.gitkeep
```

`Dockerfile` 的 `COPY workspace ./workspace` 不變。

### 收成命令（SCN-001～009）

`scripts/harvest-skills.mjs`，純 Node.js 加上 `git` 命令，沒有新依賴：

- **repo 位置**：以 `git rev-parse --show-toplevel` 取得目前工作目錄所在的 repo。不在 git checkout 裡時，以非 0 結束並說明。比對基準是該 repo 的 `skills/` 與它的 git 歷史。
- **掃描位置**：`<workspace>/.opencode/skills`，`<workspace>` 預設是 repo 的 `workspace/`，可用 `--from` 指定。
- **內容比對**：每個檔案用 `git hash-object` 算 blob id。拿相對路徑與 blob id 的集合，和 `git ls-tree -r <commit> skills/<名稱>` 的結果比對，兩邊檔案集合完全相同才算相符。歷史版本取自 `git log --format=%H -- skills/<名稱>`。
- **分類順序**：
  1. symlink；
  2. 名稱在目前的 `skills/` 裡：
     - 與目前版本相同 → 與內建相同；
     - 與歷史某版相同 → 舊版內建（列出相符的短 SHA）；
     - 都不同 → 被改過（附 `git diff --no-index` 的差異）；
  3. 名稱不在目前的 `skills/`，但出現在歷史裡 → 已退役內建；
  4. 其他 → 新技能（附檔案數）。
- **promote**：
  - 先檢查以下各項，任一不符就以非 0 結束，`skills/` 不動：
    - 名稱不得含 `/`、`\` 或 `..`；
    - workspace 裡要有這個目錄；
    - 目錄裡要有 `SKILL.md`；
    - 目錄樹裡不能有 symlink；
    - `skills/` 已有同名時要加 `--force`。
  - 先複製到 `skills/` 底下的暫存目錄，再換上；`--force` 時先移走舊目錄再換上，所以少掉的檔案也會跟著移除。
  - 掃描內容後警告：
    - frontmatter `name` 與目錄名不同；
    - 疑似 token 的字串，例如 `ghp_`、`github_pat_`、`sk-`、`nvapi-`、`xox[bp]-`、Telegram bot token 的格式。只印檔案與行號，不印字串本身；
    - 以 `/home/` 開頭的路徑。
  - 最後提醒先自己檢查內容再 commit。

## 實作步驟

1. ✅ **`.dockerignore` 限縮 workspace**（SCN-010，首要驗證）——證據：[evidence/step1-dockerignore.md](evidence/step1-dockerignore.md)。改動前 6,587 個檔案、改動後 4 個；拿掉一條放行規則結果跟著變；乾淨 checkout 與正式 Dockerfile 完整建置結果相同
   - 做法：先用最小 Dockerfile（`FROM busybox`、`COPY workspace /w`、`RUN find /w -type f`）在工作目錄建置，記下改動前的檔案清單，作為紅燈；改 `.dockerignore` 後再跑一次，作為綠燈；再拿掉一條放行規則跑一次，確認結果會跟著變。另加 `tests/docker/dockerignore-workspace.test.ts`，靜態檢查這 5 條規則都在。
   - 產出：`.dockerignore`、測試、`evidence/step1-dockerignore.md`。
   - 完成判準：綠燈時建置內容的 `workspace/` 正好是那 4 個檔案；紅燈與拿掉放行規則的結果都和綠燈不同；靜態測試先紅後綠。
   - 相依：SCN-010 已核准。
2. ✅ **收成命令：列出與分類**（SCN-001～005）——紅燈 9/9 失敗（stub 只 exit 0，[evidence/step2-red.log](evidence/step2-red.log)），綠燈 9/9（[evidence/step2-green.log](evidence/step2-green.log)）。以 `--from` 唯讀掃正式部署：新技能 skill-linker、stock-analysis；被改過 scheduler；略過 7 個，其中 rag-skill 為舊版內建（與 `7e60af6` 相同）。這也更正了 README 現況表裡 scheduler 的錯誤判定
   - 做法：`tests/harvest-skills.test.ts` 在暫存目錄建一個 git repo，提交好 `skills/` 的歷史（含一個已退役、一個有舊版的技能），workspace 擺入各種情況，再以 `spawnSync` 從該 repo 執行腳本。先寫測試取紅燈，再實作。
   - 產出：`scripts/harvest-skills.mjs`、`package.json` 的 `skills:harvest`、測試、`evidence/step2-*.log`。
   - 完成判準：SCN-001～005 每個 Scenario 與 Outline 的每一列都有測試，先紅後綠；用 `--from` 對正式部署的 workspace 唯讀跑一次，分類結果和 README 現況表一致；repo 的 `git status` 不變。
   - 相依：SCN-001～005 已核准。和步驟 1 互不相依。
3. ✅ **收成命令：promote**（SCN-006～009）——紅燈 12 個失敗（[evidence/step3-red.log](evidence/step3-red.log)），補測試後綠燈 26/26（[evidence/step3-green.log](evidence/step3-green.log)）。9 個突變中 8 個轉紅（[evidence/step3-mutations.log](evidence/step3-mutations.log)）；M8（拿掉名稱檢查）沒轉紅，因為名稱含 `/` 時暫存目錄的路徑不存在，`mkdtemp` 先失敗而拒絕，名稱檢查仍保留為明確防線
   - 做法：同一份測試 fixture。拒絕的情況要驗證 `skills/` 前後的快照相同；`--force` 的情況要驗證少掉的檔案也被移除；警告的情況要驗證輸出裡沒有疑似 token 的原文。
   - 產出：腳本的 promote 部分、測試、`evidence/step3-*.log`。
   - 完成判準：SCN-006～009 每列都有測試，先紅後綠；用突變確認以下三項各有測試擋下：拿掉 symlink 檢查、拿掉同名檢查、警告印出 token 原文。
   - 相依：步驟 2。
4. ✅ **常青文件與交付檢查**——[evidence/step4-gates.log](evidence/step4-gates.log)：build、lint exit 0，test 754/754（89 個測試檔）
   - 做法：`CLAUDE.md` 的 Common Commands 加 `skills:harvest`；`CONTRIBUTING.md` 的開發流程補收成步驟，並說明本機建置現在只帶 workspace 骨架。執行 `npm run build`、`npm run test`（核對 `# tests` 與測試檔數，[L-01](../../agents/landmines.md)）、`npm run lint`。
   - 完成判準：三個指令都 exit 0；證據檔已去敏（[L-10](../../agents/landmines.md)）。
   - 相依：步驟 1～3。

### 審查修正（review-a716fc7.md，RETURN TO execute-task）

- MUST FIX：`treeAt()` 改用 `git ls-tree -z`，含中文或 `"` 的檔名、技能名不再從比對集合消失。補 3 個測試：紅燈見 [evidence/review1-red.log](evidence/review1-red.log)，綠燈見 [evidence/review1-green.log](evidence/review1-green.log)。
- S1：Telegram token 寫在 `api.telegram.org/bot` 網址裡也會警告，補 1 列測試。
- S3：SCN-007 每列都檢查拒絕原因。上一輪沒轉紅的 M8 現在有 3 個測試失敗，見 [evidence/review1-mutations.log](evidence/review1-mutations.log)。
- S2（TBD-2，使用者選 a）：名稱含 `..` 一律拒絕。紅燈見 [evidence/review1-s2-red.log](evidence/review1-s2-red.log)，綠燈見 [evidence/review1-s2-green.log](evidence/review1-s2-green.log)。
- NICE TO HAVE 6 項未處理，留在審查報告。
- 修正後的交付檢查：[evidence/step4-gates-2.log](evidence/step4-gates-2.log)，build、lint exit 0，test 759/759（89 個測試檔）。

## 測試策略

| Scenario | 層級 | 理由 |
|----------|------|------|
| SCN-001～009 | 子程序測試（暫存 git repo 加 workspace fixture） | 分類依賴真實的 git 歷史與檔案系統，用真的 `git` 最直接；不需要容器 |
| SCN-010 | 最小 Dockerfile 實際建置＋靜態規則測試 | `.dockerignore` 的語意只有 Docker 自己知道；靜態測試防止規則被誤刪 |

期望值的來源：fixture 裡的技能內容是預先寫好的字面值；正式部署的分類結果以 README 現況表為準，現況表是 2026-11-12 用 git blob 比對得來，不是從腳本的輸出抄的。

## 檢查清單

- [x] SCN-001～010 已核准（2026-11-12）
- [x] 步驟 1～3 各有紅燈→綠燈證據
- [x] 常青文件已更新
- [x] build、test、lint 都 exit 0
- [ ] 本機獨立審查 PASS
