# Changelog

> 更早的版本歷史見 [GitHub Releases](https://github.com/raybird/telenexus/releases) 與 git log。

## 2.27.0 — 2026-08-24

### 模型健康檢查：不再需要等排程一輪輪失敗才發現模型死了

v2.26.2 記錄的 47 小時靜默故障，缺的不是錯誤記錄（四個可觀測面都如實記下了），而是**推播**——沒有任何機制在故障發生的當下說「你設定的模型不存在」。本版補上這個缺口。

週期性（預設 1 小時）對當下生效的模型發出一次最小請求。生效模型走 `loadAiConfig()` 解析，因此 `data/ai-config.override.yaml` 的覆蓋也算數。

**告警採狀態轉換，不是每次失敗都推**：

| 轉換 | 行為 |
|---|---|
| 健康 → 失敗 | 立刻推播 |
| 失敗 → 失敗（相同簽章） | 不推，每 6 小時一則「仍未恢復」 |
| 失敗 → 失敗（**不同**簽章） | 立刻推——錯誤性質變了就是新資訊 |
| 失敗 → 健康 | 推恢復通知，含故障持續時間 |

被壓抑的只有「同一故障的第 2..N 次重複偵測」。任何失敗都會告警，包含無法歸因的網路與認證錯誤——那些同樣會讓 Bot 全滅，只是訊息措辭改為「無法確認模型可用性」，不猜成模型下架。

**流量豁免**：週期內若已有真實請求成功（`opencode_done` 事件），跳過這次 ping。真實流量已經證明模型可用，高流量時幾乎零額外配額消耗；低流量時——正是最容易長期沒發現故障的情境——才真的去打。

### 刻意不接 ErrorAlerter

最初的構想是複用既有的 `error-alerter`。**那樣做永遠不會告警**：它的門檻是「同 scope 在 `ERROR_ALERT_WINDOW_MS`（預設 10 分鐘）內累積 `ERROR_ALERT_THRESHOLD`（預設 3）次」，而本檢查週期以小時計，同一 scope 不可能在 10 分鐘內湊滿 3 次。

若照原構想實作，結果是「看起來有守護、實際永遠不告警」——比沒有更危險，因為它會製造安全感。因此本檢查走獨立推播路徑，同時仍照常 `recordRuntimeIssue('model-health:*', ...)` 讓四個可觀測面都留紀錄。

### 實測修正了兩處會讓功能一上線就出錯的設計

單元測試全部注入假 probe，真正打 opencode 的那段只能靠實測驗證。實測抓到：

**探針 prompt 的選擇決定成敗。** 同一個健康模型（`nvidia/minimaxai/minimax-m3`），只換 prompt：

| prompt | 耗時 |
|---|---|
| `ping`（規劃初稿） | **超過 180 秒未結束** |
| `回覆 OK 兩個字即可` | 70 秒 |
| `Reply with exactly: OK` | **10.9 秒** |

`ping` 最慢是因為 agent 會把它當成待執行的任務去跑，而不是當成要回覆的訊息。規劃初稿寫的正是 `ping` 加 30 秒逾時——照著實作的話，每次檢查都會把健康的模型誤報成故障。現行值為明確指令加 120 秒逾時（約 11 倍餘裕）。

**失效分類是 best-effort，不保證歸因。** 以事故當事的 `opencode/deepseek-v4-flash-free` 實測，本機 opencode 輸出完全不含 `Model not found`，只有泛用的 `UnknownError`；同一模型在正式環境容器內卻會吐出 `Model not found: … Did you mean: …`。推測與 opencode 模型清單的快取狀態有關。這不影響是否告警（`unknown` 一樣推播），只影響訊息能否指出原因。

三個模型的實測判定：`deepseek-v4-flash-free`（已下架）→ `unknown` 1.3s、`minimax-m2.7`（EOL 410）→ `model-invalid` 4.7s、`minimax-m3`（可用）→ `ok` 7.1s。

### 新增設定

```bash
MODEL_HEALTH_CHECK_ENABLED=true
MODEL_HEALTH_CHECK_INTERVAL_MS=3600000    # 1 小時
MODEL_HEALTH_CHECK_TIMEOUT_MS=120000      # 2 分鐘
MODEL_HEALTH_REMIND_MS=21600000           # 6 小時
```

`provider-status.md` 增加 `Model Health` 欄位；狀態機持久化於 `data/model-health-state.json`（runner 端為 `.runner.json`——兩個服務共用同一個 `data/` volume，共用檔案會互相覆寫）。runner 端只記錄不推播，推播統一由 telenexus 負責。

設計依據與完整實測紀錄見 `docs/model-health-check-plan.md`。

⚠️ **這不會自動修好已經壞掉的模型設定**，它只負責告訴你。切換模型仍需自己改 `ai-config.yaml` 或用 `/set_model`，且**換之前務必實測**——`opencode models` 清單會列出已 EOL 的模型。

## 2.26.2 — 2026-08-23

### 上游下架模型會讓整台 Bot 靜默全滅

正式環境 2026-08-21 09:00 起完全不能回話約 47 小時，根因是 `opencode/deepseek-v4-flash-free` 被上游下架。前一分鐘的排程還 `run_done durationMs=59905` 正常，下一輪就開始 `Process exited with code 1` —— 中間沒有任何部署或設定改動。

排查時發現兩個不直觀的地方，值得記在這裡：

**1. `opencode models` 會列出已 EOL 的模型名稱。** 清單裡看得到，實際呼叫才回 `HTTP 410 Gone … has reached its end of life`。只看清單會誤判為可用。唯一可靠的檢查是實際打一次：

```bash
opencode run --model <名稱> "ping"
```

排查當下 `ai-config.yaml` 裡列的 NVIDIA 候選幾乎全滅 —— `minimax-m2.7`（EOL 2026-07-27）、`deepseek-v4-flash` 與 `deepseek-v4-pro`（皆 EOL 2026-08-07）、`mistral-large-3-675b`（EOL 2026-07-23）。

**2. runner 與 local fallback 共用同一個 model 設定。** circuit breaker 開啟後 fallback 到本地執行，用的還是同一個死模型，三層防護一起失效。日誌形狀是 `circuit_open → fallback → 同樣 exit 1` 不斷重複，`durationMs≈1000` 的 fail-fast。這代表 fallback 機制對「模型失效」這一類故障完全沒有救援能力 —— 它擋的是 runner 進程掛掉，不是模型消失。本版未改動此行為，僅先記錄。

判斷指令：

```bash
docker logs <runner 容器> --since 24h 2>&1 | grep -m1 "Model not found\|Gone:"
```

### 本版實際改了什麼

- `ai-config.example.yaml` 的範例模型改為實測可用的 `nvidia/minimaxai/minimax-m3`，並註明「上游會下架模型、`opencode models` 仍會列出已 EOL 名稱、套用前先實測」。
- `ai-config.yaml` 取消版控追蹤。該檔早已列在 `.gitignore`，但因先被 commit 而仍受追蹤，會把本機模型偏好帶進版控。範本以 `ai-config.example.yaml` 為準，`install.sh` 本來就是從範本複製產生此檔。

⚠️ **升級不會修好已經壞掉的部署。** `install.sh` 永不覆蓋使用者的 `.env`、`ai-config.yaml`、`data/`、`workspace/`，所以 bundle 只會帶去更新後的 `ai-config.example.yaml`。若你的 `ai-config.yaml`（或 `/set_model` 寫出的 `data/ai-config.override.yaml`）指向已下架的模型，**必須自己改**：

```bash
# 先確認目前生效值：override 存在時會蓋掉 ai-config.yaml
grep '^model:' ai-config.yaml
cat data/ai-config.override.yaml 2>/dev/null

# 實測候選可用後再套用
docker compose exec agent-runner opencode run --model <名稱> "ping"
```

`config-loader` 每次呼叫都重讀設定，**改完不必重啟容器**。

## 2.26.1 — 2026-08-17

### Memoria 釘選升到 1.28.1（對我們實測零影響）

1.28.1 修的是 issue-16：1.28.0 之後**中文單詞找得到、中文片語找不到**（`記憶` 5 筆、`召回` 3 筆，但 `記憶召回` **0 筆**，而英文同構的 `memory recall` 3 筆）。修法是 `LIKE` fallback 改對 token 做 OR 並 4× over-fetch。上游明載精確度代價：總回傳 11 → 38。

**我們實測是完全的 no-op**（同一份正式環境快照，1.28.0 與 1.28.1 各自獨立資料副本，參數與生產路徑逐項一致）：

| | 1.28.0 | 1.28.1 |
|---|---|---|
| 凍結 8 題（整句問句） | 8/8 命中、32 筆、精確度 0.313、conf 0.262 | 完全相同 |
| 短片語 6 題（探測） | 27 筆 | 27 筆 |
| **回傳 id 集合（含排序）** | — | **14/14 題逐筆相同** |

短片語那 6 題是看過上游 changelog 後才加的，因此標示為探測性質、不併入凍結集。

**為什麼上游的精確度代價沒有落到我們身上**：我們的 tree route 幾乎每題都已填滿 `top_k=5`，keyword route 擴大匹配後沒有空位可擠進來。上游語料看到 11→38，是因為其 tree route 回傳較少。⚠ 反過來說，**我們這組 n 不能用來否證上游的代價** —— 那是不同的語料形狀。

升版的理由不是眼前的效益，而是：目前真實聊天量為零（最後一次 2026-07-17），若聊天量長回來、語料變大，tree route 就不會再填滿 top-5，keyword route 那條路徑才開始有作用 —— 屆時希望修正已經在位上。

### 觀測：`route_mode` 會在結果不變時換組

`排程設定` 這題在 1.28.1 的 `route_mode` 從 `hybrid_tree` 變成 `hybrid_fallback`，但**回傳的 5 筆 id 完全相同**。成因是 `fallbackUsed = treeRaw.length === 0 || usedKeyword`，而 OR 化之後 keyword route 開始也找到 tree 已找到的那幾筆，翻動 `usedKeyword` 而 dedupe 吃掉重複。

對我們無影響（我們不消費 `route_mode` 做任何判斷，只寫進遙測面板），但已回報上游 —— 那會污染它們依 `route_mode` 分組的 `routeUtility` 指標。

### 順帶收錄

本版同時帶上 v2.26.0 之後補的一個測試：釘住「pipeline 解析出的 memory intent 要真的交給 Memoria 同步」這個接縫。查「正式環境 `DecisionMade` / `SkillLearned` 為 0 筆」時發現那條路徑的兩端各有測試、中間沒有，而它從未在真實環境跑過（零流量），只能靠測試釘住。同時釘住送出的 `modelMessage` 是清理過的內容 —— 若送原始回覆，`[[MEMORY_INTENT:…]]` 會被寫進長期記憶的可搜尋文字。

## 2.26.0 — 2026-08-17

### Memoria 升到 1.28.0，呼叫端的中文切詞層移除

v2.23.0 起我們在呼叫端把中文查詢切成重疊 2-gram，因為當時的 Memoria 把一整句 CJK 當單一 token、要求逐字命中。Memoria v1.28.0 把 CJK 切詞做進去了，而且 **n 由呼叫端的 `minLength` 決定**（FTS 用 3 對上 trigram 索引、`tokenCoverage` 與 tree 用 2）—— 它能各給各半邊正確的窗格，我們在外面切做不到那件事。

**A/B 實測**（正式環境 `VACUUM INTO` 快照 957 筆、`scope=user:` 的 15 筆、8 題措辭與語料刻意不同的中文問句。查詢集在跑任何一組**之前就凍結**，看到結果後未再調整；參數與生產路徑逐項一致：`project=TeleNexus` / `top_k=5` / `mode=hybrid`；切詞字串用真實程式碼路徑取出而非照規格重寫）：

| 版本 | 呼叫端切詞 | 命中 | 回傳 | 精確度 | 平均 conf | route |
|---|---|---|---|---|---|---|
| 1.27.1 | 關 | **0/8** | 0 | — | 0.000（`no_hits`） | `hybrid_fallback` |
| 1.27.1 | 開 | **8/8** | 31 | 0.323 | 0.266 | `hybrid_tree` |
| 1.28.0 | 關 | **8/8** | 32 | 0.313 | 0.262 | `hybrid_tree` |
| 1.28.0 | 開 | **8/8** | 31 | 0.323 | 0.266 | `hybrid_tree` |

1.28.0 上「原句」與「我們切詞」**逐題命中的 session 完全相同**，一題不差 —— 所以那層在 1.28.0 是 no-op，移除不損失召回。第一列同時是「我們當初為什麼要做那層」的全量確認：八題全滅、回傳零筆。

⚠️ **這兩個改動綁在一起**：降版回 1.27.x 而不還原切詞層，中文召回會直接回到 0/8。程式註解與測試都寫明了這個耦合。

CJK 測試的斷言語意因此反轉（從「必須切成 2-gram」變成「原句原樣送出」），並已對還原切詞層的舊版驗證兩個實質測試會紅。`QUERY_STOPWORDS` 保留 —— `extractQueryKeywords` 仍在用。

### 觀測到但尚未處理

實驗過程順帶量到兩件事，記錄備查：

- **可召回語料的 scope 分布**：`scheduler:915354960` 942 筆、`user:915354960` **15 筆**。聊天召回只查後者，所以實際搜索空間是 15 筆（v2.24.0 的 scope 分區刻意如此，避免 60% 都是 Crypto Monitor 的排程摘要淹掉真實對話）。
- **`DecisionMade` / `SkillLearned` 事件：0 筆。** v2.24.0 接上了 `[[MEMORY_INTENT]]` → 萃取型事件的產生路徑，但部署至今一筆都沒產生。目前召回語料 100% 來自 session summary。門檻太嚴、模型很少附 intent、或產生路徑有 bug —— 尚未查明。

## 2.25.2 — 2026-08-17

### 排程輪次結束後關掉 agent-browser 的常駐 session

**這一版才真正修掉「Active Lanes=0 但 Chrome 存活 2 小時」的頭號症狀。** v2.25.0 的 process group 終止修好的是別的東西（見下方更正）。

`agent-browser` 是 **daemon，不是普通子程序**。它的每個指令（`open` / `snapshot` / `click`）都是獨立 invocation，卻操作同一個跨 invocation 存活的瀏覽器 —— 要做到這件事，它必須自己 `setsid` 出去。用同一個映像的拋棄式容器實測：

```
呼叫方（模擬 opencode）  PGID 289
agent-browser-l   PID 28 | PPID 1  | PGID 28
chrome            PID 42 | PPID 28 | PGID 42
chrome_crashpad   PID 44 | PPID 1  | PGID 43
```

⚠️ **更正 v2.25.0 的說法**：該版說 process group 終止覆蓋了 browser cleanup，因此不需要明確呼叫 `agent-browser close`。**那是錯的。** browser tree 的 PGID 與呼叫方不同，`process.kill(-pid)` 打不到它 —— 而那是 agent-browser 的設計，不是它的 bug。v2.25.0 確實修好的是另外三件真實問題（SIGTERM 後不等待也不升級 SIGKILL、排程逾時不取消底層工作、逾時訊息的分鐘數），但頭號症狀當時仍在。

實測 `agent-browser close` 能完整收掉整棵樹（剩下的全是等待 reap 的 zombie，`session list` 回報 `No active sessions`）。

新增 `CliAgentBase.onRunFinished()` 收尾鉤子，成功／失敗／逾時／中止四條路徑都會走到；`OpencodeAgent` 覆寫它，在排程輪次結束時執行 `agent-browser close --all`。**放在 agent 層而非 scheduler 層是刻意的** —— 清理必須發生在瀏覽器所在的容器，而排程可能被路由到 runner 執行。

**只在排程路徑收**：互動聊天可能跨輪操作同一個瀏覽器（第一則開網頁、第二則接著點），每輪都 close 會弄壞那個工作流；排程是一次性的，沒有這個顧慮。用 `--all` 是因為排程可能開過具名 session，逐一列舉會漏。實測無 session 時 exit code 為 0，不會每輪製造噪音。收尾失敗記 `recordRuntimeIssue` 而非只在 console 留痕。

### runner 的 lane 從未傳給 agent

runner 一直收得到 `lane: 'scheduled'`，卻**從來沒有把它轉成 `fromScheduler`** —— CLI 端因此無從得知這輪是不是排程。少了這條，走 runner 的排程（`CHAT_USE_RUNNER_PERCENT > 0`）拿不到旗標、永遠不會被清理，而且完全沒有錯誤訊息：與原本的洩漏是同一種病。

映射邏輯抽到 `src/core/runner-agent-options.ts`（原本是兩處完全相同的巢狀三元式），順便讓它可被測試 —— `runner.ts` 有 top-level `server.listen()`，測試不能 import 它。

## 2.25.1 — 2026-08-17

### release bundle 的 compose 補上 agent-runner 資源上限

v2.25.0 加資源上限時只改了開發版 `docker-compose.yml`，而 release bundle 用的是 `docker-compose.release.yml` —— 兩份獨立維護的檔案。結果是發版流程全綠、映像正確，但 **bundle 交付了一份沒有 `mem_limit` / `pids_limit` 的 compose**。用 `install.sh --upgrade` 升級的部署因此拿不到那層安全網。

release 檔開頭本來就寫著「與開發版的唯一差異是 `build:` → `image:`」，只是沒有任何東西在守這句話。新增 `tests/docker/compose-parity.test.ts`：把兩邊的 `build:` 區塊與 `image:` 行正規化成同一個標記後逐行比對，任何其他差異都會讓 CI 紅燈，不需要有人記得同步。已對缺資源上限的狀態驗證會紅，訊息直接指出缺的是哪一行。

## 2.25.0 — 2026-08-17

### 子程序改以 process group 終止，排程逾時真的會取消底層工作

排程結束後 `agent-browser` 與整棵 Chrome（12 個 chrome + 2 個 crashpad）在 `Active Lanes=0` 的狀態下存活 2 小時以上，runner 的 cgroup task 數停在 221。重啟容器後復發，所以不是一次性事故，是每次工作結束的固定行為。

成因是兩個，不是一個：

1. **kill 只送給直接 child。** CLI 會再長出 `agent-browser` 與 Chrome，孫程序不在收訊範圍內。改為 `detached` spawn 讓 child 自成 process group leader，再以負數 PID 終止整群。
2. **送出 SIGTERM 後從不等待、也從不升級。** `process-runner.ts` 三個 kill 點都在 SIGTERM 之後立刻 `settle()` reject，`close` handler 因 `settled=true` 空轉 —— 所以連直接 child 只要不理 SIGTERM 就永遠活著。補上 5 秒後整群 SIGKILL。

`cli-agent-base.ts` 的串流路徑（互動聊天走這條）有一模一樣的缺陷，共用同一個 `terminateProcessTree`，不另寫一份。新增的 4 個測試已對修正前的程式碼驗證會紅。

**排程取消鏈**：`withScheduleTimeout` 原本只 reject 上層 Promise，queue task 沒被通知、Opencode 繼續跑到自然結束、序列 queue 被佔住 —— 逾時的工作與它的重試同時吃 provider 配額。現在逾時會 abort 一路傳到 `runProcess`。刻意**不用** `executionQueue.cancel(userId)`：那會連同該使用者排隊中的互動訊息一起清掉，排程逾時不該波及當下的對話。另補上「排隊期間就逾時」的檢查，避免輪到它時再送一次進 Opencode。

**逾時訊息的分鐘數**改為從 `OPENCODE_TASK_TIMEOUT_MS` 計算。原本寫死「10分鐘」，實際預設是 30 分鐘 —— 使用者等滿 30 分鐘卻被告知 10 分鐘。`scheduler-helpers` 的重試比對用的是 `\d+`，不受影響。

### ⚠ detached 的副作用與補償

`detached` 讓子程序脫離父行程的 process group，**終端機的 Ctrl-C 不再傳得到它**（SIGINT 是送給整個前景 group）。實測對照確認：不清理時孫程序在 group SIGINT 之後仍然存活。Docker 不受影響（`docker stop` 只送 SIGTERM 給 PID 1，本來就不靠 group），會踩到的是本機 `npm run dev` / `dev:runner`。

補償分兩層：登記表 + `terminateAllChildren()` 由各服務**既有的**關閉流程呼叫，加上 `process.on('exit')` 的 SIGKILL 兜底。刻意不在 `process-runner` 自己註冊 signal listener —— `main.ts` 已經有一組會 `process.exit(0)` 的 handler，再加一個會依註冊順序搶在優雅關閉之前退出，而該模組被 import 得更早。

`runner.ts` 先前**完全沒有** signal handler，靠 Node 預設行為終止，而預設終止不會觸發 `exit` handler。本版補上 SIGINT/SIGTERM 並自行退出（註冊 listener 會關掉預設終止）。

### agent-runner 資源上限

`docker-compose.yml` 為 agent-runner 加上 `mem_limit: 2g` / `mem_reservation: 512m` / `pids_limit: 1024`。這是失控時的安全邊界，**不是 browser cleanup 的替代品**。

上限抓在實測 peak（1.48GB）之上而非貼齊，貼近 peak 會把正常的 Chrome 尖峰變成 OOMKilled。`pids_limit` 給 1024 而非慣例的 384/512：cgroup 的 pids 是 task 數（含 threads），一棵 Chrome tree 約 180+ threads，實測 idle 就已經 221。**CPU limit 不設** —— 沒有一個完整互動與排程週期的 latency 實測基準，硬設等於瞎猜。

### Memoria 釘選升到 1.27.1

修掉先前回報的 `/v1/health` 誤報：完整性檢查改用每次重開的專屬連線，不再因為外部行程寫過 DB 就永久謊報 FTS5 索引損壞。以在 1.25.0 / 1.27.0 上必然觸發誤報的重現腳本獨立驗證，三次連打都是 `db_integrity pass`。

順帶一提，1.27.1 之前 `health` 的 `db` 欄位不可信（連線失敗時會先記 pass 再補 fail，而 `health()` 取第一筆）。TeleNexus 的 `pingMemoriaEndpoint` 與 compose healthcheck 都只看 HTTP status，未受影響。

## 2.24.0 — 2026-08-14

### 記憶意圖寫成 DecisionMade / SkillLearned 事件

Memoria 的關鍵字召回語料只有 `sessions.summary` 與 `event_type` 為 `DecisionMade` / `SkillLearned` 的事件（FTS trigger 的 DDL 寫死 `WHEN new.event_type IN (...)`），逐輪對話事件永遠不進索引 —— 那是刻意的設計：它索引的是蒸餾過的記憶，不是 transcript。v2.23.0 修好了 `summary` 這一半，但我們一種萃取型事件都不產。

模型本來就會在回覆末尾附上 `[[MEMORY_INTENT:…]]`，只是那個回報以前只進了記憶體內的遙測、沒有接到同步端。現在接上，並新增 `skill` 層級對應 `SkillLearned`。

三道閘門，寧可不寫也不要污染語料：

- `level` 限 `rule` / `decision` / `skill`（`long-term-candidate` 這種「可能有用」不算）
- `confidence` 不可為 `low`（模型自己都不確定的事不值得長期保留）
- `summary` 必須非空 —— 那是唯一會被搜尋到的文字，沒有它寫進去也召不回

`content` 送物件而非字串：Memoria 用 `parseDecisionEvent(...).decision` 與 `parseSkillEvent(...).skill_name` 取標題，送純字串會變成 `Untitled Decision`。

**夠格的意圖同時接在 `summary` 後面**，因為 `recallTree` 的 snippet 固定取 `session.summary`，萃取型事件的文字只參與比對、不會被顯示。不接的話會出現「配到了但看不到」：模型因為某句規則召回了這筆記憶，收到的卻是「這樣處理可以嗎 → 可以，我照你說的辦」，而真正有價值的那句規則不在裡面。

端對端實測（拋棄式 Memoria 1.27.0）：查「稽核 軌跡」—— 這四個字只存在於決策 summary、對話本文完全沒有 —— 命中 1 筆，且 snippet 含該規則全文。

### 記憶意圖的採用率變成可量測

這個功能完全依賴模型主動回報，而那件事**從來沒有被測量過**：既有的意圖遙測是記憶體內的 50 筆滾動，重啟即歸零，而意圖區塊在存入前就被 `parseMemoryIntent` 剝掉，所以 Memoria 與本地記憶庫都沒留下痕跡。

新增 `memory_intent` 事件寫入 `events.jsonl`（保留 7 天），欄位為三個決定閘門（`level` / `confidence` / `has_summary`）。「模型到底會不會回報」與「報了但被哪一道閘門擋掉」因此可查，而不是又一個做了卻不知道有沒有作用的東西。

## 2.23.0 — 2026-08-14

### Memoria 長期記憶一直召不回任何東西

正式環境從 2026-06-01 起同步了 905 個 session、1810 筆對話事件，每次 `remember` 都回 `ok:true`，而**任何查詢的召回結果都是 0 筆**。三個各自獨立、都足以致命的原因疊在一起：

- **`summary` 送的是 metadata**。Memoria 的關鍵字召回語料只有 `sessions.summary` 加上 `DecisionMade` / `SkillLearned` 事件（FTS trigger 的 DDL 寫死 `WHEN new.event_type IN (...)`），而我們只產 `UserMessage` / `ModelMessage` —— 所以 `summary` 是唯一搜得到的欄位，裡面卻裝著 `user=… platform=… source=…`。`recall_fts` 的 905 列 body 全是這串字。改放使用者訊息與回覆（各截 240 字），診斷欄位移到事件的 `metadata`。
- **payload 沒帶 `scope`**，被預設成 `project:TeleNexus`，但召回端傳的是 `user:<id>`，而 Memoria 的 scope 是**等值比對** —— 就算語料正常也必定 0 筆。
- **整句中文送去查詢**。Memoria 的查詢 tokenizer 把 CJK 連續字串視為單一 token，`recall_fts` 雖然是 trigram 索引、有能力配連續中文子字串，但整句餵進去會讓匹配退化成「整串必須連續出現」。同一份語料實測：「幫我看一下排程設定」0 筆、「排程 設定」2 筆。查詢送出前改切成重疊 2-gram（先用停用詞斷句，避免「一下」+「排程」黏成「下排」這種跨語意的假相鄰）。

| 情境 | 修復前 | 修復後 |
| --- | --- | --- |
| 對照查詢（拋棄式 Memoria 1.27.0） | 0/7 命中 | 4/7 |
| 完整鏈路（真實中文訊息 → 注入） | 1/3 | 3/3 |
| route / basis | `hybrid_fallback` / `no_hits` | `hybrid_tree` / `lexical_coverage` |

三個都是 fail-open 的靜默失效：寫入回 `ok:true`、召回回 `ok:true` 加空陣列，沒有任何一層會出聲。已寫入的舊記憶原始對話完整保留在 `events` 裡，可另行回填。

已知取捨：2-gram 必然帶噪音（「排程設定」會產生「程設」），而 Memoria 的 `relevance` 是「命中 token 數 / 查詢 token 數」。分母對同一次查詢的所有候選是常數，**排序不受影響**，但回報的 `confidence` 會系統性偏低 —— 遙測與 UFL 校準的數字都要照這個折扣讀。另外 2 字詞低於 `FTS_MIN_TERM_LEN=3`，實際走的是 tree route 而非 bm25。

### 排程產出寫進獨立的 `scheduler` 分區

修好 `summary` 之後浮現的第二個問題：正式資料 905 筆記憶裡 **752 筆是排程任務，且只有 5 種**，光 Crypto Monitor 就 548 筆（六成）。讓這些近乎逐字重複的自動報告進入聊天召回語料，任何與市場或技術相關的查詢都會被它們塞滿，真人對話（15 次）被 5:1 稀釋 —— 而且每天新增約 7 筆，會持續惡化。

利用 scope 是等值比對這點，排程輪次改寫入 `scheduler:<id>`，聊天召回只查 `user:<id>`。**內容完整保留、換個 scope 就查得到**，但不佔用真人對話的召回名額。端對端實測（8 份排程報告 + 2 次真人對話）：「市場 行情 分析」在聊天分區回的是「市場回覆要附資料來源」那條規則、排程外洩 0 筆，同一查詢在排程分區回 3 筆報告。

`console` 與 `telegram` 都算真人對話，一律走 `user:<id>`。

### Memoria 召回遙測

`/v1/recall` 回應 `meta` 的 `route_mode` / `fallback_used` / `confidence` / `confidence_basis` 原本整包丟棄，對召回品質形同全盲 —— 上面那個 0 筆問題正是加了這個之後才浮出來的。

- `memoria-status.md` 新增 `## Recall Telemetry` 區塊（原內容收進 `## Sync Bridge`），滾動 50 筆：路由分布、信心基準分布、平均延遲與命中數
- 每次召回 emit `memoria_recall` 事件到 `events.jsonl`
- `route_mode` 為 `vector_unavailable` / `vector_timeout` 時（語意索引服務不了、實際端出字面結果）發 `recordRuntimeIssue`，不讓它靜默降級
- 平均 confidence 只採計 `lexical_coverage` 樣本並印出 `n`：`confidence` 為 `null` 代表該路由無法判斷，當成 0 計算會製造假數字

Memoria 釘選同時升到 1.27.0（已實際建映像驗證 `memoria --version`）。

## 2.22.3 — 2026-08-13

### SAR summary 查詢改用部分索引

SAR 每輪對話都會呼叫 `getRecentSummaries`，但生產資料裡只有 2.3% 的訊息帶 summary。既有的 `(user_id, impact_level, timestamp)` 索引無法表達「有 summary」這個條件，SQLite 得把該使用者所有訊息取回逐列判斷 `TRIM(summary) != ''`，再做 TEMP B-TREE 排序。

新增 `idx_messages_summary_lookup`（部分索引，`WHERE summary IS NOT NULL AND TRIM(summary) != ''`）後，以 115K 訊息實測：

| 路徑 | 修復前 | 修復後 |
| --- | --- | --- |
| `getRecentSummaries` | 74.05ms | 6.93ms |
| `searchSummaries` 的 LIKE 後備 | 74.31ms | 5.23ms |
| `buildMemoryContext`（每輪對話） | 46.63ms | 6.99ms |

索引建置一次 41ms，DB 大小不變。附斷言 query plan 的迴歸測試 — 部分索引的 `WHERE` 必須與查詢完全一致才會被採用，查詢條件一改就會靜默退回整表候選。

### runner-audit.log 補上輪替與保留期

先前是 append-only 且沒有任何清理機制，正式環境實測 6 個月累積 2,096 行 / 424KB 且只會單調成長。它位在 `workspace/context/` 底下 — 也就是 agent 會讀的目錄 — 無上限成長不只是磁碟問題。

- 改為日輪替（`runner-audit-YYYY-MM-DD.log`）+ 7 天保留，與 event-bus 的 `events.jsonl` 同策略
- 輪替邏輯抽成 `src/services/audit-log.ts`；`runner.ts` 在 module top-level 就 `server.listen()`，邏輯留在裡面就無法在不啟動 HTTP 服務的情況下測試
- 目錄只在路徑變動時 `mkdir`，不再每寫一行就發一次 syscall

> 這兩項都是成長曲線問題，不是當下的瓶頸：以目前 12.6 則/天的速度，資料量要 2 年才會到 5×。

## 2.22.2 — 2026-08-13

### Context snapshot 的整表掃描與事件放大

`writeContextSnapshots` 是同步的，成本隨資料量線性成長，而八種生命週期事件每一個都各觸發一次完整快照。以生產資料副本放大實測，單次成本 4.4ms → 12.7ms → 28.6ms → **61.5ms**（2.3K / 11.5K / 46K / 115K 則訊息）。

- **`messages` 補上 `(role, timestamp)` 索引**：memory-health 的 24h 統計以 `role` 過濾但不帶 `user_id`，既有兩個索引都是 `user_id` 開頭而幫不上忙，query plan 退化成 `SCAN messages` — 115K 列時單次 40.21ms，佔整份快照成本三分之二。補索引後同一句降到 2.18ms，DB 大小不變；升級後首次啟動會自動建索引（115K 列約 252ms）
- **一致性稽核不再搬運整張表的內容**：改先用 `LIKE` 篩掉不可能命中的列（`LIKE` 對 ASCII 不分大小寫，是 regex `/i` 命中的超集），命中的才跑原本的 regex。生產資料實測 100% 的列屬於前者。已用邊界內容（大小寫、空標記、未閉合、含空白、NULL、多重標記）× 三種 archive 情境驗證新舊結果完全等價
- **事件觸發的快照改為合併寫出**：leading edge + trailing，預設最小間隔 1s，可用 `CONTEXT_EVENT_MIN_INTERVAL_MS` 調整。一次排程任務會連續送出 `schedule_fire` → `runner_request_done` → `schedule_done`，先前各寫一輪快照。合併後不會少寫，最後一個事件永遠會被寫出
- **修正 `recordRuntimeIssue` 的 dedupe 失效**：命中時就地改寫 `timestamp` 卻讓該筆留在原位，破壞了「陣列依 timestamp 遞增」這個反向掃描提前 `break` 的前提；後方若有更舊的項目，下一次掃描會在那裡誤判超出視窗而 break，掃不到仍在視窗內的同類項，於是重複發出 `runtime_issue` — 而每個這種事件又再觸發一輪快照，形成「錯誤 → 阻塞 → 更多錯誤」的迴圈

整體：115K 訊息下單次快照 **61.5ms → 8.9ms**，成長曲線由 14× 壓到 4×。

### 驗證缺口

- **`npm test` 只跑到 38 個測試檔中的 4 個**：glob 未加引號，而 bash 預設 `globstar` 是關的，`tests/**/*.test.ts` 退化成只匹配一層子目錄 — 所有頂層測試檔從未被 `npm test` 執行。加引號後 194 個測試全數執行
- `memory.ts` 的 fingerprint 分隔符直接嵌入 NUL 位元組，使 git 將整個檔案判為二進位而顯示不出 diff；改為跳脫序列，已驗證寫入 DB 的值逐位元組相同

## 2.22.1 — 2026-08-13

### Memoria 記憶服務升級至 v1.25.0

- `docker/memoria.Dockerfile` 的 `@raybird.chen/memoria` 由浮動 range `^1.11` 改為釘死 `1.25.0`；浮動 range 會讓同一個 TeleNexus tag 在不同時間建出不同的 Memoria（v2.22.0 映像實測帶的是 1.20.0），映像不再可重現
- 1.20.0 → 1.25.0 對 TeleNexus client 無破壞性影響：`memoria-recall.ts` 只讀 `data[].id` / `data[].snippet` / `meta.recall_id`，未使用 1.25.0 改為可 `null` 的 `meta.confidence`；`mode:'hybrid'` 與 `/v1/recall`、`/v1/remember`、`/v1/recall/:id/outcome`、`/v1/health` 四條路由維持不變
- 升級後既有 `memoria_data` volume 會自動跑 migration 14/15（長期記憶標記表、重建 `recall_fts` 清除 re-sync 造成的重複索引列）
- 需一次性維運動作：Memoria 1.24.0 修好「git 促升記憶未進 tree index」，既有 DB 的缺口要在容器內跑一次 `memoria index build` 才會補上

## 2.22.0 — 2026-07-17

### Telegram 原生草稿串流

- Telegram 私聊改用 Bot API `sendMessageDraft`，同一輪 reasoning、工具狀態與 liveness 共用固定 draft ID，完成或失敗時再送出正式訊息
- 群組、頻道、缺少 Telegram metadata 或 draft API 失敗時，自動退回單一可編輯 placeholder；中途失敗只切換一次，不產生重複狀態訊息
- 支援 `message_thread_id` 傳遞、20 秒 draft 保活、4 秒 typing 更新，以及 3900 UTF-16 code units 的安全進度上限
- 最終訊息確認送達後才清除 fallback；若 final 傳送失敗，保留進度訊息供錯誤復原
- 補齊 private draft、supergroup fallback、長 reasoning、錯誤終止與 final delivery failure 的測試

## 2.21.1 — 2026-07-08

### Docker image 瘦身

- Runtime image 改用 `npm ci --omit=dev` 安裝 production dependencies，不再複製 builder 的 dev `node_modules`
- 移除 Debian `chromium`，改由 `agent-browser install` 提供 Chrome，並補齊必要 shared libraries
- 新增 Dockerfile hygiene test，防止 dev dependencies 或雙瀏覽器重新進入 runtime image

## 2.21.0 — 2026-07-08

### 一鍵安裝與 GHCR 發佈機制

- **一鍵安裝/升級**：新增 `scripts/install.sh`，支援 `--version` / `--force` / `--upgrade` / `--dry-run`；使用者狀態（`.env`、`ai-config.yaml`、`data/`、`workspace/`）只在缺少時初始化，升級永不覆蓋
  ```bash
  curl -fsSL https://raw.githubusercontent.com/raybird/telenexus/main/scripts/install.sh | bash
  ```
- **GHCR 預建映像**：新增 `.github/workflows/release.yml`，tag push 時自動建置並推送 `ghcr.io/raybird/telenexus` 與 `ghcr.io/raybird/telenexus-memoria`，同時打包 `telenexus-docker-<版本>.tar.gz` 部署 bundle 上傳 Release；安裝端只需 `docker compose pull`，本機零建置
- **Runtime UID 對齊**：`PUID`/`PGID` 從 build args 改為 runtime 環境變數，由新的 `scripts/docker-entrypoint.sh` 在啟動時 remap `node` 使用者並以 `gosu` 降權，任意 host 帳號免手動 chown；compose 於 `cap_drop: ALL` 上補回最小 `cap_add` 集合
- 新增 `docker-compose.release.yml`（release 部署範本）、`docs/installation.md`（安裝/升級/回滾指南）、`LICENSE`（ISC）與 `scripts/test-installer-upgrade.sh` 靜態測試（`npm run test:installer`）
