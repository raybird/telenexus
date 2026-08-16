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
