# 審查報告
- 範圍：完整交付範圍（本機獨立審查，未開 PR）。這是第三輪審查，重點是第二輪之後的增量 `93b7397..f0ff433`，也就是 `151a7cf` 與 `f0ff433`；其餘部分沿用 [review-e0585ce.md](review-e0585ce.md) 與 [review-e4e30f9.md](review-e4e30f9.md) 的結論，並確認這次的增量沒有影響到它們。
- Reviewed BASE SHA：9ff41121a4c847c85ce301d771cb0e88466ca26e（main）
- Reviewed HEAD SHA：f0ff433195d08db99b905a7c11182b2cfa7e388b
- Reviewed patch-id：6265ba50595fda7910dcf14f87fded1d6adf8a2e（由 reviewer 以 `git diff -a 9ff4112 f0ff433 | git patch-id --stable` 重算，與協調者提供的值一致）
- 審查日期：2026-10-21
- 獨立 reviewer：Claude（Opus 5.5）隔離 subagent，沒有參與本 issue 的實作。前兩輪報告也是同一個 reviewer 寫的，修正則由協調者完成。
- Review artifact：docs/issues/issue-0015/review-f0ff433.md

## 問題與風險

### MUST FIX
無。

### SHOULD FIX
無。

### NICE TO HAVE

1. **轉址的實測只在主機上做過。** `redirect: 'manual'` 的行為是在主機的 Node v22.20.0 上驗證的。release 映像（`telenexus:v2.30.1` 與本機建的 `telenexus:issue-0015`）的 `NODE_VERSION` 是 22.23.3。兩者同屬 Node 22，而 undici 在 Node 環境下以 `manual` 回傳實際的 3xx 回應，這個行為從 Node 18 起就沒有變過，所以風險很低。如果要完全排除疑慮，可以在下一次重建映像後，在容器裡加跑一次轉址測試。這次 reviewer 依約束沒有在映像內執行程式。
2. **上一輪 NICE 2～4 仍未處理。** 三項分別是：`ENOTFOUND`／`EAI_AGAIN` 的單元測試、「舊分區只剩人工審閱筆數」這項自我檢查的測試，以及臨時埠的競爭。協調者記錄了不處理的理由：這三種情況失敗時都會轉紅或拒絕寫入，不會變成假綠燈。reviewer 同意這個判斷，不阻擋交付。

## 已查核維度

### 第二輪發現的處理（對照 `evidence/step6-review-followup.md`「第二輪審查後續」）

| 第二輪項目 | 處理 | reviewer 核對 |
|---|---|---|
| SHOULD 1：prune 警告漏掉 `--all` | `docs/installation.md` 改成「不要執行任何 `memoria prune`」，並寫明 `--all` 預設會套用 180 天的 stale 條件 | 措辭與 Memoria 1.28.1 的 `runPrune` 一致（第二輪已從映像確認）。通過 |
| NICE 1：服務檢查會跟隨轉址 | 加上 `redirect: 'manual'`，並新增「轉址到沒有服務在聽的位址」的 SCN-007 測試 | 見下方「`redirect: 'manual'` 的行為」與「紅燈與綠燈」。通過 |
| NICE 5：核准紀錄的可追溯性 | SCN-013 那一列註明 Then 改於 `e4e30f9`；Timeline 把 Then 的收斂改記在協調者名下；SCN-001～SCN-012 維持合成一列，理由是同一次核准 | 註記與歸屬都正確。合成一列有寫理由，可以接受 |
| NICE 6：「無法確認」時怎麼處理 | 文件補一句：先用 `docker compose ps` 確認 memoria 不在執行，再重跑；工具不提供略過檢查的選項 | 與程式一致，程式確實沒有略過選項。通過 |
| NICE 2～4 | 不處理，附理由 | 可以接受（見 NICE TO HAVE 第 2 項） |

### `redirect: 'manual'` 的行為

在 Node v22.20.0 上，讓假服務回 301、302、303、307、308，`Location` 指向一個沒有服務在聽的埠：

- `redirect: 'manual'`：每種狀態碼都回傳實際的回應物件，`status` 就是那個 3xx，`type` 是 `basic`，`Location` header 讀得到，body 也存在。沒有丟錯，也沒有拿到瀏覽器那種 status 0 的 opaque-redirect。即使回 302 卻沒有 `Location`，也一樣回傳 302。
- `redirect: 'follow'`（舊行為）：每種狀態碼都丟出 `TypeError`，`cause.code` 是 `ECONNREFUSED`。這正是上一輪被誤判成「已停止」的路徑。

工具改用 `manual` 之後，任何 3xx 都會進到「回應 HTTP 3xx，仍在執行」的分支並拒絕寫入。用 HEAD 版本重跑服務檢查的探針，結果如下：

| 假服務的行為 | 工具的判定 |
|---|---|
| 302 轉到關閉的埠 | 拒絕：「回應 HTTP 302」 |
| 回 200、503、404 | 拒絕 |
| 超過 2 秒才回應 | 拒絕：無法確認（`TimeoutError`） |
| 斷線、不回任何內容 | 拒絕：無法確認（`UND_ERR_SOCKET`） |

### 紅燈與綠燈

證據的紀錄可信，reviewer 在 scratchpad 的 `f0ff433` worktree 上逐一重現（worktree 已移除）：

- **紅燈**：把服務換回 `e4e30f9` 的版本、測試維持新版，27 個測試中只有 1 個失敗，就是新加的轉址測試，錯誤是 `Missing expected rejection.`（舊程式跟隨轉址後判定已停止並寫入）。這與證據的「27 個中 1 個失敗」相符，失敗原因也正是缺少目標行為。
- **綠燈**：還原成 HEAD 後，27/27 通過。
- **突變**：只把 `redirect: 'manual'` 改成 `'follow'`，同一個測試轉紅；還原後工作區是乾淨的。

測試與修正放在同一個提交 `151a7cf`。證據寫的是「先補測試」，而紅燈可以用舊程式重現，所以採信。

### 驗收與證據

- **SCN-007**：已有的 200、503、逾時三組單元測試，加上這次的轉址測試，再加上步驟 6 的端到端，結論成立。這次修正只影響「收到 3xx」的分支。Compose 裡服務停止時，在收到任何回應之前就會得到 `EAI_AGAIN`；服務執行中則回 200。這兩條路徑都不經過被改動的分支，所以不需要重跑端到端。
- **SCN-001～SCN-006、SCN-008～SCN-013**：增量沒有改到分類、寫入、備份、索引或截斷的邏輯，`git diff 93b7397 f0ff433 -- src` 只有服務檢查的 `fetch` 選項。前兩輪的證據與結論仍然有效。
- **SCN-013 的核准**：表格註記與 Timeline 的歸屬都已更正，第二輪的判定維持不變：措辭依核准來源更正，原核准有效。

### 需求、架構、安全、品質

- 修改範圍很小：一個 `fetch` 選項加一行註解。測試只在假服務多了 `redirectTo` 參數，並把 SCN-007 的參數表多加一列，沒有重複程式。
- 增量裡沒有本機家目錄路徑、6 位以上的數字 ID、UUID 或 token。
- 文件的 prune 警告與「無法確認」的處理都與程式行為一致。

### 豁免、待確認與限制

- Gate 豁免（不開 PR、改由本機獨立審查）沿用 README 的紀錄。TBD-1（#19）、TBD-2 維持原狀。
- 限制：沒有在 release 映像內執行轉址測試（見 NICE TO HAVE 第 1 項），只以 `docker image inspect` 讀取 Node 版本；沒有重跑 Compose 端到端（理由見「驗收與證據」）。

## 你自己跑過的命令與結果

所有命令都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行。沒有使用 git stash，沒有碰正式部署、`runtelenexus_*` volume 或 `~/.memoria`，也沒有啟動任何服務。

- `git diff -a 9ff4112 f0ff433 | git patch-id --stable` → `6265ba50595fda7910dcf14f87fded1d6adf8a2e`，與協調者一致。
- `npm run build` → exit 0。
- `npm run lint` → exit 0。
- `npm run test` → exit 0：`# tests 546`、`# pass 546`、`# fail 0`。71 個測試檔，`tests/docker/` 的 4 個檔案都有跑到。
- `npx prettier --check` 檢查兩個異動的 TypeScript 檔 → 通過。
- `fetch` 的 `redirect` 行為探針（Node v22.20.0）：結果見「`redirect: 'manual'` 的行為」。
- 紅燈、綠燈與突變的重現：結果見「紅燈與綠燈」。
- 服務檢查探針（HEAD 版本）：結果見「`redirect: 'manual'` 的行為」的表格。
- `docker image inspect` → `telenexus:v2.30.1` 與 `telenexus:issue-0015` 的 `NODE_VERSION=22.23.3`。

## 流程判定

PASS

沒有 MUST FIX，也沒有 SHOULD FIX。第二輪的 SHOULD FIX 與採納的 NICE 都已處理，並有可以重現的證據；SCN-001～SCN-013 都有有效證據。
