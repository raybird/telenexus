# 審查報告
- 範圍：修正輪的完整分支 diff `main..feat/telegram-model-panel`，固定 BASE 為 2d23d19，HEAD 為 6d0d27c。重點是 87b6cf6 之後的兩個提交（39855b1 保存上一份報告並新增 `## 現況`；6d0d27c 修正 review-87b6cf6 的 M1、S1、N1～N10），共 17 個檔案、+453/−56，同時回頭檢查整體有沒有退步。Large／High，依 README `## Gate 豁免紀錄` 在本機獨立審查。
- Reviewed BASE SHA：2d23d1995831c820b6a7088f6654cb201e11de54
- Reviewed HEAD SHA：6d0d27cfa8f473597835d9f0333063d45161f62b
- Reviewed patch-id：3f939615dad5005d138a48bac0951b0f1702084a（已用 `git diff BASE HEAD | git patch-id --stable` 重算，結果相同）
- 獨立 reviewer：Claude（Opus 5.5）的隔離 subagent，與上一輪是同一位 reviewer，沒有參與實作。全程唯讀，暫時突變都已還原。
- Review artifact：docs/issues/issue-0030/review-6d0d27c.md

## 問題與風險

### MUST FIX
無。

### SHOULD FIX
無。

### NICE TO HAVE
- **N1'. 沿用入口時重送選單失敗，會連帶關掉原本可用的入口，而且選單不會還原。**
  - 位置：`src/services/panel-controller.ts:104-114`。
  - N2 的修正讓沿用路徑也呼叫 `menu.show`。只要這次 Telegram API 暫時失敗，catch 區塊就會作廢憑證、清空已發布狀態並停掉 Tunnel，原本能用的入口跟著被關。
  - catch 區塊不呼叫 `resetMenu()`，選單會留在已經失效的網址，直到下一次 `/panel` 成功。
  - 建議擇一：沿用路徑的 show 失敗時只記 runtime issue、不拆掉入口；或在 catch 區塊補呼叫一次 `resetMenu()`。不影響驗收。
- **N2'. `boot()` 遞增 `closes` 的那一行沒有測試守門。**
  - 位置：`panel-controller.ts:201`。
  - 拿掉這行後 19 支 controller 測試照樣全過。它守的是「開啟途中服務重新 boot」這種情況，目前只靠程式審閱確認。
  - 可以比照 close 補一支：start 進行中呼叫 `boot()`，斷言開啟結果失敗且沒有呼叫 show。
- **N3'. 計數器仍有一個很窄的殘餘時序：close 已經開始，之後才進來的 open 不會發現。**
  - 情境：`close()` 已遞增計數、正在等 `stop`，這時才到的 `/panel` 取到的快照已經是遞增後的值。如果新 Tunnel 在 close 的 `resetMenu()` 之前就緒並完成 show，選單最後會變成一般選單，但狀態仍是已開啟。
  - 這要求真實 Quick Tunnel 的就緒時間（實測約 7.4 秒）短於 terminate 的寬限（最多 3 秒），實務上不會發生。即使發生，下一次 `/panel` 走沿用路徑也會重送選單（N2）而恢復。
  - 同理，「開啟途中被關閉」的分支（`:95`）回傳失敗時沒有自己停 Tunnel，是靠 close 的 `stop` 收掉；只有在 stop 比 start 先送到 tunnel-manager 時才會留下孤兒 Tunnel，但 start 的請求一定先送出，實務上不成立。
  - 不需要處理；要再收斂的話，可以讓 open 先等進行中的 close，或在 `:95` 補一次 `client.stop()`。

## 已查核維度

- **驗收與證據**：
  - 上一輪各項的處理結果：
    - **M1 已解決**：`src/core/command-router.ts:56-58` 改成 `msg.telegram?.chatType !== 'private'`，沒有 `telegram` 欄位的訊息一律拒絕。上一輪我在 scratchpad 寫的 console 形狀測試，在新程式上也通過（`calls=[]`）。把條件還原成審查前的寫法，`tests/command-router-panel.test.ts` 的新測試會失敗 1 支。決策已記在 README `## 待確認事項`，選 (a)，不修訂規格。
    - **S1 已解決**：新增假 cloudflared 的 `slow-term` 模式。拿掉 `tunnel-manager.ts:107` 的 attempt 檢查後，新測試失敗 1 支。計畫第 162 行已更正原本的等價判定。
    - **N1**：拿掉 start 之後的比對、拿掉 show 之後的比對、show 之後不再還原選單，三種突變各失敗 1 支。
    - **N3**：拿掉 poll 在 await 之後的重新檢查，失敗 1 支。
    - **N9**：拿掉 `(?!api\.)`，失敗 1 支。
    - **N2、N4～N8、N10**：已審閱 diff 與實作者的紅燈紀錄。N4 新測試以自訂 staticDir 放隱藏檔、子目錄、`%2f`、大寫與 `.txt`，涵蓋上一輪指出的缺口。N5 只接受 413。N6 回應剛好是 `{ok:false,error:'unauthorized'}`，原因改用 `console.warn` 記錄。N7 的 session 路由已移除並有 404 測試。N8 新增共用的 `src/web/panel-paths.ts`。
  - 所有突變都以 `git diff --quiet` 確認已還原。
  - SCN-001～006 的責任 Task 與證據和上一輪相同，只有 SCN-005、SCN-002 的負向覆蓋補強了；核准的 Gherkin 沒有修改。
  - 交付檢查與測試數（L-01）：
    - `npm run test` exit 0，`# tests 957`、`# pass 957`。
    - 測試檔仍是 104 個。
    - 增加的 8 支是 router 1、controller 3、tunnel-manager 2、panel-api 2，與計畫的記錄一致。
    - `npm run lint` exit 0；`npx tsc --noEmit -p .` exit 0。

- **相關失敗面**：

| 輸入／狀態 | 預期 | 覆蓋 | 判定 |
|---|---|---|---|
| Web Console 送 `/panel`、`/panel_close`；telegram 平台但沒有 chatType | 拒絕，不呼叫 open／close | 新測試，突變驗證過 | 通過 |
| `/panel_close` 發生在 `client.start` 進行中 | 開啟失敗、不設選單、不算開啟 | 新測試，突變驗證過 | 通過 |
| `/panel_close` 發生在 `menu.show` 進行中 | 開啟失敗、選單最後是一般選單、之後的輪詢不誤報中斷 | 新測試（在 show 完成時才記錄呼叫），突變驗證過 | 通過 |
| `boot()` 與開啟交錯 | 開啟放棄 | 只有程式審閱 | 正確，缺守門測試（N2'） |
| 沿用入口，但選單被別處重設過 | 重送選單 | 改寫既有測試的期望呼叫順序 | 通過 |
| 沿用入口時重送選單失敗 | 不應拆掉可用的入口 | 無 | 入口被關閉，見 N1' |
| 狀態查詢進行中被關閉 | 不丟錯、不通知 | 新測試，突變驗證過 | 通過 |
| cloudflared 收到 SIGTERM 後還在收尾，健康檢查先回成功 | 不在停止後變成就緒 | 新測試，突變驗證過 | 通過 |
| 錯誤訊息含 `https://api.trycloudflare.com` | 不被當成 Tunnel 網址 | 新測試，突變驗證過 | 通過 |
| 登入失敗的回應內容 | 只回 unauthorized | `tests/web/panel-server.test.ts` | 通過 |
| 靜態檔的隱藏檔、子目錄、`%2f`、大寫、`.txt` | 404，讀不到內容 | `tests/web/panel-api.test.ts` | 通過 |
| 上一輪已通過的各失敗面（initData 邊界、公開面 404、憑證生命週期、設定寫入、閒置與寫入中、compose 邊界） | 不退步 | 全套 957 支通過；相關程式這輪沒動或只做常數抽取 | 通過 |

- **需求、架構、安全、品質**：
  - `closes` 計數器設計簡單，close 與 boot 共用，開啟流程在兩個 await 之後各比對一次，沒有引入新的阻塞或死鎖。
  - `resetMenu()` 抽成共用函式，沒有其他重複。
  - `panel-paths.ts` 讓三處共用路徑與服務名稱，消除了上一輪 N8 的重複。
  - 移除 session 路由後，公開面與安全文件列出的路由清單一致。
  - 常青文件：`docs/runtime-boundary-and-security.md` 補了「登入失敗不透露原因」；「只有私聊管理員能開 Tunnel」的說法現在與程式一致；`docs/configuration-reference.md` 的 `.env` 說明已更正。
  - L-10：新增的 diff 沒有本機路徑；以 `.env` 的 `ALLOWED_USER_ID`、`TELEGRAM_TOKEN` 實際值比對整段 BASE..HEAD，兩者都是 0 筆。

- **豁免、待確認與限制**：
  - Gate 豁免只有「不開 PR」一項，照舊。
  - `## 待確認事項` 新增兩條使用者決策（M1 選 (a)；S1 與 N1～N10 同一輪修正），與 coordinator 轉述的一致。
  - 39855b1 保存的 review-87b6cf6.md 與我上一輪交出的報告一致（標題、範圍、SHA、判定都相同）。
  - `## 現況` 放在 `## 目標` 之後。README 沒有 `## 概述`，`## 目標` 就是它的概述，位置可以接受。`**現行 review**` 目前指向 review-87b6cf6.md，保存本報告時要一併改成 review-6d0d27c.md。
  - 限制照舊揭露，不阻擋本次判定：
    - compose stack 內的容器連線沒有實測，由 Task 5.4 承擔。
    - 缺 `KILL` 的既有問題已另開 #31。
  - Task 5.4 是發版後的外部驗收窗，合併前不要求結果。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
