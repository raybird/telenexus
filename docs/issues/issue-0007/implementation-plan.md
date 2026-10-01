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
- 依賴清單的 COPY 留在全域 CLI 之前（2026-10-01 實作時補記）：現況下每次版本 bump 都會讓這一層之後的快取失效，未釘版的全域 CLI 與 Chrome 因此每版重裝。把它移到後面會讓這些工具改由 CI 快取決定新舊，屬於正式映像的行為變更，本 issue 不動。
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
     - 正式映像等價：`docker build -t telenexus-issue7:after .`（exit 0）後擷取成 [image-baseline-after.txt](./evidence/image-baseline-after.txt)，與基準的 `diff` 為空（exit 0），見 [step2-image-baseline.diff](./evidence/step2-image-baseline.diff)。
     - 第一次比對曾有一處差異：`/app/workspace` 的內容雜湊不同、檔案清單相同。逐檔比對後只有 `workspace/context/events.jsonl` 不同，它在兩次建置之間被步驟 1 的 `npm run test` 寫入。以 083e133 的 Dockerfile 在同一份工作區狀態下重建基準映像後，差異消失。CI 從乾淨的 checkout 建置，不受這個本機檔案影響。
     - dev 映像：`docker build --target dev -t telenexus-issue7:dev .` 為 exit 0。[step2-dev-image-check.txt](./evidence/step2-dev-image-check.txt) 顯示 CMD 是 `npm run dev`、沒有 `NODE_ENV`、有 `tsx` 4.21.0；以 compose 相同的權限限制掛載 `src/` 後，`tsx` 以 node 身分執行 `src/main.ts`，並因缺少 `TELEGRAM_TOKEN` 自行結束（未連線 Telegram）。
     - 等價證據（純重排）：守門測試在重排後仍為綠；`npm run test` 為 exit 0，283 個測試全過。
     - 精煉：no-op。dev 與正式 stage 各有一段相同的 `mkdir` 與 `chown`，原因見設計方案，不合併。
3. 📝 **開發用 compose 檔與啟動 script**（SCN-001、SCN-002）
   - 產出：`docker-compose.dev.yml`、`package.json` 的開發啟動 script。
   - 相依：步驟 2。
   - 完成判準：`docker compose -f docker-compose.yml -f docker-compose.dev.yml config` 成功，合併結果中 telenexus 與 agent-runner 的 target、掛載與指令符合設計；`docker-compose.yml` 沒有變更，`compose-parity` 測試為綠。
4. 📝 **啟動與熱重載實測**（SCN-001、SCN-002）
   - 產出：實測紀錄，存於本目錄 `evidence/`。
   - 相依：步驟 3、TBD-1。啟動服務屬 `docs/agents/project.md` 列的使用者決定事項，執行前取得同意。
   - 完成判準：三個服務 healthy；telenexus 與 agent-runner 的行程為 `tsx watch`；各修改一個被載入的檔案後，該服務未重建映像與容器即重啟並反映修改；對照組結果已記錄。
5. 📝 **文件更新**（SCN-004、SCN-005）
   - 產出：`.env.example`、`README.md`、`CLAUDE.md`、`docs/agents/project.md` 的開發段落。
   - 相依：步驟 3（指令名稱定案）。
   - 完成判準：`README.md` 與 `CLAUDE.md` 的開發段落最先列出 Docker 開發指令，主機 `npm run dev` 列為替代；四份文件都寫明獨立 token、Web 埠與共用 token 的後果；`docs/configuration-reference.md` 已檢查，沒有新環境變數時記為 no-op；主機 `npm run build`、`npm run test`、`npm run lint` 都是 exit 0。

## 風險與首要驗證

見 [README.md](./README.md) 的「風險與首要驗證」。步驟 1 即首要驗證。

次要未知：`tsx watch` 在容器內（非 root、`cap_drop: ALL`、bind mount）能否正常偵測檔案變更。由步驟 4 實測；不成立時回到本檔修訂設計，不影響步驟 1、2 的成果。

2026-10-01 補記：以拋棄式容器先行探測，機制成立。在與 compose 相同的權限限制與唯讀掛載下，`tsx watch` 偵測到主機端的修改並重跑，容器沒有重建，見 [step2-tsx-watch-probe.txt](./evidence/step2-tsx-watch-probe.txt)。這只證明機制，SCN-001 與 SCN-002 仍要由步驟 4 以實際服務驗證。

## 檢查清單

- [ ] 步驟 1 的基準在改 Dockerfile 之前取得
- [ ] `docker-compose.yml`、`docker-compose.release.yml`、`release.yml` 沒有變更
- [ ] 啟動開發 stack 前已換成開發用 token，並取得使用者同意
- [ ] 依 `docs/agents/project.md` 的常青文件對照更新受影響的文件
