# 需求分析 — Issue 0010

建立日期：2026-10-04。規格與核准以 [README.md](./README.md) 為準。

## 需求描述

使用者要取代造成殭屍程序的 agent-browser；工具主要用於補足模型讀取網站的能力，不限定必須使用原工具。本次要求為規劃並開 GitHub issue，不包含直接修改或重啟部署。

## 現況分析

### 2026-10-04 既有診斷取樣

部署 v2.27.4，agent-browser 0.27.0、OpenCode 1.18.34。

| 範圍 | 殭屍數 | init | 補充 |
| --- | ---: | --- | --- |
| agent-runner | 91 | 未啟用 | /proc 確認全部 PPID 1；cgroup tasks 105 / 1024 |
| telenexus | 13 | 未啟用 | host ps 依容器主程序 PPID 分組 |
| 合計 | 104 | - | 包含 agent-browser、Chrome、crashpad 與相關 shell |

兩次取樣殭屍仍存在；runner 按程序名稱拆分為 agent-browser 7、crashpad 16、Chrome 67、shell 1。main 為 agent-browser 1、crashpad 2、Chrome 10。取樣沒有仍存活的 browser；Z state 不代表活 browser 正在用 CPU／瀏覽器 heap。

盤點來源為既有診斷的 docker inspect、host ps、容器 /proc 及 cgroup。host 程序查詢使用 `ps -eo pid,ppid,stat,etimes,comm`，按該次 inspect 的 container 主程序 PID 分組；PID 為取樣值，不寫死作日後查詢。容器觀測器需解析 /proc/[pid]/stat 的 state、ppid 並處理讀取期間程序退出，不以命令名稱或 kill(pid,0) 單獨判定存活。

Docker healthy 與 docker top 不足以證明 Z state 為零。cgroup pids.current 包含 threads，不能拿 105 當作 105 個殭屍。

### 程序與工具流程

Dockerfile 共用 base 安裝未釘版 agent-browser，並以它下載 Chrome；兩個執行服務共用工具環境及持久化 OpenCode 設定／skills。

OpencodeAgent.onRunFinished 只對排程呼叫 `agent-browser close --all`；互動聊天刻意保留跨回合瀏覽器。CliAgentBase 串流與 chatStructured 非串流皆有 finally 收尾入口，但「入口有執行」不證明真實 browser 已退出。

process-runner 終止直接管理的 detached process group；agent-browser daemon 自行脫離原 group，因此單一群組終止不能涵蓋它的所有資源。退役後也不能未驗證就假定 MCP 沒有相同問題。

runner 已有 /proc 殭屍計數；不新增另一套監控服務。取樣與驗收需同時覆蓋已完成任務的活程序、Z state、profile；既有 status 更新頻率不能代替每輪驗收採樣。

### 技能與設定遷移

sync-skills.mjs 只複製不存在的技能目錄。即使映像移除 agent-browser，workspace 與 opencode_config volume 仍可能留舊技能；有使用者修改的版本必須保留或備份，不能刪整個設定／技能目錄。memory MCP 與認證亦不得被新 browser 設定覆寫。

## 問題點總結

- init 缺席使被收養的已退出子程序無法可靠回收；換 browser backend 本身不能修復這一層。
- daemon 與任務生命週期分離，收尾沒有完整程序／profile 的完成證據。
- 全域 close 的併發干擾是待測風險，不宣稱已有事故。
- HTTP 可讀的普通網站仍可能走重型 browser，增加不必要的程序啟動。
- 跨回合／登入／完整互動能力是否真的使用尚未盤點，不能直接視作不需要。
- 更新映像不會自動遷移持久化的工具指引。

## 目標與非目標

目標是公開網頁讀取、按需渲染、可回收程序、task-owned 隔離及資料保留；驗收對應 README 的 SCN-001～007。

不新增 browser sidecar、登入服務、長期 profile、表單自動化或新模型 provider；不清理 opencode.db 或改動 issue #9 的 session 保留期邏輯。現有 104 個 Z state 的消除需排空後重建容器，這是另行核准的維運切換，不是本次建檔已完成的修復。
