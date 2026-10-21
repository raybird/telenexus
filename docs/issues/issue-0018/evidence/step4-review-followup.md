# 步驟 4：審查後續

- **日期**：2026-10-21
- **對應**：[review-6446a2d.md](../review-6446a2d.md) 的 SHOULD FIX 1～4，以及 NICE TO HAVE 1～4
- **環境**：所有命令都以 `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB` 執行。

## 處理結果

| 審查項目 | 處理 |
|---|---|
| SHOULD FIX 1：工作目錄被刪掉時會 throw 給呼叫端 | catch 裡的 `recordRuntimeIssue()` 包一層 try。`console.warn` 已經先印出紀錄，所以回報失敗時不再往外傳。補兩個測試：<br>• `workspace/context` 是一般檔案：連跑兩輪都不 throw，10 個 snapshot 各記一次。<br>• 刪掉工作目錄、unset `APP_PROJECT_DIR`：連跑 3 輪都不 throw。 |
| SHOULD FIX 2：event-projector 會同步重入 | 更正程式註解與步驟 2 證據：projector 會同步重入一次，必須先標成失敗再記 runtime issue，輪數才有上限。補一個測試：接上 `initEventProjector`，每次的錯誤訊息都不同，讓 60 秒 dedupe 幫不上忙。預期記 1 次、同步深度 2、兩次外層呼叫共寫 3 輪。 |
| SHOULD FIX 3（需決策）：預設不會推 Telegram 告警 | 使用者選「接受，文件寫明」（README D-1）。行為不變，`docs/web-console-reference.md` 寫明不會告警，以及哪裡看得到失敗。 |
| SHOULD FIX 4：「不記 runtime issue」的斷言太窄 | 改成加總所有 scope 的 `count`，不再只看 `memory-health` 開頭的 scope。 |
| NICE 2：一致性說明的措辭 | 改寫成「checkpoint 有 session ID 或處理時間、或者有 `memory.db`，就是 `null`」，並補一句：`ok` 只代表跨庫一致性，封存本身有沒有讀到，看 `archive.status`。 |
| NICE 1：`readLocalDb` 與 `readArchive` 合併 | 不處理，理由同步驟 1：要動 #17 已驗證的行為，效益小。 |
| NICE 3：10 個 snapshot 同時失敗會記 10 筆 | 不處理。AC-4 核准的 scope 是 `context-snapshot:<檔名>`；合併成目錄層級的一筆要另訂 scope，等同改規格。這個情況只在轉為失敗的那一刻發生一次。 |
| NICE 4：`LocalRead.exists` 是多餘欄位 | 不處理。報告的 `operational.exists`、`retrieval.exists` 是既有欄位，直接由它填入；拿掉它只是把推導移到別處。 |

## 紅燈

補上的測試先在 `6446a2d` 的程式上執行：

| 測試 | 修正前 |
|---|---|
| 目錄無法建立 | 第一次執行失敗，但原因是測試隔離：失敗狀態存在模組裡，前面的測試留下的狀態讓次數不符。補上測試用的 `clearContextSnapshotFailures()`，在每個測試開始時重設。審查已實測舊程式在這個情況下行為正確，所以這個測試守的是既有行為，用突變 Mc 證明有效。<br>同一次執行裡「工作目錄被刪掉」反而通過：狀態沒重設，10 個檔案都已在失敗中，根本沒呼叫 `recordRuntimeIssue()`。加上重設後才出現下一列的紅燈。 |
| 工作目錄被刪掉 | 失敗：`ENOENT: no such file or directory, uv_cwd`，就是 SHOULD FIX 1 的回歸 |
| 接上 event-projector | 修正前的程式是先標失敗再記，所以這個測試在舊程式上也是綠燈。它守的是「先標再記」的順序，改用下方突變 Ma 證明有效。 |

寫測試時另外發現兩件事：
- 用前面測試相同的錯誤訊息時，60 秒 dedupe 會把它合併掉，不觸發 projector，測試量不到重入。
- `recentIssues` 只保留 20 筆，前面的測試已經把它擠滿，以前後差計數會算錯。

所以這個測試改成每次給不同的錯誤訊息，並以 `addIssueHook` 計數。

## 綠燈與突變

```
npx tsx --test tests/context-snapshots.test.ts tests/memory-health.test.ts
# tests 26
# pass 26
# fail 0
```

交付檢查（提交前的工作區）：
- `npm run build` exit 0。
- `env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npm run test` exit 0：`# tests 558`、`# pass 558`、`# fail 0`。比步驟 3 多 3 個，就是本步驟新增的測試數。`tests/docker/` 的 4 個檔案都有跑到。
- `npm run lint` exit 0。

| 突變 | 轉紅的測試 |
|---|---|
| Ma：先記 runtime issue 再標成失敗 | 接上 event-projector |
| Mb：拿掉 `recordRuntimeIssue()` 外面的 try | 工作目錄被刪掉 |
| Mc：目錄在迴圈外解析與建立，不在 try 裡（審查的 M8） | 目錄無法建立；工作目錄被刪掉 |
| Md：`readLocalDb()` 讀不了時記 `local-db:<label>`（審查的 M7） | 運作資料庫不是 SQLite、缺少資料表，檢索資料庫不是 SQLite（3 個）。對照：舊的斷言在同一個突變下 19/19 全過 |

每次只改一處，跑完就還原（`diff` 確認與原檔相同）。
