# 步驟 7：prompt 不再指示已退役的 MCP Memory 工具（SCN-010、SCN-011）

- 日期：2026-10-27
- 來源：本機審查 [review-4e99ceb.md](../review-4e99ceb.md) 的 S1。使用者選擇擴大 #22（README 的 TBD-2），SCN-010、SCN-011 在 `2580117` 核准。

## 改動

- `src/prompt/builder.ts`：知識管理段落的標題，從 `【知識管理 - 重要】\n你有 MCP Memory 工具可以儲存長期知識與關係：` 改成 `【知識管理 - 重要】`，條列不變。`docs/current-chat-prompt.md` 原本記的就是改動後的樣子。
- `src/config/ai-config.ts`：
  - `RETIRED_EXAMPLE_MEMORY_POLICY_LINES`：v2.32.0 以前範例的三行。歷來每一版 `ai-config.example.yaml` 的有效條列都是這三行，`fc0d60f` 以前只有註解掉的版本。
  - `loadChatPromptConfig()`：設定的條列（經過既有的 trim 與空行過濾）和這三行完全相同時，改用預設條列。
  - `warnIfRetiredMemoryPolicyLines()`：在 `src/main.ts` 啟動時呼叫一次，緊接在回填警告之後。命中舊範例時 warn 一行。
  - `linesOrDefault` 從 `loadChatPromptConfig` 裡的區域函式移到模組層級，給兩個函式共用，邏輯沒變。
- `ai-config.example.yaml`：`memory_policy_lines` 改成和程式預設相同的四行，由測試守住兩者一致。
- 順手處理審查的 NICE TO HAVE：
  - N1：`src/tools/memory-health-cli.ts` 的 description 拿掉 backfill；
  - N5：`src/core/scheduler.ts` 的註解改成實際讀的是 `moltbot.db`。
- 文件：
  - `configuration-reference.md`：更正「2026-03-29 起 prompt 就不再指示」這句，它只對程式預設成立。退役段落新增 prompt 一項，升級說明補一行。
  - `installation.md`、`current-chat-prompt.md`：補上說明。

## 影響分析

- `gitnexus_impact`：`loadChatPromptConfig` 與 `buildChatPrompt` 都回報 0 個呼叫者，這是 GitNexus 已知的低報。
- `gitnexus_detect_changes`：risk critical。它把 `validateAiConfig`、`loadAiConfigRaw`、`loadProviderStatus`、`toLanguageInstruction` 標成 touched，連帶 bootstrap 與 BuildPromptFn 的流程；但逐一用 diff 比對函式內容，這四個都沒變，只是上方插入程式碼造成行號位移。`Scheduler.executeTask` 與排程流程被標到，是因為 N5 改了一行註解。真正改到行為的只有 `loadChatPromptConfig`、`buildChatPrompt` 的知識管理標題，以及新增的 `warnIfRetiredMemoryPolicyLines`。
- 用 `grep -rn "loadChatPromptConfig(\|buildChatPrompt("` 自己數：生產程式的呼叫點是 `src/main.ts` 的 `buildPromptFn`（每一輪聊天組 prompt），另有測試。
- 影響面是每一個 full prompt 的知識管理段落，排程 prompt（`buildScheduledTaskPrompt`）不經過這裡。

## 紅燈

`warnIfRetiredMemoryPolicyLines` 先放一個永遠回 `false` 的空函式，讓 import 成立：

```text
$ env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/ai-config.test.ts
ok 1 - loadChatPromptConfig default prompt text uses current TeleNexus wording
not ok 2 - issue 0022 SCN-011 memory_policy_lines 和舊範例的三行完全相同時用預設條列，warn
not ok 3 - issue 0022 SCN-011 memory_policy_lines 和舊範例相同、只差頭尾空白時用預設條列，warn
ok 4 - issue 0022 SCN-011 memory_policy_lines 使用者改過一個字時用使用者的條列，不warn
ok 5 - issue 0022 SCN-011 memory_policy_lines 只留舊範例的前兩行時用使用者的條列，不warn
ok 6 - issue 0022 SCN-011 memory_policy_lines 使用者自己的條列時用使用者的條列，不warn
ok 7 - issue 0022 SCN-011 memory_policy_lines 未設定時用預設條列，不warn
not ok 8 - issue 0022 SCN-010／SCN-011 舊範例設定組出的 full prompt 不再提 MCP Memory 工具
not ok 9 - issue 0022 SCN-010 使用者自訂條列時，知識管理段落照用但標題不提 MCP Memory
not ok 10 - issue 0022 SCN-010 出貨的 ai-config.example.yaml 不點名 MCP Memory 工具，條列和預設相同
# tests 10
# pass 5
# fail 5
```

- 失敗的 2、3、8、9、10，原因都是目標行為還不存在。
- 4～7 在改動前就是綠的：使用者條列本來就原樣使用。它們要擋的是「誤換使用者條列」的回歸，由突變 M1 證明抓得到。

測試裡舊範例的三行是逐字抄錄的字面值，沒有從實作 import。

## 綠燈

- `tests/ai-config.test.ts` 加上 `tests/prompt-builder.test.ts`：`# tests 31`、`# pass 31`、`# fail 0`。
- 全套 `npm run test`（以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行）：exit 0，`# tests 578`、`# pass 578`、`# fail 0`，`tests/` 下有 72 個測試檔。和步驟 6 的 569 個相比，多出這次新增的 9 個（6 個 SCN-011 表格案例，加上 3 個）。
- `npm run build`、`npm run lint`：exit 0。`npx prettier --check` 改過的檔案都通過。

## 突變

| 突變 | 結果 |
|------|------|
| M1：比對放寬成「任一行和舊範例相同就替換」 | `not ok 4`（改一個字）、`not ok 5`（只留兩行），`# fail 2` |
| M2：標題加回「你有 MCP Memory 工具可以儲存長期知識與關係：」 | `not ok 8`、`not ok 9`，`# fail 2` |

突變後已還原。

## 對正式部署設定的實跑

正式部署的 `ai-config.yaml` 是使用者檔案，升級不會覆蓋，所以要確認它確實會被判成舊範例。做法：把它唯讀複製到 repo 外的暫存目錄，在那裡 import 編譯後的 `dist/config/ai-config.js` 與 `dist/prompt/builder.js`，組出 full prompt，只輸出布林值，用完就刪掉複本。檔案內容沒有進 repo。

```text
warned: true warn_lines: 1
prompt_mentions_mcp_tools: false
prompt_has_knowledge_section: true
prompt_uses_default_lines: true
```

## 文件 grep

`grep -rn "MCP Memory\|create_entities"` 掃 `*.md`，`docs/issues`、`node_modules`、`dist` 除外。剩下的命中分兩類：
- 退役說明本身：`configuration-reference.md`、`installation.md`、`current-chat-prompt.md`；
- 歷史文件：`migration-log.md`、`chat-prompt-config-proposal.md`。

`skills/`、`AGENTS.md`、`workspace/` 下的 tracked 檔案都沒有提到 MCP Memory 工具或知識圖譜。

## 精煉

`linesOrDefault` 改成模組層級後，`loadChatPromptConfig` 與 `warnIfRetiredMemoryPolicyLines` 共用同一個解析（`configuredMemoryPolicyLines`），不會出現兩份不一致的 trim 規則。除此之外沒有可再簡化的部分。
