# Claude Code Leak Shell Takeaways (2026-04-01)

這份文件整理 2026-04-01 前後，外界對 `Claude Code` 原始碼洩漏事件的公開分析與討論中，對 TeleNexus 這種「Telegram / Local Web 殼層 + 外部 AI agent CLI」架構最值得借鏡的重點。

這份文件的目的不是追逐八卦，也不是重建 Claude Code 內核，而是把可學的系統設計思路轉譯成 TeleNexus 殼層語言。

## 先講結論

對 TeleNexus 這層殼來說，最值得學的不是神祕 prompt 或隱藏工具，而是以下五類能力：

1. session / context 治理
2. shell 邊界與權限控制
3. 對外部 agent 執行鏈的 observability
4. memory / context 注入策略
5. fallback / rollout / recovery 設計

## 事件背景的安全解讀

公開討論裡最一致的觀察是：

- 洩漏的是 CLI / client 端程式與系統工程細節，不是模型權重
- 產品強度很大一部分來自 orchestration 與 prompt/runtime 設計
- 發佈流程與 artifact 管理本身就是安全邊界

對 TeleNexus 的意義：

- 你不用複製 Claude Code 的所有能力
- 但要把「殼層如何包裝 agent」當成正式工程面，而不是臨時 glue code

## 對 TeleNexus 殼層可直接借鏡的重點

### 1. Shell 不是聊天轉接器，而是 control plane

公開分析普遍凸顯一件事：成熟 agent 產品的價值不只在模型，而在把輸入、規則、工具、記憶、回應包成一致的控制平面。

對 TeleNexus 的轉譯：

- Telegram 與 Local Web 不只是兩個入口
- 應共享同一套 request lifecycle、session policy、fallback policy、memory policy

具體可做：

- 將 `message-pipeline` 視為 control plane 主幹
- 補 request trace 與 prompt/session 狀態
- 讓 Web 可以看見 shell 狀態，而不只是聊天結果

### 2. Session continuity 與 context reinjection 要分開治理

外界對 Claude Code 的討論中，很常提到它不是單靠超長 prompt 撐住，而是靠 runtime/session/context 三者分層。

對 TeleNexus 的轉譯：

- 外部 CLI session (`-r`, `-c`) 是 continuity 層
- SAR / shell policy reinjection 是 governance 層
- 兩者不應混為一談

實務含義：

- 不要每回合都重送大段 policy/context
- 但也不要只在 `/new` 時注一次然後完全放手
- 應該改成 mode-based reinjection policy

### 3. Prompt / policy 是正式系統資產

公開討論常把 Claude Code 的 prompt 設計視為系統核心之一。真正可學的點，不是 prompt 文案本身，而是它被當成正式工程資產管理。

對 TeleNexus 的轉譯：

- `roleSystem`
- `memory policy`
- `workspace policy`
- `file return protocol`
- `SAR guidance`

這些都應該被明確分層、版本化、可測試，而不是一大塊不可觀測字串。

具體可做：

- 在 `buildChatPrompt()` 中把區塊切開
- 對每種 prompt mode 明確定義會帶哪些 block
- 用測試守住 reinjection 行為

### 4. 可觀測性是殼層核心能力

從公開拆解可以看出，成熟 agent 系統很重視執行鏈的可觀測性。

對 TeleNexus 的轉譯：

- 每則訊息都應有 `requestId`
- 要知道這次走 runner 還是 local
- 要知道 full/compact/minimal 哪種 prompt mode
- 要知道 memory 有沒有命中、context 多長、是否 fallback

如果沒有這些資料，就無法回答：

- 為什麼這次回覆變差
- 為什麼 token 用量變高
- 為什麼 session continuity 失效

### 5. Fallback 與 recovery 是 shell 的責任

Claude Code 類產品值得學的地方之一，是它們不是假設底層永遠穩，而是把異常視為系統設計的一部分。

對 TeleNexus 的轉譯：

- runner 失敗後怎麼回 local
- Gemini 壓縮異常時怎麼 recover
- 何時強制 new session
- 何時略過 memoria sync

這些都應由殼層明確治理並留下狀態，而不是讓使用者感覺結果忽好忽壞。

### 6. 灰度與 feature flag 要服務殼層穩定性

公開討論裡另一個可借鏡點，是成熟系統會把新能力放在可回滾的旗標後面。

對 TeleNexus 的轉譯：

- prompt mode policy 可灰度
- runner 比例可灰度
- memory reinjection policy 可灰度
- Web console 的新觀測面板也可灰度

目標不是增加更多 env var，而是讓高風險行為能分階段放量、快速回退。

### 7. 發佈流程本身就是產品安全的一部分

這次事件最直接的教訓之一，是再強的產品，只要發佈管線失守，一樣會外洩內部工程細節。

對 TeleNexus 的轉譯：

- release workflow 不只要看版本號與 commit
- 也要看 package artifact、debug artifact、認證與本地 state 是否被排除

這點雖然不直接改善聊天品質，但對你這種本地 control plane 非常重要。

## 不值得直接學的部分

有些外界討論很吸睛，但不適合直接拿來當 TeleNexus 的 roadmap：

- 神祕 prompt 文案本身
- 未發布功能名稱
- 未證實的防蒸餾技巧
- 為了多 agent 而多 agent
- 為了工具數量而擴工具

TeleNexus 現階段更重要的是：

- 把殼層做好
- 把 CLI session 與 reinjection 的平衡做好
- 把 observability、policy、recovery 做紮實

## 對目前 TeleNexus 的直接啟發

### Prompt / session

- 不應每回合都重送大段 shell context
- 也不應只在 `/new` 注入一次
- 應採 `full / compact / minimal` 模式治理

### Web / Telegram 統一性

- 不同入口應共享相同 shell policy
- 應共享 request trace、fallback、session 狀態語言

### Shell observability

- `workspace/context` 已經是很好基礎
- 下一步要把它擴成 prompt/session/memory/fallback 的操作視圖

### Policy engineering

- 將 prompt block 與高風險規則顯式化
- 讓 shell 能清楚知道何時需要 re-anchor

### Release / security

- 發版流程要把 shell artifact 與本地 state 納入檢查

## 推薦落地順序

若只採納最值得做的三件事，順序建議如下：

1. request 級 trace 與 prompt/session observability
2. prompt reinjection policy mode 化
3. fallback / recovery policy 顯式化

## 一句話摘要

Claude Code 洩漏事件真正值得 TeleNexus 借鏡的，不是內部神祕細節，而是把「殼層如何包裝、治理、觀測外部 agent CLI」當成正式系統工程來做。
