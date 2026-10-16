# 步驟 6：以實作後的映像對資料庫複本跑完整清理

- **日期**：2026-10-16
- **對應**：SCN-001、SCN-002、SCN-003（掛載）、SCN-004、SCN-006
- **授權**：使用者在 2026-10-16 同意這次的做法（建本機測試映像、啟動拋棄式 agent-runner、使用正式資料庫的複本）。
- **映像**：在分支 `feat/issue-0009-opencode-session-retention` 以 `docker build -t telenexus:issue-0009-e2e .` 建出（本機，未推送），內含 opencode 1.18.34 與 `dist/services/opencode-session-retention.js`。驗證後已刪除。
- **複本**：作法同步驟 1，在正式部署的 agent-runner 容器內以唯讀 `backup()` 取出，放在 repo 之外。正式部署沒有停止，也沒有改動；驗證後三個服務仍是 healthy。複本在驗證後刪除。
- **容器**：`docker run -d` 以測試映像執行 `node dist/runner.js`。只掛複本、一個暫存的 `data/` 與 repo 的 `ai-config.yaml`（唯讀），不發佈 port、不帶 Telegram token 或 auth。暫存 `data/` 只有一筆模擬的聊天綁定 `chat-session-state.json`，指向一個 135 天前更新、有 4 則訊息的頂層 session。容器在驗證後刪除。
- **紀錄範圍**：只記彙總數字。腳本在 [step6-scripts/](step6-scripts/)，每輪結果在 [step6-e2e-runs.jsonl](step6-e2e-runs.jsonl)。

## 掛載（SCN-003）

容器啟動後 8 秒內的 log 有 `[opencode-retention] INFO scheduled retentionDays=30 intervalMs=3600000`，接著是 `[Runner] INFO listening port=8787`。沒有設定任何保留期環境變數，所以這是預設值。容器存活的約 40 分鐘內，runner 自己的計時器（1 小時）沒有到期，下面的清理都是由腳本觸發的。「啟動時不立刻清理、每個間隔執行一次」由步驟 3 的單元測試承擔。

## 完整清理（SCN-001、SCN-002）

腳本 [e2e-loop.mjs](step6-scripts/e2e-loop.mjs) 在同一個容器內以 uid 1000 執行。它直接匯入編譯後的 `runRetentionOnce`、`createOpencodeRetentionDeps` 與 `loadRetentionConfig`，使用真實的 opencode CLI，每輪 100 個，直到沒有候選為止。

| 項目 | 清理前 | 清理後 |
| --- | --- | --- |
| session（含子 session） | 3,756 | 1,390 |
| 頂層 session | 3,714 | 1,387 |
| 早於 30 天且未綁定的頂層 session | 2,326 | 0 |
| 綁定的 session | 存在，4 則訊息 | 存在，4 則訊息 |
| 檔案大小 | 221,052,928 bytes（53,968 頁，freelist 0） | 164,425,728 bytes（40,143 頁，freelist 17,457） |

- 共 25 輪，刪除 2,327 個，失敗 0，沒有任何一輪被跳過，總耗時 30.2 分鐘。第 1～24 輪每輪 100 個，最後一輪候選 0、耗時 670 ms。
- 刪除數比清理前的計數多 1 個：清理期間有一個 session 跨過了 30 天門檻。清理後剩下的未綁定頂層 session 裡，最舊的是 30.0 天。
- 清理後在同一個容器執行 `opencode run -s <綁定 id> -m opencode/big-pickle --format json "Reply with exactly: OK"`：exit 0，所有事件的 `sessionID` 都是綁定的 session，訊息從 4 則增加到 7 則，全庫 session 數仍是 1,390，沒有新增。
- 反向自檢：如果綁定的 session 被刪，接續會 exit 1 並回 `Session not found`（步驟 1 的對照組）；如果清理沒有生效，「早於 30 天且未綁定」不會是 0。兩者都和實際觀察不同。

## 空間回收（SCN-006）

- 第 1、2 輪是 `below-threshold`。第 3 輪 freelist 超過兩成，觸發 `reclaimed`。第 4～25 輪是 `recently-reclaimed`，一天最多一次的限制生效。
- 回收前的 221.1 MB 降到清理結束時的 164.4 MB。之後刪除空出的 17,457 頁（約 68 MB）留在 freelist 給新資料重複使用，檔案不會再長；隔天的回收會再把檔案縮小。
- 本次腳本把「沒有任務」固定為 true。有任務時不回收的判斷由步驟 5 的單元測試承擔。

## 探針 session（SCN-004）

腳本 [probe-e2e.mjs](step6-scripts/probe-e2e.mjs) 在同一個容器呼叫編譯後的 `defaultProbe('opencode/big-pickle', 120000)`，探針執行期間每 200 ms 掃一次新建立的 session。結果 `{"ok":true}`：探針執行中出現 1 個新 session，探針結束後剩 0 個。

另外，容器啟動時 runner 自己跑的那次探針，用的是 repo `ai-config.yaml` 的模型；容器裡沒有 auth，所以結果是 `model-invalid`。之後沒有留下新 session，也沒有 `probe-session-delete` 的 runtime issue。但這次分不出 session 是「建立後被刪」還是「根本沒建立」，所以只以上面那次有掃描的探針為證據。
