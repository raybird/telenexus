# 步驟 1：.dockerignore 限縮 workspace（SCN-010）

- **日期**：2026-11-12
- **被測**：`feat/issue-0025-skill-harvest`（從 760775b 分出），未提交的 `.dockerignore` 與 `tests/docker/dockerignore-workspace.test.ts`
- **探針**：只做 `COPY workspace` 的最小 Dockerfile，在工作目錄建置（建置內容套用 repo 的 `.dockerignore`），列出映像裡的檔案：

```dockerfile
FROM busybox:1.36
COPY workspace /w
RUN find /w \( -type f -o -type l \) | sort > /list.txt; wc -l < /list.txt; du -sh /w | cut -f1
CMD ["cat","/list.txt"]
```

命令：`docker build -q -f probe.Dockerfile -t tn25-probe . && docker run --rm tn25-probe`

## 紅燈：改動前

建置內容的 `workspace/` 有 **6,587 個檔案**。檔案最多的前幾個目錄：`Memoria/node_modules`（3,315）、`.pnpm-store/v10`（1,277）、`.opencode/node_modules`（783）、`projects/` 底下的開發專案、`.opencode/skills`（143，同步出來的技能與 agent 做的技能）。

靜態規則測試 `npx tsx --test tests/docker/dockerignore-workspace.test.ts`：exit 1，因為「要有 workspace/** 排除規則」不成立（[step1-static-red.log](step1-static-red.log)）。

## 綠燈：改動後

探針輸出正好是 4 個檔案：

```text
/w/.gitignore
/w/.opencode/opencode.json
/w/.opencode/skills/.gitkeep
/w/projects/.gitkeep
```

靜態規則測試 exit 0（[step1-static-green.log](step1-static-green.log)）。

## 對照

| 情況 | 結果 |
|------|------|
| 拿掉 `!workspace/.opencode/opencode.json` | 探針少了 `opencode.json`，只剩 3 個檔案；靜態測試 1 個失敗。跑完以 `cmp` 確認還原 |
| 乾淨 checkout（`git stash create` 的工作樹快照經 `git archive` 解開後建置，等同 CI） | 與工作目錄建置的結果完全相同 |
| 正式 Dockerfile 從工作目錄完整建置（`docker build -t telenexus:issue25 .`） | exit 0；`/app/workspace` 只有同樣 4 個檔案，40K |

## 限制

- 探針與完整建置都是 Docker 28.1.1 的 BuildKit。舊版的 legacy builder 對「排除目錄後再放行其中檔案」的處理沒有實測。release.yml 用的是 `docker/build-push-action`，也是 BuildKit。
