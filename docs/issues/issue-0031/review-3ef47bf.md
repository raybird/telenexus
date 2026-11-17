# 審查報告
- 範圍：issue 0031（GitHub #31），分支 `fix/container-sigterm`，`BASE..HEAD` 共 3 個提交：fec9420（實作）、6770894（保存 review-fec9420.md 與記帳）、3ef47bf（修正 S1、N1 的措辭）。這次是重新審查，重點是 `fec9420..3ef47bf` 的增量；實作部分沿用 review-fec9420 的查核，原因是程式與測試沒有變動，已在下方核對。風險 High，與前次相同。
- Reviewed BASE SHA：fea4b6059e259a4b619e6cbaa0f9bd91ff0adf44
- Reviewed HEAD SHA：3ef47bf9bf09dbb3fb9e93c90eb1ab1c718836bf
- Reviewed patch-id：06c500b9545fd39924acf041f9b68737f0a85928（我重算的結果與協調者提供的一致）
- 獨立 reviewer：Claude subagent（獨立審查 agent，不是實作者；全程只讀，2026-11-17）
- Review artifact：docs/issues/issue-0031/review-3ef47bf.md

## 問題與風險
- MUST FIX：無
- SHOULD FIX：無。前次的 S1 已修正，見下方「驗收與證據」。
- NICE TO HAVE：
  - N2～N5 照使用者 2026-11-17 的決定不處理，README 的 Timeline 有記錄。內容沿用 review-fec9420：重複訊號時 `shutdown` 冪等；3 秒上限沒有自動化回歸測試；runner 被停止時把執行中的工作記成 timeout；不需要 KILL 的替代做法。都不阻擋。
  - 提醒協調者：保存本報告的那個提交，要把 README `## 現況` 的 `**現行 review**` 從 `review-fec9420.md` 改成 `review-3ef47bf.md`（流程契約 2.5）。

## 已查核維度

### 驗收與證據
- **增量範圍**：`git diff --name-status fec9420 3ef47bf` 只有三項：
  - M `docs/issues/issue-0031/README.md`
  - A `docs/issues/issue-0031/review-fec9420.md`
  - M `docs/runtime-boundary-and-security.md`

  `git diff --quiet fec9420 3ef47bf -- src tests package.json docker-compose.yml docker-compose.release.yml Dockerfile scripts` 結束碼為 0，表示程式、compose、Dockerfile、scripts 與測試都沒有改動。所以下列結果仍然有效：
  - 前次 AC-1、AC-2 的實際映像測試，映像建自 fec9420 的 git archive。
  - 變異測試，共 10 項。
  - `npm run build` exit 0、`npm run lint` exit 0。
  - `npm run test`：`# tests 969`、`# fail 0`，105 個測試檔。

  我這次另外重跑了 `container-signals` 與 `compose-parity`：`# tests 9`、`# fail 0`。
- **AC-1～AC-3**：結論與證據同 review-fec9420，都通過，程式沒有變動。
- **AC-4**：通過。
  - `docs/runtime-boundary-and-security.md:173`（S1）：現在列出容器內以 root 執行的程序是 init、entrypoint、compose 的 healthcheck 與 `docker exec` 預設的 session；也寫明降權後的 node 程序（含 opencode 與它的 bash 工具）有效 capability 為空，以及 root 本來就有 `SETUID`，KILL 增加的能力很小。這與前次實測一致：
    - 正式 stage 沒有 `USER`，`docker exec` 的程序是 uid=0、`CapEff=0xeb`。
    - npm 與 node 的 `CapEff=0`，node 對 PID 1 送訊號得到 `EPERM`。
    - opencode 是 node 的子程序，加上 `no-new-privileges`，拿不到 capability。
  - `:179`（N1）：已改成「v2.40.0 及更早的映像」，與對照組結果一致（v2.40.0 是 exit 1，log 有 tini FATAL）。
  - 文件仍寫「已建立的正式容器要重建才會套用」，沒有宣稱正式部署已套用。
- **README**：
  - 「風險與首要驗證」底下同一句已同步更正。
  - 步驟 4 多了一行修正紀錄。
  - Timeline 加了兩列（review-fec9420 PASS、使用者決定修 S1／N1）。
  - `## 現況` 加了 `**現行 review**: review-fec9420.md`，位置在 `## 概述` 之後。

  這次修正動到凍結區段（風險一節、步驟 4），所以需要重新審查，與協調者的判斷相同。
- **review-fec9420.md**：101 行；開頭欄位、S1／N1／N5 的內容與結尾的 PASS 段落，都與我前次交出的報告相符。
- **L-10**：`.env` 的 `ALLOWED_USER_ID`、`TELEGRAM_TOKEN` 實際值，在 `BASE..HEAD` 的完整 diff 中各出現 0 次；值只在命令內比對，沒有印出。diff 中唯一命中 `/home/` 的地方是報告裡的字面說明「diff 裡沒有 `/home/`」，不是實際路徑。報告中的 `ALLOWED_USER_ID=424242` 是合成值。

### 相關失敗面

| 輸入／狀態 | 預期 | 現有覆蓋 | 判定 |
|---|---|---|---|
| 增量是否夾帶程式或設定變更 | 只改文件 | 用 `git diff --quiet` 檢查程式、compose、Dockerfile、scripts、測試 | 通過 |
| 新寫的安全描述是否與實際一致 | 列出的 root 程序與 capability 狀態屬實 | 前次 `/proc` 的 CapEff 實測、`docker exec` 的 uid 實測 | 通過 |
| 受影響版本的描述 | 包含 v2.40.0 | 前次 v2.40.0 對照組 exit 1 | 通過 |
| 記帳與保存的報告 | 報告原文保存、`現行 review` 位置正確 | 閱讀 diff 與報告檔 | 通過；本報告保存時要更新 `現行 review` |
| 其餘失敗面（停止時有卡住的連線、有子程序樹、連續兩次 SIGTERM、process group 收到 SIGINT、compose down／force-recreate、dev overlay、memoria） | 同 review-fec9420 | 程式沒有變動，沿用前次實測 | 通過，與前次相同 |

### 需求、架構、安全、品質
- 需求、架構與品質的結論同 review-fec9420，這段期間沒有程式變更。
- 安全：文件現在準確描述了 KILL 的作用範圍與實際增加的能力，不再有前次 S1 指出的不精確。

### 豁免、待確認與限制
- 不開 PR、改成本機獨立審查（Q3），這點不變。
- TBD-1 不在範圍內，非阻塞。
- N2～N5 由使用者決定不處理。
- 限制同前次：沒有實際跑過 Telegram 聊天或排程進行中時的停止，正式部署沒有碰。
- 這一輪沒有建立任何容器或映像。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
