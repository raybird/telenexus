# 審查報告

- 範圍：完整交付範圍（本機流程，未開 PR）
- Reviewed BASE SHA：79fd6cd63dd0730a296e345a91febaca72730b6b
- Reviewed HEAD SHA：60f845f72cf66d69b3b926b8318e8ec6f3ad0e1b
- Reviewed patch-id：01ace72b202d420d4cc91ed5d129ebd316bfc453（自行以 `git diff BASE HEAD | git patch-id --stable` 複核，相符）
- 獨立 reviewer：與實作者隔離的 subagent（Claude，僅讀取 repo、diff 與證據檔自行判斷；未修改任何檔案，審查後工作區仍為 clean、HEAD 未變）
- Review artifact：docs/issues/issue-0007/review-60f845f.md

> 協調者補記（2026-10-01）：本報告審查的 HEAD `60f845f` 在審查後因 M1 被改寫，對應的新提交是 `e6b9797`；兩者的樹只差 `evidence/step1-guard-test-red.txt` 中的兩行路徑。新舊提交對照見 [implementation-plan.md](./implementation-plan.md) 的「審查退回」。以下為 reviewer 的原始報告。

## 問題與風險

### MUST FIX

**M1. 證據檔把本機絕對路徑（含 OS 帳號名）帶進公開 repo**

- 位置：`docs/issues/issue-0007/evidence/step1-guard-test-red.txt:9`、`:18`，內容是 `/home/<帳號>/Documents/RCodes/moltbot-lite/tests/docker/dockerfile-hygiene.test.ts`。
- 影響：BASE 的所有追蹤檔中這類路徑出現 0 次（`git grep -l` 複核），這是第一次引入。推上公開 repo 後，本機帳號名與目錄結構會永久留在歷史裡。實作者在步驟 4 已用同一標準處理過（因為沒遮使用者 ID 而捨棄第一輪輸出），這裡是漏網。敏感度低，但推送後無法回收。
- 建議：把路徑改成 `<repo>/tests/docker/...`。該檔由 083e133 引入，單純追加修正提交仍會留在歷史中。分支目前沒有任何遠端參照（`git branch -r --contains` 為空），可以改寫 083e133 之後的提交或以 squash 合併；核准 commit f863d1a 在它之前，不受影響。改寫後 HEAD 會變，需重審。

**M2. `ARG` 下移改變了正式映像的建置快取語意，與實作者自訂的「不動」界線牴觸，且未揭露、無證據**

- 位置：`Dockerfile:91-92`（新）對照 `git show 79fd6cd:Dockerfile` 的 25-26 行；相關敘述在 `Dockerfile:43-44` 與 `docs/issues/issue-0007/implementation-plan.md:45`。
- 事實：
  - 舊版 `ARG APP_GIT_SHA`、`APP_BUILD_TIME` 宣告在 runtime stage 最上方。`docker history telenexus-issue7:before` 顯示 apt-get、`npm ci`、uv、全域 CLI、`agent-browser install` 這些 RUN 都帶 `|2 APP_GIT_SHA=… APP_BUILD_TIME=…`。
  - 新版 `telenexus-issue7:after` 的同一批 RUN 已不帶這兩個 ARG；ARG 只存在於最後一個 stage。
  - `.github/workflows/release.yml:58-62` 每次傳入不同的 `APP_BUILD_TIME`，並啟用 `cache-from/to: type=gha,mode=max`。
- 影響：
  - 依 Docker 文件，ARG 之後的 RUN 隱含使用該 ARG，值不同就 cache miss。舊版因此每次發版都從 apt-get 起整段重建。
  - 新版只剩 `COPY package.json`（`Dockerfile:45`）能讓快取失效。版本 bump 仍會重裝全域 CLI 與 Chrome，但 **apt 系統套件那一層改由 GHA 快取決定新舊**。
  - 本機 `npm run docker:up:meta` 與 `docker:up:telenexus` 原本每次都重裝未釘版的全域 CLI 與 Chrome，現在不會。
  - 計畫第 45 行把「改由 CI 快取決定新舊」定義為「正式映像的行為變更，本 issue 不動」，實際上對 apt 層與同版重建已經動了。前後基準比對看不到這件事：兩次建置都用預設值 `unknown`。
- 建議：二擇一。
  - 把兩行 `ARG` 放回 `base` 的 `WORKDIR` 之後，最後 stage 保留自己的宣告。這樣還原原本的快取語意，映像內容不變，重跑基準應仍為空 diff。
  - 或保留現狀，但在計畫與 `Dockerfile` 註解照實寫出這項變更，並取得使用者決定。
- 驗證限制：我依 Docker 文件與兩個映像的 history 推論，未以實際建置重現 cache miss（本次審查不得建置映像）。

### SHOULD FIX

**S1. 守門測試有可繞過的寫法**（證據持久力，不是假綠燈）。位置 `tests/docker/dockerfile-hygiene.test.ts:13`、`:35`、`:46`。我在 repo 外的複本做了變異：

- 結尾接小寫的 `from base as dev` 加 dev 的 CMD：測試仍綠（exit 0），但不指定 target 的建置會變成 dev。原因是第 13 行的 `/^FROM\s.+$/gm` 區分大小寫，而 Dockerfile 指令不分大小寫。建議改成 `/^\s*FROM\s.+$/gim`。
- 最後 stage 再加一行 `RUN npm install --include=dev`：仍綠。第 35 行只擋 `npm ci`。
- 第 46 行只要 stage 內任一處有 `CMD ["npm","start"]` 就過；建議改為斷言最後一個 CMD。

**S2. 開發 stack 沒有 `/app/dist`，內建 skill 指示 bot 執行的 CLI 在開發容器內不存在，文件未揭露**

- 位置：`skills/scheduler/SKILL.md:15` 起（`node /app/dist/tools/scheduler-cli.js`）、`skills/memory/SKILL.md:13` 起、`AGENTS.md:36-37`。
- dev 映像的 `/app` 只有 `data node_modules package*.json workspace`（`evidence/step2-dev-image-check.txt:9`），`docker-compose.dev.yml:21-24` 也沒有掛 dist。
- 影響：在開發 stack 透過 bot 測排程或記憶 skill 會失敗。`README.md:149` 寫「環境與正式映像相同」；步驟 4 揭露了沒觸發 opencode，但沒指出這個後果。
- 建議：在 README 與 `docker-compose.dev.yml` 註明此限制，或另開 issue 處理。這不在 SCN 範圍內，不構成驗收缺口。

**S3. 常青文件漏更新**。`docs/runtime-boundary-and-security.md:166-169` 仍寫 dev 模式靠 `docker-compose.override.yml`，且「安全硬化在 dev/prod 一致生效，因為共用同一個映像」。本次之後 dev 與正式是不同 stage 的映像。`docs/agents/project.md` 的對照表把容器與 runtime 邊界對應到這份文件，計畫檢查清單（`implementation-plan.md:163`）卻勾了已完成，只記了 `configuration-reference.md` 的 no-op。

**S4. `CONTRIBUTING.md:11-14` 的開發流程仍只列主機 `npm run dev`**，與「預設走 Docker」不一致。不在 SCN-004 點名的兩份文件內，故不列為驗收缺口。

### NICE TO HAVE

- `docs/issues/issue-0007/README.md:140` 的狀態寫「待 PR 與審查」，但 PR 已豁免，用語可對齊。
- 步驟 4 的「實測用 override」沒有留存去敏複本，證據無法重現。`step2-image-baseline.diff` 是 0 位元組檔，建議改記命令與 exit code。兩份逐位元相同的 63KB 基準檔可只留一份加雜湊。
- `evidence/step4-live.txt:6-8`、`:79-81` 含正式部署的容器名與完整容器 ID，敏感度低，可遮蔽。
- `.env.example:1-2`、`:90` 的開發說明會隨 release bundle 出貨（`release.yml:81`）。另外 `docker-compose.yml:85` 的 healthcheck 寫死 3030 是既有問題：我以 `WEB_PORT=3031` 驗證，只用正式 compose 時 healthcheck 仍打 3030。使用者若錯開的是非 dev 那一側會永遠 unhealthy，建議另開 issue。
- `base` 把 `COPY package.json` 放在全域 CLI 之前，任何 `package.json` 變動（含只改 scripts）都會讓 dev 映像重裝全域 CLI 與 Chrome。這是已記錄的取捨，可在 README 提醒。
- `docs/agents/project.md:31` 移除了「repo 的 `.env` 目前與正式部署共用 token」這個仍為真的現況（見 TBD-1），可保留一句。
- `docker-compose.dev.yml:29` 的 `command` 與 dev stage 的 CMD 重複，屬可接受的顯式寫法。

## 已查核維度

### 驗收與證據

| SCN     | 證據位置                                                                                                          | 結論                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SCN-001 | `evidence/step4-live.txt:11-27`、`:70-73`                                                                         | 支持 Then：三個服務 healthy、映像 `telenexus:dev`、行程為 `tsx watch src/main.ts` 與 `src/runner.ts`、`/app/src` 唯讀。我未重現（不得啟動服務），僅審閱證據。 |
| SCN-002 | `evidence/step4-live.txt:29-39`、`:51-68`；對照組 `evidence/step4-control.txt`                                    | 支持 Then：health 回應改變、容器 Id／StartedAt／Image 不變、log 有 `Restarting`。對照組（正式 target）30 秒內不變，反向自檢成立。未重現。                     |
| SCN-003 | `image-baseline-before.txt`、`image-baseline-after.txt`、`step1-guard-test-red.txt`、`step1-guard-test-green.txt` | 映像內容通過，我已獨立重現（見下方命令）。快取語意不在 Then 內，另列 M2。                                                                                     |
| SCN-004 | `README.md:147-163`、`CLAUDE.md:12-15` 與新增的兩段說明、`evidence/step5-docs-and-host-checks.txt`                | 通過：Docker 指令在前、主機 `npm run dev` 為替代；獨立 token、Web 埠與 409 後果都有寫。                                                                       |
| SCN-005 | `evidence/step5-docs-and-host-checks.txt:21-39`                                                                   | 通過，我自行重跑三個入口都是 exit 0，compose-parity 為綠。                                                                                                    |

- **SCN-001 的落差屬限制揭露，不是驗收缺口**。實作者列了四項：借用正式 token 並暫停正式部署、啟動指令改用 `--no-build -d --wait` 加實測 override、data 與 workspace 指到暫存目錄、未實際對話。同一時間只有一個 poller，條件等價。字面上的 `npm run docker:dev` 沒有端到端跑過，只確認了 script 字串。
- **時間線合理**：兩次暫停各約 15 秒，本機 Docker 28.1.1 在 start period 內預設每 5 秒探測一次。
- **SCN-003 無 devDependencies**：基準的 `npm ls --all` 與 `.bin` 不含 `package.json` 的任何 devDependencies。
- **測試真偽**：
  - 假綠燈：未發現。守門斷言都是字面性質，不是同義反覆；紅燈由目標行為驅動，我在新舊 Dockerfile 上都重現了。
  - 證據持久力：見 S1 與 NICE TO HAVE。
  - 基準鑑別力：成立。對 dev 映像跑同一支腳本，與基準差 1107 行且腳本 exit 1。

### 相關失敗面

| 輸入／狀態                                            | 預期                              | 現有覆蓋                                                                                                   | 判定                           |
| ----------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| dev stage 被排到最後，流進 release 映像               | 守門紅燈                          | 大寫 `AS dev`、改名為 `development`、拿掉 `--omit=dev`、CMD 改成 dev，我的變異都紅                         | 通過；小寫 `from` 可繞過（S1） |
| 發版時 build-arg 每次不同，且有 GHA 快取              | 與變更前相同的重建範圍            | 無                                                                                                         | 缺口（M2）                     |
| 只用 `docker-compose.yml` 啟動                        | 沒有 target、映像名與指令維持原樣 | 我以 `config` 驗證：image 未指定、無 target、runner 指令是 `node dist/runner.js`                           | 通過                           |
| 跑過 dev 之後不帶 `--build` 執行 `docker compose up`  | 不會拿 dev 映像跑正式設定         | dev 映像另名 `telenexus:dev`（`docker-compose.dev.yml:16`）                                                | 通過                           |
| 正式 compose 與 release compose 的一致性              | 只差 `build:` 與 `image:`         | parity 測試為綠；兩檔零變更                                                                                | 通過                           |
| dev compose 或 dev 內容進入 release bundle 或正式映像 | 不進                              | bundle 只取 `docker-compose.release.yml`；最後 stage 只複製 dist、workspace、scripts、`debug-container.sh` | 通過                           |
| `WEB_PORT=3031` 的開發 stack                          | healthcheck 與埠跟著變            | 我以合併 `config` 驗證，兩者都是 3031                                                                      | 通過                           |
| 兩個部署共用 token                                    | 文件警示                          | 四份文件都有；無技術防呆，符合 SCN-004 的文件層級                                                          | 通過；本機現況仍共用（TBD-1）  |
| `PUID` 不是 1000，加上唯讀掛載                        | entrypoint 不因 chown 失敗        | `scripts/docker-entrypoint.sh:39-47` 只處理特定目錄且容錯                                                  | 通過（靜態閱讀，未實跑）       |
| 在開發 stack 觸發排程或記憶 skill                     | 可用                              | 無                                                                                                         | 會失敗（S2）                   |

### 需求、架構、安全、品質

- **規格與核准**：Gherkin 區塊在 f863d1a 與 HEAD 之間逐字相同（`diff` 複核）。README 的變動只有核准 commit 回填、TBD-1、Gate 豁免與狀態。GitHub issue #7 存在，狀態 OPEN，建立於 2026-10-01T03:45Z，早於 f863d1a。核准原話只能對照 README 的引述，對話本身我無法獨立驗證。
- **架構與範圍**：五個「不可觸及」的檔案與 `src/` 都零變更。所有變更檔都在涉及檔案清單或 issue 目錄內。超出核准範圍的行為變更只有 M2。
- **Dockerfile 等價性**：
  - 逐行比對新舊最後 stage，ENV 的內容與順序、ENTRYPOINT、CMD、擁有權都相同。
  - `chown -R` 仍在各 stage 最後，entrypoint 仍是 root:root 775。
  - 差異有二：`npm ci --omit=dev` 移到全域 CLI 之後（內容無影響）、ARG 位置（M2）。
  - dev stage 合理：不 COPY 原始碼與 `.env`、不設 `NODE_ENV`；`--target dev` 不會觸發 builder。
- **安全**：
  - diff 中無 token。使用者 ID 已遮成 `<user-id>`。
  - 合併設定的容器權限與正式相同：`no-new-privileges`、`cap_drop: ALL`、同一組 `cap_add`，無 privileged，無新增埠，只多四個唯讀掛載。
  - 隱私問題見 M1。
- **品質**：dev 與正式 stage 各一段相同的 `mkdir` 加 `chown`，必須在各自的 `npm ci` 之後執行，重複合理。YAML anchor 的用法恰當，沒有過度設計。新測試與既有第二個測試對 `npm ci --omit=dev` 略有重疊，可接受。

### 豁免、待確認與限制

- **Gate 豁免**：只列「建立 PR」，欄位齊全，並明寫獨立審查未豁免，符合規範。
- **TBD-1**：狀態改為「不影響本次交付」，附日期、結論與理由，符合規範。殘餘事項是獨立的開發用 bot 尚未建立，在這台機器直接跑 `npm run docker:dev` 會讓正式 bot 收到 409。
- **未驗證**：
  - 步驟 4 的實機啟動與熱重載（不得啟動服務）。
  - 字面的 `npm run docker:dev`。
  - `npm run test:installer`（不在允許清單）。
  - M2 的 cache miss 未以實際建置重現。
  - 核准對話原文。

### 我實際執行過的命令與結果

- `git diff BASE HEAD | git patch-id --stable`：相符。`git diff --name-status`：22 個檔。
- `npm run build`：exit 0。`npm run lint`：exit 0。`npm run test`：exit 0，283 個測試、46 個檔、fail 0。
- `npx tsx --test tests/docker/dockerfile-hygiene.test.ts tests/docker/compose-parity.test.ts`：4 個全過。
- `capture-image-baseline.sh` 對 `:before` 與 `:after` 重新擷取：與已提交的兩份基準檔逐位元相同，兩者互相也相同。對 `:dev`：exit 1，差 1107 行。
- `docker history` 與 `docker image inspect` 三個映像：確認 `:before` 來自舊 Dockerfile、`:after` 來自新 Dockerfile，Env 順序與內容相同，以及 M2 的 ARG 範圍差異。
- 守門測試變異（repo 外暫存複本，共 11 組）：結果見 S1 與失敗面表。
- `docker compose … config --format json`（只擷取非機密欄位）：合併、僅正式、`WEB_PORT=3031` 三種。
- `gh issue view 7`、`git branch -r --contains`、`npx prettier --check`。

## 流程判定

RETURN TO execute-task — M1 會把本機路徑永久帶進公開歷史，M2 是未揭露且牴觸實作者自訂界線的正式映像建置行為變更；兩者修正成本都很低，五項 SCN 的證據本身成立。
