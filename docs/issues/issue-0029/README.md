# Issue 0029 - models:probe 預設測合併 override 之後實際生效的模型 (Small)

## 概述

`npm run models:probe`（`scripts/probe-models.mjs`）不帶參數時說是「測目前設定的那一顆」，實際上只用單行 regex 讀 `ai-config.yaml` 的 `model:`。實際生效的模型由 `src/core/config-loader.ts` 的 `loadAiConfig()` 決定，它還會合併 `data/ai-config.override.yaml`，也就是 Telegram 的 `/set_model` 寫入的檔案。

2026-11-13 正式部署踩到這個落差（GitHub #29）：`ai-config.yaml` 是 `opencode/big-pickle`，override 是 `nvidia/z-ai/glm-5.3-flash`。後者當天 20:00 起上游回 HTTP 404，聊天與排程都失敗；不帶參數的探針卻去測 `opencode/big-pickle`，回報「✅ 可用」。

根因：探針要在沒有原始碼、沒有建置的正式映像裡執行，不能 import TypeScript 的 config-loader，所以自己重寫了「讀目前模型」的邏輯，漏掉 override。`tests/probe-models-script.test.ts` 只比對兩邊限流 regex 的原始字串，沒有比對設定解析，所以兩邊分歧了也沒有測試發現。

目標：不帶參數時測合併 override 之後的模型，並標明模型來自哪個檔；再用對照測試讓探針與 config-loader 的解析規則不能各自分歧。

## 現況

**現行 review**: review-23d451d.md

## 涉及檔案

- `scripts/probe-models.mjs` - 以 `js-yaml` 照 `loadAiConfig()` 的規則合併 override；輸出模型來源、`--json` 的 `config` 欄位、結尾提示與錯誤訊息
- `tests/probe-models-script.test.ts` - 對照測試與輸出測試（沿用既有的假 `opencode` 黑盒做法）
- `CLAUDE.md`（Common Commands）、`README.md`（探測指令說明）- 「目前設定的模型」改成「合併 override 之後實際生效的模型」

不改 `src/core/config-loader.ts` 與 `src/core/command-router.ts`（`/model` 見 TBD-1）。

## 驗收條件

以下的「設定檔」指 `$APP_PROJECT_DIR/ai-config.yaml`（未設 `APP_PROJECT_DIR` 時為目前目錄）與 `$APP_PROJECT_DIR/data/ai-config.override.yaml`，與 `loadAiConfig()` 讀的位置相同。

1. **AC-1**：不帶 `--all`／`--models` 執行，override 的模型與 `ai-config.yaml` 的不同時，只探測 override 的模型。探測前印出模型來源：override 的模型標為 `data/ai-config.override.yaml（/set_model）`；`ai-config.yaml` 的模型標為已被覆寫、不測，並提示要測它可以用 `--models <模型>`。`--json` 輸出多一個 `config` 欄位：`{ model, source, baseModel, overrideModel }`，`source` 標明 `model` 來自哪個檔。— 檢查方式：`tests/probe-models-script.test.ts` 以暫存專案目錄（`APP_PROJECT_DIR`）與假 `opencode` 執行腳本，斷言探測的模型（`results[].model`）、`config` 欄位與文字輸出的來源行。
2. **AC-2**：沒有 override 檔，或 override 的 `model` 空白、不是字串時，探測 `ai-config.yaml` 的模型，來源標為 `ai-config.yaml`。override 與 `ai-config.yaml` 的模型相同時，來源標為 override，並註明兩個檔相同。— 檢查方式：同 AC-1，各情境一個測試。
3. **AC-3**：同一組設定情境下，探針選出的模型與 `loadAiConfig()` 逐一相同。情境涵蓋：沒有 override、相同、不同、override 空白、override 的 `model` 不是字串、override 的 YAML 壞掉、值加了引號、缺 `ai-config.yaml`。故意改掉探針的任一條合併規則時，這組測試會失敗。— 檢查方式：`tests/probe-models-script.test.ts` 的對照測試；變異檢查（改探針的一條規則 → 紅燈 → 還原）記入完成證據。
4. **AC-4**：`--models`、`--all` 的行為不變：不讀設定檔，不印模型來源，也沒有 `config` 欄位。— 檢查方式：既有的 `--models` 測試加斷言，加上 `--all` 一例。
5. **AC-5**：結尾「可用」清單的提示改成用 `/set_model <模型>` 切換。有 override 時另外註明：直接改 `ai-config.yaml` 要先 `/reset_model` 清掉 override 才會生效。— 檢查方式：測試斷言有、沒有 override 兩種情況的文字輸出。
6. **AC-6**：兩個設定檔都讀不到模型時，錯誤訊息點名兩個檔，並提示改用 `--models` 或 `--all`，exit 1。— 檢查方式：測試斷言 stderr 與 exit code。
7. **AC-7**：新腳本能在正式映像裡執行。在 `ghcr.io/raybird/telenexus:v2.39.1` 的臨時容器（`--rm --network none`，不碰正在跑的服務）掛上新腳本與暫存設定檔，不帶參數執行，印出的模型來源正確；斷網造成的探測失敗不影響這項判定。— 檢查方式：`docker run` 命令與輸出記入完成證據。

- **核准日期**: 2026-11-17
- **核准來源**: 使用者 2026-11-17 在本對話以 AskUserQuestion 回答 Q1「js-yaml 加對照測試」、Q2「只測生效的那顆」、Q3「一起改」、Q4「不納入，記在待確認」（都是建議答案），並對 AC-1～AC-7 的草案（含 `config` 欄位、AC-6 錯誤訊息、AC-7 正式映像驗證，以及交付方式：分支、本機獨立審查、PASS 後由使用者決定是否快轉合併）回答「照草案核准」。

## 風險與首要驗證

**風險**: Low — 只改開發／維運用的探測腳本，不碰聊天、排程與健康檢查（`model-health-check.ts` 已經透過 `loadAiConfig()` 取得模型）。最需要防的是兩件事：對照測試假綠燈（情境沒有真的走到不同規則），以及正式映像裡載不到 `js-yaml`。前者以 AC-3 的變異檢查確認；後者在規劃時已用 v2.39.1 的臨時容器確認，從 `/app/scripts` 可以 `import 'js-yaml'`（它是 runtime 依賴，`npm ci --omit=dev` 會安裝），交付前再以 AC-7 實跑新腳本。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | Telegram 的 `/model`（`src/core/command-router.ts`）有第三份「讀目前模型」的實作：`ai-config.yaml` 以 `APP_PROJECT_DIR` 解析，`loadAiConfig()` 預設以目前目錄解析；`model` 不是字串時 `/model` 會丟例外，`loadAiConfig()` 則忽略它 | 已決定不納入（2026-11-17，Q4）；之後另開 issue | 不影響 AC-1～AC-7 |

## 實作與驗證步驟

1. ✅ **AC-3、AC-1、AC-2、AC-6：探針照 config-loader 的規則解析設定** — 驗證方式：先寫對照測試與來源輸出測試，在現有腳本上取得紅燈，再改腳本至綠燈；完成後做 AC-3 的變異檢查。
   - 做法：`scripts/probe-models.mjs` 以 `js-yaml` 讀兩個設定檔的頂層 `model`（讀不到、YAML 壞掉、不是字串或空白都當成沒有設定），override 有模型就用它；`--json` 帶 `config: { model, source, baseModel, overrideModel }`，`source` 是 `data/ai-config.override.yaml` 或 `ai-config.yaml`。
   - 對照測試：`tests/probe-models-script.test.ts` 的「issue 0029 AC-3」13 個情境，每個都在暫存專案目錄（cwd 與 `APP_PROJECT_DIR` 相同，同正式映像）裡執行腳本，與同一份設定的 `loadAiConfig()` 比對。實際探測的模型（`results[].model`）先比，`config.model` 後比。
   - 紅燈（2026-11-17，修改前的腳本）：`npx tsx --test tests/probe-models-script.test.ts` 32 個中 17 個失敗。AC-3 有 4 個情境實際探測了錯的模型：override 不同時測了 `opencode/big-pickle`（就是 #29 的事故）；值加引號時單行 regex 讀到 `'` 與 `"opencode/big-pickle"`；缺 `ai-config.yaml` 時直接以 1 結束、沒有讀 override。其餘情境的模型相同，只缺 `config` 欄位。AC-1、AC-2、AC-5、AC-6 的測試全部失敗；AC-4 與「兩個檔都沒有模型」在修改前就通過（回歸保護）。
   - 綠燈：同一命令 33 個全過（之後補了「`ai-config.yaml` 的值前後有空白」一個情境，見下方變異）。
   - 變異（每次只改腳本一處，跑 AC-3 後以備份還原，`cmp` 確認還原）：優先順序對調 → 2 個情境失敗；不讀 override → 3 個；不 trim → 起初只有「override 的 model 空白」1 個，補上「`ai-config.yaml` 的值前後有空白」情境後 2 個；非字串也收 → 1 個；空字串不當成沒設定 → 1 個；退回單行 regex → 5 個；override 路徑改錯 → 3 個。
2. ✅ **AC-4、AC-5：`--models`／`--all` 不受影響，結尾提示改成 `/set_model`** — 驗證方式：同一個測試檔的斷言。
   - 完成證據：「issue 0029 AC-4」以 `--models` 與 `--all`（假 `opencode models` 回兩顆，其中一顆是非對話模型、照舊被略過）執行，`--json` 沒有 `config` 欄位、文字輸出沒有「模型來源」；「issue 0029 AC-5」斷言沒有 override 時只出現 `/set_model <模型>`、沒有 `/reset_model`，有 override 時另有「直接改 ai-config.yaml … 要先 /reset_model」。
   - 實作細節：`--all`／`--models` 依 AC-4 不讀設定檔、不知道有沒有 override，所以結尾一律附上同一句提醒，措辭改成「若有 /set_model 的 override」；不帶參數時只在確實有 override 時才附（「目前有」）。
2. ⏳ **AC-4、AC-5：`--models`／`--all` 不受影響，結尾提示改成 `/set_model`** — 驗證方式：同一個測試檔的斷言。
   - 完成證據：（執行時回寫）
3. ✅ **AC-7：正式映像實跑** — 驗證方式：AC-7 的 `docker run`。
   - 完成證據（2026-11-17）：暫存專案目錄放 `ai-config.yaml`（`opencode/big-pickle`）與 override（`nvidia/z-ai/glm-5.3-flash`），執行 `docker run --rm --network none --entrypoint node -e APP_PROJECT_DIR=/proj -w /app -v "$PWD/scripts/probe-models.mjs:/app/scripts/probe-models.mjs:ro" -v "<暫存目錄>:/proj:ro" ghcr.io/raybird/telenexus:v2.39.1 scripts/probe-models.mjs --timeout 10 --rounds 1`。輸出第一行「模型來源：data/ai-config.override.yaml（/set_model）＝nvidia/z-ai/glm-5.3-flash」，第二行「ai-config.yaml＝opencode/big-pickle（已被覆寫，不測；要測請用 --models opencode/big-pickle）」，只探測 override 那顆；加 `--json` 時 `config` 為 `{"model":"nvidia/z-ai/glm-5.3-flash","source":"data/ai-config.override.yaml","baseModel":"opencode/big-pickle","overrideModel":"nvidia/z-ai/glm-5.3-flash"}`。探測結果是「⛔ 模型不存在」，因為容器斷網、沒有 provider 設定，不在本項判定範圍。映像裡的 `js-yaml` 從 `/app/scripts` 載入成功。
4. ✅ **交付檢查與文件** — `npm run build`、`npm run test`（核對 `# tests`，地雷 L-01）、`npm run lint` 都 exit 0；更新 `CLAUDE.md` 的 Common Commands、`README.md` 的探測指令說明與腳本開頭的用法註解。
   - 完成證據（2026-11-17）：`npm run build` exit 0；`npm run test` exit 0，`# tests 841`、`# pass 841`、`# fail 0`（比 main 的 821 多 20 個，都是本 issue 新增），`tests/` 下 94 個測試檔；`npm run lint` exit 0；兩個變更檔通過 `prettier --check`。
   - 文件：`CLAUDE.md` Common Commands 與 `README.md` 的探測說明改成「實際生效的模型」；腳本開頭的用法與 `--help` 同步。另依 project.md 的地雷規則新增 [L-14](../../agents/landmines.md)（探針裡的 TypeScript 邏輯複本悄悄分歧，證據是 #29），並在 project.md 的地雷指引登記觸發情境。
   - 影響分析：GitNexus `impact` 對 `readConfiguredModel`、`renderTable` 都是 LOW，唯一呼叫者是腳本的 `main`，與 grep 一致；`detect_changes` 另列出 issue-0008、issue-0010 的章節，是索引行號過時，`git diff --stat` 確認只改了 6 個檔案。

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-11-13 | 建立 GitHub issue #29 | 使用者 |
| 2026-11-17 | 建立 issue 文件；AC-1～AC-7 依 Q1～Q4 的答案與草案確認核准；交付方式照 #27、#28（分支、本機獨立審查、不開 PR） | 使用者 |
| 2026-11-17 | 本機獨立審查 RETURN TO execute-task（review-23d451d.md：MUST FIX 1 項、SHOULD FIX 2 項），回頭修正 | - |

---
**建立日期**: 2026-11-17  
**分級**: Small  
**風險**: Low\
**狀態**: 實作中（審查要求修正）
