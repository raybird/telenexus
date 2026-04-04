# Telegram Streaming Design

這份文件聚焦在 TeleNexus 的 Telegram 節流式 streaming 設計。

它不是整體 CLI streaming 規劃，而是把 Telegram 這個通道需要的節流頻率、更新策略、fallback 規則與驗收案例細化到可直接實作的程度。

- 整體策略：`docs/cli-structured-output-streaming-plan.md`
- 整體 implementation plan：`docs/cli-structured-output-streaming-implementation-plan.md`

## 目的

在不破壞 Telegram 穩定性的前提下，讓使用者在長回覆期間能更早看到內容，降低等待感。

目標不是做 token-by-token，而是做「節流式、可回退、可維持格式穩定」的增量更新。

## 現況

目前 Telegram 相關行為如下：

- `src/core/message-pipeline-helpers.ts`
  - `ThinkingMessenger` 會先送 placeholder
  - 每 `3000ms` edit 一次 thinking 文字
- `src/connectors/telegram.ts`
  - `sendPlaceholder()` 用來送出初始訊息
  - `editMessage()` 會先 edit 第一段內容
  - 若內容超過 Telegram 單訊息長度，剩餘內容會改用新訊息送出
  - 若 parse mode 失敗，會 fallback 到 plain text
  - 若 edit 失敗，可能 fallback 成直接 `sendMessage()`

這代表 Telegram 不是沒有更新能力，而是現況只適合「placeholder -> 最終一次性完成」，還不適合真增量內容流。

## 核心判斷

Telegram 不適合照 Web 那樣每個 `delta` 都立即推送，原因包括：

- 容易觸發 Telegram rate limit 或暫時失敗
- 訊息會頻繁閃動，體感反而變差
- 中途更新若帶 markdown/html，格式失敗機率高
- 長訊息 edit 與 chunk-splitting 的邊界較複雜

因此 Telegram 的正確方向是：

- provider / runner 層仍維持真 streaming
- Telegram connector 層採用節流式渲染

## 設計原則

1. 不做 token-by-token update
2. 中途更新只更新同一則 placeholder
3. 中途更新預設使用 plain text，不套 parse mode
4. 完成後才進入最終格式化與 chunk-splitting
5. 任一 edit 失敗時可退回 final-only 模式
6. 以「穩定 + 清楚」優先於「極致即時」

## 使用者體感目標

希望呈現的感覺是：

- 使用者送出訊息後，很快看到 `思考中`
- 模型開始產出時，placeholder 轉成「回覆中」並逐步長大
- 長回覆時，每隔一小段時間看到新的內容被補進去
- 完成後聊天室只留下乾淨、完整、可閱讀的最終訊息

不希望呈現的感覺是：

- 每個字都跳一下
- 訊息一直閃爍重排
- 半成品 markdown 斷掉
- 最後聊天室多出很多重複訊息

## 推薦節流策略

### 預設建議值

目前實際採用的平衡配置：

- `editThrottleMs = 1000`
- `minDeltaChars = 40`
- `forceFlushMs = 2500`
- `earlyFlushChars = 120`

補充：

- 這組值是根據實際 Telegram 體感微調後的設定
- 目標是比初版 `1200 / 60 / 3000 / 180` 更有即時感，但避免像積極 preset 那樣過度頻繁更新

### 各參數含義

- `editThrottleMs`
  - 兩次 edit 之間的最短間隔
  - 作用：避免過度頻繁更新
- `minDeltaChars`
  - 自上次成功 render 後，至少新增多少字才值得更新
  - 作用：避免只多出幾個字就 edit 一次
- `forceFlushMs`
  - 即使新增字數還不多，也不能超過多久不更新
  - 作用：避免使用者看到太久沒動靜
- `earlyFlushChars`
  - 若短時間內累積大量內容，可提前更新
  - 作用：讓長回覆時的體感更即時

### 三種可選 preset

保守：

- `1500ms / 80 chars / 3500ms / 220 chars`

平衡：

- `1000ms / 40 chars / 2500ms / 120 chars`

積極：

- `800ms / 40 chars / 2500ms / 140 chars`

建議第一版先上平衡 preset。

## 目前落地狀態

截至本輪實作，Telegram 節流式 streaming 已落地，並具備以下能力：

- Telegram chat 路徑可啟用節流式 streaming
- 中途更新強制使用 plain text
- 完成時會以 final text 對齊 placeholder
- 若內容過長，會退為 `完成提示 + 分段送出`
- 若 edit 連續失敗達門檻，會停用 streaming edit 並退回 final-only
- 已補 runtime log 便於之後追查體感退化

目前相關環境變數：

```text
TELEGRAM_STREAMING_ENABLED=true
TELEGRAM_STREAM_EDIT_THROTTLE_MS=1000
TELEGRAM_STREAM_MIN_DELTA_CHARS=40
TELEGRAM_STREAM_FORCE_FLUSH_MS=2500
TELEGRAM_STREAM_EARLY_FLUSH_CHARS=120
TELEGRAM_STREAM_MAX_EDIT_FAILURES=3
```

目前關鍵 runtime log：

- `stream.started`
- `stream.first-delta`
- `stream.flush`
- `stream.finalizing`
- `stream.finalized-via-edit`
- `stream.finalized-via-send`
- `stream.failed`

## 狀態機設計

建議新增一個 Telegram 專用 renderer，例如：

```ts
type TelegramStreamRenderer = {
  start(): Promise<void>;
  onStatus(text: string): Promise<void>;
  onDelta(text: string): Promise<void>;
  finish(finalText: string): Promise<void>;
  fail(message: string): Promise<void>;
};
```

### 狀態

1. `idle`
2. `thinking`
3. `streaming`
4. `finalizing`
5. `completed`
6. `failed`

### 狀態轉移

#### idle -> thinking

- 收到聊天請求
- 先送 placeholder，例如：`🤔 思考中...`

#### thinking -> streaming

- 收到第一個 `delta`
- placeholder 改成：

```text
✍️ 回覆中...

<目前累積內容>
```

#### streaming -> streaming

- 收到更多 `delta`
- 但只有在節流條件成立時才真正 edit

#### streaming -> finalizing

- 收到 `done`
- 停止 timer
- 將最後累積內容與 final text 對齊

#### finalizing -> completed

- 若最終文字長度可由單一訊息承載
  - 直接把 placeholder 改成完整最終訊息
- 若最終文字過長
  - placeholder 改成簡短完成提示
  - 再用 `sendMessage()` 分段送出完整內容

#### 任意狀態 -> failed

- placeholder send 失敗
- edit 持續失敗
- Telegram API 回錯
- parse mode 失敗且 plain text fallback 也失敗

失敗處理：

- 盡量至少送一則完整 final text
- 若連最終送出也失敗，再退回 error log，不阻塞主流程

## 更新判斷規則

每次收到 `delta` 時，不要立即 edit，先只更新 buffer 與時間戳。

只有滿足以下任一條件才 flush：

1. 距離上次成功 edit 已超過 `editThrottleMs`，且新增字數 >= `minDeltaChars`
2. 距離上次成功 edit 已超過 `forceFlushMs`
3. 自上次成功 edit 以來，新增字數 >= `earlyFlushChars`
4. 收到 `done`

可用概念式邏輯表示：

```ts
shouldFlush =
  deltaCharsSinceLastRender >= earlyFlushChars ||
  (now - lastRenderAt >= editThrottleMs && deltaCharsSinceLastRender >= minDeltaChars) ||
  now - lastRenderAt >= forceFlushMs ||
  event.type === 'done';
```

## 顯示策略

### Streaming 中途顯示

中途更新建議一律使用 plain text，不套 HTML / Markdown。

建議形式：

```text
✍️ 回覆中...

<目前全文>
```

理由：

- code block 尚未閉合時，不適合格式化
- markdown table 尚未完整時容易出錯
- 一旦 parse mode 失敗，edit 成本更高

### Final 顯示

完成後再走既有 Telegram formatting 流程：

- 若單則可承載：直接 edit placeholder 成最終版本
- 若超過單則上限：
  - placeholder 改成 `✅ 已完成，以下分段送出`
  - 之後呼叫既有 `sendMessage()` 進行 chunk-splitting 與格式化

## Placeholder 策略

建議第一版保留 placeholder 作為最終訊息容器，避免額外產生重複訊息。

### 推薦流程

1. `sendPlaceholder("🤔 思考中...")`
2. streaming 期間反覆 edit 同一則
3. 完成後：
   - 短訊息：直接把同一則改成 final text
   - 長訊息：同一則改為完成提示，再分段送出

### 不建議流程

- placeholder 一則
- streaming 中又不斷新增新訊息
- 完成時再額外送一則 final

這會讓聊天室過於雜亂。

## 失敗與 fallback 規則

### 1. placeholder 發送失敗

處理：

- 放棄 streaming 呈現
- 最後直接 `sendMessage(finalText)`

### 2. 單次 edit 失敗

處理：

- 記錄錯誤
- 不要立刻中止整個流程
- 下一次 flush 再試一次

### 3. 連續 edit 失敗達門檻

建議門檻：`3` 次

處理：

- 停止 streaming edit
- 切到 final-only 模式
- 等 `done` 後直接送最終訊息

### 4. parse mode 失敗

處理：

- streaming 過程本來就不該用 parse mode
- final 階段若 parse mode 失敗，退 plain text 即可

### 5. 訊息超長

處理：

- streaming 中 placeholder 只維持目前可安全顯示的內容
- `done` 時由既有 `sendMessage()` chunk-splitting 接手最終多段輸出

### 6. provider / runner 中途失敗

處理：

- placeholder 改成：`⚠️ 生成中斷`
- 若已有部分可讀內容，可視情況保留部分內容
- 若不想留下半成品，直接顯示錯誤提示並停止

建議第一版採保守策略：

- 不保證保留半成品
- 以清楚錯誤提示優先

## 建議設定項目

可考慮新增以下環境變數：

```text
TELEGRAM_STREAMING_ENABLED=true
TELEGRAM_STREAM_EDIT_THROTTLE_MS=1200
TELEGRAM_STREAM_MIN_DELTA_CHARS=60
TELEGRAM_STREAM_FORCE_FLUSH_MS=3000
TELEGRAM_STREAM_EARLY_FLUSH_CHARS=180
TELEGRAM_STREAM_MAX_EDIT_FAILURES=3
```

目的：

- 方便先灰度開啟
- 能針對實際聊天體感微調
- 不需要每次改碼才調整節流參數

## 與現有程式的對接點

### 主要檔案

- `src/connectors/telegram.ts`
- `src/core/message-pipeline.ts`
- `src/core/message-pipeline-helpers.ts`
- 視需要新增：
  - `src/core/telegram-stream-renderer.ts`

### 建議責任分工

#### `message-pipeline.ts`

- 判斷這次是否啟用 Telegram streaming
- 將 `AgentEvent` 導向 Telegram renderer

#### `telegram-stream-renderer.ts`

- 負責 buffer、節流、狀態機、fallback
- 不直接理解 provider schema，只吃 `AgentEvent`

#### `telegram.ts`

- 維持為底層 transport / formatting / chunking 能力
- 不把節流邏輯寫死在 connector 內部

#### `ThinkingMessenger`

- 仍保留給非 streaming 路徑
- Telegram streaming 開啟時，不再使用輪播 thinking edit

## 第一版實作建議

### 範圍

- 只針對 Telegram chat 路徑
- scheduler / summarize / background 任務不做 streaming
- streaming 中途只做 plain text edit
- final 階段沿用既有 `editMessage()` / `sendMessage()`

### 實作順序

1. 抽出 Telegram stream renderer
2. 在 message pipeline 加入 Telegram streaming 分支
3. 啟用 `AgentEvent` -> renderer 映射
4. 完成後仍走既有 final delivery path
5. 補測試與 fallback 驗證

## 驗收案例

### Case 1: 短回覆

預期：

- placeholder 出現
- 可能只更新 1 次
- 最後同一則訊息直接變成完整回覆

### Case 2: 長回覆

預期：

- placeholder 逐步增長
- 更新頻率不會過高
- 完成時若超長，改成分段送出

### Case 3: 含 code block

預期：

- streaming 中途一律 plain text
- final 才套格式
- 不因半個 code fence 導致 edit 失敗

### Case 4: Telegram API 暫時失敗

預期：

- 單次 edit 失敗不致命
- 達門檻後退回 final-only
- 最終仍能把完整結果送出去

### Case 5: provider 中途錯誤

預期：

- placeholder 不會永遠停在 `思考中`
- 使用者能看到明確失敗訊息

## 開放決策

以下兩項在正式實作前最好先決定：

1. 是否要讓 placeholder 成為最終訊息本體
   - 建議：是
2. 長訊息完成時，是否保留 placeholder 內容作為摘要
   - 建議：保留簡短完成提示即可，不保留半成品全文

## 建議結論

若沒有額外產品需求，Telegram streaming 第一版建議採：

- 平衡 preset：`1200ms / 60 chars / 3000ms / 180 chars`
- 中途 plain text
- 完成時才格式化
- 連續 edit 失敗 `3` 次後退回 final-only
- placeholder 優先作為最終訊息容器

這條路能在「互動體感改善」與「Telegram 穩定性」之間取得比較好的平衡。
