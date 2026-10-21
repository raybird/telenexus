# 步驟 3：實作與測試

- **日期**：2026-10-21
- **對應**：AC-3

## 改動

- 新增 `src/core/memoria-recall-query.ts`：
  - `stripFunctionWords()`：拿掉疑問詞與虛詞，換成空白。多字詞清單與單字清單與 [scripts/function-words.mjs](scripts/function-words.mjs) 第二版相同，套用順序也相同。
  - `tokenizeQuery()`：複製自 Memoria 1.28.1。
  - `countMatchedContentTokens()`：算問句裡不是純數字、而且出現在 snippet 裡的 token 數。
  - `MIN_MATCHED_TOKENS = 2`。
- `MemoriaRecallClient.recallWithMeta()`（`src/core/memoria-recall.ts`）：
  - 送出 `stripFunctionWords(query)`；結果是空字串時改送原句。
  - 丟棄條件從 `confidence < 門檻` 改為以下全部成立時丟棄：
    - 有 hit；
    - `confidence` 不是 null；
    - 門檻大於 0；
    - `confidence < 門檻`，或第一筆 snippet 的內容 token 少於 2 個。
  - 內容 token 用拿掉虛詞後的問句計算，所以整句都是功能詞時是 0 個，一定丟棄。
  - 丟棄時的處理和以前一樣：
    - `memoria_recall` 事件記 `dropped_low_confidence: true`，另外加上 `matched_tokens` 與 `min_matched_tokens`；
    - trace 記 `droppedLowConfidence=true`、`injected=false`，#20 的 `memoria_recall_events` 也照這兩個值寫入；
    - 回傳空結果、不帶 `recallId`，所以不回報 UFL outcome。
- 影響範圍：
  - GitNexus `impact(recallWithMeta, upstream)` 回報 LOW，只列出 1 個測試檔。
  - 用 `grep` 補查到正式環境唯一的呼叫點 `src/main.ts:234`（`buildPromptFn`）；GitNexus 又一次漏報。
  - 呼叫點拿到的介面沒有改變。

## 測試

新增 `tests/memoria-recall-criteria.test.ts`，共 14 個測試，使用假的 Memoria 回應：

- 單元測試：
  - 改寫後不會把前後的字接成新的窗格；
  - 切 token 的方式和 Memoria 相同；
  - 數字不計入命中。
- 擋下的情況：
  - 只命中 1 個內容 token；
  - 命中的只有數字（snippet 裡有兩個數字）；
  - 第二個命中是虛詞拼成的窗格（只有用原句計算時才會湊滿 2 個）；
  - 整句都是疑問詞（改送原句，但不注入）；
  - 命中 2 個以上，但 confidence 低於門檻。
- 放行的情況：
  - 命中 3 個內容 token；
  - confidence 是 `null`；
  - 門檻設為 0。
- 送出的問句是改寫後的。
- 被擋下時，事件、trace 與 #20 的資料表都記為丟棄、未注入，也沒有 `recallId`。

既有測試的修改：`tests/memoria-recall-threshold.test.ts` 原本以「問題」查詢，和 snippet 沒有共用任何內容詞，新判準一律擋下。依 AC-3「依文件更新的意義修改」，改成與 snippet 共用 4 個內容 token 的問句，讓這組測試只檢查 confidence 門檻。門檻的 8 個案例與期望值都沒有改。

### 紅燈與綠燈

| 階段 | 結果 |
|---|---|
| 只有測試 | 匯入的模組不存在，整個檔案失敗 |
| 只有 `memoria-recall-query.ts`，client 未改 | 13 個測試中 6 個失敗，全是新行為：送出改寫後的問句、只命中 1 個、只命中數字、整句疑問詞、事件與 trace、#20 指標。另外 7 個通過，其中 3 個是既有行為：null、門檻 0、低於門檻。這時還沒加後面補的 2 個案例。 |
| client 改完 | 相關的 4 個測試檔共 56 個測試，門檻測試有 4 個失敗，原因都是上述的「問題」查詢 |
| 門檻測試改用共用內容詞的問句 | 56/56 通過 |

### 突變

每次只改一處，跑完就以備份還原，並用 `diff` 確認與原檔相同。

| 突變 | 轉紅的測試 |
|---|---|
| M1：`MIN_MATCHED_TOKENS` 改成 1 | 只命中 1 個內容 token；事件與 trace；#20 指標 |
| M2：數字也算命中 | 數字不計入命中（單元）；命中的只有數字 |
| M3：送出原句 | 送出改寫後的問句 |
| M4：拿掉「門檻大於 0」 | 門檻設為 0 時停用整個判準 |
| M5：不拿掉單字虛詞 | stripFunctionWords |
| M6：事件不帶 `matched_tokens` | 事件與 trace |
| M7：用原句計算內容 token | 第二個命中是虛詞拼成的窗格 |

M2 第一次只有單元測試轉紅：整合測試「命中的只有數字」的 snippet 只含一個數字，不管數字算不算命中都會被擋下。M7 第一次沒有任何測試轉紅。補上兩個數字的 snippet 和「第二個命中是虛詞拼成的窗格」之後重跑，兩個突變都轉紅。

### 交付檢查

- `npm run build`：通過。
- `npm run lint`：通過。
- `npm test`：`# tests 591`、`# pass 591`、`# fail 0`。#20 結束時是 577 個，加上這次新增的 14 個。prettier 格式化之後又重跑一次，結果相同。
- `prettier --check`：
  - 新的程式與測試檔已依 prettier 格式化。
  - `CLAUDE.md` 通過。
  - `docs/configuration-reference.md` 在 main 上本來就沒通過，這次沒有處理。

### 命令與 exit code

（審查 review-fe4504b 指出原本的紀錄沒有命令，以下是審查後續重跑的結果。）

```bash
export TMPDIR=$HOME/.cache/memoria-release-tmp
env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/memoria-recall-criteria.test.ts tests/memoria-recall-threshold.test.ts
# → # tests 27、# pass 27、# fail 0
npm run build              # exit 0
npm run lint               # exit 0
env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm test   # exit 0；# tests 594、# pass 594、# fail 0
```

突變的做法：
- 每次以 `python3` 對單一字串取代一次，取代前先確認那段字串只出現一次；
- 跑上面那兩個測試檔；
- 從 scratchpad 的備份複製回來；
- 最後以 `diff -q` 確認與備份相同。
