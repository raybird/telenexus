# Phase 3 相容性盤點（準備）

日期：2026-10-04。Task：T3.1 唯讀盤點；支援 SCN-006。**不是 T3.1 完成，也不是相容性全通過。** 未啟停正式服務、未修改正式 DB／設定／skills、未讀取 auth.json／credential table／登入 profile，未輸出 command、URL、聊天正文、session ID 或認證。

## 方法與範圍

2026-10-04 先以 `docker exec --user node <container> node -e <metadata script>` 只讀列出 `/home/node/.local/share/opencode/` 檔名，兩容器均有 opencode.db（亦有 auth.json，未開啟）；再用 `/app/node_modules/better-sqlite3` 的 `readonly: true, fileMustExist: true`、`PRAGMA query_only=ON` 讀 sqlite_master table 名及 part／message／session 的 `PRAGMA table_info`。

正式容器：`runtelenexus-telenexus-1`、`runtelenexus-agent-runner-1`。兩邊 DB device 66306／inode 20510987 相同，schema 與聚合一致：**共享 DB，不是兩份獨立樣本，不能加總倍增。**

可重複命令（只讀）：

```bash
docker exec -i --user node runtelenexus-telenexus-1 node --input-type=module < docs/issues/issue-0010/evidence/audit-browser-compatibility.mjs
docker exec -i --user node runtelenexus-agent-runner-1 node --input-type=module < docs/issues/issue-0010/evidence/audit-browser-compatibility.mjs
```

兩命令 exit 0。查詢原文與聚合邏輯見 [audit-browser-compatibility.mjs](./audit-browser-compatibility.mjs)，實際數值見 [phase3-compatibility-aggregates.json](./phase3-compatibility-aggregates.json)。腳本僅對 `part.data.type = tool` 讀取 `state.input.command` 作內部分類；不讀 message.data 正文，僅查 role 與 preceding user message ID 並聚合，所有 ID 留在程序記憶體、不輸出。依 root 追加的唯讀授權，同使用者回合相鄰 snapshot 的 tool output 僅在記憶體解析 click ref 對應 role，不輸出 label／URL／正文。

窗口：2026-09-04 00:00:00（UTC+08）含起始，至 2026-10-05 00:00:00（UTC+08）不含結束；epoch ms 1788451200000～1791129600000。SQL 以 `time_created >= ? AND time_created < ? AND json_valid(data) AND json_extract(data, '$.type') = 'tool'`，降序 LIMIT 20000。窗口工具 parts 共 2175，實際檢查 2175，**未截斷**。最終全 DB part 58687／message 16702（正式服務仍運行，早一輪 metadata 為 58683／16700）；窗口工具 parts 與分類在重查時一致，沒有因停止服務凍結資料。窗口以外不納入，不據此否定較早歷史依賴。

## 實際聚合

2026-10-04：2175 個工具 parts 中 bash 1507、webfetch 308、websearch 279，其餘為固定工具名；669 個 parts 沒有 string command（多為非 bash 工具），不當作 command 掃描。含 agent-browser 字樣的候選 parts 75，分布於 14 個 OpenCode sessions；單 part 可含多個 CLI 呼叫，固定操作詞 tokenizer 識別出 112 個 invocation。

| 操作 | 固定詞 invocation 數 |
| --- | ---: |
| open | 33 |
| wait | 19 |
| get | 39 |
| close | 6 |
| eval | 2 |
| snapshot | 7 |
| scroll | 1 |
| screenshot | 1 |
| click | 2 |
| --version | 2 |

候選正規表示式另查：state save 0／state load 0／login-related 0／fill-or-type 0／explicit session 5。這些是限定窗口和解析路徑的「未觀察到」，**不是從未使用／不存在依賴**；command 可透過 wrapper、shell 變數、其他工具或窗口外呼叫，靜態 tokenizer 不保證完整 shell AST。categories 可重疊，不可加總作 invocation 數。

14 個候選 sessions 全部有多個 browser calls 與多個 assistant messages，但各自僅對應 1 個最近 preceding user turn；多 preceding user turns=0、missing preceding user=0、browser 使用跨度超過一小時=0。這支持「所觀察多步發生於同一使用者回合」，**不能把多 assistant messages 當成跨使用者回合 profile 依賴**；也不證明網站 cookie／登入 state 在窗口前從未沿用。

## 待釐清的互動相容性

2026-10-04：存在 **2 個可識別且 tool status completed 的 click 操作**，以及 scroll 1。click targets 均為 @ref；同一 preceding user turn 內查最近 snapshot（每 click LIMIT 50），總共取得 4 個 snapshot rows、4 個 string outputs，沒有查詢截斷，但 ref 對應行匹配 0。因此 target role 聚合 link 0／button 0／input 0／unknown 2，**不是確認了登入或提交依賴**，也不能把 role 未知解讀成沒有 click。

本期「不承諾完整互動能力」已有核准，不能僅因 click 次數非零就判定需重新核准；若只是公開閱讀導覽，可仍在既有核准範圍內。盤點結果尚不能識別兩次 click 的用途；root 應核對既有核准，必要時向維護者澄清是否有要求保留的提交／登入／跨回合操作，再決定是否真正需要規格修訂。**本盤點不擅自選擇、不宣稱規格缺口已確認、不修改 Scenario、不標未知已解決。** 目前未觀察到登入／state save-load／跨 user-turn 使用，但缺窗口外與其他記錄來源證據，仍需揭露。

## Repo 既有指引與遷移準備

2026-10-04：`skills/agent-browser/SKILL.md` 明列 fill／click／表單、自登入 state save-load、named session；`references/authentication.md`、`references/session-management.md` 與 `templates/authenticated-session.sh`／`templates/form-automation.sh` 亦承載舊互動能力。repo 指引提供功能，不等於正式使用量，因此不以文字存在推斷維護者正在登入。

`scripts/sync-skills.mjs` 僅 copy 不存在目錄；既有 workspace／user-level 目錄會 skipped，索引仍掃描既有 SKILL.md。只移除 image source 不會自動停止載入舊技能，T3.1 必須實作辨識舊內建、備份／保留自訂、兩次遷移冪等的 fixture；本次未讀取／改寫正式技能內容或 runtime config。認證、文字 session、memory MCP／custom MCP 的保留仍由遷移測試負責。

2026-10-04：`node --check docs/issues/issue-0010/evidence/audit-browser-compatibility.mjs` exit 0；新腳本沒有產品行為修改，無需宣稱紅綠測試。正式 DB 查詢取數成功只證明此窗口的盤點，不取代工具退役的回歸、設定遷移與完整 SCN-006 驗收。
