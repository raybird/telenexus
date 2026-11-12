# 步驟 4：技能同步把新版 web-reading 送到現有部署（SCN-008）

- **日期**：2026-11-12
- **被測工作區**：`feat/issue-0024-moli-web-reading`，未提交的 `scripts/sync-skills.mjs`、`scripts/retired-web-reading.json`、`tests/skill-web-reading-upgrade.test.ts`、`tests/fixtures/legacy-web-reading/SKILL.md`
- **impact**：`gitnexus_impact` 對 `matchesRetiredBrowser` 與 `syncBuiltinSkills` 都回報 LOW。前者的直接呼叫者是 `retireBuiltinBrowser`、`anotherWorkerFinished`，後者只在腳本進入點被呼叫。grep 核對結果相同：腳本外只有 `package.json` 的 `dev`、`dev:runner`、`start`、`start:runner`，以及 `tests/skill-browser-migration.test.ts`。

## 變更

- `scanDirectory()`／`matchesManifest()`：從原本的 `matchesRetiredBrowser()` 抽出來的共用雜湊比對，`matchesRetiredBrowser()` 改成呼叫它，agent-browser 的退役行為不變。
- `upgradeBuiltinWebReading()`：workspace 的 `web-reading` 與已出貨舊版（`scripts/retired-web-reading.json`）完全相同時，先改名到 `retired-skills/web-reading-718cc8b`，再複製新版。已經是新版時不動。有客製內容、symlink，或備份已存在時，原地保留並以 `console.warn` 警告。
- 舊版 fixture `tests/fixtures/legacy-web-reading/SKILL.md` 是 `git show 718cc8b:skills/web-reading/SKILL.md` 的輸出，sha256 是 `03821d8d…`，與 manifest 以及維護者正式部署的副本相同（README 概述）。

## 紅燈

實作前執行 `npx tsx --test tests/skill-web-reading-upgrade.test.ts`：exit 1，9 個中 7 個失敗（[step4-red.log](step4-red.log)）。

- 通過的 2 個是「沒有 web-reading」與「已經是新版」，兩者都是既有「只補缺少目錄」的行為，本來就成立。
- 失敗的 7 個，原因都是目標行為缺少：舊版沒有被換新（同步輸出只有 `copied=0, skipped=2`）、客製版本沒有警告（stderr 是空的）。

## 綠燈

`npx tsx --test tests/skill-web-reading-upgrade.test.ts tests/skill-browser-migration.test.ts`：exit 0，21/21 通過（[step4-green.log](step4-green.log)）。issue 0010 的 agent-browser 遷移測試（12 個）照舊通過。

並行測試（每次 5 輪，兩個同步程序同時跑）另外重跑 3 次，3 次都通過（[step4-concurrency-reruns.log](step4-concurrency-reruns.log)）。

## 突變

每次只套用一個突變，跑 `skill-web-reading-upgrade.test.ts`，跑完還原（[step4-mutations.log](step4-mutations.log)）：

| 突變 | 結果 |
|------|------|
| M1 不比對舊版雜湊，存在就換新 | 4 個失敗（三種客製內容、symlink） |
| M2 不備份，直接刪除舊版 | 2 個失敗（換新、並行） |
| M3 拿掉「已經是新版」的判斷 | 1 個失敗（已經是新版） |
| M4 不檢查備份是否已存在 | 1 個失敗（備份已存在） |
| M5 不呼叫升級 | 7 個失敗 |
| M6 改名衝突（ENOENT／ENOTEMPTY／EEXIST）時不忽略 | **0 個失敗** |

## 限制

- M6 沒有測試擋得住。要撞到這條路徑，必須在「判定為舊版」之後、「改名」之前，剛好有另一個同步程序完成改名或備份；5 輪乘 4 次的並行測試都沒有撞到這個時間點。要穩定重現需要在程式裡插入可控的暫停點，為了測試修改產品程式不划算。這條路徑的行為（另一個 worker 已經完成，這邊直接返回）照 agent-browser 退役的既有做法寫，由審查判斷。
- 只測了暫存目錄 fixture；在映像裡對真實 workspace 跑同步，留給步驟 6 的整合測試。
