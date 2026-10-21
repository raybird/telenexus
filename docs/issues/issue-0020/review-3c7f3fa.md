# 審查報告
- 範圍：完整交付範圍 6b6eb1d..3c7f3fa；這一輪新增的是 `849715e..3c7f3fa`，只改文件
  - `3d0e21f`：只新增前次的報告 review-849715e.md。
  - `3c7f3fa`：更正 step4 證據與 README。
  - `6b6eb1d..849715e` 已在 [review-849715e.md](review-849715e.md) 審查並 PASS，這次沿用其結論。
- Reviewed BASE SHA：849715e748e1e1828400feeb39d5b5697f486ee1（後續範圍）；完整交付範圍的 BASE 是 6b6eb1d3af9e2553fd815a5ce543c029e37a00b4（main）
- Reviewed HEAD SHA：3c7f3fa0c4bdafdd2b057168d5bb7f9324096bb9
- Reviewed patch-id：
  - 完整範圍 `6b6eb1d..3c7f3fa`：84a30e2ba1baee72fc7fe36f72dddba5d7fac351
  - 後續範圍 `849715e..3c7f3fa`：9b2b83906ca9a82d3ae2877d2ecf616d93377522
  - 兩個都由 reviewer 以 `git diff -a <base> <head> | git patch-id --stable` 計算。協調者這次沒有提供值，無從對照。
- 審查日期：2026-10-21
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，不是本 issue 的實作者；與 review-ed4c001、review-849715e 是同一位 reviewer
- Review artifact：docs/issues/issue-0020/review-3c7f3fa.md

## 問題與風險

- MUST FIX：無
- SHOULD FIX：無
- NICE TO HAVE：無

## 已查核維度

### 範圍：只改文件

| 核實項目 | 結果 |
|---|---|
| `git diff --name-status 849715e 3d0e21f` | 只有 `A docs/issues/issue-0020/review-849715e.md`，以一般檔案模式（100644）新增 |
| 3d0e21f 的報告與 reviewer 寫出的檔案比對 | 沒有差異，提交的就是前次的原文 |
| `git diff --name-status 3d0e21f 3c7f3fa` | 只有 `M docs/issues/issue-0020/README.md` 與 `M docs/issues/issue-0020/evidence/step4-review-followup.md` |
| `git diff --stat 849715e 3c7f3fa -- src tests` | 空的：沒有改程式與測試 |
| 每個提交的 parent | 一條直線：`849715e` → `3d0e21f` → `3c7f3fa` |

程式與測試都和 849715e 相同，前次的 `# tests 577 / # pass 577` 仍然適用。依協調者的指示，這次沒有重跑全套測試。

### 前次 SHOULD FIX 的處理

| 項目 | 處理 | reviewer 核實 | 判定 |
|---|---|---|---|
| M11 的轉紅範圍寫多了 | 突變表的 M11 只留降版測試（`step4-review-followup.md:46`） | 前次我重做 M11，結果是 `# fail 1`，只有降版測試轉紅，與更正後的表格一致 | 已解決 |
| README 寫「2 個以突變證明」，但只記錄了 1 個 | 補上 M13（`:48`）；README 第 121 行標明是 M11、M13 | 我在 3c7f3fa 的 worktree 重做 M13：把 `readAppVersion()` 的回傳改成 `` `v${parsed.version.trim()}` ``，結果是 `# tests 19 / # fail 1`，只有「readAppVersion 讀 package.json 的 version」轉紅，與紀錄相符。還原後是 `# fail 0` | 已解決 |

### 更正的敘述是否準確（`step4-review-followup.md:52`）

- **「scope 測試讀資料時依 id 排序，不經過彙總查詢」**：正確。`readRows()` 用的是 `SELECT * FROM memoria_recall_events ORDER BY id`。
- **「那次會失敗，是因為 scope 測試本身還有預設值錯誤」**：我在 HEAD 的程式上重現了。
  - 做法：不做任何突變，只把 scope 測試裡直接呼叫 client 的那段，換回錯誤的寫法 `recallOnce(..., undefined)`。
  - 結果：`# fail 1`，scope 測試失敗，實際值是 `['other', 'user']`，期望值是 `['other', 'none']`。
  - 原因：`undefined` 讓 `recallOnce()` 用了預設值 `user:u1`。這個失敗和 M11 無關，有沒有做 M11 都會出現。
  - 所以「誤記到 M11 名下」的解釋成立。
- **「M13 原本沒有記錄，是補跑後才寫進來的」**：誠實揭露了時序，沒有把補跑寫成當時就有。
- **更正的方式**：保留了原始紀錄的錯誤說明，附上日期與來源（複審報告），沒有直接改寫歷史紀錄。

### NICE 不處理的理由

- **trace hook 的 warn 沒有測試**：理由是這行 warn 不改變行為，只是讓被吞掉的例外留下紀錄。成立。它不屬於任何 AC 的檢查方式；這個 catch 不影響聊天，已有程式結構保證。
- **以 `:` 開頭的 scope 記成空字串**：理由是不會洩漏 ID，現在唯一的呼叫點一定傳 `user:<id>`（`src/prompt/builder.ts`）。成立。AC-1 的隱私要求不受影響。

### 需求、架構、安全、品質

- 沒有改程式，所以需求、架構與安全的結論沿用 review-849715e。
- README 的 Timeline 新增一行複審紀錄，與實際經過相符。
- **去識別化**：在 `3d0e21f..3c7f3fa` 的 diff 裡搜尋 `/home/`、OS 帳號名、`/tmp/claude`，都沒有命中。在 `849715e..3c7f3fa` 搜尋時，命中的只有前次報告裡的 patch-id 十六進位字串，以及搜尋命令本身的說明文字，都不是本機資訊。

### 豁免、待確認與限制

- **Gate 豁免**：沿用 README 2026-10-21 的「不開 PR、改由本機獨立審查」。
- **待確認事項**：D-1 已解決，沒有新的項目。
- **環境**：
  - 測試用 `TMPDIR=$HOME/.cache/memoria-release-tmp`。
  - worktree 開在 `$HOME/.cache` 下的暫存目錄，用完已經 `git worktree remove` 與 `prune`，並刪掉暫存目錄。
  - 沒有使用 `git stash`；沒有碰正式部署；沒有網路寫入。

## 你自己跑過的命令與結果

以下測試都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行，`TMPDIR=$HOME/.cache/memoria-release-tmp`。

| 命令 | 結果 |
|---|---|
| `git diff -a 6b6eb1d 3c7f3fa \| git patch-id --stable` | `84a30e2ba1baee72fc7fe36f72dddba5d7fac351` |
| `git diff -a 849715e 3c7f3fa \| git patch-id --stable` | `9b2b83906ca9a82d3ae2877d2ecf616d93377522` |
| `git diff --name-status 849715e 3d0e21f`、`git diff --name-status 3d0e21f 3c7f3fa` | 只有報告新增與兩個文件修改（見上） |
| `git diff --stat 849715e 3c7f3fa -- src tests` | 空的 |
| worktree 檢出 `3c7f3fa`：`npx tsx --test tests/recall-metrics.test.ts` | `# tests 19 / # fail 0` |
| 突變 M13：`readAppVersion()` 在版本前加 `v` | `# fail 1`：readAppVersion 的測試轉紅 |
| 重現錯誤的 scope 測試：改回 `recallOnce(..., undefined)`，不做突變 | `# fail 1`：scope 測試失敗，實際值是 `['other','user']` |
| 每次改動後 `git checkout -- src tests` | worktree 回到乾淨狀態 |
| `git worktree remove --force`、`git worktree prune`、刪除暫存目錄 | 只剩主 checkout |

## 流程判定

**PASS**

- 前次唯一的 SHOULD FIX 已經處理：M11 的紀錄更正了，M13 經我重跑確認屬實。
- 更正說明所寫的失敗原因，經實測重現成立。
- 兩項 NICE 不處理的理由成立。
- 這一輪只改文件，沒有動到程式與測試。
- 沒有 MUST FIX，也沒有其他待處理的發現。
