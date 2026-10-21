import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  assessBackfillSource,
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
  const prevArchiveDb = process.env.MEMORIA_ARCHIVE_DB;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-memory-health-test-'));
  const dbDir = path.join(tempDir, 'data');
  const memoriaHome = path.join(tempDir, 'Memoria');
  const checkpointFile = path.join(tempDir, 'memory-backfill-checkpoint.json');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(path.join(memoriaHome, '.memory'), { recursive: true });

  process.env.DB_DIR = dbDir;
  process.env.MEMORIA_HOME = memoriaHome;
  process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = checkpointFile;
  // MEMORIA_ARCHIVE_DB 優先於 MEMORIA_HOME，主機 shell 有設時會讓這裡的封存被忽略
  delete process.env.MEMORIA_ARCHIVE_DB;

  try {
    return fn({ dbDir, memoriaHome, checkpointFile });
  } finally {
    if (prevDbDir === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prevDbDir;
    if (prevMemoriaHome === undefined) delete process.env.MEMORIA_HOME;
    else process.env.MEMORIA_HOME = prevMemoriaHome;
    if (prevCheckpoint === undefined) delete process.env.MEMORY_BACKFILL_CHECKPOINT_FILE;
    else process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = prevCheckpoint;
    if (prevArchiveDb === undefined) delete process.env.MEMORIA_ARCHIVE_DB;
    else process.env.MEMORIA_ARCHIVE_DB = prevArchiveDb;
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
  'MEMORIA_ENDPOINT',
  // issue 0016 AC-3 斷言 backfill.enabled=false，主機有設時會影響結果
  'MEMORY_BACKFILL_ENABLED'
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

test('AC-2／AC-4：遠端模式且沒有 checkpoint（官方 Compose 預設）時，checkpoint 兩項是 skipped，ok 仍為 null', async () => {
  await withArchiveEnv({}, async ({ dbDir }) => {
    writeRetrievalDb(dbDir, ['tagged [source_session=session-x]']);

    const report = collectMemoryHealthReport();

    assert.deepEqual(report.consistency.checks, {
      orphanSourceSession: 'unsupported',
      checkpointSession: 'skipped',
      checkpointAhead: 'skipped'
    });
    assert.equal(report.consistency.orphanSourceSessionObservations, null);
    assert.equal(report.consistency.checkpointSessionMissing, false);
    assert.equal(report.consistency.checkpointAheadOfArchive, false);
    // orphan 沒檢查到，所以整體仍是未知，不會因為 checkpoint 兩項 skipped 就變成 true
    assert.equal(report.consistency.ok, null);
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

// issue 0016：回填來源的共用判定
const CHECKPOINT_TIMESTAMP = '2026-05-31T10:38:00.556Z';

test('issue 0016 AC-1：回填來源判定分成六種狀態，各附原因', async () => {
  await withArchiveEnv({}, () => {
    const assessment = assessBackfillSource();
    assert.equal(assessment.source, 'remote');
    assert.equal(assessment.state, 'remote-unsupported');
    assert.match(assessment.detail, /遠端/);
  });

  await withArchiveEnv({}, ({ tempDir }) => {
    const missing = path.join(tempDir, 'missing', 'sessions.db');
    process.env.MEMORIA_ARCHIVE_DB = missing;
    const assessment = assessBackfillSource();
    assert.equal(assessment.source, 'local');
    assert.equal(assessment.state, 'unavailable');
    assert.match(assessment.detail, /MEMORIA_ARCHIVE_DB/);
    assert.ok(assessment.detail.includes(missing), assessment.detail);
  });

  await withArchiveEnv({}, ({ tempDir }) => {
    const archivePath = path.join(tempDir, 'sessions.db');
    fs.writeFileSync(archivePath, 'not a sqlite database');
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    const assessment = assessBackfillSource();
    assert.equal(assessment.state, 'error');
    assert.match(assessment.detail, /file is not a database/);
  });

  await withArchiveEnv({}, ({ tempDir, checkpointFile }) => {
    const archivePath = path.join(tempDir, 'sessions.db');
    writeArchiveDb(archivePath, []);
    writeCheckpoint(checkpointFile);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    const assessment = assessBackfillSource();
    assert.equal(assessment.state, 'empty');
  });

  await withArchiveEnv({}, ({ tempDir, checkpointFile }) => {
    const archivePath = path.join(tempDir, 'sessions.db');
    writeArchiveDb(archivePath, [{ id: 'session-old', timestamp: CHECKPOINT_TIMESTAMP }]);
    writeCheckpoint(checkpointFile);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    const assessment = assessBackfillSource();
    assert.equal(assessment.state, 'up-to-date');
    assert.ok(assessment.detail.includes(CHECKPOINT_TIMESTAMP), assessment.detail);
  });

  await withArchiveEnv({}, ({ tempDir, checkpointFile }) => {
    const archivePath = path.join(tempDir, 'sessions.db');
    writeArchiveDb(archivePath, [{ id: 'session-new', timestamp: '2026-10-03T04:02:40.861Z' }]);
    writeCheckpoint(checkpointFile);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    const assessment = assessBackfillSource();
    assert.equal(assessment.state, 'pending');
  });

  await withArchiveEnv({}, ({ tempDir }) => {
    const archivePath = path.join(tempDir, 'sessions.db');
    writeArchiveDb(archivePath, [{ id: 'session-new', timestamp: '2026-10-03T04:02:40.861Z' }]);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    const assessment = assessBackfillSource();
    assert.equal(assessment.state, 'pending');
    assert.match(assessment.detail, /checkpoint/);
  });
});

test('issue 0016 AC-3：健康報告的 backfill 區塊列出來源狀態與原因，回填沒啟用也顯示', async () => {
  await withArchiveEnv({}, ({ dbDir }) => {
    writeRetrievalDb(dbDir, []);
    const report = collectMemoryHealthReport();
    assert.equal(report.backfill.enabled, false);
    assert.equal(report.backfill.sourceState, 'remote-unsupported');
    assert.match(report.backfill.sourceDetail, /遠端/);

    const markdown = formatMemoryHealthMarkdown(report);
    assert.match(markdown, /^- Backfill Source State: remote-unsupported$/m);
    assert.ok(
      markdown.includes(`- Backfill Source Detail: ${report.backfill.sourceDetail}`),
      markdown
    );
  });

  await withArchiveEnv({}, ({ tempDir, dbDir, checkpointFile }) => {
    writeRetrievalDb(dbDir, []);
    const archivePath = path.join(tempDir, 'sessions.db');
    writeArchiveDb(archivePath, [{ id: 'session-new', timestamp: '2026-10-03T04:02:40.861Z' }]);
    writeCheckpoint(checkpointFile);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    const report = collectMemoryHealthReport();
    assert.equal(report.backfill.sourceState, 'pending');
    assert.match(formatMemoryHealthMarkdown(report), /^- Backfill Source State: pending$/m);
  });
});

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
  await withArchiveEnv({}, async ({ dbDir }) => {
    writeRetrievalDb(dbDir, []);

    const report = collectMemoryHealthReport();

    assert.equal(report.operational.status, 'unavailable');
    assert.match(report.operational.detail ?? '', /moltbot\.db/);
    assert.equal(report.operational.exists, false);
    assert.equal(report.operational.totalMessages, null);
    assert.equal(report.operational.totalSchedules, null);
    assert.equal(report.operational.lastMessageAt, null);
    assert.equal(report.operational.modelResponses24h, null);
    assert.equal(report.retrieval.status, 'ok');
    assert.equal(report.retrieval.detail, null);

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
      writeRetrievalDb(dbDir, []);
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

test('AC-1／AC-2：檢索資料庫不是 SQLite 檔時是 error，orphan 檢查是 error、ok 為 null', async () => {
  await withArchiveEnv({}, async ({ tempDir, dbDir, checkpointFile }) => {
    writeLocalArchive(tempDir);
    writeOperationalDbWithRecentModelReply(dbDir);
    writeCheckpoint(checkpointFile);
    writeNotSqlite(path.join(dbDir, 'memory.db'));
    const issuesBefore = runtimeIssueCount();

    const report = collectMemoryHealthReport();

    assert.equal(report.retrieval.status, 'error');
    assert.match(report.retrieval.detail ?? '', /not a database/);
    assert.equal(report.retrieval.exists, true);
    assert.equal(report.retrieval.entities, null);
    assert.equal(report.retrieval.observations, null);
    assert.equal(report.retrieval.relations, null);
    assert.equal(report.consistency.checks.orphanSourceSession, 'error');
    assert.equal(report.consistency.orphanSourceSessionObservations, null);
    assert.equal(report.consistency.sourceSessionTaggedObservations, null);
    assert.equal(report.consistency.observationsMissingSourceSession, null);
    // checkpoint 兩項不讀檢索資料庫，照常檢查
    assert.equal(report.consistency.checks.checkpointSession, 'checked');
    assert.equal(report.consistency.checks.checkpointAhead, 'checked');
    assert.equal(report.consistency.ok, null);
    assert.equal(report.operational.status, 'ok');
    assert.equal(report.operational.modelResponses24h, 1);
    assert.equal(runtimeIssueCount(), issuesBefore);

    const markdown = formatMemoryHealthMarkdown(report);
    assert.match(markdown, /- Retrieval Status: error\n/);
    assert.match(markdown, /- Retrieval Detail: \S/);
    assert.match(markdown, /- Retrieval Entities: unknown\n/);
    assert.match(markdown, /- Retrieval Observations: unknown\n/);
    assert.match(markdown, /- Retrieval Relations: unknown\n/);
    assert.match(markdown, /- Consistency Check Orphan Source Session: error\n/);
    assert.match(markdown, /- Consistency Tagged Observations: unknown\n/);
    assert.match(markdown, /- Consistency Missing Source Session Tag: unknown\n/);
    assert.match(markdown, /- Consistency OK: unknown\n/);
  });
});

test('AC-1／AC-2：檢索資料庫不存在時是 unavailable，orphan 檢查 skipped，其餘通過即 ok=true', async () => {
  await withArchiveEnv({}, async ({ tempDir, dbDir, checkpointFile }) => {
    writeLocalArchive(tempDir);
    writeOperationalDbWithRecentModelReply(dbDir);
    writeCheckpoint(checkpointFile);

    const report = collectMemoryHealthReport();

    assert.equal(report.retrieval.status, 'unavailable');
    assert.match(report.retrieval.detail ?? '', /memory\.db/);
    assert.equal(report.retrieval.exists, false);
    assert.equal(report.retrieval.entities, null);
    assert.equal(report.retrieval.observations, null);
    assert.equal(report.retrieval.relations, null);
    assert.equal(report.consistency.checks.orphanSourceSession, 'skipped');
    assert.equal(report.consistency.orphanSourceSessionObservations, 0);
    assert.equal(report.consistency.sourceSessionTaggedObservations, 0);
    assert.equal(report.consistency.observationsMissingSourceSession, 0);
    assert.equal(report.consistency.checks.checkpointSession, 'checked');
    assert.equal(report.consistency.checks.checkpointAhead, 'checked');
    assert.equal(report.consistency.ok, true);

    const markdown = formatMemoryHealthMarkdown(report);
    assert.match(markdown, /- Retrieval Status: unavailable\n/);
    assert.match(markdown, /- Retrieval Entities: unknown\n/);
    assert.match(markdown, /- Consistency Check Orphan Source Session: skipped\n/);
    assert.match(markdown, /- Consistency OK: true\n/);
  });
});

test('AC-1：兩個本機資料庫都可讀時狀態是 ok、detail 為 null', async () => {
  await withArchiveEnv({}, async ({ dbDir }) => {
    writeOperationalDbWithRecentModelReply(dbDir);
    writeRetrievalDb(dbDir, ['tagged [source_session=s1]']);

    const report = collectMemoryHealthReport();

    assert.equal(report.operational.status, 'ok');
    assert.equal(report.operational.detail, null);
    assert.equal(report.operational.totalMessages, 1);
    assert.equal(report.retrieval.status, 'ok');
    assert.equal(report.retrieval.detail, null);
    assert.equal(report.retrieval.observations, 1);

    const markdown = formatMemoryHealthMarkdown(report);
    assert.match(markdown, /- Operational Status: ok\n/);
    assert.match(markdown, /- Operational Detail: \(none\)\n/);
    assert.match(markdown, /- Retrieval Status: ok\n/);
  });
});
