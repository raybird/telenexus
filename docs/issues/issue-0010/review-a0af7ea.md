# Issue 0010 獨立審查報告

- 審查日期：2026-10-05。
- 範圍：完整 PR [#11](https://github.com/raybird/telenexus/pull/11)，不是局部 diff 或決策審查。
- TARGET：`main`。
- TARGET SHA：`80dbebace2a4889aa1ca0abfb7e660e094420501`。
- Reviewed BASE SHA：`7f698f7bb32d53196056803a4b2a0a8193bdccef`。
- Reviewed HEAD SHA：`a0af7ea096cf97a07219432077690247be40ec5e`。
- Reviewed patch-id：`8ce4e90af313c977497913e194d39a36102d603a`（`git diff BASE HEAD | git patch-id --stable`）。
- 獨立 reviewer：宿主 subagent `/root/review_issue10_preflight`；未參與產品實作。
- Review artifact：`docs/issues/issue-0010/review-a0af7ea.md`。
- 2026-10-05 以 `gh pr view 11 --json baseRefName,headRefOid,headRefName,url` 確認 PR 目標 `main`、source HEAD 與上述 HEAD 完全相同。fetch 後獨立確認 `origin/main` 為上述 TARGET SHA、`git merge-base origin/main HEAD` 符合上述 BASE。TARGET 相對 BASE 只改 `.github/workflows/release.yml` 的 checkout v6→v7；本 PR 不改該檔案，沒有相同檔案衝突或產品 runtime／測試契約相依，不需 merge／rebase 才能作本次範圍審查。審查前工作區乾淨。

## 問題與風險

- MUST FIX：無。
- SHOULD FIX：`evidence/product-cycle-contract.mjs`／`evidence/run-product-cycles.mjs` 已保存 cgroup 趨勢，但成功 exit 的自動判準不直接檢查趨勢。建議將不累積判準納入自動守門，避免未來只看 `cleanupPassed` 而漏掉 cgroup 驗收。本次已獨立核對全部實際數值，故屬證據持久力改善，不是假綠燈，也不阻塞本次交付。
- NICE TO HAVE：無需為本次加入 browser pool、sidecar、通用 migration manager 或跨程序交易鎖；這些會超出目前已驗證的最小邊界。

## 驗收、核准與證據

2026-10-05 比對核准提交 `d345ba1bc3f391bd2038f8ca0341ccbf742490d0` 與固定 HEAD 的 issue README：SCN-001～007 的 Given／When／Then、Examples 與必要數字未被實質修改，核准集合完全相等。相容性盤點後的公開閱讀取捨與使用者「確認」來源已記入 TBD-2／Timeline，未把未觀察到登入或未知 click 用途當成沒有依賴。TBD-5 正式切換仍待維護者決定；不影響已核准的隔離交付，沒有 gate 豁免。

以下規格均以 `a0af7ea096cf97a07219432077690247be40ec5e:docs/issues/issue-0010/README.md` 對應編號定位。證據連結為該固定 HEAD 的內容；不是只依口頭摘要判定。

| Scenario | 可觀察結果與證據 | 查核結論 |
| --- | --- | --- |
| SCN-001 | [HTTP 報告](evidence/phase2-http-report.md)、[產品矩陣](evidence/product-matrix-v3-summary.json)：真 webfetch 正文／來源與獨立 fixture 相符，static Chrome 啟動 0，dynamic 正對照啟動非零；沿用既有 HTTP characterization，未虛構缺少功能紅燈 | 通過 |
| SCN-002 | [產品整合](evidence/phase2-product-report.md)、[設定證據](evidence/phase2-config-report.md)：真 MCP navigate／evaluate 取得 JS 正文／URL，固定 MCP／Chrome、自有 TMPDIR／XDG／profile，涵蓋串流／非串流與互動／排程 | 通過 |
| SCN-003 | [launcher 紅綠](evidence/phase2-launcher-report.md)、[runner 取消紅綠](evidence/phase2-runner-cancel-report.md)、[產品整合](evidence/phase2-product-report.md)、[最終 45 輪](evidence/phase4-report.md)：正常、缺 binary、真導覽逾時、取消、上游 401、OpenCode PGID SIGKILL 均收尾；EACCES 負對照確實留 root 並寫持久 failure record，不拿回答成功遮蔽清理失敗 | 通過 |
| SCN-004 | [新版四組摘要](evidence/final-concurrency-v1-summary.json) 與各自 raw：兩工作同 origin 不同 cookie／root，取消 local 或 runner 的 A 後，B 再次取得自己的正文／cookie／URL；量測時 runner 原 PID/starttime 仍活著 | 通過 |
| SCN-005 | [HTTP 恢復摘要](evidence/product-http-recovery-v1-summary.json)、[raw](evidence/product-http-recovery-v1.jsonl)：同一容器 Chrome 始終缺少，JS 真工具如實失敗後 HTTP 仍取得獨立正文／URL；部分啟動資源與 launcher root 歸零 | 通過 |
| SCN-006 | [安全遷移紅綠](evidence/phase3-skill-report.md)、[真產品遷移](evidence/phase3-product-report.md)、fresh／legacy v3 raw 與摘要、[映像檢查](evidence/phase3-final-image-check.json)：兩目標重跑冪等，完整舊內建移出探索範圍，自訂／auth／MCP bytes 保留；真原生 skill 讀檔與同 session `-c` 歷史延續；映像舊套件不存在 | 通過 |
| SCN-007 | [45 輪摘要](evidence/product-cycles-v1-summary.json)、[逐秒 raw](evidence/product-cycles-v1.jsonl)、[獨立計數](evidence/phase4-independent-counts.json)：同一存活 init 容器，正常 20＋五種失敗各 5；45 筆 second=15 的 owned／live／Z／profile／root 全零，45 組 cgroup baseline/final 與初始／最後全部為 8 | 通過 |

## 獨立重算與版本有效性

2026-10-05 reviewer 以唯讀 Node 腳本直接解析 `product-cycles-v1.jsonl`，而非複製 `phase4-independent-counts.json` 的結果：篩選 `event=sample && second=15`，斷言筆數與唯一 cycle 數均 45、模式數量為 dynamic=20，其餘五種各 5；逐筆檢查 liveCount、zombieCount、owned.length、profiles.length、launcherRoots.length 皆 0，cgroup.current 皆 8。再核對 raw 最終 measurement 的 45 個 cgroupBaseline／cgroupFinal 全為 8、initial／final 皆 8、observerStillAlive=true。摘要容器 ID `dd552da4a3daab2c85a7c16f05b938c639bb1bf8ee197f4469fd8871af626ce8`、init=true、runningAtMeasurement=true，映像為 `sha256:445ce68d079d87c65a11bde4d9effcad26b2e1b6a0e2a4723a8557428cdbefb0`。指令 exit 0。

2026-10-05 同一唯讀腳本核對新版四組 summary／raw 的 measurement、runnerStillAlive／runningAtCollection 與 passed，4／4 成立；獨立重新計算 [Phase 3 建置紀錄](evidence/phase2-product-build-phase3-v3.json) 的 7 個產品來源 SHA-256 與目前固定 HEAD 內容完全一致，另核對 [映像內同步腳本與 manifest](evidence/phase3-final-image-check.json) 的 2 個 SHA-256 與來源一致。沒有拿舊映像的成功套到新產品來源。

2026-10-05 預審階段 reviewer 實跑並可重用的同版限定測試：

- `./node_modules/.bin/tsx --test tests/skill-browser-migration.test.ts tests/opencode-browser-config.test.ts tests/dynamic-agent-runner-cancel.test.ts tests/runner-disconnect-cancel.test.ts`：exit 0，24 tests／24 pass／0 fail／0 skipped。
- `./node_modules/.bin/tsx --test tests/browser-mcp-launcher.test.ts`：exit 0，8 tests／8 pass／0 fail／0 skipped。
- 唯讀 Git blobs／manifest／legacy fixture 比對：固定 `9d6b8d3` 的全部 10 個歷史檔 SHA-256 與 fixture bytes 一致；exit 0。其後這些產品程式與測試未再改動。

2026-10-05 完整專案 gate 依 [phase3-project-gates.json](evidence/phase3-project-gates.json) 與各原始 build／test／lint／installer log 查核：build → 370 tests／0 fail → lint → installer 均 exit 0，測試 glob 涵蓋巢狀測試。後續內容為證據／文件與新探針，非產品行為修正；已核對來源／映像一致，沒有必要重跑同版完整 gate。新增 log 的行尾正規化已揭露，JSONL、fixture bytes 與產品來源不變；診斷失敗資料保留且未冒稱通過。固定 `BASE..HEAD` 的 `git diff --check` exit 0。

## 相關失敗面與安全邊界

| 輸入／狀態 | 預期與現有覆蓋 | 判定 |
| --- | --- | --- |
| HTTP 可讀／JS 殼層 | 普通正文不啟動 Chrome；JS 真渲染後才回覆正文與來源，static／dynamic 正負對照及真工具紀錄 | 充分；自主模型路由不在此測試證明內 |
| child spawn ENOENT／非零／SIGKILL／SIGSTOP | 已建立 root 亦回收；非零／signal 結果不吞成成功；八項 launcher 真程序測試與產品失敗矩陣 | 充分 |
| cleanup EACCES／audit 寫入失敗 | 清理不成功不能刪除證據或回報成功；真 EACCES 留 root、exit 1 並持久追蹤，audit 失敗保留 stderr／失敗語意 | 已查核；stderr 不等於已保存 audit |
| PID 重用／已 reparent 後代 | 首次 child starttime、親緣／唯一 root、tracked identity，送 signal 前重讀 starttime；只處理自身 owned 程序 | 原始碼與真併發查核成立；不是 pidfd 原子保障 |
| 使用者 pre-abort／執行中 HTTP disconnect | 不送已取消請求、不轉 local、不記 runner success；response close 而非正常 request close 驅動 abort，queued 工作開始前 throwIfAborted | pre-abort、真 HTTP／runner 子程序與產品併發充分；queued 分支另以原始碼核對 |
| malformed JSONC／inline 同名 MCP | 無效 config 不靜默丟棄、不印原文；同名自訂 entry 保留不重複注入；memory／custom 與權限保留 | 六項配置測試與真工具合併充分 |
| 技能 custom bytes／額外檔案／空目錄／`__proto__` | 完整檔名、目錄與 SHA-256 才識別 builtin；null-prototype map 不漏額外檔名；差異保留與警告 | 12 項遷移測試與歷史獨立比對充分 |
| 技能／祖先 symlink、備份碰撞 | 不跟隨既有 symlink 做退役，不覆寫檢查到的既有備份；重跑保留 | symlink／collision／雙 worker 真程序測試充分 |
| 兩 worker 同步與人工並行改寫 | source 已不存在且完整 backup 符合才視為另一 worker 完成；非原子檔案系統交易，人工同時改寫／建空 backup 不在保證內 | 無已確認需阻塞的正常雙 worker 缺陷；一般 race 已準確揭露，部署應先排空與備份，不要求新增鎖 |
| cgroup／觀測假零 | no-init 已知 Z、init PID 消失、profile present→removed 對照驗證同取數管道；45 輪固定 baseline 不重新排除前輪殘留 | 本次數據有效，非單一 cleanup／healthy 假綠燈 |

## 架構、依賴與品質

2026-10-05 完整產品 diff 查核：變更限 Docker 共用 base、兩份 Compose、OpenCode 工作 env、runner/client 取消傳遞、task-owned launcher、安全技能退役及必要文件／測試。沒有碰 Memoria、排程規則、Telegram 渲染或正式資料；原始程序層未做無關重構。兩份 Compose parity、dev 繼承 init、既有 runner PID 限制與非 root／cap-drop／no-new-privileges 保留。MCP 固定發布版本，Chrome 固定官方 linux64 URL 並驗 SHA-256；新增 jsonc-parser 固定 3.3.1，lockfile resolved／integrity 與用途一致，未引入額外瀏覽器服務。

2026-10-05 以 code-simplify 標準跨 Task 檢查：local／stream 共用 getEnv，兩個 HTTP handler 的小型取消 listener 對應不同 handler，沒有已分歧的重複收尾邏輯；launcher helper 與完整 fingerprint／symlink helper 均直接服務已知失敗面，沒有推測性通用框架。技能 source 的舊目錄等位元搬至測試 fixture、不進入 runtime skills；runtime 同步永遠略過退役名稱，沒有因 upgrade tar 殘留重新註冊。指引分支與容器程式責任清楚：模型不負責全域收尾，認證錯誤／驗證碼不授權繞過。

## 限制、待確認與流程判定

2026-10-05 限制維持原範圍：固定 linux/amd64／工具版本與合成認證 provider；fake provider 驅動真工具、未 mock 核心 browser／HTTP，不證明真模型自主選工具品質。Chrome no-sandbox 不等於安全執行任意網站；launcher 自身 SIGKILL／容器或宿主被殺、stat／kill TOCTOU、同名自訂 backend、外部 skills.paths、並行人工修改遷移資料均不被擴張為保障。audit 沒有 rotation。兩次未知用途 click 不假稱已識別；登入／表單／跨回合 browser state 不在本期承諾。正式部署與發版仍待維護者授權，本 reviewer 沒有操作 Docker 或正式服務。

2026-10-05 判定：**PASS**。完整固定 PR 範圍無 MUST FIX，SCN-001～007 與重要失敗面具有效證據，獨立報告已持久化。這是固定 HEAD 的審查通過，不是 merge／發版／正式切換完成；T4.2 等待 PR／review 狀態回填為合法交付中間狀態。

本報告只綁定上述被審查 HEAD；後續若修改 issue 進度或其他檔案，不符合「只新增本份報告」的 artifact 提交例外，須按新固定 HEAD 重新核對範圍與證據。只新增一份新 HEAD 報告的唯一後繼 commit，仍需依 review-evidence 的三項條件及 verify-artifact.py 實際驗證，不能憑 patch-id 相同自動沿用。
