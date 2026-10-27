# 步驟 1：注入停用在 `opencode run` 的行為（SCN-001、SCN-002）

- 日期：2026-10-27
- 映像：`ghcr.io/raybird/telenexus:v2.32.0`（opencode 1.18.34）
- 腳本：[scripts/probe.sh](scripts/probe.sh)、[scripts/fake-mcp.mjs](scripts/fake-mcp.mjs)、[scripts/mock-upstream-ok.mjs](scripts/mock-upstream-ok.mjs)
- 命令（repo 根目錄）：

  ```bash
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$PWD/docs/issues/issue-0022/evidence/scripts:/scripts:ro" \
    --entrypoint sh ghcr.io/raybird/telenexus:v2.32.0 /scripts/probe.sh
  ```

## 做法

- **舊設定**：每組有自己的 workspace，`.opencode/opencode.json` 的鍵名和舊部署相同（`mcp-memory-libsql`），只是 `command` 換成假 MCP。假 MCP 被啟動時會在該組的 `markers/` 寫一個標記檔，所以標記檔有沒有出現，就代表 opencode 有沒有啟動這個 MCP。真正的舊設定是 `npx -y mcp-memory-libsql`；合併與啟動的判斷看的是鍵名與 `enabled`，跟指令是什麼無關。
- **模型**：用容器內的假上游（OpenAI 相容，一律回 `OK`）掛成 `mock/ok`，讓 `run` 能正常完成。
- **另一個 MCP**：注入的設定另外帶一個 `other` 假 MCP，用來確認停用條目不會影響其他 MCP。
- **執行方式**：`opencode run --format json --print-logs --log-level ERROR`，參數和 TeleNexus 相同；stdin 接 `/dev/null`（L-12）。

| 組 | workspace 舊設定 | `OPENCODE_CONFIG_CONTENT` 的 `mcp-memory-libsql` |
|----|------------------|--------------------------------------------------|
| A（對照組） | 有 | 不注入 |
| B | 有 | `{"enabled":false}` |
| C | 無 | `{"enabled":false}` |
| D | 有 | `{"type":"local","command":["mcp-memory-libsql"],"enabled":false}` |
| E | 無 | 同 D |

## 結果

```text
1.18.34
== A legacy=yes inline=no
exit=0 text=["text":"OK" ] error_events=0
markers:       1 libsql
stderr (前 5 行):
== B legacy=yes inline=yes
exit=0 text=["text":"OK" ] error_events=0
markers:       1 other
stderr (前 5 行):
== C legacy=no inline=yes
exit=0 text=["text":"OK" ] error_events=0
markers:       1 other
stderr (前 5 行):
timestamp=2026-10-27T07:18:49.918Z level=ERROR run=111800dd message="Ignoring MCP config entry without type" key=mcp-memory-libsql
== D legacy=yes inline=yes
exit=0 text=["text":"OK" ] error_events=0
markers:       1 other
stderr (前 5 行):
== E legacy=no inline=yes
exit=0 text=["text":"OK" ] error_events=0
markers:       1 other
stderr (前 5 行):
== upstream requests: 10
```

## 判定

- **對照組成立**：A 有 `libsql` 標記，代表沒有注入時舊設定確實會啟動 MCP，而標記檔抓得到這件事。
- **停用有效**：B、D 都沒有 `libsql` 標記，只有 `other`。
- **其他 MCP 照常**：B～E 都有 `other` 標記。
- **run 正常**：五組都 exit 0，從假上游拿到 `OK`，`error` 事件 0 個。假上游共收到 10 個請求，每組 2 個（標題與回覆）。
- **只有 `enabled` 的條目在新部署會留下錯誤 log**：C 的 stderr 有一行 `level=ERROR … "Ignoring MCP config entry without type"`。run 沒有失敗，但每輪都會多一行 ERROR log，不符合「沒有設定錯誤」的完成判準。
- **完整條目在新舊部署都乾淨**：D 的完整條目和舊設定合併後是停用的；E 沒有舊設定時，stderr 沒有任何訊息。

結論：探測成立，但注入的內容改成完整條目（D、E），不用只有 `enabled` 的條目。`command` 寫 `mcp-memory-libsql`，因為條目是停用的，所以不會被執行。設計的調整記在[實作計畫](../implementation-plan.md)。這不改變任何 Scenario 的行為：SCN-001 停用舊設定，SCN-002 沒有設定錯誤，兩者都由 D、E 證明。
