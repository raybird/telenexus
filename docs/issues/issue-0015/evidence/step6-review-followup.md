# 步驟 6：審查後續

- **日期**：2026-10-21
- **對應**：[review-e0585ce.md](../review-e0585ce.md) 的 SHOULD FIX 1～5，以及 NICE TO HAVE 1～4
- **環境**：所有測試與 CLI 都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行；端到端與步驟 4 相同，用拋棄式專案 `tn15probe`。

## 處理結果

| 審查項目 | 處理 |
|---|---|
| SHOULD FIX 1：服務檢查把 503、404、逾時誤判為已停止 | 不再用 `pingMemoriaEndpoint()`，改由工具自己的 `checkMemoriaStopped()` 判斷。只有 `ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN` 算已停止。收到任何 HTTP 回應，或逾時、其他錯誤而無法確認，都拒絕寫入。報告的 `serviceCheck` 加上 `detail`，記錄判定依據。 |
| SHOULD FIX 2：`--db` 預設落到 `MEMORIA_HOME` | CLI 改成 `--db` 必填，不給就由 commander 以非 0 結束。實作計畫的 CLI 一節同步修改。 |
| SHOULD FIX 3：`CLAUDE.md` 沒補新命令 | Common Commands 的 Memory tooling 補上一行。 |
| SHOULD FIX 4：SCN-013 的核准紀錄 | README 核准紀錄展開成表格，SCN-013 有自己的核准 commit `cf5cbff`。 |
| SHOULD FIX 5：「不刪其他 scope 的節點」沒有測試 | 新增測試，在其他 scope 放一個沒有來源的 topic 與一個沒有子節點的 root，確認寫入後完全不變。 |
| NICE 1（需決策）：SCN-013 的 Then 比實作寬 | 使用者核准的選項原文是「不切開 surrogate pair」，所以把 Then 收斂成「不含落單的 surrogate，不會寫出不合法的 UTF-8」，不改成以字形為單位截斷。記在 README 核准紀錄與 Timeline。 |
| NICE 2：自我檢查與「ModelMessage 超過一筆」沒有測試 | 補上兩個測試：用 trigger 讓改寫 sessions 時連帶改到 events，自我檢查要整批回滾；兩筆 ModelMessage 要列入人工審閱。步驟 3 證據裡「造不出違反情況」的說法不正確，已在該檔更正。 |
| NICE 3：操作文件 | `docs/installation.md` 補上三點：工具輸出的 `/memoria/` 路徑在 Memoria 容器裡是 `/data/`；回復會丟掉遷移後新增的記憶；重建索引前不要跑 `memoria prune --stale-days`。最後一點查過 Memoria 原始碼：`pruneStaleMemory()` 會把沒有 `memory_node_sources` 而且時間早於門檻的 session 列為刪除候選。 |
| NICE 4：非字串的 `user_id` 原因寫成「缺少」 | `user_id` 不存在時寫「缺少 user_id」，存在但不是有效字串時寫「user_id 不是有效的字串」。 |
| NICE 5：紀錄與報告各自重算統計 | 不處理。兩處都呼叫同一個 `countByScope()`，只是各自組資料，合併的效益不大。 |
| NICE 6：前置檢查沒確認 `recall_fts` 的 trigger | 不處理。trigger 不見時，`recall_fts` 不會跟著 summary 更新，但 `sessions` 與索引照常；`memoria index build` 也不依賴它。記為已知限制。 |

## 順序與紅燈

這次先改了程式才寫測試，順序不對。補救方式：測試寫好之後，用 `git show e0585ce:<路徑>` 把服務與 CLI 換回審查時的版本，以新測試跑一次，跑完再換回新版。沒有用 git stash。

```
# e0585ce 的服務與 CLI，配上新測試
# tests 26
# pass 21
# fail 5
```

失敗的 5 個：
- SCN-004：原因措辭，新的「有效的字串」。
- SCN-007：503。
- SCN-007：逾時。
- CLI：沒有 `--db`。
- SCN-002：`serviceCheck` 多了 `detail`。

「不動其他 scope 的節點」與「自我檢查」這兩個測試守的是既有行為，在舊程式上也是綠燈，所以改用下面的突變檢查證明它們有效。

另外一個發現：測試原本把「已停止」的 endpoint 設成 `http://127.0.0.1:9`。新程式改用 `fetch` 之後，這個埠被 `fetch` 的封鎖清單擋下（`bad port`），工具判定「無法確認」而拒絕寫入。這是保守而正確的行為。測試改成先開再關一個高位埠，確保那裡沒有服務在聽。

## 綠燈與突變

```
npx tsx --test tests/memoria-legacy-scope.test.ts
# tests 26
# pass 26
# fail 0
```

| 突變 | 轉紅的測試 |
|---|---|
| 兩條刪除孤立節點的 DELETE 拿掉 `scope = ?` | SCN-002：寫入不動其他 scope 的索引節點。審查時這個突變全綠，補強測試資料後轉紅。 |
| 拿掉 events 的自我檢查 | SCN-009：自我檢查 |
| HTTP 5xx 也當成已停止 | SCN-007：503 |

每次只改一處，跑完就還原（`diff` 確認與原檔相同）。

## 端到端（重建映像後）

| 情況 | 結果 |
|---|---|
| 不給 `--db` | exit 1，`error: required option '--db <path>' not specified` |
| Memoria 執行中加 `--write` | exit 1，`Memoria 服務仍在執行（http://memoria:3917 回應 HTTP 200），請先停止 Memoria 再寫入` |
| `docker compose stop` 後加 `--write` | exit 0，`服務檢查：http://memoria:3917 沒有服務在聽（EAI_AGAIN），視為 Memoria 已停止`，已遷移 2,300 筆，產生一個備份目錄 |

## 交付檢查

在提交前的工作區上執行：

- `npm run build` exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0：`# tests 545`、`# pass 545`、`# fail 0`。比步驟 5 的 540 多 5 個，就是本步驟新增的測試數。`tests/` 下仍是 71 個測試檔，`tests/docker/` 的 4 個檔案都出現在輸出中。
- `npm run lint` exit 0；三個異動的 TypeScript 檔通過 `prettier --check`。

步驟 4 的證據保留當時的輸出（例如「連不上，視為 Memoria 已停止」），那是 `cf5cbff` 映像的實際結果；新版的輸出以本檔為準。
