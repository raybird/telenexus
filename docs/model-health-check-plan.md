# 模型健康檢查 (Model Health Check) 規劃

建立日期：2026-08-24

**狀態：已於 2026-08-24 實作完成**（`src/services/model-health-check.ts`，20 個測試）。本文件保留為設計依據與實測紀錄。

它要解決的問題只有一個：**設定的模型被上游下架時，系統原本不會告訴任何人。**

## 背景：v2.26.2 的 47 小時靜默故障

2026-08-21 09:00 起，正式環境完全不能回話約 47 小時。根因是 `opencode/deepseek-v4-flash-free` 被上游下架，而非任何程式或部署變更 —— 前一分鐘的排程還 `run_done durationMs=59905` 正常，下一輪就開始 `Process exited with code 1`。

完整事故紀錄見 `CHANGELOG.md` 的 2.26.2 條目。與本規劃直接相關的兩件事：

1. **`opencode models` 會列出已 EOL 的模型名稱。** 清單看得到，實際呼叫才回 `HTTP 410 Gone … has reached its end of life`。因此**任何靜態比對清單的檢查方式都無效**，必須實際發出一次請求。
2. **runner 與 local fallback 共用同一個 model 設定。** circuit breaker 開啟後 fallback 到本地執行，用的還是同一個死模型。日誌形狀是 `circuit_open → fallback → 同樣 exit 1` 不斷重複，`durationMs≈1000` 的 fail-fast。

**故障發生在服務已經跑了數天之後** —— 這決定了本規劃的形狀：只做啟動檢查會完全錯過這次事故，因此**週期性檢查是主體，啟動檢查只是它的第一次執行**。

## 為什麼 47 小時沒有人發現

現有的四個可觀測面（`recentIssues` 緩衝、`IssueStore`、`ErrorAlerter`、`EventBus`）**全都正確記錄了這個錯誤**，`error-summary.md` 也如實顯示 `scheduler:task-failed: 14`。缺的不是記錄，是**推播**：

- 排程失敗只會把錯誤訊息送進 Telegram 對話，形狀與一般回覆相同，不易察覺異常
- `ErrorAlerter` 確實有推播，但它的門檻是「同 scope 10 分鐘內 3 次」；排程間隔多為數小時，`scheduler:task-failed` 很少在單一視窗內湊滿 3 次
- 沒有任何機制在**故障開始的當下**主動說「你設定的模型不存在」

## ⚠️ 關鍵限制：ErrorAlerter 無法承接本檢查

最初構想是「檢查失敗 → 透過既有 `error-alerter` 推 Telegram」。**這個做法不會生效**，實作前必須先知道。

`src/services/error-alerter.ts:49`：

```ts
if (window.timestamps.length < threshold) return;   // DEFAULT_THRESHOLD = 3
if (timestamp - window.lastAlertedAt < cooldownMs) return;
```

門檻是「同 scope 在 `windowMs`（預設 10 分鐘）內累積 `threshold`（預設 3）次」。本檢查的週期以小時計，同一 scope 永遠不可能在 10 分鐘內湊滿 3 次 —— 照原構想實作的結果是「看起來有守護、實際永遠不告警」，比現況更糟，因為它會製造安全感。

**採用的解法**：本檢查走**獨立的推播路徑**，直接呼叫 `connector.sendMessage(ALLOWED_USER_ID, ...)`，不經過 `ErrorAlerter` 的視窗邏輯。同時仍照常 `recordRuntimeIssue('model-health', err)`，讓四個可觀測面都留下紀錄。

被否決的替代方案：
- **降低 `ERROR_ALERT_THRESHOLD` 到 1** —— 會讓所有 scope 的任何單一錯誤都推播，噪音無法接受
- **故意送 3 次相同事件湊門檻** —— 污染錯誤統計，且與 cooldown 邏輯耦合

## 設計

### 檢查方式

對**當下生效的模型**發出一次最小請求，以實際結果判定：

```
opencode run --model <生效模型> "Reply with exactly: OK"
```

prompt 必須是明確的最小指令 —— 用 `ping` 會讓 agent 當成任務去執行而遲遲不結束，見下方實測紀錄。

生效模型的解析必須走 `loadAiConfig()`（`src/core/config-loader.ts`），因為 `data/ai-config.override.yaml` 會覆蓋 `ai-config.yaml`，只讀後者會檢查到錯的目標。

判定：
- **exit 0** → 健康
- **exit 非 0** → 失敗，錯誤內容決定訊息措辭：
  - 含 `Model not found` 或 `Gone:` / `end of life` → **模型已失效**，訊息直接點名模型並附替代模型的查法
  - 其他（網路、認證、逾時、未知）→ **無法確認模型可用性**，訊息附上原始錯誤片段，不宣稱是模型問題

**分類只影響訊息措辭，不影響是否算失敗。** 認證過期、金鑰失效同樣會讓 Bot 全滅，不能因為無法歸因就當作沒事。措辭必須誠實：無法歸因時就說無法確認，不要猜成模型下架。

### 告警策略：狀態轉換，不是每次失敗都推

週期性檢查加上「任何失敗都要通知」，天真實作的結果是壞掉一天收 24 則。但降低通知量不能靠**過濾掉某些故障**（那就是漏報）。改為以**狀態轉換**決定推播時機：

| 轉換 | 行為 |
|---|---|
| 健康 → 失敗 | **立刻推播**，含失敗類別與原始錯誤片段 |
| 失敗 → 失敗（相同簽章） | 不推播，但每隔 `MODEL_HEALTH_REMIND_MS`（預設 6 小時）推一則「仍未恢復」提醒 |
| 失敗 → 失敗（**不同**簽章） | **立刻推播** —— 錯誤性質改變了（如 model-not-found 變成認證失敗），是新資訊 |
| 失敗 → 健康 | **推播恢復通知**，含故障持續時間 |

失敗簽章 = 失敗類別 + 錯誤訊息前 120 字的 hash。

**這不是漏報**：每個獨立的故障事件都會在發生當下推播一則，持續期間有定期提醒，恢復時有結束通知。被壓抑的只有「同一個故障的第 2 到第 N 次重複偵測」。

### 流量豁免：有真實成功流量時跳過 ping

若最近一個檢查週期內已有**真實請求成功**，就跳過這次 ping —— 真實流量已經證明模型可用，再打一次只是浪費配額。

實作上訂閱 event-bus（`addEventHook`，`src/services/event-bus.ts:86`），記錄最後一次 `opencode_done` 的時間戳；檢查觸發時若該時間戳在週期內，直接記為健康。

這同時解決兩件事：高流量時幾乎不額外消耗配額，低流量時（正是最容易長期沒發現故障的情境）才真的去 ping。

**已確認可用**：`opencode_done` 全 repo 只有一個 emit 點（`src/core/opencode.ts:396`），位於 `try` 區塊內、`executeChatProcess` resolve 之後。失敗會 throw 進 catch，不會 emit。v2.26.2 的 `Process exited with code 1` 正屬此路徑，因此不會誤觸豁免。

`cli-agent-base.ts` 分類的三種空輸出（`no_events` / `tool_only` / `text_filtered_out`）是 exit 0，會 emit `opencode_done` —— 這對本用途是**正確**的：模型有回應、只是內容不合用，模型本身是活的。

### 時機與非阻塞

啟動檢查**不得阻塞啟動**。實測失敗約 1 秒內返回，但成功路徑要數秒到數十秒（v2.26.2 驗證時走 runner 全鏈路耗時 22.6s）。若同步等待，Bot 上線時間會被拉長且無實益。

接入點必須在 `await telegram.initialize()`（`src/main.ts:371`）**之後** —— connector 未就緒時無法推播，檢查結果會無處可去。

週期性排程沿用 `contextRefreshTimer` 的既有慣例（`src/main.ts:401-404`）：`setInterval` 加 `.unref()`，並在 shutdown handler 中清除。不使用 `Scheduler` —— 那是使用者排程的領域，混入系統自檢會污染 `scheduler-status.md` 與排程統計。

### 兩個服務都要檢查

`telenexus` 與 `agent-runner` 是獨立容器、各自解析設定（runner 走 `loadProviderConfig()`，`src/runner.ts:272`）。兩者讀同一份設定檔，理論上模型相同，但**各自的 opencode CLI 與認證狀態可能不同** —— runner 容器的 opencode 壞掉而主服務正常，是實際可能發生的情況。

runner 沒有 Telegram connector，因此：
- runner 端在 `server.listen()` callback（`src/runner.ts:660`）後啟動同一套週期檢查，結果寫入 `runner-status.md` 並 `recordRuntimeIssue`
- 推播統一由 telenexus 端負責

## 實作範圍

| 檔案 | 動作 |
|---|---|
| `src/services/model-health-check.ts` | 新增。匯出 `startModelHealthCheck`、純函式 `classifyFailure` / `failureSignature` / `decideAlert`、`defaultProbe` 與 `readHealthState` |
| `src/utils/paths.ts` | 新增 `resolveModelHealthStatePath(scope)`。telenexus 與 runner 共用 `data/` volume，狀態檔必須分開否則互相覆寫 |
| `src/main.ts` | `bootstrap()` 尾段（`telegram.initialize()` 之後）啟動；shutdown handler 清除 timer |
| `src/runner.ts` | `server.listen()` callback 後啟動；SIGINT/SIGTERM handler 清除 timer；僅記錄不推播 |
| `src/services/context-snapshots.ts` | `provider-status.md` 增加「模型健康狀態」與「最近一次檢查時間」欄位 |
| `.env.example` | 新增 `MODEL_HEALTH_CHECK_ENABLED`（true）、`MODEL_HEALTH_CHECK_INTERVAL_MS`（3600000）、`MODEL_HEALTH_CHECK_TIMEOUT_MS`（120000）、`MODEL_HEALTH_REMIND_MS`（21600000） |
| `data/model-health-state.json` | 新增。健康狀態機（目前狀態、失敗簽章、故障起始時間、最後推播時間），跨重啟存活。屬使用者狀態，`install.sh` 不覆蓋 |

**不可觸及**：`error-alerter.ts` 的視窗邏輯、既有 `recordRuntimeIssue` 的 scope 命名慣例、circuit breaker 行為、`Scheduler`。

## 驗收條件

- **AC-1**：模型失效（如 `opencode/deepseek-v4-flash-free`）時，`ALLOWED_USER_ID` 收到一則明確指出模型名稱與失效原因的 Telegram 訊息。
  - 檢查方式：單元測試以假的 connector 驗證 `sendMessage` 被呼叫且內容含模型名稱；失敗路徑為 connector 拋錯時不得讓呼叫端崩潰。
- **AC-2**：模型可用時不推播任何訊息。
  - 檢查方式：同上，斷言 `sendMessage` 未被呼叫。
- **AC-3**：檢查失敗時 `recordRuntimeIssue('model-health', ...)` 被呼叫，錯誤出現在 `error-summary.md` 與 `events.jsonl`。
  - 檢查方式：訂閱 `addIssueHook` 斷言 scope 字串。
- **AC-4**：啟動檢查不阻塞啟動 —— 檢查仍在進行時，Bot 已能接收並處理訊息。
  - 檢查方式：測試中讓檢查回傳永不 resolve 的 promise，斷言 `bootstrap()` 正常完成。
- **AC-5**：非模型類錯誤（網路逾時、認證失敗）**同樣視為失敗並推播**，但訊息不得宣稱模型已下架。
  - 檢查方式：注入逾時與 401 情境，斷言 `sendMessage` 被呼叫、內容含原始錯誤片段，且**不含**「已下架」「end of life」等歸因字樣。
- **AC-6**：`MODEL_HEALTH_CHECK_ENABLED=false` 時完全不執行檢查，且不註冊 timer。
- **AC-7**：持續失敗時不重複推播 —— 相同簽章連續失敗只在第一次推播，直到 `MODEL_HEALTH_REMIND_MS` 過後才推提醒。
  - 檢查方式：以假時鐘連續執行多次相同失敗，斷言 `sendMessage` 呼叫次數為 1；推進時鐘超過提醒間隔後再執行，斷言增為 2。
- **AC-8**：失敗簽章改變時立刻推播。
  - 檢查方式：先注入 model-not-found 失敗，再注入認證失敗，斷言 `sendMessage` 被呼叫兩次且第二則內容不含模型下架歸因。
- **AC-9**：故障恢復時推播恢復通知，內容含故障持續時間。
  - 檢查方式：失敗後轉為成功，斷言 `sendMessage` 被呼叫且內容含時間長度。
- **AC-10**：狀態跨重啟存活 —— 失敗狀態下重啟，不重複推播首次告警。
  - 檢查方式：寫入失敗狀態的 `data/model-health-state.json` 後啟動檢查並注入相同失敗，斷言 `sendMessage` 未被呼叫。
- **AC-11**：週期內有 `opencode_done` 事件時跳過 ping。
  - 檢查方式：發出 `opencode_done` 後觸發檢查，斷言未產生 opencode 子程序呼叫且狀態記為健康。

## 實作後的實測紀錄（2026-08-24）

單元測試全部注入假 probe，真正打 opencode 的那段只能靠實測驗證。以下兩項是實測才發現、且會讓功能一上線就出錯的問題：

### 探針 prompt 的選擇會決定成敗

同一個健康模型（`nvidia/minimaxai/minimax-m3`），只換 prompt：

| prompt | 耗時 |
|---|---|
| `ping` | **超過 180 秒未結束** |
| `回覆 OK 兩個字即可` | 70 秒 |
| `Reply with exactly: OK` | **10.9 秒** |

`ping` 之所以最慢，是因為 agent 會把它當成一個待執行的任務去跑（可能真的去做網路操作），而不是當成要回覆的訊息。**探針 prompt 必須是明確的最小指令。**

規劃初稿寫的正是 `ping`，逾時預設 30 秒 —— 若照著實作，每次檢查都會把健康的模型誤報成故障。現行值：prompt 為 `Reply with exactly: OK`，逾時 120 秒（約 11 倍餘裕）。

### 失效分類是 best-effort，不保證歸因

以事故當事的 `opencode/deepseek-v4-flash-free` 實測，本機 opencode 的輸出**完全不含** `Model not found`，只有：

```
Error: { "name": "UnknownError", "data": { "message": "Unexpected server error..." } }
```

同一個模型在正式環境容器內卻會吐出 `Model not found: … Did you mean: …`。推測與 opencode 的模型清單快取狀態有關 —— 清單裡還有這個模型時就送到伺服器端、拿回泛用錯誤；清單已更新時才在客戶端擋下並給出明確訊息。

結果是**同一個故障在不同環境會被歸到不同類別**。這不影響「是否告警」（unknown 一樣會推播），只影響訊息能否指出原因。三個模型的實測結果：

| 模型 | 判定 | 耗時 |
|---|---|---|
| `opencode/deepseek-v4-flash-free`（已下架） | `unknown` → 告警但不歸因 | 1.3s |
| `nvidia/minimaxai/minimax-m2.7`（EOL 410） | `model-invalid` → 告警並歸因 | 4.7s |
| `nvidia/minimaxai/minimax-m3`（可用） | `ok` → 不告警 | 7.1s |

## 風險與取捨

- **每個檢查週期多一次模型呼叫。** 免費模型有配額。以流量豁免大幅降低實際次數（有真實流量時完全不 ping），並提供 `MODEL_HEALTH_CHECK_ENABLED` 開關與可調週期。預設 1 小時是「偵測延遲」與「配額消耗」的折衷：v2.26.2 的 47 小時故障在此設定下 1 小時內就會被發現。
- **狀態轉換告警會壓抑重複訊息。** 若使用者錯過了首次告警，要等 `MODEL_HEALTH_REMIND_MS`（預設 6 小時）才會再被提醒。這是刻意的取捨 —— 完整狀態隨時可在 `provider-status.md` 查得。若認為 6 小時太長，調短即可，機制本身不需改。
- **判定依賴上游錯誤訊息的字串樣式。** `Model not found` 與 `Gone:` 的措辭若改變，檢查會退化成「無法確認模型可用性」那一類訊息 —— 仍算失敗、仍會推播，只是少了明確歸因。樣式比對需集中在單一常數，便於日後調整。

## 待確認事項

1. **[未決] 檢查週期預設值** —— 規劃暫定 1 小時。影響：偵測延遲與配額消耗的平衡。有流量豁免後實際 ping 次數應遠低於 24 次/日，但正式環境的實際流量分佈尚未量測。
2. **[未決] 模型失效時是否要自動切換到備援模型** —— 影響：牽涉 fallback 機制是否應使用獨立模型，屬於另一個議題（見 CHANGELOG 2.26.2「runner 與 local fallback 共用同一個 model 設定」）。本規劃只做偵測與告警，不做自動修復。
3. **[未決] runner 的檢查結果是否需要回報給 telenexus** —— 影響：目前規劃 runner 僅寫入自己的 status 檔，若 runner 的 opencode 壞掉而主服務正常，使用者不會收到推播。待確認這個缺口是否可接受。
