# 步驟 1：在拋棄式容器實測釘版 Moli

- **日期**：2026-11-12
- **對應**：implementation-plan 步驟 1；SCN-002、SCN-005、SCN-006、SCN-007；README TBD-1、TBD-2
- **產品變更**：無。不動 repo 的產品程式，也不碰正式部署。

## 環境

| 項目 | 值 |
|------|----|
| 映像 | `ghcr.io/raybird/telenexus:v2.37.0`（現行 release，Debian 12 bookworm，glibc 2.36） |
| 執行身分與限制 | `--user 1000:1000`（node）、`--init`、`--security-opt no-new-privileges:true`、`--cap-drop ALL`、`--pids-limit 1024`、`--memory 2g`，依 `docker-compose.release.yml` 的 agent-runner 設定 |
| Moli | v1.1.23，`moli-x86_64-unknown-linux-gnu.tar.gz` |
| tarball sha256 | `df360c04e567ce2e56a8391a03dc677d794465848b5821f944d2de10f3f1f430`（本機 `sha256sum` 的結果，與 GitHub release asset 公布的 digest 相同） |
| tarball 內容 | `moli-v1.1.23-x86_64-unknown-linux-gnu/` 底下有 `moli`（111,579,728 bytes）、`VERSION`、授權檔 |
| 網路 | `tn24-pub`：`45.67.89.0/24`，不在任何保留網段，用來代表公開位址，fixture 在 `45.67.89.10`。`tn24-priv`：Docker 預設的 RFC1918 網段，fixture 在 `172.21.0.2`，並帶別名 `memoria`。探測容器兩個網路都接，也可以連外網 |

做法：Moli 以唯讀方式掛進容器，fixture 伺服器跑在另一個容器。腳本、fixture 與原始輸出都放在 [step1/](step1/)：`run-probe.sh` 負責建立與拆除網路及容器，`probe.sh`、`probe2.sh`、`probe3.sh` 是三輪探測，`results*.jsonl` 是原始結果。重跑方式：`PROBE=probe2.sh bash run-probe.sh <step1 目錄> <解開的 moli 目錄> <輸出目錄>`。

## 結果

### 能不能執行（SCN-007）

- `moli --version` 輸出 `moli 1.1.23`，exit 0。
- `ldd` 列出的 `libstdc++`、`libfontconfig`、`libfreetype`、`libpng16`、`libbrotli*`、`libexpat`、`libz` 在映像裡都已經有，沒有 `not found`。**不必新增 apt 套件。**
- HTTPS 正常：`https://example.com/` exit 0，有正文（`results.jsonl` 的 `https-example`），可見映像內的 CA 憑證可用。

### 讀取 fixture（SCN-002）

全部加 `--dump markdown --block-private-networks`，fixture 都放在公開位址 `45.67.89.10`。正文比對時先拿掉 Markdown 的反斜線跳脫，因為 Moli 會把 `_` 輸出成 `\_`。

| fixture | 正文怎麼出現 | `done` | `load` | `networkidle` | `domstable` |
|---------|-------------|--------|--------|---------------|-------------|
| `/static` | HTML 本身就有 | ✅ 20ms | — | ✅ 519ms | — |
| `/js` | inline script | ✅ 20ms | — | ✅ 524ms | — |
| `/js-module` | ES module import | ✅ 22ms | — | ✅ 523ms | — |
| `/js-async` | 800ms 計時器後再 `fetch` | ❌ `WAITING` | ❌ | ❌ 524ms | ✅ 1175ms |
| `/js-slow-api` | 立刻 `fetch`，API 4 秒後才回應 | ❌ | ❌ | ✅ 4524ms | ✅ 4378ms |
| `/js-late` | 3 秒計時器，中間沒有網路活動 | ❌ | ❌ | ❌ 522ms | ❌ 1223ms |
| `/ticker` | 正文立刻出現，之後每 100ms 變動 | — | — | ✅ 522ms | ✅ 但 **25009ms** |
| `/idb` | 寫入 localStorage 與 IndexedDB 後才出現 | — | — | ✅ 530ms | — |

（— 表示沒有測。）

- 只有 inline script 或 module 的頁面，四種策略都讀得到。
- **`done`（預設）不會等計時器或之後才發出的請求。** `domstable` 涵蓋的情況最多，但遇到一直變動的頁面，要等到 Moli 自己的就緒期限（`-t`，預設 25000ms）才結束，結束碼仍是 0，也有正文。
- 3 秒純計時器的頁面，四種策略都讀不到，只拿到殼層 `WAITING`，exit 0。這種情況依 SCN-003 會退回 Chrome。
- `/shell`（script 拋錯）：exit 0，輸出殼層 `WAITING`。
- `/empty`（body 為空）：**exit 0，stdout 是空的**，所以 wrapper 必須自己判斷空輸出（SCN-003 第 3 例）。
- 404（`/nope`）：**exit 0，stdout 是 `not found`**，耗時 1014ms（`--redirect-wait-ms` 預設 1000）。加 `--fail` 的話，HTTP ≥ 400 會改成 exit 22。
- 連不上的公開位址（`45.67.89.99`）：exit 1，約 3 秒，stderr 是 `Could not connect to server`。

### 內網封鎖（SCN-006）

| 目標 | 加 `--block-private-networks` | 不加（負對照） |
|------|-----------------------------|---------------|
| `127.0.0.1` | exit 1，`blocked private network address 127.0.0.1` | exit 0，有正文 |
| `localhost` | exit 1，被擋的位址是 `::1` | — |
| `[::1]` | exit 1 | — |
| `172.21.0.2`（RFC1918） | exit 1 | exit 0，有正文 |
| `memoria`（服務名稱，解析成 RFC1918） | exit 1，被擋的位址是 `172.21.0.2` | — |
| `10.255.255.1` | exit 1，約 11ms，不需要真的連線 | — |
| `169.254.169.254`（metadata） | exit 1 | — |
| `45.67.89.10`（非保留網段） | 不擋，exit 0 | — |

被擋時一律是 exit 1，stdout 是空的，stderr 是 `Error: failed to fetch ...` 加上 `Reason: ... blocked private network address ...`。負對照證明擋下來的原因是這個旗標，不是連不上。

### scheme 與參數（SCN-006）

- `file:///etc/hostname`：Moli 自己就拒絕，exit 1，`Navigation to a local file URL requires an explicitly granted browser capability`。
- `data:text/html,<p>ISSUE24_DATA</p>`：**Moli 接受，exit 0，輸出 `ISSUE24\_DATA`。** 所以 wrapper 必須自己檢查 scheme（Q8）。
- `--` 分隔：`moli fetch ... -- <url>` 可以用，結果與不加相同。
- 等待參數叫 `--wait`；上游 README 與 implementation-plan 原本寫的 `--wait-until` 在 v1.1.23 的 `fetch --help` 裡不存在。
- Moli 也讀環境變數，例如 `MOLI_BLOCK_PRIVATE_NETWORKS`、`MOLI_LAYOUT`、`MOLI_RESOURCE`。wrapper 要明確傳旗標，不依賴環境變數。

### 逾時、訊號與程序（SCN-005）

- `/hang`（標頭送出後本文永不結束）：外層 `timeout --kill-after=5 30` 還沒觸發，Moli 就自己在 **25008ms** 以 exit 1 結束，`fetch readiness timed out after 25000 ms while streaming main body`。也就是 Moli 自己的 `-t` 會比 30 秒硬逾時先到；外層逾時只是保險，要在步驟 3 用假 moli 驗證。
- SIGTERM：exit 143，收到訊號後 2ms 就結束。
- Moli 是單一程序：每一次結束後（正常、Moli 自己逾時、SIGTERM）在 `/proc` 都看不到 `moli` 程序，也沒有 zombie（`procs:*` 那幾列都是空的）。

### 檔案系統（TBD-2）

- 第一輪用 `find -newer` 的比對方式無效：列出了整個映像的檔案，原因沒有追查。`results.jsonl` 那一列只保留筆數，結論不採用。
- 第二輪改成比對前後完整清單（路徑、大小、mtime）。中間跑了 `/idb`、`/js-module`、`https://example.com/` 三次 `fetch`（`snap-diff.txt`）：**唯一的差異是 `TMPDIR` 目錄自己的 mtime**。`HOME`、`~/.cache`、`~/.config`，以及 rootfs 的其他位置都沒有新檔。
- 第三輪在 `/idb-hold`（寫入 IndexedDB 後持續變動）執行 3 秒時中斷，`TMPDIR` 底下有 18 個項目：`moli-storage-XXXXXX/`，裡面有 `cookies.sqlite`、`cookies.sqlite-wal`、`idb-lite/.../db.sqlite`（含 WAL，約 230 KB）、`opfs/...`。
  - SIGTERM（exit 143）：中斷後 1 秒仍有 **18 個項目，沒有清理**。
  - SIGKILL（exit 137）：同樣留下 18 個項目。
- 結論：沒帶 `--profile-dir` 時，Moli 只寫 `TMPDIR/moli-storage-*`。正常結束（包括 Moli 自己逾時的 exit 1）會清掉；**被 SIGTERM 或 SIGKILL 中斷時會留下來**。外層 `timeout` 送的就是 SIGTERM，所以 wrapper 一定要有自己的暫存目錄，並在 Moli 結束後刪除。

## 對 TBD 的結論

- **TBD-1（fixture 放哪裡）**：已解決。`--block-private-networks` 不擋非保留網段，所以拋棄式 Docker 網路用 `45.67.89.0/24` 這類非保留網段放 fixture，就能在不關掉封鎖的情況下驗證 SCN-002、SCN-003。內網那幾列用同一個 fixture 的 RFC1918 位址與服務名稱驗證。wrapper 不需要為了測試開放關閉封鎖的參數。
- **TBD-2（取消與暫存檔）**：部分解決。Moli 不寫 `HOME` 或 `XDG_*`，只寫 `TMPDIR/moli-storage-*`，被訊號中斷時會留下。wrapper 自己被 SIGTERM 時，可以用 trap 清理。**wrapper 和 Moli 一起被 SIGKILL 時**，trap 不會執行，暫存目錄會留下，這條路徑會違反 SCN-005。實際取消時 opencode 送的是什麼訊號、送給誰，仍要在步驟 6 實測。設計調整見下節。

## 對設計的影響（已回寫 implementation-plan）

1. Dockerfile 的釘版值：v1.1.23、sha256 `df360c04…f430`、執行檔路徑 `moli-v1.1.23-x86_64-unknown-linux-gnu/moli`。不需要新增 apt 套件。
2. 等待參數：`--wait` 而不是 `--wait-until`。策略改成 `--wait domstable`，並把 Moli 的就緒期限從 25 秒縮成 `--timeout 10000`。理由：`domstable` 涵蓋的 JS 頁面最多；一直變動的頁面在期限到時仍會回傳當下內容，10 秒能限制它最多拖多久。最壞情況（主文件本身 10 秒內載不完）Moli 會 exit 1，退回 Chrome。外層 30 秒硬逾時不變（Q6）。
3. 加 `--fail`：HTTP ≥ 400 時 exit 22，讓「錯誤頁」走 SCN-003 的非 0 路徑，不把 404 的內文當正文。
4. wrapper 一定要擋 `data:`（Moli 自己會接受），`file:` 也照 Q8 擋在 wrapper，不依賴 Moli。
5. 暫存目錄：wrapper 建 `/tmp/tnm-XXXXXX`，把 `TMPDIR` 指過去，trap 在結束時刪除。為了 SIGKILL 的路徑，wrapper 另外以 `setsid` 起一個獨立 session 的清理程序：等 Moli 結束（最多 40 秒）後刪除這個目錄。這個程序不在被殺的 process group 裡，所以即使 wrapper 與 Moli 一起被 SIGKILL，也會收尾。要在步驟 3 用測試驗證，並在步驟 6 實測取消。
6. 正文比對：Moli 會把 `_` 跳脫成 `\_`，後續測試 fixture 的正文字串不要用底線，或比對前先去掉反斜線。

## 未涵蓋

- 記憶體與 CPU 用量沒有量，上游公布的 73 MiB 中位數在本環境沒有驗證。不影響本 issue 的驗收，所以不追測。
- 真實網站的成功率沒有測，只測了受控 fixture 與 `example.com`。實際成功率由步驟 6 和上線後的使用情況反映。
