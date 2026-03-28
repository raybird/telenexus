## 架構概覽

Moltbot Lite 由數個可替換的模組組成，核心目標是以 Telegram 作為入口，連接後端的 AI 提供者 (Gemini 或 Opencode)，並透過 SQLite 做記憶管理與排程執行。

### 模組責任
- `src/main.ts`：啟動流程、組裝依賴、訊息主流程。
- `src/core/agent.ts`：定義 `AIAgent` 介面與 `DynamicAIAgent` 代理機制，支援動態 Provider 切換。
- `src/core/gemini.ts`：封裝 `gemini-cli` 呼叫。
- `src/core/opencode.ts`：封裝 `opencode run` 呼叫。
- `src/core/memory.ts`：記憶儲存、摘要、與全文檢索。
- `src/core/scheduler.ts`：排程任務管理與執行。
- `src/connectors/telegram.ts`：Telegram 連接器與訊息格式轉換。

### 主要資料流
1. 使用者透過 Telegram 發送訊息。
2. `TelegramConnector` 將訊息轉成 `UnifiedMessage`，交給 `main.ts`。
3. `CommandRouter` 嘗試處理指令；若無匹配，進入一般聊天流程。
4. 記憶模組保存使用者訊息，並組合近期上下文。
5. **`DynamicAIAgent`** 讀取 `ai-config.yaml` 決定使用的後端：
   - 若為 `gemini`：呼叫 `GeminiAgent` 透過 `gemini-cli --resume` 取得回應。
   - 若為 `opencode`：呼叫 `OpencodeAgent` 透過 `opencode run -c` 取得回應。
2. **記憶整合層**：
   - 使用 CLI 原生 Session 維護對話連貫性。
   - SQLite 儲存 15 則歷史對話作為摘要 Fallback。
   - MCP Memory 處理長期知識點。
6. 回應儲存至記憶，並回傳 Telegram。

### 感知主權與合規規訓 (Sovereign Sensing & Compliance)
為了維持系統在 2026 年監管環境下的主權獨立性，感知層（opencli-rs 等）必須遵循以下規訓：
- **禁止偽裝 (No Spoofing)**：嚴禁偽裝 User-Agent。代理人行為必須透過 **WBA (Web Bot Auth)** 進行 SHA-256 加密身分宣告。
- **意圖宣告 (Intent Declaration)**：每次網頁感知調用必須附帶明確的任務意圖標籤，並主動對齊目標站點之 `ai.txt` 或 `llms.txt` 指令。
- **風險對沖**：系統將自動調用預測市場 (Polymarket) 數據作為法律與監管風險的動態探針，據此調整感知強度。

### 擴充建議
- **新增 AI 提供者**：實作 `AIAgent` 介面並在 `DynamicAIAgent` 中加入對應邏輯。
- **新增指令**：在 `CommandRouter` 註冊新的 command。
- **新增連接器**：實作 `Connector` 介面並在 `main.ts` 注入。
- **新增記憶策略**：在 `MemoryManager` 擴充摘要或索引邏輯。
