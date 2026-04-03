# Prompt / Session Injection Implementation Plan

這份文件定義 TeleNexus 在「Telegram / Local Web 殼層」上，如何調整 prompt 注入策略，減少每回合重複灌入大段 system/context，同時保留對外部 CLI session 的治理能力。

它的角色是 implementation plan，不是現況說明。

- 想看現行 prompt 組裝：`src/prompt/builder.ts`
- 想看現行 session 整合：`docs/cli-session-integration.md`
- 想看 runtime 邊界：`docs/runtime-boundary-and-security.md`

## 背景

目前系統已透過外部 CLI session 維持對話連續性：

- Gemini 使用 `-r`
- Opencode 使用 `-c`

但殼層目前仍會在多數非 passthrough 對話中，持續重建 prompt：

- `src/core/message-pipeline-chat.ts` 以 `full` / `compact` 模式決定 prompt 包裝
- `src/prompt/builder.ts` 在 `compact` 模式下仍會注入 `System`、語言規則、以及 `memoryContext`
- `CHAT_FULL_PROMPT_EVERY` 只是降低 full prompt 頻率，沒有真正降低每回合重送 context 的比例

這代表目前是「CLI native session + shell reinjection」的混合模式，但 reinjection 仍偏重。

## 問題陳述

目前殼層有三個主要問題：

1. 每回合 prompt 重複度高，浪費 token / latency / session 空間
2. `compact` 與 `full` 的差異仍不夠大，無法充分利用 CLI 原生 session
3. 缺少足夠 observability，無法量化「這次到底送了多少殼層 context」

## 目標

本輪目標不是把殼層改成完全依賴 CLI session，也不是重做 agent runtime。

本輪只做三件事：

1. 讓殼層 prompt mode 從 `full / compact` 升級成 `full / compact / minimal`
2. 讓 `memoryContext` 與政策區塊改成「必要時才注入」
3. 補上 request 級別的 prompt/session observability

## 非目標

- 不重做 `src/core/gemini.ts` / `src/core/opencode.ts` 的底層 CLI 呼叫方式
- 不實作完整多 agent coordinator-worker 架構
- 不移除 shell 對 session 的所有治理能力
- 不把殼層所有規則只在 `/new` 時注入一次

## 核心判斷

### 為什麼不建議只在 `/new` 注一次

若只在 `/new` 時注入完整 prompt，後續完全依賴 `-r` / `-c`：

- session 漂移時，殼層無法重新校正
- provider 間 session 穩定度不一致，行為會變黑箱
- SAR 與檔案回傳規則會變成只在開場有效
- Web / Telegram / Scheduler 入口更難維持一致體感

因此本輪策略是：

- 不做「只在 new 注一次」
- 改做「只在必要時重送較重的殼層 context」

## 目標狀態

### Prompt mode

新增第三種模式：

1. `full`
2. `compact`
3. `minimal`

### 各模式責任

#### `full`

使用時機：

- 新 session
- 明確 `/new`
- provider fallback / recovery 後
- topic drift 明顯
- 週期性 re-anchor

內容：

- 完整 `System`
- 語言規則
- memory / workspace policy
- file return 協議
- `SAR 使用規則`
- `memoryContext`
- user message

#### `compact`

使用時機：

- 延續中的一般多輪對話
- session 健康
- topic 未明顯改變
- 但仍需要保留少量 shell reminder

內容：

- 簡短 session reminder
- 簡短語言提醒
- 視需要注入精簡版 `memoryContext`
- user message

#### `minimal`

使用時機：

- 同主題連續追問
- 前一輪剛剛 full 或 compact 完成
- session 健康且未 fallback
- 無需再次 SAR 校正

內容：

- 最短 session reminder 或完全不加 reminder
- user message

關鍵原則：

- `minimal` 預設不注入 `memoryContext`
- `compact` 不應每回合都帶完整 `memoryContext`

## 實作原則

- 先改決策層，再改 prompt 內容層
- 先補 observability，再根據資料調校閾值
- 不依賴高風險 heuristic；先用可解釋、可測試的規則
- 優先維持殼層對 session 的控制權，而不是追求極端省 token

## 實作範圍

### 1. Prompt mode 決策層

檔案：`src/core/message-pipeline-chat.ts`

要做的事：

- 將 `buildPrompt(..., mode)` 的 mode 擴成 `full | compact | minimal`
- 在 `preparePromptForAgent()` 中把判斷改成顯式 policy，而不是只靠 counter
- 將 mode 選擇原因結構化記錄，例如：
  - `new-session`
  - `periodic-full`
  - `topic-drift`
  - `post-fallback-reanchor`
  - `recent-followup-minimal`

建議新增概念：

- `PromptMode`
- `PromptSelectionResult`
- `PromptSelectionReason`

最小版 heuristic 建議：

1. 若 `forceNewSession` 為 true，使用 `full`
2. 若最近一次執行發生 fallback / recovery，使用 `full`
3. 若使用者訊息很短且像 follow-up，優先 `minimal`
4. 若 counter 命中週期校正，使用 `full`
5. 其餘使用 `compact`

### 2. Prompt 組裝層

檔案：`src/prompt/builder.ts`

要做的事：

- `buildChatPrompt()` 支援 `minimal`
- `compact` 與 `minimal` 對 `memoryContext` 採不同注入策略
- 把「穩定規則」與「依查詢決定的 SAR context」邏輯拆開

建議切分：

- `system block`
- `shell policy block`
- `sar guidance block`
- `memory context block`
- `user message block`

最小版策略建議：

- `full`: 帶所有 block
- `compact`: 不帶 workspace/file 協議；僅在條件命中時帶 SAR block + memory block
- `minimal`: 不帶 memory block，只送最短 reminder + user message

### 3. Shell observability

檔案：

- `src/core/message-pipeline.ts`
- `src/services/context-snapshots.ts`
- 視需要擴充 `src/utils/errors.ts` 或新增輕量 metrics buffer

要記錄的資料：

- `requestId`
- `channel` (`telegram` / `web` / `scheduler`)
- `provider`
- `runner/local`
- `promptMode`
- `promptSelectionReason`
- `memoryContextLength`
- `memoryContextSectionCount`
- `usedMemoryContext`
- `forceNewSession`
- `fallbackOccurred`
- `durationMs`

完成後至少要能回答：

- 哪些對話其實可以用 `minimal`
- `compact` 還剩多少冗餘
- `full` 是否過於頻繁

### 4. Web console 狀態揭露

檔案：`src/web/server.ts`

本輪不需要大改 UI，但建議最小補上：

- 最近一次 prompt mode
- 最近一次 provider / runner 路徑
- 最近一次是否 fallback
- 最近一次是否 force new session

目的不是做完整 dashboard，而是讓殼層狀態對操作者可見。

## 建議實作步驟

### Phase 1 - Instrument first

目標：

- 不改既有 prompt 行為，先量化現況

步驟：

1. 在 message pipeline 產生 `requestId`
2. 記錄 prompt mode、memory context 長度、runner/local、duration
3. 將最近 N 次結果寫入 context snapshot 或 in-memory buffer

完成標準：

- 可以明確知道 full / compact 比例
- 可以看出 compact 是否仍然太重

### Phase 2 - Introduce `minimal`

目標：

- 將最明顯的 follow-up 場景切到 `minimal`

步驟：

1. 擴充 mode type
2. 更新 `preparePromptForAgent()`
3. 為 `minimal` 實作最小 prompt 組裝

完成標準：

- 同主題連續短追問不再注入完整 SAR
- 行為不影響 `/new`、passthrough、fallback 場景

### Phase 3 - Conditional SAR injection

目標：

- `compact` 不再預設攜帶完整 `memoryContext`

步驟：

1. 建立是否需要 memory reinjection 的條件
2. 將 `buildChatPrompt()` 改成條件式帶入 memory block
3. 補 regression tests

完成標準：

- `compact` 與 `minimal` 的差異足夠明顯
- 中短對話的 prompt 長度可明顯下降

### Phase 4 - Tune policy by data

目標：

- 根據真實對話資料微調 full cadence 與 minimal 觸發規則

步驟：

1. 觀察 full/compact/minimal 比例
2. 觀察 fallback 前後的 mode 分布
3. 調整 `CHAT_FULL_PROMPT_EVERY` 與 minimal 條件

完成標準：

- prompt 長度下降
- session 穩定度不明顯退化
- 使用者體感沒有變差

## 測試計畫

### 單元測試

建議新增或擴充：

- `tests/message-pipeline.test.ts`
- `tests/prompt-builder.test.ts`

至少覆蓋以下 case：

1. 新 session 使用 `full`
2. 一般 follow-up 使用 `minimal`
3. `compact` 可在無需 SAR 時不帶 memory block
4. fallback 後下一輪會 re-anchor 為 `full`
5. passthrough command 不受新 mode 影響

### 手動驗證

1. Telegram 連續三輪短追問，確認第二、三輪不再重送大段 context
2. Local Web 連續追問，確認 session continuity 仍正常
3. `/new` 後確認回到 `full`
4. 人工製造 runner fallback，確認下一輪有 re-anchor
5. 問明顯新 topic，確認會重新注入較完整規則與 SAR

## 風險

### 風險 1 - 過度依賴 CLI session

若 `minimal` 比例太高，可能造成：

- shell 規則失效
- file send 協議遺失
- SAR 長期記憶不再被帶入

對策：

- 保留週期性 `full`
- fallback 後強制 re-anchor
- 新 topic 強制升級 prompt mode

### 風險 2 - topic drift 判斷過於粗糙

若 heuristic 太簡單，可能錯把新主題當 follow-up。

對策：

- 第一版先保守
- 只讓明顯短追問進 `minimal`
- 先上 observability 再調整規則

### 風險 3 - provider 行為差異

Gemini 與 Opencode 的 session 穩定度可能不同。

對策：

- 將 prompt mode 與 provider 一起記錄
- 若需要，可後續做 provider-specific policy

## 成功指標

本輪成功不以「完全不再重複 prompt」定義，而以下列指標判斷：

1. `minimal` 能覆蓋一部分連續追問場景
2. 平均 prompt 長度下降
3. `compact` 模式中帶入完整 `memoryContext` 的比例下降
4. fallback / session 漂移的錯誤率沒有明顯上升
5. Web / Telegram 對話體感維持穩定

## 建議後續文件更新

本計畫若開始實作，建議同步更新：

- `docs/cli-session-integration.md`
- `docs/configuration-reference.md`
- `docs/web-console-reference.md`

## 一句話摘要

TeleNexus 這一輪不是要把 shell 完全交給 CLI session，而是要把 shell prompt 從「每回合重送很多」收斂成「必要時才重送」，讓 session continuity 與 shell governance 取得較好的平衡。
