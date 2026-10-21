# 審查報告

- 範圍：`main..fix/issue-0016-backfill-remote-unsupported`（本機審查，不開 PR；依 README「Gate 豁免紀錄」2026-10-21）。這是 [review-3dc3f44](review-3dc3f44.md)（PASS，SHOULD FIX 1 項）之後的複審，範圍仍是完整的 `BASE..HEAD`。
- Reviewed BASE SHA：`af5d57b89483cc7b4ddb2892c7a5f89558065b7b`（`git rev-parse main`，和上次相同）
- Reviewed HEAD SHA：`0640b958a169fab6d3c04e78e73ca2fdea7bd493`
- Reviewed patch-id：`25bde0795aa3ad9cbcccba3cdfdc0657ff3dd1f8`（reviewer 以 `git diff -a af5d57b 0640b95 | git patch-id --stable` 自行重算，與協調者提供的值相同）
- 獨立 reviewer：獨立 subagent（Claude Opus 5.5），沒有參與實作
- Review artifact：`docs/issues/issue-0016-part2/review-0640b95.md`（未提交）
- 審查日期：2026-10-21
- 3dc3f44 之後新增 3 個 commit：
  - `a47db9a`：只新增 `review-3dc3f44.md`（`--name-status` 為 A，模式 100644）；
  - `62f2ad3`：補強 `tests/memory-backfill-worker.test.ts`，修改 `docs/web-console-reference.md:68`；
  - `0640b95`：step2 證據補註、新增 `evidence/step3-review-followup.md`、README 加一列 Timeline。

  `src/` 和上次審查的 3dc3f44 完全相同（`git diff 3dc3f44 0640b95 -- src` 為空），所以上次對程式的驗收判定仍然成立；這次重跑全部驗證。

## 問題與風險

### MUST FIX

無

### SHOULD FIX

無。上次的 SHOULD FIX 1 已解決，見下方「SHOULD FIX 1 的處理」。

### NICE TO HAVE

1. **`docs/issues/issue-0016-part2/README.md:114`**：新增的 Timeline 列「負責」寫 `reviewer`，但這列的內容包含「已補強測試」，那是實作端做的，不是 reviewer。可以改成 `-`，和前兩列一致，或者拆成兩列：審查一列、補強一列。只影響紀錄的歸屬，不影響驗收。
2. 上次 NICE TO HAVE 的 2、3 項（`CHANGELOG.md:30` 的已發版段落、`src/services/memory-backfill.ts:238` 既有的 NUL 位元組）照建議只在 step2 證據註明，沒有改。這個處理方式合理，本次不再列為問題。

### 需決策

無

## SHOULD FIX 1 的處理

- 測試改法（`tests/memory-backfill-worker.test.ts:355-410`）：
  - `captureStart` 新增選填的 `afterStart`，在 console 仍被攔截時執行。
  - 遠端 AC-2 測試在啟動後再跑 `worker.runOnce('interval')`，斷言 `warns.length === 1`。
  - 補上 `/每輪只會印 skipped/`。
  - 斷言 `startup skipped. remote-unsupported: ` 與 `interval skipped. remote-unsupported: ` 各剛好一行。
- 時序：startup 那一輪在第一個 `await` 之前就同步完成，`finally` 也已把 `inFlight` 設回 `false`，所以手動的 interval 那一輪不會被 `inFlight` 擋掉。
- 突變結果：
  - 上次存活的 M6、M9 現在都轉紅。
  - reviewer 另外補了兩個針對新斷言的突變，M13（每輪的 skipped 改用 `console.warn`）、M14（startup 之後的遠端輪次不印任何訊息），也都轉紅。
  - 舊的 M2、M4 照樣轉紅。

## 驗收對照

| AC | 判定 | 證據 |
|---|---|---|
| AC-1：遠端模式的原因說明是正式的不支援，三個地方同一句，其他行為不變 | 符合 | `src/` 和 3dc3f44 相同，review-3dc3f44 的對照仍然成立：<br>- `memory-health.ts:382-388` 的新句子三點都有，沒有「目前」；<br>- worker 每輪、健康報告的 JSON 與 markdown、`memory:backfill` 的錯誤訊息都是同一句；<br>- 其他狀態的訊息、exit 1、不記 runtime issue、報告形狀都不變。<br>本次重跑 3 個目標測試檔與全套測試，全部通過。 |
| AC-2：遠端模式且回填開啟時啟動 warn 一次，排程照常；本機或沒開時輸出不變 | 符合 | 實作不變（`memory-backfill-worker.ts:169-178`）。<br>補強後的測試：<br>- 遠端開啟時跑 startup、interval 兩輪，warn 只有 1 次、三點內容都比對到、每輪各一行 skipped、`runBackfill` 沒被呼叫；<br>- 本機開啟或沒開時沒有 warn。<br>M2、M4、M6、M7、M9、M13、M14 都會讓測試轉紅。 |
| AC-3：文件寫明正式不支援 | 符合 | `docs/configuration-reference.md:220-227` 與 `.env.example:135` 和上次相同，逐項符合。<br>`docs/web-console-reference.md:68` 現在寫了「遠端模式正式不支援回填，見 `configuration-reference.md`」，沒有暫時的說法。 |

## 驗證重跑

全部在隔離的 worktree `/home/kevin/Documents/RCodes/moltbot-lite-review-0016p2b`（detached 在 `0640b95`，node_modules 用 symlink，用完已移除）執行，`TMPDIR=$HOME/.cache/memoria-release-tmp`，測試加 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB`。

1. `git diff -a main 0640b95 | git patch-id --stable`：`25bde0795aa3ad9cbcccba3cdfdc0657ff3dd1f8`，相符。
2. 3 個目標測試檔：`npx tsx --test tests/memory-health.test.ts tests/memory-backfill.test.ts tests/memory-backfill-worker.test.ts`：`# tests 48`、`# pass 48`、`# fail 0`。
3. `npm test`：exit 0，`# tests 598`、`# pass 598`、`# fail 0`。
4. `npm run build`、`npm run lint` 都 exit 0；`npx prettier --check tests/memory-backfill-worker.test.ts` 通過。
5. 突變：每次只取代一處，跑 3 個目標測試檔，之後以 `git checkout -- src` 還原，每次確認 `git status --short` 為空。

   | 突變 | 結果 |
   |---|---|
   | M6：警告從 `start()` 移到每輪的 remote-unsupported 分支 | 轉紅：第二部分遠端 AC-2 |
   | M9：警告拿掉「worker 每輪只會印 skipped」 | 轉紅：第二部分遠端 AC-2 |
   | M13：每輪的遠端 skipped 改用 `console.warn` | 轉紅：第二部分遠端 AC-2 |
   | M14：startup 之後的遠端輪次直接 `return`，不印訊息 | 轉紅：第一部分 AC-2、第二部分遠端 AC-2 |
   | M2：拿掉警告 | 轉紅：第二部分遠端 AC-2 |
   | M4：警告後 `return`，不建立排程 | 轉紅：第二部分遠端 AC-2 |

6. 時序穩定性：`tests/memory-backfill-worker.test.ts` 以 8 個並行、共 32 次執行，32/32 通過（每次 `# tests 20`）。
7. 新增的 commit：
   - `a47db9a` 只新增上次的報告；
   - `62f2ad3`、`0640b95` 只動測試與文件；
   - `src/` 沒有變更。

## 判定

PASS

沒有 MUST FIX，也沒有 SHOULD FIX。上次的 SHOULD FIX 1 已解決，補強後的測試會被 M6、M9 打紅，reviewer 另外補的 M13、M14 也一樣。只剩一項 NICE TO HAVE（Timeline 的「負責」欄），不阻擋合併。
