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

## 實作與驗證步驟
1. ⏳ **AC-1、AC-2：只掃描一次，警告前再確認原處** — 驗證方式：先寫兩個定點競爭測試取得紅燈，在現行程式上應該會重現誤報；改完轉綠，既有 SCN-008 測試照樣通過。
   - 完成證據：待執行時回寫。
2. ⏳ **AC-3：啟動時清掉過期暫存** — 驗證方式：先寫清理測試取得紅燈，再實作；以突變確認「拿掉時間門檻」與「放寬名稱比對」都會被測試擋下。
   - 完成證據：待執行時回寫。
3. ⏳ **AC-4 與交付檢查** — 驗證方式：`npm run build`、`npm run test`（核對 `# tests` 與測試檔數）、`npm run lint`；更新 `docs/installation.md`。
   - 完成證據：待執行時回寫。

## Gate 豁免紀錄

| 日期 | 豁免項目 | 使用者原話 | 殘餘風險 |
|------|----------|-----------|----------|
| 2026-11-13 | 不開 PR；在 `fix/issue-0026-web-reading-race` 分支實作，由獨立 subagent 在本機審查，合併由使用者決定 | 對第 3 題回「照建議」 | GitHub 上沒有 PR 紀錄；審查報告保存在本 issue 目錄 |

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-11-12 | 建立 GitHub issue #26 | 使用者 |
| 2026-11-13 | 3 題回「照建議」；建立 issue 文件，AC-1～4 核准 | 使用者 |

---
**建立日期**: 2026-11-13
**分級**: Small
**風險**: Low
**狀態**: 待實作
