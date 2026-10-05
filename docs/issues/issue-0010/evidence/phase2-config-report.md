# T2.2：產品設定與固定安裝

日期：2026-10-04。SCN-002／005／006 的底層設定證據；不是 T2.2 完成報告。

## 範圍與影響

GitNexus `impact(OpencodeAgent, upstream)` 為 LOW、兩個產品建立點；`impact(executeChatProcess, upstream)` 為 HIGH、一個直接呼叫與四組受影響流程，包含 local、runner、一般／串流。`rg` 確認 executeChatProcess 只有 runChatStructured 呼叫、產品建立點為 core/agent 與 runner；已在修改前告知風險。

只新增 getEnv 覆寫，非串流改用同一入口；串流沿用原入口。未修改 CliAgentBase／process-runner／摘要；摘要維持既有文字用途，不宣稱每個 OpenCode invocation 都註冊瀏覽器。舊排程 global close 留至 T3.1 盤點與退役。

設定在子程序 `OPENCODE_CONFIG_CONTENT` 合併 `mcp.telenexus_browser`，不寫共享持久化檔案。固定 jsonc-parser 3.3.1 支援註解與 trailing comma，保留 model／provider／memory／自訂 MCP／權限；無效設定如實失敗且錯誤不印原文。inline 已有同名自訂 entry 時整段保持原樣，記錄 `browser.custom-config-preserved`；使用者自訂 backend 不屬於內建 launcher 收尾保障。其他持久化設定的實際合併仍需產品整合 fixture 驗證。

內部子程序環境 `TELENEXUS_BROWSER_AUDIT_FILE` 指向 project/data/browser-lifecycle.jsonl，供收尾失敗的最小持久化追蹤；不是新增對外設定介面。紀錄不能包含命令參數、網址或憑證。

## 紅綠證據

2026-10-04 `npx tsx --test tests/opencode-browser-config.test.ts`：實作前 exit 1、4 tests／0 pass／4 fail。父環境和一般／串流真子程序皆未註冊 browser；JSONC 尚未被合併為新子程序配置。fake opencode 只擷取傳入環境，不代替 MCP／Chrome 驗收。

實作後同命令 exit 0、6 tests／6 pass／0 fail（另補同名自訂設定與無效設定分支）。加入 launcher executable 介面後，與 `tests/docker/browser-install.test.ts` 合跑 exit 0、7 tests／7 pass／0 fail。

2026-10-04 `npx tsx --test tests/docker/browser-install.test.ts`：Dockerfile 改動前 exit 1、1 fail，失敗原因是共用 base 缺少固定 MCP 安裝；改後 exit 0。靜態配置測試不等於套件／Chrome 真正運作，需保留外層產品整合。

2026-10-04 `npm run build`、`npm run lint` 均 exit 0；最終產品版本還要重跑完整 gate。內層驗證配置輸出，外層驗證真正文與 PID/profile，兩層未合併。

## 固定映像依賴

獨立 Chrome for Testing 154.0.8037.92 linux64 官方 URL 已回 HTTP 200；實際下載 196202491 bytes，SHA-256 `ff43322f335e436b2f4dcdfeeec5db032299e335a7e8c1c618b326e100ce8732`。Dockerfile 建置時下載並核對，不使用舊 agent-browser 路徑或 runtime @latest。MCP 固定 1.10.1；平台沿用現有 release workflow 的 linux/amd64，不聲稱新增 ARM 支援。

2026-10-04 `docker build --target base -t issue10-product-base:20261004 .` exit 0，image ID `sha256:618a962aa86e3af4fc8f58c85576768cf7f2fe7b6089f66267513c46798c7c60`，實際 Chrome 校驗輸出 OK。此為 launcher 首版建置，後續 launcher 修訂須重建產品映像，不能重用此 image ID 驗收最終版本。

沿用 Phase0 證實的 sandbox 限制與既有 no-sandbox 邊界，保持非 root、cap-drop／no-new-privileges；沒有新增 privileged、CDP 埠或宿主 profile。此並非聲稱 Chrome 具 sandbox 保護。

## 尚待完成

真產品 OpenCode／MCP／Chrome 六種退出、兩入口、local／runner／排程與 HTTP 失敗後恢復；同時需核對 audit 在真環境可追蹤。尚未完整驗收 SCN-002／003／005，不標 T2.2 完成，不發版或操作正式服務。

依據：[OpenCode config 合併與 JSONC](https://opencode.ai/docs/config/)、[JSONC parser 官方契約](https://github.com/microsoft/node-jsonc-parser)、[Chrome for Testing 官方下載機制](https://github.com/GoogleChromeLabs/chrome-for-testing)。官方文件僅供設計依據，非測試通過證據。
