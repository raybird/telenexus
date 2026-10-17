# Issue 0014 - opencode session 清理的 VACUUM 後 WAL 檔不縮小 (Small)

GitHub：[#14](https://github.com/raybird/telenexus/issues/14)

## 概述

[issue 0009](../issue-0009/README.md)（v2.30.0）的保留期清理在可回收頁數達兩成時以 `opencode db "VACUUM"` 回收空間。2026-10-18 03:31 正式環境第一次回收後，主檔變小，但 WAL 檔長到和主檔一樣大，合計占用反而增加：

| | 升級前（10-18 01:31） | 回收後（10-18 06:31） |
|---|---|---|
| `opencode.db` | 228,925,440 bytes | 172,724,224 bytes |
| `opencode.db-wal` | 4,923,432 bytes | 173,233,672 bytes |
| 合計 | 約 234 MB | 約 346 MB |

推定原因：WAL 模式下 `VACUUM` 會把整個新資料庫寫進 WAL；checkpoint 只把內容寫回主檔，不縮小 WAL 檔，而這份資料庫的 `journal_size_limit` 是 `-1`（不限制），所以 WAL 檔維持在最高水位。issue 0009 在複本上實測回收時只量了主檔（[step1 實測](../issue-0009/evidence/step1-delete-vacuum-probe.md)「空間回收」一節）。

目標：回收之後接著截斷 WAL，讓回收真的減少磁碟占用。截斷同樣經 `opencode db` 執行，維持 issue 0009「一律經 opencode 的 CLI 操作」的原則。正式環境現有的 173 MB WAL 不在本 issue 範圍（TBD-2）。

## 涉及檔案

- `src/services/opencode-session-retention.ts` - VACUUM 後截斷 WAL；截斷沒完成時記下待重試，之後的輪次只重試截斷
- `tests/opencode-session-retention-run.test.ts` - 截斷成功、未完成與重試的單元測試
- `docs/configuration-reference.md` - 「opencode session 保留期清理」的回收說明與 runtime issue 清單
- `docs/agents/landmines.md` - 新增 WAL 模式下 VACUUM 讓 WAL 長到整庫大小的地雷

## 驗收條件

1. **AC-1**：回收（`VACUUM`）成功後，同一輪接著以 `opencode db` 執行 `PRAGMA wal_checkpoint(TRUNCATE)`。截斷完成時，WAL 檔縮回 0 bytes，回收後 `opencode.db` 加 `opencode.db-wal` 的合計小於回收前；該輪 `run` log 記錄截斷已完成。 — 檢查方式：單元測試驗證回收成功後會呼叫截斷、截斷結果會出現在 log 摘要裡；另外在資料庫複本上，以 opencode 1.18.34 實際跑一次本版的回收路徑，記錄回收前、`VACUUM` 後、截斷後三個時間點的主檔與 WAL 大小。
   - 失敗路徑：截斷後 WAL 仍約等於主檔大小，或合計不小於回收前，就判定未通過。截斷命令的輸出無法解析時，視為截斷未完成，處理方式見 AC-2，不能當作成功。
2. **AC-2**：截斷沒完成（`wal_checkpoint` 回傳 `busy` 不為 0、命令失敗或逾時）時，記錄 runtime issue `opencode-retention:wal-truncate`，本輪的刪除結果不受影響。之後每一輪在沒有任務執行時重試截斷，直到成功一次為止，重試期間不再執行 `VACUUM`。待重試狀態只存在記憶體中，服務重啟後不保留。 — 檢查方式：單元測試讓假的截斷依序回傳 busy、拋錯、成功，確認每次失敗都記錄 runtime issue、下一輪只重試截斷不重跑 `VACUUM`、成功之後不再呼叫，忙碌時不重試；另外在複本上讓另一個連線持有讀取交易，記錄截斷回傳 busy 的實際輸出。
   - 失敗路徑：截斷沒完成卻被當成完成（之後不再重試），或因此重跑 `VACUUM`，或沒有記錄 runtime issue。

- **核准日期**: 2026-10-18
- **核准來源**: 使用者 2026-10-18 對話。「開 issue 處理1」，其中第 1 點是「在 `VACUUM` 之後接著執行 `PRAGMA wal_checkpoint(TRUNCATE)`……同樣用 `opencode db` 來執行，並補上把 WAL 大小算進去的實測」（對應 AC-1）。Q1「什麼時候截斷 WAL」選「只在 VACUUM 後截斷」，該選項的內容是「VACUUM 成功後才截斷，失敗就在記憶體記下來、下一輪重試（服務重啟後這個紀錄會消失）；正式環境現有的 173 MB 要另外手動處理」（對應 AC-2、TBD-2）。
- **核准 commit**: 待提交

## 風險與首要驗證

- **最大風險**：經 `opencode db` 執行的 `wal_checkpoint(TRUNCATE)` 不一定能把 WAL 縮回 0，例如 opencode 開連線的方式讓 TRUNCATE 沒有作用，或有其他連線一直持有讀取交易，使截斷永遠回傳 busy；另外 `opencode db` 對 PRAGMA 輸出的格式也還沒確認。任何一項不成立，AC-1 的修法方向就要改。
- **風險等級與理由**：Medium。這是一項重要的外部行為未知；失敗只會造成有限度的返工，checkpoint 本身不會刪改資料，不會造成資料損失。
- **首要驗證**：先在資料庫複本上，以正式環境同版的 opencode 重現「`VACUUM` 後 WAL 等於整庫大小」，再分別在沒有其他連線、以及有連線持有讀取交易時執行截斷，記錄輸出格式和 WAL 大小（步驟 1）。
- **選擇理由**：這是 opencode 這個外部 CLI 的契約驗證，最小的真實操作就能直接回答。單元測試只能驗證 TeleNexus 自己的流程，答不了 opencode 的行為。
- **完成證據**：步驟 1 的實測紀錄同時具備三項：`VACUUM` 後 WAL 約等於主檔大小（重現了問題）；截斷後 WAL 是 0 bytes，輸出的 `busy` 為 0；持有讀取交易時輸出的 `busy` 不為 0，且 WAL 沒有縮回 0。

## 待確認事項

| 編號 | 事項 | 狀態 | 影響 |
|------|------|------|------|
| TBD-1 | 正式環境的 WAL 從 03:31 回收後就一直是 173 MB。SQLite 通常在最後一個連線關閉時 checkpoint 並刪除 WAL，所以可能有常駐的連線一直開著資料庫，或 opencode 結束時沒有關閉連線。若是前者，截斷在正式環境可能一直回傳 busy。2026-10-18 想唯讀列出容器內開著 `opencode.db` 的行程，被權限檢查擋下，尚未確認。 | 待確認 | AC-1 在正式環境是否有效。步驟 1 在複本上觀察 opencode 行程結束後 WAL 是否被刪除；正式環境的確認方式由使用者決定。 |
| TBD-2 | 正式環境現有的 173 MB WAL | 不影響本次交付 | 結論（2026-10-18）：依 Q1 的選擇，本版的截斷只在下一次 `VACUUM` 後才執行，不會處理既有的 WAL。由使用者在修正版升級時決定是否手動執行一次截斷，結果記在本 README 的 Timeline。 |

## 實作與驗證步驟

1. 📝 **首要驗證：在複本上確認 opencode 的截斷行為（AC-1、AC-2 的前提）** — 從正式部署目錄的 `backups/opencode_auth-pre-v2.30.0-20261018.tgz`（10-18 升級前停機時打包）解出複本，放在 repo 外的暫存目錄。以 `ghcr.io/raybird/telenexus:v2.30.0`（opencode 1.18.34）的拋棄式容器操作：只掛複本，不帶 auth、不發佈 port。依序做三件事：刪除舊 session 直到可回收頁數達兩成後執行 `opencode db "VACUUM"`；執行 `opencode db --format json "PRAGMA wal_checkpoint(TRUNCATE)"`；在另一個連線持有讀取交易時再截斷一次。每個時間點都記錄主檔與 WAL 大小，另外觀察 opencode 行程結束後 WAL 是否被刪除（TBD-1）。
   - 產出：`evidence/step1-wal-truncate-probe.md` 與所用腳本。依[地雷 L-10](../../agents/landmines.md) 去敏，只記彙總數字，不記 session ID、內容或本機路徑。
   - 完成判準：「風險與首要驗證」的完成證據三項都有實測紀錄。截斷後 WAL 不是 0 時停止，回到規劃，修改 AC-1 的方向並重新取得核准。
2. 📝 **AC-1、AC-2：VACUUM 後截斷與重試** — 相依：步驟 1。`RetentionDeps` 新增截斷，依步驟 1 實測的輸出格式解析 `busy`；回收的狀態另外記錄是否有待重試的截斷；`run` log 摘要記錄截斷結果；失敗記錄 `opencode-retention:wal-truncate`。
   - 產出：上述程式與 `tests/opencode-session-retention-run.test.ts` 的測試。
   - 完成判準：依 [verification.md](../../agents/verification.md) 取得 AC-1、AC-2 的紅綠重構證據。單元測試以假 deps 涵蓋：回收成功後截斷、busy、拋錯、下一輪只重試截斷、成功後不再呼叫、忙碌時不重試、實際 deps 下的 `opencode db` 參數。
3. 📝 **AC-1：複本上的端到端回收** — 相依：步驟 2。用本版程式的實際 deps，對步驟 1 的同一份備份重新解出的複本跑回收路徑。
   - 產出：`evidence/step3-e2e-copy.md`。
   - 完成判準：記錄回收前、`VACUUM` 後、截斷後三個時間點的主檔與 WAL 大小，截斷後合計小於回收前，log 記錄截斷完成。
4. 📝 **常青文件與地雷** — 相依：步驟 2。`docs/configuration-reference.md` 的回收說明補上截斷與重試，runtime issue 清單加入 `opencode-retention:wal-truncate`，更新最後驗證日期；`docs/agents/landmines.md` 新增地雷，附步驟 1 的證據連結。
   - 完成判準：文件與實作的行為一致，連結指向存在的檔案。
5. 📝 **交付前驗證** — 相依：步驟 2～4。依 [project.md](../../agents/project.md) 依序執行 `npm run build`、`npm run test`（核對 `# tests` 與測試檔數相稱）、`npm run lint`。
   - 完成判準：三者 exit 0，輸出記在本步驟。

## Timeline

| 日期 | 異動 | 負責人 |
|------|------|--------|
| 2026-10-18 | 建立；開 GitHub #14；AC-1、AC-2 核准（Q1：只在 VACUUM 後截斷） | - |

---
**建立日期**: 2026-10-18  
**分級**: Small — 單一服務檔案的修正加測試與文件  
**風險**: Medium — `opencode db` 截斷 WAL 的實際行為與輸出格式尚未確認\
**狀態**: 待實作
