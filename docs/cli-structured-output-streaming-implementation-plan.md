# CLI Structured Output / Streaming Implementation Plan

這份文件定義 TeleNexus 如何從目前的 `string-only` CLI 整合，演進到可支援結構化輸出與真 streaming 的實作步驟。

它是 implementation plan，不是現況說明。

- 想看策略與取捨：`docs/cli-structured-output-streaming-plan.md`
- 想看目前 session / runner 邊界：`docs/cli-session-integration.md`
- 想看 runtime 邊界：`docs/runtime-boundary-and-security.md`

## 背景

目前 TeleNexus 對 Gemini / Opencode 的整合主軸仍是「取得最終文字回覆」，主要限制如下：

- `src/core/gemini.ts` / `src/core/opencode.ts`
  - `chat()` / `summarize()` 都回 `Promise<string>`
- `src/runner.ts`
  - `/run` 回傳 `{ provider, output: string }`
- `src/core/agent.ts`
  - `RunnerResponse.output?: string`
- `src/types/index.ts`
  - connector 只支援文字傳送與文字編輯

這讓底層 CLI 就算支援 JSON，也只能在很底層被 parse 成字串，無法把 session id、usage、事件流、首字延遲等資料往上保留。

## 本輪目標

本輪 implementation plan 的目標不是一次把所有 provider 與所有通道改成 streaming，而是建立一條低風險演進路徑：

1. 先把 provider 結果升級成「可保留結構化資訊」
2. 再把 Web `/api/chat/stream` 升級成真 streaming
3. 最後再評估 Telegram 節流式更新

## 非目標

- 不一次重寫整條聊天 pipeline
- 不要求 scheduler / summarize / memory sync 都同步支援 streaming
- 不讓 Web / Telegram 直接理解 provider 原生 schema
- 不把既有 `chat(): Promise<string>` 一次全面移除

## 核心原則

- 先增加新能力，不先破壞既有能力
- provider-specific parser 留在 provider adapter，不外漏到 connector
- 先做 Gemini，再做 Opencode
- 先做 Web streaming，再評估 Telegram streaming
- 每個 phase 都必須有 fallback，避免一改就打斷既有對話能力

## 目標介面

### 1. 非 streaming 統一結果

建議新增：

```ts
type AgentStructuredResult = {
  text: string;
  provider: 'gemini' | 'opencode';
  sessionId?: string;
  stats?: unknown;
  raw?: unknown;
  events?: unknown[];
};
```

用途：

- 給 runner / audit / diagnostics / Web API 使用
- 既有只需要文字的路徑仍可取 `text`

### 2. streaming 統一事件

建議新增：

```ts
type AgentEvent =
  | { type: 'start'; provider: 'gemini' | 'opencode' }
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; stats: unknown }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };
```

用途：

- Web SSE
- Telegram placeholder/edit 節流更新
- 後續 runner diagnostics

### 3. 新舊介面共存策略

短期內保留：

```ts
chat(prompt): Promise<string>
summarize(text): Promise<string>
```

新增：

```ts
chatStructured(prompt): Promise<AgentStructuredResult>
streamChat(prompt, onEvent): Promise<AgentStructuredResult>
```

原則：

- 既有使用者先不被迫改成新介面
- 新功能從 Web stream endpoint 開始接入

## Phase 拆分

### Phase 1: Provider 結構化結果骨架

目標：

- 讓 provider adapter 能回傳 `AgentStructuredResult`
- 不改變既有外部聊天體感

主要檔案：

- `src/core/gemini.ts`
- `src/core/opencode.ts`
- `src/core/agent.ts`
- `src/runner.ts`
- 視需要新增 `src/core/agent-result.ts`

要做的事：

1. 抽出共用型別
2. 在 Gemini 實作 `chatStructured()`
3. `chat()` 改成薄包裝，只回 `result.text`
4. runner `/run` response 可選加上 `structured`
5. `DynamicAIAgent` 先只吃 `output` 或 `structured.text`

Gemini 初版建議：

- 一般 chat 優先改用 `gemini --output-format json`
- parse：
  - `response -> text`
  - `session_id -> sessionId`
  - `stats -> stats`
- parse 失敗時 fallback 到現有 text 清洗邏輯

Opencode 初版建議：

- Phase 1 可先不切到 JSON 為預設
- 或僅新增內部 parser，先不啟用

驗收：

- Gemini chat 在既有 Telegram / Web / runner 路徑不退化
- 結構化欄位可被保留
- parse 失敗時仍可退回文字模式

### Phase 2: Opencode 事件 parser

目標：

- 能把 `opencode run --format json` 的 line-delimited events 轉成 `AgentStructuredResult`

主要檔案：

- `src/core/opencode.ts`
- 視需要新增 `src/core/opencode-events.ts`

要做的事：

1. 逐行 parse JSON
2. 收集 `text` 事件組成最終文字
3. 收集 `step_finish` tokens / cost / reason
4. 遇到非 JSON 行時要防禦性處理
5. 失敗時 fallback 到現有 text 路徑

驗收：

- Opencode 結構化 parse 不影響既有 `chat()` 路徑
- 最終文字與原文字模式內容一致或接近
- 非法事件行不會直接打爆整體流程

### Phase 3: Runner response 升級

目標：

- runner 能在維持相容性的前提下回傳結構化結果

主要檔案：

- `src/runner.ts`
- `src/core/agent.ts`

建議 response：

```ts
{
  ok: true,
  requestId,
  durationMs,
  provider,
  output: string,
  structured?: AgentStructuredResult
}
```

原則：

- `output` 先保留，避免所有 caller 一次重寫
- `structured` 作為 opt-in metadata

要做的事：

1. runner `executeTask()` 改能取得 structured result
2. `/run` response 帶回 `structured`
3. `DynamicAIAgent.callRunner()` 擴充 response type
4. `DynamicAIAgent.executeTask()` 先仍回文字，但保留 structured 供後續使用

驗收：

- 舊 caller 不需要立即改動
- 新 caller 已能取到 `structured`

### Phase 4: Gemini Web 真 streaming

目標：

- `/api/chat/stream` 不再等待完整回覆後才切 chunk，而是真正收到 provider 事件就往前端推 SSE

主要檔案：

- `src/core/gemini.ts`
- `src/core/agent.ts`
- `src/web/server.ts`
- 視需要新增 `src/core/agent-stream.ts`

建議做法：

1. 在 Gemini 新增 `streamChat(prompt, onEvent)`
2. parse `--output-format stream-json`
3. 將 provider 事件轉成 `AgentEvent`
4. Web `/api/chat/stream` 直接把 `AgentEvent` 轉成 SSE event

建議 SSE 對應：

- `start -> start`
- `status -> status`
- `delta -> chunk`
- `done -> done`
- `error -> error`

驗收：

- 前端能在模型完成前先看到增量內容
- `done.reply` 與非 streaming 文字結果一致
- SSE 中斷與 provider 錯誤都有明確收尾

### Phase 5: Web 與非 streaming 路徑對齊

目標：

- 避免 streaming 路徑與一般 chat 路徑輸出內容逐漸分歧

主要檔案：

- `src/web/server.ts`
- `src/core/agent.ts`
- 視需要調整 `CaptureConnector`

要做的事：

1. 建立 final text 對齊策略
2. 統一 provider label 處理方式
3. 定義 `done.text` 與 `output` 的責任分界

驗收：

- Web streaming 與一般 `/api/chat` 的最終回覆差異可控

### Phase 6: Telegram 節流式 streaming

目標：

- 用 placeholder + edit 提升 Telegram 體感
- 避免 token 級更新過於 noisy

主要檔案：

- `src/connectors/telegram.ts`
- `src/core/message-pipeline-helpers.ts`
- `docs/telegram-streaming-design.md`
- 視需要新增 `src/core/streaming-renderer.ts`

建議做法：

1. 建立節流 buffer
2. 將 `delta` 事件累積為目前全文
3. 每 500ms 到 1500ms 更新一次 placeholder
4. 完成時再送最終版本
5. edit 失敗時 fallback 為一般訊息送出

驗收：

- 不會高頻 edit 到 Telegram API 不穩
- 最終訊息內容完整
- parse mode 錯誤不會造成訊息遺失

細化設計請參考：`docs/telegram-streaming-design.md`

## 具體檔案變更順序

建議依下列順序實作，避免一次改太大：

1. `src/core/agent-result.ts`
   - 放 `AgentStructuredResult` / `AgentEvent`
2. `src/core/gemini.ts`
   - 先做 `chatStructured()`
3. `src/core/agent.ts`
   - 擴充 runner response / local execution 使用 structured result
4. `src/runner.ts`
   - 回傳 `structured`
5. `src/core/opencode.ts`
   - 補 event parser
6. `src/web/server.ts`
   - 接 Gemini `streamChat()`
7. `src/connectors/telegram.ts`
   - 最後才做節流 streaming

## 測試建議

### 單元測試

- Gemini `json` parse success / malformed / fallback
- Gemini `stream-json` event normalization
- Opencode line-delimited event parse
- runner response backward compatibility

### 整合測試

- `/api/chat` 仍可正常回覆
- `/api/chat/stream` 先收到 chunk 再收到 done
- runner `/run` 回傳 `output` 且可選擇讀 `structured`

### 手動驗收

- Gemini 長回覆時 Web 端能提早出字
- Opencode 結構化 parse 與原回覆內容一致
- Telegram streaming 若啟用，編輯頻率與最終可讀性可接受

## 風險與緩解

### 1. Provider schema 漂移

緩解：

- parser 做防禦性設計
- 保留 fallback 到 text mode

### 2. 事件流與最終文字不一致

緩解：

- 在 `done.text` 明確定義 final assembled text
- 驗收時比對 streaming / non-streaming 最終內容

### 3. Streaming 讓錯誤處理變複雜

緩解：

- 統一 `AgentEvent.error`
- provider 中斷時也要產出結束語意

### 4. Telegram 通道噪音

緩解：

- Telegram 一律節流，不做 token 級更新
- 必要時只在 Web 啟用 streaming，Telegram 保持 final-only

## 決策建議

若只選一個最值得先做的切入點，建議順序：

1. Gemini `chatStructured()`
2. runner `structured` response
3. Gemini Web 真 streaming

這條路線能用最小改動先把技術風險釐清，也最容易量化體感收益。

## 相關文件

- `docs/cli-structured-output-streaming-plan.md`
- `docs/cli-session-integration.md`
- `docs/runtime-boundary-and-security.md`
- `docs/web-console-reference.md`
