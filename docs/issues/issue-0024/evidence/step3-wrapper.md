# 步驟 3：Moli wrapper（SCN-003、SCN-005、SCN-006）

- **日期**：2026-11-12
- **被測工作區**：`feat/issue-0024-moli-web-reading`，未提交的 `scripts/moli-fetch.sh`、`tests/moli-fetch-wrapper.test.ts`、`Dockerfile`（wrapper 的 COPY）、`tests/docker/moli-install.test.ts`
- **設計**：見 implementation-plan「Wrapper」。依步驟 1 的實測，參數是 `--dump markdown --wait domstable --timeout 10000 --fail --block-private-networks -- <url>`。外層是 `timeout --foreground --kill-after=5 30`；wrapper 有自己的 `/tmp/tnm-*` 暫存目錄，trap 處理 TERM／INT／HUP，另外起一個獨立 session 的清理程序。

## 紅燈

先放一個只做轉呼叫的 stub（`exec moli fetch --dump markdown "$@"`），讓失敗出在目標行為，而不是「檔案不存在」。執行 `npx tsx --test tests/moli-fetch-wrapper.test.ts`：exit 1，15 個測試中 1 個通過、12 個失敗、2 個取消（[step3-red.log](step3-red.log)）。

- 通過的是「Moli 以非 0 結束時原樣傳回結束碼」：`exec` 本來就會這樣，不是目標行為。
- 失敗的 12 個，原因都是目標行為缺少：參數沒檢查、沒有 `--block-private-networks`、空輸出被當成成功、沒有逾時、沒有收尾。
- 取消的 2 個是 stub 沒有逾時，假 moli 一直不結束，測試跑到自己的逾時。這輪測試程序最後是以 PID 停掉殘留的假 moli 才結束；原因與修正見下面「測試本身的修正」。

## 綠燈

換上正式版後執行同一個命令：exit 0，15/15 通過，35 秒（[step3-green.log](step3-green.log)）。SCN-005 的五個收尾測試放在同一個 `describe({ concurrency: true })` 裡平行跑，原本依序跑要 96 秒。跑完後沒有殘留的假 moli、`tn24-wrapper-test-*` 或 `tnm-*`。

`tests/docker/moli-install.test.ts` 新增「wrapper 安裝成 `/usr/local/bin/telenexus-moli-fetch`，而且可執行」：加 COPY 之前 1/3 失敗，加了之後 3/3 通過。

## 突變

[step3-mutations.log](step3-mutations.log)：一次只改 `scripts/moli-fetch.sh` 一處，跑完整個 wrapper 測試，跑完還原（最後以 `cmp` 確認與正式版相同）。`# fail 0` 但有 `not ok` 的列，是失敗算在 `SCN-005 收尾` 這個 describe 底下。

| 突變 | 擋下的測試 |
|------|-----------|
| M1 拿掉 scheme 檢查 | file、data、只有參數、javascript 網址 |
| M2 拿掉 `--block-private-networks` | 固定參數 |
| M3 拿掉 `timeout` | 超過 30 秒、不理會 SIGTERM、只有 wrapper 被 SIGKILL |
| M4 拿掉獨立 session 的清理程序 | 整個 process group 被 SIGKILL、只有 wrapper 被 SIGKILL |
| M5 拿掉 `timeout --foreground` | 整個 process group 被 SIGKILL |
| M6 清理程序持有 stdout／stderr | **沒有擋下** |
| M7 拿掉空輸出判斷 | 輸出只有空白 |
| M8 不清掉 `MOLI_*` 環境變數 | 固定參數 |
| M9 拿掉 SIGTERM 的 trap | wrapper 收到 SIGTERM |
| M10 不加 `--fail` | 固定參數 |

M6 在目前的設計裡沒有可觀察的差異。正常結束時，wrapper 一結束，清理程序 0.2 秒內就退出；只有 wrapper 單獨被殺時，清理程序會比 wrapper 活得久，但那時 Moli 本身也還握著 stderr，管線要等 Moli 結束才會關閉。那行重新導向是保險，不是任何一個 SCN 的保障。

M3 第一次跑時，測試程序卡了約 13 分鐘：與紅燈同一個原因，最後以 PID 停掉 3 個假 moli 才繼續。

## 測試本身的修正

只要 wrapper 的收尾壞掉，假 moli 就會一直活著。測試逾時時 `await` 不會回來，`finally` 不會執行，整個測試程序就卡住，而不是單純失敗。現在改為在檔案層加 `after` hook，所有測試結束後一律 SIGKILL 還活著的假 moli 並刪除暫存目錄。用 M3 再跑一次：70 秒結束（等最長的測試逾時），3 個收尾測試失敗，沒有殘留。修正後再跑一次正式版：15/15 通過。

## 映像內的真 Moli

在 `telenexus:issue24`（`sha256:182b60c11a9d`，含 wrapper）裡，用步驟 1 的拋棄式網路與 fixture，以 node 身分執行 `telenexus-moli-fetch`（[step3/probe4.sh](step3/probe4.sh)、[step3/results4.jsonl](step3/results4.jsonl)）：

| 網址 | 結束碼 | 耗時 | 結果 |
|------|-------|------|------|
| 公開位址 `/js` | 0 | 387ms | 有正文 |
| `/js-async`（計時器加 fetch） | 0 | 1185ms | 有正文 |
| `/js-slow-api`（API 4 秒後回應） | 0 | 4391ms | 有正文 |
| `/ticker`（一直變動） | 0 | 10013ms | 有正文；10 秒期限到時回傳 |
| `/empty` | **3** | 375ms | `沒有正文` |
| `/nope`（404） | **22** | 374ms | `final main document returned HTTP status 404` |
| `/shell`（script 拋錯） | 0 | 380ms | 只有殼層 `WAITING`，由指引判斷改用 Chrome |
| `/hang` | 1 | 10011ms | `fetch readiness timed out after 10000 ms` |
| `127.0.0.1`、`localhost`、RFC1918、服務名稱 `memoria`、`169.254.169.254` | 1 | 13～15ms | `blocked private network address` |
| `data:` 網址 | **2** | 1ms | wrapper 擋下，沒有啟動 Moli |
| `127.0.0.1`，並帶 `MOLI_BLOCK_PRIVATE_NETWORKS=0` | 1 | 13ms | 仍然被擋 |

跑完後 `/tmp` 底下沒有 `tnm-*` 或 `moli-storage-*`。映像裡沒有 `ps`，所以結果檔的 `moli-procs` 那一列無效；程序殘留由上面 wrapper 測試的 `/proc` 檢查負責。

## 限制

- 使用者取消時，opencode 實際送什麼訊號、送給誰，這裡只用測試模擬了三種情況（wrapper 收到 SIGTERM、整個 group 被 SIGKILL、只有 wrapper 被 SIGKILL）。真實路徑留給步驟 6（README TBD-2）。
