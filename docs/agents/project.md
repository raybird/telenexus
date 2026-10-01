# 專案客製規範

本檔由專案維護，初始化只在不存在時建立，更新上游時保留。規劃與交付前讀取；未填內容從 repo 的設定、現有文件與命令取得，不為填表猜測。

## 專案邊界與驗證入口

模組職責、訊息流程與程式慣例以根目錄 `CLAUDE.md` 為準，完整模組地圖在 `ARCHITECTURE.md`；命令定義在 `package.json` 的 `scripts`。

### 產品內容與開發工具的分界

- 根目錄 `AGENTS.md` 與 `skills/` 是產品內容：compose 把 `AGENTS.md` 掛進 bot 的 workspace，兩者都隨 release bundle 出貨。開發 agent 的規則寫在 `CLAUDE.md` 與 `docs/agents/`。
- `docker-compose.yml`（開發）與 `docker-compose.release.yml`（bundle 範本）是兩份獨立檔案，服務設定兩份一起改。`tests/docker/compose-parity.test.ts` 要求兩者只差在 `build:` 與 `image:`，開發專用的設定放 `docker-compose.dev.yml`。
- `workspace/`、`data/`、`ai-config.yaml`、`.env` 是執行期狀態，範圍見 `.gitignore`。

### 驗證

交付前依序執行，三者都以 exit 0 為通過：

1. `npm run build`：`tsc` 就是型別檢查，repo 沒有獨立的 typecheck 指令。
2. `npm run test`：核對輸出的 `# tests` 與 `tests/` 下的測試檔數相稱（2026-10-01 基準：46 個檔、283 個測試）。v2.22.2 之前 glob 沒加引號，只跑到 4 個檔，輸出仍是 `# fail 0`。
3. `npm run lint`

改到 `scripts/install.sh` 或升級流程時加跑 `npm run test:installer`。

GitHub Actions 只有 tag 觸發的 `release.yml`，它只建映像與打包、不跑測試；push 與 PR 沒有 CI。本機實跑的輸出是唯一的測試證據。

### 啟動服務

開發時以 `npm run docker:dev` 在容器內啟動：dev stage、唯讀掛載 `src/`、存檔即重載。主機的 `npm run dev` 是替代方式。

維護者的正式服務跑在 repo 之外的 release 部署目錄（GHCR 映像）。啟動開發 stack 前，確認 repo 的 `.env` 用的是另一個 bot 的 `TELEGRAM_TOKEN`、`WEB_PORT` 已錯開：同一個 token 兩邊同時 poll，Telegram 會回 409，兩邊都收不到訊息。驗證以測試為主；需要實機驗證時，由使用者決定時機與方式。

## 提交與交付

- **訊息格式**：`type(scope): 中文摘要`。scope 用子系統名（如 `opencode`、`memoria`、`installer`、`model-health`），沒有明確子系統時省略。歷史上沒有使用 footer；有對應 issue 時才加 `Refs: #ID`。
- **基準分支**：`main`，遠端 `origin` 是 GitHub（SSH，不需要 token）。歷史以直接提交 `main` 為主，要不要開分支與 PR 依使用者當次指示；既有分支命名是 `<type>/<描述>`（如 `fix/upstream-429-failfast`）。
- **版本 commit 與 tag 由發版腳本產生**：純版號 commit（如 `2.27.3`）、`v*` tag 與 README 版本 badge 都交給 `npm run release:patch|minor|major -- -m "<訊息>"`。腳本會直接 `git push` 並推 tag，tag 觸發 GHCR 映像與 release bundle 發佈，所以發版由使用者下令。
- **發版腳本的前提**：在 `main`、有 staged 變更、沒有 unstaged 變更、帶 `-m`。功能已先 commit 時，把該版的 `CHANGELOG.md` 條目 `git add` 後以 `-m "docs: <新版號> release notes"` 執行；每版在歷史上是 `docs: X release notes` 接 `X` 兩筆。

## 常青文件更新責任

| 變更                                                  | 更新的文件                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| 模組職責、資料流、雙服務拓撲                          | `ARCHITECTURE.md`；`CLAUDE.md` 的 Key Modules 表與對應章節                  |
| 環境變數、`ai-config.yaml` 欄位、runner／session 設定 | `docs/configuration-reference.md`、`.env.example`、`ai-config.example.yaml` |
| 聊天 prompt 組裝                                      | `docs/current-chat-prompt.md`                                               |
| Web Console API 或頁面                                | `docs/web-console-reference.md`                                             |
| 容器權限、runtime 邊界、安全模型                      | `docs/runtime-boundary-and-security.md`                                     |
| 排程行為或操作方式                                    | `docs/scheduler-operation-runbook.md`                                       |
| 安裝、升級、release bundle 內容                       | `docs/installation.md`                                                      |
| 記憶檢索（SAR）行為                                   | `docs/summary-aware-retrieval-plan.md`                                      |
| 使用者可見的功能與指令                                | `README.md`                                                                 |
| npm scripts、開發命令                                 | `CLAUDE.md` 的 Common Commands                                              |
| 新增或淘汰 `docs/` 文件                               | `docs/README.md` 索引                                                       |
| 發版                                                  | `CHANGELOG.md` 該版條目                                                     |

`docs/README.md` 的「歷史提案 / 研究文件」區記錄當時的規劃，維持原樣。

## 本地 gate 與案例

- **GitNexus**：`CLAUDE.md` 要求改 symbol 前跑 `gitnexus_impact`、commit 前跑 `gitnexus_detect_changes`。impact 在這個 repo 會低報呼叫者（2026-09-08 實測 `interpretEvent` 回報 0，實際有 2 個生產呼叫點），所以另外用 `grep -rn "\bsymbolName("` 數一遍，兩者不一致時以 grep 為準。
- **新增必須被處理的狀態時，手動找齊所有分支**：`tsconfig.json` 的 `noFallthroughCasesInSwitch` 是註解掉的，eslint 也沒開 `switch-exhaustiveness-check`，編譯器不會指出漏處理的 `switch`。
- **需由使用者決定**：發版；啟動或重啟服務；升級正式部署；issue 編號來源（GitHub 上目前沒有 issue，建立第一份 issue 文件前先問）。
- **既有規劃文件**：`docs/superpowers/plans/` 與 `docs/*-plan.md` 是導入本流程前的產物。新 issue 文件依 `docs/AGENTS.md` 放在 `docs/issues/issue-{編號}/`。
