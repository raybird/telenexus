import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { extractCandidatesFromSession } from '../src/services/memory-backfill.js';
import { runMemoryBackfillDryRun } from '../src/services/memory-backfill.js';

const baseSession = {
  id: 'session-1',
  timestamp: '2026-03-30T00:00:00.000Z',
  project: 'TeleNexus',
  event_count: 2,
  summary: null,
  scope: null
};

function withBackfillEnv<T>(
  fn: (paths: {
    dataDir: string;
    memoriaHome: string;
    checkpointFile: string;
    reportFile: string;
  }) => T
): T {
  const prevDbDir = process.env.DB_DIR;
  const prevMemoriaHome = process.env.MEMORIA_HOME;
  const prevCheckpoint = process.env.MEMORY_BACKFILL_CHECKPOINT_FILE;
  const prevReport = process.env.MEMORY_BACKFILL_REPORT_FILE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-backfill-test-'));
  const dataDir = path.join(tempDir, 'data');
  const memoriaHome = path.join(tempDir, 'Memoria');
  const checkpointFile = path.join(tempDir, 'memory-backfill-checkpoint.json');
  const reportFile = path.join(tempDir, 'memory-backfill-report.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(memoriaHome, '.memory'), { recursive: true });

  process.env.DB_DIR = dataDir;
  process.env.MEMORIA_HOME = memoriaHome;
  process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = checkpointFile;
  process.env.MEMORY_BACKFILL_REPORT_FILE = reportFile;

  try {
    return fn({ dataDir, memoriaHome, checkpointFile, reportFile });
  } finally {
    if (prevDbDir === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prevDbDir;
    if (prevMemoriaHome === undefined) delete process.env.MEMORIA_HOME;
    else process.env.MEMORIA_HOME = prevMemoriaHome;
    if (prevCheckpoint === undefined) delete process.env.MEMORY_BACKFILL_CHECKPOINT_FILE;
    else process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = prevCheckpoint;
    if (prevReport === undefined) delete process.env.MEMORY_BACKFILL_REPORT_FILE;
    else process.env.MEMORY_BACKFILL_REPORT_FILE = prevReport;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('extractCandidatesFromSession rejects noisy rule text with markdown table', () => {
  const candidates = extractCandidatesFromSession(baseSession, [
    {
      event_type: 'UserMessage',
      content: JSON.stringify({
        text: '這份規範必須固定下來\n| 專案 | 狀態 |\n| --- | --- |\n| A | done |'
      }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    },
    {
      event_type: 'ModelMessage',
      content: JSON.stringify({ text: '收到' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    }
  ]);

  assert.equal(
    candidates.some((candidate) => candidate.type === 'rule'),
    false
  );
});

test('extractCandidatesFromSession keeps clean high-signal rule text', () => {
  const candidates = extractCandidatesFromSession(baseSession, [
    {
      event_type: 'UserMessage',
      content: JSON.stringify({ text: '之後每次部署都要先跑 smoke test。' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    },
    {
      event_type: 'ModelMessage',
      content: JSON.stringify({ text: '收到，我會記住。' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    }
  ]);

  const rule = candidates.find((candidate) => candidate.type === 'rule');
  assert.ok(rule);
  assert.match(rule.summary, /smoke test/);
});

test('extractCandidatesFromSession captures multiple high-signal candidates in one session', () => {
  const candidates = extractCandidatesFromSession(baseSession, [
    {
      event_type: 'UserMessage',
      content: JSON.stringify({ text: '我想用 Docker compose 當主要部署方式。' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    },
    {
      event_type: 'UserMessage',
      content: JSON.stringify({ text: '後續補上 runner timeout 保護。' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    },
    {
      event_type: 'UserMessage',
      content: JSON.stringify({ text: '部署前一律先做 smoke test。' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    },
    {
      event_type: 'ModelMessage',
      content: JSON.stringify({ text: '收到，我會照這三項處理。' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    }
  ]);

  assert.ok(
    candidates.some(
      (candidate) => candidate.type === 'decision' && /Docker compose/.test(candidate.summary)
    )
  );
  assert.ok(
    candidates.some(
      (candidate) => candidate.type === 'task' && /runner timeout/.test(candidate.summary)
    )
  );
  assert.ok(
    candidates.some(
      (candidate) => candidate.type === 'rule' && /smoke test/.test(candidate.summary)
    )
  );
});

test('extractCandidatesFromSession keeps more than one candidate of the same type when both are high-signal', () => {
  const candidates = extractCandidatesFromSession(baseSession, [
    {
      event_type: 'UserMessage',
      content: JSON.stringify({ text: '我想用 Opencode 當主要 provider。' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    },
    {
      event_type: 'UserMessage',
      content: JSON.stringify({ text: '接下來都改走 runner 路徑。' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    },
    {
      event_type: 'ModelMessage',
      content: JSON.stringify({ text: '收到。' }),
      metadata: JSON.stringify({ user_id: 'user-a' })
    }
  ]);

  const decisions = candidates.filter((candidate) => candidate.type === 'decision');
  assert.equal(decisions.length, 2);
});

test('runMemoryBackfillDryRun reports telemetry for candidate hits and rejection reasons', () => {
  withBackfillEnv(({ memoriaHome }) => {
    const sessionsDbPath = path.join(memoriaHome, '.memory', 'sessions.db');
    const db = new Database(sessionsDbPath);
    try {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          project TEXT,
          event_count INTEGER,
          summary TEXT,
          scope TEXT
        );
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          event_type TEXT NOT NULL,
          content TEXT,
          metadata TEXT
        );
      `);

      db.prepare(
        `INSERT INTO sessions (id, timestamp, project, event_count, summary, scope) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('session-1', '2026-03-30T00:00:00.000Z', 'TeleNexus', 2, null, null);
      db.prepare(
        `INSERT INTO sessions (id, timestamp, project, event_count, summary, scope) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('session-2', '2026-03-30T00:05:00.000Z', 'TeleNexus', 1, null, null);

      db.prepare(
        `INSERT INTO events (session_id, timestamp, event_type, content, metadata) VALUES (?, ?, ?, ?, ?)`
      ).run(
        'session-1',
        '2026-03-30T00:00:01.000Z',
        'UserMessage',
        JSON.stringify({ text: '之後每次部署都要先跑 smoke test。' }),
        JSON.stringify({ user_id: 'user-a' })
      );
      db.prepare(
        `INSERT INTO events (session_id, timestamp, event_type, content, metadata) VALUES (?, ?, ?, ?, ?)`
      ).run(
        'session-1',
        '2026-03-30T00:00:02.000Z',
        'ModelMessage',
        JSON.stringify({ text: '收到' }),
        JSON.stringify({ user_id: 'user-a' })
      );
      db.prepare(
        `INSERT INTO events (session_id, timestamp, event_type, content, metadata) VALUES (?, ?, ?, ?, ?)`
      ).run(
        'session-2',
        '2026-03-30T00:05:01.000Z',
        'UserMessage',
        JSON.stringify({ text: '這是什麼？' }),
        JSON.stringify({ user_id: 'user-a' })
      );

      const report = runMemoryBackfillDryRun({
        batchSize: 10,
        maxCandidates: 10,
        saveCheckpoint: false
      });
      assert.equal(report.telemetry.sessionsWithCandidates, 1);
      assert.equal(report.telemetry.candidateTypes.rule, 1);
      assert.equal(report.telemetry.confidenceBuckets.medium, 1);
      assert.equal(report.telemetry.modelFallbackCandidates, 0);
      assert.ok((report.telemetry.rejectionReasons.question_like || 0) >= 1);
      assert.ok(report.telemetry.extractionMs >= 0);
    } finally {
      db.close();
    }
  });
});
