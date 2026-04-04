# CLI Structured Output 與 Streaming 規劃

## 更新日期

2026-04-04

## 目的

本文件用來整理 TeleNexus 從「CLI 純文字輸出」演進到「結構化輸出 / 逐行事件流」的可行方案，作為後續整體追蹤與分階段實作依據。

本次重點不是直接改完所有聊天路徑，而是先建立共同理解：

- 哪些 provider 已支援 JSON / event stream
- 目前程式架構卡在哪裡
- 真正值得先做的最小切入點是什麼
- 後續若要做 Web / Telegram 的 streaming，應怎麼分階段落地

## 現況摘要

目前 TeleNexus 雖然有 Web SSE 與 Telegram placeholder/edit 能力，但 provider 回應主軸仍是「收斂成一段最終文字」。

實際上目前資料流大致是：

- provider CLI 輸出 `stdout/stderr`
- provider adapter 清洗後回傳 `string`
- runner 回傳 `{ output: string }`
- `DynamicAIAgent` 只消費 `string`
- connector 只負責送出 `text`

因此，即使底層 CLI 已能輸出 JSON，現況也會在中間層被扁平成純文字。

## 本次實測結果

### Gemini

實測命令：

```bash
gemini -p "請只回答 OK" --output-format json
gemini -p "請只回答 OK" --output-format stream-json
```

結果：

- `--output-format json`
  - 輸出為單一 JSON 物件
  - 主要欄位：
    - `session_id`
    - `response`
    - `stats`
- `--output-format stream-json`
  - 輸出為 line-delimited JSON event stream
  - 已觀察到事件：
    - `init`
    - `message`（`role=user`）
    - `message`（`role=assistant`，帶 `delta: true`）
    - `result`

判斷：

- 若目標是先把目前 `string` 路徑升級成「結構化但仍回文字」，Gemini 的 `json` 最容易先接
- 若目標是做真 streaming，Gemini 的 `stream-json` 比較適合

### Opencode

實測命令：

```bash
opencode run --format json "請只回答 OK"
```

結果：

- 輸出為 line-delimited JSON event stream
- 已觀察到事件：
  - `step_start`
  - `text`
  - `step_finish`

判斷：

- Opencode 的 `json` 比較接近 Gemini 的 `stream-json`
- 它不是單一 final JSON object，必須逐行 parse 事件後才能組裝最終文字與 metadata

## 目前架構的主要限制

以下幾個位置都把 provider 結果視為 `string`：

- `src/core/process-runner.ts`
  - 只回傳 `{ stdout, stderr }`
- `src/core/gemini.ts`
  - `chat()` / `summarize()` 都回 `Promise<string>`
- `src/core/opencode.ts`
  - `chat()` / `summarize()` 都回 `Promise<string>`
- `src/runner.ts`
  - `/run` 回傳 `{ provider, output: string }`
- `src/core/agent.ts`
  - `RunnerResponse.output?: string`
- `src/types/index.ts`
  - connector 介面只有 `sendMessage(chatId, text)` / `editMessage(..., newText)`

這代表若直接把 CLI 改成 `--json`：

- 最輕則 JSON 會被當文字處理
- 稍重則需要 provider-specific parser
- 若要做 streaming，還要新增事件型介面，不適合直接硬塞進既有 `chat(): Promise<string>`

## 對互動體感的影響

### Web

Web 目前的 `/api/chat/stream` 並不是真正把 provider output 即時推到前端。

現況是：

- 先等 `handleWebMessage()` 完成
- 再把完整 reply 切成 chunks
- 用 SSE 模擬流式輸出

因此若改為 provider 逐行事件流，Web 端體感會有明顯提升：

- 更早看到第一段回覆
- 長回覆時等待焦慮降低
- 可在中途顯示 tool / step 狀態，而不只是固定的 `Thinking...`

### Telegram

Telegram 可以利用既有 placeholder/edit 能力做漸進更新，但不能照 token 級別直接更新，否則會遇到：

- rate limit 壓力
- 訊息一直閃動
- Markdown/格式化在半句更新時容易壞掉

較務實的做法是：

- 先送 placeholder
- 對增量文字做節流（例如 500ms 到 1500ms）
- 以「累積後更新」取代「每個 token 更新」

## 建議的目標狀態

不要讓上層直接理解 Gemini / Opencode 的原生事件 schema，應在 provider adapter 與 connector 之間加一層標準化事件。

建議內部事件模型：

```ts
type AgentEvent =
  | { type: 'start'; provider: 'gemini' | 'opencode' }
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; stats: unknown }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };
```

同時保留一個適合非 streaming 路徑的統一結果：

```ts
type AgentStructuredResult = {
  text: string;
  provider: 'gemini' | 'opencode';
  raw?: unknown;
  stats?: unknown;
  events?: unknown[];
};
```

這樣可以把問題拆成兩層：

- provider adapter 負責「CLI schema -> TeleNexus 標準事件 / 標準結果」
- runner / web / telegram 只負責「標準事件怎麼呈現」

## 分階段落地建議

### Phase 1: 結構化但不 streaming

目標：

- 先讓內部拿得到 JSON / stats / events
- 外部回覆仍以最終文字為主
- 盡量不打斷既有 Telegram / scheduler / memory 路徑

建議做法：

- Gemini 先改用 `--output-format json`
- Opencode 先保留現況，或只在實驗路徑做 event parser
- provider 回傳 `AgentStructuredResult`
- runner response 擴充為：
  - 保留 `output`
  - 可選加上 `structured`
- 既有 connector 仍只顯示 `structured.text`

為什麼先做這一層：

- 風險最小
- 可以先提升 observability
- 可以更清楚保留 token usage / session id / raw event
- 後續要做 streaming 時，不需要再重拆 provider parser

### Phase 2: Web 真 streaming

目標：

- 讓 `/api/chat/stream` 改成真正的 provider-driven SSE

建議做法：

- 新增 `streamChat()` 路徑，不直接破壞既有 `chat(): Promise<string>`
- Web stream endpoint 改吃 `AgentEvent`
- 先只接 Gemini
- 完成後再接 Opencode

理由：

- Web 是最適合 streaming 的通道
- 不受 Telegram edit rate limit 約束
- 可以最快驗證事件模型是否合理

### Phase 3: Telegram 節流式 streaming

目標：

- 使用 placeholder + edit 提升 Telegram 體感
- 避免 token 級更新造成噪音與風險

建議做法：

- connector 層新增節流更新器
- 將 `delta` 事件累積後再定時 edit
- 僅在完成時送最終完整版本
- 必要時保留 fallback：若 streaming 失敗，改回一次性最終訊息

### Phase 4: 統一觀測與除錯資料

目標：

- 在 runner audit / status / web diagnostics 中保留 provider 結構化資訊

可追蹤內容：

- provider session id
- 使用 token / latency
- event count
- 首字出現時間
- 完成時間
- streaming 是否 fallback

## 不建議的做法

以下做法看似快，但長期維護成本高：

- 直接把所有 `stdout` JSON 當文字塞進 `output`
- 讓 Web / Telegram 直接理解 Gemini 或 Opencode 的原生事件格式
- 一次把 Gemini、Opencode、Web、Telegram 全部改成 streaming
- 直接把 streaming 寫死在既有 `chat(): Promise<string>` 裡，導致所有呼叫端被迫同步改寫

## 風險與注意事項

### 1. Provider schema 可能隨版本變動

- Gemini / Opencode CLI 的 JSON 結構不是 TeleNexus 自己控制的 API contract
- parser 必須做防禦性處理，不能假設欄位永遠完整

### 2. 錯誤處理邏輯需要重看

目前部分錯誤判斷依賴純文字特徵，例如：

- `invalid argument`
- `compress`
- `stderr` 中的壓縮失敗訊號

導入 JSON / stream 後，錯誤訊息來源可能分散在：

- `stderr`
- event stream
- 非 0 exit code 前的 partial stdout

### 3. Streaming 與 summarize / memory sync 是不同問題

- summarize 比較適合 final structured result，不一定需要 streaming
- chat 才是最需要 streaming 的主戰場
- 不要把兩條路一次綁死在同一套新介面

### 4. Connector 能力差異不能忽略

- Web 適合真 SSE
- Telegram 適合節流式 edit
- scheduler / background 任務可能根本不需要 streaming

## 建議優先順序

若以「投資報酬比」排序，建議優先順序如下：

1. Gemini `json` 結構化接入
2. 統一 `AgentStructuredResult`
3. Gemini Web streaming
4. Opencode event parser
5. Telegram 節流式 streaming
6. runner / audit metadata 擴充

## 驗收方向

### Phase 1 驗收

- Gemini provider 能穩定 parse `--output-format json`
- 失敗時可 fallback 到既有 text 路徑
- runner / agent / connector 既有文字回覆不退化

### Phase 2 驗收

- Web `/api/chat/stream` 能在模型完成前先看到增量內容
- SSE 斷線 / provider 中斷時能正確送出 `error` 或 `done`
- 非 streaming endpoint 仍保持相容

### Phase 3 驗收

- Telegram placeholder 能穩定更新
- 不會出現過度頻繁 edit
- 最終訊息與非 streaming 版本內容一致

## 相關檔案

- `src/core/process-runner.ts`
- `src/core/gemini.ts`
- `src/core/opencode.ts`
- `src/core/agent.ts`
- `src/runner.ts`
- `src/web/server.ts`
- `src/connectors/telegram.ts`
- `src/core/message-pipeline-helpers.ts`
- `docs/cli-session-integration.md`

## 建議追蹤方式

後續若開始實作，建議以這份文件作為主入口，並另外拆出：

- implementation plan：列出實作步驟與影響檔案
- validation report：記錄不同 provider / endpoint 的實測結果
- rollout note：記錄是否先開在 Web-only 或特定 provider

在正式開始改 code 前，建議先做一個決策：

- 這次先做「結構化結果」
- 還是直接做「Web-only 真 streaming」

若沒有額外需求，建議順序是先結構化、再 Web streaming。
