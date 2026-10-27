# 步驟 5：映像與 repo 設定（SCN-004）

- 日期：2026-10-27
- 改動：
  - `Dockerfile`：`npm install -g` 拿掉 `mcp-memory-libsql`；
  - `workspace/.opencode/opencode.json`：拿掉 `mcp` 區塊，只留 `$schema` 與 `model`；
  - `tests/docker/dockerfile-hygiene.test.ts`：新增靜態測試。
- 腳本：[scripts/probe-image.sh](scripts/probe-image.sh)，沿用步驟 1 的 [scripts/mock-upstream-ok.mjs](scripts/mock-upstream-ok.mjs)。

## 建置

```bash
docker build -t telenexus:issue-0022 .
```

不指定 target，所以取的是最後一個 stage，和 `release.yml`、`docker-compose.yml` 相同。結果 exit 0。

## 探測

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/docs/issues/issue-0022/evidence/scripts:/scripts:ro" \
  --entrypoint sh telenexus:issue-0022 /scripts/probe-image.sh
```

做法：

- 兩組的 workspace 都放**真正的舊設定**，也就是 v2.32.0 repo 裡的 `{"command":["npx","-y","mcp-memory-libsql"],"enabled":true,"environment":{"LIBSQL_URL":"file:../data/memory.db"}}`，不是步驟 1 的假 MCP。這樣看得到 npx 實際有沒有去取套件。
- 注入組的 `OPENCODE_CONFIG_CONTENT` 是在映像內 import 編譯後的 `/app/dist/core/opencode.js`，由 `OpencodeAgent.getEnv()` 實際組出來的，沒有手寫。
- 每組用獨立的 `HOME`，npx 有沒有取得套件，看該組 `~/.npm/_npx` 有沒有 `mcp-memory-libsql`。另外看 MCP 有沒有建立 `LIBSQL_URL` 指向的 `../data/memory.db`。
- 模型用容器內的假上游 `mock/ok`。參數和 TeleNexus 相同：`--format json --print-logs --log-level ERROR`，stdin 接 `/dev/null`。

結果：

```text
global mcp-memory-libsql: absent
injected mcp keys: mcp-memory-libsql,telenexus_browser {"type":"local","command":["mcp-memory-libsql"],"enabled":false}
1.18.34
== N inline=no
exit=0 text=["text":"OK" ] npx_cache_mcp_memory_libsql=1 memory_db_created=yes
stderr (前 5 行):
== I inline=yes
exit=0 text=["text":"OK" ] npx_cache_mcp_memory_libsql=0 memory_db_created=no
stderr (前 5 行):
== upstream requests: 4
```

## 判定

- **映像內查無套件**：`/usr/local/lib/node_modules/mcp-memory-libsql` 不存在。
- **對照組（N）會嘗試**：沒有注入時，舊設定讓 npx 從 npm 下載了 `mcp-memory-libsql`，啟動後也建立了 `memory.db`。這就是舊部署升級後、沒有這一版修正時會發生的事：每輪都要經過 npx。
- **注入組（I）不嘗試**：npx 快取裡沒有這個套件，也沒有建立 `memory.db`。`getEnv()` 組出的停用條目就是步驟 1 驗證過的完整條目，同時保留 `telenexus_browser`。
- **run 正常**：兩組都 exit 0，從假上游拿到 `OK`，stderr 是空的（沒有 ERROR log）。假上游共收到 4 個請求，每組 2 個。

## 靜態測試

`tests/docker/dockerfile-hygiene.test.ts` 新增 `issue 0022 SCN-004 映像與 repo 設定不再提供 mcp-memory-libsql`，檢查兩件事：
- `Dockerfile` 不含 `mcp-memory-libsql`；
- repo 的 `workspace/.opencode/opencode.json` 沒有這個 MCP 鍵。

建映像要好幾分鐘，所以由這條測試在每次 `npm run test` 守住回歸；映像行為由上面的探測證明。

| 情況 | 結果 |
|------|------|
| 綠燈 | `# tests 5`、`# pass 5`、`# fail 0` |
| 突變：`Dockerfile` 換回 HEAD 版（仍安裝套件） | `not ok 5 - issue 0022 SCN-004…`，`# fail 1` |
| 突變：`opencode.json` 換回 HEAD 版（仍有 `mcp` 區塊） | `not ok 5 - issue 0022 SCN-004…`，`# fail 1` |

突變後已還原。紅燈以這兩個突變代替：測試是在改動之後才寫的，換回改動前的檔案，就等於實作前的狀態。

## 其他檢查

`tests/docker/*.test.ts`、`tests/skill-browser-migration.test.ts`、`tests/opencode-browser-config.test.ts` 合跑（含 `compose-parity.test.ts`）：`# tests 28`、`# pass 28`、`# fail 0`。這時還沒加新的靜態測試。

## 精煉

改動是刪掉一個套件名稱與一個設定區塊，加上一條 8 行的測試，沒有可再簡化的部分，記為 no-op。
