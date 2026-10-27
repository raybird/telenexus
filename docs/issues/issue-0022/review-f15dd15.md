# 審查報告
- 範圍：完整交付範圍（本機，無 PR）；rebase 與規格修訂後的第二輪審查
- Reviewed BASE SHA：98d7d893044f8b41007e4e15a1c20b1dd1165779
- Reviewed HEAD SHA：f15dd15898aaacdb49ee455efe74dfc58b51263a
- Reviewed patch-id：8fd28f10e30707abf0373f15517f06927557f259
- 審查日期：2026-10-27
- 獨立 reviewer：Claude Code 獨立 subagent（general-purpose，未參與實作）。上一輪 4e99ceb（`review-4e99ceb.md`）也是我審的，這次是同一位 reviewer 的第二輪審查
- Review artifact：docs/issues/issue-0022/review-f15dd15.md

## 範圍核對

- `git rev-parse HEAD` 是 f15dd15，`git diff 98d7d89 f15dd15 | git patch-id --stable` 和上面的 patch-id 相同，共 51 個檔、8 個提交。98d7d89 是 HEAD 的祖先。
- **rebase 沒有改動內容**：
  - `git range-diff 70e46d5..4e99ceb 98d7d89..f8ace9f` 的六組都是 `=`；
  - 逐一比對 `git show <commit> | git patch-id --stable`，六組新舊提交全部相同；
  - `git diff 4e99ceb f8ace9f` 只差 `docs/issues/issue-0022/README.md`，也就是 main 上的規格修訂 2580117 與 98d7d89。
- **838aae9**：只新增 `review-4e99ceb.md` 一個檔（141 行），用來留存上一輪的報告。
- **規格修訂**：
  - 70e46d5..98d7d89 的 README 差異新增了 SCN-010、SCN-011，更正概述，加上 TBD-2（已解決），核准表加了兩列已核准；
  - 修訂核准 commit 是 2580117；
  - 98d7d89..HEAD 之間 README 沒有再改，實作讀到的就是核准版本。
- **上一輪已查核、這次沿用的部分**：SCN-001～009 的程式與證據，因為 rebase 後內容逐位元組相同，沿用 `review-4e99ceb.md` 的結論。這次重跑了全套測試；另外重讀 f15dd15 改到的文件段落，確認 SCN-009 仍成立。

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

無。

### NICE TO HAVE

- **N8　「只差頭尾空白」這個測試其實測不到 trim**：`tests/ai-config.test.ts` 的「和舊範例相同、只差頭尾空白」案例，把空白加在 YAML plain scalar 的尾端。js-yaml 解析時就會先去掉這些空白（我實測過，`yaml.load` 之後字串不以空白結尾），所以程式裡的 `.trim()` 拿掉了，這個測試也照樣是綠的。
  - trim 本身是對的：我用加引號的 `"  …  "` 實測過，會判成舊範例並且 warn。
  - 這屬於證據持久力的問題，測試名稱說得比實際測到的多，不是假綠燈。
  - 建議改成加引號的 scalar。
- **N9　空字串與非字串的項目會被忽略後再比對**：舊範例三行再加一個 `- ""` 或 `- 42`，仍然會判成舊範例並替換（我實測過）。
  - 這是因為比對沿用 `linesOrDefault` 的過濾。過濾之後，交給 prompt 的條列本來就和舊範例一模一樣，所以替換符合 SCN-011 的意圖。
  - 但規格寫的是「多一行……就視為使用者自訂」。這兩種輸入是例外，建議在 `configuration-reference.md` 補一句，或者接受現狀。
- **N10　`memory_policy_enabled: false` 時仍然會 warn**：知識管理段落不會注入，啟動時卻仍然印「已改用預設條列」。訊息不算錯（條列確實換了），也沒有其他影響，可以接受。
- **上一輪的 N2、N3、N4、N7 仍未處理**（都不阻擋判定）：
  - N2：step5 沒有記錄映像 ID 與來源提交。上一輪我已用 `docker create`＋`docker cp` 核對，映像內容和 HEAD 的編譯輸出一致；rebase 後程式內容沒變，結論仍然有效。
  - N3：step4 實跑 `/api/status` 沒有記錄命令。
  - N4：plan 的「檢查清單」仍然全部沒打勾。README 已從「待實作」改成「實作中」，合併或結案時再更新。
  - N7：SCN-007 的 mtime 斷言是證據持久力的問題。

## 上一輪發現的處理結果

| 項目 | 處理 | 覆核結論 |
|------|------|----------|
| S1（需決策） | 使用者選擇擴大 #22，新增 SCN-010、SCN-011（2580117）並實作（f15dd15）。改了 builder 的標題、`ai-config.example.yaml`，舊範例自動換成預設條列並在啟動時 warn；`configuration-reference.md:190` 那句改成合乎事實的說法 | 已解決 |
| N1 | `memory-health-cli.ts` 的 description 改成 `Show operational database and memory archive health` | 已解決 |
| N2、N3、N7 | 未處理 | 不阻擋判定，見上方 |
| N4 | README 的狀態改成「實作中」；plan 的檢查清單沒改 | 部分處理 |
| N5 | `scheduler.ts:425` 的註解改成「moltbot.db 最近訊息」 | 已解決 |
| N6 | step7 記錄了 `gitnexus_detect_changes`，也記了誤報的原因（只是行號位移） | 已解決 |

## 已查核維度

### 驗收與證據

| SCN | 證據位置 | 結論 |
|-----|----------|------|
| SCN-001～009 | 同 `review-4e99ceb.md`；rebase 後內容相同（range-diff 與 patch-id 都相同）；本輪全套測試仍是綠的 | 成立。SCN-009 在 f15dd15 有文件更新（prompt 一項、升級說明），我重讀過，沒有退步 |
| SCN-010 | `issue 0022 SCN-010 使用者自訂條列時…標題不提 MCP Memory`（斷言 `【知識管理 - 重要】\n- 記住使用者的偏好`，而且沒有 `MCP Memory`）；`…出貨的 ai-config.example.yaml 不點名 MCP Memory 工具，條列和預設相同`（用 js-yaml 讀實際檔案，deepEqual 預設條列）；`SCN-010／SCN-011 舊範例設定組出的 full prompt…`。紅燈是 8、9、10 失敗，原因是行為還不存在；突變 M2（加回標題）會讓 8、9 轉紅 | 成立。我 grep 過 `src skills AGENTS.md ai-config.example.yaml scripts`，除了 `ai-config.ts` 裡的舊範例常數之外，已經沒有 `MCP Memory` 和三個工具名 |
| SCN-011 | 六個表格案例：完全相同、只差空白、改一個字、只留兩行、自訂條列、未設定，每個都同時驗證條列與 warn 的次數。期望值是逐字抄寫的字面值，或 `DEFAULT_CHAT_PROMPT_CONFIG`，不是從實作推算的。紅燈用空殼；4～7 提早就綠，由突變 M1（任一行相同就替換）證明擋得住誤換。對正式部署 `ai-config.yaml` 的唯讀複本實跑，結果是 `warned: true`、prompt 不提工具 | 成立。我另外實測邊界：<br>- 順序對調 → 使用者條列，不 warn；<br>- 加引號、帶空白 → 預設條列，warn；<br>- 值是字串而不是陣列、沒有 `chat_prompt`、YAML 壞掉 → 預設條列，不 warn，也不 throw；<br>- 空字串或非字串項目見 N9；trim 的測試見 N8 |

**建置與測試（我在 HEAD f15dd15 實跑，工作區乾淨）：**

- `npm run build`：exit 0。
- `npm run lint`：exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB TMPDIR=$HOME/.cache/memoria-release-tmp npm run test`：exit 0，`# tests 578`、`# pass 578`、`# fail 0`。
- `tests/` 下有 72 個 `*.test.ts`。
- 569 + 9（SCN-011 六個案例，加上三個）＝ 578，和 step7 相符。9 個 SCN-010／011 的測試都出現在輸出裡。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|------------|------|----------|------|
| `linesOrDefault` 從函式內移到模組層級 | 行為不變 | diff 逐行相同，只是位置不同；`workspacePolicyLines` 照舊呼叫；既有的 ai-config 與 prompt-builder 測試都是綠的 | 等價 |
| 啟動 warn 和 prompt 用的設定來源不同 | 兩者讀的應該是同一份 | 兩者都經過 `loadAiConfigRaw()`（`process.cwd()/ai-config.yaml`）與同一個 `configuredMemoryPolicyLines` | 一致 |
| 啟動 warn 的接法 | 只印一次，不影響啟動 | `main.ts` 在回填警告之後呼叫；讀檔失敗時 `loadAiConfigRaw` 回 undefined，不會 throw（我測過壞掉的 YAML） | 通過 |
| 每一輪聊天的 prompt | 每輪重讀設定並替換 | `main.ts:230` 的 `buildPromptFn` 每輪都呼叫 `loadChatPromptConfig()` | 通過；執行中改了 `ai-config.yaml` 也會生效（warn 只在啟動時印） |
| agent-runner、排程 prompt | 不經過知識管理段落 | grep：生產程式只有 `main.ts` 呼叫 `loadChatPromptConfig`、`buildChatPrompt`；`buildScheduledTaskPrompt` 不帶這一段 | 不受影響 |
| 使用者條列含舊範例的部分行 | 照使用者的條列 | 「只留兩行」「改一個字」的測試；M1 突變 | 通過 |
| `memory_policy_enabled: false` | 不注入 | 既有行為 | 見 N10 |

### 需求、架構、安全、品質

- **需求**：SCN-010、SCN-011 和修訂後的「涉及檔案」相符。`src/prompt/builder.ts` 只改了一行標題，其他部分照規格維持不可觸及。
- **架構**：
  - 替換放在設定載入層（`loadChatPromptConfig`），prompt 組裝層不需要知道舊範例；
  - 舊範例的常數只有一份，warn 和替換共用同一個判斷，不會出現兩套 trim 規則。
- **安全**：
  - 對正式部署設定的實跑是複製到 repo 外的唯讀複本，只輸出布林值，內容沒有進 repo。
  - 新增的行裡找不到家目錄路徑、`.env` 裡的 Telegram 使用者 ID、`RunTelenexus` 路徑或 token（L-10）。
- **品質（code-simplify 的標準）**：
  - `configuredMemoryPolicyLines` 與 `isRetiredExampleMemoryPolicy` 是兩個小函式，各有用途，沒有過度設計；
  - 測試的舊範例是自己抄寫的字面值，沒有從實作 import，所以不是同義反覆；
  - 沒有看到跨步驟重複的邏輯。
- **文件**：
  - 常青文件表的「`ai-config.yaml` 欄位」一列，對應的 `configuration-reference.md` 與 `ai-config.example.yaml` 都更新了；
  - 「聊天 prompt 組裝」一列對應的 `docs/current-chat-prompt.md` 補了說明（它原本記的標題就已經是改動後的樣子）；
  - `installation.md` 補上升級說明；
  - 歷史文件（`migration-log.md`、`chat-prompt-config-proposal.md`）維持原樣。

### 豁免、待確認與限制

- **Gate 豁免**（Q6）：審查 PASS 而且沒有要修的項目時，以 `git merge --ff-only` 自動合併。本輪沒有 MUST FIX，也沒有 SHOULD FIX，條件成立。
- **待確認事項**：
  - TBD-1：待確認，不阻塞（Q5）；
  - TBD-2：已解決（使用者 2026-10-27 決定擴大 #22）。
- **審查限制**：
  - 依指示沒有建 Docker 映像，也沒有重跑 step1、step5 的探測；rebase 後程式內容逐位元組相同，沿用上一輪對映像的核對；
  - 沒有修改既有檔案，沒有 commit，沒有碰正式部署，也沒有啟動或停止任何服務。

## 流程判定

PASS

沒有 MUST FIX，也沒有 SHOULD FIX。SCN-001～011 與已辨識的失敗面都有可信的證據；N8～N10 與上一輪留下的 NICE TO HAVE 都不阻擋判定。
