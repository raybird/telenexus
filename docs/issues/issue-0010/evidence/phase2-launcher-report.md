# Phase 2 工作專屬 launcher 證據

日期：2026-10-04。Task：T2.2 launcher 子範圍；支援 SCN-003、SCN-005，並提供 SCN-004 隔離的底層證據。這不是 Chrome／OpenCode／local／runner 完整驗收，也不將 T2.2 標為完成。

## 範圍與介面

新增 `scripts/browser-mcp-launcher.mjs`，呼叫方式為 `setsid node <launcher> <executable> <args...>`。launcher 不 exec MCP，保留 supervisor：每工作建立短 `/tmp/tnb-*` root，將 MCP 的 TMPDIR／XDG config／cache 指向自有 root，原樣轉送 stdout／stdin，診斷只寫 stderr。

程序歸屬結合首次捕獲的 child PID＋starttime、親緣、已持有身分及唯一 root；送訊號前重讀 starttime，不重新認領重用 PID。environ 讀取失敗仍保留 stat 身分；已持有 PID 的 stat 非不存在錯誤保守留存，不當成清零。EOF／child exit／SIGTERM／SIGINT 進入一次收尾，先給 EOF 寬限，再僅 SIGKILL 自有程序；以單一 12 秒截止保留 15 秒驗收餘裕。只在 owned 清零後刪除完整自有 root。

取消 exit 143／130、child SIGKILL exit 137、原 child 非零 code 均保留。cleanup failure exit 1，另外只在失敗時追加 `TELENEXUS_BROWSER_AUDIT_FILE`：event、launcherPid、root、errorCode、remaining PID＋starttime＋state；不保存 argv、URL、正文、token。audit 寫入失敗仍 stderr 回報並維持失敗，不改成成功。

## 紅燈、characterization 與綠燈

2026-10-04：Phase 0 已用真 MCP 故障建立 profile 未清理的既有紅燈，見 [phase0-report.md](./phase0-report.md)。新增測試同時建立真子程序、不清理 root 的 unsupervised baseline，以同一檔案斷言確認清理判準抓得到行為缺失；不是 missing launcher／缺依賴的假紅燈。

| 命令 | 實際結果 | 理由／證據 |
| --- | --- | --- |
| `BROWSER_LAUNCHER_BASELINE=1 npx tsx --test --test-name-pattern='EOF 轉送\|非零退出\|executable spawn\|SIGTERM\|MCP 被\|A 收尾' tests/browser-mcp-launcher.test.ts` | exit 1，6 fail | 真實 profile 與完整 root 留存；[原始輸出](./phase2-launcher-baseline-red.log)。 |
| `BROWSER_LAUNCHER_CHARACTERIZATION=1 npx tsx --test --test-name-pattern='EOF 轉送\|非零退出' tests/browser-mcp-launcher.test.ts` | exit 0，2 pass | 既有 Phase 0 probe 的正常 EOF 與非零 child outcome 保持；[原始輸出](./phase2-launcher-characterization.log)。 |
| `npx tsx --test --test-name-pattern='收尾失敗須' tests/browser-mcp-launcher.test.ts`（追加 audit 前） | exit 1，1 fail | chmod 自有 root 為 0500 真正製造 EACCES；root 確實殘留、launcher exit 1，但 audit 不存在，斷言 `false !== true`。不是 mock rm／log。 |
| `npx tsx --test tests/browser-mcp-launcher.test.ts`（新增 SIGSTOP 測試後） | exit 1，7 pass／1 fail | child 已 SIGKILL，但退出事件尚未送達，launcher 錯回 1 而非真 signal code 137；[原始輸出](./phase2-launcher-stopped-red.log)。 |
| `npx tsx --test tests/browser-mcp-launcher.test.ts`（有限等待 child exit 後） | exit 0，8 pass／0 fail | EOF、code 7、spawn ENOENT、SIGTERM、child SIGKILL、SIGSTOP 強制收尾、A／B 隔離、真 EACCES 持久 audit 全綠；[最終輸出](./phase2-launcher-green.log)。 |
| `node --check scripts/browser-mcp-launcher.mjs`、`git diff --check` | exit 0 | 最終語法及工作區差異檢查。 |

2026-10-04：最初並行 baseline 紅燈在 A 斷言失敗後未關閉 B fixture，已核對 exact PID 4077115 與其 `/tmp/tnb-baseline-0GYYBp` 後停止及移除該自有 root，補 finally 再執行保存的 baseline。沒有清理正式程序或其他工作。baseline 的 assert 失敗會先保存判定，再於 finally 清除測試資源，不把測試清理當成產品通過。

單迴圈合併限此 launcher 子範圍：真 Linux 子程序與磁碟 profile 即此層可觀察契約，沒有 mock 核心 cleanup；跨 OpenCode／Chrome 與產品 local／runner 的另一層保障仍由 root 的 T2.2／T2.3 整合測試負責，沒有以本測試取代。characterization 比對於產品化後重新執行，並非聲稱先寫完全部 characterization 才建立 launcher 草稿。

## code-simplify 與限制

2026-10-04：檢查新增 launcher 與 fixture 一次，精煉為 no-op；只保留與所有權、退出、收尾及失敗紀錄直接相關的 helper，未新增 service、共享 pool 或通用 manager。最終同組 8 tests 再跑全綠。

- launcher 本身遭 SIGKILL 無法收尾；宿主／容器遭殺不在本程式保證內。
- stat／kill 仍有極短 TOCTOU，並非 pidfd 原子保證。
- 此測試用主機 Node 22.20.0、非 root 的 Linux 自有 fixture，不驗收 init 回收 detached Chrome 後代；真正 Chrome 與 init 容器盤點、15 秒逐秒觀測及 45 輪回歸仍須後續執行。
- 不可因 stdout 正文／exit 0／Z=0 就推斷 profile 清理成功；測試明列完整 root 不存在，真故障組則要求殘留與持久 failure record。
- audit 僅記失敗，不新增 rotation／無界成功記錄；既有異常檔案的保留政策需常青文件揭露。
