# 審查報告
- 範圍：完整 diff（本機流程，無 PR），`git diff 79b081d 2eafbb6`，6 個提交（f1f8336、17b4cb3、933f5ce、eb9cc0b、dffa5b4、2eafbb6）。這一輪重點看增量 `git diff dffa5b4 2eafbb6`：8 個檔案，+129／−6。
- Reviewed BASE SHA：79b081d3087c0ad5aceec40a3803aa8de730754b
- Reviewed HEAD SHA：2eafbb6168b93a71962693021cad812c82088c6d
- Reviewed patch-id：2820c77ff53d4a1c5ed6f0212644b678bc8da443
- 獨立 reviewer：Claude（Opus 5.5）隔離 subagent，不是實作者，和第一輪（[review-eb9cc0b.md](review-eb9cc0b.md)）是同一個 reviewer。全程只讀，沒有修改、提交或推送，也沒有呼叫 Telegram 或任何外部服務。
- Review artifact：docs/issues/issue-0028/review-2eafbb6.md
- 核准基線：17b4cb300ab264023e5386671d2fa45d0df0c367
  - 推導命令在 2eafbb6 上重跑，結果仍是 17b4cb3。README 的 `**核准 commit**` 已回填 17b4cb3，兩者一致。
  - `git diff 17b4cb3 2eafbb6 -- docs/issues/issue-0028/README.md` 只動了記帳區段：`## 現況` 新增 `**現行 review**`、核准 commit 的值、Timeline 一列、`**狀態**`。Gherkin、核准來源與核准表都沒有變。

## 問題與風險
### MUST FIX
無

### SHOULD FIX
無。第一輪的 SHOULD FIX 1 已解決，見下方「增量修正的查核」。

### NICE TO HAVE
第一輪的 NICE TO HAVE 1～3 已處理。4～8 這輪不在修正範圍，仍然適用，照列：

4. **SCN-002 與 SCN-005 字面上衝突**
   - 只有一個 step 但含 think 結束標籤時，實作照 SCN-005 摺疊（`tests/opencode-reply-parts.test.ts:164`），與 SCN-002「只有一個 step 就與變更前逐字相同」的字面不符。
   - 建議在 README 或 plan 註明 think 推理文字優先於 SCN-002。
5. **「過程」的定義和實作不一致**
   - `src/core/reply-parts.ts:58` 把最後一個 step 以外的所有 step 都當成過程，不論結束原因。
   - 程式註解（`reply-parts.ts:6`）、CLAUDE.md、ARCHITECTURE.md 都寫「以 tool-calls 結束的 step」。
   - 實際影響很小。建議把措辭改成符合實作，或改成只收 tool-calls 的 step。
6. **SCN-007 的測試比計畫少**
   - 計畫步驟 3 寫「逾時／限流／上游錯誤各一例」，實際只有上游錯誤一例。
   - 逾時、限流、中止三種在結構上不會帶 `replyParts`（都經 `buildTextOnlyStructuredResult()`），所以目前沒有風險。
   - 建議修正計畫的描述，或補測試。
7. **`cleanOutput` 的垃圾偵測逐段做，可能和全文判斷不一致**
   - 垃圾偵測是指大量 `</function>` 時換成警示句。逐段判斷時，可能全文被換成警示句、但摺疊版面照常顯示內容，或反過來。
   - 極少見，可接受。
8. **小幅精煉**
   - `folded-reply.ts` 的 fence 型別寫了兩次。
   - `sendFoldedReply` 的 options 型別分別寫在 `types/index.ts` 和 `telegram.ts`。
   - `reply-parts.ts` 開頭的說明註解放在 `type StepText` 上方，不在它說明的 class 上方。

## 已查核維度

### 增量修正的查核

**SHOULD FIX 1：結論只剩前綴時不摺疊**
- 位置：`src/core/message-pipeline-chat.ts:134` 改用 `hasVisibleText(conclusion)`。
- 實測：
  - 結論只剩 `[Opencode]`，或前綴後只有空白和換行：回 undefined，照舊送全文。
  - `[Opencode] ok`：照常摺疊。
- 其他漏網情況：
  - 結論只有 think 標籤：`StepTextCollector.build()` 的 `tidy` 已先把標籤去掉，`replyParts` 不會成立，到不了這裡。
  - 排程：不經 `toFoldedReply`，結論一定非空（build 先檢查過，前綴之後才加），而且排程原本就不移除標記，行為和變更前一樣。
  - 串流和非串流共用同一個 `toFoldedReply`。
- 新測試：`tests/message-pipeline.test.ts` 的兩支「SCN-003：結論只有 SEND_FILE／MEMORY_INTENT 時不摺疊」。
- 變異：把判斷改回 `!conclusion`，26 支中 2 支失敗，和實作者記錄的紅燈一致。

**NICE 1：過程裡的引言攤平，不送 `>>`**
- 位置：`src/telegram/render/folded-reply.ts` 的 `quote()`。程式碼區塊外、以 `>` 開頭的渲染行原樣保留，其他行前面加 `>`。
- 為什麼程式碼區塊外的 `>` 一定是引言：渲染器會把一般文字裡的 `>` 跳脫成 `\>`，所以這種行只會來自 blockquote。
- 實測的情況：
  - 多行引言、巢狀引言、引言內的清單：都攤平成一層，字詞都在。
  - 清單項目裡的程式碼區塊、`~~~` fence、表格（渲染成程式碼區塊）：渲染器都把 fence 輸出在行首，`inCode` 追蹤正確，程式碼裡的 `> 1` 送出時是 `>> 1`。
  - 程式碼裡含 ```` ``` ```` 字面：渲染器會跳脫成 `` \`\`\` ``，不會誤切換 `inCode`。
  - 700 行以 `>` 開頭的超長程式碼區塊：切成 3 則過程，每則 fence 成對，內容行都帶 `>` 前綴。
- 跨段追蹤：每段各自渲染、fence 成對，`splitSegment` 切開時也會補上結尾 fence，所以 `inCode` 跨段追蹤不會錯位。
- 實機：`evidence/review-fix-samples.ts` 是合成樣本，計畫記錄 2 則 ok=true，使用者在手機上確認，`>> 1` 顯示為 `> 1`。
- 已知差異：引言內的空行在攤平後消失，這是 #27 渲染器原本的行為，不丟字詞。
- 變異：
  - 拿掉攤平：新測試失敗。
  - 拿掉 fence 追蹤：同一支測試失敗，期望值裡有 `>> prompt`。

**NICE 2：回合停在 tool-calls step 時沒有 `replyParts`**
- 新測試：`tests/opencode-reply-parts.test.ts` 的 StepTextCollector 單元測試。
- 變異：把 `last.reason === 'tool-calls'` 拿掉，10 支中 1 支失敗。上一輪這個變異沒被抓到，現在抓得到。

**NICE 3：串流摺疊版面帶 `messageThreadId`**
- 新測試：pipeline 串流測試斷言 `foldedThreadIds` 為 `[42]`。
- 變異：拿掉 renderer 摺疊路徑的 `messageThreadId`，26 支中 1 支失敗。上一輪這個變異沒被抓到，現在抓得到。

所有變異都用 `git checkout --` 還原，結束時 `git status` 乾淨。

### 驗收與證據
第一輪對 SCN-001～SCN-012 的結論仍然成立：
- 2eafbb6 之前，`src/` 只有 `message-pipeline-chat.ts` 和 `folded-reply.ts` 兩處改動，其餘程式碼與 eb9cc0b 相同。
- 第一輪引用的測試全部仍然通過。
- SCN-003 多了「結論只剩標記」與「停在 tool-calls step」兩種覆蓋。
- SCN-004 與 SCN-006 的組版測試在 `quote()` 修改後全部通過。
- 計畫記錄步驟 4 的語料檢查重跑後不變（缺字詞 0、超長 0、引言不完整 0）。reviewer 手上沒有快照，沒辦法自己重跑。
- SCN-010 原本的 7 則樣本都不含引言，`quote()` 的修改不影響它們的輸出。新增的寫法另有 review-fix 的 2 則實機樣本。

### 相關失敗面

| 情況 | 判定 |
|---|---|
| 結論只剩標記或空白 | 通過 |
| 過程含引言、巢狀引言、引言內清單 | 通過 |
| 程式碼區塊（行首、清單內、`~~~`、表格、含字面 ```` ``` ````、超長切段）內以 `>` 開頭的行 | 通過 |
| 論壇主題的 thread id | 通過 |
| 停在 tool-calls step | 通過 |
| 其餘失敗面（串流與非串流、runner 與本機、think、降級結果、4096 切段、純文字退回、非 Telegram 連接器、passthrough、Web Console） | 沿用第一輪結論，程式未改 |

### 需求、架構、安全、品質
- 修正都在原本的模組內完成，沒有新的抽象層。
- `quote()` 多出 9 行，邏輯集中在一個地方。
- 新證據檔是合成內容，沒有 token、聊天 ID 或正式回覆原文（L-10）。以 grep 找 token 樣式與長數字 ID，沒有命中。
- 變更的 src、tests 與證據檔都通過 `prettier --check`。

### 執行結果
| 命令 | 結果 |
|---|---|
| `npm run build` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test` | exit 0，`# tests 818`、`# pass 818`、`# fail 0` |

測試數比第一輪的 813 多 5 支，正好是這次新增的 5 支。測試檔仍是 94 個，數量相符（L-01）。

### 豁免、待確認與限制
- 沒有 Gate 豁免；TBD-1～4 都已解決。
- 限制：
  - reviewer 不能呼叫 Telegram，`>> 1` 被接受這件事以計畫記錄的實機結果和使用者確認為準。
  - 步驟 4 語料重跑的結果，以計畫記錄為準。

## 流程判定
PASS

PASS 只適用於上列 Reviewed HEAD SHA。之後在這個分支提交 issue README 記帳區段與本報告以外的檔案（例如交接文件），PASS 會失效、需要重新審查（流程契約 2.3 以下只有單獨新增本報告的提交可沿用）；提交前先告知使用者，由使用者決定做法。
