# 步驟 2：映像釘版安裝 Moli（SCN-007）

- **日期**：2026-11-12
- **被測工作區**：`feat/issue-0024-moli-web-reading`，基於 `632fef5`，未提交的 `Dockerfile` 與 `tests/docker/moli-install.test.ts`
- **變更**：`Dockerfile` 的 `base` stage 在 Chrome 安裝之後加一條 RUN，下載 v1.1.23 的 x86_64 tarball，以 sha256 驗證後解開到 `/opt/telenexus/moli`。Moli 不放進 PATH。wrapper 的 COPY 留到步驟 3：wrapper 那時才存在，現在加會讓建置失敗。

## 紅燈

`npx tsx --test tests/docker/moli-install.test.ts`，改 Dockerfile 之前執行：exit 1，2 個測試中 1 個失敗（[step2-red.log](step2-red.log)）。

- 失敗的是「base stage 以固定版本的 release tarball 安裝 Moli，並在同一條 RUN 驗 sha256」：安裝 Moli 的 RUN 有 0 條，預期 1 條。這正是缺少的目標行為。
- 「不用 latest 或 curl | sh」在這時沒有可檢查的行，所以是空轉通過；它擋不擋得住，由下面的突變 M1、M5 證明。

## 綠燈

改 Dockerfile 後執行 `npx tsx --test` 跑 `moli-install`、`browser-install`、`dockerfile-hygiene`、`compose-parity`：exit 0，9/9 通過（[step2-green.log](step2-green.log)）。既有的 Chrome 安裝、預設建置目標、build args 位置、compose parity 都不受影響。

## 突變

每次只對 Dockerfile 套用一個突變，跑 `moli-install.test.ts`，跑完還原（[step2-mutations.log](step2-mutations.log)）：

| 突變 | 結果 |
|------|------|
| M1 下載網址改成 `releases/latest` | 2 個都失敗 |
| M2 拿掉 `sha256sum -c` | 1 個失敗 |
| M3 雜湊改錯一碼 | 1 個失敗 |
| M4 先解開 tarball 再驗雜湊 | 1 個失敗 |
| M5 另外加一條 `curl … moli-installer.sh \| sh` | 2 個都失敗 |
| M6 把安裝移到 dev stage | 1 個失敗 |

## 實際建置

在 repo 根目錄執行 `docker build --target dev -t telenexus:issue24-dev .` 和 `docker build -t telenexus:issue24 .`：兩者都是 exit 0，log 裡有 `/tmp/moli.tar.gz: OK`（[step2-images.log](step2-images.log)）。

| 映像 | `moli --version`（node 使用者） | 執行檔 | PATH |
|------|-------------------------------|--------|------|
| `telenexus:issue24-dev` | `moli 1.1.23`，exit 0 | `root:root 755`，111,579,728 bytes | 不在 PATH |
| `telenexus:issue24`（正式 stage） | `moli 1.1.23`，exit 0 | 同上 | 不在 PATH |

## 雜湊不符時建置失敗

把 Dockerfile 的雜湊最後一碼由 `0` 改成 `1`，另存到 scratchpad，以 `--target base` 建置：exit 1，`sha256sum: WARNING: 1 computed checksum did NOT match`、`/tmp/moli.tar.gz: FAILED`，沒有產生映像（[step2-badsha.log](step2-badsha.log)）。repo 的 Dockerfile 沒有改動。

## 未涵蓋

- arm64 映像：不在範圍內（README「不在範圍內」）；`release.yml` 只建 linux/amd64。
