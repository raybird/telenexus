# SCN-008 runner／container termination 補驗收

驗證日期：2026-10-05。核准規格：`5dfc8f77159387418ab2ab2e1ba89df07822fcc7`；SCN-001～007 未改變。本次只新增驗證 fixture、driver 與證據，未修改產品程式，也未合併、發版或操作正式服務。

## 最終命令與環境

```sh
node docs/issues/issue-0010/evidence/run-runner-termination.mjs v3
node docs/issues/issue-0010/evidence/verify-scn008-observations.mjs
node docs/issues/issue-0010/evidence/run-scn008-gates.mjs
```

三項實跑 exit 0。固定產品映像為 `sha256:445ce68d079d87c65a11bde4d9effcad26b2e1b6a0e2a4723a8557428cdbefb0`；Node v22.23.3、OpenCode 1.18.34、Chrome 154.0.8037.92，MCP 1.10.1 的同映像版本查核沿用 [最終映像證據](phase3-final-image-check.json)。[最終 summary](scn008-v3-summary.json) 保存完整 Docker run/stop 命令、映像 ID、driver／fixture 雜湊、三項被測 runtime 檔案 SHA-256 與版本原文。

每組專用容器均 `--init --network none --user node --cap-drop ALL --security-opt no-new-privileges --pids-limit 1024 --memory 2g`，唯一 bind mount 是 `/probe` 唯讀驗證材料，沒有正式資料、設定、token 或公開 port。兩個最終容器與四個前測容器停止後保留，未刪除。沒有啟動 repo compose／Telegram。

## 觀測判準的正反對照

被測程序是真 runner，且它是 Docker init 的直接子程序；entry shell 已 `exec node /app/dist/runner.js`，不是以替代 runner 模擬停止。fixture provider 只指定 navigate/evaluate 工具，不提供正文答案；必須取得真正 Chrome 執行 JavaScript 產生的 `SCN008_REAL_CHROME` 與實際 URL，才進入終止步驟。

停止前的宿主 `/proc` 正對照確認 runner → OpenCode → task-owned MCP launcher 的父子關係，以及每組 8 個 `exe` 精確為 Chrome 的 descendant；同時 cgroup.procs 包含這些 Chrome。不是靠 argv 中出現 Chrome 路徑就判定 browser 存活。宿主追蹤 PID＋starttime，避免 PID 重用誤判；除了已知身分，停止後也讀整個 cgroup.procs，不因 reparent 忽略程序。

最終 driver 另建立已知 host zombie：stat 有 `state=Z`、starttime，但 exe 不存在，必須仍被計入 Z。`/proc/1/mem` 的 EACCES 對照必須拋錯；cgroup 僅 ENOENT 可以代表已移除，不能把 EACCES／I/O 錯誤吞成空集合。對照 zombie 自身已被回收；[獨立查核](scn008-independent-counts.json) 保存 `controlGone=true`，統籌者也於 2026-10-05 重讀原始樣本、signal events、source hashes 與該 host PID 已 ENOENT。

若發生 leaked live process 或 persistent Z，宿主 stat 身分仍會在；若程序不在已追蹤表但仍屬該容器，cgroup.procs 會非空；任何這些情形都會 assert 失敗。Docker State.Running=false 只是額外條件，不是唯一判零依據。

## 真實 termination 結果

| 路徑 | Docker stop | 真實 signal events | stop 耗時 | exit | 停止後 0～15 秒每秒宿主觀測 | writable layer profile |
|---|---|---|---|---|---|---|
| 正常 SIGTERM | `--time 10` | 15，沒有 9 | 3061 ms | 0 | 16／16 樣本 live=0、Z=0、cgroup PID=0 | 不存在 |
| graceful deadline 後 force | `--time 2` | 15 → 9 | 2093 ms | 137 | 16／16 樣本 live=0、Z=0、cgroup PID=0 | **仍存在** |

正常組 [原始 runner log](scn008-sigterm-v3.jsonl) 有 `shutdown signal=SIGTERM terminatedChildren=1`，證明 signal handler 真的對 active OpenCode 工作執行終止；[events](scn008-sigterm-v3-events.jsonl) 沒有 SIGKILL，並非偷偷依靠 deadline 通過。[docker diff](scn008-sigterm-v3-diff.log) 沒有 `/tmp/tnb-*`。

force 組先以 `docker exec issue10-scn008-deadline-force-v3-20261005 /bin/sh -c 'kill -STOP 7'` 凍結真 runner，host stat 斷言為 T；這是測試故障注入，沒有修改產品 signal handler，也沒有直接 kill Chrome。[events](scn008-deadline-force-v3-events.jsonl) 保存實際 exec 命令、SIGTERM 與約 2 秒後 SIGKILL；[原始 log](scn008-deadline-force-v3.jsonl)、[docker diff](scn008-deadline-force-v3-diff.log) 與 summary 保留真實結果。

## 強制終止的語意與限制

force 組通過的是 **Docker init／container teardown 最終不留下 owned live／orphan／persistent zombie process**，不是「launcher 在 SIGKILL 後還能執行 application cleanup」。容器停止後 PID namespace／cgroup 不再有程序，但 `/tmp/tnb-*` profile 仍留在停止容器的 writable layer；保留容器不等於刪除該層，重新啟動同容器也不能宣稱 profile 已清乾淨。

本次沒有任何持久化 `/tmp`／profile 掛載。若使用者自行把暫存工作 root 放進 bind／volume，Docker teardown 不會 unlink 持久化檔案，需另外管理；此測試不保證那種自訂檔案清理。SIGSTOP 注入只保證 force deadline 路徑被真實走到，不是對所有停滯成因的窮舉。本驗收是固定 Linux／Docker 映像的 integration evidence，不宣稱 kernel teardown 等同應用程式 finally，也不宣稱沒有瞬態 Z；量測保障停止後 0～15 秒沒有持續殘留。

## 前測與 final gates

- `v1` 的兩條 termination 路徑雖有實際數值，但初版 observer 把輔助 exe 缺失一起 catch 成 PID absent，且執行期間曾修改檔案，結尾 hash 不適合作為精確版本綁定；保留前測資料但 **不作 final acceptance**。
- `v2` 已加 stat／exe 分離、fail-closed cgroup、精確 Chrome exe／父子鏈與正常 signal handler assertion；兩組 PASS。最終採 `v3`，補已知 Z／EACCES 對照，且啟動前固定 code hashes；未使用前測結果填補最終缺項。
- 初次 gate 在沙箱內 `npm run build` exit 0，但 `npm run test` 因 tsx IPC socket `listen EPERM` exit 1，沒有實際進入測試；[失敗 log](scn008-test-sandbox-attempt-20261005.log) 與 [失敗摘要](scn008-project-gates-sandbox-attempt.json) 保留。這是環境失敗，不是產品紅燈。
- 取得執行權限後重跑完整 gate；SCN-008 v3 與獨立數值查核完成後，再依使用者指定順序重跑完整 final gate：[結果](scn008-project-gates.json) 為 build、test（370 tests／0 fail）、lint、test:installer 全 exit 0。最終 log 是後一次執行，首次沙箱失敗仍獨立保留。顯示用 log 只正規化 CR／行尾空白，未變更測試結果。
- SCN-008 本次是既有產品行為的補驗收，不新增產品功能，故不製造假的產品紅燈；用真 runner／Docker 整合與已知錯誤對照降低觀測假綠燈。精煉檢查為 no-op：現有 fixture 保留最窄工具持有與兩條終止路徑，沒有額外抽象或產品擴充。
- GitHub Actions 僅 tag-triggered release，未配置 push／PR branch checks；這些是本機實跑證據，**不能稱 GitHub checks 已跑過**。
