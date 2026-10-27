# 步驟 2：注入停用條目（SCN-001、SCN-002、SCN-003）

- 日期：2026-10-27
- 改動：`src/core/opencode.ts` 的 `OpencodeAgent.getEnv()`，以及 `tests/opencode-browser-config.test.ts`

## 影響分析

- `gitnexus_impact(getEnv, upstream)`：risk CRITICAL，直接呼叫者 1 個（`executeChatProcess`），影響 5 個流程：`runChatStructured`、`executeLocal`、`executeTaskStream`、`executeTask`、`executeChatProcess`。聊天與排程的每一輪都經過這裡，這也是步驟 1 先做契約探測的原因。
- `grep -rn "getEnv()" src tests`：
  - `src/core/opencode.ts:368`：非串流；
  - `src/core/cli-agent-base.ts:186`：串流，呼叫的是同一個覆寫；
  - 測試的 `ConfigAgent`。
  - 和 impact 一致，沒有其他呼叫點。

## 測試契約的變更

`SCN-006 同名自訂 browser 設定保持原樣，不覆寫或重複註冊` 原本斷言 `OPENCODE_CONFIG_CONTENT` 整串等於使用者原文。issue 0022 SCN-003（2026-10-27 核准）改變了這個行為：使用者自訂 `telenexus_browser` 時，仍然要加上停用條目。所以這條斷言改成四項：
- browser 條目和使用者原文相同；
- `mcp` 只有 browser 與停用條目兩個鍵，沒有重複註冊；
- 停用條目的 `enabled` 是 `false`；
- 不額外帶 `TELENEXUS_BROWSER_AUDIT_FILE`。

其他既有斷言沒有拿掉。兩個「真 OpencodeAgent 子程序」測試各加一條斷言：子程序收到的設定有停用條目。

## 紅燈（最小實作前）

`env -u MEMORIA_HOME -u MEMORIA_ARCHIVE_DB npx tsx --test tests/opencode-browser-config.test.ts`，exit 1：

```text
ok 1 - SCN-002 子程序設定加入固定、工作專屬 browser MCP，不改父程序環境
ok 2 - SCN-006 合併 JSONC inline 設定，保留 provider、memory、自訂 MCP 與工具權限
not ok 3 - SCN-002 non-stream 真 OpencodeAgent 子程序收到 browser 設定
not ok 4 - SCN-002 stream 真 OpencodeAgent 子程序收到 browser 設定
not ok 5 - SCN-006 同名自訂 browser 設定保持原樣，不覆寫或重複註冊
not ok 6 - issue 0022 SCN-001/002 預設注入完整的 mcp-memory-libsql 停用條目
ok 7 - issue 0022 SCN-003 使用者自訂的 mcp-memory-libsql 原樣保留
ok 8 - 無效 inline 設定如實失敗，不靜默丟失原設定或印出內容
# tests 8
# pass 4
# fail 4
```

- 3、4：子程序收到的 `mcp-memory-libsql.enabled` 是 `undefined`，預期 `false`。
- 5：`mcp` 的鍵少了 `mcp-memory-libsql`。
- 6：停用條目是 `undefined`。

四個失敗都是因為缺少停用條目，也就是目標行為。7 在實作前就是綠的：還沒有注入時，本來就不會覆寫使用者設定。它要擋的是「覆寫使用者設定」的回歸，由下面的突變證明。

這一層是單元測試，只看 TeleNexus 組出的設定。opencode 實際怎麼合併、會不會啟動 MCP，由步驟 1 的契約探測負責；兩層各管不同的失敗面，所以保留雙迴圈。

## 綠燈（最小實作後）

同一命令，exit 0：`# tests 8`、`# pass 8`、`# fail 0`。

## 突變

| 突變 | 結果 |
|------|------|
| 拿掉注入（實作前的程式） | 3、4、5、6 轉紅（即上面的紅燈） |
| 永遠覆寫使用者設定：把 `Object.hasOwn(mcp, LEGACY_MEMORY_MCP)` 的判斷換成 `false` | `not ok 7 - issue 0022 SCN-003 使用者自訂的 mcp-memory-libsql 原樣保留`，`# fail 1` |

突變後已還原檔案。

## 其他檢查

- `npm run build`：exit 0。
- `npx eslint src/core/opencode.ts`：0 error。測試檔不在 eslint 的範圍內，會印出 ignored warning。
- `npx prettier --check`：兩個檔都通過。

## 精煉

改動只有一個常數，以及 `getEnv()` 裡的一段合併。兩條回傳路徑共用 `withLegacyMemoryDisabled`，沒有可再簡化的重複，記為 no-op，沿用上面的綠燈。
