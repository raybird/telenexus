# Issue 0026 - web-reading 升級在兩個服務同時同步時誤報「新版未套用」，被殺時留下暫存目錄 (Small)

GitHub：[#26](https://github.com/raybird/telenexus/issues/26)

## 概述

issue 0024 讓 `scripts/sync-skills.mjs` 在啟動時，把沒被改過的已出貨舊版 `web-reading` 換成新版。做法是先複製到 `retired-skills/` 底下的暫存目錄，再以兩次改名換上。telenexus 與 agent-runner 會同時執行這支腳本，兩者共用 `./workspace` 與 `opencode_config`。

issue 0024 的第四次審查（`docs/issues/issue-0024/review-b38af46.md`）留下兩個問題，使用者決定另開本 issue：

- **S-D：誤報。** `upgradeBuiltinWebReading()` 對原處掃描兩次，第一次比新版、第二次比舊版。如果另一個服務在這兩次之間換上了新版，這個服務會警告「有自訂內容」或「備份已存在」，說新版網頁閱讀指引未套用，但新版其實已經換上。
  - reviewer 跑了 200 輪並行測試，誤報「有自訂內容」9 次、「備份已存在」5 次，最終狀態全部正確。
  - 現有的並行測試只檢查最終狀態，不檢查輸出。
- **N-H：暫存殘留。** 行程在複製到暫存的途中被殺，或在兩次改名之間被殺，`retired-skills/.web-reading-new-*` 都會一直留著。下次啟動時一般同步會補上新版，最終狀態正確。

**不在範圍內**：
- 恢復時一般同步的 `cpSync` 不是原子操作（兩次故障疊加，BASE 就有的寫法）。
- `retireBuiltinBrowser()` 的改名錯誤處理（issue 0024 審查 N-B，issue 0010 的既有行為）。
- `web-reading` 的雜湊比對與備份規則。

## 現況

**現行 review**: review-aadf0a4.md

| 外部狀態 | 查證命令 | 上次結果 | 查證日期 |
|---|---|---|---|
| GitHub issue #26 | `gh issue view 26 --repo raybird/telenexus --json state -q .state` | CLOSED（使用者同意關閉） | 2026-11-13 |
| 併入 main | `git branch --list main --contains fix/issue-0026-web-reading-race` | main（2026-11-13 快轉到 5ca81c6；分支本身不推送） | 2026-11-13 |
| origin 的 main 含本 issue | `git merge-base --is-ancestor 5ca81c6 origin/main && echo yes` | yes | 2026-11-13 |

## 涉及檔案
- `scripts/sync-skills.mjs`：`upgradeBuiltinWebReading()` 只掃描一次；警告前再確認原處；啟動時清掉過期暫存。`retireBuiltinBrowser()` 與一般同步不動。
- `tests/skill-web-reading-upgrade.test.ts`：補定點競爭測試與暫存清理測試。
- `docs/installation.md`：技能同步段落補上暫存清理。

## 驗收條件

1. **AC-1**：另一個服務在本服務掃描期間換上了新版時，本服務不輸出「有自訂內容」或「備份已存在」的警告，安靜結束；最終原處是新版、只有一份備份。
   - 檢查方式：定點測試用 `node --import` 讓 B 掃描原處時暫停，期間由 A 完成升級；斷言 B 的輸出沒有這兩種警告，最終狀態正確。兩種交錯各一個測試：B 讀舊版之前、B 判定是舊版之後。
2. **AC-2**：原處真的有自訂內容，或備份已存在而原處仍是舊版時，照舊警告「新版網頁閱讀指引未套用」並原地保留。
   - 檢查方式：既有的 SCN-008 測試照樣通過。
3. **AC-3**：啟動時，`retired-skills/` 底下名稱是 `.web-reading-new-*`、最後修改超過 1 小時的目錄會被刪除。1 小時內的不刪；名稱不符合這個格式的目錄與檔案都不動。
   - 檢查方式：fixture 放一個 2 小時前的暫存、一個剛建立的暫存、一個名稱相近但不同的目錄（例如 `web-reading-718cc8b`、`.web-reading-new`），同步後只有過期的那個被刪除。
4. **AC-4**：既有行為不變：issue 0024 的 SCN-008 與 S1、S-C 測試、issue 0010 的遷移測試全部通過；並行同步的最終狀態仍是新版、一份備份、沒有暫存殘留。
   - 檢查方式：`npx tsx --test tests/skill-web-reading-upgrade.test.ts tests/skill-browser-migration.test.ts`。

- **核准日期**: 2026-11-13
- **核准來源**: 使用者 2026-11-13 對 3 題回「照建議」：暫存目錄超過 1 小時才清，且只比對 `.web-reading-new-*`（AC-3）；另一個服務已換上新版時安靜結束（AC-1）；在 `fix/issue-0026-web-reading-race` 分支實作，本機獨立審查，不開 PR。issue 目標見 GitHub #26 內文。

## 風險與首要驗證

**風險**: Low — 只影響第一次升級時的警告文字與過期暫存的清理。清理只刪 `retired-skills/` 底下符合固定名稱格式、而且超過 1 小時的目錄，正常的暫存目錄只存在幾毫秒。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | 審查 review-aadf0a4.md 的 S-1：另一個服務換新到一半、原處暫時不存在時安靜結束的那段程式，沒有測試守住；改壞後 19 個測試照樣全過 | 不影響本次交付（2026-11-13）：使用者選 (a) 記為殘餘風險。追蹤：無——reviewer 以掛勾手動驗證 HEAD 的行為正確，缺的只是防止日後改壞的測試；之後修改 `upgradeBuiltinWebReading()` 時一併補上 | AC-1 |

## 實作與驗證步驟
1. ✅ **AC-1、AC-2：只掃描一次，警告前再確認原處** — 驗證方式：先寫兩個定點競爭測試取得紅燈，在現行程式上應該會重現誤報；改完轉綠，既有 SCN-008 測試照樣通過。
   - 完成證據：
     - 定點競爭測試共 3 個，以 `--import` 掛勾在 B 的檔案操作時同步跑完 A：
       - B 讀到舊版之後、判斷之前；
       - B 判定是舊版之後、檢查備份之前；
       - 新版有多個檔案時，B 列完舊版目錄、讀檔之前。這是實作時發現的第三種交錯：只有一個檔案的 fixture 走不到「有自訂內容」那個分支的再確認，所以補上。
     - 紅燈：[evidence/red.log](evidence/red.log) 裡前兩個測試分別重現「有自訂內容」與「備份已存在」；第三個在舊程式上的紅燈見 [evidence/red-multifile.log](evidence/red-multifile.log)，舊程式以 `git show` 暫時放回，跑完以 `cmp` 還原。
     - 綠燈：[evidence/green.log](evidence/green.log)，31/31，含 SCN-008 既有測試（AC-2）。
     - 突變 M1～M3 各有測試擋下，見 [evidence/mutations.log](evidence/mutations.log)。
     - 200 輪並行壓測：修正前誤報 18 次（有自訂內容 14、備份已存在 4），修正後 0 次，兩邊最終狀態全部正確，見 [evidence/stress.log](evidence/stress.log)。
2. ✅ **AC-3：啟動時清掉過期暫存** — 驗證方式：先寫清理測試取得紅燈，再實作；以突變確認「拿掉時間門檻」與「放寬名稱比對」都會被測試擋下。
   - 完成證據：
     - 紅燈見 [evidence/red.log](evidence/red.log)，綠燈見 [evidence/green.log](evidence/green.log)。
     - 另加防護測試：`retired-skills` 是 symlink 時不跟著連結刪東西。這個測試在舊程式上本來就通過。
     - 突變 M4～M8 各有測試擋下：拿掉時間門檻、放寬名稱、不檢查是不是目錄、拿掉 symlink 檢查、不呼叫清理，見 [evidence/mutations.log](evidence/mutations.log)。
3. ✅ **AC-4 與交付檢查** — 驗證方式：`npm run build`、`npm run test`（核對 `# tests` 與測試檔數）、`npm run lint`；更新 `docs/installation.md`。
   - 完成證據：
     - AC-4：[evidence/green.log](evidence/green.log) 含 issue 0024 的 SCN-008、S1、S-C 測試與 issue 0010 的遷移測試，並行同步測試照樣通過。
     - 交付檢查見 [evidence/gates.log](evidence/gates.log)：build、lint exit 0，test 764/764（89 個測試檔）。
     - `docs/installation.md` 的技能同步段落已補上並行升級與暫存清理的說明。

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-11-13 | 不開 PR；在 `fix/issue-0026-web-reading-race` 分支實作，由獨立 subagent 在本機審查，合併由使用者決定 | 對第 3 題回「照建議」 | GitHub 上沒有 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-11-12 | 建立 GitHub issue #26 | 使用者 |
| 2026-11-13 | 3 題回「照建議」；建立 issue 文件，AC-1～4 核准 | 使用者 |
| 2026-11-13 | 使用者同意在本分支試用 dev-rules-kit v4.11.0 候選版：967d247 套用 docs/（文件版本 2.10） | 使用者 |
| 2026-11-13 | 實作 AC-1～4（65ce42a），步驟 1～3 完成 | - |
| 2026-11-13 | 獨立審查 review-aadf0a4.md 判定 PASS，有 1 項 SHOULD FIX；使用者選 (a) 記為殘餘風險（TBD-1），同意快轉併入 main 並推送 | 使用者 |
| 2026-11-13 | 分支快轉併入 main（5ca81c6）並推送 origin main；GitHub #26 仍開著，未發版 | 使用者 |
| 2026-11-13 | 結案：關閉 GitHub #26，依 Gate 豁免不開 PR，以快轉合併為結案依據；使用者決定與 #25 一起發版 | 使用者 |

---
**建立日期**: 2026-11-13
**分級**: Small
**風險**: Low
**狀態**: 已完成（2026-11-13 併入 main 的 5ca81c6）
