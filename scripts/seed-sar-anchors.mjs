import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

function resolveDbPath() {
  const explicitPath = process.env.DB_PATH?.trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const dbDir = process.env.DB_DIR?.trim();
  if (dbDir) {
    return path.resolve(dbDir, 'moltbot.db');
  }

  return path.resolve(process.cwd(), 'moltbot.db');
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run')
  };
}

const CANONICAL_ANCHORS = [
  {
    key: 'gemini-recovery',
    tags: ['gemini', 'runner', 'memory', 'infra'],
    timestamp: Date.parse('2026-03-18T09:30:00Z'),
    summary:
      'Goal: 穩定 Gemini 對話與 runner 執行路徑.\nDecision: 將 Gemini 故障分流為兩類: 1) 壓縮簽名錯誤 (INVALID_ARGUMENT / ChatCompressionService.compress) 先執行 /compress; 若仍失敗再考慮 /new. 2) 容量不足 (RESOURCE_EXHAUSTED / MODEL_CAPACITY_EXHAUSTED) 不靠 /new 解決, 應等待重試或 fallback model/provider.\nTodo: 持續分類 compression 與 capacity 失敗, 並優先保留 runner 路徑觀測.\nFacts: agent-runner 有正常收到請求; /compress 可修復壞掉的 Gemini session; preview model 容易遇到 RESOURCE_EXHAUSTED.'
  },
  {
    key: 'web-chat-history',
    tags: ['web', 'memory'],
    timestamp: Date.parse('2026-03-18T09:31:00Z'),
    summary:
      'Goal: 改善 Web chat 歷史上滑載入體驗.\nDecision: 採用 cursor-based loading, incremental prepend 與 top-anchor scroll preserve; 避免 offset pagination 與全量 re-render 造成閃爍與跳位.\nTodo: 持續觀察極長對話下的 DOM 成本, 必要時再進一步導入 windowing.\nFacts: chat history 載入改為 beforeTimestamp 游標; 上滑載入僅增量插入舊訊息; 保留原本靠近頂部才觸發載入的策略, 避免一路預抓到最舊日期.'
  },
  {
    key: 'release-workflow',
    tags: ['release', 'memory'],
    timestamp: Date.parse('2026-03-18T09:32:00Z'),
    summary:
      'Goal: 固化 TeleNexus 的 release SOP.\nDecision: 使用 command workflow: npm run release:patch -- -m <commit message>, 流程固定為 commit > npm version > tag > push.\nTodo: 發版時保留本地 ai-config.yaml 與 workspace 測試檔不入版.\nFacts: release-workflow 腳本已自動檢查 staged changes, 建立 commit, 執行 npm version, 推送 branch 與 tags.'
  }
];

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = resolveDbPath();
  const userId = process.env.WEB_USER_ID || process.env.ALLOWED_USER_ID;
  if (!userId) {
    throw new Error('Missing WEB_USER_ID or ALLOWED_USER_ID');
  }

  const db = new Database(dbPath);
  const selectStmt = db.prepare(
    'SELECT id FROM messages WHERE user_id = ? AND role = ? AND summary = ? LIMIT 1'
  );
  const insertStmt = db.prepare(
    'INSERT INTO messages (user_id, role, content, summary, impact_level, tags, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertFtsStmt = db.prepare(
    'INSERT INTO messages_fts (rowid, user_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
  );

  let inserted = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const anchor of CANONICAL_ANCHORS) {
      const existing = selectStmt.get(userId, 'model', anchor.summary);
      if (existing) {
        skipped += 1;
        continue;
      }

      inserted += 1;
      if (options.dryRun) {
        continue;
      }

      const info = insertStmt.run(
        userId,
        'model',
        anchor.summary,
        anchor.summary,
        3,
        JSON.stringify(anchor.tags),
        anchor.timestamp
      );
      insertFtsStmt.run(info.lastInsertRowid, userId, 'model', anchor.summary, anchor.timestamp);
    }
  });

  tx();

  console.log(`DB: ${dbPath}`);
  console.log(`Mode: ${options.dryRun ? 'dry-run' : 'write'}`);
  console.log(`Inserted: ${inserted}`);
  console.log(`Skipped existing: ${skipped}`);
}

main();
