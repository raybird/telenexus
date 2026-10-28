- Reviewed BASE SHA：82fa6ad2d7c97bf2fc15c7eb39d25434319d8278
- Reviewed HEAD SHA：3246b6631bc3e72cb8e63c6c2dd0cf63ed43f31d
- Reviewed patch-id：a21390bb563d39912d125f4f112f1345589a7930

# Issue 0023 審查報告：review-3246b66

- 審查日期：2026-10-28
- 範圍：`main`（82fa6ad）..`fix/opencode-quota-failfast`（3246b66）完整分支，6 個提交、21 個檔案、+955／−39。`git diff 82fa6ad..3246b66 | git patch-id --stable` 重算結果與上列相同。工作區 staged 的 `CHANGELOG.md` 與本 issue 無關，不在範圍內。
- 獨立 reviewer：Claude Code 隔離 subagent，不是實作者。
- 交付方式：不開 PR，報告存在本機（見 README「Gate 豁免紀錄」2026-10-28）。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

**S1. 非串流路徑遇到額度用完時，runtime issue 與 `failure.message` 記的還是 429 的原因文字**

- 位置：`src/core/opencode.ts:554-566`。`recordRuntimeIssue('opencode:quota-exhausted', error)` 傳入的 `error`，以及 `failure: { kind: 'rate-limit', message }` 裡的 `message`，都來自 `abortOnStderr` 的固定訊息 `src/core/opencode.ts:109-113`：`Opencode upstream rate-limited (HTTP 429); aborted before internal backoff retries.`
- 影響：scope 是對的（`opencode:quota-exhausted`），但原因文字寫成 HTTP 429。這正是本 issue 要「說清楚原因」的面向，而且出現在正式部署會走的路徑上：
  - 排程經 runner `/run` 走 `chatStructured()`（`src/runner.ts:363`）。`deriveRunOutcome()` 把 `failure.message` 當成 `error`（`src/core/run-outcome.ts:25`），runner 再寫進 `runner-status.md` 的 `Last Error`（`src/runner.ts:230`、`src/runner.ts:264-265`）。所以 Web Console `#/status` 在額度用完期間顯示的是「HTTP 429」。
  - 本機執行時（沒有 `RUNNER_ENDPOINT`，或 runner fallback），`error-summary.md` 的「Recent Runtime Issues」會出現 `(opencode:quota-exhausted) Opencode upstream rate-limited (HTTP 429)…`（`src/services/context-snapshots.ts:160-163`）。`ErrorAlerter` 的 Telegram 告警「最後一次：」也是這句（`src/services/error-alerter.ts:55-61`）。
  - 串流路徑已經改用 `streamChat upstream quota exhausted`（`src/core/cli-agent-base.ts:448-459`），兩條路徑不一致。
- 覆蓋缺口：`tests/opencode-quota-failfast.test.ts:695-708` 只斷言了回覆文字、`failure.kind` 與 scope，沒有斷言 runtime issue 的訊息與 `failure.message`。
- 建議：額度用完時另建一個 Error，例如 `Opencode upstream free usage limit reached; aborted before internal backoff retries.`，同時用在 `recordRuntimeIssue` 與 `failure.message`，和串流路徑的做法對齊。補一條斷言：兩種模式下 `getRecentIssues()` 中 `opencode:quota-exhausted` 那筆的 message，以及 `deriveRunOutcome(result).error`，都不含 `429`。修正很小，不需要使用者決策。

### NICE TO HAVE

**N1. `models:probe` 判定為額度用完時，表格仍印出 `429×1`**

- 位置：`scripts/probe-models.mjs:257-259`（`count429()` 用的是 `RATE_LIMIT_PATTERN`，而它已經包含 `usage limit reached`），印出的地方在 `scripts/probe-models.mjs:316-322`。
- 實測（假 opencode 輸出真實樣本）：`⛔ 額度用完  opencode/big-pickle  0s  len=0  429×1`。判定標籤正確，SCN-004 成立，但旁邊的計數會讓人以為是 429。`tests/probe-models-script.test.ts:797-807` 只排除了 `⛔ 429 限流|⛔ 逾時`，所以沒抓到。可以把額度用完的那一行從計數中扣掉，或改成判定為 `quota-exhausted` 時不顯示這個計數。

**N2. `models:probe` 中止時只 `SIGKILL` 直接的子程序**

- 位置：`scripts/probe-models.mjs:124`（spawn 沒有帶 `detached`）、`scripts/probe-models.mjs:141`。
- 評估：在正式映像裡，`opencode-ai@1.18.34` 的 postinstall 把 `bin/opencode.exe` 換成原生 ELF（本機 1.18.31 的套件結構實際查過），所以 `SIGKILL` 會直接結束 opencode 本身，不會只殺到一層 node 包裝。opencode 若已經長出 MCP 子程序：
  - 子程序會成為孤兒（L-07），容器裡由 init 回收；
  - 如果子程序繼承了 stderr，`close` 要等它們關掉管線才會觸發，「立刻結束」就會延遲。
- 這和既有的逾時路徑是同一個做法，屬於既有限制。這是手動工具，風險低。如果要處理，可以照 `terminateProcessTree()` 的方式（`detached` 加上 `process.kill(-pid)`）複製一份進腳本。

**N3. log 行剛好在 `usage limit reached` 之後被切成兩個 chunk 時，健康檢查的訊息會退回整段輸出**

- 位置：`src/services/model-health-check.ts:295-299`、`src/services/model-health-check.ts:457-461`。中止條件只比對到 `reached` 為止，而 `quotaExhaustedMessage()` 的 `([^"\n]*)"` 需要右引號。取不到時退回 `output.trim()`：去掉易變欄位後，簽章與告警片段會和整行的情況不同，最多多一次 `changed-failure`。
- opencode 的單行 log 約 350 bytes，小於 PIPE_BUF，一次寫出，實務上不會遇到。記錄下來，不建議為此增加複雜度。

**N4. `defaultProbe` 在 stderr 處理裡呼叫的 `finish(...)` 是等價突變**

- 位置：`src/services/model-health-check.ts:460`。我拿掉這一行重跑 `tests/model-health-quota.test.ts`，仍然 7/7 通過：假 opencode 收到 SIGTERM 後 `close` 很快觸發，`interpretProbeOutput()` 同樣先判額度用完。
- 這一行本身是對的：真實 opencode 收到 SIGTERM 可能要收尾一陣子，最長 5 秒後才升級成 SIGKILL，這一行讓結果不必等 `close`。只是目前沒有測試證明它的必要性。若要補，可以讓假 opencode `trap '' TERM`。

**N5. 文件筆誤**

- `docs/issues/issue-0023/README.md:64` 寫「SCN-001～008」，但只有 SCN-001～007。這在核准版（3bf8690）就已經存在，不在本次 diff 裡。

## 已查核維度

### 驗收與證據

| SCN | 可觀察結果 | 測試／證據 | 結論 |
|-----|-----------|-----------|------|
| SCN-001 | 串流與非串流都在 4 秒內結束；回覆含「免費額度已用完／其他免費模型／OpenCode Go／provider」，不含 429；scope 是 `opencode:quota-exhausted`，沒有 `opencode:rate-limit`；`failure.kind` 是 `rate-limit`，`deriveRunOutcome().ok` 是 false | `tests/opencode-quota-failfast.test.ts:694-708`；step3 | 成立。原因文字見 S1 |
| SCN-002 | 排程經 `Scheduler` → `taskAgent.chat()` → `chatStructured()`（非串流），得到同一段額度訊息，不會撞到排程逾時 | `src/core/scheduler.ts:412`、`src/core/cli-agent-base.ts:100-101`、`src/runner.ts:363`；以非串流測試作為等價證據（step3） | 等價證據成立。排程層沒有改動，推論鏈我自己追過 |
| SCN-003 | 判定為 `quota-exhausted`；`defaultProbe` 在 4 秒內結束（逾時設 8 秒）；告警文字正確、不含 429；兩次探測簽章相同，提醒間隔內不再推播，到了間隔才 `reminder` | `tests/model-health-quota.test.ts:389-496`；step4 | 成立 |
| SCN-004 | `--timeout 60` 時該輪也在 8 秒內結束，標示 `⛔ 額度用完` | `tests/probe-models-script.test.ts:778-807`；step5；我另外實跑腳本，0.04 秒結束 | 成立。表格的 `429×1` 見 N1 |
| SCN-005 | 真實樣本、`Usage limit reached`、`Monthly usage limit reached for this plan`、全大寫，兩個樣式都命中 | `tests/opencode-quota-exhausted.test.ts:539-555` | 成立 |
| SCN-006 | 標題代理（真實 `AI_RetryError` 行，以及改成 `AI_APICallError` 的版本）、非 stream error 行、`error.error` 以外的欄位、回覆文字，兩個樣式都不命中 | `tests/opencode-quota-exhausted.test.ts:557-586` | 成立 |
| SCN-007 | 一般 429 的兩份樣本仍是限流而不是額度用完；聊天兩種模式仍回 `HTTP 429` 訊息與 `opencode:rate-limit`；`defaultProbe` 遇到 429 不提早中止（等到逾時）；`models:probe` 遇到 429 等到 `--timeout` 後判為 `rate-limited`；`interpretProbeOutput` 對 429 樣本仍判 `rate-limited` | `tests/opencode-quota-exhausted.test.ts:588-597`、`tests/opencode-quota-failfast.test.ts:710-719`、`tests/model-health-quota.test.ts:407-411,498-503`、`tests/probe-models-script.test.ts:809-823` | 成立。四條路徑都有覆蓋 |

我自己跑的驗證（HEAD 3246b66，工作區只多一個 staged 的 `CHANGELOG.md`）：

- `npm run build`：exit 0。
- `npm run lint`：exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test`：exit 0，`# tests 618`、`# pass 618`、`# fail 0`。
- 測試檔：main 73 個，HEAD 76 個（`git ls-tree`）。
- main 的基準：用 `git archive 82fa6ad` 解到暫存目錄後跑同一組測試，`# tests 589`、`# pass 589`。589 + 29 = 618，和證據相符（L-01）。
- `npx prettier --check`（9 個變更的程式與測試檔加上 `CLAUDE.md`）通過；`node --check scripts/probe-models.mjs` 通過。
- 測試跑完後沒有殘留的 `sleep 20` 程序。

### 相關失敗面

| 失敗面 | 具體輸入／狀態 | 預期 | 覆蓋與結論 |
|--------|---------------|------|-----------|
| 樣式太寬（L-04） | 標題代理行、非 stream error 行、其他欄位、回覆文字 JSON | 不命中、不中止 | 有反例測試。我獨立做的突變 M1（拿掉 quota 樣式的 `small=false`）轉紅 2 個。兩個樣式都把措辭限定在 `error.error="AI_APICallError: [^"\n]*` 之內，和既有 1.18 分支的結構相同 |
| 樣式太窄（L-03） | 正式部署擷取的真實 1.18.34 stderr | 命中 | 樣本來自真實擷取（step1），測試直接讀 fixture |
| 既有 fixture 的行為 | 全部 14 份 fixture，比對 base 與 head 的 `UPSTREAM_RATE_LIMIT_PATTERN` 與 `countUpstreamRateLimitHits` | 只有新樣本改變 | 我寫腳本逐檔比對：只有 `1.18.34-free-usage-limit.stderr.txt` 從 false/0 變成 true/1，其餘 13 份完全不變 |
| 非串流的 stderr 來源 | `abortOnStderr` 命中 | `ProcessError.stderr` 帶著觸發中止的累積 stderr | `src/core/process-runner.ts:196-208` 在同一個 data handler 裡把 `stderr` 放進 ProcessError，一定帶得到。兩個樣式的結尾措辭相同：quota 命中時 rate-limit 一定命中；rate-limit 先因別的措辭命中時，結果是 429 訊息，這是正確的 |
| 串流收尾順序（L-05） | `rateLimited` 之後才 close，`onEvent` 是延遲 30ms 的 async | 不等處理鏈；先 `emitStart` 再送 `done` | `src/core/cli-agent-base.ts:393` 的「rateLimited 不等 drain」與送出順序都沒改，只多一個依 `stderr` 選文字的判斷。測試用的是 async 延遲回呼。突變 M3（串流一律當限流）轉紅 |
| 健康檢查重複 resolve | stderr 中止後 `close` 又觸發 | 只 resolve 一次 | `finish()` 用 `settled` 擋住（`src/services/model-health-check.ts:434-439`），`close` 與 `error` 都經過 `finish` |
| 程序樹終止（L-07） | 健康檢查的 spawn 帶 `detached`，用 `terminateProcessTree` | 整個 group 收到 SIGTERM，5 秒後 SIGKILL | `src/services/model-health-check.ts:424-427,459`。聊天的假 opencode 是 `cat; sleep 20` 沒有 exec，group 沒殺乾淨的話 `close` 要等 20 秒，所以 4 秒的斷言間接證明了非串流與串流都有 group kill。`models:probe` 見 N2 |
| 簽章穩定 | 時間戳、run id、session id 不同的兩次探測 | 簽章相同 | 訊息只取上游那句（`quotaExhaustedMessage`），有測試；邊界見 N3 |
| `FailureCategory` 分支 | 新增 `quota-exhausted` | 所有比對都補齊 | `grep` 過 src、scripts、web：比對只出現在 `model-health-check.ts`。`buildAlertText` 已補分支；`failureSignature` 只特判 `rate-limited`，額度用完走一般規則，是對的；`context-snapshots.ts:78-84` 只看 `status`，不看類別；Web Console 沒有依類別分支 |
| scope 變更的波及 | `model-health:quota-exhausted`、`opencode:quota-exhausted` | 不破壞既有觀測 | `ErrorAlerter`、pinned status、Web Console 都不依 scope 名稱分支。`error-summary.md` 的 `Rate-limit Issues (24h)` 只算 `opencode:rate-limit`（`src/services/context-snapshots.ts:173-176`），文件已寫明不算進去。升級當下若前一個狀態是 `unknown`，會發一次 `changed-failure`，這是預期的 |
| 摘要路徑 | `summarize()` 也用 `OPENCODE_RATE_LIMIT_ABORT` | 額度用完時快速中止並退回截斷文字 | `src/core/opencode.ts:480-483`，行為改善（以前要等到逾時），不記 issue，和既有 429 相同 |
| `VERDICTS` 重新編號 | `order` 加一 | 沒有外部依賴 | 只用在 `worstVerdict()` 與 `renderTable()` 的排序；exit code 只看是不是全部 `ok`（`scripts/probe-models.mjs:384`）。repo 內沒有其他地方引用 `order` |
| 腳本副本一致 | `RATE_LIMIT_PATTERN`、`QUOTA_EXHAUSTED_PATTERN` | 字串與 TS 相同 | 兩條比對原始字串的測試（`tests/probe-models-script.test.ts:143-150,768-774`） |

我獨立做的突變（在 `git archive` 解出的暫存副本裡做，每次都還原，最後 `diff -r` 確認和 repo 完全相同）：

| 突變 | 結果 |
|------|------|
| M1：quota 樣式拿掉 `small=false` | `opencode-quota-exhausted` 轉紅 2 個 |
| M2：非串流一律當限流 | `opencode-quota-failfast` 的非串流 SCN-001 轉紅（第一次 regex 沒套上，我偵測到後改正重跑） |
| M3：串流一律當限流 | 串流 SCN-001 轉紅 |
| M4：`defaultProbe` 不中止 | `defaultProbe` SCN-003 轉紅 |
| M5：中止時只 kill、不呼叫 `finish` | 仍是綠燈，是等價突變，見 N4 |
| M6：`models:probe` 不傳中止樣式 | SCN-004 轉紅 |
| M7：快速失敗樣式不認 `usage limit reached` | 兩種模式的 SCN-001 轉紅 |

證據揭露的兩次無效突變（step3 的 R4、step4 的 H5／H6）都已重跑並說明原因。我沒有發現假綠燈。紅燈裡「先綠」的項目都是對照組，證據有逐一說明。

### 需求、架構、安全、品質

- **需求**：實作和使用者核准的 Q1～Q3 與推導行為 (a)～(c) 一致：`failure.kind` 維持 `rate-limit`，斷路器與 runner-audit 不變；措辭不分大小寫；健康檢查與 `models:probe` 遇到額度用完立刻中止，一般 429 不提早中止。核准後的 Gherkin 沒有被改動，README 只更新步驟狀態與待確認事項。
- **架構**：判定集中在 `src/core/rate-limit.ts`；`CliAgentConfig.quotaExhausted` 是選填欄位，只有 `OpencodeAgent` 實作；腳本副本照既有慣例處理，有比對測試。沒有越界改動。
- **安全／去敏（L-10）**：fixture 與證據裡沒有家目錄路徑、Telegram ID、token 或完整容器 ID。fixture 裡的 `session.id=ses_e7f4…` 是探測用的隨機值，證據記錄該 session 已刪除。
- **品質（code-simplify 標準）**：
  - 額度用完分別在非串流、串流、`interpretProbeOutput`、`classifyFailure` 與腳本各判一次，但每處的輸入與要組的結果都不同，抽共用函式的收益很小。
  - `classifyFailure()` 開頭的額度判斷（`src/services/model-health-check.ts:103-104`）在正式路徑上到不了（`interpretProbeOutput` 已經先判過），保留它是為了讓這個匯出函式本身前後一致，可以接受。
  - 測試 `tests/model-health-quota.test.ts:391-392` 的 `assert.equal(outcome.ok, false)` 和 `assert.ok(!outcome.ok)` 重複，後者是為了讓型別收窄，無傷。
  - 沒有過度設計。
- **文件**：
  - `CLAUDE.md` 兩段補充符合實作，並修正了原本「探針結束後一律刪 session」的不精確說法；
  - `docs/configuration-reference.md:341` 對 scope 與 `Rate-limit Issues (24h)` 的描述正確；
  - fixtures README 新增的那一列正確。
  - 新增的中文都是繁體，掃描過 diff 的新增行，沒有簡體字。

### 豁免、待確認與限制

- Gate 豁免：不開 PR，PASS 且沒有要修的項目時才 ff-merge。本報告有 SHOULD FIX，不符合自動合併的條件。
- TBD-1：已解決，有真實樣本。
- TBD-2：額度用完與逾時時，探針建立的 session 不會被刪掉。這是新記錄的非阻塞事項，不在核准範圍內；正式部署的健康檢查目前暫停。我同意它不阻擋本次交付。
- 證據揭露的限制：沒有在正式部署跑新版本；子程序測試用的是假 opencode 加真實 stderr。我認為這種驗證方式對本次改動足夠，N2、N4 是這種方式剩下的盲點。
- 本次審查沒有連線真實上游，也沒有碰 `~/Documents/RunTelenexus`。

## 流程判定

**PASS**

- 沒有 MUST FIX，SCN-001～007 都有測試或等價證據，相關失敗面都有覆蓋結論（依 `docs/agents/review-evidence.md`「審查強度與流程判定」）。
- 但有一項 SHOULD FIX（S1）。依 README「Gate 豁免紀錄」，「PASS 且沒有要修的項目」才自動合併，所以這次不符合自動合併的條件。建議修正 S1 並補斷言後，針對新的 HEAD 重新審查。
- 本報告路徑：`docs/issues/issue-0023/review-3246b66.md`。
