# Phase 3 內建技能安全退役證據

日期：2026-10-04。Task：T3.1 技能遷移子範圍；支援 SCN-006。使用者已確認公開閱讀相容性取捨，核准與完整 Task 狀態由 README／implementation-plan 維護；本報告不宣稱整個 T3.1 或 SCN-006 已完成。

## 最小變更與可復原性

2026-10-04：修改 `scripts/sync-skills.mjs`，新增 `scripts/retired-agent-browser.json` 與 `tests/skill-browser-migration.test.ts`。GitNexus `impact(syncBuiltinSkills, upstream)` 回報 LOW、1 個直接 caller（同檔腳本）；`rg '\bsyncBuiltinSkills\(' scripts tests` 確認只有定義與腳本底部一個呼叫，沒有修改索引產生函式。

固定 manifest 來源為 `9d6b8d32833828d8fea261f29f0ee0f59131f750:skills/agent-browser` 的 git blobs，共 10 個 regular files SHA-256 與 `references`／`templates` 兩個目錄名；manifest ID `04f5f2d`。`git diff --exit-code 04f5f2d 9d6b8d3 -- skills/agent-browser` exit 0，歷史內建版本相同。manifest 不在啟動時重新生成、不以新 source 內容決定誰是舊內建。

每個既有同步目標的 `agent-browser` 只有在完整檔案集合、完整目錄集合與全部 SHA-256 相符，且 candidate／target／backup 祖先沒有 symlink 時，才 `renameSync` 至同步目標父層的 `retired-skills/agent-browser-04f5f2d`。此處在 skills 掃描範圍外，內容可復原，沒有刪除技能／認證／聊天／設定資料。

- 自訂內容、extra file、extra 空目錄、任意非 regular-file／dir、symlink：原地保留，明列「無法自動遷移」及「舊瀏覽器後端不可用」警告。
- 既有備份碰撞：不覆寫備份、不刪重複 source，兩者保留並警告。不能宣稱被保留的自訂舊指引已停止載入；一般自訂目錄仍由既有索引載入，維護者需人工調整。
- 並行 local／runner 同步：只有 source 經 lstat 確認不存在、且固定備份完整符合 manifest，才把 rename／掃描 ENOENT 當作另一 worker 已完成；不把 dangling symlink 當成消失。
- 即使 upgrade tar 留下舊 source `skills/agent-browser`，同步迴圈永遠略過該名稱，不把已退役 builtin 重新 copy 回來。其他技能同步與原本 primary 索引行為保留。
- 自訂外部 `skills.paths` 不在此遷移範圍；沒有清空 workspace、OpenCode config 或 volume。

## 紅綠與 fixture

2026-10-04：先新增測試，尚未修改 sync-skills 行為時執行 `npx tsx --test tests/skill-browser-migration.test.ts`：exit 1、8 fail。fresh fixture 抓到舊 source 被 copy 回兩目標，upgrade fixture 抓到 builtin 未退役，自訂差異／extra／symlink／collision fixture 抓到缺少可行動警告；見 [原始紅燈](./phase3-skill-red.log)。不是 missing script／套件／環境故障的假紅燈。

固定 manifest 與最小實作後，原 8 cases 全綠；再補 target／backup 祖先 symlink 及兩個真 Node 同步程序的並行 fixture，11 cases 全綠。交付前再驗證任意額外檔名：`npx tsx --test --test-name-pattern=prototype-file tests/skill-browser-migration.test.ts` exit 1，額外檔案 `__proto__` 被普通物件的 setter 忽略，錯判完整內建而未警告，見 [原始紅燈](./phase3-skill-prototype-red.log)。最小修正檔名 map 為 `Object.create(null)`；最終完整命令 exit 0、12 pass／0 fail，見 [最終綠燈](./phase3-skill-green.log)。

12 個 cases 都以兩個目標（workspace `.opencode/skills`／global skills）驗證。fresh／upgrade／各保留情境均重跑同步，備份內容用獨立原樹逐檔 byte snapshot 比對；custom 技能、auth fixture、含 memory／custom MCP 的 config fixture、文字 session fixture 在每次同步後都與原始 bytes 相同。退役 builtin 不出現在 primary AGENTS／skills-summary；新的 web-reading 及既有 custom 索引保留。**文字 session fixture 保持不變不是實際 OpenCode `-c` 延續驗收**，真正整合仍由 root 的產品證據核對。

Root 於 2026-10-04 將 10 檔舊樹等位元搬至 `tests/fixtures/legacy-agent-browser`，測試改用此路徑，避免最終刪除 runtime skill 後依賴已刪 source 或 shallow clone 的 git 歷史。搬移切換期間有一次舊 source 已空、測試路徑尚未更新，得到 9 pass／2 fail，保留 [fixture 切換紀錄](./phase3-skill-fixture-transition.log)；**不列為產品行為紅燈**。新 fixture 路徑的最終同組 12 cases 已重新全綠。

初次固定 manifest 的 git 子程序受沙箱 EPERM，診斷輸出曾誤放入未提交草稿；未執行遷移、未改正式資料。以必要 escalation 重讀固定 git blobs，確認 exit 0 及 JSON.parse 成功後已完全替換為真正 JSON，才開始產品腳本測試；診斷 stack 不是 manifest 或有效證據。

## 精煉與驗證限制

2026-10-04：code-simplify 檢查一次，僅使用 manifest 比對、symlink／祖先檢查及可復原 rename 所需的局部 helper，沒有引入通用遷移管理器。`anotherWorkerFinished` 合併三個相同的併行完成判準；避免 existsSync 忽略 dangling symlink。最終原 12 tests 重跑 exit 0；其餘精煉 no-op。null-prototype 檔名 map 是安全 bug 修正，另有真紅綠燈，不冒充純精煉。

2026-10-04：`node --check scripts/sync-skills.mjs`、`git diff --check` exit 0。外／內迴圈在本子範圍合併：真實同步腳本直接作用自有檔案樹，遷移行為與底層檔案保障在同一可觀察層；沒有 mock 核心 compare／rename。Chrome／OpenCode config 合併、真正文字 session 延續、正式映像 agent-browser 缺席與完整 build／test／lint 屬 root 的其他 T3.1／T4 工作，不能用本 12 tests 替代。

此變更只保存／移動已確認的歷史內建目錄；同時存在人工修改與同步仍有一般檔案系統 race，不宣稱提供跨程序交易鎖。2026-10-05 預審補充：檢查到既有備份時保留並警告，但 `renameSync` 不是原子 no-replace，不宣稱能抵擋檢查後人工同時建立空目錄或修改檔案的競態。差異原地保留，維護者可從固定 retired-skills 路徑復原；未在正式容器執行本遷移。
