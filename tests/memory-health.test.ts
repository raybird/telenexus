import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  collectMemoryHealthReport,
  formatMemoryHealthMarkdown
} from '../src/services/memory-health.js';
import { getRecentIssues } from '../src/utils/errors.js';

// ---- issue 0017：封存來源與讀取狀態的判定 ----

const ARCHIVE_ENV_KEYS = [
  'DB_DIR',
  'MEMORIA_HOME',
  'MEMORIA_ARCHIVE_DB',
  'MEMORIA_ENDPOINT'
] as const;

/**
 * 只設定 DB_DIR；封存相關變數由各測試決定，未列出的一律刪除，
 * 避免開發機上的 MEMORIA_HOME 讓「遠端模式」的測試讀到本機封存。
 */
async function withArchiveEnv<T>(
  vars: { MEMORIA_HOME?: string; MEMORIA_ARCHIVE_DB?: string; MEMORIA_ENDPOINT?: string },
  fn: (paths: { tempDir: string; dbDir: string }) => T | Promise<T>
): Promise<T> {
  const previous = Object.fromEntries(ARCHIVE_ENV_KEYS.map((key) => [key, process.env[key]]));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-memory-health-0017-'));
  const dbDir = path.join(tempDir, 'data');
  fs.mkdirSync(dbDir, { recursive: true });
  for (const key of ARCHIVE_ENV_KEYS) delete process.env[key];
  process.env.DB_DIR = dbDir;
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn({ tempDir, dbDir });
  } finally {
    for (const key of ARCHIVE_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeLegacyMemoryDb(dbDir: string, observations: string[]): void {
  const db = new Database(path.join(dbDir, 'memory.db'));
  try {
    db.exec(`
      CREATE TABLE entities (id INTEGER PRIMARY KEY);
      CREATE TABLE relations (id INTEGER PRIMARY KEY);
      CREATE TABLE observations (id INTEGER PRIMARY KEY, content TEXT);
    `);
    const insert = db.prepare('INSERT INTO observations (content) VALUES (?)');
    for (const content of observations) insert.run(content);
  } finally {
    db.close();
  }
}

function writeOperationalDbWithRecentModelReply(dbDir: string): void {
  const db = new Database(path.join(dbDir, 'moltbot.db'));
  try {
    db.exec(`
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, timestamp INTEGER);
      CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    `);
    db.prepare('INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)').run(
      'model',
      'hello',
      Date.now()
    );
  } finally {
    db.close();
  }
}

function writeArchiveDb(archivePath: string, sessions: Array<{ id: string; timestamp: string }>) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const db = new Database(archivePath);
  try {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT);
    `);
    const insert = db.prepare('INSERT INTO sessions (id, timestamp) VALUES (?, ?)');
    for (const session of sessions) insert.run(session.id, session.timestamp);
  } finally {
    db.close();
  }
}

test('AC-1：遠端模式把讀不到的封存統計標為 unavailable 與 null，不發出網路請求', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    await withArchiveEnv({ MEMORIA_ENDPOINT: `http://127.0.0.1:${port}` }, async ({ dbDir }) => {
      writeOperationalDbWithRecentModelReply(dbDir);

      const report = collectMemoryHealthReport();
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(report.archive.source, 'remote');
      assert.equal(report.archive.status, 'unavailable');
      assert.equal(typeof report.archive.detail, 'string');
      assert.equal(report.archive.exists, false);
      assert.equal(report.archive.totalSessions, null);
      assert.equal(report.archive.totalEvents, null);
      assert.equal(report.archive.sessions24h, null);
      assert.equal(report.archive.lastSessionAt, null);
      // 近 24h 有 1 則模型回應；舊版會把它算成 1 的假缺口
      assert.equal(report.operational.modelResponses24h, 1);
      assert.equal(report.archive.estimatedGapRecent24h, null);
      assert.equal(requests, 0);

      const markdown = formatMemoryHealthMarkdown(report);
      assert.match(markdown, /- Archive Source: remote\n/);
      assert.match(markdown, /- Archive Status: unavailable\n/);
      assert.match(markdown, /- Archive Detail: \S/);
      assert.match(markdown, /- Archive Total Sessions: unknown\n/);
      assert.match(markdown, /- Archive Total Events: unknown\n/);
      assert.match(markdown, /- Archive Sessions 24h: unknown\n/);
      assert.match(markdown, /- Archive Estimated Gap Recent 24h: unknown\n/);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const envKey of ['MEMORIA_ARCHIVE_DB', 'MEMORIA_HOME'] as const) {
  test(`AC-1：${envKey} 設定的封存路徑不存在時是 local／unavailable，並寫明找不到設定的路徑`, async () => {
    await withArchiveEnv({}, async ({ tempDir }) => {
      process.env[envKey] =
        envKey === 'MEMORIA_ARCHIVE_DB'
          ? path.join(tempDir, 'missing', 'sessions.db')
          : path.join(tempDir, 'missing-home');

      const report = collectMemoryHealthReport();

      assert.equal(report.archive.source, 'local');
      assert.equal(report.archive.status, 'unavailable');
      assert.match(report.archive.detail ?? '', new RegExp(envKey));
      assert.equal(report.archive.exists, false);
      assert.equal(report.archive.totalSessions, null);
      assert.equal(report.archive.totalEvents, null);
      assert.equal(report.archive.sessions24h, null);
      assert.equal(report.archive.lastSessionAt, null);
      assert.equal(report.archive.estimatedGapRecent24h, null);

      const markdown = formatMemoryHealthMarkdown(report);
      assert.match(markdown, /- Archive Source: local\n/);
      assert.match(markdown, /- Archive Status: unavailable\n/);
      assert.match(markdown, /- Archive Total Sessions: unknown\n/);
      assert.match(markdown, /- Archive Last Session At: unknown\n/);
    });
  });
}

test('AC-3：空的本機封存照樣讀取，統計是 0 而不是 null', async () => {
  await withArchiveEnv({}, async ({ tempDir }) => {
    const archivePath = path.join(tempDir, 'archive', 'sessions.db');
    writeArchiveDb(archivePath, []);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;

    const report = collectMemoryHealthReport();

    assert.equal(report.archive.source, 'local');
    assert.equal(report.archive.status, 'ok');
    assert.equal(report.archive.detail, null);
    assert.equal(report.archive.totalSessions, 0);
    assert.equal(report.archive.totalEvents, 0);
    assert.equal(report.archive.lastSessionAt, null);
  });
});

for (const [label, prepare] of [
  [
    '內容不是 SQLite',
    (archivePath: string) => fs.writeFileSync(archivePath, 'this is not a sqlite database')
  ],
  [
    '缺少 sessions 表',
    (archivePath: string) => {
      const db = new Database(archivePath);
      db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
      db.close();
    }
  ]
] as const) {
  test(`AC-5：本機封存讀不了（${label}）時報告照樣產生並標 error，不記 runtime issue`, async () => {
    await withArchiveEnv({}, async ({ tempDir }) => {
      const archivePath = path.join(tempDir, 'archive.db');
      prepare(archivePath);
      process.env.MEMORIA_ARCHIVE_DB = archivePath;
      const issuesBefore = getRecentIssues().length;

      const report = collectMemoryHealthReport();

      assert.equal(report.archive.source, 'local');
      assert.equal(report.archive.status, 'error');
      assert.ok((report.archive.detail ?? '').length > 0);
      assert.equal(report.archive.totalSessions, null);
      assert.equal(report.archive.totalEvents, null);
      assert.equal(report.archive.estimatedGapRecent24h, null);
      assert.equal(getRecentIssues().length, issuesBefore);
    });
  });
}

// ---- issue 0018：本機資料庫沒讀到時照樣產生報告 ----

function writeNotSqlite(file: string): void {
  fs.writeFileSync(file, 'this is not a sqlite database, just text '.repeat(40));
}

function writeLocalArchive(tempDir: string): string {
  const archivePath = path.join(tempDir, 'archive', 'sessions.db');
  writeArchiveDb(archivePath, [
    { id: 'session-from-checkpoint', timestamp: '2026-05-31T10:38:00.556Z' }
  ]);
  process.env.MEMORIA_ARCHIVE_DB = archivePath;
  return archivePath;
}

/** 所有 scope 的 runtime issue 次數總和；dedupe 命中只會加 count，所以要加總 count，不能只數筆數 */
function runtimeIssueCount(): number {
  return getRecentIssues().reduce((sum, issue) => sum + issue.count, 0);
}

test('AC-1：運作資料庫不存在時是 unavailable，數字為 null，不 throw', async () => {
  await withArchiveEnv({}, async () => {
    const report = collectMemoryHealthReport();

    assert.equal(report.operational.status, 'unavailable');
    assert.match(report.operational.detail ?? '', /moltbot\.db/);
    assert.equal(report.operational.exists, false);
    assert.equal(report.operational.totalMessages, null);
    assert.equal(report.operational.totalSchedules, null);
    assert.equal(report.operational.lastMessageAt, null);
    assert.equal(report.operational.modelResponses24h, null);

    const markdown = formatMemoryHealthMarkdown(report);
    assert.match(markdown, /- Operational Status: unavailable\n/);
    assert.match(markdown, /- Operational Detail: \S/);
    assert.match(markdown, /- Operational Total Messages: unknown\n/);
    assert.match(markdown, /- Operational Total Schedules: unknown\n/);
    assert.match(markdown, /- Operational Last Message At: unknown\n/);
    assert.match(markdown, /- Operational Model Responses 24h: unknown\n/);
  });
});

for (const [label, prepare] of [
  ['不是 SQLite 檔', (file: string) => writeNotSqlite(file)],
  ['缺少資料表', (file: string) => new Database(file).close()]
] as const) {
  test(`AC-1／AC-2：運作資料庫${label}時是 error，數字與推算的缺口都是 null，不記 runtime issue`, async () => {
    await withArchiveEnv({}, async ({ tempDir, dbDir }) => {
      writeLocalArchive(tempDir);
      prepare(path.join(dbDir, 'moltbot.db'));
      const issuesBefore = runtimeIssueCount();

      const report = collectMemoryHealthReport();

      assert.equal(report.operational.status, 'error');
      assert.equal(report.operational.exists, true);
      assert.ok(report.operational.detail);
      assert.equal(report.operational.totalMessages, null);
      assert.equal(report.operational.modelResponses24h, null);
      assert.equal(report.archive.status, 'ok');
      assert.equal(report.archive.sessions24h, 0);
      assert.equal(report.archive.estimatedGapRecent24h, null);
      assert.equal(runtimeIssueCount(), issuesBefore);

      const markdown = formatMemoryHealthMarkdown(report);
      assert.match(markdown, /- Operational Status: error\n/);
      assert.match(markdown, /- Archive Estimated Gap Recent 24h: unknown\n/);
    });
  });
}

test('AC-1：運作資料庫可讀時狀態是 ok、detail 為 null', async () => {
  await withArchiveEnv({}, async ({ dbDir }) => {
    writeOperationalDbWithRecentModelReply(dbDir);

    const report = collectMemoryHealthReport();

    assert.equal(report.operational.status, 'ok');
    assert.equal(report.operational.detail, null);
    assert.equal(report.operational.totalMessages, 1);

    const markdown = formatMemoryHealthMarkdown(report);
    assert.match(markdown, /- Operational Status: ok\n/);
    assert.match(markdown, /- Operational Detail: \(none\)\n/);
  });
});

// issue 0022：memory.db 這條路退役，健康報告只留運作資料庫與封存
const REPORT_MARKDOWN_KEYS = [
  'Updated',
  'Archive Enabled',
  'Archive Source',
  'Archive Status',
  'Archive Detail',
  'Archive DB Exists',
  'Archive Total Sessions',
  'Archive Total Events',
  'Archive Last Session At',
  'Archive Sessions 24h',
  'Archive Sync Failures 24h',
  'Archive Estimated Gap Recent 24h',
  'Operational DB Exists',
  'Operational Status',
  'Operational Detail',
  'Operational Total Messages',
  'Operational Total Schedules',
  'Operational Last Message At',
  'Operational Model Responses 24h',
  'operational_db',
  'archive_db'
];

test('issue 0022 SCN-007 健康報告只有運作資料庫與封存，memory.db 存在時不讀也不改', async () => {
  await withArchiveEnv({}, async ({ tempDir, dbDir }) => {
    writeLocalArchive(tempDir);
    writeOperationalDbWithRecentModelReply(dbDir);
    const legacyFile = path.join(dbDir, 'memory.db');
    writeLegacyMemoryDb(dbDir, ['tagged [source_session=s1]']);
    const before = fs.statSync(legacyFile);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const report = collectMemoryHealthReport();
    const markdown = formatMemoryHealthMarkdown(report);

    assert.deepEqual(Object.keys(report).sort(), [
      'archive',
      'generatedAt',
      'ok',
      'operational',
      'paths',
      'timestamp'
    ]);
    assert.deepEqual(Object.keys(report.paths).sort(), ['archiveDb', 'operationalDb']);
    const keys = markdown
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2, line.indexOf(':')));
    assert.deepEqual(keys, REPORT_MARKDOWN_KEYS);
    assert.match(markdown, /^## Paths$/m);
    // 運作資料庫與封存照常判定
    assert.equal(report.operational.status, 'ok');
    assert.equal(report.archive.status, 'ok');
    assert.equal(report.archive.totalSessions, 1);

    const after = fs.statSync(legacyFile);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });
});
