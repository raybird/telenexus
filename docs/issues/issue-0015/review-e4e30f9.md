# 審查報告
- 範圍：完整交付範圍（本機獨立審查，未開 PR）。這次是重新審查，重點放在上次審查之後的增量 `ff409cb..e4e30f9`，也就是 `a9a6b0f` 與 `e4e30f9`。上次已審過的部分，只核對增量有沒有影響到。
- Reviewed BASE SHA：9ff41121a4c847c85ce301d771cb0e88466ca26e（main）
- Reviewed HEAD SHA：e4e30f94f87b1654eb86af2691df9cf027cb6e44
- Reviewed patch-id：399ea796b53497ccd08326b69aa7916e27dfb8b5（reviewer 以 `git diff -a 9ff4112 e4e30f9 | git patch-id --stable` 重算，與協調者提供的一致）
- 審查日期：2026-10-21
- 獨立 reviewer：Claude（Opus 5.5）隔離 subagent，沒有參與本 issue 的實作。上次報告 [review-e0585ce.md](review-e0585ce.md) 也是我寫的，修正則由協調者完成。
- Review artifact：docs/issues/issue-0015/review-e4e30f9.md

## 問題與風險

### MUST FIX
無。

### SHOULD FIX

1. **prune 警告只寫了 `--stale-days`，漏了 `--all`**（`docs/installation.md:83`）
   - 我從 `ghcr.io/raybird/telenexus-memoria:v2.30.1` 取出 Memoria 1.28.1 的 `dist/cli.mjs` 核對：
     - `pruneStaleMemory()`（第 6621 行起）與 1.30.0 相同，都會刪除「沒有 `memory_node_sources`、時間早於門檻、沒有被 utility 或 durable 保留」的 session，連同它的 events。
     - prune 只由 CLI 的 `memoria prune` 觸發（第 26413 行），serve 不會自動執行。所以文件把它當成「操作人員在寫入與重建之間誤跑」的風險，這個判斷正確。
   - 但 `runPrune` 的 `--all` 預設也會套用 stale 180 天（第 6705 行）。在資料副本上，2,301 筆舊 session 裡已有 1,083 筆早於 180 天，在重建索引前跑 `memoria prune --all`，這些都會成為刪除候選。
   - 小標題「先重建索引再做其他維護」方向正確，但內文只點名 `--stale-days`，容易被讀成 `--all` 沒關係。
   - 建議：改成「不要執行任何 `memoria prune`（包括 `--all`，它也會套用 `--stale-days 180`）」。

### NICE TO HAVE

1. **服務檢查會跟著轉址走**（`src/services/memoria-legacy-scope.ts:354`）
   - `fetch` 預設跟隨轉址。實測：某個服務對 `/v1/health` 回 302，指向一個沒有服務在聽的埠，工具收到 `ECONNREFUSED`，就判定「已停止」並寫入。
   - Memoria 不會轉址，只有在 `MEMORIA_ENDPOINT` 前面接了反向代理時才可能發生，機率很低。
   - 建議：加上 `redirect: 'manual'`。這樣只要原始端點有回應（包括 3xx），就拒絕寫入。

2. **`ENOTFOUND`、`EAI_AGAIN` 沒有單元測試守住**
   - 突變檢查：從 `STOPPED_ERROR_CODES`（第 341 行）拿掉其中任何一個，測試全綠。
   - 這個方向是 fail-safe：拿掉之後工具會在 Compose 裡拒絕寫入，不會誤寫，而且步驟 6 的端到端已實測到 `EAI_AGAIN`。
   - 可以補一個指向 `http://memoria.invalid:<埠>` 的測試，斷言 `reachable: false`，不鎖定是哪個錯誤碼。主機與沙箱可能分別回 `ENOTFOUND` 或 `EAI_AGAIN`，兩者都在集合裡。

3. **「舊分區只剩人工審閱筆數」這個自我檢查仍然沒有測試**（第 274 行）
   - 拿掉它，測試全綠。
   - 上次我用「更新 sessions 時以 trigger 在舊分區插入一筆」實測過，它會回滾，可以照這個方式補測試。

4. **測試用的 `STOPPED_ENDPOINT` 有極小的機率不穩**（`tests/memoria-legacy-scope.test.ts:36`）
   - 它是「先開再關」的臨時埠。`node --test` 會平行跑多個測試檔，其他檔案可能剛好拿到同一個埠。
   - 真的碰上時，工具會拒絕寫入，表現為紅燈，不會變成假綠燈。
   - 建議：維持現狀，或在 `withTempDir` 內各自取埠。

5. **核准紀錄的可追溯性**（`docs/issues/issue-0015/README.md:160-163`、`205`）
   - 判定：SCN-013 的 Then 收斂到核准選項的原文，這屬於「措辭依核准來源更正」，不需要重新核准（依據見「已查核維度」）。
   - 可以改善的三處：
     - SCN-013 那一列的核准 commit 是 `cf5cbff`，但現在的 Then 文字是在 `e4e30f9` 才改的。建議加註「Then 措辭於 e4e30f9 依核准原文更正」。
     - Timeline 那一列把 Then 的收斂算在「獨立 subagent」名下，但 reviewer 只提出建議，實際修改的是協調者與實作者。
     - `acceptance.md` 要求表格與 Scenario 集合完全相等，`SCN-001～SCN-012` 合成一列是否符合要求，可以考慮拆開。

6. **服務檢查判定「無法確認」時，文件沒有說怎麼辦**
   - 例如端點逾時、或回應 `UND_ERR_SOCKET` 時，工具會拒絕寫入，而且沒有覆寫旗標。
   - `docs/installation.md` 可以補一句：遇到時先用 `docker compose ps` 確認 Memoria 已停止，再重試。

## 已查核維度

### 上次 SHOULD FIX 與 NICE TO HAVE 的處理（對照 `evidence/step6-review-followup.md`）

| 上次項目 | 處理 | reviewer 核對 |
|---|---|---|
| SHOULD 1 服務檢查 | 新增 `checkMemoriaStopped()`，只有 `ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN` 算已停止 | 用 Node 22.20 實測 `fetch` 的錯誤形狀：127.0.0.1、localhost、[::1] 的關閉埠是 `ECONNREFUSED`；`.invalid` 是 `ENOTFOUND`；在主機上解析 `memoria` 是 `EAI_AGAIN`；埠 9 是 `bad port`（沒有 code，所以拒絕）；黑洞 IP 是 `TimeoutError`（拒絕）；沒有 scheme 是 `unknown scheme`（拒絕）。假服務回 200、503、404，延遲 3 秒，或斷線不回應（`UND_ERR_SOCKET`），全部拒絕，訊息分得出「仍在執行」與「無法確認」。判定方向正確、而且保守，殘留的邊角是 NICE 1 的轉址 |
| SHOULD 2 `--db` | 改成 `requiredOption`，不再 import `resolveMemoriaSessionsDbPath` | 新測試把 `MEMORIA_HOME` 指到放了合成資料庫的暫存目錄，不給 `--db`：結束碼非 0，資料庫不變。舊 CLI 在同一個測試下會寫入，所以紅燈有意義，而且測試本身不會碰到真正的 `MEMORIA_HOME` |
| SHOULD 3 `CLAUDE.md` | Memory tooling 補一行，並寫明 `--db` | 通過 |
| SHOULD 4 核准表 | 展開成表格，SCN-013 指向 `cf5cbff` | 通過（細節見 NICE 5） |
| SHOULD 5 其他 scope 的節點 | 新測試放入其他 scope 的孤兒 topic 與 root | 我重跑突變：level-1、level-0 的 DELETE 各自拿掉 `scope = ?`，都轉紅 |
| NICE 1 SCN-013 措辭 | Then 收斂成「不含落單的 surrogate，不寫出不合法的 UTF-8」 | 與實作和測試一致；核准的判斷見下方「驗收與證據」 |
| NICE 2 自我檢查、ModelMessage 多筆 | 補上 events 自我檢查的測試與兩筆 ModelMessage 的情況；更正步驟 3 證據的說法 | events 自我檢查的突變轉紅；剩餘筆數的檢查仍未覆蓋（NICE 3） |
| NICE 3 操作文件 | 補上 `/memoria` 與 `/data` 的對應、回復會丟掉新記憶、prune 警告 | prune 警告不完整（SHOULD 1） |
| NICE 4 原因措辭 | 分成「缺少 user_id」與「user_id 不是有效的字串」 | 通過，並以 `user_id: 42` 測試 |
| NICE 5、6 | 不處理，有寫理由 | 可接受，兩項都不影響正確性 |

### 驗收與證據

- **SCN-001～SCN-006、SCN-008、SCN-010～SCN-012**：增量沒有改到分類、寫入、備份或索引的邏輯。上次的證據與結論仍然有效，`git diff ff409cb e4e30f9 -- src` 只動到服務檢查、原因措辭與 CLI 選項。
- **SCN-007**：
  - 證據：單元測試的 200、503、逾時三種情況，加上步驟 6 的端到端（執行中回 200 被拒；`docker compose stop` 之後得到 `EAI_AGAIN`，判定已停止並遷移 2,300 筆）。
  - 結論：成立。上次指出的缺口已補上。
- **SCN-009**：
  - 證據：原本的 trigger 失敗測試，加上新的自我檢查測試。
  - 結論：成立。
- **SCN-013**：
  - 修訂後的 Then 與 `tests/memoria-sync-payload.test.ts` 的斷言一致，都是「沒有落單的前半或後半，以『…』結尾」。
  - 核准判定：README 記錄的核准選項原文是「讓 truncateForSummary 不切開 surrogate pair（遇到就少取一個字元）」。收斂後的 Then 等於這個選項，`cf5cbff` 寫成「不含切成一半的 emoji」反而超出了選項。依 `docs/agents/acceptance.md`「規格修訂的查核」，差異沒有改變核准來源所定的結果，所以原核准有效，並在 Timeline 留下紀錄。這個判斷的前提是 README 引用的選項原文正確；選項原文出自使用者對話，reviewer 無法另行核對。

### 「先改程式後補紅燈」的補救是否可信

可以採信。

- 我在 scratchpad 開了 `e4e30f9` 的 worktree，用 `git show e0585ce:` 換回舊的服務與 CLI，配上新的測試。結果 26 個中 5 個失敗，與 `step6-review-followup.md` 列的 5 個完全相同：
  - SCN-004：原因措辭。
  - SCN-007：503。
  - SCN-007：逾時。
  - CLI：沒有 `--db`。
  - SCN-002：`serviceCheck` 的 `detail`。
- 每個失敗都直接對應目標行為的缺少，不是環境問題或語法錯誤。
- 守護既有行為的兩個測試（其他 scope 的節點、events 自我檢查）在舊程式上本來就是綠的，改以突變證明它們有效。我重跑過，都會轉紅。
- 順序錯誤已經主動揭露。依 `docs/agents/verification.md`，揭露限制不算缺失。

### 相關失敗面（增量）

| 輸入／狀態 | 預期行為 | 覆蓋 | 判定 |
|---|---|---|---|
| `/v1/health` 回 2xx、4xx 或 5xx | 拒絕寫入 | 單元測試（200、503）＋ reviewer 探針（404） | 通過 |
| 服務收下請求但不回應 | 逾時後拒絕寫入 | 單元測試（逾時 300ms） | 通過 |
| 斷線不回應（`UND_ERR_SOCKET`）、TLS 錯誤、bad port、端點設錯 | 拒絕寫入（無法確認） | reviewer 探針 | 通過 |
| 連線被拒、解析不到主機 | 視為已停止 | 單元測試（`ECONNREFUSED`）＋步驟 6 端到端（`EAI_AGAIN`） | 通過；`ENOTFOUND`、`EAI_AGAIN` 沒有單元測試（NICE 2） |
| 原始端點回 3xx，轉址目標已關閉 | 依規格應拒絕 | reviewer 探針顯示會寫入 | 邊角案例（NICE 1） |
| 主機上沒有給 `--db` | 拒絕執行，不讀寫 `MEMORIA_HOME` | CLI 測試 | 通過 |
| 寫入後、重建索引前執行 `memoria prune --all` | 文件應提醒 | 文件只寫 `--stale-days` | 缺口（SHOULD 1） |

### 需求、架構、安全、品質

- `checkMemoriaStopped()` 不再沿用 `pingMemoriaEndpoint()`，聊天路徑的可達性觀測因此完全沒有被改動，邊界清楚。
- 用 `throw` 加上 `catch` 再拋回 `LegacyScopeMigrationError` 的寫法有點繞，但正確，也有測試。不算過度設計。
- `serviceCheck.detail` 讓輸出能說明判定依據，對操作人員有用。
- 增量裡沒有本機家目錄路徑、6 位以上的數字 ID、UUID 或長十六進位字串。證據只有錯誤碼與筆數。
- 常青文件：`CLAUDE.md`、`docs/installation.md`、實作計畫都已同步。
- 步驟 4 的證據保留舊版的輸出字串，並註明以步驟 6 為準。這是誠實的做法。

### 豁免、待確認與限制

- Gate 豁免（不開 PR、本機獨立審查）沿用 README 的紀錄。
- TBD-1（#19）、TBD-2 維持原狀，不影響交付。
- 限制：
  - reviewer 沒有重跑 Compose 端到端。步驟 6 的 `EAI_AGAIN` 結果，我是以主機上解析 `memoria` 同樣得到 `EAI_AGAIN` 間接佐證。
  - 檢查 1.28.1 時，我用 `docker run --rm --network none` 從映像讀取 `dist/cli.mjs`。沒有掛任何 volume，也沒有啟動任何服務。
  - 資料副本只為了統計 session 時間分布而短暫複製，查完已刪除。

## 你自己跑過的命令與結果

以下命令都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行，沒有用 git stash，沒有碰正式部署、`runtelenexus_*` volume 與 `~/.memoria`。

- `git diff -a 9ff4112 e4e30f9 | git patch-id --stable` → `399ea796b53497ccd08326b69aa7916e27dfb8b5`，一致。
- `npm run build` → exit 0。
- `npm run lint` → exit 0。
- `npm run test` → exit 0：`# tests 545`、`# pass 545`、`# fail 0`。共 71 個測試檔，`tests/docker/` 的 4 個檔案都有出現在輸出中。
- 三個異動的 TypeScript 檔通過 `npx prettier --check`。
- 在 `e4e30f9` worktree 換回 `e0585ce` 的服務與 CLI → 26 個中 5 個失敗，與證據一致。
- 突變檢查，每次都還原並確認與原檔相同：
  - 會轉紅：level-1、level-0 的 DELETE 拿掉 scope；拿掉 events 自我檢查；5xx 當成已停止；逾時當成已停止；任何錯誤都當成已停止。
  - 沒有轉紅：拿掉剩餘筆數的自我檢查；從集合拿掉 `EAI_AGAIN`；從集合拿掉 `ENOTFOUND`。
- `fetch` 錯誤形狀探針與服務檢查探針：結果見「已查核維度」第一張表與「相關失敗面」。
- `docker run --rm --network none --entrypoint sh ghcr.io/raybird/telenexus-memoria:v2.30.1 -c '…cat dist/cli.mjs'`：
  - 版本是 1.28.1。
  - `pruneStaleMemory()` 的條件與 1.30.0 相同。
  - `--all` 會套用 stale 180 天。
  - prune 只由 CLI 觸發。
- 在資料副本的暫存複本上統計：舊分區 2,301 筆，時間範圍是 2026-02-23 到 2026-08-14，其中 1,083 筆早於 180 天。查完即刪除。

## 流程判定

PASS

沒有 MUST FIX。上次的 SHOULD FIX 1～5 都已處理並有證據，SCN-001～SCN-013 都有有效證據。新的 SHOULD FIX 1 只需要改一行文件，建議在正式部署執行遷移前補上。
