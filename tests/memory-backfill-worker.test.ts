import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { MemoryBackfillReport } from '../src/services/memory-backfill.js';
import { MemoryBackfillWorker } from '../src/services/memory-backfill-worker.js';
import type { BackfillSourceAssessment } from '../src/services/memory-health.js';
import { getRecentIssues } from '../src/utils/errors.js';

function makeReport(): MemoryBackfillReport {
  return {
    ok: true,
    mode: 'dry-run',
    archiveDbPath: '/tmp/archive.db',
    retrievalDbPath: '/tmp/retrieval.db',
    checkpointPath: '/tmp/checkpoint.json',
    checkpointBefore: null,
    checkpointAfter: null,
    scannedSessions: 1,
    candidates: [],
    duplicateEstimate: 0,
    written: 0,
    duplicatesSkipped: 0,
    writeAttempted: false
  };
}

function assessment(
  state: BackfillSourceAssessment['state'],
  detail = `detail for ${state}`
): BackfillSourceAssessment {
  return { source: state === 'remote-unsupported' ? 'remote' : 'local', state, detail };
}

async function captureLogs<T>(fn: () => Promise<T> | T): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const capture = (...args: unknown[]) => {
    logs.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  };
  console.log = capture;
  console.warn = capture;
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

const SOURCE_ENV_KEYS = [
  'DB_DIR',
  'MEMORIA_HOME',
  'MEMORIA_ARCHIVE_DB',
  'MEMORY_BACKFILL_CHECKPOINT_FILE'
] as const;

/** 暫存 DB_DIR 與 checkpoint；不設定兩個封存變數就是遠端模式 */
async function withSourceEnv<T>(
  fn: (paths: { tempDir: string; checkpointFile: string }) => Promise<T> | T
): Promise<T> {
  const previous = Object.fromEntries(SOURCE_ENV_KEYS.map((key) => [key, process.env[key]]));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-backfill-worker-0016-'));
  const checkpointFile = path.join(tempDir, 'memory-backfill-checkpoint.json');
  for (const key of SOURCE_ENV_KEYS) delete process.env[key];
  process.env.DB_DIR = path.join(tempDir, 'data');
  process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = checkpointFile;
  try {
    return await fn({ tempDir, checkpointFile });
  } finally {
    for (const key of SOURCE_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeArchive(archivePath: string, timestamps: string[]): void {
  const db = new Database(archivePath);
  try {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT);
    `);
    const insert = db.prepare('INSERT INTO sessions (id, timestamp) VALUES (?, ?)');
    timestamps.forEach((timestamp, index) => insert.run(`session-${index}`, timestamp));
  } finally {
    db.close();
  }
}

test('MemoryBackfillWorker skips run when no new archive sessions exist', async () => {
  let runCount = 0;
  const worker = new MemoryBackfillWorker({
    enabled: true,
    assessArchiveSource: () => assessment('up-to-date'),
    runBackfill: async () => {
      runCount += 1;
      return makeReport();
    }
  });

  await worker.runOnce('manual');
  assert.equal(runCount, 0);
});

test('MemoryBackfillWorker runs backfill and calls onAfterRun when work exists', async () => {
  let runCount = 0;
  let afterRunCount = 0;
  const worker = new MemoryBackfillWorker({
    enabled: true,
    assessArchiveSource: () => assessment('pending'),
    onAfterRun: () => {
      afterRunCount += 1;
    },
    runBackfill: async () => {
      runCount += 1;
      return makeReport();
    }
  });

  await worker.runOnce('manual');
  assert.equal(runCount, 1);
  assert.equal(afterRunCount, 1);
});

test('MemoryBackfillWorker releases inFlight after timeout-like failure', async () => {
  let runCount = 0;
  const worker = new MemoryBackfillWorker({
    enabled: true,
    assessArchiveSource: () => assessment('pending'),
    runBackfill: async () => {
      runCount += 1;
      if (runCount === 1) {
        throw new Error('memory backfill timeout after 10ms');
      }
      return makeReport();
    }
  });

  await worker.runOnce('manual');
  await worker.runOnce('manual');
  assert.equal(runCount, 2);
});

// issue 0016 AC-1：預設判定決定要不要執行回填，結果必須與舊版 defaultHasPendingArchiveSessions() 一致
const PENDING_EQUIVALENCE_CASES: Array<{
  name: string;
  archive: string[] | 'remote' | 'missing';
  checkpointTimestamp?: string;
  expectRun: boolean;
}> = [
  {
    name: '遠端模式',
    archive: 'remote',
    checkpointTimestamp: '2026-05-31T10:38:00.556Z',
    expectRun: false
  },
  { name: '設定的路徑不存在', archive: 'missing', expectRun: false },
  {
    name: '空封存',
    archive: [],
    checkpointTimestamp: '2026-05-31T10:38:00.556Z',
    expectRun: false
  },
  { name: '空封存且沒有 checkpoint', archive: [], expectRun: false },
  { name: '沒有 checkpoint', archive: ['2026-03-30T00:00:00.000Z'], expectRun: true },
  { name: 'session 的時間是空字串且沒有 checkpoint', archive: [''], expectRun: false },
  {
    name: 'checkpoint 時間是空白',
    archive: ['2026-03-30T00:00:00.000Z'],
    checkpointTimestamp: '   ',
    expectRun: true
  },
  {
    name: '最新 session 與 checkpoint 相同',
    archive: ['2026-03-30T00:00:00.000Z', '2026-05-31T10:38:00.556Z'],
    checkpointTimestamp: '2026-05-31T10:38:00.556Z',
    expectRun: false
  },
  {
    name: 'checkpoint 前後有空白但時間相同',
    archive: ['2026-05-31T10:38:00.556Z'],
    checkpointTimestamp: ' 2026-05-31T10:38:00.556Z ',
    expectRun: false
  },
  {
    name: 'checkpoint 比最新 session 新',
    archive: ['2026-03-30T00:00:00.000Z'],
    checkpointTimestamp: '2026-05-31T10:38:00.556Z',
    expectRun: false
  },
  {
    name: '有比 checkpoint 新的 session',
    archive: ['2026-05-31T10:38:00.556Z', '2026-10-03T04:02:40.861Z'],
    checkpointTimestamp: '2026-05-31T10:38:00.556Z',
    expectRun: true
  }
];

for (const testCase of PENDING_EQUIVALENCE_CASES) {
  test(`issue 0016 AC-1 等價：${testCase.name} → ${testCase.expectRun ? '執行' : '不執行'}回填`, async () => {
    await withSourceEnv(async ({ tempDir, checkpointFile }) => {
      const archivePath = path.join(tempDir, 'sessions.db');
      if (testCase.archive === 'missing') {
        process.env.MEMORIA_ARCHIVE_DB = archivePath;
      } else if (testCase.archive !== 'remote') {
        writeArchive(archivePath, testCase.archive);
        process.env.MEMORIA_ARCHIVE_DB = archivePath;
      }
      if (testCase.checkpointTimestamp !== undefined) {
        fs.writeFileSync(
          checkpointFile,
          JSON.stringify({ lastProcessedTimestamp: testCase.checkpointTimestamp })
        );
      }

      let runCount = 0;
      const worker = new MemoryBackfillWorker({
        enabled: true,
        runBackfill: async () => {
          runCount += 1;
          return makeReport();
        }
      });
      await captureLogs(() => worker.runOnce('manual'));
      assert.equal(runCount, testCase.expectRun ? 1 : 0);
    });
  });
}

test('issue 0016 AC-2：沒執行回填的狀態各印各的原因，no new archive sessions 只用在 up-to-date', async () => {
  for (const state of ['remote-unsupported', 'unavailable', 'empty'] as const) {
    let runCount = 0;
    const worker = new MemoryBackfillWorker({
      enabled: true,
      assessArchiveSource: () => assessment(state, `原因-${state}`),
      runBackfill: async () => {
        runCount += 1;
        return makeReport();
      }
    });
    const { logs } = await captureLogs(() => worker.runOnce('interval'));
    assert.equal(runCount, 0, state);
    const line = logs.join('\n');
    assert.ok(line.includes(`interval skipped. ${state}: 原因-${state}`), line);
    assert.ok(!line.includes('no new archive sessions'), line);
  }

  const upToDate = new MemoryBackfillWorker({
    enabled: true,
    assessArchiveSource: () => assessment('up-to-date'),
    runBackfill: async () => makeReport()
  });
  const { logs } = await captureLogs(() => upToDate.runOnce('interval'));
  assert.ok(
    logs.includes('[MemoryBackfillWorker] interval skipped. no new archive sessions.'),
    logs.join('\n')
  );
});

test('issue 0016 AC-2：封存讀取失敗照舊記 memory-backfill:worker 並呼叫 onAfterRun', async () => {
  let runCount = 0;
  let afterRunCount = 0;
  const detail = `file is not a database (issue-0016 ${Date.now()})`;
  const worker = new MemoryBackfillWorker({
    enabled: true,
    assessArchiveSource: () => assessment('error', detail),
    onAfterRun: () => {
      afterRunCount += 1;
    },
    runBackfill: async () => {
      runCount += 1;
      return makeReport();
    }
  });
  const { logs } = await captureLogs(() => worker.runOnce('interval'));
  assert.equal(runCount, 0);
  assert.equal(afterRunCount, 1);
  assert.ok(
    logs.some((line) => line.includes('interval failed') && line.includes(detail)),
    logs.join('\n')
  );
  const issue = getRecentIssues().find(
    (item) => item.scope === 'memory-backfill:worker' && item.message.includes(detail)
  );
  assert.ok(issue, 'memory-backfill:worker runtime issue');
});

test('issue 0016 AC-2：遠端模式用預設判定時不再印 no new archive sessions，啟動訊息帶 source=remote', async () => {
  await withSourceEnv(async () => {
    const worker = new MemoryBackfillWorker({
      enabled: true,
      startupDelayMs: 60_000,
      intervalMs: 60_000,
      runBackfill: async () => makeReport()
    });
    const { logs } = await captureLogs(async () => {
      worker.start();
      worker.shutdown();
      await worker.runOnce('startup');
    });
    const text = logs.join('\n');
    assert.match(text, /Starting\. .*source=remote/);
    assert.ok(text.includes('startup skipped. remote-unsupported: '), text);
    assert.ok(!text.includes('no new archive sessions'), text);
  });
});

test('issue 0016：checkpoint 的處理時間不是字串時 start() 不 throw，runOnce() 照舊記 runtime issue', async () => {
  await withSourceEnv(async ({ tempDir, checkpointFile }) => {
    const archivePath = path.join(tempDir, 'sessions.db');
    writeArchive(archivePath, ['2026-10-03T04:02:40.861Z']);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    fs.writeFileSync(checkpointFile, JSON.stringify({ lastProcessedTimestamp: 1717150680556 }));

    let runCount = 0;
    let afterRunCount = 0;
    const worker = new MemoryBackfillWorker({
      enabled: true,
      startupDelayMs: 60_000,
      intervalMs: 60_000,
      onAfterRun: () => {
        afterRunCount += 1;
      },
      runBackfill: async () => {
        runCount += 1;
        return makeReport();
      }
    });
    const issuesBefore = getRecentIssues()
      .filter((issue) => issue.scope === 'memory-backfill:worker')
      .reduce((sum, issue) => sum + issue.count, 0);
    const { logs } = await captureLogs(async () => {
      worker.start();
      worker.shutdown();
      await worker.runOnce('startup');
    });
    assert.match(logs.join('\n'), /Starting\. .*source=local/);
    assert.equal(runCount, 0);
    assert.equal(afterRunCount, 1);
    const issuesAfter = getRecentIssues()
      .filter((issue) => issue.scope === 'memory-backfill:worker')
      .reduce((sum, issue) => sum + issue.count, 0);
    assert.equal(issuesAfter, issuesBefore + 1);
  });
});

// issue 0016 第二部分：遠端模式且回填開啟時，啟動警告一次，排程照常
async function captureStart(
  worker: MemoryBackfillWorker,
  waitMs: number,
  afterStart?: () => Promise<void>
): Promise<{ logs: string[]; warns: string[] }> {
  const logs: string[] = [];
  const warns: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
  try {
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await afterStart?.();
  } finally {
    worker.shutdown();
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return { logs, warns };
}

test('issue 0016 第二部分 AC-2：遠端模式開啟回填時，啟動用 warn 印一次不支援，排程照常、每輪仍印 skipped', async () => {
  await withSourceEnv(async () => {
    let runCount = 0;
    const worker = new MemoryBackfillWorker({
      enabled: true,
      startupDelayMs: 0,
      intervalMs: 60_000,
      runBackfill: async () => {
        runCount += 1;
        return makeReport();
      }
    });
    // 再跑一輪 interval：警告只在啟動時印，不會每輪都印
    const { logs, warns } = await captureStart(worker, 50, () => worker.runOnce('interval'));
    assert.equal(warns.length, 1, warns.join('\n'));
    assert.match(warns[0] ?? '', /遠端 Memoria 模式不支援回填/);
    assert.match(warns[0] ?? '', /每輪只會印 skipped/);
    assert.match(warns[0] ?? '', /MEMORY_BACKFILL_ENABLED 設為 false/);
    assert.ok(
      logs.some((line) => /Starting\. .*source=remote/.test(line)),
      logs.join('\n')
    );
    // 排程照常建立：startup 那一輪有跑；startup 與 interval 各印一行 skipped
    for (const trigger of ['startup', 'interval']) {
      assert.equal(
        logs.filter((line) => line.includes(`${trigger} skipped. remote-unsupported: `)).length,
        1,
        logs.join('\n')
      );
    }
    assert.equal(runCount, 0);
  });
});

test('issue 0016 第二部分 AC-2：本機模式或回填沒開時，啟動不印警告', async () => {
  await withSourceEnv(async ({ tempDir }) => {
    const archivePath = path.join(tempDir, 'sessions.db');
    writeArchive(archivePath, ['2026-10-03T04:02:40.861Z']);
    process.env.MEMORIA_ARCHIVE_DB = archivePath;
    const local = await captureStart(
      new MemoryBackfillWorker({
        enabled: true,
        startupDelayMs: 60_000,
        intervalMs: 60_000,
        runBackfill: async () => makeReport()
      }),
      0
    );
    assert.deepEqual(local.warns, []);
    assert.ok(local.logs.some((line) => /Starting\. .*source=local/.test(line)));
  });

  await withSourceEnv(async () => {
    const disabled = await captureStart(new MemoryBackfillWorker({ enabled: false }), 0);
    assert.deepEqual(disabled.warns, []);
    assert.deepEqual(disabled.logs, [
      '[MemoryBackfillWorker] Disabled by MEMORY_BACKFILL_ENABLED.'
    ]);
  });
});
