# Issue 0007 - 開發環境預設走 Docker：dev stage 與熱重載 compose

GitHub：<https://github.com/raybird/telenexus/issues/7>

## 概述

使用端已經是純 Docker（GHCR 預建映像加 `install.sh`）。本 issue 補上開發端：在容器內以原始碼執行 telenexus 與 agent-runner 並支援熱重載，讓開發時的執行環境（opencode 版本、agent-browser、uv、Memoria 服務）與正式映像一致。build／test／lint 仍以主機執行為主。

## 文件清單

- [implementation-plan.md](./implementation-plan.md)

## 快速導覽

### 當前流程

`docker-compose.yml` 建的是正式映像：執行編譯後的 `dist/`、不含 devDependencies。改程式後要 `docker compose up -d --build` 重建映像才看得到結果，所以實際開發是在主機跑 `npm run dev`。

### 重構後流程

一個指令啟動開發 stack：映像取自 Dockerfile 的 dev stage，`src/` 由主機掛載進容器，服務以 `tsx watch` 執行，存檔即重載。

## 關鍵差異

| 項目               | 變更前                   | 變更後                                          |
| ------------------ | ------------------------ | ----------------------------------------------- |
| 開發時的執行環境   | 主機（opencode 1.18.31） | 容器（與正式映像同一份 base，opencode 1.15.10） |
| 容器內改程式       | 重建映像                 | 存檔後自動重載                                  |
| 開發時的 Memoria   | 主機預設連不到           | compose 內的 memoria 服務                       |
| 不指定 target 建置 | 正式映像                 | 正式映像（不變）                                |
| build／test／lint  | 主機                     | 主機（不變）                                    |

## 涉及檔案

```text
.
├── Dockerfile                    # 可改：拆出共用 base、新增 dev stage，正式 stage 維持最後
├── docker-compose.dev.yml        # 新增：開發用 override
├── package.json                  # 可改：新增開發啟動 script
├── .env.example                  # 可改：開發用 token 與埠的說明
├── tests/docker/                 # 可改：守住「不指定 target 等於正式映像」
├── README.md                     # 可改：開發段落
├── CLAUDE.md                     # 可改：Common Commands
├── docs/agents/project.md        # 可改：啟動服務一節
├── docker-compose.yml            # 不可觸及：與 release 版的一致性由 compose-parity 測試守著
├── docker-compose.release.yml    # 不可觸及
├── .github/workflows/release.yml # 不可觸及：維持不指定 target 的建法
├── docker/memoria.Dockerfile     # 不可觸及
└── scripts/install.sh            # 不可觸及
```

## Gherkin 驗收劇本

```gherkin
Feature: 開發環境預設在 Docker 內執行

  @SCN-001
  Scenario: 以單一指令啟動開發 stack
    Given repo 的 .env 已填入開發用的 Telegram bot token 與 ALLOWED_USER_ID
    And ai-config.yaml 已存在
    When 開發者執行開發啟動指令
    Then telenexus、agent-runner 與 memoria 三個服務都進入 healthy
    And telenexus 與 agent-runner 以 tsx watch 執行掛載進容器的 src/

  @SCN-002
  Scenario: 修改原始碼後自動重載
    Given 開發 stack 已啟動且服務 healthy
    When 開發者在主機修改 src/ 下某個被該服務載入的檔案
    Then 該服務在沒有重建映像、沒有重建容器的情況下自動重啟
    And 重啟後的行為反映這次修改

  @SCN-003
  Scenario: 不指定 target 的建置仍產出正式映像
    Given Dockerfile 已包含 dev stage
    When 以不指定 target 的方式建置映像（release.yml 與 docker-compose.yml 的建法）
    Then 映像的 ENTRYPOINT、CMD、NODE_ENV、/app 內容、production 依賴與全域 CLI 版本與變更前的基準相同
    And 映像內沒有 devDependencies

  @SCN-004
  Scenario: 文件以 Docker 作為開發的預設路徑
    When 開發者閱讀 README.md 與 CLAUDE.md 的開發段落
    Then 最先列出的啟動方式是 Docker 開發指令，主機的 npm run dev 列為替代方式
    And 文件說明開發 stack 與既有部署並存時需要獨立的 bot token 與 Web 埠，以及共用 token 的後果

  @SCN-005
  Scenario: 主機的驗證入口維持不變
    When 開發者在主機執行 npm run build、npm run test、npm run lint
    Then 三者都以 exit 0 結束
    And docker-compose.yml 與 docker-compose.release.yml 仍只差 build: 與 image:
```

## Gherkin 核准紀錄

- **核准 commit**: f863d1a
- **核准來源**: 使用者於 2026-10-01 對話提出「如果這個專案想要預設都是使用 docker 環境無論是開發或使用」，同日在範圍選項中選定「只做開發服務預設走 Docker」（Dockerfile 加 dev stage、新增 dev 用 compose 檔含熱重載、開發用 .env 說明，更新 README、CLAUDE.md、project.md；build／test／lint 仍以主機為主），並指示「再來開 issue」。

全部 Scenario 於 2026-10-01 核准。

## 重構步驟概要

任務清單、狀態與證據只維護在 [implementation-plan.md](./implementation-plan.md) 的「實作步驟」：

1. 正式映像基準與守門測試
2. Dockerfile 重排：base、dev、正式
3. 開發用 compose 檔與啟動 script
4. 啟動與熱重載實測
5. 文件更新

## 風險與首要驗證

- **最大風險**：Dockerfile 重排後，不指定 target 的建置產出的不再是原本的正式映像，例如 devDependencies 或 dev 指令流進 GHCR 映像，或正式映像少了檔案。`release.yml` 不跑測試，這種錯誤在發版流程裡是全綠的。
- **風險等級與理由**：Medium。失敗會影響下載該版映像的使用者，但映像釘版、`install.sh --version` 可回滾，屬有限度影響；未知只有一項，即重排後的正式 stage 內容是否與現在等價。
- **首要驗證**：改 Dockerfile 之前，先用現行 Dockerfile 建置並記下正式映像的基準（ENTRYPOINT、CMD、ENV、`/app` 檔案清單、`npm ls --omit=dev`、全域 CLI 版本），同時在 `tests/docker/` 加上靜態斷言，守住「最後一個 stage 是正式映像」。
- **選擇理由**：風險來源是破壞既有行為，characterization 基準能直接比對前後差異。熱重載的端到端實測驗的是新能力，證明不了舊映像沒變。
- **完成證據**：重排後不指定 target 建出的映像，上述基準逐項相同；靜態斷言在現行 Dockerfile 為綠、在「dev stage 排最後」的變異下為紅。

## 待確認事項

| 編號  | 事項                                                                                                                                                                                                         | 狀態   | 影響                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------- |
| TBD-1 | 開發用的 Telegram bot token。repo 的 `.env` 目前與既有部署用同一個 token（2026-10-01 以雜湊比對確認），直接啟動開發 stack 會讓既有部署的 bot 收到 409。需由使用者向 BotFather 申請開發用 bot 並填入 `.env`。 | 待確認 | 阻擋步驟 4 的啟動實測（SCN-001、SCN-002）；步驟 1、2、3、5 不受影響 |

## Timeline

| 日期       | 異動                                          | 負責人 |
| ---------- | --------------------------------------------- | ------ |
| 2026-10-01 | 建立；SCN-001 至 SCN-005 依使用者同日對話核准 | -      |

---

**建立日期**: 2026-10-01  
**分級**: Medium  
**風險**: Medium\
**狀態**: 待實作
