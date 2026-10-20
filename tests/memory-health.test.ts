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

function withHealthEnv<T>(
  fn: (paths: { dbDir: string; memoriaHome: string; checkpointFile: string }) => T
): T {
  const prevDbDir = process.env.DB_DIR;
  const prevMemoriaHome = process.env.MEMORIA_HOME;
  const prevCheckpoint = process.env.MEMORY_BACKFILL_CHECKPOINT_FILE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-memory-health-test-'));
  const dbDir = path.join(tempDir, 'data');
  const memoriaHome = path.join(tempDir, 'Memoria');
  const checkpointFile = path.join(tempDir, 'memory-backfill-checkpoint.json');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(path.join(memoriaHome, '.memory'), { recursive: true });

  process.env.DB_DIR = dbDir;
  process.env.MEMORIA_HOME = memoriaHome;
  process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = checkpointFile;

  try {
    return fn({ dbDir, memoriaHome, checkpointFile });
  } finally {
    if (prevDbDir === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prevDbDir;
    if (prevMemoriaHome === undefined) delete process.env.MEMORIA_HOME;
    else process.env.MEMORIA_HOME = prevMemoriaHome;
    if (prevCheckpoint === undefined) delete process.env.MEMORY_BACKFILL_CHECKPOINT_FILE;
    else process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = prevCheckpoint;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('collectMemoryHealthReport reports cross-db consistency drift', () => {
  withHealthEnv(({ dbDir, memoriaHome, checkpointFile }) => {
    const operationalDb = new Database(path.join(dbDir, 'moltbot.db'));
    const retrievalDb = new Database(path.join(dbDir, 'memory.db'));
    const archiveDb = new Database(path.join(memoriaHome, '.memory', 'sessions.db'));

    try {
      operationalDb.exec(`
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, timestamp INTEGER);
        CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
      `);
      operationalDb
        .prepare(`INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)`)
        .run('model', 'hello', Date.now());

      retrievalDb.exec(`
        CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, entity_type TEXT, created_at TEXT);
        CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_name TEXT, content TEXT, created_at TEXT);
        CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, from_entity TEXT, relation_type TEXT, to_entity TEXT, created_at TEXT);
      `);
      retrievalDb
        .prepare(
          `INSERT INTO observations (entity_name, content, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
        )
        .run('Rule_user_1', 'valid observation [source_session=session-1] [confidence=0.82]');
      retrievalDb
        .prepare(
          `INSERT INTO observations (entity_name, content, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
        )
        .run(
          'Rule_user_2',
          'orphan observation [source_session=missing-session] [confidence=0.82]'
        );
      retrievalDb
        .prepare(
          `INSERT INTO observations (entity_name, content, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
        )
        .run('Rule_user_3', 'legacy observation without source tag');

      archiveDb.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, project TEXT, event_count INTEGER, summary TEXT, scope TEXT);
        CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, timestamp TEXT, event_type TEXT, content TEXT, metadata TEXT);
      `);
      archiveDb
        .prepare(
          `INSERT INTO sessions (id, timestamp, project, event_count, summary, scope) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('session-1', '2026-03-30T00:00:00.000Z', 'TeleNexus', 1, null, null);

      fs.writeFileSync(
        checkpointFile,
        JSON.stringify(
          {
            lastProcessedSessionId: 'missing-session',
            lastProcessedTimestamp: '2026-03-31T00:00:00.000Z'
          },
          null,
          2
        )
      );

      const report = collectMemoryHealthReport();
      assert.equal(report.consistency.sourceSessionTaggedObservations, 2);
      assert.equal(report.consistency.orphanSourceSessionObservations, 1);
      assert.equal(report.consistency.observationsMissingSourceSession, 1);
      assert.equal(report.consistency.checkpointSessionMissing, true);
      assert.equal(report.consistency.checkpointAheadOfArchive, true);
      assert.equal(report.consistency.ok, false);

      const markdown = formatMemoryHealthMarkdown(report);
      assert.match(markdown, /Consistency Orphan Observations: 1/);
      assert.match(markdown, /Consistency Checkpoint Session Missing: true/);
    } finally {
      operationalDb.close();
      retrievalDb.close();
      archiveDb.close();
    }
  });
});

test('一致性稽核以 LIKE 預篩後，結果與逐列 regex 掃描等價', () => {
  // 稽核每次 context snapshot 都會重算，改成先用 LIKE 篩掉不可能命中的列以免搬運整張表的內容。
  // LIKE 是 regex 命中的超集（兩者對 ASCII 都不分大小寫），這裡用邊界內容確認結論一致。
  withHealthEnv(({ dbDir, memoriaHome }) => {
    const retrievalDb = new Database(path.join(dbDir, 'memory.db'));
    retrievalDb.exec(`
      CREATE TABLE entities (id INTEGER PRIMARY KEY);
      CREATE TABLE relations (id INTEGER PRIMARY KEY);
      CREATE TABLE observations (id INTEGER PRIMARY KEY, content TEXT);
    `);
    const rows: Array<string | null> = [
      'plain text no marker',
      'tagged [source_session=abc123] tail',
      'UPPER [SOURCE_SESSION=Xyz789] tail',
      'empty marker [source_session=]',
      'unclosed [source_session=nobracket',
      'space inside [source_session=has space] tail',
      'two [source_session=first] and [source_session=second]',
      null,
      '',
      'bracket only [] nothing'
    ];
    const insert = retrievalDb.prepare('INSERT INTO observations (content) VALUES (?)');
    for (const row of rows) insert.run(row);
    retrievalDb.close();

    // archive 內只放其中一個 session id，讓 orphan 計數不為 0
    const archiveDb = new Database(path.join(memoriaHome, '.memory', 'sessions.db'));
    archiveDb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, timestamp TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY);
      INSERT INTO sessions (id, timestamp) VALUES ('abc123', '2026-08-13T00:00:00.000Z');
    `);
    archiveDb.close();

    const report = collectMemoryHealthReport();

    // 命中 regex 的：abc123 / Xyz789 / first（第 7 列只取第一個）
    assert.equal(report.consistency.sourceSessionTaggedObservations, 3);
    // 不含標記或標記不完整的其餘 7 列
    assert.equal(report.consistency.observationsMissingSourceSession, 7);
    // 三個命中裡只有 abc123 在 archive 內
    assert.equal(report.consistency.orphanSourceSessionObservations, 2);
  });
});

// ---- issue 0017：封存來源、讀取狀態與一致性的逐項判定 ----

const ARCHIVE_ENV_KEYS = [
  'DB_DIR',
  'MEMORIA_HOME',
  'MEMORIA_ARCHIVE_DB',
  'MEMORY_BACKFILL_CHECKPOINT_FILE',
  'MEMORIA_ENDPOINT'
] as const;

/**
 * 只設定 DB_DIR 與 checkpoint 路徑；封存相關變數由各測試決定，未列出的一律刪除，
 * 避免開發機上的 MEMORIA_HOME 讓「遠端模式」的測試讀到本機封存。
 */
async function withArchiveEnv<T>(
  vars: { MEMORIA_HOME?: string; MEMORIA_ARCHIVE_DB?: string; MEMORIA_ENDPOINT?: string },
  fn: (paths: { tempDir: string; dbDir: string; checkpointFile: string }) => T | Promise<T>
): Promise<T> {
  const previous = Object.fromEntries(ARCHIVE_ENV_KEYS.map((key) => [key, process.env[key]]));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-memory-health-0017-'));
  const dbDir = path.join(tempDir, 'data');
  const checkpointFile = path.join(tempDir, 'memory-backfill-checkpoint.json');
  fs.mkdirSync(dbDir, { recursive: true });
  for (const key of ARCHIVE_ENV_KEYS) delete process.env[key];
  process.env.DB_DIR = dbDir;
  process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = checkpointFile;
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn({ tempDir, dbDir, checkpointFile });
  } finally {
    for (const key of ARCHIVE_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeRetrievalDb(dbDir: string, observations: string[]): void {
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

function writeCheckpoint(checkpointFile: string): void {
  fs.writeFileSync(
    checkpointFile,
    JSON.stringify({
      lastProcessedSessionId: 'session-from-checkpoint',
      lastProcessedTimestamp: '2026-05-31T10:38:00.556Z'
    })
  );
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

test('AC-1：設定的封存路徑不存在時是 local／unavailable，並寫明找不到設定的路徑', async () => {
  await withArchiveEnv({}, async ({ tempDir }) => {
    process.env.MEMORIA_ARCHIVE_DB = path.join(tempDir, 'missing', 'sessions.db');

    const report = collectMemoryHealthReport();

    assert.equal(report.archive.source, 'local');
    assert.equal(report.archive.status, 'unavailable');
    assert.match(report.archive.detail ?? '', /MEMORIA_ARCHIVE_DB/);
    assert.equal(report.archive.totalSessions, null);
    assert.equal(report.archive.totalEvents, null);
    assert.equal(report.archive.estimatedGapRecent24h, null);
  });
});

test('AC-2：遠端模式的一致性三項都是 unsupported，ok 為 null 而不是 true', async () => {
  await withArchiveEnv({}, async ({ dbDir, checkpointFile }) => {
    writeRetrievalDb(dbDir, ['tagged [source_session=session-x]']);
    writeCheckpoint(checkpointFile);

    const report = collectMemoryHealthReport();

    assert.deepEqual(report.consistency.checks, {
      orphanSourceSession: 'unsupported',
      checkpointSession: 'unsupported',
      checkpointAhead: 'unsupported'
    });
    assert.equal(report.consistency.orphanSourceSessionObservations, null);
    assert.equal(report.consistency.checkpointSessionMissing, null);
    assert.equal(report.consistency.checkpointAheadOfArchive, null);
    assert.equal(report.consistency.ok, null);
    // 只依賴本機檢索資料庫的兩項照常計算
    assert.equal(report.consistency.sourceSessionTaggedObservations, 1);
    assert.equal(report.consistency.observationsMissingSourceSession, 0);

    const markdown = formatMemoryHealthMarkdown(report);
    assert.match(markdown, /- Consistency OK: unknown\n/);
    assert.match(markdown, /- Consistency Orphan Observations: unknown\n/);
    assert.match(markdown, /- Consistency Check Orphan Source Session: unsupported\n/);
  });
});

test('AC-3：空的本機封存照樣檢查，空封存裡的無效引用與 checkpoint 都會被發現', async () => {
  await withArchiveEnv({}, async ({ tempDir, dbDir, checkpointFile }) => {
    const archivePath = path.join(tempDir, 'archive', 'sessions.db');
    writeArchiveDb(archivePath, []);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    writeRetrievalDb(dbDir, ['tagged [source_session=session-x]', 'plain text']);
    writeCheckpoint(checkpointFile);

    const report = collectMemoryHealthReport();

    assert.equal(report.archive.source, 'local');
    assert.equal(report.archive.status, 'ok');
    assert.equal(report.archive.detail, null);
    assert.equal(report.archive.totalSessions, 0);
    assert.equal(report.archive.totalEvents, 0);
    assert.equal(report.archive.lastSessionAt, null);
    assert.deepEqual(report.consistency.checks, {
      orphanSourceSession: 'checked',
      checkpointSession: 'checked',
      checkpointAhead: 'checked'
    });
    assert.equal(report.consistency.orphanSourceSessionObservations, 1);
    assert.equal(report.consistency.checkpointSessionMissing, true);
    assert.equal(report.consistency.checkpointAheadOfArchive, true);
    assert.equal(report.consistency.ok, false);
  });
});

test('AC-4：沒有 checkpoint 時兩項 checkpoint 檢查是 skipped，其餘通過即 ok=true', async () => {
  await withArchiveEnv({}, async ({ tempDir, dbDir }) => {
    const archivePath = path.join(tempDir, 'archive', 'sessions.db');
    writeArchiveDb(archivePath, [{ id: 'session-1', timestamp: '2026-10-01T00:00:00.000Z' }]);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    writeRetrievalDb(dbDir, ['tagged [source_session=session-1]']);

    const report = collectMemoryHealthReport();

    assert.deepEqual(report.consistency.checks, {
      orphanSourceSession: 'checked',
      checkpointSession: 'skipped',
      checkpointAhead: 'skipped'
    });
    assert.equal(report.consistency.orphanSourceSessionObservations, 0);
    assert.equal(report.consistency.checkpointSessionMissing, false);
    assert.equal(report.consistency.checkpointAheadOfArchive, false);
    assert.equal(report.consistency.ok, true);
    assert.match(
      formatMemoryHealthMarkdown(report),
      /- Consistency Check Checkpoint Session: skipped\n/
    );
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
    await withArchiveEnv({}, async ({ tempDir, dbDir, checkpointFile }) => {
      const archivePath = path.join(tempDir, 'archive.db');
      prepare(archivePath);
      process.env.MEMORIA_ARCHIVE_DB = archivePath;
      writeRetrievalDb(dbDir, ['tagged [source_session=session-x]']);
      writeCheckpoint(checkpointFile);
      const issuesBefore = getRecentIssues().length;

      const report = collectMemoryHealthReport();

      assert.equal(report.archive.source, 'local');
      assert.equal(report.archive.status, 'error');
      assert.ok((report.archive.detail ?? '').length > 0);
      assert.equal(report.archive.totalSessions, null);
      assert.equal(report.archive.totalEvents, null);
      assert.equal(report.archive.estimatedGapRecent24h, null);
      assert.deepEqual(report.consistency.checks, {
        orphanSourceSession: 'error',
        checkpointSession: 'error',
        checkpointAhead: 'error'
      });
      assert.equal(report.consistency.ok, null);
      assert.equal(getRecentIssues().length, issuesBefore);
    });
  });
}
