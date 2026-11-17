# 審查報告
- 範圍：issue 0029（GitHub raybird/telenexus #29）分支 `fix/issue-0029-probe-override`，`0eba19b..23d451d` 共 1 個提交、7 個檔案（`scripts/probe-models.mjs`、`tests/probe-models-script.test.ts`、`CLAUDE.md`、`README.md`、`docs/agents/landmines.md`、`docs/agents/project.md`、`docs/issues/issue-0029/README.md`）。規模 Small、風險 Low。本機流程，沒有開 PR。
- Reviewed BASE SHA：0eba19bf23c329b1f7dbfc13214c072255fc16ee
- Reviewed HEAD SHA：23d451d47be2790201241a0cc44a6fa51eb2d8f8
- Reviewed patch-id：599f34edb1204a412afa0d5c55452595a8889217
- 獨立 reviewer：Claude（Opus 5.5）獨立 reviewer subagent，不是實作者；全程只讀，工作區最後是乾淨的
- Review artifact：docs/issues/issue-0029/review-23d451d.md

## 問題與風險
### MUST FIX
1. **`docs/issues/issue-0029/README.md` 第 57～58 行：步驟 2 留了一份舊的 ⏳ 版本**。第 54 行已經有 `2. ✅ **AC-4、AC-5：…**` 和它的完成證據，但第 57～58 行舊的 `2. ⏳ **AC-4、AC-5：…** — 完成證據：（執行時回寫）` 沒有刪掉。prettier 也把後面的編號排成 3、4、5，可以佐證。
   - 影響：同一個步驟在 issue 紀錄裡同時是「完成」和「待做」，紀錄不實。結案後，dev-cycle 的 pending-scan 會因為「步驟仍為 ⏳」把它列成「結案後仍有待觀察」。
   - 為什麼現在就要改：`## 實作與驗證步驟` 是凍結章節，PASS 之後再修會讓 PASS 失效、要重審。在這一輪改掉成本最低。
   - 建議：刪掉第 57～58 行。

### SHOULD FIX
1. **`docs/agents/landmines.md` 第 98～107 行：L-14 寫在檔尾的 `---`／`**最後驗證**: 2026-10-18（新增 L-13）` 之後，頁尾也沒更新**。docs/AGENTS.md 第 169、186 行規定常青文件要同時更新正文和最後驗證日期。
   - 建議：把 L-14 移到 L-13 之後、`---` 之前，頁尾改成 `2026-11-17（新增 L-14）`。
2. **`scripts/probe-models.mjs` 第 388～393 行：`--all`／`--models` 的「若有 /set_model 的 override…先 /reset_model」提醒沒有測試**。把條件改成 `if (config?.overrideModel)`，等於 `--all`／`--models` 時不再提醒，結果整個測試檔 33 個仍全過。AC-5 測試只涵蓋不帶參數的模式。
   - 建議：在 `tests/probe-models-script.test.ts` 第 413 行的 AC-4 測試，對 `--models`／`--all` 的文字輸出補一個斷言：要出現 `/set_model mock/a` 和「若有 /set_model 的 override」。

### NICE TO HAVE
1. **README 已核准的 AC 前言說設定檔位置「與 `loadAiConfig()` 讀的位置相同」，這句不精確**。
   - 實際規則不同：`loadAiConfig()` 的 base 預設是相對於 cwd 的 `'ai-config.yaml'`（`src/runner.ts:287`、`src/core/agent.ts:123` 都用這個預設），探針第 134 行則以 `APP_PROJECT_DIR` 為準，和 `/model` 的 `resolveConfigPath()` 一樣。
   - 對照測試讓 cwd 等於 `APP_PROJECT_DIR`，也給 `loaderModel` 明確的 basePath，所以測不到這一點。變異：把 base 改成以 `process.cwd()` 解析，AC-3 的 13 個情境全過。
   - 在支援的情境下兩者等價。正式映像是 WORKDIR /app、`APP_PROJECT_DIR=/app`，`docker compose exec` 預設 cwd 也是 /app。host 上跑 `npm run models:probe` 時 cwd 是 repo 根目錄，`.env.example` 不設 `APP_PROJECT_DIR`，兩邊都會退回 cwd。只有 host 上把 `APP_PROJECT_DIR` 設成和 cwd 不同的目錄才會分歧，而且這時探針的選法反而比較貼近 bot 讀 override 的位置。
   - 建議：在步驟 1 的完成證據或 L-14 的「怎麼查」補一句說明這個限制。AC 原文不要改，那是核准過的規格。
2. **`src/core/config-loader.ts` 沒有反向指標**。`rate-limit.ts` 第 28、42、71 行有「scripts/probe-models.mjs 另有一份副本」的註解，config-loader 沒有。本 issue 依範圍不改 config-loader，而對照測試會在兩邊分歧時失敗，所以影響很小；可以留到 TBD-1 的後續 issue 一起補。
3. **README 步驟 4 寫「`git diff --stat` 確認只改了 6 個檔案」**，實際 diff 是 7 個；6 是不含 issue README 的數字。可以把說法寫明確。

## 已查核維度
- **驗收與證據**（逐條 AC）
  - AC-1：成立。實作在 `resolveConfiguredModel`／`printConfigSource`，測試在 `tests/probe-models-script.test.ts`「issue 0029 AC-1」，斷言 `results[].model`、完整的 `config` 物件與兩行來源文字。在 v2.39.1 臨時容器實跑，來源兩行與 `--json` 的 `config` 都正確。
  - AC-2：成立。三個 AC-2 測試涵蓋沒有 override、override 為 `""`／`123`／陣列、兩檔相同（註明相同，也確認不出現「已被覆寫」）。
  - AC-3：成立，沒有假綠燈。13 個情境裡，「不同」「空白」「非字串」「YAML 壞掉」「空檔」「引號加空白」「缺 base」「巢狀 model」各自會讓不同規則走到不同結果。在 HEAD 上重做變異，結果和實作者記錄的一致：優先順序對調 2 個失敗、不讀 override 3 個、不 trim 2 個、非字串也收 1 個、空字串不當成沒設定 1 個。base 路徑的解析規則不在涵蓋範圍內，見 NICE TO HAVE 1。
  - AC-4：成立。`--models`／`--all` 的 `--json` 都沒有 `config`、文字輸出沒有「模型來源」；假 `opencode models` 會讓非對話模型 `bge-m3` 照舊被略過。測試是另外新增而不是改既有測試，和檢查方式等價。
  - AC-5：成立。不帶參數時的有、沒有 override 都有斷言。`--all`／`--models` 一律附上「若有」提醒，判定符合 AC-4、AC-5，**不需要使用者決策**：AC-4 只限制不讀設定檔、不印來源、沒有 `config`，沒有限制結尾提示；AC-5 第一句適用所有模式；在不讀設定檔的前提下，要做到「有 override 時註明」只能用條件式措辭，這是實作上的解讀，不是語意變更。這個分支沒有測試，見 SHOULD FIX 2。
  - AC-6：成立。stderr 點名兩個檔、提示 `--models 或 --all`、exit 1；舊腳本跑這個測試會失敗。
  - AC-7：成立，reviewer 自己重跑了。v2.39.1（7876ef7c758d）的臨時容器，`--rm --network none`：
    - 自訂 `APP_PROJECT_DIR="/proj dir"`（含空白）：來源兩行正確，只探測 override 那顆，結果「⛔ 模型不存在」、exit 1（斷網造成的，不在判定範圍）。
    - 用映像預設環境（APP_PROJECT_DIR=/app、cwd /app），設定檔掛到 `/app/ai-config.yaml` 與 `/app/data`，加 `--json`：`config` 正確。
    - `js-yaml` 在映像內可以載入，它在 package.json 的 `dependencies` 裡。
  - 紅燈可信：把 `git show 0eba19b:scripts/probe-models.mjs` 暫時覆寫回去，配新測試跑，33 個中 18 個失敗，之後以 `git checkout --` 還原。實作者記的是 32 個中 17 個，之後補了一個情境（舊腳本跑也會失敗），數字一致。AC-4 和「兩個檔都沒有模型」在舊腳本上就通過，和紀錄相符。
- **相關失敗面**
  - YAML 形狀：頂層是陣列、純量、null，多文件，Date 或數字型的 `model`。兩邊用同一個 js-yaml，規則相同（`doc?.model` 加字串檢查）。測試涵蓋空檔、壞 YAML、數字、陣列、巢狀。判定：OK。
  - override 檔權限讀不到（chmod 000）：實測 `loadAiConfig()` 和探針都退回 base（`opencode/big-pickle`），一致。判定：OK。
  - `APP_PROJECT_DIR` 含空白：容器實測正常；這裡的 trim 和 `resolveProjectDir()` 一樣。判定：OK。
  - `--json` 和文字輸出一致：兩者來自同一個 `config` 物件；兩檔都沒有模型時在輸出前就 exit 1。判定：OK。
  - exit code：探測完的非零規則沒有改；讀不到模型時 exit 1。判定：OK。
  - 和 issue 0008、0023 的既有測試相容：同一個檔案裡的舊測試全過；假 opencode 只有在設定 `FAKE_OPENCODE_MODELS` 時才多出 `models` 分支。判定：OK。
- **需求、架構、安全、品質**
  - 範圍：符合 README 的「涉及檔案」，沒有改 config-loader 和 command-router。
  - TBD-1 的揭露正確：`/model` 的 base 以 `APP_PROJECT_DIR` 解析並退回 cwd 相對路徑；`model` 是數字時 `.trim()` 會丟例外，被 catch 成「無法讀取設定檔」。
  - 安全：沒有新的輸入面。L-14 和 README 裡沒有 token、聊天 ID 或正式回覆原文（L-10），只有模型名稱和日期。
  - 常青文件：依 project.md 的表，「npm scripts」對應 `CLAUDE.md` Common Commands、「使用者可見指令」對應 `README.md`，兩個都改了；`configuration-reference.md`、`ARCHITECTURE.md` 沒有提到探針，不需要改；CHANGELOG 留到發版。L-14 的證據連結 `../issues/issue-0029/README.md` 存在。project.md 地雷指引的新增項正確。
  - 重複與過度設計：`readConfigModel` 是 `readYamlSafe` 加 `nonEmptyString` 的刻意複本，是必要的；`source` 的巢狀三元運算子和 `printConfigSource` 的分支都不算過度設計。測試的 `makeProject`／`runInProject`／`loaderModel` 抽象程度恰當。`loaderModel` 會暫時改 `process.env`，但同一個檔案裡的頂層測試是依序執行，沒有競態。
- **執行結果**
  - `npm run build`：exit 0。
  - `npm run test`：exit 0，`# tests 841`、`# pass 841`、`# fail 0`；`tests/` 下有 94 個 `*.test.ts`，數量相稱（L-01）。
  - `npm run lint`：exit 0。注意它只掃 `src/**/*.ts`，不含 `scripts/` 與 `tests/`。
  - `npx prettier --check`：兩個程式檔通過。`CLAUDE.md`、issue README 有警告：表格對齊在 BASE 就有；issue README 的編號重排是 MUST FIX 1 造成的。
  - 只跑 issue 0029 的測試：`npx tsx --test tests/probe-models-script.test.ts` 33 個全過。
- **豁免、待確認與限制**
  - 沒有 Gate 豁免。TBD-1 已決定不納入，揭露正確。
  - Small + Low 沒有核准 commit；AC-1～AC-7 和 README 記的核准原話（2026-11-17，Q1～Q4、「照草案核准」）語意相符，沒有發現未核准的語意修改。
  - 限制：沒有實際連到上游探測（斷網），探測結果正確與否不在本 issue 範圍。GitNexus 的影響分析沿用實作者的紀錄，reviewer 沒有重跑。

## 流程判定
RETURN TO execute-task

（理由：MUST FIX 1 在凍結章節，PASS 之後再修會讓 PASS 失效，所以這一輪就要改。建議 SHOULD FIX 1、2 一起處理，之後送重審。）
