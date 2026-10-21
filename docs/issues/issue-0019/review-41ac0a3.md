# 審查報告（改寫歷史後的複審）

- 範圍：完整分支 `main..feat/issue-0019-recall-criteria`。這次是 [review-940ba9c.md](review-940ba9c.md) MUST FIX 1 的複審，依該報告提出的範圍，核對改寫後的歷史。
- Reviewed BASE SHA：`d0da5fb1c1202f78a7dac4c2609ff38b18b04462`
- Reviewed HEAD SHA：`41ac0a3a9477ac31a0ca596dc7e9d2e8a6af273d`
- Reviewed patch-id：`550f15ed31c28c99e090027c5f0d3aa24378bb2d`（reviewer 以 `git diff -a BASE HEAD | git patch-id --stable` 重算，與協調者提供的一致）
- 獨立 reviewer：協調者派出的獨立 subagent（Claude Opus 5.5），沒有參與實作
- Review artifact：`docs/issues/issue-0019/review-41ac0a3.md`
- 審查日期：2026-10-21

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

無。

### NICE TO HAVE

1. **本機的 `backup/issue-0019-940ba9c` 仍含 C17 原句。**
   - 這個 ref 的歷史裡有 C17 原句，以 `git log -S` 確認；`refs/` 底下只有它還含這句。
   - 它是本機分支，沒有推送，現在不影響公開 repo。但只要 `git push --all`，或把它推上遠端，原句就會公開。
   - 建議：在 README 的 D-3 註明「不推送；合併後確認不再需要就刪除」。
   - 兩份前次報告的 `Reviewed HEAD SHA` 指向這條分支上的 `fe4504b`、`940ba9c`。刪除分支之後，這兩個 SHA 只能從 reflog 找回，D-3 已列出新舊 SHA 的對照。
2. **改寫只換了 C17，沒有換前次 NICE 提到的片段。**
   - 改寫後的 `ad6a06a`、`09a5060`、`92b411d` 的測試檔，仍有前次 NICE 2 提到的兩個片段（取自 R01、B12 的用詞），到 `6c22b23` 才換掉。
   - 前次已判定這兩個片段不算洩漏（不是完整問句，也沒有私人資料），所以不要求再改寫歷史，這裡只是記錄。

## 已查核維度

### (1) 改寫後的 HEAD 和 `backup/issue-0019-940ba9c` 的差異

`git diff backup/issue-0019-940ba9c 41ac0a3` 有 5 個檔案：
- `review-fe4504b.md`：只有兩處文字修改：
  - 第 16 行的原句改成「這一行的測試字串」，另外加一行改寫的說明；
  - 第 74–75 行的兩個片段改成題號。
  - 判定與其他內容不變。
- `review-940ba9c.md`：`c50f09d` 新增，是 reviewer 寫入的檔案。提交後工作區乾淨，內容和 reviewer 寫的相同。
- `README.md`：D-3、Timeline 與文件清單。
- `evidence/step5-review-followup.md`：更正「評估集掃描」，內容和 reviewer 的重掃結果一致。
- `evidence/scripts/function-words.mjs`：只在檔頭加一行註解，說明測試依賴這個檔案，清單沒有改。

程式碼與測試的內容和 `940ba9c` 完全相同。

**逐一比對新舊提交**：

| 舊 → 新 | 樹的差異 | 提交訊息與作者時間 |
|---|---|---|
| `a75367c`、`1019b8e` | 沒有改變 | 相同 |
| `b9a2ff9` → `ad6a06a` | 只有測試檔的 2 行：C17 的註解與 assert 換成最終版的句子 | 相同 |
| `fe4504b` → `09a5060` | 只有同樣的 2 行 | 相同 |
| `eb0415f` → `92b411d` | 同樣的 2 行，加上 `review-fe4504b.md` 的文字修改 | 相同 |
| `2023b4b` → `6c22b23` | 只有 `review-fe4504b.md` 的文字修改 | 相同 |
| `b7cde44` → `c090a9c` | 只有 `review-fe4504b.md` 的文字修改 | 相同 |
| `940ba9c` → `515d8f8` | 只有 `review-fe4504b.md` 的文字修改 | 相同 |

另外確認：`refs/original` 已清掉，分支沒有推送到遠端。

### (2) 歷史裡沒有評估題原文

- **`git log -S`**：以兩份凍結檔的 134 題原句，逐題在 `d0da5fb..41ac0a3` 執行。
  - C17 沒有命中。
  - 唯一命中的是 C01：`ad6a06a` 加入測試檔，`6c22b23` 拿掉。
- **每個提交的完整樹與提交訊息**：檢查 BASE..HEAD 每個提交的整份樹，範圍是相對 BASE 有變更的檔案。問句正規化後至少 5 字才比對。
  - 樹：只有 C01、C04 的完整句子，`1019b8e` 以前只有 C04。
  - 提交訊息：沒有命中。
- **C01、C04 在 HEAD 的位置**：只在 `docs/issues/issue-0012/evidence/step6-confidence-sampling.md`、`docs/issues/issue-0015/evidence/investigation-migration-simulation.md`，以及 `review-fe4504b.md:22`。
  - 前次報告這一行說明的正是「這兩句在 BASE 已公開」。
  - 兩句在 BASE 的 issue 0012、0015 證據與 GitHub #19 都已公開，是 #15 的對照題，不違反 AC-1。
- **其他 ref**：只有 `backup/issue-0019-940ba9c` 的歷史含 C17（NICE 1）。

### (3) 改寫後的實作提交可以單獨通過測試

在隔離的 worktree（`~/.cache/tn19-review-wt3`）逐一 checkout，跑兩個目標測試檔：
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB`、`TMPDIR=$HOME/.cache/memoria-release-tmp`；
- `npx tsx --test tests/memoria-recall-criteria.test.ts tests/memoria-recall-threshold.test.ts`。

| 提交 | 結果 |
|---|---|
| `ad6a06a` | `# tests 24`、`# fail 0` |
| `6c22b23` | `# tests 27`、`# fail 0` |
| `41ac0a3` | `# tests 27`、`# fail 0` |

在 `41ac0a3` 另外跑了：
- `npm test`：`# tests 594`、`# pass 594`、`# fail 0`；
- `npm run build` exit 0、`npm run lint` exit 0。

審查後已移除 worktree。

### 驗收與其他維度

- 驗收：
  - AC-1～AC-4、前次各項發現、D-1、D-2 的查核結論，沿用 [review-940ba9c.md](review-940ba9c.md)。
  - 這次的改寫沒有改變任何程式碼、量測腳本的清單或驗收數字：`git diff 940ba9c 41ac0a3` 的程式與測試是空的。
  - review-940ba9c 的 MUST FIX 1 已解決：C17 原句不在 HEAD，也不在 `main..HEAD` 的任何提交裡。
- 需決策：review-940ba9c 的 `需決策`（怎麼把原句從歷史拿掉）由使用者選 (b)，記為 README 的 D-3。
- 安全與隱私：
  - 這次新增的內容只有文件；
  - 沒有使用者 ID、session id，也沒有評估題原文；
  - 這份報告也沒有寫出任何題目內容。
- 架構與品質：沒有變更。

## 流程判定

**PASS**

- 條件：獨立審查已完成、報告已保存在本檔、沒有 MUST FIX，必要的驗收與失敗面都有證據。
- 適用範圍：PASS 只適用於 `41ac0a3`。之後若新增一個只加入本報告的提交，用下面的指令確認版本有效：

```bash
python3 ~/.claude/skills/review/scripts/verify-artifact.py --repo . --reviewed 41ac0a3a9477ac31a0ca596dc7e9d2e8a6af273d --head <新 HEAD> --artifact docs/issues/issue-0019/review-41ac0a3.md
```
