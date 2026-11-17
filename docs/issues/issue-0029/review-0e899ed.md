# 審查報告
- 範圍：issue 0029（GitHub raybird/telenexus #29）分支 `fix/issue-0029-probe-override`，完整範圍是 `0eba19b..0e899ed`，共 3 個提交：
  - `23d451d`：實作，上一輪（[review-23d451d.md](review-23d451d.md)）已審。
  - `93fb76e`：保存 review-23d451d.md，並在 README 記帳。
  - `0e899ed`：依審查修正。
  這一輪重點看增量 `93fb76e..0e899ed`，改了 3 個檔：`docs/agents/landmines.md`、`docs/issues/issue-0029/README.md`、`tests/probe-models-script.test.ts`。`23d451d..0e899ed` 沒有動 `scripts/` 與 `src/`，diff 是 0 行。規模 Small、風險 Low，本機流程，沒有開 PR。
- Reviewed BASE SHA：0eba19bf23c329b1f7dbfc13214c072255fc16ee
- Reviewed HEAD SHA：0e899edca0574280aee5615c177da7fa1f3c487f
- Reviewed patch-id：1c3efea3d90f65295e7a315ffdf35fec60c2bed1
- 獨立 reviewer：Claude（Opus 5.5）獨立 reviewer subagent，不是實作者，與上一輪是同一個 reviewer。全程只讀，變異改動都以 `git checkout --` 還原，最後 `git status` 是乾淨的。
- Review artifact：docs/issues/issue-0029/review-0e899ed.md

## 問題與風險
### MUST FIX
無。

### SHOULD FIX
無。

### NICE TO HAVE
1. 上一輪 NICE TO HAVE 2：`src/core/config-loader.ts` 沒有指回探針複本的註解。依範圍不改 config-loader 這個處理合理。對照測試在兩邊分歧時會失敗，所以影響很小，可以留到 TBD-1 的後續 issue 一起補。
2. README 步驟 4 新加的「審查修正後重跑」那一點，放在原本的「完成證據」之前，讀起來時間順序顛倒。只是可讀性問題，不影響判定。

## 已查核維度
- **上一輪的修正**
  - MUST FIX 1：成立。README 步驟 2 的舊 ⏳ 版本已刪，步驟編號依序是 1、2、3、4（第 52、59、62、64 行），全部 ✅。增量 diff 對 `## 驗收條件`、核准來源與其他凍結章節沒有任何 `-`／`+` 行，AC-1～AC-7 原文沒變。
  - 93fb76e 的記帳：新增的 `## 現況` 在 `## 概述` 之後（第 13 行），只有一行 `**現行 review**: review-23d451d.md`；另外是 Timeline 一列和 `**狀態**` 值。review-23d451d.md 的內容和上一輪的報告相符。
  - SHOULD FIX 1：成立。L-14 現在在 L-13 之後、`---`／頁尾之前，頁尾改成 `**最後驗證**: 2026-11-17（新增 L-14）`，L-14 的內容沒變。
  - SHOULD FIX 2：成立。AC-4 測試對 `--models`、`--all` 的文字輸出補了 `/set_model <模型>` 和「若有 /set_model 的 override」兩個斷言。重做了兩個變異：
    - 條件改成 `if (config?.overrideModel)`：AC-4 測試失敗（33 個中 1 個失敗）。
    - 措辭固定成「目前有」：同樣 1 個失敗。
    兩次都已還原。
  - NICE TO HAVE 1：措辭正確。步驟 1 新增「限制」一點：`loadAiConfig()` 的 base 預設相對於目前目錄（`src/core/agent.ts`、`src/runner.ts`），探針以 `APP_PROJECT_DIR` 為準，對照測試分不出兩者。正式映像和 host 預設情況下結果相同，只有 host 上把 `APP_PROJECT_DIR` 設成另一個目錄時才會分歧。這和實際查證的一致，也沒有改 AC 原文。
  - NICE TO HAVE 3：措辭正確，改成「只改了 6 個檔案（另加本 README 共 7 個）」，和 `23d451d` 的 diff stat 相符。
- **驗收與證據**：上一輪逐條 AC 的結論仍成立，因為 `scripts/probe-models.mjs` 沒有改。
  - AC-1、AC-2、AC-5、AC-6：見測試檔裡對應名稱的測試。
  - AC-3：13 個對照情境，上一輪的變異結果（2／3／2／1／1 個失敗）有效。
  - AC-4：現在加上了結尾提示的斷言。
  - AC-7：上一輪已用 v2.39.1 臨時容器（`--rm --network none`）重跑，包含 `APP_PROJECT_DIR` 含空白與映像預設環境兩種，腳本沒變所以仍有效。
  - 紅燈：舊腳本配新測試是 33 個中 18 個失敗，和實作者的紀錄一致。
  - `--models`／`--all` 一律附上「若有」提醒：判定符合 AC-4、AC-5，不需要決策。
- **相關失敗面**：腳本沒變，上一輪結論都有效：
  - YAML 的各種形狀：兩邊同一個 js-yaml，規則相同。
  - override 讀不到（chmod 000）：兩邊都退回 `ai-config.yaml`。
  - `APP_PROJECT_DIR` 含空白：在容器裡實測正常。
  - `--json` 和文字輸出：來自同一個 `config` 物件。
  - exit code：沒有改。
  - issue 0008、0023 的既有測試：照樣通過。
- **需求、架構、安全、品質**
  - 增量只動測試斷言和文件，沒有新的程式路徑。
  - L-14 和 README 沒有 token、聊天 ID 或正式回覆原文（L-10）。
  - 常青文件該改的都改了，沒有漏掉的。
  - 新增的斷言沒有重複，也不算過度設計。
- **執行結果**（在 0e899ed 上跑）
  - `npm run build`：exit 0。
  - `npm run lint`：exit 0，它只掃 `src/**/*.ts`。
  - `npm run test`：exit 0，`# tests 841`、`# pass 841`、`# fail 0`。`tests/` 下有 94 個 `*.test.ts`，數量相稱（L-01）。測試數和上一輪相同，因為新的是斷言，不是新測試。
  - `npx prettier --check tests/probe-models-script.test.ts docs/agents/landmines.md`：通過。
  - patch-id 以 `git diff 0eba19b 0e899ed | git patch-id --stable` 重算。
- **豁免、待確認與限制**
  - 沒有 Gate 豁免。TBD-1 已決定不納入，揭露正確。
  - Small + Low 沒有核准 commit，AC 原文和核准原話仍相符。
  - 沒有連到真實上游探測，因為一直是斷網；這不在本 issue 的範圍內。
  - GitNexus 的影響分析沿用實作者的紀錄，reviewer 沒有重跑。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
