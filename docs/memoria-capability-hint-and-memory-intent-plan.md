# Memoria Capability Hint And Memory Intent Plan

這份文件定義 TeleNexus 如何在不把 `Memoria` 綁成硬依賴的前提下，讓外部 agent CLI 知道「長期記憶補強可用」，並在回合結束後提供可治理的 memory intent。

它是 implementation plan，不是現況說明。

- 想看目前 `Memoria` bridge：`src/core/memoria-sync.ts`
- 想看 prompt mode 設計：`docs/prompt-session-injection-implementation-plan.md`
- 想看 Claude Code 洩漏轉譯：`docs/claude-code-leak-shell-takeaways-2026-04-01.md`

## 背景

目前 TeleNexus 已有兩種記憶層：

1. `MemoryManager + SAR`
2. `MemoriaSyncBridge`

其中：

- `MemoryManager + SAR` 是殼層主記憶，負責高信號、可控、可注入的記憶治理
- `Memoria` 是外部長期記憶補強，透過 async bridge 同步 turn 資料

目前 `Memoria` 的特性：

- `on / off / auto` 可切換
- 找不到 CLI 時 `auto` 可自動 disable
- sync 失敗不阻斷主聊天流程
- 已有 hook queue 能力，但主要是資料同步，不是 prompt 決策

這代表 `Memoria` 很適合被定義成 optional auxiliary memory，而不是 primary prompt memory。

## 問題陳述

目前系統雖然能把 turn 同步到 `Memoria`，但 agent CLI 本身並不知道：

- `Memoria` 是否可用
- 什麼時候應把當前回合視為長期記憶候選
- 什麼時候只應留在短期 session

如果完全不提示 agent：

- agent 不知道有額外長期記憶層存在
- agent 不會主動以「可重用規則 / 決策」格式輸出高價值內容

如果每回合都重提示 agent：

- prompt 會變重
- `minimal` 模式失去意義
- 會把 `Memoria` 從 optional capability 錯誤升格成核心依賴

## 目標

本輪目標是建立一套可治理的雙階段機制：

1. pre-prompt capability hint
2. post-response memory intent

## 非目標

- 不讓 agent 直接決定是否寫入 `Memoria`
- 不讓 `Memoria` 成為每回合 prompt 的固定內容
- 不把 `Memoria` 直接當成主記憶檢索來源
- 不把現有 `MemoriaSyncBridge` 改造成主流程阻斷式元件

## 核心設計原則

1. `Memoria` 是 optional auxiliary memory
2. 主記憶治理仍由 TeleNexus 殼層掌控
3. agent 可以感知能力，但不應掌控執行
4. 先觀測 memory intent 品質，再決定是否自動採納

## 目標狀態

### 一、Pre-Prompt Capability Hint

在送 prompt 給 agent CLI 前，殼層依條件插入一小段 `Memoria capability hint`。

這段提示的目的不是要求 agent 每回合都去使用 `Memoria`，而是告知：

- 若任務涉及跨 session 歷史、長期規則、重用決策
- 目前系統可用長期記憶補強能力
- 但若不可用，仍應以當前 session 與 TeleNexus 注入記憶為準

### 二、Post-Response Memory Intent

回合結束後，agent 可附帶一份簡短、結構化的 memory intent，表示它對本回合內容的記憶價值判斷。

這份 intent 是建議，不是命令。

最後是否：

- 寫入主記憶候選
- 只 archive 到 `Memoria`
- 忽略

都由 TeleNexus 殼層決定。

## 設計分層

### Layer 1 - Session Continuity

- Gemini `-r`
- Opencode `-c`

負責：

- 模型層連續對話
- 工具執行上下文

### Layer 2 - Primary Managed Memory

- `MemoryManager`
- `SAR`

負責：

- 高信號記憶
- prompt 注入治理
- 可控 retrieval

### Layer 3 - Auxiliary Long-Term Memory

- `Memoria`

負責：

- 完整歷史 archive
- 回填來源
- 輔助檢索候選

## Pre-Prompt Capability Hint 設計

### 何時注入

建議條件：

1. `Memoria` 可用且健康
2. prompt mode 不是 `minimal`
3. 本輪任務不像單純短追問
4. 最近 `Memoria` sync 沒有持續失敗

### 何時不要注入

1. prompt mode = `minimal`
2. `MEMORIA_SYNC_ENABLED=off`
3. `Memoria` CLI 不存在且 mode = `auto`
4. 最近 `memoria-sync` 連續失敗，需要先降級

### 提示內容原則

- 要短
- 要描述 capability，不描述內部實作細節
- 要明確說它是補強，不是唯一來源

### 建議提示語意

可用時：

- 若任務需要跨 session 歷史、長期規則或可重用決策，系統目前有額外長期記憶補強能力可配合；若不需要，仍以前回合 session 與 TeleNexus 已注入內容為主

不可用時：

- 不注入任何 `Memoria` 提示

## Post-Response Memory Intent 設計

### 目的

讓 agent 在不直接執行記憶寫入的前提下，給殼層一個高層判斷：

- 這輪是否值得長期記住
- 值得記住的是規則、決策，還是只是短期上下文

### 第一版策略

先做「intent 只記錄，不執行」。

也就是：

- agent 產生 intent
- TeleNexus 記錄到 telemetry / snapshot / debug log
- 不直接改 memory write 行為

### 建議 schema

```ts
type MemoryIntent = {
  level: 'none' | 'short-term' | 'long-term-candidate' | 'rule' | 'decision';
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  summary?: string;
};
```

### 欄位意義

- `none`: 不值得保留
- `short-term`: 只適合留在 session，不應長期保存
- `long-term-candidate`: 可能有長期價值，但需殼層審核
- `rule`: 明顯屬於穩定做法或 SOP
- `decision`: 明顯屬於重要決策或偏好

### 不建議的做法

- 讓 agent 自由文字直接命令「請寫入記憶」
- 讓 agent 直接觸發 `Memoria` CLI
- 將 memory intent 與最終記憶寫入綁死

## Hook 機制設計

### 這裡的 hook 不是 provider hook

本計畫中的 hook，指的是 TeleNexus 殼層中的兩個邏輯掛點：

1. prompt assembly hook
2. response assessment hook

### Hook A - Prompt Assembly Hook

掛點建議：

- `src/main.ts` 的 `buildPromptFn()` 前後
- 或 `src/prompt/builder.ts` 增加 capability block 組裝入口

責任：

- 判斷 `Memoria` 是否可用
- 判斷本輪 prompt mode
- 決定是否注入 capability hint

### Hook B - Response Assessment Hook

掛點建議：

- `src/core/message-pipeline.ts` 在收到 model response 之後
- 在 `persistModelResponse()` 與 `enqueueMemoriaSync()` 之間或附近

責任：

- 解析 agent 的 memory intent
- 記錄 telemetry
- 暫時不執行自動寫入決策

## 實作步驟

### Phase 1 - Capability Detection

目標：

- TeleNexus 能知道 `Memoria` 現在是否可用

建議做法：

1. 在 `MemoriaSyncBridge` 暴露只讀狀態
2. 提供簡單 health snapshot，例如：
   - enabled / disabled
   - mode
   - recent failure count
   - cli detected

完成標準：

- prompt 組裝邏輯能讀到一個乾淨的 `Memoria availability` 狀態

### Phase 2 - Pre-Prompt Hint

目標：

- 在 `full` / 部分 `compact` 條件式注入 capability hint

建議做法：

1. 在 prompt builder 增加可選 `capability block`
2. `minimal` 一律不加
3. 先只加很短的一段說明

完成標準：

- agent 知道有額外記憶補強層
- prompt 長度沒有大幅增加

### Phase 3 - Memory Intent Observation

目標：

- agent 可輸出結構化 memory intent

建議做法：

1. 在 prompt 中加入簡短約定：必要時附 memory intent
2. 在 response assessment hook 解析 intent
3. 只記錄，不執行

完成標準：

- 可以觀察 intent 命中率與品質
- 不會影響主回覆穩定性

### Phase 4 - Shell-Gated Adoption

目標：

- 只有在 intent 品質足夠好時，才考慮導入自動採納

建議做法：

1. 只讓 `rule / decision + high confidence` 進候選
2. 仍由 TeleNexus 決定寫到哪一層
3. 先從人工 review 或 debug-only 模式開始

完成標準：

- agent intent 有實際價值
- 不會污染主記憶

## 風險

### 風險 1 - 過度依賴 Memoria

若 prompt 太常提醒 `Memoria`，agent 可能把它視為必備能力。

對策：

- 只在條件式場景注入
- 強調它是補強，不是唯一來源

### 風險 2 - Agent 過度標記記憶

若 memory intent 太寬鬆，會把大量短期雜訊標成長期記憶候選。

對策：

- 第一版只觀測，不採納
- 要求 `reason + summary`

### 風險 3 - Hook 太早耦合主流程

若一開始就把 hook 做成同步依賴，會降低主聊天流程穩定性。

對策：

- 讓 capability 檢查與 intent 解析都可降級
- 不可用時直接略過

## 成功指標

1. prompt 不會因 `Memoria` 提示而明顯膨脹
2. `minimal` 模式仍保持輕量
3. agent 能產出少量但高信號的 memory intent
4. 主聊天流程不因 `Memoria` 狀態異常而退化

## 一句話摘要

TeleNexus 應讓 agent 感知 `Memoria` 是一個可選長期記憶補強能力，但記憶治理與最終採納權仍留在殼層；先做 capability hint，再做 intent observation，最後才考慮自動採納。
