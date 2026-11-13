# 審查報告
- 範圍：完整分支 diff（本機流程，不開 PR；Gate 豁免紀錄 2026-11-13）
- Reviewed BASE SHA：a530da8aa96be239a044ff22a9e790b699b245e0（與本機 main 的 merge-base，也是 issue 文件的核准提交）
- Reviewed HEAD SHA：aadf0a4b5693f246cb7cd2044e922d8bb18ec565
- Reviewed patch-id：4ed76392b6949e8c7872d84d87f5073768b02dc9（`git diff a530da8 aadf0a4 | git patch-id --stable`）
- 獨立 reviewer：Claude Code 獨立 subagent（未參與實作），2026-11-13
- Review artifact：docs/issues/issue-0026/review-aadf0a4.md
- 審查依據：dev-rules-kit v4.11.0 候選版 review skill；docs/AGENTS.md（流程契約 2.5、文件版本 2.10）、docs/agents/project.md、acceptance.md、verification.md、review-evidence.md

## 問題與風險

### MUST FIX
無。

### SHOULD FIX
- **S-1：再確認時「原處暫時不存在」的分支沒有測試。** `scripts/sync-skills.mjs:161`（`upgradedElsewhere()` 裡 `if (isMissing(error)) return true;`）。把它改成 `return false`（突變 X1），`tests/skill-web-reading-upgrade.test.ts` 19 個測試全部通過；300 輪並行壓測也是 0 次誤報，因為這個窗口只在另一個服務兩次改名之間的幾微秒。行為本身正確：reviewer 用掛勾在 B 讀完舊版 `SKILL.md` 後，自己把原處改名到備份（模擬 A 做完第一次改名，或 A 在兩次改名之間被殺），HEAD 安靜結束，一般同步補上新版；X1 突變則印出「web-reading 備份已存在…新版網頁閱讀指引未套用」。這正是 AC-1 要防的誤報，程式註解（`sync-skills.mjs:141`、`:156`）也明說「正在被換（暫時不存在）就安靜結束」，但目前沒有任何測試守住它。建議照上述做法補一個定點測試：用 `raceHook` 的寫法，掛勾內只做 `renameSync(candidate, backup)`，斷言 B 不誤報、最終原處是新版、只有一份備份。

### NICE TO HAVE
- **N-1：1 小時門檻的數值沒有被測試釘住。** `sync-skills.mjs:217`。把門檻改成 1 秒（突變 X3）測試照樣全過，只有放大到 3 小時（X4）或拿掉門檻（實作者的 M4）才會被擋。AC-3 的檢查方式只要求「剛建立的暫存不刪」，測試已滿足；但這個門檻是用來保護另一個服務正在用的暫存，如果數值被誤改小，測試擋不住。可以在 `tests/skill-web-reading-upgrade.test.ts:319` 的 fixture 加一個 59 分鐘前的暫存。
- **N-2：暫存前綴寫了兩次。** `sync-skills.mjs:191` 的 `mkdtempSync` 仍寫字面值 `'.web-reading-new-'`，清理用的是 `:218` 的 `STAGING_PREFIX`。兩者若只改一邊，清理會認不出暫存，而且測試擋不住：清理測試是自己手動建目錄，不是用升級程式產生的暫存。建議 `mkdtempSync` 也改用 `STAGING_PREFIX`。
- **N-3：名稱長度檢查沒有測試，作用也很小。** `sync-skills.mjs:224` 的 `entry.name.length === STAGING_PREFIX.length` 只會排除剛好叫 `.web-reading-new-` 的目錄；`.web-reading-new` 本來就不符合 `startsWith`。拿掉它（突變 X5）測試全過。看要拿掉，還是補一個 fixture。
- **N-4：一個暫存刪不掉，同一輪後面的暫存都不清。** `sync-skills.mjs:230` 遇到非 ENOENT 錯誤就往外丟，迴圈直接結束。reviewer 實測：4 個過期暫存中第 2 個含不可寫的子目錄，結果第 1 個被刪，第 3、4 個保留，而且每次啟動都會印「清除過期的 web-reading 暫存失敗」。最終狀態仍然安全（只是沒清乾淨），可以改成逐項 try/catch。專案曾經遇過 root 遺留檔（L-08 類型），所以不是完全不可能。
- **N-5：第三個競爭測試沒有檢查暫存殘留。** `tests/skill-web-reading-upgrade.test.ts:357` 沒用 `assertUpgradedOnce`，自己逐項斷言，但少了 `f.leftovers()` 的檢查，AC-1 的「只有一份備份」在這個測試裡少了一半。
- **N-6：兩個服務會對同一個過期暫存各印一次 `Removed stale web-reading staging`。** `rmSync` 用了 `force: true`，所以後到的那個也不會報 ENOENT。reviewer 實測 100 輪、每輪 3 個暫存，一共印了 522 次。只影響日誌，不影響正確性。

## 已查核維度

### 驗收與證據

| 編號 | 證據 | 結論 |
|---|---|---|
| AC-1 | 三個定點競爭測試：`tests/skill-web-reading-upgrade.test.ts:298`、`:308`、`:357`。reviewer 把 HEAD 的測試放到 BASE 的程式上跑，三個都紅（not ok 15、16、19），在 HEAD 上綠；`evidence/red.log`、`evidence/red-multifile.log` 與此相符。reviewer 另做 200 輪並行壓測，新版有子目錄：BASE 誤報 15 次，HEAD 0 次，兩邊最終狀態都正確 | 通過；「原處暫時不存在」分支缺測試，見 S-1 |
| AC-2 | SCN-008 的客製、symlink、備份已存在等測試照樣通過；把再確認改成一律當作已換上（實作者 M3），這 5 個測試都會失敗 | 通過 |
| AC-3 | `tests/skill-web-reading-upgrade.test.ts:319`、`:343`。BASE 紅、HEAD 綠；實作者的 M4～M8 與 reviewer 的 X2、X4 都有測試擋下 | 通過；門檻數值與長度檢查見 N-1、N-3 |
| AC-4 | reviewer 在 `git archive aadf0a4` 的副本上跑 `npx tsx --test tests/skill-web-reading-upgrade.test.ts tests/skill-browser-migration.test.ts`：31/31。`npm run test`：764 個測試、89 個檔案，763 個通過；唯一失敗的 SCN-010（`tests/docker/dockerignore-workspace.test.ts`）要呼叫 `git ls-files`，而 archive 副本不是 git repo，在 repo 工作樹單獨跑是 1/1 通過。`npm run lint`、`npx tsc --noEmit` 都是 exit 0 | 通過，與 `evidence/gates.log` 的 764/764、89 個檔案一致 |

證據的持久力：`green.log` 與 `mutations.log` 記的被測版本是「未提交的工作樹」，`gates.log` 記的是 65ce42a。65ce42a 到 aadf0a4 之間只有 README 與 gates.log 的變更，而且 reviewer 已在 aadf0a4 上重跑，所以結論以本報告的重跑為準。這只是證據持久力的揭露，不構成缺失。

### 規格基線比對
- 分級為 Small + Low，依 acceptance.md 不需要 `**核准 commit**`；README 也沒有這個欄位。最後一個修改 `**核准來源**` 欄位行的提交，用 acceptance.md 的推導命令找出來是 a530da8。
- 把 `## 驗收條件` 到 `## 風險與首要驗證` 之間的內容，在 a530da8 與 aadf0a4 逐字比對：完全相同。README 的 30 行差異都在「實作與驗證步驟」的完成證據、Timeline 與 `**狀態**`。原核准有效，不需要重新核准。
- AC-1 的檢查方式寫的是「B 讀舊版之前、B 判定是舊版之後」，實作的第一個測試寫成「B 讀到舊版之後、判斷之前」。這兩種說法在舊程式上落在同一個時間點：第一次掃描讀完之後、第二次拿舊版比對之前，紅燈也重現了 S-D 描述的「有自訂內容」誤報。所以這屬於選擇等價的驗證，不是規格變更。第三個測試是額外補上的。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋與判定 |
|---|---|---|
| B 掃描到舊版，A 隨即換上新版（在讀檔後、在檢查備份前、在列完目錄後） | B 安靜結束 | 三個定點測試加上壓測；通過 |
| B 掃描完成後，A 正在兩次改名之間（原處暫時不存在） | B 安靜結束，A 或一般同步補上新版 | 行為正確（reviewer 定點驗證），但沒有測試；見 S-1 |
| 原處真的有客製內容、是 symlink，或備份已存在而原處是舊版 | 照舊警告並原地保留 | `upgradedElsewhere()` 只有在原處內容與新版 manifest 完全相同，或原處不存在時才放行；客製內容不可能等於新版，symlink 會讓 `scanDirectory` 回 null。另一個服務只會把掃描結果符合舊版的目錄改名，不會把客製內容移走。SCN-008 測試與 M3 突變都守住這點；通過 |
| B 的掃描混到 A 換新途中的狀態，結果判為客製；A 換新失敗並把舊版移回 | A 警告「未升級」；B 在再確認時看到舊版，印出「有自訂內容」 | B 這行字措辭不精確（實際上是舊版），但要先發生換新失敗這個故障，再剛好撞上競爭，A 也會另外警告。屬殘餘，不列發現 |
| 清理：`.web-reading-new-*` 是檔案或 symlink | 不動 | `Dirent.isDirectory()` 遇到 symlink 回 false；M6 測試涵蓋檔案；通過 |
| 清理：`retired-skills` 本身或上層路徑是 symlink | 不動 | `pathHasSymlink(dir)`、`:343` 測試、M7 突變。升級時的備份位置用的是同一套 symlink 判斷，所以不會在那種路徑底下產生暫存，兩邊一致；通過 |
| 清理：另一個服務正在用的暫存 | 不刪 | 暫存是 mkdtemp 新建的，複製時頂層新增項目會更新 mtime，存在時間只有毫秒級，1 小時門檻足夠；門檻數值見 N-1 |
| 清理：mtime 在未來（時鐘偏差） | 不刪 | 差值是負數，小於門檻；通過 |
| 清理：兩個服務同時刪同一批過期暫存 | 不出錯、刪乾淨、不碰其他項目 | reviewer 100 輪壓測：0 次警告、0 個殘留、其他項目都沒被動；只有重複印日誌，見 N-6 |
| 清理：一個暫存刪不掉（EACCES） | 警告，不中止同步 | 由 `syncBuiltinSkills` 的 try/catch 接住（X2 突變會被 S1 測試擋下）；但同一輪後面的暫存不會清，見 N-4 |
| 掛勾測試會不會空轉 | 掛勾必須真的觸發 A | `:286` 斷言 log 存在，另外斷言 A 印出 `Upgraded builtin web-reading`；比對的路徑字串與程式實際傳入的一致；在 BASE 上會紅；通過 |

### 需求、架構、安全、品質
- **需求**：改動範圍與「涉及檔案」一致，`retireBuiltinBrowser()` 與一般同步都沒動；不在範圍內的項目也沒有順手處理。
- **文件與程式**：`docs/installation.md` 的描述（先換上的那個服務印 `Upgraded`、另一個安靜結束；只刪超過 1 小時的 `.web-reading-new-` 目錄；其他名稱、檔案、含 symlink 的路徑都不動）與程式相符。理論上有一個窗口兩邊都不會印 `Upgraded`：A 做完第一次改名後，B 的一般同步先把原處補上，A 第二次改名遇到 ENOTEMPTY 而安靜返回。這個窗口在 BASE 就存在，reviewer 壓測 200 輪沒有出現，不列發現。依 project.md 的常青文件責任表，這次只需要更新 installation.md；CLAUDE.md 與 ARCHITECTURE.md 不用改。
- **重複與過度設計**：`sameContent()` 從原本的比對函式抽出來，讓原處只掃描一次，這是合理的拆法。`:172` 的提早返回在功能上和後面的再確認重複（拿掉它的突變 X8 測試全過），但它省掉一次掃描，可以保留。`upgradedElsewhere()` 和 `retireBuiltinBrowser()` 的 `anotherWorkerFinished()` 判斷的東西不同，沒有已經分歧的重複邏輯。暫存前綴寫了兩次，見 N-2。
- **安全**：只刪固定名稱格式、是目錄、超過門檻的項目，而且整條路徑不能含 symlink。`rmSync` 遇到 symlink 只會刪連結本身；從 readdir 到 rmSync 之間即使有東西被換掉，也不會沿著連結往外刪。

### 967d247（dev-rules-kit v4.11.0 候選版）
- 只改了 4 個檔案：`docs/.dev-rules-kit.json`、`docs/AGENTS.md`、`docs/agents/review-evidence.md`、`docs/agents/verification.md`。
- 三份文件的 SHA-256 與候選版副本（`dev-rules-kit-v4.11.0-trial/docs/`）以及 `.dev-rules-kit.json` 記錄的雜湊三者一致，可見是工具直接套用，沒有手改。
- `docs/agents/project.md`、`landmines.md`、`acceptance.md` 在這段範圍內都沒有變更。
- 舊錨點 `#合法的中間狀態與終態` 在 repo 中已經沒有引用，只剩修訂紀錄裡的文字；`verification.md` 已改連新錨點。
- kit 文字本身的設計不在本次審查範圍內。

### 豁免、待確認與限制
- Gate 豁免紀錄：不開 PR，改在本機獨立審查（使用者 2026-11-13）。本報告依此保存在 issue 目錄。
- 沒有待確認事項。
- 限制：沒有執行 docker，也沒有連網；並行行為以本機 node v22.20.0 的程序壓測與定點掛勾驗證，沒有在實際的雙容器共用 volume 上重現。
- 提交本報告時：README 目前沒有 `## 現況`。依流程契約 2.5，保存報告的同一個提交要在 `## 概述` 之後建立 `## 現況`，並把 `**現行 review**` 指向本報告；之後執行 review skill 的 `scripts/verify-artifact.py` 確認 PASS 仍然有效。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
