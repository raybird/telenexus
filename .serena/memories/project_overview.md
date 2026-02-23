# Moltbot Lite 專案概述

## 專案目的
Moltbot Lite 是一個輕量級、具備強大工具執行能力的本地 AI 助理。它整合了 Telegram 作為使用者介面，並利用系統上的 `gemini` CLI 作為其核心邏輯與工具執行引擎。

## 核心特性
- **YOLO 模式**: 自動執行 AI 請求的工具（搜尋、檔案操作、指令執行）。
- **Stream UX**: 在 Telegram 上使用 "Thinking..." 佔位訊息，隨後更新為完整回應，提供流暢的體驗。
- **記憶管理**: 透過 SQLite 持久化對話紀錄，確保跨 Session 的上下文一致性。

## 代碼結構
- `src/main.ts`: 程式進入點，初始化各個元件並定義訊息處理工作流。
- `src/connectors/`: 包含與外部平台連接的類別。目前僅有 `telegram.ts`。
- `src/core/`:
    - `gemini.ts`: 封裝對 `gemini` CLI 的呼叫邏輯。
    - `memory.ts`: 管理對話歷史與上下文。
- `src/types/`: 定義專案中使用的 TypeScript 介面與型別。
- `src/tools/`: 預留給自定義工具的目錄。
