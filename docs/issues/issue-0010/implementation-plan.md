# 實作計畫 — Issue 0010

建立日期：2026-10-04。本檔是階段、進度與後續 Task／證據的唯一來源；README 及 GitHub 只提供入口／快照。使用者於 2026-10-04 核准規劃並以 /dev-cycle 授權推進；2026-10-05 Phase 0～4 的實作、驗證與初次獨立審查完成，PR #11 等待合併。

## 設計方案

普通公開文件走既有 webfetch／HTTP；只有 JS 正文需要渲染才走 Chrome DevTools MCP。工作專屬 MCP、Chrome 與臨時 profile 由任務生命週期控制，不能用全域 close，也不能依賴模型自願收尾。容器 init 處理孤兒回收，並非關閉活程序。

使用前後差異與範圍以 [README.md](./README.md#快速導覽與關鍵差異) 及 [technical-analysis.md](./technical-analysis.md) 為準。不建立新的網頁服務／sidecar。

候選收尾入口仍為 OpencodeAgent.onRunFinished／CliAgentBase finally 與 chatStructured finally；僅契約探測證實需要才改它們的行為／簽名。正常 close 與強制終止是否需要不同所有權處理，必須由 Phase 0 的真實程序樹決定。

## 風險與首要驗證

唯一風險策略來源：[README.md 的風險與首要驗證](./README.md#風險與首要驗證)。第一個 gate 是外部程序契約驗證，不預設先全面實作後再補端到端測試。

## 實作步驟（Phase／Task 已拆解）

2026-10-04 使用者以 /dev-cycle 授權推進，已依 decompose 在本檔細化 Task。實作前先提交核准規格並回填 README 的核准 commit；待提交不代表 gate 已完成。以下 Task 是唯一的進度／證據來源，Phase 敘述保留設計與 gate，不另作第二份任務清單。

### Phase 0 — 外部契約與觀測器驗證

- 2026-10-04 已拆解 T0.1、T0.2；進度與證據見下方 Task。無前置實作相依。對應 SCN-001～005、007。
- 產出：固定版本／平台清單、工具契約樣本、受控靜態與 JS fixture、真實程序／profile 證據、MCP 設定合併與所有權的可行性決策。
- 方法：不帶正式 Telegram token、不掛生產資料，使用拋棄式容器／測試設定。在 no-init 組製造已知被收養的 Z state，驗證 /proc 觀測器能讀到；init 組重跑並確認回收。再跑實際 OpenCode → MCP → Chrome 的正常、部分啟動失敗、取消、導覽逾時、上游失敗與強制終止。
- 完成判準：觀測器在已知失敗組會失敗；所選套件發布版確實支援工具與旗標，退出後 15 秒內無工作資源殘留，且已確認不共用 profile。HTTP 與 JS fixture 正文／URL 為預先定義的獨立答案。
- Gate：契約不成立則停止後端替換；記錄缺口，不擴張成未核准 sidecar。核准不包含啟動正式 stack。

### Phase 1 — 容器回收

- 2026-10-04 已拆解 T1.1；進度與證據見下方 Task。相依：Phase 0 gate；對應 SCN-003、007。
- 產出：開發／release compose 的兩個執行服務 init 設定與測試；dev overlay 繼承一致。
- 完成判準：resolved Compose 配置及測試容器 inspect 均確認 init 啟用；刻意 orphan／Z fixture 被回收；compose parity 保持。保留 runner pids_limit，不靠調高上限通過。
- 邊界：不改 Memoria，也不立即重建正式服務。

### Phase 2 — 網頁工具與任務所有權

- 2026-10-04 已拆解 T2.1～T2.3；進度與證據見下方 Task。相依：Phase 0 相容契約、Phase 1 回收；對應 SCN-001～005、007。
- 產出：固定 MCP／Chrome 的共用 base 安裝、MCP 設定合併、最小網頁路由指引與所需生命週期處理。
- 完成判準：普通文件真實工具路徑不啟動 Chrome；JS fixture 能讀到正文。兩個併發工作 cookie／profile 不共用，取消其一另一個繼續成功。串流、非串流、local、runner、排程與互動均涵蓋退出。
- 限制：保留非 root／既有權限，不暴露 CDP、不掛宿主 profile；MCP 失敗如實記錄，後續 HTTP 閱讀不受影響。若既有工具已實現目標，不另造 fetch backend。

### Phase 3 — 技能與設定遷移／淘汰

- 2026-10-04 已拆解 T3.1；進度與證據見下方 Task。相依：Phase 2 通過；TBD-2 實際相容性盤點，若發現規格缺口需先處理；對應 SCN-006。
- 產出：退役 agent-browser 的套件、下載步驟、專用 env、全域 close；舊內建技能辨識／保留自訂版本的遷移；新最小閱讀指引。
- 完成判準：以新安裝及含自訂內容的升級 fixture 各跑兩次，同步後只載入新指引，認證與既有 memory MCP／自訂 MCP 不變，文字聊天 -c 可延續；修改過的舊技能保留／備份並明列未自動遷移原因。
- Gate：不能證明舊技能屬產品內建就不刪；不得清空整個 volume／skills。未解決既有互動依賴時不移除後端。
- 修改任何產品 AGENTS.md／SKILL.md 前載入 writing-rules；本次規劃沒有改這些檔。

### Phase 4 — 重複回歸與維運交付

- 2026-10-04 已拆解 T4.1、T4.2；進度與證據見下方 Task。相依：Phase 1～3；對應 SCN-001～007。
- 產出：45 次循環、併發矩陣、專案測試證據、必要常青文件與切換／回退說明。
- 完成判準：正常 20 次、每種非正常結果 5 次；每次結束 15 秒內瀏覽器 Z 數、已完成工作活程序數、profile 殘留數均為零。另記 cgroup tasks 趨勢，不以它單獨取代前三項。連續兩工作與 local／runner 交錯取消均無干擾。
- 專案 gate：依序 npm run build、npm run test、npm run lint；核對 test 數量及巢狀測試未漏跑；compose parity；涉及 installer／升級流程加 npm run test:installer。保留每筆實際命令、exit、版本、日期及 Scenario 映射，不將尚未執行寫成通過。
- 常青文件：依實際改動更新配置、安全邊界、安裝、模組／架構與必要產品指引；不改歷史提案。
- 維運切換：維護者另行核准後，先排空聊天／排程、備份需要遷移的設定／技能、以新映像與 compose 重建兩個執行容器，確認新基線。一般 restart 不能套用新的 init 設定。回退復原舊映像／配置但保留 init 回收；不刪認證、session、排程或 Memoria 資料。
- 不在本期建檔時發版、升級、清除現有 104 個殭屍或重啟服務。

## Task 清單與相依

以下 Task 於 2026-10-04 拆解。SCN 的責任 Task 為 T2.1→001、T2.2→002／003／005、T2.3→004、T3.1→006、T4.1→007，集合完整且不重複；T0／T1／T4.2 提供必要支援與交付證據。

### T0.1 — 觀測器對照與固定測試環境

- 產出與最小範圍：issue evidence 下的拋棄式容器探測 fixture、/proc／profile 觀測器及版本／平台紀錄，不改正式容器／產品程序。
- 相依：無；核准規格提交後執行。支援 SCN-003、007 及首要風險證據。
- 完成判準：no-init 已知 orphan／Z 對照確實被觀測到；init 組能回收；確認觀測器分辨活程序、Z、已消失 PID 與 profile，保存命令與實際數值。
- 驗證：真實正／負對照加 parser 單元測試；fixture／探測不改產品行為，不假造產品紅綠燈。
- 狀態：✅ 2026-10-04 已完成。
- 證據：[Phase 0 探測紀錄](evidence/phase0-report.md) 的 T0.1；no-init 組第 2～4 秒 Z=1，init 組相同觀測路徑 Z=0 且 PID 消失，兩容器保持存活；profile 正／負對照 1→0，parser 測試 2／2 通過。此證據不代表產品 Scenario 已通過。

### T0.2 — OpenCode／MCP／Chrome 真實契約 gate

- 產出與最小範圍：固定發布版本 MCP／Chrome 探測、OpenCode 隔離設定、各退出路徑／並行所有權紀錄與可行性決策；不掛認證或生產資料 volume。
- 相依：T0.1。支援 SCN-001～005、007。
- 完成判準：發布版本的工具／旗標可用，實際 OpenCode 能取得受控 HTTP／JS fixture 的獨立正文與 URL；正常、部分啟動失敗、取消、導覽逾時、上游失敗、強制終止後 15 秒內無本工作活程序／Z／profile；兩工作所有權獨立。
- 驗證：實際 MCP transport 與 OpenCode 工具路徑、程序樹／profile 每秒採樣；發布套件原始碼只輔助解釋。若缺口只能靠擴張架構或修訂核准行為解決，先回報新決策，不推進 T1 以後。
- 狀態：✅ 2026-10-04 已完成，Phase 0 gate 通過。
- 證據：[Phase 0 探測紀錄](evidence/phase0-report.md)、[最終矩陣](evidence/matrix-v6-summary.json)；固定 MCP 1.10.1／Chrome 154.0.8037.92／OpenCode 1.18.34，最小 launcher 補足原生 profile 收尾缺口。真 OpenCode HTTP／JS、memory MCP 設定合併及六種工作退出的最終矩陣 7／7 通過，每輪 15 秒內 live／Z／profile／launcher root=0，量測時容器仍存活；[並行 v2](evidence/concurrent-v2.jsonl) 的 A 收尾不影響 B cookie／正文。這是隔離可行性 gate，不代表產品 Scenario 已完成；條件與限制見報告。

### T1.1 — 兩服務 init 回收與 compose parity

- 產出與最小範圍：兩份 compose 共用設定、dev 繼承檢查及測試；不動正式部署。
- 相依：T0.2 gate 通過。支援 SCN-003、007。
- 完成判準：resolved Compose、fresh 測試容器 inspect 及 orphan 對照均證明 init 生效；parity 測試通過，保留 pids_limit。
- 驗證：先以缺 init 的配置／容器取得行為紅燈，再修改設定並重跑；配置單元與真容器回收屬不同失敗面。
- 狀態：✅ 2026-10-04 已完成。
- 證據：[Phase 1 紀錄](evidence/phase1-report.md)；配置紅燈 2／2 fail → init／parity 3／3 pass；base／release／dev 的兩服務 resolved init=true，六個 fresh fixture 的 inspect Init=true、Running=true、orphan PID 消失／Z=0。build／335 tests／lint 均 exit 0，沒有正式服務操作。

### T2.1 — HTTP 優先閱讀

- 產出與最小範圍：沿用既有 webfetch 的必要配置／工具指引與受控閱讀測試，不新增 HTTP 服務。
- 相依：T1.1。責任驗收：SCN-001。
- 完成判準：實際 OpenCode 取得 fixture 已知正文／URL，工作期間沒有 Chrome 啟動；websearch 不可用仍可對給定 URL 閱讀。
- 驗證：實際工具紀錄與獨立正文斷言；若既有 webfetch 已符合行為，記 characterization 與指引靜態檢查，不虛構既有功能紅燈。
- 狀態：✅ 2026-10-04 已完成。
- 證據：[HTTP 閱讀紀錄](evidence/phase2-http-report.md)，既有 webfetch characterization 取得真正文／URL、Chrome 啟動 0；dynamic 對照啟動 1。新增最小 web-reading 指引，分支人工查核與 skill 格式驗證 exit 0；沒有新增 HTTP 後端。真模型自主選工具品質尚未驗證，未將 fake provider 冒充該證據。

### T2.2 — 動態閱讀、任務收尾與失敗傳遞

- 產出與最小範圍：Docker 共用 base 的 MCP／Chrome 固定安裝、設定合併與契約探測證實必要的最小程序收尾。
- 相依：T2.1。責任驗收：SCN-002、003、005。
- 完成判準：JS 正文／URL 正確；六種退出結果收尾符合 15 秒窗；MCP／binary 不可用如實失敗，後續 HTTP 仍成功；不掛宿主 profile、不放寬容器權限。
- 驗證：先補真實失敗重現與收尾邏輯紅燈，再最小實作；串流／非串流、local／runner、聊天／排程均實測，mock 不能取代核心 browser 契約。
- 狀態：✅ 2026-10-04 已完成。
- 證據：[真產品整合報告](evidence/phase2-product-report.md)；實際 runtime 映像 10／10 矩陣涵蓋六種退出、串流／非串流、聊天／排程，15 秒內 live／Z／profile／root=0。同環境 Chrome 始終缺少的兩工作證明 JS 如實失敗後 HTTP 仍成功；EACCES 負對照留下清理失敗紀錄且不假報 cleanup PASS。內層紅綠與 356 tests／build／lint 均通過；配置及安全常青文件已更新。local／runner 取消實測見 T2.3；不是 45 次最終回歸。

### T2.3 — 並行工作所有權隔離

- 產出與最小範圍：兩個工作隔離／取消回歸與必要所有權修補，不新增全域 browser pool。
- 相依：T2.2。責任驗收：SCN-004。
- 完成判準：不同 cookie／profile／收尾目標；取消其一另一個仍成功，包括 local 與 runner 同時執行。
- 驗證：實機並行及獨立 fixture 斷言；需要修補時保留先紅後綠證據。
- 狀態：✅ 2026-10-04 已完成。
- 證據：[真產品整合報告](evidence/phase2-product-report.md#localrunner-所有權scn-004) 與四輪摘要；local／runner 同源不同 cookie，串流／非串流、互動／排程各涵蓋取消一方，另一方再讀成功，最終 runner 仍活著且工作 live／Z／profile／root=0。保留實際 runner 取消留下 A root 的紅燈及原生 HTTP signal／response disconnect 修補後綠燈；沒有新增全域 pool。

### T3.1 — 相容性盤點、安全遷移與舊後端退役

- 產出與最小範圍：實際登入／跨回合依賴盤點、內建技能辨識、設定合併及 agent-browser 安裝／全域 close 退役；不刪使用者資料。
- 相依：T2.3；實際依賴有核准範圍外缺口時先處理決策。責任驗收：SCN-006。
- 完成判準：新安裝／升級 fixture 各遷移兩次，認證、memory／自訂 MCP、文字 -c 延續、客製技能不變；內建舊指引不再載入，客製舊版明列保留／備份；映像不再依賴 agent-browser。
- 驗證：遷移紅綠、idempotence 及資料前後獨立清單；修改技能前用 writing-rules，不清空 volume。
- 狀態：✅ 2026-10-05 已完成。
- 證據：[相容性盤點](evidence/phase3-compatibility-audit.md)，限定窗口 2175 工具 parts 中有 2 次完成的 click，用途無法由 @ref 判定；未觀察到登入／state save-load／跨使用者回合，不等於不存在。2026-10-04 使用者「確認」接受公開閱讀範圍、不保證沿用舊自動點擊，TBD-2 已解除；遷移與退役尚待測試，不標 SCN-006 通過。
- 最終證據：2026-10-05 [產品遷移報告](evidence/phase3-product-report.md)，新安裝／升級各同步兩次、真原生技能讀取及同 session `-c` 延續、認證／MCP／客製 bytes 保留；12 項安全遷移與映像退役通過，補齊真實探測發現的 ripgrep 依賴。SCN-006 通過，正式切換未執行。

### T4.1 — 重複生命週期與完整回歸

- 產出與最小範圍：45 次循環／併發矩陣與 build／test／lint／installer 必要證據。
- 相依：T3.1。責任驗收：SCN-007；最終整合支援 SCN-001～006。
- 完成判準：每輪 15 秒內完成工作活程序、browser Z 與 profile 均為零，無 cgroup 累積趨勢；兩工作互不干擾；全部相關測試與專案 gate 通過。
- 驗證：沿用 T0.1 正／負對照驗證取數管道，保存每輪命令／task ID／PID 起始時間／實際數值，不能只看 healthy 或 cgroup。
- 狀態：✅ 2026-10-05 已完成。
- 證據：[Phase 4 回歸](evidence/phase4-report.md)：同一存活容器 45／45、每轮 15 秒 live／Z／profile／root=0；45 輪 cgroup baseline/final、初始與最後均 8，沒有累積。新版四組 local／runner 並行矩陣 4／4；370 tests、build、lint、installer exit 0。

### T4.2 — 常青文件與交付範圍

- 產出與最小範圍：實際變更需要的配置／安裝／安全／工具文件，drain／備份／重建／回退手冊，以及固定 BASE／HEAD 的 PR 與獨立審查。
- 相依：T4.1。交付整合支援 SCN-001～007。
- 完成判準：文件符合實作且無不存在連結；Proof of Test 每個 Scenario 有有效證據，review artifact 可追溯；不自行 merge／發版／操作正式服務。
- 驗證：文件靜態／人工查核、GitNexus detect_changes、create-pr 及獨立 review；文件不改行為時採等價證據。
- 狀態：✅ 2026-10-05 已完成。
- 證據：[Phase 4 回歸](evidence/phase4-report.md) 的常青文件與限制；[PR #11](https://github.com/raybird/telenexus/pull/11)、[a0af7ea 獨立 PASS](review-a0af7ea.md)。狀態文件收尾產生新 HEAD 後，另按該 HEAD 報告查核有效性，不因相同產品來源自動沿用舊 PASS；正式服務未操作，不自行 merge／發版。

## 測試策略與驗收映射

| Scenario | 外迴圈／實機層 | 內迴圈／靜態層 |
| --- | --- | --- |
| SCN-001 | OpenCode 讀靜態 fixture，內容／URL／Chrome 啟動事件 | 路由指引檢查；必要配置測試，不以文字匹配取代行為 |
| SCN-002 | 真實 MCP 讀 JS fixture，來源與正文 | MCP／Chrome 配置與支援旗標契約 |
| SCN-003 | 六種退出結果的程序／profile 真實盤點 | 必要收尾邏輯的取消／逾時／失敗測試 |
| SCN-004 | 兩工作 cookie/profile 隔離，取消其一另一成功 | 所有權辨識及不全域關閉 |
| SCN-005 | 缺 binary／MCP 啟動失敗後再讀普通文件 | 錯誤傳遞及部分啟動收尾 |
| SCN-006 | 新安裝／升級／重複遷移複本；-c 延續 | 設定合併、客製技能保護、映像依賴及 compose parity |
| SCN-007 | 45 次固定循環、init/no-init 對照 | /proc 解析以已知 Z／活／已消失程序測試 |

有整合與底層不同失敗面時保留雙迴圈紅綠；若同層可合併需說明沒有漏掉另一層，不能只 mock browser 關閉。無重構則記 no-op。規劃文件本身不改可執行行為，以連結／Scenario／metadata 靜態檢查為等價證據。

### 防假綠燈

失敗必須造成：殘留 PID／Z／profile 非零、正文／來源斷言錯誤，或另一工作無法完成。若看 healthy、close hook 被呼叫、exit 0、僅統計 Node 或單次 cgroup tasks，即使 Chrome 留下來仍可能綠，因此不用它們作終態證據。

觀測先用已知正／負樣本驗證，再保存每次 task ID、容器範圍、PID 啟動時間、採樣命令、日期與實際值；測試 fixture 不含私人登入資料。browser／MCP 官方程式碼只能作研究來源，不能當測試通過。

## 檢查清單

- [x] 2026-10-04 建立 issue 與初始範圍／風險／待核准劇本
- [x] 2026-10-04 保存首要契約驗證、對照組與失敗差異的計畫
- [x] 2026-10-04 使用者核准規格與本期相容性取捨；來源見 README
- [x] 2026-10-04 初始核准規格已提交 d345ba1，README 回填核准基線
- [x] 2026-10-04 在本檔細化 Large 的可執行 Task，Scenario 責任覆蓋完整
- [x] 2026-10-04 取得 Phase 0 gate 證據，才推進主要實作
- [x] 2026-10-05 完成後續紅綠／整合／45 輪與資料保留證據
- [x] 2026-10-05 依交付授權提交、建立 PR #11 並保存獨立審查；有效性依對應 HEAD 報告
- [ ] 維護者另行決定發版與正式部署切換

## 本次建檔驗證（2026-10-04）

工作區基準為 main 的 7f698f7；只新增四份 issue 文件與 docs/README.md 索引，無產品行為變更，故本次不適用行為紅燈測試。

- Node 靜態檢查：四份文件存在、9 個本機文件連結有效、Gherkin 的 7 個 Scenario 與待核准表逐項一致、metadata／日期／程式碼區塊完整；exit 0。
- GitHub fetch issue #10：state=open，讀回 body 與送出的規劃內容完全一致。
- npm run build：exit 0。
- npm run test：沙箱內因 tsx IPC socket 的 EPERM 無法啟動；取得權限後重跑 exit 0，333 tests／333 pass／0 fail／0 skipped；tests 下盤點為 49 個測試檔，與完整巢狀 glob 相稱。
- npm run lint：exit 0。
- git diff --check：exit 0；新增未追蹤文件另以 Node 靜態檢查涵蓋，不把 diff 未包含它們誤當已檢查。
- GitNexus analyze --skip-agents-md 已更新索引；沙箱外 status 確認 indexed/current commit 同為 7f698f7。MCP resource 的舊 metadata 有快取，故不以該快取宣稱索引已更新，也沒有修改 AGENTS.md／CLAUDE.md。

以上不代表 SCN-001～007 已實作或驗收通過；MCP／Chrome 契約、45 次循環、正式切換均尚未執行。文件尚未提交／推送。
