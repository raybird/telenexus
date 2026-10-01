# Issue 0007 實作計畫

驗收劇本、風險與涉及檔案以 [README.md](./README.md) 為準；本檔是任務清單、狀態與證據的唯一來源。

## 現況與取捨

### 現況（2026-10-01 調查）

- `Dockerfile` 有兩個 stage：`builder`（含 devDependencies，執行 `npm run build`）與最後的 runtime stage（`npm ci --omit=dev`、全域 CLI、`COPY --from=builder /app/dist`、`CMD ["npm", "start"]`）。
- `release.yml` 與 `docker-compose.yml` 建置時都不指定 target，取到的是最後一個 stage。
- `tests/docker/compose-parity.test.ts` 要求 `docker-compose.yml` 與 `docker-compose.release.yml` 正規化後逐行相同，只容許 `build:` 區塊與 `image:` 行不同。開發專用的設定因此不能寫進 `docker-compose.yml`。
- `.gitignore` 已排除 `docker-compose.override.yml`，註解為個人的本機 override。
- `src/main.ts` 在缺少 `TELEGRAM_TOKEN` 或 `ALLOWED_USER_ID` 時直接 `process.exit(1)`，沒有不連 Telegram 的啟動模式。
- `src/web/server.ts` 找不到 `dist` 旁的 `public/` 時會退回 `process.cwd()/src/web/public`，以原始碼執行時 Web Console 的靜態檔可用。
- `npm run dev` 與 `npm run dev:runner` 已經是 `sync-skills.mjs` 接 `tsx watch`，容器內可沿用。

### dev stage 放在哪裡

`FROM` 只能引用前面定義過的 stage，所以 dev stage 要共用 runtime 的系統套件與全域 CLI 時有兩種排法：

```text
現況             方案 A（採用）       方案 B
builder          builder              builder
runtime（最後）  base                 runtime
                 dev                  dev（最後）
                 正式（最後）
```

- **方案 A**：把 runtime 拆成共用的 `base` 與最後的正式 stage，dev 夾在中間。不指定 target 的建置天生就是正式映像，`release.yml` 與 `docker-compose.yml` 都不用改。代價是正式 stage 的指令順序會動，需要用基準比對證明內容等價。
- **方案 B**：正式 stage 原封不動，dev 接在最後。代價是預設 target 變成 dev，`release.yml`、`docker-compose.yml` 與任何手動 `docker build` 都要記得加 target；漏一處就把 dev 映像發出去，而且流程全綠。

採方案 A：安全性來自結構本身，不依賴每個建置點都記得加參數。

### 開發用 compose 檔的檔名

採明確指定的 `docker-compose.dev.yml`，以 `-f docker-compose.yml -f docker-compose.dev.yml` 疊加。不用會被自動載入的 `docker-compose.override.yml`：該檔名已保留給個人本機設定，而且自動載入會讓 README「從原始碼安裝」的 `docker compose up -d --build` 悄悄變成開發模式。

## 設計方案

具體指令與路徑可由 execute-task 依實測調整，等價的寫法不視為規格變更。

### Dockerfile

- `base`：現行 runtime stage 中兩邊共用的部分，包含系統套件、`COPY package.json package-lock.json`、uv、全域 CLI（`pnpm`、`opencode-ai@1.15.10`、`mcp-memory-libsql`、`agent-browser`）與 entrypoint。
- `ARG APP_GIT_SHA` 與 `ARG APP_BUILD_TIME` 宣告在 `base` 的第一個 RUN 之前，正式 stage 另外宣告一次供 ENV 使用（2026-10-01 審查退回後修正）：ARG 之後的每個 RUN 都隱含使用它，`release.yml` 每次傳入不同的 `APP_BUILD_TIME`，所以從 apt 起的每一層每版都會重建。這是重排前的行為，本 issue 不改。
- 依賴清單的 COPY 留在全域 CLI 之前（2026-10-01 實作時補記；審查退回後更正適用範圍）：以下描述只適用於不帶 build args 的本機建置。現況下每次版本 bump 都會讓這一層之後的快取失效，未釘版的全域 CLI 與 Chrome 因此每版重裝。把它移到後面會讓這些工具改由 CI 快取決定新舊，屬於正式映像的行為變更，本 issue 不動。
- 建立目錄與 `chown -R node:node /app /home/node` 留在 dev 與正式 stage 各自的最後，不放進 `base`：它要在該 stage 的 `npm ci` 與 COPY 之後執行，擁有權才與現況相同。
- `dev`：`FROM base`，`npm ci`（含 devDependencies），不設 `NODE_ENV=production`，預設指令為 `npm run dev`。原始碼不 COPY 進映像，由 compose 掛載。
- 正式 stage（最後）：`FROM base`，`npm ci --omit=dev`、`COPY --from=builder /app/dist`、workspace 與 scripts，`NODE_ENV=production`、`CMD ["npm", "start"]`。內容與現行 runtime stage 等價。

### docker-compose.dev.yml

對 telenexus 與 agent-runner：

- `build.target: dev`，映像另外命名為 `telenexus:dev`。不分開命名的話，之後不帶 `--build` 的 `docker compose up` 會拿 dev 映像去跑正式設定。
- 追加唯讀掛載：`./src`、`./scripts`、`./package.json`、`./tsconfig.json`。`node_modules` 留在映像內，改依賴時重建 dev 映像。
- telenexus 的 healthcheck 改成跟著 `WEB_PORT` 走。`docker-compose.yml` 的 healthcheck 寫死 3030，開發時錯開埠會讓服務永遠 unhealthy。
- 指令：telenexus 用 `npm run dev`，agent-runner 用 `npm run dev:runner`（覆寫 `docker-compose.yml` 的 `node dist/runner.js`）。

memoria 服務不變。

### package.json

新增一個開發啟動 script（暫定 `docker:dev`），內容是帶兩個 `-f` 的 `docker compose up --build`。

### 與既有部署並存

- bot token：開發 stack 必須用另一個 bot 的 token。同一個 token 兩邊同時 poll 會讓 Telegram 回 409。
- Web 埠：既有部署佔用 3030 時，開發用 `.env` 的 `WEB_PORT` 改成別的埠，文件範例用 3031。
- compose 專案名取自目錄名，volume 與既有部署各自獨立，不需額外設定。

## 使用方式對照

| 情境               | 變更前                               | 變更後                                         |
| ------------------ | ------------------------------------ | ---------------------------------------------- |
| 開發時啟動服務     | 主機 `npm run dev`、`dev:runner`     | `npm run docker:dev`（主機指令保留為替代方式） |
| 從原始碼建正式映像 | `docker compose up -d --build`       | 不變                                           |
| 驗證               | 主機 `npm run build`、`test`、`lint` | 不變                                           |

## 測試策略

| 驗收    | 層級               | 證據                                                                                                              |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| SCN-003 | 靜態測試加映像比對 | `tests/docker/` 斷言的紅綠輸出；重排前後正式映像基準的 diff                                                       |
| SCN-001 | 整合（實際啟動）   | `docker compose ps` 的健康狀態；容器內行程列表顯示 `tsx watch`                                                    |
| SCN-002 | 整合（實際啟動）   | 修改前後的 log 與回應差異。對照組：以正式 target 啟動時做同樣修改，行為不變                                       |
| SCN-004 | 靜態檢查（純文件） | 以 grep 確認指令與說明存在；不改變可執行行為，採等價證據                                                          |
| SCN-005 | 既有驗證入口       | `npm run build`、`npm run test`、`npm run lint` 的輸出；`# tests` 不低於 2026-10-01 的基準（46 個檔、282 個測試） |

SCN-001 與 SCN-002 沒有自動化測試承擔，屬實地觀測。失敗時的可觀察差異：SCN-001 是服務停在 unhealthy 或行程為 `node dist/...`；SCN-002 是修改後 log 沒有重啟紀錄、回應維持舊內容。

## 實作步驟

1. ✅ **正式映像基準與守門測試**（SCN-003）
   - 產出：現行正式映像的基準清單，存於本目錄 `evidence/`；`tests/docker/` 新增「最後一個 stage 是正式映像」的靜態斷言。
   - 相依：無。
   - 完成判準：基準涵蓋 ENTRYPOINT、CMD、ENV、`/app` 檔案清單、`npm ls --omit=dev`、全域 CLI 版本；新斷言對現行 Dockerfile 為綠，並以「暫時把一個 dev stage 接在最後」的變異確認它會紅。
   - 證據（2026-10-01，工作區為 f863d1a 加本步驟變更，Dockerfile 與 f863d1a 相同）：
     - 基準：以 `docker build -t telenexus-issue7:before .` 建置（exit 0），再以 [capture-image-baseline.sh](./evidence/capture-image-baseline.sh) 擷取成 [image-baseline-before.txt](./evidence/image-baseline-before.txt)。同一映像連續擷取兩次，輸出相同。依賴清單用 `npm ls --all`，正式映像只裝 production 依賴，與 `--omit=dev` 等價。
     - 紅燈：[step1-guard-test-red.txt](./evidence/step1-guard-test-red.txt)，在 Dockerfile 最後接上 dev stage 後 `npx tsx --test tests/docker/dockerfile-hygiene.test.ts` 為 exit 1，3 個測試中失敗的是新增的那一個，原因是 `the dev stage must not be last`。變異在測試後以 `git checkout -- Dockerfile` 還原。
     - 綠燈：[step1-guard-test-green.txt](./evidence/step1-guard-test-green.txt)，現行 Dockerfile 下同一命令 exit 0，3 個測試全過。`npm run test` 為 exit 0，283 個測試全過。
     - 單迴圈合併：這項守門只有「讀 Dockerfile 文字」一個可觀察層級，沒有另一層整合責任；映像層的保障由步驟 2 的基準比對承擔。
     - 精煉：no-op，新增內容只有一個取最後 stage 的輔助函式與一個測試。
     - 基準的範圍限制：`/app/workspace` 是建置當下本機工作區的複本，只記筆數與彙總雜湊，不列檔名。
     - 補記：`image-baseline-before.txt` 在步驟 2 以同一份 Dockerfile（083e133 版）重建後重新擷取，原因見步驟 2 的證據。
2. ✅ **Dockerfile 重排：base、dev、正式**（SCN-003、SCN-001）
   - 產出：三段式 `Dockerfile`。
   - 相依：步驟 1。
   - 完成判準：不指定 target 建出的映像與步驟 1 的基準逐項相同；`--target dev` 建置成功且映像內有 `tsx`；`npm run test` 全綠。
   - 證據（2026-10-01，工作區為 083e133 加本步驟變更）：
     - 正式映像等價：`docker build -t telenexus-issue7:after .`（exit 0）後擷取成 [image-baseline-after.txt](./evidence/image-baseline-after.txt)，與基準的 `diff` 為空（exit 0）。審查退回修正後兩份基準都已重建並重新擷取，命令與結果見 [return1-build-arg-scope.txt](./evidence/return1-build-arg-scope.txt) 第 3 節。
     - 第一次比對曾有一處差異：`/app/workspace` 的內容雜湊不同、檔案清單相同。逐檔比對後只有 `workspace/context/events.jsonl` 不同，它在兩次建置之間被步驟 1 的 `npm run test` 寫入。以 083e133 的 Dockerfile 在同一份工作區狀態下重建基準映像後，差異消失。CI 從乾淨的 checkout 建置，不受這個本機檔案影響。
     - dev 映像：`docker build --target dev -t telenexus-issue7:dev .` 為 exit 0。[step2-dev-image-check.txt](./evidence/step2-dev-image-check.txt) 顯示 CMD 是 `npm run dev`、沒有 `NODE_ENV`、有 `tsx` 4.21.0；以 compose 相同的權限限制掛載 `src/` 後，`tsx` 以 node 身分執行 `src/main.ts`，並因缺少 `TELEGRAM_TOKEN` 自行結束（未連線 Telegram）。
     - 等價證據（純重排）：守門測試在重排後仍為綠；`npm run test` 為 exit 0，283 個測試全過。
     - 精煉：no-op。dev 與正式 stage 各有一段相同的 `mkdir` 與 `chown`，原因見設計方案，不合併。
3. ✅ **開發用 compose 檔與啟動 script**（SCN-001、SCN-002）
   - 產出：`docker-compose.dev.yml`、`package.json` 的開發啟動 script。
   - 相依：步驟 2。
   - 完成判準：`docker compose -f docker-compose.yml -f docker-compose.dev.yml config` 成功，合併結果中 telenexus 與 agent-runner 的 target、掛載與指令符合設計；`docker-compose.yml` 沒有變更，`compose-parity` 測試為綠。
   - 證據（2026-10-01，工作區為 cd12dc7 加本步驟變更）：[step3-compose-config.txt](./evidence/step3-compose-config.txt)
     - 合併設定：`config` 為 exit 0；telenexus 與 agent-runner 的 target 是 `dev`、映像是 `telenexus:dev`、指令分別是 `npm run dev` 與 `npm run dev:runner`，四個原始碼掛載都是唯讀；memoria 不變。
     - `WEB_PORT=3031` 時，telenexus 的 healthcheck 與對外埠都跟著變成 3031。
     - 只用 `docker-compose.yml` 時三個服務都沒有 target、映像名與指令維持原樣；`docker-compose.yml`、`docker-compose.release.yml`、`release.yml` 對 cd12dc7 沒有差異；`compose-parity` 測試為綠。
     - 啟動 script 定名為 `docker:dev`。
     - 本步驟只產出設定，實際啟動後的行為由步驟 4 驗證。精煉：no-op。
4. ✅ **啟動與熱重載實測**（SCN-001、SCN-002）
   - 產出：實測紀錄，存於本目錄 `evidence/`。
   - 相依：步驟 3、TBD-1。啟動服務屬 `docs/agents/project.md` 列的使用者決定事項，執行前取得同意。
   - 完成判準：三個服務 healthy；telenexus 與 agent-runner 的行程為 `tsx watch`；各修改一個被載入的檔案後，該服務未重建映像與容器即重啟並反映修改；對照組結果已記錄。
   - 證據（2026-10-01，被測提交 0b96860；使用者於同日對話同意暫停正式部署、借用其 token 實測）：
     - 實測：[step4-live.txt](./evidence/step4-live.txt)。三個服務 healthy；telenexus 與 agent-runner 的映像是 `telenexus:dev`、行程是 `tsx watch src/main.ts` 與 `tsx watch src/runner.ts`、`/app/src` 為唯讀掛載。在主機修改 `src/web/server.ts` 與 `src/runner.ts` 的 health 回應後，兩個服務的回應都變成修改後的值，容器的 Id、StartedAt 與映像都沒變，log 有 tsx 的 `Restarting` 紀錄；還原原始碼後回應也回到原值。telenexus 的 log 沒有 409。
     - 對照組：[step4-control.txt](./evidence/step4-control.txt)。不疊 `docker-compose.dev.yml`、以正式 target 啟動 agent-runner，對 `src/runner.ts` 做同樣的修改，30 秒內回應維持原值。
     - 反向自檢：熱重載失敗時，health 回應會維持原值，與對照組的結果相同；判準分得出成功與失敗。
     - 與驗收劇本的落差，照實記錄：
       - SCN-001 的前提是「開發用的 bot token」。這次用的是正式部署的 token，並在實測期間暫停正式部署，同一時間只有一個 poller，條件等價。獨立的開發用 bot 仍未建立，見 README 的 TBD-1。
       - 啟動指令是 `docker compose -f docker-compose.yml -f docker-compose.dev.yml -f <實測用 override> up -d --no-build --wait`，不是字面上的 `npm run docker:dev`：映像已用同一組 compose 檔預先建好，改成背景執行並等待 healthy。
       - 實測用 override（不進版控）把 `/app/data` 與 `/app/workspace` 指到暫存空目錄，並設 `PINNED_STATUS_ENABLED=false`、`MODEL_HEALTH_CHECK_ENABLED=false`。原因是 repo 的舊資料裡有 5 個啟用中的排程，借用正式 token 時要避免重複觸發與干擾聊天室。釘選訊息與模型健康檢查在開發 stack 下的行為因此沒有驗到。
       - 沒有透過 Telegram 實際對話，也沒有觸發 opencode 執行；驗到的是啟動、健康檢查、Telegram 連線成功與重載。
     - 正式部署兩次暫停各約 15 秒（12:09:12 至 12:09:26、12:10:18 至 12:10:33），恢復後三個容器是原本的容器且都是 healthy，Telegram 重新連上，沒有 409。
     - 第一輪實測的輸出已捨棄：腳本的等待函式把成功回報成 `no`，log 摘錄也沒有遮蔽使用者 ID。修正後重跑的第二輪即上述證據，兩輪的實際觀察一致。
5. ✅ **文件更新**（SCN-004、SCN-005）
   - 產出：`.env.example`、`README.md`、`CLAUDE.md`、`docs/agents/project.md` 的開發段落。
   - 相依：步驟 3（指令名稱定案）。
   - 完成判準：`README.md` 與 `CLAUDE.md` 的開發段落最先列出 Docker 開發指令，主機 `npm run dev` 列為替代；四份文件都寫明獨立 token、Web 埠與共用 token 的後果；`docs/configuration-reference.md` 已檢查，沒有新環境變數時記為 no-op；主機 `npm run build`、`npm run test`、`npm run lint` 都是 exit 0。
   - 證據（2026-10-01，工作區為 e2b6016 加本步驟變更）：[step5-docs-and-host-checks.txt](./evidence/step5-docs-and-host-checks.txt)
     - SCN-004（純文件，等價證據）：四份文件都以 grep 確認含 `docker:dev`、409、另一個 bot 的 token 與錯開 `WEB_PORT` 的說明；`README.md` 與 `CLAUDE.md` 的開發段落中 `npm run docker:dev` 排在主機 `npm run dev` 之前。
     - SCN-005：`npm run build`、`npm run test`（283 個測試、46 個檔）、`npm run lint`、`npm run test:installer` 都是 exit 0；`tests/docker/` 的 4 個測試全過。
     - `docs/configuration-reference.md`：no-op，本 issue 沒有新增環境變數，`src/` 也沒有變更。
     - `docs/agents/project.md` 的測試基準由 282 更新為 283（步驟 1 新增一個測試）。

## 風險與首要驗證

見 [README.md](./README.md) 的「風險與首要驗證」。步驟 1 即首要驗證。

次要未知：`tsx watch` 在容器內（非 root、`cap_drop: ALL`、bind mount）能否正常偵測檔案變更。由步驟 4 實測；不成立時回到本檔修訂設計，不影響步驟 1、2 的成果。

2026-10-01 補記：以拋棄式容器先行探測，機制成立。在與 compose 相同的權限限制與唯讀掛載下，`tsx watch` 偵測到主機端的修改並重跑，容器沒有重建，見 [step2-tsx-watch-probe.txt](./evidence/step2-tsx-watch-probe.txt)。這只證明機制，SCN-001 與 SCN-002 仍要由步驟 4 以實際服務驗證。

## 審查退回（第 1 輪，2026-10-01）

第一輪獨立審查的判定是 `RETURN TO execute-task`，報告見 [review-60f845f.md](./review-60f845f.md)。五項 SCN 的證據成立，退回原因是兩項 MUST FIX。

### 提交改寫

為了處理 M1，083e133 起的 6 筆提交已改寫（分支當時沒有任何遠端參照）。核准 commit f863d1a 在改寫範圍之前，不受影響。改寫前後每一筆的樹只差 `evidence/step1-guard-test-red.txt` 中的兩行路徑。本檔與證據檔中出現的舊 SHA 依下表對照：

| 改寫前  | 改寫後  | 提交                                    |
| ------- | ------- | --------------------------------------- |
| 083e133 | ae891e5 | 守門測試與基準                          |
| cd12dc7 | 37b91c1 | Dockerfile 拆出 base 並新增 dev stage   |
| e2b6016 | c1d98f5 | 開發用 compose override 與 `docker:dev` |
| 0b96860 | 0094620 | 文件更新                                |
| cb92e18 | b2afd49 | 步驟 4 實測紀錄                         |
| 60f845f | e6b9797 | Gate 豁免紀錄（第一輪審查的 HEAD）      |

### 處理結果

| 編號 | 問題                                                                | 處理                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1   | 證據檔含本機絕對路徑                                                | 改寫提交，把路徑換成 `<repo>`。改寫後 f863d1a 之後的每一筆提交都不含該路徑（`git grep` 逐筆確認）。                                                                                                                                                        |
| M2   | `ARG` 下移改變了正式映像的建置快取語意                              | 把兩個 `ARG` 放回 `base` 的第一個 RUN 之前，並新增守門斷言。紅燈見 [return1-arg-guard-red.txt](./evidence/return1-arg-guard-red.txt)；實際帶不同 `APP_BUILD_TIME` 建置的前後對照見 [return1-build-arg-scope.txt](./evidence/return1-build-arg-scope.txt)。 |
| S1   | 守門測試可被小寫 `from`、`npm install --include=dev`、多個 CMD 繞過 | 比對改為不分大小寫、擋下 `npm install` 與 `--include=dev`、只認最後一個 CMD。五組變異全紅，見 [return1-guard-mutations.txt](./evidence/return1-guard-mutations.txt)。                                                                                      |
| S2   | 開發 stack 沒有 `/app/dist`，排程與記憶 skill 無法使用              | 只補文件：`README.md`、`CLAUDE.md`、`docker-compose.dev.yml` 與 `docs/agents/project.md` 寫明限制，README 的「環境與正式映像相同」改為「工具鏈相同」。讓 dev 映像帶 dist 是新行為，不在本 issue 範圍。                                                     |
| S3   | `docs/runtime-boundary-and-security.md` 的 dev/prod 說明過時        | 已改寫該節。                                                                                                                                                                                                                                               |
| S4   | `CONTRIBUTING.md` 的開發流程只列主機 `npm run dev`                  | 已改為先列 `npm run docker:dev`，並加入 README 的涉及檔案。                                                                                                                                                                                                |

改善建議中採納的項目：issue 狀態用語、留存實測 override 的去敏複本（[step4-test-override.example.yml](./evidence/step4-test-override.example.yml)）、0 位元組的 diff 檔改為文字紀錄、`step4-live.txt` 的容器 ID 截短為 12 碼、README 提醒重建時間、`project.md` 補回共用 token 的現況。未採納：兩份相同的基準檔仍各留一份；`docker-compose.yml` 的 healthcheck 寫死 3030 屬既有問題，另行處理。

### 修正後的證據

- **M2 紅綠**：修正前的 Dockerfile 對新斷言為紅，原因是 `base stage should declare ARG APP_GIT_SHA before its first RUN`；修正後 `tests/docker/dockerfile-hygiene.test.ts` 的 4 個測試全過。
- **快取行為**：以不同的 `APP_BUILD_TIME` 實際建置。修正前 `base` 的每一層都命中快取；修正後從 apt 起每一層都重新執行，帶 ARG 的 RUN 指令集合與重排前相同。
- **SCN-003**：修正後不指定 target 建出的映像，基準與重排前的 `diff` 仍為空。兩份基準在同一份工作區狀態下重建與擷取。
- **SCN-001、SCN-002 的適用性**：步驟 4 的實測是對修正前的 dev 映像做的。修正只在 `base` 多了兩行 ARG，dev 映像已重建。這次沒有再暫停正式部署重跑完整實測，改以只啟動 agent-runner 的方式重驗：healthy、行程為 `tsx watch`、改檔後不重建容器即反映、還原後回到原值，見 [return1-dev-runner-recheck.txt](./evidence/return1-dev-runner-recheck.txt)。telenexus 在修正後的 dev 映像上沒有重新啟動過，這是殘餘限制。
- **SCN-004、SCN-005**：見 [return1-docs-and-host-checks.txt](./evidence/return1-docs-and-host-checks.txt)。

## 檢查清單

- [x] 步驟 1 的基準在改 Dockerfile 之前取得（之後以同一份舊 Dockerfile 重建過一次，見步驟 2）
- [x] `docker-compose.yml`、`docker-compose.release.yml`、`release.yml` 沒有變更
- [x] 啟動開發 stack 前取得使用者同意（借用正式 token 並暫停正式部署，未換成開發用 token）
- [x] 依 `docs/agents/project.md` 的常青文件對照更新受影響的文件（`docs/runtime-boundary-and-security.md` 於審查退回後補上）
