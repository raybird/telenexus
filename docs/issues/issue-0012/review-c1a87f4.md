# 審查報告
- 範圍：完整 PR（`main..feat/issue-0012-chat-session-binding`，依 README「Gate 豁免紀錄」不開 PR、以本機獨立審查代替）。[review-abd28e3.md](./review-abd28e3.md) 判 PASS 後，使用者要求把該次的 SHOULD FIX 一併修完，本報告是修完後的重審
- Reviewed BASE SHA：7a485a561de6015bf38c2774427ffd59db25ce36
- Reviewed HEAD SHA：c1a87f427fb478b9ba029c32e67a27511ae75563
- Reviewed patch-id：87e2fad46bb9ea17b0b781e59bc89f21dfb7ee70（2026-10-07 以 `git diff 7a485a5 c1a87f4 | git patch-id --stable` 重算，一致）
- 獨立 reviewer：Claude（Opus 5.5）獨立 subagent，未參與本 issue 的實作
- Review artifact：docs/issues/issue-0012/review-c1a87f4.md

審查日期 2026-10-07。開審前確認 `git rev-parse HEAD` = c1a87f427fb478b9ba029c32e67a27511ae75563，工作區乾淨。abd28e3 之後只有兩筆提交：

- `b8fb305`：只新增 `review-abd28e3.md`
- `c1a87f4`：修正，程式只動 `src/web/server.ts` 兩處，另新增一個測試檔與步驟 10 的文件及證據

`git diff abd28e3 c1a87f4 -- src` 只有 `src/web/server.ts`。其他程式與 abd28e3 相同，abd28e3 審查對它們的結論沿用。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

無。abd28e3 審查的 SHOULD FIX 1 已修正，見下文。

### NICE TO HAVE

1. **測試裡的原因清單是寫死的**（`tests/web-prompt-reason-label.test.ts` 第二個測試）。以後 pipeline 再新增原因時，這個測試不會自動發現，仍要靠人工找齊所有分支。這是證據持久力的問題，不是假綠燈：這次清單與 src 實際產生的值完全相等（見下文）。可考慮改成讀 `src/core/message-pipeline*.ts`，抽出 `promptSelectionReason` 的字面值來比對，或把原因集中成一個型別或常數。
2. `humanizePromptReason()` 裡的 `message-failed-before-response` 在 src 中已經沒有地方會產生，是既有的殘留，與本 issue 無關，可以留著。
3. abd28e3 審查的 NICE 1～6 維持原狀，都不阻擋交付。其中 NICE 4（passthrough 遇到 session-missing 會在空 session 上重跑）已記為已知限制。

## 已查核維度

### 驗收與證據

- **核准**：從 856c486 到 c1a87f4，README 中沒有任何 Scenario 或 Given／When／Then 的變動。這次只新增一筆 Timeline，記錄 abd28e3 PASS 後使用者要求修完 SHOULD FIX。SCN-001～008 仍是已核准，TBD-1～6 都是已解決。
- **SCN-001～008**：證據與結論同 abd28e3 審查，這次的修正沒有觸及相關程式。
- **步驟 10（SCN-006 的可觀察面：Web Console 的原因顯示）**：
  - 紅燈 `evidence/step10-red.txt`：`new-session` 原樣露出，2 項失敗，都落在目標行為上。
  - 綠燈 `evidence/step10-green.txt`：2/2 通過，完整測試 439/439。
  - 重構 no-op 已記錄。

### 修正與測試是否正確

- **修正**：`src/web/server.ts` 的 `humanizePromptReason()` 新增 `case 'new-session': return '開新 Session';`，措辭與既有的「強制新 Session」一致。
- **原因清單是否涵蓋 src 的所有值**：我 grep 整個 `src`，`promptSelectionReason` 的字面值只有下列 7 個，與測試清單完全相等，沒有多也沒有少：

  | 原因 | 產生位置 |
  |---|---|
  | `passthrough-command`、`not-built-yet` | `src/core/message-pipeline.ts:198`（另有 `message-pipeline-chat.ts:149` 也產生 `passthrough-command`） |
  | `force-new-session`、`new-session`、`periodic-full`、`minimal-followup`、`compact-followup` | `src/core/message-pipeline-chat.ts:194-202` |

  `src/services/prompt-session-telemetry.ts` 只轉存這個值，不產生新的原因。全專案只有 `server.ts` 這一處把原因列舉成顯示文字，與實作者的說法相符。
- **抽函式的方式會不會靜默通過**：測試以字面標記 `function humanizePromptReason(reason) {` 定位，用大括號計數抽出整個函式，再以 `new Function` 實際執行。我在 scratch 複本做了兩個突變：

  | 突變 | 結果 |
  |---|---|
  | 刪掉新增的 case | 2 項都失敗 |
  | 把函式改寫成 arrow function，標記因此找不到 | 2 項都失敗：`assert.ok(start >= 0)` 擋下，`loadHumanizePromptReason()` 沒有抽到函式就不會往下跑 |

  兩個突變都會大聲失敗，不會靜默通過。函式內容沒有含大括號的字串，計數不會被干擾。被執行的是頁面輸出的真實程式碼，不是另一份複本，所以不是同義反覆。突變是在 `git archive c1a87f4` 的 scratch 複本上做的，repo 沒有被改動。
- **匯出 `getWebAppHtml` 的副作用**：這是一個純函式，只讀 options 的兩個門檻值並回傳 HTML 字串，沒有 I/O，也不啟動任何東西。`server.ts` 的模組頂層原本就只有宣告；`tests/web-status.test.ts`、`tests/web-streaming.test.ts` 早就 import 這個模組。所以多一個 export 只是擴大 API 表面，行為沒有變。

### 相關失敗面

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| Web Console 顯示 `new-session` | 顯示中文文字 | 新增的兩個測試、突變 | 通過 |
| pipeline 產生的其他 6 個原因 | 都有顯示文字 | 新增的第二個測試 | 通過 |
| 以後新增未列入的原因 | 會被發現 | 清單寫死，不會自動發現 | NICE 1（持久力） |
| `humanizePromptReason` 被改寫格式 | 測試失敗，不能靜默通過 | 突變驗證 | 通過 |
| 其餘失敗面 | — | abd28e3 審查已查核，這次沒有觸及 | 沿用上次「通過」的判定 |

### 需求、架構、安全、品質（含跨 Task 重複與過度設計）

- **範圍**：修正只動到顯示文字與一個 export，沒有過度設計。
- **常青文件**：`docs/web-console-reference.md` 沒有列舉 prompt 選擇原因，不需要更新。
- **安全**：c1a87f4 新增的內容中沒有 token、本機絕對路徑或使用者 ID。正式 Memoria 資料中那筆疑似 PAT 不在本次範圍，仍建議使用者另行撤銷。
- **前一版的判定**：abd28e3 審查的所有結論仍然成立，因為這次除了 `server.ts` 兩處之外，程式沒有任何變動。

### 驗證（reviewer 於 2026-10-07 在 HEAD c1a87f4 自行執行）

- `npm run build` → exit 0
- `npm run lint` → exit 0
- `npm run test` → exit 0，`# tests 439`、`# pass 439`、`# fail 0`。`tests/` 下有 66 個 `*.test.ts`：上次的 65 個加上新增的 `web-prompt-reason-label.test.ts`。測試數 437 加新增的 2 個，正好 439，相符。
- 跑完 `git status --short` 為空，只會多出本報告。

### 豁免、待確認與限制

- Gate 豁免：同前，只豁免「不開 PR，改由本機獨立審查」。
- 待確認事項：TBD-1～6 都是已解決，沒有新增的 `需決策` 項目。
- 已揭露的限制同 abd28e3 審查。
- 本報告尚未提交。協調者如果新增只含本報告的提交，請依 `docs/agents/review-evidence.md`「本機 artifact 提交後的有效性」驗證。

## 流程判定
PASS

理由：沒有 MUST FIX，也沒有 SHOULD FIX；上次的 SHOULD FIX 已修正，有紅綠證據與突變複核。SCN-001～008 與重要失敗面都有證據。報告已存檔，審查由非實作者的獨立 reviewer 完成。
