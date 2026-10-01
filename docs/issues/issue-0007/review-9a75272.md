# 審查報告

- 範圍：完整交付範圍（本機流程，未開 PR），第 2 輪
- Reviewed BASE SHA：79fd6cd63dd0730a296e345a91febaca72730b6b
- Reviewed HEAD SHA：9a752724f3c09aaf547173a91164afa272a22e34
- Reviewed patch-id：7e9dcada5468d8b2183a8377948bd3dc85a832bb（自行以 `git diff BASE HEAD | git patch-id --stable` 複核，相符）
- 獨立 reviewer：與實作者隔離的 subagent（Claude）。只依新範圍的 diff、提交歷史、映像與證據檔判斷，未修改任何檔案；審查後工作區仍為 clean、HEAD 未變。
- Review artifact：docs/issues/issue-0007/review-9a75272.md

## 問題與風險

### MUST FIX

無。

### SHOULD FIX

無。

### NICE TO HAVE

- **中間提交仍留有正式部署的完整容器 ID**：`evidence/step4-live.txt` 在 b2afd49、e6b9797、1d275ff、c519737 四筆提交中各有 6 個 64 碼容器 ID，9a75272 才截短。容器 ID 是本機隨機識別碼，敏感度低，不阻塞；若要歷史也乾淨，推送前可一併改寫。
- **守門測試會把正式 stage 的 `npm install -g` 誤判成安裝 devDependencies**：`tests/docker/dockerfile-hygiene.test.ts:40` 的 `npm\s+(?:install|i|add)\b` 不分全域與否。我拿 79fd6cd 的 Dockerfile 去跑就得到這個訊息。這是偏嚴的誤報，不是繞過；之後若有人在正式 stage 加全域工具，訊息會誤導，可排除 `-g`。
- **`Dockerfile:97` 的註解與實際行為有落差**：註解寫「不依賴從 base 繼承」，但 `telenexus:dev` 的 history 顯示 dev stage 沒宣告 ARG，RUN 仍帶 `|2 APP_GIT_SHA=…`，BuildKit 實際上會繼承。重複宣告無害，註解可改成「明確宣告」。
- **舊 SHA 之後只能靠對照表**：計畫與證據檔仍引用 083e133、cd12dc7、e2b6016、0b96860、cb92e18、60f845f。`refs/original/` 清掉後這些 SHA 會無法解析，對照表在 `implementation-plan.md:167-174`，已足夠。

## 已查核維度

### 第一輪問題的處理

| 編號                    | 結論               | 我的驗證                                                                                                                                                                                   |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 本機絕對路徑         | 已解決             | 逐筆檢查範圍內 10 筆提交的樹、patch 與提交訊息，並掃過 `79fd6cd..9a75272` 可達的所有 blob。唯一命中是第一輪報告 `review-60f845f.md:18` 中已遮蔽帳號的 `/home/<帳號>/…`。分支仍無遠端參照。 |
| M2 ARG 快取語意         | 已解決             | 見下方「M2 的獨立佐證」。                                                                                                                                                                  |
| S1 守門可繞過           | 已解決             | 小寫 `from`、行首空白的 `FROM`、`npm install --include=dev`、`pnpm install`、結尾追加 dev 的 CMD，我的變異全部紅燈。                                                                       |
| S2 dev 無 `/app/dist`   | 只補文件，理由成立 | 讓 dev 映像帶 dist 是新行為，超出核准範圍。限制已寫進 `README.md:159`、`CLAUDE.md`、`docker-compose.dev.yml:9-10`、`docs/agents/project.md:31`；README 的「環境相同」改為「工具鏈相同」。  |
| S3 runtime 邊界文件過時 | 已解決             | `docs/runtime-boundary-and-security.md:166-171` 的新敘述與合併後的 compose 設定相符：兩種模式的 `security_opt`、`cap_drop`、`cap_add` 相同。                                               |
| S4 CONTRIBUTING         | 已解決             | `CONTRIBUTING.md:11-15` 先列 `npm run docker:dev`，主機 `npm run dev` 為替代。                                                                                                             |

**M2 的獨立佐證**

- `Dockerfile:28-29` 把兩個 ARG 放在 `base` 的第一個 RUN 之前，`:98-99` 在正式 stage 再宣告一次。
- 帶不同 `APP_BUILD_TIME` 的兩個探針映像，各層建立時間與實作者的說法一致：
  - `argprobe-prefix`（修正前）：apt 層建於 11:55:13，其餘 base 層建於 12:07，都是沿用快取；只有最後 stage 在 12:34 重建。
  - `argprobe-fixed`（修正後）：apt 層建於 12:35:38 並帶 `APP_BUILD_TIME=issue7-probe-b`，base 每層都重新執行。
- `:after` 的 apt 層與 `:before` 是同一個快取層（都建於 11:51:44），表示修正後 base 的前綴與重排前的快取鍵相同。
- 帶 ARG 的 RUN 指令集合，`:before` 與 `:after` 相同，共 8 個。
- 新增的 ARG 守門：拿掉 base 的 ARG、移到 RUN 之後、只留一個、註解掉、RUN 排到 ARG 之前、base 改名，都紅燈。修正前的 Dockerfile（e6b9797）只紅這一項，與 `return1-arg-guard-red.txt` 一致。

未採納的兩項（兩份相同的基準檔各留一份、`docker-compose.yml` 的 healthcheck 寫死 3030 另行處理）都屬建議層級或既有問題，理由可接受。

### 提交改寫與核准可追溯性

- **改寫範圍**：6 組舊新提交逐對比對，每一對只差 `evidence/step1-guard-test-red.txt` 的 2 行，提交訊息相同，父提交鏈正確接到 f863d1a。
- **核准 commit**：f863d1a 仍是 HEAD 的祖先。
- **Gherkin**：f863d1a 與 9a75272 的 Gherkin 區塊逐字相同。
- **issue README 的其他變動**：核准 commit 回填、TBD-1、Gate 豁免、狀態，以及涉及檔案清單新增兩份文件並標明「審查退回後加入」。都沒有動到驗收的條件、動作、結果。
- **第一輪報告**：以 1d275ff 單獨提交，只新增該檔。它是 RETURN 報告，不涉及 PASS 的有效性規則。

### 驗收與證據

| SCN     | 證據位置                                                                                                         | 結論                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| SCN-001 | `evidence/step4-live.txt`、`evidence/return1-dev-runner-recheck.txt`、`evidence/step4-test-override.example.yml` | 通過，附已揭露的限制（見下）。                                                                                       |
| SCN-002 | 同上，加對照組 `evidence/step4-control.txt`                                                                      | 通過，對照組與反向自檢仍成立。                                                                                       |
| SCN-003 | `evidence/image-baseline-before.txt`、`image-baseline-after.txt`、`return1-build-arg-scope.txt`                  | 通過。我重新擷取 `:before` 與 `:after`，都與已提交的基準檔逐位元相同，兩者互相也相同；基準不含任何 devDependencies。 |
| SCN-004 | `README.md:149-165`、`CLAUDE.md:12-15` 與其後兩段、`evidence/return1-docs-and-host-checks.txt`                   | 通過。Docker 指令在前，token、Web 埠與 409 的說明仍在，新增的限制敘述與實際行為一致。                                |
| SCN-005 | `evidence/return1-docs-and-host-checks.txt:22-39`                                                                | 通過。我自行重跑，結果見下方命令清單。                                                                               |

**步驟 4 在修正前的 dev 映像上實測，是可接受且已揭露的限制，不是驗收缺口。** 理由：

- 修正只在 `base` 多兩行 ARG，ARG 不會寫進映像。
- 我用基準腳本比對了步驟 4 當時的 dev 映像（`sha256:5178ce2f…`，本機仍在）與修正後的 `telenexus:dev`：設定、`/home/node` 清單、`/app` 檔案與雜湊、`npm ls --all`、`.bin`、全域套件、工具版本全部相同（diff 為空）。腳本在 dev 映像上會停在最後的 stat，系統套件清單沒有比到。
- telenexus 與 agent-runner 用同一個映像，修正後 agent-runner 已重驗 healthy、`tsx watch` 與熱重載。
- 實作者在 `implementation-plan.md` 的「修正後的證據」明寫 telenexus 未在修正後映像上重啟。

### 相關失敗面

| 輸入／狀態                                                                                  | 預期                            | 覆蓋                                                          | 判定             |
| ------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------- | ---------------- |
| dev stage 排到最後（含小寫、行首空白、改名）                                                | 守門紅燈                        | 變異全紅                                                      | 通過             |
| 發版時 `APP_BUILD_TIME` 每次不同，且有 GHA 快取                                             | 與重排前相同，從 apt 起每層重建 | 探針映像的層時間；ARG 守門測試                                | 通過             |
| 正式 stage 裝進 devDependencies（`npm ci`、`npm install`、`pnpm install`、`--include=dev`） | 守門紅燈                        | 變異全紅                                                      | 通過             |
| 正式 stage 的有效 CMD 被後面的 CMD 蓋掉                                                     | 守門紅燈                        | 變異紅                                                        | 通過             |
| 正式 stage 改為 `FROM dev`                                                                  | 不出貨 devDependencies          | 守門為綠；`npm ci --omit=dev` 會重建 `node_modules`，實際無害 | 可接受           |
| 只用 `docker-compose.yml`                                                                   | 無 target、映像名與指令照舊     | 我以 `config` 複核                                            | 通過             |
| dev 映像被拿去跑正式設定                                                                    | 不會                            | dev 另名 `telenexus:dev`                                      | 通過             |
| 正式與 release compose 的一致性；dev 檔進 bundle                                            | 不變、不進                      | parity 測試為綠；不可觸及檔案與 `src/` 對 BASE 零變更         | 通過             |
| 兩個部署共用 token                                                                          | 文件警示                        | 多份文件都有；`project.md:33` 補回現況                        | 通過（文件層級） |
| 在 dev stack 觸發排程或記憶 skill                                                           | 失敗，但有揭露                  | 已寫進多份文件                                                | 已揭露的限制     |

### 需求、架構、安全、品質

- **範圍**：變更檔都在涉及檔案清單（含退回後新增的兩份文件）或 issue 目錄內，沒有超出核准範圍的行為變更。
- **正確性**：修正後 Dockerfile 的正式 stage 與重排前等價，映像內容與快取語意都已驗證。dev compose 這一輪只多註解，合併設定與第一輪相同。
- **安全與隱私**：diff 無 token、無使用者 ID；HEAD 無本機帳號路徑、無 64 碼容器 ID。dev 的容器權限與正式相同，只多四個唯讀掛載。
- **品質**：
  - `stages()` 輔助函式由兩個測試共用，沒有重複邏輯。
  - ARG 在 `base` 與正式 stage 各宣告一次，是刻意的明確寫法。
  - 新增的 5 份 `return1-*` 證據各有對應問題，沒有過度設計。

### 豁免、待確認與限制

- **Gate 豁免**：仍只有「建立 PR」，獨立審查未豁免。
- **TBD-1**：狀態「不影響本次交付」。殘餘事項是獨立的開發用 bot 尚未建立，在這台機器直接跑 `npm run docker:dev` 會讓正式 bot 收到 409。
- **已揭露的測試限制**：
  - 字面的 `npm run docker:dev` 沒有端到端跑過。
  - 實測用了 override，把 data 與 workspace 指到暫存目錄，並關閉釘選訊息與模型健康檢查。
  - 沒有實際對話、沒有觸發 opencode。
  - telenexus 未在修正後的 dev 映像上重啟。
- **我未驗證的項目**：
  - 步驟 4 與修正後的 agent-runner 重驗（不得啟動服務，僅審閱證據，並以映像內容比對佐證）。
  - 核准對話原文（GitHub issue #7 的存在已於第一輪確認）。
- **第一輪敘述的精確化**：我第一輪說 BASE 中「這類路徑出現 0 次」，指的是該本機帳號名。BASE 的 `docs/migration-log.md:1027` 本來就有一筆以公開身分為帳號名的同型路徑，所以目錄結構不是新資訊，M1 的問題在帳號名，現已不存在。

### 我實際執行過的命令與結果

- `git diff BASE HEAD | git patch-id --stable`：相符。`git merge-base --is-ancestor f863d1a HEAD`：成立。
- 逐筆提交的 `git grep`、`git show` 與可達 blob 掃描：無本機帳號路徑。
- 6 組改寫前後的 `git diff --numstat`：每組 1 個檔、2 行。
- `npm run build`：exit 0。`npm run lint`：exit 0。
- `npm run test`：exit 0，284 個測試、46 個檔、fail 0。
- `npm run test:installer`：exit 0。
- `npx tsx --test tests/docker/*.test.ts`：5 個全過。
- `capture-image-baseline.sh`：`:before`、`:after` 各一次，另對三個 dev 映像各一次。
- `docker image inspect` 與 `docker history`：六個映像加步驟 4 當時的 dev 映像。
- 守門測試變異 17 組，在 repo 外的暫存複本上執行。
- `docker compose … config --format json`（只擷取非機密欄位）：合併與僅正式兩種。
- `npx prettier --check`：變更的 Markdown 全數通過。

## 流程判定

PASS — 第一輪兩項 MUST FIX 都已解決並經我獨立驗證，四項 SHOULD FIX 處理到位或理由成立，五項 SCN 都有有效證據，剩下的只有已揭露的限制與建議層級事項。此判定綁定 9a75272；本報告需以「只新增 `docs/issues/issue-0007/review-9a75272.md`」的單一後繼提交保存後才算完成持久化。
