# Current Chat Prompt

本文件描述目前 TeleNexus 一般聊天 prompt 的組裝方式。實際來源以程式碼為準：

- `src/main.ts`
- `src/prompt/builder.ts`
- `src/core/prompt-build.ts`
- `src/config/ai-config.ts`

## 1) Prompt 組裝不是固定單一模板

目前聊天 prompt 依訊息情境分成四種模式：

- `full`
  - 週期性注入完整 system prompt、工作區規則、檔案回傳協議、SAR 記憶內容
- `compact`
  - 延續既有 session 規則，只在必要時補 memory context
- `minimal`
  - 極短 follow-up，不重複大段 system prompt
- `passthrough`
  - 命中 `passthrough_commands` 時，直接把原始 slash command 傳給底層 CLI

## 2) 一般對話 Prompt（full / compact / minimal）

### `full`

主要結構：

```text
System: <來自 ai-config.yaml 的 role_system>

現在已經開啟了 YOLO 模式，你的所有工具調用都會被自動允許。

請用<language>回應。

【知識管理 - 重要】
<來自 chat_prompt.memory_policy_lines 的條列>

【工作目錄限制 - 重要】
<來自 chat_prompt.workspace_policy_lines 的條列>

【可用能力提示】
<僅在 Memoria 可用且需要時注入>

【檔案回傳協議】
<workspace/temp/ + [[SEND_FILE: ...]] 規則>

【SAR 使用規則】
<僅在 memory context 存在時注入>

<核心決策回顧 / 相關歷史摘要 / 最近對話等 memory context>

User Message:
<user input>

AI Response:
```

### `compact`

重點差異：

- 仍保留 `System: ...`
- 不再重複 YOLO notice、memory policy、workspace policy、檔案回傳協議
- 會加一段「延續目前對話 Session 的既有規則」
- 只有在判定使用者問題需要歷史規則、決策、設定時才注入 memory context

### `minimal`

重點差異：

- 不放 `System: ...`
- 不放 memory policy / workspace policy / file return policy
- 僅保留「延續目前對話 Session 與最近一次系統規則」的短提示

## 3) `passthrough` 流程

當訊息命中 `ai-config.yaml` 的 `passthrough_commands`，例如：

- `/compress`
- `/compact`
- `/clear`

TeleNexus 不會包裝一般聊天 prompt，而是直接把原始指令送給 provider CLI。

補充：

- Gemini / Opencode 之間會在必要時做 `/compress` 與 `/compact` 的指令改寫
- `forceNewSession` 啟用時，不會接續既有 CLI session

## 4) 記憶注入現況

目前不是「固定注入最近 15 則歷史」。

現在的做法是：

- prompt mode 決定是否需要注入記憶
- 記憶內容由 TeleNexus 自己的 memory/SAR retrieval 組裝
- 內容可能包含：
  - 核心決策回顧
  - 相關歷史摘要
  - 最近對話
- 若 Memoria 可用，會額外注入 capability hint，提醒模型可輸出 `[[MEMORY_INTENT:...]]` 給系統觀測

## 5) 配置來源

一般聊天 prompt 的可調整部分來自 `ai-config.yaml`：

```yaml
chat_prompt:
  language: zh-TW
  role_system: |
    你是 TeleNexus，一個具備強大工具執行能力的本地 AI 助理。
  yolo_notice_enabled: true
  memory_policy_enabled: true
  workspace_policy_enabled: true
  include_ai_response_suffix: true
  memory_policy_lines:
    - ...
  workspace_policy_lines:
    - ...
```

## 6) 以哪裡為準

若文件與程式碼不一致，以下優先順序較可靠：

1. `src/prompt/builder.ts`
2. `src/core/prompt-build.ts`
3. `src/config/ai-config.ts`
4. `ai-config.yaml`
5. 本文件
