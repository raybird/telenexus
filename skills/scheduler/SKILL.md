---
name: scheduler
description: Manage scheduled tasks (cron jobs) for the Moltbot system.
---

# Scheduler Tool - 排程管理工具

### 概述

你可以透過執行 CLI 工具來管理使用者的排程任務。所有排程會持久化到 SQLite 資料庫，並在主程序中自動執行。

### 工具位置

```bash
node /app/dist/tools/scheduler-cli.js
```

### 可用指令

#### 1. 新增排程

```bash
node /app/dist/tools/scheduler-cli.js add <名稱> <Cron表達式> <提示詞>
```

**範例**：

```bash
node /app/dist/tools/scheduler-cli.js add "晨間報告" "0 9 * * *" "請生成今日市場分析報告"
```

**Cron 表達式格式**：

- `分 時 日 月 週`
- 範例：
  - `0 9 * * *` - 每天早上 9:00
  - `0 17 * * *` - 每天下午 5:00
  - `0 9,17 * * *` - 每天 9:00 和 17:00
  - `*/30 * * * *` - 每 30 分鐘

#### 2. 列出所有排程

```bash
node /app/dist/tools/scheduler-cli.js list
```

#### 3. 刪除排程

```bash
node /app/dist/tools/scheduler-cli.js remove <ID>
```

**範例**：

```bash
node /app/dist/tools/scheduler-cli.js remove 1
```

#### 4. 更新排程（名稱 / 時間 / Prompt）

```bash
node /app/dist/tools/scheduler-cli.js update <ID> <名稱> <Cron表達式> <提示詞>
```

**範例**：

```bash
node /app/dist/tools/scheduler-cli.js update 3 "BTC 六小時報告" "0 */6 * * *" "請提供 BTC 六小時市場分析，含重點與建議"
```

> 建議流程：先 `list` 找到 ID，再執行 `update`。

### 工作流程

1. 當使用者要求設定定時任務時，使用 `add` 指令建立排程
2. 當使用者要求修改既有排程時，使用 `update` 指令（避免 remove + add 造成 ID 變動）
3. 工具會自動將變更寫入資料庫
4. 工具會自動通知主程序 reload（優先 HTTP、失敗時 signal）
5. 主程序收到通知後會即時重載排程，無需重啟

### 注意事項

- 所有排程都會在主程序重啟後自動載入
- 如果主程序未執行，排程會在下次啟動時生效
- 使用者 ID 會自動從環境變數 `ALLOWED_USER_ID` 讀取
- 更新 cron 時，系統會重建該 ID 的 job，正常情況不會長期重複疊加
- 若更新瞬間剛好命中觸發點，舊規則可能多執行一次（短暫 race），後續會以新 cron 為準

### 使用範例

**情境：使用者說「我想要在早上8:00與下午5:00收到市場分析報告」**

你應該執行：

```bash
node /app/dist/tools/scheduler-cli.js add "早安市場分析" "0 8 * * *" "請分析今日市場動態並提供重點摘要"
node /app/dist/tools/scheduler-cli.js add "晚間市場分析" "0 17 * * *" "請分析今日市場動態並提供重點摘要"
```
