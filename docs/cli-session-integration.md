# CLI Session 與 Runner 整合

## 更新日期

2026-04-03

## 現況摘要

TeleNexus 目前的 session continuity 主軸，已經不是單純「CLI 原生 session + 手動注入最近歷史」。

現在的實際模式是：

- chat 預設可走 `agent-runner`
- runner 內執行 Gemini / Opencode CLI
- TeleNexus 在 dispatch 前自行決定 prompt mode 與 memory injection
- provider CLI session 用來延續工具與對話狀態
- TeleNexus memory / SAR retrieval 用來補跨輪規則、決策與長期背景
- Memoria sync 是背景補強，不是主對話硬依賴

## 1) Session continuity 怎麼維持

### Gemini

- 一般 chat 會用 `gemini --yolo -r -p <prompt>`
- 若 `forceNewSession=true`，則不加 `-r`
- passthrough command 同樣可走 session，除非強制新 session

### Opencode

- 一般 chat 會用 `opencode run -c`
- 若 `forceNewSession=true`，則不加 `-c`

## 2) Runner 在這裡扮演什麼角色

`agent-runner` 的目的不是替代 provider，而是把真正的 CLI session 從 orchestrator 中抽離出來，讓聊天脈絡更穩定。

目前特性：

- 提供 `/run` HTTP API
- 支援 `chat` 與 `summarize`
- 可附帶 `provider`、`model`、`isPassthroughCommand`、`forceNewSession`
- 會寫 `runner-status.md` 與 `runner-audit.log`
- Gemini 可在 runner 內序列化執行，降低併發導致的 session 問題

## 3) TeleNexus memory 與 CLI session 的分工

請把它理解成兩套不同層次的脈絡系統：

- CLI session
  - 維持單一 provider 當前工作串的對話與工具狀態
- TeleNexus memory / SAR
  - 維持較穩定的規則、決策、歷史摘要、長期背景

所以現在不是「CLI session 取代所有記憶」，而是：

- session 負責連續性
- SAR 負責可治理的歷史回收

## 4) `/new` 的語意

`/new` 不會直接把所有資料庫清空，也不代表刪除 provider 端所有歷史檔。

目前語意是：

- 標記「下一則一般對話」強制使用新 session
- 實作上會讓 Gemini 不帶 `-r`，或讓 Opencode 不帶 `-c`
- TeleNexus 自己的記憶資料仍保留，是否注入則由 prompt mode 與 memory policy 決定

## 5) Provider 切換時會怎樣

當 `ai-config.yaml` 的 provider 從 Gemini 切到 Opencode，或反過來：

- provider CLI session 不會自動跨引擎共享
- 但 TeleNexus 的 memory / SAR 仍可把核心決策與歷史摘要重新注入
- 若 Memoria 可用，也可能提供額外長期背景補強

因此，跨 provider continuity 目前主要靠：

- TeleNexus prompt injection
- TeleNexus memory / summary
- 可選的 Memoria 補強

不是直接搬運 provider 原生 session 檔案

## 6) 風險與限制

- 若直接在 `telenexus` 容器裡手動跑 CLI，看到的 session 不一定是聊天實際使用的那一條
- 若 runner 掛掉，`DynamicAIAgent` 可能 fallback 到 local execution，造成 session 邊界暫時改變
- CLI session continuity 仍受 provider 自身穩定性影響，不能把它當成唯一記憶來源

## 7) 除錯建議

若要確認真實聊天 session 狀態，優先看：

1. `workspace/context/runtime-status.md`
2. `workspace/context/runner-status.md`
3. `workspace/context/prompt-session-status.md`
4. `workspace/context/memoria-status.md`

若要人工接續真實 CLI context，優先進 `agent-runner`：

```bash
docker compose exec agent-runner sh -lc "cd /app/workspace && gemini -r"
docker compose exec agent-runner sh -lc "cd /app/workspace && opencode run -c"
```

## 8) 相關檔案

- `src/core/agent.ts`
- `src/core/gemini.ts`
- `src/core/opencode.ts`
- `src/runner.ts`
- `docs/configuration-reference.md`
