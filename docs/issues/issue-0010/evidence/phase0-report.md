# Phase 0 契約探測紀錄

日期：2026-10-04。Task：T0.1、T0.2；支援 SCN-003、SCN-005、SCN-007 的風險驗證，**不是完整 Scenario 驗收**。核准基線 d345ba1bc3f391bd2038f8ca0341ccbf742490d0；僅新增 issue evidence，不修改產品或正式服務。

## 固定環境與安全範圍

- 基底：`ghcr.io/raybird/telenexus@sha256:4fd13c3bbdcc1e6f2dd8cb37cbbdaae3a8c48287928d59c63fa36db2630d8236`，本機 image ID `sha256:6c2208eec83cc7b83bb0a71ffb3aba642462dacc79b83f262f5bcfe8a4da4ae8`。
- 探測映像：`issue10-mcp-probe:20261004`，image ID `sha256:8bfb44aadb11a4f096e38c6e6c7a4f79a4c3403f4ce94ed9c853895c2f69a814`；[Dockerfile.probe](./Dockerfile.probe) 僅在建置下載固定 `chrome-devtools-mcp@1.10.1`。完整版本與 npm integrity 見 [environment.log](./environment.log)。
- 容器 Node 22.23.3、linux x86_64、OpenCode 1.18.34、Chrome for Testing 154.0.8037.92。Chrome 暫用既有映像內 binary，不代表已完成淘汰 agent-browser 或獨立正式 binary 安裝。
- 全部為 `issue10-*-20261004` 拋棄式容器：`--network none --cap-drop ALL --security-opt no-new-privileges --user node`，只唯讀掛載本 issue evidence；無正式 volume、token、登入 profile 或 publish port。
- 觀測對照限制 memory 256m／pids 64；MCP 測試限制 memory 2g／pids 1024。
- 先測原生 sandbox，真實導覽得到 `Protocol error (Target.setDiscoverTargets): Target closed`；後續 [sandbox-stderr.log](./sandbox-stderr.log) 明確回報 `No usable sandbox!`，但不能據此歸因特定 AppArmor／kernel／seccomp 限制。差異對照使用專案既有 `--no-sandbox --disable-dev-shm-usage`，未加 capabilities、未改成 root；這不是 sandbox 已可用的證據，也沒有修改正式安全設定。

## T0.1：觀測器對照通過

已知樣本由短命 helper 建立 detached 子程序後退出，觀測 PID1 始終保持存活。觀測器讀 Linux `/proc/*/stat`／cmdline，保存 PID、state、PPID、PGID、SID、starttime，避免用 PID 存在誤判活程序。profile 在自有暫存 root 中製造及移除。

| 對照 | 第 0～1 秒 | 第 2～4 秒 | 容器量測後 |
| --- | --- | --- | --- |
| no-init | PID 20，R→S，PPID 1 | 同 starttime `22264204`，Z=1 | running=true，init=null |
| init | PID 21，R→S，PPID 1 | PID 消失，Z=0 | running=true，init=true |

原始資料：[no-init-control.jsonl](./no-init-control.jsonl)、[init-control.jsonl](./init-control.jsonl)、[control-inspect.log](./control-inspect.log)。兩組 profile-present 都為 1，profile-removed 都為 0。

`node docs/issues/issue-0010/evidence/proc-observer.test.mjs`：exit 0，2 tests／2 pass／0 fail，見 [proc-observer-tests.log](./proc-observer-tests.log)。測試以人工固定 stat 字面值驗證含括號 comm／Z／live／starttime，另外確認自身活 PID 與不存在 PID。它不代替真容器對照。

反向自檢：若 orphan 沒回收，no-init 實際出現 Z=1；init 同取數路徑出現 PID 消失／Z=0。因此不是讀錯範圍但兩邊都回零。若 profile 沒清理，清單從 1 不會變 0。

## T0.2：原生 MCP 收尾契約未通過

真實 MCP stdio JSON-RPC：`initialize` → `notifications/initialized` → `tools/list` → `tools/call navigate` → `tools/call evaluate`。CLI 入口以發布 package.json 的 bin 為準，不使用只匯出 library 的 index.js。發布版回傳 slim `navigate(url)`／`evaluate(script)`／`screenshot()` 三工具；正文在瀏覽器執行 fixture JavaScript 後才變成獨立字面值 `ISSUE10_JS_BODY_20261004`，evaluate 同時回傳實際 localhost URL。

每輪先記 baseline，量測工作期間新增 PID 身分（PID＋starttime），退出後逐秒量測到 15 秒；PID1 與容器持續存活。此單工作拋棄式容器沒有其他工作，所有非 baseline 程序均屬本 probe。**此歸屬方法不是多工作共用容器的正式所有權實作**。

| 案例 | 正文／URL | MCP 退出 | 第 15 秒 live／Z／profile | 判定 |
| --- | --- | --- | --- | --- |
| 原生 sandbox、EOF | 導覽失敗，未讀到 | code 0 | 0／0／0 | 閱讀失敗，不是通過 |
| no-sandbox、正常 EOF | 真實讀到 | code 0 | 0／0／0 | 此局部正常路徑通過 |
| no-sandbox、SIGKILL MCP | 真實讀到 | signal SIGKILL | 0／0／1 | profile 收尾失敗 |
| no-sandbox、SIGSTOP Chrome root → EOF | 真實讀到 | code 0 | 0／0／1 | profile 收尾失敗，即使 exit 0 |

原始資料：[mcp-sandbox.jsonl](./mcp-sandbox.jsonl)、[mcp-eof.jsonl](./mcp-eof.jsonl)、[mcp-kill.jsonl](./mcp-kill.jsonl)、[mcp-stopped.jsonl](./mcp-stopped.jsonl)、[mcp-inspect.log](./mcp-inspect.log)。SIGSTOP 組第 0～4 秒 live=11／Z=0，第 5 秒取樣 live=5／Z=6，第 6 秒回 0／0，profile 仍留到第 15 秒；暫時 Z 可被 init 回收不代表 profile 已清理。

失敗時差異：兩個故意故障的 `cleanupPassed=false`，profile 留存 1；正常 EOF 的 `cleanupPassed=true`、profile 0。判準確實能抓到「程序死了但 profile 還在」；不能只以 exit 0、容器 healthy 或 Z=0 當通過。

## 工作專屬 launcher 與 OpenCode 探測

2026-10-04：依原核准技術分析，只在 probe 實作最小 launcher；每工作建立自有 TMPDIR／XDG root，按親緣、root 與 PID＋starttime 歸屬收尾，使用 `setsid` 將 launcher 與 OpenCode 程序群分離。不依賴模型關閉，不建立常駐 sidecar。launcher 自身 SIGKILL 仍不能執行收尾，不能宣稱涵蓋宿主／容器被殺。

- [launcher-mcpkill-v2.jsonl](./launcher-mcpkill-v2.jsonl)：MCP child SIGKILL 後 launcher exit 128；收尾與工作成功分開，不再吞異常為 exit 0。
- [opencode-static-v2.jsonl](./opencode-static-v2.jsonl)、[opencode-dynamic-v2.jsonl](./opencode-dynamic-v2.jsonl)：真 OpenCode 1.18.34 透過本地假 provider 決定工具呼叫；正文必須來自真工具結果，最終 OpenCode 文字斷言正文與來源 URL。真 Chrome executable wrapper 的啟動事件為 0／1 正負對照。此方式不是認證過的真模型自主路由品質驗收。
- [opencode-groupkill.jsonl](./opencode-groupkill.jsonl)、[opencode-pidkill.jsonl](./opencode-pidkill.jsonl)：真 OpenCode PGID 15、launcher PGID 31；讀取後強制終止單 PID／整個 OpenCode PGID，第 15 秒活程序／Z／profile 均為零。這是隔離設定下的契約證據，不是產品整合完成。
- [concurrent-v1.jsonl](./concurrent-v1.jsonl)：兩個真 MCP 在同 origin 設定 owner=A／B cookie，分別取得獨立 JS 正文與 URL。A transport EOF 後 B 保留自己的 cookie 並再次成功，最後兩工作程序與 launcher root 為零。最終 launcher 修訂後的 [concurrent-v2.jsonl](./concurrent-v2.jsonl) 重跑亦通過。此局部探測不是 local／runner 產品端 SCN-004 完整驗收。

2026-10-04 獨立 Oracle 探測諮詢（非 PR review、非 Scenario PASS）確認以上 raw 與局部結果一致。指出並已修正首次 child 身分捕獲、送訊號前重讀 starttime、異常退出保留及 EPIPE；仍揭露 stat／kill 存在極短 TOCTOU，並非 pidfd 原子保證。新增完整 launcher root 殘留判準，避免只掃名稱含 profile。

### 未通過紀錄與修正原因

- 舊 [opencode-navtimeout.jsonl](./opencode-navtimeout.jsonl) 是 `Target closed`，不是逾時，不列為通過。重跑 [opencode-navtimeout-debug.jsonl](./opencode-navtimeout-debug.jsonl) 的 [Chrome 原始診斷](./chrome-socket-path-failure.log) 確認測試 TMPDIR 過長造成 `SingletonSocket` 路徑超限；改成短前綴後 [opencode-navtimeout-v4.jsonl](./opencode-navtimeout-v4.jsonl) 得到真 `MCP error -32001: Request timed out`，且伺服器已收到刻意阻塞的導覽。
- [opencode-startupfail-v3.jsonl](./opencode-startupfail-v3.jsonl) 的活程序／Z／profile 均為零，但完整 launcher root 仍留 1，強化判準呈紅燈。收尾改為等待 child exit 或寬限時間，子程序已結束時立即清理；[opencode-startupfail-v4.jsonl](./opencode-startupfail-v4.jsonl) 同組檢查通過，不靠忽略殘留修復。
- [matrix-static-v5-summary](./matrix-v5-summary.json)：真工具清單保留 memory MCP，但 OpenCode 原生補上缺少的 `$schema`，使 byte-identical 判準失敗。改用含官方 `$schema` 的有效既有設定重跑，沒有弱化設定檔未被改寫的斷言。

最終程式修訂後的七路退出＋設定合併矩陣由 `node docs/issues/issue-0010/evidence/run-opencode-matrix.mjs` 重跑；保存精確 docker 命令、image、程式 SHA-256、init 與量測時容器仍存活的狀態，見 [matrix-v6-summary.json](./matrix-v6-summary.json)。腳本只停止其建立的測試容器，量測前 PID1 始終存活；重跑須使用未占用的明確容器名稱，不能拿正式容器替代。

| 最終 v6 路徑 | 工具／退出驗證 | 第 15 秒 live／Z／profile／launcher root | 設定合併 |
| --- | --- | --- | --- |
| static | 最終正文＋URL；Chrome 啟動 0 | 0／0／0／0 | memory 工具保留，原檔 byte-identical |
| dynamic | 真 JS 正文＋URL；Chrome 啟動 1 | 0／0／0／0 | 同上 |
| startupfail | 真缺 binary 錯誤，未偽造正文 | 0／0／0／0 | 同上 |
| navigationtimeout | fixture 真阻塞，MCP Request timed out | 0／0／0／0 | 同上 |
| cancel | 真 OpenCode PGID SIGTERM | 0／0／0／0 | 同上 |
| upstreamfail | 導覽後注入 401，真 OpenCode error／exit 1 | 0／0／0／0 | 同上 |
| groupkill | 真 OpenCode PGID SIGKILL，launcher 不同 PGID | 0／0／0／0 | 同上 |

矩陣 7／7 通過；每案 inspect `init=true`、量測時 `running=true`。原始逐秒資料為 `matrix-<mode>-v6.jsonl`。取數判準沿用 T0.1 對照；2026-10-04 再跑 `node --test docs/issues/issue-0010/evidence/proc-observer.test.mjs`，exit 0、2／2 通過。假 memory fixture 只證明設定合併，不 mock browser／HTTP 核心行為，亦不連正式 Memoria。

## 決策與剩餘探測

2026-10-04：T0.1、T0.2 完成，Phase 0 契約 gate 通過，允許推進 T1.1。可行性條件為固定版本、短 TMPDIR、明示 setsid 的工作專屬 launcher、init 及既有容器權限；不能縮減成只加 isolated 或只加 init。45 次循環、正式映像的獨立 Chrome 來源、產品 local／runner 整合及遷移仍屬後續 Task，SCN-001～007 尚未完整驗收。

根因解釋以實測為主：`--isolated` 的臨時 profile 並非 TTL 回收；MCP 被 SIGKILL 無法執行非同步移除，而 Chrome 關閉受阻後 CLI 退出亦不能證明 profile 移除完成。因此純換後端不足，必須有不依賴模型或 MCP 自願關閉的 task-owned 外層收尾。

可在原核准範圍內探測的最小方向：每工作 launcher 建立自有 TMPDIR、保留其 parent 角色而不 exec MCP，轉送 stdio；監看 EOF／child exit，按 PID＋starttime 和自有 root 追蹤本工作程序，必要時限本工作終止，再移除自有暫存 profile。launcher 自身 SIGKILL、OpenCode 強制終止與並行隔離仍需真實故障測試，不能先宣稱已解決。不建立 sidecar／共享 pool，不改正式服務。

## code-simplify

2026-10-04：僅將新 observer 的回傳物件展開並將新增註解改繁體中文；解析欄位／契約不變，重跑相同 parser 測試 2／2 通過。後續針對 PID、退出與路徑的修改屬探測修復，不冒充純重構；最終需重跑同組矩陣。其餘 probe 精煉為 no-op，沒有可證明必要且行為不變的額外抽象，保持原狀。未改產品 symbol，不需要把 probe 成功誤列為產品紅綠燈。
