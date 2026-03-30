import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  collectMemoryHealthReport,
  formatMemoryHealthMarkdown
} from '../src/services/memory-health.js';

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
