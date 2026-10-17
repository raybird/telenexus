# 地雷紀錄

這裡收的是在本 repo 實際出過事或差點出事、之後的 issue 可能重踩的坑。收錄門檻、條目格式與編號規則依 [document-types.md 的「地雷紀錄」](document-types.md#地雷紀錄)；每個 issue 都要遵守的規則寫在 [project.md 的「本地 gate 與案例」](project.md#本地-gate-與案例)。

程式與設定的事實以連結指向原位置，各條目只寫它為什麼容易被踩到。

## L-01 測試指令少跑了檔案，輸出仍是 `# fail 0`

- **症狀**：`npm run test` 綠燈，但 `# tests` 遠少於實際測試數。v2.22.2 之前只跑到 38 個測試檔中的 4 個。
- **觸發**：修改 `package.json` 的 test script、調整 `tests/` 目錄層級，或用 shell glob 傳測試路徑。bash 預設不開 `globstar`，沒加引號的 `**` 會退化成 `*`。
- **怎麼查**：比對輸出的 `# tests` 與 `find tests -name '*.test.ts' | wc -l` 是否相稱（gate 見 project.md「驗證」）。
- **證據**：`50a7a8e`（2026-08-13，glob 加上引號，隨 v2.22.2 發佈）。

## L-02 上游拒絕請求，所有觀測面卻都顯示正常

- **症狀**：容器 healthy、模型健康檢查 healthy、runner success rate 100%、`error-summary.md` 全是 0，但聊天與排程都沒有有效輸出。`events.jsonl` 裡的 `durationMs`、`outputLen`、`responseLength` 每次都幾乎相同。
- **觸發**：修改上游錯誤判定、降級結果（timeout、429、upstream-error）的處理或 opencode 輸出解析，或以列舉狀態碼判斷錯誤。降級結果會轉成友善文字後正常 resolve，呼叫端看起來和成功一樣。
- **怎麼查**：先看 `events.jsonl` 那三個欄位是否固定不變。以唯讀方式查 `opencode.db` 的 `message.data.error`（方法見 issue 0008 的 [implementation-plan.md](../issues/issue-0008/implementation-plan.md)）。用 `npm run models:probe` 至少跑 2 輪。判定規則見 `CLAUDE.md` 的「Upstream error events」與「Degraded results」。
- **證據**：2026-09-08 模型下架回 410（`3f87400`）。2026-09-17 起免費層回 426，到 2026-10-01 累積 545 個失敗回合無人察覺（[issue 0008](../issues/issue-0008/README.md)）。

## L-03 升級 opencode 釘版後，判定悄悄失靈

- **症狀**：升版後 429 快速中止不再觸發，回合一路退避到逾時；或依 exit code 的判斷結果翻轉。
- **觸發**：修改 `Dockerfile` 的 `opencode-ai` 釘版。事件 schema 在 1.15.10 到 1.18.34 之間沒變，但上游錯誤時的 exit code（0 變 1）與 `--print-logs` 的格式（改成 logfmt、不再有狀態碼）都變了。
- **怎麼查**：依 [step1-compat-probe.md](../issues/issue-0008/evidence/step1-compat-probe.md) 的方法，用新版本重新取得 `tests/fixtures/opencode/` 的樣本再跑測試。維護方式見 `CLAUDE.md` 的「opencode pin」。
- **證據**：[issue 0008 的相容性探測](../issues/issue-0008/evidence/step1-compat-probe.md)。

## L-04 錯誤樣式誤判一般文字

- **症狀**：正常的回合被中止，或被判為模型下架。
- **觸發**：修改 `src/core/rate-limit.ts` 的樣式，或 `scripts/probe-models.mjs` 裡的同一份副本。舊版 opencode 的 `--print-logs` 會帶出整個請求內容，市場資料或模型回覆中的字詞都可能被比對到。
- **怎麼查**：樣式只比對結構化欄位（如 `"statusCode":429`）或指定 log 欄位內的文字；測試要放進含有同樣字詞的正常輸出作為對照。
- **證據**：`d8bc923`（2026-09-08，v2.27.2 加入的裸 `\bGone\b` 誤判「the opportunity is gone」，v2.27.3 移除）。

## L-05 串流測試用同步回呼，測不到漏行

- **症狀**：測試綠燈，但正式環境的 Telegram 串流回合漏掉同一批 stdout 的後幾行，連 error 事件一起漏掉，結果回合被記為成功。
- **觸發**：修改 `src/core/cli-agent-base.ts` 的 stdout 處理或 `close` 判定，或撰寫串流相關測試。正式環境的回呼（編輯 Telegram 訊息）是慢的 async，同步回呼重現不了這個時序。
- **怎麼查**：測試裡的 `onEvent` 改用 async 且有延遲的回呼。
- **證據**：issue 0008 第一輪審查的 MUST FIX（[review-48944eb.md](../issues/issue-0008/review-48944eb.md)），修正見 `ab110b2`、`7adf1a7`。

## L-06 `opencode run -c` 接到別人的 session

- **症狀**：聊天回覆接續了排程、摘要或健康探針的內容。
- **觸發**：新增 opencode 呼叫點，或修改 session 相關參數。`-c` 接的是「最後被更新的 session」，而排程、摘要、探針與 runner 的兩條 lane 都會更新 session。
- **怎麼查**：每個呼叫點明確選擇 `-s <id>` 或開新 session；聊天的綁定見 `src/services/chat-session-store.ts`。
- **證據**：[issue 0012](../issues/issue-0012/README.md)（正式環境 `opencode.db` 的現況見其 implementation-plan.md 的「現況」），最早記錄於 issue 0008 的 TBD-4。

## L-07 工作結束後，瀏覽器與子孫程序仍然存活

- **症狀**：工作完成或逾時後，Chrome 程序樹仍然常駐，runner 記憶體回不到基準值。
- **觸發**：修改 `src/core/process-runner.ts`、opencode 子程序生命週期、瀏覽器 MCP launcher 或排程逾時。只終止直接 child 不會帶走它的子孫程序；`process.kill(-pid)` 的前提見 `process-runner.ts` 檔頭的註解。
- **怎麼查**：在容器內用 `/proc` 數 Chrome 程序與 zombie。`docker stats` 的 PIDs 是包含 thread 的 cgroup task 數，不等於程序數。
- **證據**：[2026-08-16 runtime handover](../2026-08-16-runtime-resource-handover.md)。修正見 `02b46c5`（以 process group 終止、排程逾時會取消底層工作）與 [issue 0010](../issues/issue-0010/README.md)。

## L-08 容器改用非 root 後，舊檔案的擁有權導致寫入失敗

- **症狀**：context 快照寫入時出現 `EACCES`，狀態頁停止更新；或 `opencode.db` 變成唯讀，`opencode run` 以 exit 1 結束，Bot 不回話。
- **觸發**：修改容器的執行身分或 named volume 的掛載，或升級曾以 root 寫過資料的舊部署。Docker 重建時不會重設非空 named volume 的擁有者。
- **怎麼查**：在主機上執行 `find workspace data -uid 0`；volume 則執行 `docker run --rm -v <volume>:/v node:22-slim sh -c 'find /v -uid 0 | wc -l'`。結果為 0 才算健康。修復方式見 [installation.md](../installation.md) 的疑難排解。
- **證據**：v2.18.0 改以非 root 執行（`be4530d`，2026-05-31），2026-06-01 重建後發生；v2.21.0 改由 entrypoint 依 `PUID`/`PGID` 對齊（`CHANGELOG.md` 2.21.0 的「Runtime UID 對齊」）。

## L-09 issue 文件與實際交付狀態不一致

- **症狀**：PR 已合併並發版，issue README 的 `**狀態**` 與 `docs/README.md` 索引卻還停在合併前；反過來，GitHub issue 已關閉，程式卻沒有實作。
- **觸發**：PR 在 GitHub 上 squash 合併。結案紀錄要在合併後到 main 補上，這一步不在 PR 裡。在 GitHub 上手動關閉 issue 也屬於此類。
- **怎麼查**：用 `gh pr list --repo raybird/telenexus --state merged` 與 `gh issue list --repo raybird/telenexus --state all` 對照各 issue README 的狀態，或用 dev-cycle 的懸置掃描。
- **證據**：PR #11 於 2026-10-05 合併（`718cc8b`），[issue 0010](../issues/issue-0010/README.md) 的狀態到 2026-10-16 才補上；對照組是 issue 0012 合併後的結案提交 `69efa39`。GitHub #9 在 2026-10-04 以 completed 關閉，但 [issue 0009](../issues/issue-0009/README.md) 仍是待實作，repo 裡也沒有對應的實作提交；2026-10-16 重新開啟。

## L-10 證據檔把本機資訊帶進公開 repo

- **症狀**：審查以「證據檔含本機絕對路徑（含 OS 帳號名）」退回，必須改寫還沒推送的提交。
- **觸發**：提交 `docs/issues/*/evidence/` 的命令輸出。node 測試失敗的 stack trace 會帶出本機路徑，telenexus 的 log 會印出 Telegram 使用者 ID。
- **怎麼查**：提交前搜尋本機家目錄路徑、Telegram 使用者 ID、bot token 與完整容器 ID，並遮蔽命中的內容。
- **證據**：issue 0007 第一輪審查的 M1（[review-60f845f.md](../issues/issue-0007/review-60f845f.md)）。

## L-11 opencode 的輸出經 pipe 被截斷，exit 仍是 0

- **症狀**：`opencode session list --format json` 或 `opencode db --format json` 的輸出不完整，JSON 解析失敗或只拿到前段；指令本身 exit 0、stderr 沒有任何訊息。
- **觸發**：用程式（`spawn`、`runProcess`）或 shell pipe 讀取 opencode 超過約 64 KB 的輸出。重導到檔案時是完整的。
- **怎麼查**：比對同一個指令重導到檔案與經 pipe 的位元組數。程式解析時以「能完整解析」為前提，解析失敗就當作失敗，不使用部分結果；查詢加上 `LIMIT`，讓輸出保持在小範圍內。
- **證據**：[issue 0009 步驟 1 實測](../issues/issue-0009/evidence/step1-delete-vacuum-probe.md)的「`session list` 與 `opencode db` 的輸出」一節：3,710 筆經 pipe 只拿到 196,608 bytes，重導到檔案是 808,437 bytes。

## L-12 `opencode run` 在 stdin 沒關時一直等待

- **症狀**：`opencode run` 沒有任何輸出，也沒有建立 session，看起來像卡住或被資料庫鎖住。
- **觸發**：在背景子殼、或以 stdin 為 pipe 的方式啟動 `opencode run`。它會讀 stdin，stdin 一直不關就一直等。`runProcess()` 沒給 `stdin` 時是 `ignore`，不受影響；自行 `spawn` 或在 shell 腳本裡呼叫時要注意。
- **怎麼查**：加上 `</dev/null`（shell）或 `stdio: ['ignore', ...]`（node）後重跑，10 秒內就會開始輸出。
- **證據**：[issue 0009 步驟 1 實測](../issues/issue-0009/evidence/step1-delete-vacuum-probe.md)的「有任務執行時刪除」一節：第一次嘗試 5 分鐘沒有輸出，改成 `</dev/null` 後正常。

## L-13 WAL 模式下 `VACUUM` 之後，WAL 檔長到和整個資料庫一樣大

- **症狀**：`VACUUM` 之後主檔變小，但 `-wal` 檔變得和主檔差不多大，合計占用反而比回收前多；之後 opencode 執行多少次，WAL 都不會縮小。
- **觸發**：對 WAL 模式的 SQLite（`opencode.db` 就是）執行 `VACUUM`。整個新資料庫會先寫進 WAL；checkpoint 只把內容寫回主檔，不縮小檔案，`journal_size_limit` 又是 `-1`；opencode 結束時也不會刪除 WAL。只量主檔大小時看不出來。
- **怎麼查**：主檔與 `-wal` 檔一起量。要縮小 WAL，執行 `PRAGMA wal_checkpoint(TRUNCATE)`，並看輸出的 `busy`：有其他連線在讀取時 `busy` 是 1，WAL 不會縮小，但 `opencode db` 的 exit 仍是 0。
- **證據**：[issue 0014 步驟 1 實測](../issues/issue-0014/evidence/step1-wal-truncate-probe.md)：`VACUUM` 後主檔 172,851,200 bytes、WAL 173,864,032 bytes，截斷後 WAL 為 0；正式環境 2026-10-18 第一次回收後 WAL 從 5 MB 長到 173 MB。

---

**最後驗證**: 2026-10-18（新增 L-13）
