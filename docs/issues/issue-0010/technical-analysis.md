# 技術分析 — Issue 0010

建立日期：2026-10-04。風險與首要驗證引用 [README.md](./README.md#風險與首要驗證)。

## 方案選型與取捨

| 方案 | 優點 | 限制／決策 |
| --- | --- | --- |
| 保留 agent-browser，加 init 與 session 收尾 | 最少相容性改變；init 能改善回收 | daemon／跨回合所有權仍須處理；可作切換失敗時回退，不符合主要替換目標 |
| HTTP 優先＋任務級 Chrome DevTools MCP | 普通閱讀不啟動 Chrome；動態頁按需；沿用 OpenCode MCP | 要驗證真實退出與併發契約；推薦，但不宣稱已測通 |
| 獨立 supervised Chrome sidecar | 可集中管理 browser、context 與 TTL | 新增服務及 CDP／驗證／context 生命周期；擴大 scope，不納入本期 |
| Playwright MCP／外部 Reader 服務 | 同樣能做渲染或抽取 | 前者仍有 Chrome 回收問題；後者多外部資料／費用依賴，不是本案優先方案 |

推薦不是「MCP 絕不產生殭屍」，而是把一般閱讀移出 browser，讓必需的 browser 能有可驗證的任務所有權，並由 init 回收被收養程序。

## 設計差異

```diff
 網頁讀取
- agent-browser CLI → 跨指令 daemon / browser
- 排程結束 → close --all
- 互動聊天 → 保留跨回合 browser
+ HTTP 可取得正文 → OpenCode webfetch，不啟動 Chrome
+ 需要 JS → 本工作 MCP → isolated headless Chrome
+ 任務任何退出 → 本工作資源收尾，不能關掉別人的 browser
+ 容器 init → 回收被收養的已退出程序
```

## 可行性與官方契約邊界

2026-10-04 查核 Chrome DevTools MCP 官方文件：提供 headless、isolated、slim、executable-path 等選項；Chrome 按工具使用按需啟動。isolated 建立臨時 user-data-dir，在 browser 關閉後清理；它不是 TTL。slim 的工具範圍較小，但 evaluate 仍能執行頁面程式，不能聲稱為硬性唯讀沙箱。

上述依據是上游 main 文件，不等同已發布版本。Phase 0 要選定並保存 MCP、Chrome binary、OpenCode、Node 與映像平台組合，查核所用版本的旗標／工具清單，實跑一次完整生命週期再決定整合方式。不使用 @latest 或 runtime 自動下載作可重複建置契約。

既有 runner 的 HTTP 探測能取得 OpenCode／Docker 公開文件，但只證明 HTTP 可達，不證明模型工具路由、抽取品質或 JS fallback 已成立；SCN-001／002 要走真實 OpenCode 路徑。

## 架構影響

- 不改 local／runner 雙服務拓撲、不新開 CDP 對外埠、不掛宿主 Chrome profile。
- local 與 runner 共用持久化設定，不能同時覆寫整份檔案；browser 配置需與 memory MCP／自訂 MCP 合併且可重複執行。
- Chrome profile 所有權必須跟工作走，不跟共用工作目錄或全域設定走。兩個 MCP client 不得使用同一個 profile／cookie。
- 瀏覽器收尾由程式負責，不靠 prompt／模型最後呼叫 close；正常、EOF、取消、逾時與 SIGKILL 的有效邊界要實測。
- init 只回收孤兒；仍有活 Chrome 時須處理退出，不可以 init 作為活程序清理。
- 非 root 不等於一定要 --no-sandbox。保持現有 cap／no-new-privileges；若 sandbox 不可用，記錄原因與隔離取捨，不自行放寬到 privileged。
- 選定版本支援時停用非必要 usage statistics／CrUX，避免新增不必要資料外送。

## 最小實作原則與未決事項

先探測 OpenCode 對 MCP 的所有權、EOF／終止行為與設定載入方式。若客戶端自然符合任務級清理，只做配置與最少收尾改動；若不符合才設計最小的工作專屬 launcher／supervisor。新檔名與函式簽名由探測結果決定，不先建立通用 browser manager、常駐 pool 或大量設定旋鈕。

2026-10-04 已核准 15 秒收尾窗，仍須實測；若不成立，回報實際行為並修訂／重新核准，而非延長等待後宣稱原規格通過。browser 跨回合或登入需求若仍存在，先回報相容性缺口，不以 HTTP／slim 為藉口直接淘汰。

## 參考資料

研究日期：2026-10-04。

- [Docker Compose init](https://docs.docker.com/reference/compose-file/services/#init)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [設定](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)
- [進階隔離／連線](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md)
- [OpenCode 工具](https://opencode.ai/docs/tools/)
- [Playwright Docker：init 建議](https://playwright.dev/docs/docker#recommended-docker-configuration)
