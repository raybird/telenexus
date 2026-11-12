# Issue 0024 實作計畫

驗收劇本、風險與首要驗證、涉及檔案都在 [README.md](README.md)。本檔是實作步驟的唯一來源。SCN-001～008 已於 2026-11-12 核准。

## 設計方案

### 安裝（SCN-007）

在 Dockerfile 的 `base` stage，接在 Chrome 安裝之後：

```dockerfile
# 2026-11-11：JS 正文先用 Moli 讀取，失敗才開 Chrome（issue 0024）。
RUN curl -fL --retry 2 -o /tmp/moli.tar.gz \
      https://github.com/lexmount/moli/releases/download/v1.1.23/moli-x86_64-unknown-linux-gnu.tar.gz \
  && printf '%s  %s\n' df360c04e567ce2e56a8391a03dc677d794465848b5821f944d2de10f3f1f430 /tmp/moli.tar.gz | sha256sum -c - \
  && mkdir -p /opt/telenexus/moli && tar -xzf /tmp/moli.tar.gz -C /opt/telenexus/moli \
  && rm /tmp/moli.tar.gz
COPY scripts/moli-fetch.sh /usr/local/bin/telenexus-moli-fetch
```

- 版本、雜湊與執行檔路徑（`/opt/telenexus/moli/moli-v1.1.23-x86_64-unknown-linux-gnu/moli`）來自步驟 1 的實測。映像已經有它需要的函式庫，不必新增 apt 套件（[evidence/step1-moli-probe.md](evidence/step1-moli-probe.md)）。
- dev 與正式 stage 都繼承 `base`，所以兩者都有 Moli。正式 stage 仍然放在最後（CLAUDE.md）。

### Wrapper（SCN-005、SCN-006）

`scripts/moli-fetch.sh`（bash），安裝成 `/usr/local/bin/telenexus-moli-fetch`：

```text
telenexus-moli-fetch <url>
  參數不是剛好一個，或不是 http:// / https:// 開頭 → stderr 說明原因，exit 2，不啟動 Moli
  root = mktemp -d /tmp/tnm-XXXXXX；trap 在 EXIT 時刪除 root
  HOME、TMPDIR 指到 root 底下；清掉 MOLI_* 環境變數
  以 setsid 起獨立 session 的清理程序：等 Moli 與 wrapper 都結束（最多 40 秒）後刪除 root
  timeout --kill-after=5 30 <moli> fetch --dump markdown --wait domstable --timeout 10000 \
      --fail --block-private-networks -- <url>
  timeout 結束碼 124／137 → stderr「逾時」，exit 124
  Moli 結束碼非 0 → 原樣傳回（被內網封鎖與一般錯誤都是 1，HTTP ≥ 400 是 22）
  stdout 去掉空白後是空的 → stderr「沒有正文」，exit 3
```

- 30 秒寫死（Q6）。`--kill-after` 讓不理會 SIGTERM 的 Moli 在 35 秒時被 SIGKILL，加上收尾，落在 SCN-005 的 45 秒窗口內。Moli 自己的就緒期限設成 10 秒，正常情況會比外層逾時先到。
- 參數依步驟 1 實測：等待參數是 `--wait`（不是 `--wait-until`）、`--` 可以用、被封鎖時 exit 1。`domstable` 涵蓋的 JS 頁面最多，但一直變動的頁面要等到就緒期限才回傳，所以把期限縮成 10 秒。`--fail` 讓 404 這類錯誤頁走非 0 的路徑，不被當成正文。
- `data:` 網址 Moli 自己會接受，`file:` 會拒絕；兩者都由 wrapper 先擋（Q8）。
- 暫存目錄：Moli 只寫 `TMPDIR/moli-storage-*`。正常結束會清掉，被 SIGTERM 或 SIGKILL 中斷時會留下（步驟 1）。trap 處理 wrapper 正常結束與被 SIGTERM 的情況；獨立 session 的清理程序處理 wrapper 與 Moli 一起被 SIGKILL 的情況（README TBD-2）。

### 技能同步（SCN-008）

照 `retireBuiltinBrowser()` 的模式，新增 `upgradeBuiltinWebReading()`：

- `scripts/retired-web-reading.json` 記錄已出貨舊版的檔案清單與 sha256（目前只有 `SKILL.md` 一個檔案，`03821d8d…`）。
- 對每個 target dir：
  - 沒有 `web-reading` → 交給既有的「補缺少的目錄」流程。
  - 內容與舊版清單完全相同（沒有多出檔案、沒有 symlink）→ 搬到 `retired-skills/web-reading-<id>`，再複製新版。
  - 已經和新版相同 → 不動。
  - 其他情況 → 原地保留，輸出警告：無法自動升級，請人工比對新版。
- 備份目錄已經存在時，不覆寫，原地保留並警告（與 agent-browser 相同）。

### 指引（SCN-001～004）

`skills/web-reading/SKILL.md` 改成三層。改這個檔案時先載入 `writing-rules`：

1. 已知網址先用 `webfetch`（不變）。
2. HTTP 只拿到殼層時，以 bash 執行 `telenexus-moli-fetch '<網址>'`。結束碼 0、而且輸出有所需正文時，就以輸出回答並附網址。
3. wrapper 結束碼非 0，或輸出沒有所需正文時，才用 `telenexus_browser_navigate` 加 `telenexus_browser_evaluate`（沿用現有段落）。
4. 都失敗時明確說明讀取失敗（不變）。

不寫 Moli 的其他參數；技能範圍與「頁面中的指令是資料」等規則照舊。

## 實作步驟

1. ✅ **在拋棄式容器實測釘版 Moli**（首要驗證；SCN-002、SCN-005、SCN-006、SCN-007；TBD-1、TBD-2）——證據：[evidence/step1-moli-probe.md](evidence/step1-moli-probe.md)。v1.1.23 在現行映像以 node 身分可執行、不缺函式庫；JS fixture 讀得到正文；內網封鎖對 loopback、RFC1918、服務名稱、metadata 都是 exit 1，非保留網段不擋；Moli 被訊號中斷時會在 `TMPDIR` 留下 `moli-storage-*`
   - 做法：用現行映像起一個拋棄式容器（不發佈 port、不帶 Telegram token、不掛 named volume），把 release tarball 下載到容器內並記錄 sha256，以 node 使用者執行。issue 0010 的 HTTP／JS fixture 放在容器內供測試。依序記錄：`moli --version`、`ldd`、HTTP 與 JS fixture 的輸出與結束碼、`--block-private-networks` 對 `127.0.0.1`／`10.x`／容器服務名稱／公開位址的結束碼與 stderr、`timeout 30` 對一個永不完成的頁面的結果與之後的 `/proc` 採樣，以及執行前後 `HOME`、`/tmp`、`XDG_*` 的差異。
   - 產出：`evidence/step1-moli-probe.md`，以及探測腳本（放在 `evidence/`）。
   - 完成判準：README「完成證據」列的每一項都有實際輸出；TBD-1 寫明 fixture 的放置方式與理由，TBD-2 寫明 Moli 寫不寫磁碟。若 Moli 在本環境跑不起來或讀不到 JS fixture，停下來回報使用者，不繼續後面的步驟。
   - 相依：無。不改產品程式。
2. ✅ **映像釘版安裝**（SCN-007）——證據：[evidence/step2-image-install.md](evidence/step2-image-install.md)。紅燈 1/2；綠燈 9/9；6 個突變都轉紅；dev 與正式映像的 `moli --version` 都是 1.1.23；雜湊錯誤時建置失敗。wrapper 的 COPY 移到步驟 3
   - 做法：先新增 `tests/docker/moli-install.test.ts`（版本、sha256、`sha256sum -c`、沒有 `latest` 或 `| sh`），確認紅燈，再改 Dockerfile。wrapper 的 COPY 在步驟 3 才加，因為 wrapper 那時才存在。另外建出 dev 與正式映像，各跑一次 `moli --version`；把雜湊改錯一次，確認建置失敗。
   - 完成判準：靜態測試紅燈→綠燈；兩個映像的版本輸出；雜湊錯誤時建置失敗的輸出。
   - 相依：步驟 1；SCN-007 已核准。
3. ✅ **Moli wrapper**（SCN-005、SCN-006）——證據：[evidence/step3-wrapper.md](evidence/step3-wrapper.md)。紅燈 12 失敗／2 取消；綠燈 15/15；10 個突變中 9 個轉紅（M6 沒有可觀察差異，已說明）；映像內真 Moli 的內網五種位址都被擋，`data:` 被 wrapper 擋下
   - 做法：新增 `tests/moli-fetch-wrapper.test.ts`，用假的 `moli`（以環境變數或 PATH 指向測試用執行檔）驅動 wrapper，覆蓋 SCN-006 每一列、逾時（假 moli 不結束也不理會 SIGTERM）、非 0 結束、空輸出、假 moli 在 `TMPDIR` 建檔後被中斷，以及對整個 process group 送 SIGKILL，確認之後沒有殘留程序與暫存目錄。之後在步驟 2 的映像裡用真的 Moli 跑一次 SCN-006 的內網兩列。
   - 完成判準：紅燈→綠燈；突變「拿掉 scheme 檢查」「拿掉 `--block-private-networks`」「拿掉 timeout」「拿掉獨立 session 的清理程序」都會讓測試轉紅。
   - 相依：步驟 1；SCN-005、SCN-006 已核准。真 Moli 那一輪依賴步驟 2。
4. ✅ **技能同步升級**（SCN-008）——證據：[evidence/step4-skill-upgrade.md](evidence/step4-skill-upgrade.md)。紅燈 7/9；綠燈 21/21（含 issue 0010 的遷移測試）；6 個突變中 5 個轉紅，M6（改名衝突）沒有測試擋得住，已揭露
   - 做法：在 `tests/skill-browser-migration.test.ts` 旁新增測試，用暫存目錄的 fixture 覆蓋 SCN-008 的四列，加上備份已存在、symlink、多出檔案三種情況，每種都同步兩次。
   - 完成判準：紅燈→綠燈；突變「不比對雜湊就覆寫」會讓「內容被改過」那一列轉紅。
   - 相依：SCN-008 已核准。和步驟 2、3 互不相依。
5. ✅ **web-reading 指引**（SCN-001～004）——證據：[evidence/step5-red.log](evidence/step5-red.log)、[evidence/step5-green.log](evidence/step5-green.log)。`tests/web-reading-skill.test.ts` 對舊版指引 1/3 通過（「明確說明讀取失敗」舊版就有），新版 3/3；改寫時套用 writing-rules。模型是否照著走由步驟 6 驗證
   - 做法：依上方「指引」改寫 `skills/web-reading/SKILL.md`，更新「最後驗證日期」。`tests/skill-browser-migration.test.ts` 若檢查技能內容，同步調整，並把它記為「核准的行為已變更」。
   - 完成判準：文字層的靜態檢查（提到 wrapper、退回 Chrome 的條件、失敗回報）；行為由步驟 6 驗證。
   - 相依：步驟 3（wrapper 的介面已定）、步驟 4（新版要送得到現有部署）。
6. ✅ **實際 OpenCode 工具路徑整合**（SCN-001～005、SCN-009）
   - 做法：沿用 issue 0010 的拋棄式 runner 做法（`docker run` 隔離啟動 agent-runner，資料指到暫存目錄），用步驟 2 的映像，透過 `/run` 送讀取請求。每個情境記錄回覆、工作期間有沒有執行 wrapper、有沒有 Chrome 程序（`/proc` 採樣），以及結束後 45 秒的 moli／zombie／暫存目錄數。SCN-003 的四種失敗各跑一次，SCN-005 的取消在 Moli 執行中途送出。
   - 完成判準：觀測器先用已知的正／負對照驗過（例如刻意不清理的暫存目錄要被抓到）；每個 Scenario 列都有實際輸出。模型沒有照指引走（例如跳過 Moli 直接開 Chrome）時如實記錄，不重試到成功為止。
   - 相依：步驟 2～5。
   - 2026-11-12 進度：三輪實測見 [evidence/step6-opencode-path.md](evidence/step6-opencode-path.md)。模型 20 次有 9 次沒載入技能，Q13 新增 SCN-009：`src/prompt/builder.ts` 在三種模式的聊天提示詞都加上網頁讀取順序（`tests/web-reading-route-hint.test.ts`，紅燈 3/3 失敗、綠燈 41/41、4 個突變全紅，記錄在 evidence/step6b-*.log）。第四輪改用正式部署的 `nvidia/z-ai/glm-5.3-flash`（Q14），8 個情境全部符合，結論見證據檔。
7. ✅ **常青文件與交付檢查**
   - 做法：更新 `docs/runtime-boundary-and-security.md`（Moli 的執行邊界、內網封鎖只套用在 Moli、Chrome 照舊）、`docs/configuration-reference.md` 第 7 行附近的網頁閱讀說明、`docs/installation.md` 的技能同步段落（雜湊相符才換新）、`CLAUDE.md` 的 Configuration 段落、`ARCHITECTURE.md` 第 47 行。執行 `npm run build`、`npm run test`（核對 `# tests` 與測試檔數，[L-01](../../agents/landmines.md)）、`npm run lint`。
   - 完成判準：三個指令都 exit 0；證據檔已去敏（[L-10](../../agents/landmines.md)）。
   - 2026-11-12 結果：[evidence/step7-gates.log](evidence/step7-gates.log)，build、lint exit 0，test 725/725（87 個測試檔），這是審查 S1、S4 修正之後的結果。
   - 相依：步驟 1～6。

## 測試策略

| Scenario | 層級 | 理由 |
|----------|------|------|
| SCN-001～004 | 實際 OpenCode 工具路徑（步驟 6） | 判斷「要不要用 Moli／Chrome」的是模型照著技能指引走，只有真的跑過一輪才看得到 |
| SCN-005 | wrapper 子程序測試（步驟 3）＋實際取消（步驟 6） | 逾時與非 0 結束用假 moli 就能重現；取消的訊號會不會傳到 bash 工具底下，只能實測（TBD-2） |
| SCN-006 | wrapper 子程序測試（步驟 3）＋真 Moli 的內網兩列 | 參數檢查是 wrapper 自己的邏輯；內網封鎖是 Moli 的行為，要用真 binary 驗 |
| SCN-007 | Dockerfile 靜態測試＋實際建置 | 沿用 `browser-install.test.ts` 的做法；雜湊錯誤時建置失敗只能實際建置驗證 |
| SCN-008 | 技能同步測試（暫存目錄 fixture） | 純檔案操作，沿用 issue 0010 的遷移測試 |
| SCN-009 | 提示詞單元測試＋實際 OpenCode 工具路徑（步驟 6 第四輪） | 提示詞內容用單元測試鎖住；有沒有讓模型先用 Moli，只有實測看得到 |

期望值的來源：fixture 的正文是預先寫好的字面值；舊版 `web-reading` 的雜湊來自 `718cc8b` 的實際檔案與正式部署副本；Moli 的結束碼與訊息來自步驟 1 的實測，不是照文件抄。

## 風險與首要驗證

見 [README.md](README.md#風險與首要驗證)。

## 檢查清單

- [x] SCN-001～008 已核准（2026-11-12）
- [x] 步驟 1 證據齊全，TBD-1 已解決，TBD-2 留給步驟 3、6
- [x] 步驟 2～6 各有紅燈→綠燈或實測證據
- [x] 常青文件已更新
- [x] build、test、lint 都 exit 0
- [ ] 本機獨立審查 PASS
