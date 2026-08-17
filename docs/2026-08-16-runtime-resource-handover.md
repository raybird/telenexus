# TeleNexus Runtime 資源與穩定性 Handover

日期：2026-08-16

部署目錄：~/Documents/RunTelenexus

執行映像：ghcr.io/raybird/telenexus:v2.24.0

OpenCode：1.15.10

agent-browser：0.27.0

## 摘要

本次檢查只讀取執行中容器、cgroup、runner 狀態、日誌與原始碼，沒有重啟服務、
修改設定或刪除資料。

目前沒有可直接套用的版本升級：執行映像 v2.24.0 與本地 moltbot-lite
checkout 的 tag/HEAD 一致。現階段資源問題主要來自 agent/browser lifecycle、
timeout cancellation 與缺少 cgroup guardrail，不是單純版本落後。

主要結論：

1. agent-runner 是 TeleNexus 的資源瓶頸；Docker memory 約 778 MiB，
   cgroup current 約 1.06 GB，peak 約 1.48 GB。
2. runner 沒有 memory、CPU、PID 上限；目前 cgroup memory.max=max。
3. 最近一次工作完成後，headless Chrome 與 browser descendant processes 仍存活；
   沒有 active lane，但 browser tree 仍佔 runner 主要資源。
4. runner 狀態檔顯示 10/10 success，但日誌實際有 2 次 OpenCode 執行達到 30 分鐘
   timeout。timeout 被轉成正常文字，因此目前的 success rate 不能當作真正完成率。

## 目前執行狀態

| 服務 | Memory | CPU | 其他 |
|---|---:|---:|---|
| telenexus | 約 61 MiB | 約 0.01% | 23 tasks |
| memoria | 約 70 MiB | 約 0% | 11 tasks |
| agent-runner | Docker 約 778 MiB；cgroup 約 1.06 GB | 約 0.12–0.14% | 193 cgroup tasks |

runner cgroup peak 約 1.48 GB，目前沒有 high、max、oom 或 oom_kill
事件。193 是 cgroup tasks，包含 threads；docker top 實際 process rows 較少，
主要額外樹狀程序是 agent-browser/Chrome。

所有容器目前 healthy，沒有 restart 或 OOMKilled。主機當下仍有約 23 GiB 可用記憶體，
但無上限的 runner 會讓單次失控工作直接擴大影響範圍。

## 最近運行與異常

- runner 狀態檔最近一次更新顯示：
  - active interactive lanes：0
  - active scheduled lanes：0
  - total requests：10
  - runner success：10
  - 平均成功耗時：約 475 秒
  - zombie processes：0
- 日誌中有 2 次 Opencode process timeout，時間約 1,800,000 ms。
- scheduler 也有 2 個排程在 30 分鐘上限後被判定失敗。
- 最近一次排程結束後，Chrome/browser process tree 仍存活，表示完成或 timeout 路徑
  沒有可靠的 browser cleanup。
- MemoryBackfill 每 5 分鐘執行一次，目前反覆顯示沒有新的 archive sessions；
  現在是 enabled + dry-run，只有低量 CPU/日誌成本，但屬於無效輪詢。

另外，RunTelenexus/.env 有疑似格式錯誤的行：

    OPENCODE_VERBOSE_STDOUT=truePUID

需修正並確認實際載入值，避免相鄰環境變數被黏在一起。

## 建議處理順序

### P0：每次任務結束都清理 Browser 與 descendant processes

相關位置：

- src/core/opencode.ts
- src/core/cli-agent-base.ts
- src/runner.ts
- skills/agent-browser/SKILL.md

建議：

1. 在成功、失敗、timeout、abort 四條路徑共用 finally cleanup。
2. 明確執行 agent-browser close，不要依賴 Node 子程序自然結束。
3. 以 process group 管理 Opencode 與 Chrome；timeout 時一起終止 descendant。
4. 若互動流程需要持久 browser，改成有明確 lease/idle TTL 的 browser session，
   不要讓 default session 無限期常駐。
5. cleanup 失敗要寫入 runner audit 與 runtime issue，避免只在 console 留痕。

驗收條件：

- 工作完成或 timeout 後，沒有對應的 Chrome/browser descendant 殘留。
- runner 的 cgroup memory 在 idle 後能回到穩定 baseline。
- browser 需要持久狀態的互動工作仍能正常完成。
- zombie processes 維持為 0。

### P0：把 scheduler timeout 傳播到 queue 與子程序

目前 withScheduleTimeout 只讓上層 Promise timeout；ExecutionQueue 雖然已有
AbortController，scheduler 沒有把取消訊號一路傳到 Opencode process。

應建立以下取消鏈：

    scheduler timeout
      → executionQueue.cancel()
      → AbortSignal
      → kill Opencode process group
      → close agent-browser / Chrome
      → runner audit 標記 timeout

只修改 SCHEDULE_TASK_TIMEOUT_MS 不能解決資源殘留，因為底層工作可能仍在執行。
目前程式預設為 30 分鐘，而 .env.example 的說明曾寫 15 分鐘；在取消鏈修好前，
不要只靠縮短設定值來掩蓋問題。

驗收條件：

- timeout 後 1 個觀察週期內，Opencode 與 descendant 全部結束。
- runner 不再把 timeout 回覆誤標成正常完成。
- scheduler、runner audit、runtime issue 對同一工作使用一致的 timeout 狀態。

### P1：先加 runner cgroup guardrail

目前 compose 沒有 runner 的 mem_limit、mem_reservation、cpus 或 pids_limit。
建議以實測 peak 1.48 GB 為基準先加保守限制，例如：

- memory limit 從 2 GiB 起始驗證，不要一開始設在 peak 附近。
- memory reservation 約 512 MiB。
- PID limit 先設 384 或 512，再依 browser/工具需求調整。
- CPU limit 依一個完整互動與排程週期的 latency 實測決定。

這些是失控時的安全邊界，不是 browser cleanup 的替代品。加限制後要觀察 timeout、
Chrome 啟動失敗與正常互動延遲。

### P1：降低無效背景工作與設定噪音

- 若目前不需要歷史 session backfill，將 MEMORY_BACKFILL_ENABLED 關閉；或把
  5 分鐘 interval 拉長。
- CONTEXT_REFRESH_MS=60000 對現況不是主要瓶頸，不需優先調整。
- 修正 .env 的 OPENCODE_VERBOSE_STDOUT=truePUID 格式，重啟前先用容器內環境
  檢查實際值。

### P2：磁碟與映像整理

RunTelenexus 約 2.5 GiB，主要為 workspace/Memoria 約 1.1 GiB、state
與資料庫。Docker 還保留舊版 TeleNexus / Memoria images，可回收數 GiB；刪除前需
確認 rollback 與 state volume 需求，不要直接執行廣泛 prune。

## 後續驗證命令

    cd ~/Documents/RunTelenexus
    docker compose ps
    docker stats --no-stream
    docker logs --since 24h agent-runner
    docker logs --since 24h telenexus
    sed -n '1,220p' workspace/context/runner-status.md
    tail -n 120 workspace/context/runner-audit.log

每次調整後至少觀察一個完整排程週期與一個互動工作，記錄：

- runner cgroup current/peak/events
- Chrome/browser process count
- timeout 後的 descendant 是否全部退出
- runner audit 的真實 success/timeout/error 分布
- scheduler 與 runner 的狀態是否一致

## 追補：2026-08-17 回覆失敗與 runner process 調查

本次追查仍為唯讀，沒有重啟容器、修改設定或刪除資料。

### 回覆失敗的直接根因

四個失敗任務的 OpenCode 持久化 log 都記錄 provider HTTP 429：
`FreeUsageLimitError` / `Rate limit exceeded`。失敗時段為
`2026-08-16T15:30Z`、`16:00Z`、`22:00Z`、`22:30Z`；Telegram sendMessage
本身都能快速成功。

排程放大了問題：`withScheduleTimeout()` 在任務入 queue 時就開始 30 分鐘計時，
但 timeout 不會取消底層 queue task；同一 user 的 serial queue 因此可能出現：

    task A 執行中
      -> task B 已在 queue 等候並先達到上層 timeout
      -> task B 仍被 queue 取出並繼續執行
      -> provider quota 被背景重試與重複工作進一步消耗

此外，`OpencodeAgent` 將 `ETIMEDOUT` 轉成一般文字回覆，runner 因而把 timeout
記成 `ok=true`。現有 success rate 不能代表模型任務真的完成。

### `PIDs=193/195` 的正確解讀

Docker stats 的 PIDs 欄位是 cgroup task 數，包含 threads，不是獨立 process 數。
2026-08-17 07:51 左右的即時檢查結果為：

- cgroup `pids.current=195`，`pids.max=35819`，沒有 PID 上限壓力。
- `/proc` 實際約 16 個服務 process：runner Node、agent-browser wrapper、12 個
  Chrome process、2 個 Chrome crashpad process。
- 這棵 browser tree 約 14 個 Chrome/crashpad process，但合計約 180 多個 threads，
  所以 cgroup task 數看起來接近 195。
- runner Docker memory 約 268 MiB；cgroup `memory.current` 取樣約 385 MiB，
  差異來自 cache/accounting，均沒有 `high`、`max`、`oom` 或 `oom_kill` 事件。

browser wrapper 與 Chrome tree 已存活約 13 小時，時間上對應前一個排程開始後仍未
被關閉；這表示成功完成或 timeout 後都可能缺少 browser session cleanup。真正要修的
不是把 PID limit 調大，而是讓 browser 與其 descendants 具有明確生命週期。

目前最符合證據的機制是 agent-browser 透過 CLI 啟動 wrapper/Chrome，但 CLI invocation
或上層 opencode timeout 結束後沒有明確執行 close；觀察時 agent-browser 已被 container
PID 1（runner Node）收養。這與 `runProcess()` 只終止直接 child、沒有終止 process
group 的行為一致；仍應補上 close telemetry，以區分刻意持久化的 browser session 與 leak。

### zombie 的正確解讀

`workspace/context/runner-status.md` 的 07:00 快照曾記錄 `Zombie Processes: 1`，
但該檔案只在 request 完成時由 `markRunnerResult()` 更新，不是即時監控。07:51 的
直接 `/proc` 檢查為 0 zombie，因此目前沒有持續存在的 zombie 證據；較可能是 timeout
收尾期間的短暫狀態，或狀態檔尚未刷新。runner 的 zombie warning threshold 是 8，
所以單一瞬時 zombie 也不會標成 warning。

若未來再次出現，應同時記錄 zombie 的 PID、PPID、command 與持續時間；只有在跨越
多次取樣仍存在時，才視為 parent 沒有 wait/reap 的實際 leak。

### 可行修復方案

P0：修正 browser/process lifecycle

1. 在成功、provider error、timeout、abort 四條路徑共用 `finally` cleanup，明確關閉
   agent-browser session。
2. `runProcess()` 不要只對直接 child 呼叫 `child.kill('SIGTERM')`；應以 process group
   管理 OpenCode，timeout/abort 時先終止整個 group，必要時再對殘留 descendants 做
   SIGKILL，並等待 close/reap 完成。
3. scheduler timeout 要傳入 `ExecutionQueue` 的 AbortSignal，讓 queue、OpenCode、
   browser cleanup 使用同一條取消鏈。

P1：修正觀測與安全邊界

- runner status 改成定期刷新，分開顯示 process count、thread/task count 與 zombie count。
- 保留 browser session lease/idle TTL，避免 default session 無限期常駐。
- 加入 runner 的 memory、CPU、PID guardrail；這只能限制失控範圍，不能替代 cleanup。

相關程式位置：

- `src/core/process-runner.ts:38`：目前只終止直接 child。
- `src/core/opencode.ts:236`：OpenCode timeout 與 provider error handling。
- `src/runner.ts:134`：zombie 掃描；`markRunnerResult()` 才刷新狀態檔。
- `docker-compose.yml:91`：agent-runner 目前尚未設定資源上限。
