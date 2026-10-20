# 步驟 4：審查後續（AC-2 規格修訂與 SHOULD FIX）

- **日期**：2026-10-20
- **對應**：AC-1、AC-2、AC-4；[review-4451564.md](../review-4451564.md) 的 SHOULD FIX 1、2 與 NICE TO HAVE 1、3、6、7
- **環境**：分支 `fix/issue-0017-memory-health-source`，基準 `c08cf64`（被審查提交 `4451564` 加上審查報告），工作區未提交；Node.js v22.20.0、tsx v4.21.0。

## SHOULD FIX 1：遠端模式＋沒有 checkpoint

使用者決定維持 `skipped`，AC-2 的文字依此修訂（見 README「規格修訂」）。實作行為在 `4451564` 就已經是這樣，所以新測試鎖定的是既有行為，寫好就是綠燈，不適用紅燈。為了確認它擋得住回歸，做了一次突變：暫時把 `checkpointSessionCheck` 改成不論有沒有 checkpoint 都跟著封存狀態走，也就是 AC-2 修訂前的字面解讀。

| 狀態 | 命令 | 結果 |
|---|---|---|
| 突變後 | `npx tsx --test tests/memory-health.test.ts` | `# pass 9`、`# fail 2`：新測試「AC-2／AC-4：遠端模式且沒有 checkpoint」與既有的 AC-4 測試失敗 |
| 還原後 | 同上 | 全部通過；`git diff --stat src/services/memory-health.ts` 為空，與被審查版本相同 |

## SHOULD FIX 2：影響分析的紀錄

補在 [step1-red-green.md](step1-red-green.md)「0. 改動前的影響分析」。

## NICE TO HAVE

| 項目 | 處理 |
|---|---|
| 1 `withHealthEnv` 沒清 `MEMORIA_ARCHIVE_DB` | 已處理：helper 先刪除再還原這個變數 |
| 2 來源判定的 env 優先順序與 `paths.ts` 重複 | 不處理：要讓 `paths.ts` 一併回傳設定來源，會改到 `resolveMemoriaSessionsDbPath()` 的介面，它還有 backfill worker 等其他呼叫者，超出本 issue 範圍 |
| 3 三層巢狀三元式、`existsSync` 呼叫兩次 | 已處理：兩項 checkpoint 檢查改由 `checkCheckpointField()` 判定；`exists` 併入 `readArchive()` 的回傳值 |
| 4 timestamp 全是 NULL 時「超前」標 `checked` | 不處理：Memoria 的 `sessions.timestamp` 是 `NOT NULL`，實務上碰不到，且行為與舊版相同 |
| 5 `memory.db` 損壞時仍會 throw | 不在範圍：記為 README 的 TBD-2，待使用者決定是否另開 issue |
| 6 AC-1 第二個測試斷言不足 | 已處理：補上 `exists`、`sessions24h`、`lastSessionAt` 與 markdown 的斷言，並對 `MEMORIA_ARCHIVE_DB` 與 `MEMORIA_HOME` 各跑一次 |
| 7 README 頁尾狀態 | 已處理 |

## 重構的等價證據

NICE TO HAVE 3 是純重構，以同一組測試與 probe 確認行為不變：

- `npx tsx --test tests/memory-health.test.ts`：`# tests 11`、`# pass 11`、`# fail 0`；`npx tsc --noEmit -p .` 無輸出。
- [step1-scripts/old-vs-new-probe.mts](step1-scripts/old-vs-new-probe.mts) 在重構後的輸出與 [step1-red-green.md](step1-red-green.md)「最小實作後全綠」的兩行 `diff` 完全相同。

## 交付檢查

- `npm run build`：exit 0
- `npm run test`：exit 0，`# tests 499`、`# pass 499`、`# fail 0`。比步驟 3 的 497 多 2 個：AC-1「設定的路徑不存在」拆成 `MEMORIA_ARCHIVE_DB` 與 `MEMORIA_HOME` 兩個，加上新的「遠端模式且沒有 checkpoint」。`tests/` 下 70 個測試檔，`tests/docker/` 的測試有出現在輸出中（地雷 L-01）。
- `npm run lint`：exit 0
