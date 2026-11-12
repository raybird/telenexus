# 步驟 6：實際 OpenCode 工具路徑（SCN-001～005）

- **日期**：2026-11-12
- **被測映像**：`telenexus:issue24`（`sha256:b0afda1cc196`），以 `git archive HEAD`（分支頭 f26c5a2）為建置內容，與 CI 一樣只含 git 追蹤的檔案
- **模型**：`opencode/big-pickle`（正式部署 `ai-config.yaml` 的預設值，免費層，不需憑證）。正式部署另有 `data/ai-config.override.yaml` 指向需要憑證的模型，這裡沒有使用
- **驗法**：使用者 2026-11-12 選「只用真模型」（Q9）。每個情境只跑一次，模型沒照指引走時照實記錄，不重跑

## 環境

[step6/run-step6.sh](step6/run-step6.sh) 建立拋棄式網路 `tn24s6-pub`（`45.67.89.0/24`，Moli 不封鎖的非保留網段）與 `tn24s6-priv`（Docker 預設的 RFC1918 網段），fixture 同時接上兩個網路。每個情境起一個全新的 agent-runner 容器：

- 以 `node scripts/sync-skills.mjs && node dist/runner.js` 啟動，與 `npm run start:runner` 相同。不對外開 port，沒有 Telegram token，資料只在容器內。
- 權限與正式部署相同：`--init`、`--cap-drop ALL`、`no-new-privileges`、`--memory 2g`、`--pids-limit 1024`，以 uid 1000 執行。`OPENCODE_YOLO=1` 與 `OPENCODE_SKILLS_DIRS` 照 compose。
- `/app/workspace` 跟正式部署一樣是 bind mount，內容是 git 追蹤的 `workspace/`，加上 v2.37.0 出貨的舊版 web-reading。每個容器啟動時都記錄到 `Upgraded builtin web-reading`，舊版備份到 `retired-skills/web-reading-718cc8b`，換上的 `SKILL.md` 雜湊與 repo 相同（`results/*-sync.log`、`results/*-skill.txt`）。
- 請求由容器內的 [step6/client.mjs](step6/client.mjs) 送到 `POST /run`，內容是一則使用者訊息：「幫我讀這個網頁，告訴我正文寫了什麼，並附上網址：<網址>」。

**第一次執行作廢**：第一輪用的映像是在 repo 目錄直接建置的，`COPY workspace` 把開發者本機的 `workspace/` 整個帶進映像。技能同步在 overlay 檔案系統上改名失敗（`EXDEV`），新版 web-reading 沒有裝上。跑完第一個情境就停掉，改用上面的乾淨建置與 bind mount 重跑，作廢那輪的結果沒有採用。這是本機建置的既有行為，GHCR 映像不受影響。

## 觀測器與對照

- **讀取者**：[step6/fixture6.mjs](step6/fixture6.mjs) 依 User-Agent 分辨讀取者，Moli 是實測的 v1.1.23 字串，Chrome 含 `HeadlessChrome`，其他歸為 `other`；實際上 `other` 就是 webfetch，UA 為 `Chrome/143.0.0.0`。
- **正文來源**：JS 正文由頁面 script 帶自訂標頭向 `/<情境>/api` 取得。原始 HTML 裡沒有正文字面值，直接讀 API 只會拿到 403，所以只有真的執行了 JavaScript 才讀得到。
- **程序與暫存檔**：[step6/sampler.mjs](step6/sampler.mjs) 在 runner 容器內每 100ms 掃一次 `/proc` 與 `/tmp`，記錄 wrapper、moli、Chrome、chrome-devtools-mcp、任何 zombie，以及 `tnm-*`、`moli-storage-*`、`tnb-*`。
- **工具呼叫順序**：取自回合結束後的 `opencode export`（`results/*-session.json`）。

觀測器先跑過正負對照（[step6/control.sh](step6/control.sh)、[results/control-analysis.jsonl](step6/results/control-analysis.jsonl)），全部抓到預期的東西：

| 對照 | 觀測到 |
|------|--------|
| 空閒 3 秒（負） | 沒有程序、沒有暫存目錄、fixture 沒有請求 |
| 直接執行 `telenexus-moli-fetch` | wrapper、moli、`tnm-*`；fixture 記到 `moli` |
| 刻意不清理的 `/tmp/tnm-control` | 抓到 `tnm-control` |
| 沒人收的子程序 | 抓到 `zombie` |
| 直接啟動 Chrome | Chrome 程序與 `tnb-control`；fixture 記到 `chrome` |
| curl | fixture 記到 `other` |
| 全部結束後（負） | 最後一列沒有程序、沒有暫存目錄 |

## 結果

兩輪各 8 個情境，每個情境每輪只跑一次：
- **第一輪**：使用者原話直接送 runner，搭配舊措辭的技能，彙整在 [results/analysis.json](step6/results/analysis.json)。
- **第二輪**：使用者在 Q11 選「改指引措辭後，用正式提示詞重測」。技能開頭改成「一層取得所需正文就停，讀不到才進到下一層」，送出的是 `src/main.ts` 在 full 模式組出的提示詞，內容含 `【可用技能索引】`。彙整在 [results-round2/analysis.json](step6/results-round2/analysis.json)。

「工具順序」取自 session export，「Moli／Chrome」取自 `/proc` 採樣與 fixture 紀錄，兩者一致。

| 情境 | 第一輪 | 第二輪 |
|------|--------|--------|
| SCN-001 靜態頁 | 載入技能；webfetch 讀到正文，仍執行 Moli 和 Chrome。**未通過** | 同第一輪。**未通過** |
| SCN-002 JS 頁 | 沒載入技能；webfetch → Chrome，回覆正確。**未通過**（沒走 Moli） | 沒載入技能；webfetch → Chrome → 截圖 → `read` 截圖被權限拒絕，回覆只剩「Opencode 執行完成,但沒有返回任何文字內容。」**未通過** |
| SCN-003 一直不完成載入 | 載入技能；Moli 10 秒後 exit 1 → Chrome，回覆正確。通過 | 同第一輪。通過 |
| SCN-003 Moli 非 0（500） | 載入技能；Moli exit 22 → Chrome。通過 | webfetch 之後才載入技能；Moli exit 22 → Chrome。通過 |
| SCN-003 只有殼層 | 沒載入技能；webfetch → Chrome。**未驗到** | 沒載入技能；從原始碼看出 API，用 `curl` 帶標頭直接取。**未驗到** |
| SCN-003 內網位址 | 載入技能；Moli exit 1（`blocked private network address`）→ Chrome。通過 | 同第一輪。通過 |
| SCN-004 都讀不到 | 載入技能；三層都只有 `WAITING`，回覆「讀取失敗，沒有可讀的正文」。通過 | 沒載入技能；webfetch → Chrome → `curl`，回覆說明沒有正文、沒有捏造。結果符合，但沒走 Moli |
| SCN-005 取消 | 載入技能；Moli 執行中取消。見下方「收尾」 | 見下方「第二輪的取消」 |

除了取消的情境，所有回合的 `ok` 都是 true，沒有 `structured.failure`。

### 歸納

- **載入了技能，就會先試 Moli**：兩輪合計 11 次載入，每次都在 Chrome 之前執行 wrapper。Moli 失敗時，都照指引退回 Chrome。
- **沒載入技能，就不會用 Moli**：兩輪合計 6 次沒載入（第一輪 2 次；第二輪 4 次，含取消情境的第三次），都直接開 Chrome 或改用 `curl`。這時的行為等於 issue 0024 之前的狀態，不是新功能造成的破壞，但新功能也沒有發揮。full 模式的技能索引沒有提高載入率：第二輪反而更低。
- **SCN-001 兩輪都未通過**：webfetch 已回傳正文（Markdown 把 `_` 轉成 `\_`），模型仍依序執行 Moli 和 Chrome。改措辭沒有改變這個行為。代價是靜態頁每次多一次 Moli 和一次 Chrome。
- **跟 Moli 無關的既有問題**：第二輪 SCN-002 的空回覆，是模型自己截圖後讀不到 `/tmp` 下的截圖檔造成的。

### 第三輪：擬真頁面

使用者在 Q12 選「改成擬真頁面後重跑」。每頁改成一則短新聞，驗收代碼放在「公告編號」那句裡；JS 頁面在 script 執行前只顯示「載入中…」。提示詞與第二輪相同，都是 full 模式。結果在 [results-round3/analysis.json](step6/results-round3/analysis.json)。

| 情境 | 結果 |
|------|------|
| SCN-001 靜態頁 | 沒載入技能；只用 webfetch，就以正文與網址回答，沒有執行 Moli 或 Chrome。**通過** |
| SCN-002 JS 頁 | 沒載入技能；webfetch（`載入中…`）→ Chrome，回覆正確。**未通過**（沒走 Moli） |
| SCN-003 一直不完成載入 | 沒載入技能；webfetch → Chrome，回覆正確。**未驗到**（沒走 Moli） |
| 其餘 5 個 | 2026-11-12 14:34 起，上游回報免費額度用完，回合在 3 秒內中止，沒有結果 |

- 前兩輪 SCN-001 的失敗，來自 fixture 的正文只有一串代碼：換成擬真頁面後，模型讀到正文就停。
- 第三輪 3 個有效情境都沒有載入技能。三輪合計有效樣本 20 次，載入 11 次、沒載入 9 次。

### 第四輪：常駐規則＋正式部署的模型（最終判定）

第三輪額度用完後，加上 SCN-009 的常駐規則（`859331a`），映像以 `git archive HEAD` 重建（`sha256:29dfc369b79f`）。頁面與第三輪相同（擬真新聞），提示詞是 full 模式，內容含【網頁讀取】。

模型改用正式部署 override 的 `nvidia/z-ai/glm-5.3-flash`，這是使用者在 Q14 的選擇。憑證只從本機 auth.json 取 Nvidia 那一筆，寫成權限 600 的暫存檔，以唯讀方式掛進每個拋棄式容器，測完已刪除；證據裡沒有這把 key。結果在 [results-round4/analysis.json](step6/results-round4/analysis.json)。

| 情境 | 工具順序 | 回覆 | 判定 |
|------|---------|------|------|
| SCN-001 靜態頁 | webfetch | 正文與網址 | 通過：沒有執行 Moli 或 Chrome |
| SCN-002 JS 頁 | webfetch（`載入中…`）→ Moli（exit 0，讀到正文） | 正文與網址 | 通過：fixture 只記到 other 與 moli，沒有 Chrome 程序 |
| SCN-003 一直不完成載入 | webfetch → Moli（10 秒自行逾時，exit 1）→ Chrome | 正文與網址 | 通過 |
| SCN-003 Moli 非 0（500） | webfetch → Moli（exit 22）→ Chrome | 正文與網址 | 通過 |
| SCN-003 只有殼層 | webfetch → Moli（exit 0，只有 `載入中…`）→ Chrome | 正文與網址 | 通過：「Moli 只讀到殼層再退回」這條路徑第一次實際發生 |
| SCN-003 內網位址 | webfetch → Moli（被封鎖）→ Chrome | 正文與網址 | 通過 |
| SCN-004 都讀不到 | 技能 → webfetch → Moli → Chrome（等 5 秒再讀一次） | 「結論：讀取失敗（無正文）」，說明 script 拋錯、沒有捏造 | 通過 |
| SCN-005 取消 | webfetch → Moli 執行中（wrapper 第 86 秒出現，第 89 秒中斷連線） | 回合中斷 | 通過：Moli 在 wrapper 啟動後 10.0 秒結束並清掉暫存目錄，與第一輪相同 |

- **SCN-009 的效果**：8 輪中只有 SCN-004 那一輪載入了技能，但 7 個需要 JS 的情境全都先試 Moli，順序與退回都照常駐規則走。第一到三輪沒載入技能就不用 Moli 的情況，這一輪沒有再發生。
- **模型速度**：這個模型一回合 88～252 秒。
- **SCN-003 內網位址重跑一次**：第一次上游 300 秒內沒有任何回應，測試 client 的 `fetch` 剛好有 300 秒的預設逾時，時間一到 client 斷線，runner 就把它當成取消（`results-round4/s3d-*.timeout`）。改用沒有逾時的 `http.request` 重跑，上表是重跑的結果。這是測試工具的問題，與 Moli 無關。
- **收尾（SCN-005）**：每個情境只看 Moli 這一側（wrapper、moli、`tnm-*`、`moli-storage-*`），全部清掉的時間都在 wrapper 啟動後 0.1～10.0 秒。用 Chrome 的情境，在「wrapper 啟動後 45 秒」那個檢查點時 Chrome 還在用（回合還沒結束），那是 issue 0010 的範圍。所有情境的最後一列都沒有任何程序或暫存目錄。

### 30 秒硬逾時

「頁面超過 30 秒仍未完成載入」這一例，實際上是 Moli 自己的 `--timeout 10000` 先在 10 秒時結束，exit 1。wrapper 的 30 秒硬逾時在真 Moli 上沒有觸發，只由步驟 3 的假 moli 測試驗證。

### 收尾（SCN-005）

每個情境的檢查點：用到 wrapper 時是 wrapper 啟動後 45 秒，沒用到時是回合結束後 15 秒。兩輪所有情境在檢查點都沒有 moli、wrapper、zombie、`tnm-*`、`moli-storage-*` 或 `tnb-*`，採樣器的最後一列也是空的。

採樣器只在狀態改變時寫一列，下表的時間是最後一個忙碌列的下一列，也就是觀測到全部清掉的時間：

| SCN-005 例 | 取自（第一輪） | wrapper 啟動後多久全部清掉 |
|-----------|------|------|
| 正常完成 | SCN-001（Moli exit 0） | 8.5 秒（後段是 Chrome 階段的短暫 zombie） |
| 超過時限 | SCN-003 一直不完成載入（Moli 10 秒自行逾時） | 16.5 秒 |
| Moli 以非 0 結束 | SCN-003 Moli 非 0 | 16.3 秒 |
| 使用者取消 | SCN-005：wrapper 在第 10 秒出現，第 13 秒中斷 HTTP 連線 | 10.0 秒 |

**取消的實際路徑（TBD-2）**：第 13 秒 runner 依連線關閉終止 opencode（pid 106），但 bash 工具裡的 wrapper（pid 225）沒有一起結束，而是被收養到 pid 1，與 Moli 繼續執行。直到第 20 秒 Moli 自己的 10 秒逾時到了，才結束並清掉 `tnm-*`（[results/s5-proc.jsonl](step6/results/s5-proc.jsonl)）。也就是說：
- 取消訊號不會傳到 wrapper；
- 收尾靠 Moli 的 10 秒逾時，最壞情況靠 wrapper 的 30 秒硬逾時；
- 兩者都落在 45 秒窗口內，所以這一例仍符合 SCN-005。

### 第二輪的取消

第二輪的取消跑了三次，都沒有得到「Moli 執行中取消」的樣本，所以 SCN-005 的取消只有第一輪那一份證據：
1. **第一次作廢**：full 模式的提示詞放在 opencode 的 argv，技能索引裡又有 `telenexus-moli-fetch` 字樣。採樣器與 client 依 cmdline 判斷 wrapper，把 opencode 本身也算進去，第 0 秒就判定 wrapper 出現，3 秒後取消，那時 Moli 還沒啟動（`results-round2/s5-*.invalid.*`）。改成「cmdline 含這個字樣、而且不是 opencode」重判；第二輪其他情境的分析也用同樣的規則重算。
2. **第二次沒觸發取消**：中間有一版誤用 comm 判斷 wrapper（wrapper 的 comm 其實是 `bash`），client 沒偵測到 wrapper，回合就這樣跑完了：載入技能 → Moli 逾時 → Chrome，回覆正確（`results-round2/s5-*.nocancel.*`）。這一份可視為 SCN-003 一直不完成載入的另一個樣本。
3. **第三次沒用到 Moli**：判斷規則修好後，模型沒有載入技能，直接 webfetch → Chrome，沒有可以取消的 wrapper。

## 結論

第四輪（常駐規則、擬真頁面、正式部署的模型）的 8 個情境全部符合 SCN-001～005 與 SCN-009。前三輪的失敗分成三類，都已處理：
- fixture 的正文不像真頁面：改用擬真頁面；
- 模型不一定載入技能：新增 SCN-009；
- 觀測器與測試 client 的缺陷：已修正，並在上文逐一說明。

## 限制

- 每個情境每輪只跑一次，載入率是 20 次有效樣本（11 次載入、9 次沒載入；作廢與額度用完的不算）中的觀察，不是穩定的比例。
- 第四輪每個情境只跑一次；常駐規則下的穩定程度，要等上線後看實際使用。
- compact／minimal 模式與排程任務的提示詞沒有實測；排程提示詞沒有加常駐規則。
- 記憶內容沒有納入（每個 runner 都是全新的）。
