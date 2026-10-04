# Phase 1：容器 init 回收

日期：2026-10-04。Task：T1.1，支援 SCN-003／007；不代表瀏覽器替換或整個 Scenario 已完成。

## 紅燈與最小修正

修改 Compose 前執行 `npx tsx --test tests/docker/container-init.test.ts`：exit 1，2 tests／0 pass／2 fail，原因是兩份 Compose 的執行服務 `init` 為 undefined，而期望 true。外層已知 no-init orphan 取數紅燈引用 [Phase 0 正負對照](./phase0-report.md)，同一 fixture／映像及觀測器，Z=1；配置與真程序屬不同失敗面，沒有合併省略。

最小實作只在開發與 release 的共用執行設定各加入 `init: true`，兩服務繼承；不改 Memoria、runner `pids_limit: 1024`、權限、volume 或服務啟動方式。dev overlay 不需額外改動。

修改後執行 `npx tsx --test tests/docker/container-init.test.ts tests/docker/compose-parity.test.ts`：exit 0，3／3 通過。精煉為 no-op，沒有安全且必要的額外變更，這份綠燈仍代表最終配置。

## resolved 配置與 fresh fixture

`node docs/issues/issue-0010/evidence/verify-compose-init.mjs`：exit 0。完整命令與選定數值見 [compose-init-summary.json](./compose-init-summary.json)。讀取配置使用 `--env-file /dev/null --no-env-resolution --no-interpolate`，不輸出環境值、不掛正式 volume，不啟動 bot stack。

| 配置 | telenexus | agent-runner |
| --- | --- | --- |
| base | init=true，fixture Z=0 | init=true，pids_limit=1024，fixture Z=0 |
| release | init=true，fixture Z=0 | init=true，pids_limit=1024，fixture Z=0 |
| dev overlay | init=true，fixture Z=0 | init=true，pids_limit=1024，fixture Z=0 |

各 fresh fixture 在量測時 inspect `Init=true`／`Running=true`，orphan 起始活 PID 存在，退出後 PID 消失、Z=0；observer 保持存活。它們使用 resolved 配置已確認的 init 契約執行同一 orphan fixture，不假稱實際 bot 服務已啟動或正式部署已更新。量測後只停止這六個具名測試容器，保留紀錄。

## 專案 gate

2026-10-04 以 `node docs/issues/issue-0010/evidence/run-project-gates.mjs` 依序實跑，exit 0，見 [phase1-project-gates.json](./phase1-project-gates.json)：

- `npm run build`：exit 0。
- `npm run test`：exit 0，335 tests／0 fail；測試檔 50 個，新增 2 個 init 測試，未刪除／略過既有測試。
- `npm run lint`：exit 0。

未修改 installer，不需 installer gate。命令輸出為同目錄 `phase1-build.log`、`phase1-test.log`、`phase1-lint.log`；lint 紀錄的尾端空行與版本輸出的尾端空白已正規化，事件／結果／數值未改寫。沒有發版、重啟或升級正式部署，也未清除原正式容器的既有殭屍。
