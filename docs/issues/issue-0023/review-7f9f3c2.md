- Reviewed BASE SHA：82fa6ad2d7c97bf2fc15c7eb39d25434319d8278
- Reviewed HEAD SHA：7f9f3c20d0b71df4e1d0bb5d60fd64837f4af064
- Reviewed patch-id：4f253039b0ccc695409df1d3b5489b342d2f4002

# Issue 0023 審查報告：review-7f9f3c2

- 審查日期：2026-10-28
- 範圍：`main`（82fa6ad）..`fix/opencode-quota-failfast`（7f9f3c2）完整分支，8 個提交、23 個檔案、+1173／−37。`git diff 82fa6ad..7f9f3c2 | git patch-id --stable` 重算結果與上列相同。重點是上一輪報告 [review-3246b66.md](review-3246b66.md) 之後的兩個提交：
  - 0834698：只新增 `docs/issues/issue-0023/review-3246b66.md`（`git diff --name-status` 為 A，沒有其他變更）；
  - 7f9f3c2：修 S1、N1、N5，改動 `src/core/opencode.ts`、`scripts/probe-models.mjs`、兩個測試檔、README，並新增 `evidence/review-fixes-3246b66.md`。
  
  3246b66 以前的提交沿用上一輪的結論，我只重新查核和本次修正相關的部分，以及上一輪可能漏看的地方。工作區 staged 的 `CHANGELOG.md` 與本 issue 無關，不在範圍內，沒有動它。
- 獨立 reviewer：Claude Code 隔離 subagent，不是實作者，也不是上一輪的 reviewer。
- 交付方式：不開 PR，報告存在本機（見 README「Gate 豁免紀錄」2026-10-28）。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

無。

### NICE TO HAVE

**N1. SCN-007 沒有鎖住一般 429 的 `failure.message` 與 runtime issue 訊息**

- 位置：`tests/opencode-quota-failfast.test.ts:108-117`。
- 本次修正把 `src/core/opencode.ts:557-574` 的 `ERATELIMIT` 分支拆成兩段。一般 429 那段（`src/core/opencode.ts:569-573`）和修正前逐字相同，所以行為沒有改變。但測試只斷言回覆文字、`failure.kind` 與 scope，沒有斷言訊息本身。
- 我做的兩個突變都沒有被抓到：
  - Mc：一般 429 的 `failure.message` 改成額度那句；
  - Md：一般 429 的 runtime issue 改用額度那句。
- 這兩個突變存活，代表「一般 429 完全照舊」目前是靠讀程式確認，不是靠測試確認。可以在 SCN-007 補一行：`failure.message` 含 `HTTP 429`，`opencode:rate-limit` 那筆紀錄也含 `HTTP 429`。

**N2. 非串流額度用完時，容器 log 的第一行仍寫 HTTP 429**

- 位置：`src/core/opencode.ts:545-551`。`logger.error('execution_failed', { err: message, … })` 在分辨限流與額度之前就印出，`message` 來自 `OPENCODE_RATE_LIMIT_ABORT.message`（`src/core/opencode.ts:109-113`）。所以 `docker compose logs` 會先看到 `[Opencode] ERROR execution_failed err=Opencode upstream rate-limited (HTTP 429); … code=ERATELIMIT`，下一行才是 `WARN quota_exhausted`。
- 這不影響 S1 修的那些觀測面：`runner-status.md` 的 Last Error、`error-summary.md`、`ErrorAlerter`、`runtime_issues`，現在都是額度那句。只有看原始 log 的人可能被誤導。若要處理，可以把這行 log 移到分支之後，或在額度用完時加上 `reason=quota-exhausted` 欄位。要不要處理屬於風格選擇，不需要使用者決策。

**N3. `review-fixes-3246b66.md` 沒有從 README 或計畫連過去**

- 位置：`docs/issues/issue-0023/README.md`「文件清單」、`docs/issues/issue-0023/implementation-plan.md` 的步驟清單。
- issue 0015～0021 的審查修正證據（`evidence/stepN-review-followup.md`）都有從 README 或計畫連過去，本 issue 的 `evidence/review-fixes-3246b66.md` 只有自己連回上一輪報告。檔名也和既有慣例不同。這屬於證據的可找性，不影響判定。

**N4. `OPENCODE_QUOTA_EXHAUSTED_MESSAGE` 的 JSDoc 現在掛在新常數上**

- 位置：`src/core/opencode.ts:118-126`。新增的 `OPENCODE_QUOTA_EXHAUSTED_REASON` 插在原本的 JSDoc 與 `OPENCODE_QUOTA_EXHAUSTED_MESSAGE` 之間，所以編輯器懸停時，這段說明會顯示在 REASON 上，MESSAGE 反而沒有說明。內容對兩者都適用，純屬外觀。

## 已查核維度

### S1 是否真的修好

| 路徑 | runtime issue 訊息 | `failure.message`（→ `deriveRunOutcome().error` → runner `Last Error`） | 結論 |
|------|-------------------|------------------------------------------------------------------|------|
| 非串流（`src/core/opencode.ts:561-567`） | `Error: Opencode upstream free usage quota exhausted; aborted before internal backoff retries.`（經 `toErrorMessage`，`src/utils/errors.ts:43-46`） | 同一句的 `message` | 不含 429，修好了 |
| 串流（`src/core/cli-agent-base.ts:447-461`，04f1a6a 起就是這樣） | `Error: streamChat upstream quota exhausted` | `streamChat upstream quota exhausted` | 不含 429 |
| 一般 429，非串流（`src/core/opencode.ts:569-573`） | 原本的 `ProcessError`（HTTP 429） | 原本的 `message` | 和 3246b66 逐字相同 |
| 一般 429，串流 | `streamChat upstream 429` | 同左 | 和 3246b66 相同 |

- 下游的鏈我重新追過一次：`deriveRunOutcome()` 把 `failure.message` 當成 `error`（`src/core/run-outcome.ts:20-26`），runner 寫進 `runnerStats.lastError`（`src/runner.ts:265`），再印成 `- Last Error:`（`src/runner.ts:230`）。
- 新建的 `Error` 沒有帶 `ProcessError` 的 `code` 與 `stderr`。下游只用訊息字串（`recordRuntimeIssue` 只呼叫 `toErrorMessage`），所以不會掉資訊；stderr 在前面的 `execution_failed` log 已經印出前 500 字元。
- 兩條路徑的額度訊息措辭不同（非串流與串流），這和既有的 429 一樣（`Opencode upstream rate-limited (HTTP 429)…`／`streamChat upstream 429`），scope 相同，可以接受。

### 新斷言會不會在修正前轉紅

我用 `git archive 7f9f3c2` 解出一份暫存副本，把 `src/core/opencode.ts` 換回 3246b66 的版本，其他維持 HEAD：

- 整檔執行 `tests/opencode-quota-failfast.test.ts`：`not ok 1`（非串流 SCN-001）、`not ok 3`（串流 SCN-001），`# pass 2`、`# fail 2`，和證據相同。
- 只跑 `--test-name-pattern="SCN-001 stream"`：`# pass 1`。

證據對串流那題的說法成立：
- `recentIssues` 是同一個測試程序內共用的記憶體緩衝（`src/utils/errors.ts:16`）。
- 斷言掃的是所有 `opencode:quota-exhausted` 紀錄（`tests/opencode-quota-failfast.test.ts:103-105`），非串流留下的那筆（含 429）就在裡面。
- 兩筆的訊息不同，dedupe 不會合併（dedupe key 是 scope 加訊息，`src/utils/errors.ts:63`）。

所以串流那題的紅燈反映的是非串流的 S1，不是串流本身的問題。證據寫的是實情，沒有誇大。

證據說串流本來就是對的，那麼串流的新斷言能不能獨立抓到串流退化？我另外做了兩個突變確認：

| 突變 | 結果 |
|------|------|
| Ma：串流額度用完的 `failure.message` 改回 `streamChat upstream 429` | 串流 SCN-001 轉紅 |
| Mb：串流額度用完的 runtime issue 改回 `streamChat upstream 429` | 串流 SCN-001 轉紅 |
| Mc：一般 429 的 `failure.message` 改成額度那句 | 4/4 仍是綠燈，見 N1 |
| Md：一般 429 的 runtime issue 改成額度那句 | 4/4 仍是綠燈，見 N1 |
| Me：`rateLimitHits` 一律用 `count429()` | `tests/probe-models-script.test.ts` 的 SCN-004 轉紅 |

每個突變都在暫存副本裡做，做完用 `cmp` 確認還原；最後刪掉暫存副本，repo 的 `git status` 只有原本 staged 的 `CHANGELOG.md`。

### N1（上一輪）的修正對 JSON 輸出的影響

- 改動：`scripts/probe-models.mjs:302`，判成 `quota-exhausted` 的那一輪，`rateLimitHits` 記 0。表格的 `429×N`（`scripts/probe-models.mjs:319-324`）跟著消失。
- 使用者：`grep` 過整個 repo（src、scripts、tests、docs、README），`rateLimitHits` 只出現在這支腳本本身和 `tests/probe-models-script.test.ts:25,134,192`；docs 沒有描述 `--json` 的欄位契約。repo 內沒有其他使用者。
- 語意：其他判定（`rate-limited`、`ok` 等）的 `rateLimitHits` 照舊。`tests/probe-models-script.test.ts:134` 的「5 次」斷言仍通過。
- 邊界：同一輪裡如果先有幾次真正的 429、之後才出現額度用完那行，那幾次也會被記成 0。不過真實樣本（step1）顯示，額度用完時主代理第一次呼叫就是額度那行，中止也發生在那一行，所以實際上不會發生。就這支手動工具來說，這種取捨合理。

### 不修 N2、N3、N4 的理由

- **N2**（`models:probe` 中止時只 `SIGKILL` 直接子程序）：理由是「逾時路徑本來就是這樣，正式映像裡的 opencode 是原生 binary」。上一輪 reviewer 實際查過 1.18.x 的 postinstall 結構。這是既有限制，工具也是手動的，理由成立。
- **N3**（log 行剛好在 `reached` 之後被切開時，訊息退回整段輸出）：理由是「只影響訊息，判定與中止不受影響」。我核對過：中止條件 `isUpstreamQuotaExhausted(stderr)`（`src/services/model-health-check.ts:460`）只需要比對到 `reached`，命中後 `interpretProbeOutput` 一定判成 `quota-exhausted`（`src/services/model-health-check.ts:319-321`），只有 `quotaExhaustedMessage()` 會退回整段輸出。最壞的情況是多一次 `changed-failure` 告警。理由成立。
- **N4**（`finish(...)` 是等價突變）：理由是「孫程序佔住 stderr 管線時，`close` 會晚到」。這和 `terminateProcessTree` 的 5 秒升級邏輯一致，這行程式本身也是正確的。不補測試可以接受。

### 驗收與證據

| SCN | 本輪結論 |
|-----|---------|
| SCN-001 | 成立。S1 修正後，兩條路徑的回覆、scope、`failure.kind`、`failure.message` 與 runtime issue 訊息都有斷言（`tests/opencode-quota-failfast.test.ts:86-106`） |
| SCN-002 | 等價證據成立（排程經 `chatStructured()` 走非串流），沿用上一輪的推論鏈；S1 的修正也涵蓋 runner 的 Last Error |
| SCN-003 | 成立，3246b66 之後沒有改動 |
| SCN-004 | 成立；表格不再出現 `429×`（`tests/probe-models-script.test.ts:191-192`） |
| SCN-005、SCN-006 | 成立，3246b66 之後沒有改動 |
| SCN-007 | 成立：程式沒有改動，聊天、健康檢查、`models:probe` 都有測試。訊息層級的缺口見 N1 |

我自己跑的驗證（HEAD 7f9f3c2，工作區只多一個 staged 的 `CHANGELOG.md`）：

- `npm run build`：exit 0。
- `npm run lint`：exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test`：exit 0，`# tests 618`、`# pass 618`、`# fail 0`。
- 測試檔：HEAD 76 個、main 73 個（`git ls-tree`）。本次只新增斷言，沒有新增測試，所以測試數和 3246b66 相同，符合實作者宣稱（L-01）。
- `npx prettier --check`：本次改動的 TS 與 mjs 都通過。兩個 md 有警告，但 `npm run format` 不涵蓋 `docs/issues/`，既有 issue 的文件也一樣，不列為問題。
- `node --check scripts/probe-models.mjs` 通過；測試跑完後沒有殘留的 `sleep 20` 程序。

### 重複邏輯與過度設計

- 額度與限流的分辨仍在五個地方各做一次：非串流、串流、`interpretProbeOutput`、`classifyFailure`、腳本。每處的輸入與要組的結果都不同，上一輪的結論仍然成立。
- 本次修正只新增一個常數和一個分支，沒有新的抽象。非串流把三元運算改成提前 return 的 if 區塊，比原本好讀。
- 沒有過度設計。

### 文件與用字

- README 的「SCN-001～007」已改正（`docs/issues/issue-0023/README.md:64`）。
- CLAUDE.md、`docs/configuration-reference.md` 沒有寫到額度用完時 runtime issue 的訊息措辭，所以不需要跟著改；現有描述（scope、不寫 HTTP 429 的回覆、`failure.kind` 維持 `rate-limit`）和實作一致。
- `evidence/review-fixes-3246b66.md` 的敘述與我重現的結果一致，包括「第一版用 `find()` 只取第一筆，紅燈原因不對」的自我揭露。
- 掃描過 3246b66..7f9f3c2 新增行的常見簡體字，沒有發現。用字是台灣慣用語。

### 上一輪可能漏看的地方

- N1 與 N2 是上一輪沒有列出的：上一輪只要求訊息「不含 429」，沒有要求一般 429 的訊息被測試鎖住；也沒有提到 `execution_failed` 這行 log。兩者都不影響判定。
- 其他維度（樣式範圍、fixture 回歸、串流收尾順序、程序樹終止、`FailureCategory` 分支、scope 波及、摘要路徑）本次都沒有改動，沿用上一輪的結論。

### 豁免、待確認與限制

- Gate 豁免：不開 PR，PASS 且沒有要修的項目時以 ff-merge 合併。本報告沒有 MUST FIX 與 SHOULD FIX；NICE TO HAVE 不阻擋合併。
- TBD-1 已解決；TBD-2 仍是非阻塞的待確認事項，不在核准範圍內，維持 README 的狀態。
- 限制：沒有在正式部署跑新版本，沒有連線真實上游，也沒有碰 `~/Documents/RunTelenexus`。驗證方式是假 opencode 加上真實 stderr 樣本，和上一輪相同。

## 流程判定

**PASS**

- 沒有 MUST FIX 也沒有 SHOULD FIX。上一輪的 S1 已修好：兩條路徑在額度用完時，runtime issue 與 `failure.message` 都不再提 429；一般 429 的程式逐字不變。新斷言在修正前確實會轉紅，原因也和證據的說法相同。
- SCN-001～007 都有測試或等價證據，相關失敗面都有覆蓋結論（依 `docs/agents/review-evidence.md`「審查強度與流程判定」）。
- N1～N4 都是 NICE TO HAVE，不阻擋 README「Gate 豁免紀錄」的自動 ff-merge。
- 本報告路徑：`docs/issues/issue-0023/review-7f9f3c2.md`。
