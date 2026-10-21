import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/core/memory.js';
import { writeContextSnapshots } from '../src/services/context-snapshots.js';
import {
  clearPromptSessionTraces,
  recordPromptSessionTrace
} from '../src/services/prompt-session-telemetry.js';
import {
  clearMemoryIntentTraces,
  recordMemoryIntentTrace
} from '../src/services/memory-intent-telemetry.js';
import type { MemoriaSyncStatus } from '../src/core/memoria-sync.js';
import { getRecentIssues } from '../src/utils/errors.js';

function withTempProject<T>(fn: (projectDir: string) => T): T {
  const prevCwd = process.cwd();
  const prevDbPath = process.env.DB_PATH;
  const prevProjectDir = process.env.APP_PROJECT_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-context-snapshots-'));
  const dbPath = path.join(tempDir, 'test.db');

  fs.mkdirSync(path.join(tempDir, 'workspace', 'context'), { recursive: true });
  process.chdir(tempDir);
  process.env.DB_PATH = dbPath;
  process.env.APP_PROJECT_DIR = tempDir;

  try {
    clearPromptSessionTraces();
    clearMemoryIntentTraces();
    return fn(tempDir);
  } finally {
    clearPromptSessionTraces();
    clearMemoryIntentTraces();
    process.chdir(prevCwd);
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    if (prevProjectDir === undefined) delete process.env.APP_PROJECT_DIR;
    else process.env.APP_PROJECT_DIR = prevProjectDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('writeContextSnapshots writes prompt session status snapshot', () => {
  withTempProject((projectDir) => {
    const memory = new MemoryManager();
    const memoriaStatus: MemoriaSyncStatus = {
      mode: 'auto',
      available: true,
      disabled: false,
      endpointReachable: true,
      endpoint: 'http://memoria:3917',
      hookQueueEnabled: true,
      hookQueuePollMs: 5000,
      recentFailureCount: 1,
      lastSyncAt: Date.parse('2026-04-03T11:02:00Z'),
      lastFailureAt: Date.parse('2026-04-03T11:01:00Z'),
      lastFailureMessage: 'sample failure'
    };
    recordPromptSessionTrace({
      requestId: 'req-ctx',
      timestamp: Date.parse('2026-04-03T11:00:00Z'),
      channel: 'telegram',
      userId: 'user-a',
      executionMode: 'local',
      promptMode: 'compact',
      promptSelectionReason: 'compact-followup',
      promptLength: 380,
      memoryContextLength: 120,
      memoryContextSectionCount: 2,
      usedMemoryContext: true,
      forceNewSession: false,
      isPassthroughCommand: false,
      durationMs: 640,
      responseLength: 140,
      ok: true
    });
    recordMemoryIntentTrace({
      requestId: 'req-intent',
      timestamp: Date.parse('2026-04-03T11:03:00Z'),
      userId: 'user-a',
      channel: 'telegram',
      promptMode: 'full',
      intent: {
        level: 'rule',
        confidence: 'high',
        reason: '穩定規則',
        summary: 'sample summary'
      }
    });

    writeContextSnapshots(memory, { memoriaStatus });

    const snapshotPath = path.join(projectDir, 'workspace', 'context', 'prompt-session-status.md');
    const content = fs.readFileSync(snapshotPath, 'utf8');
    assert.match(content, /# Prompt Session Status/);
    assert.match(content, /compact: 1/);
    assert.match(content, /req=req-ctx/);

    const memoriaSnapshotPath = path.join(projectDir, 'workspace', 'context', 'memoria-status.md');
    const memoriaContent = fs.readFileSync(memoriaSnapshotPath, 'utf8');
    assert.match(memoriaContent, /# Memoria Status/);
    assert.match(memoriaContent, /Available: yes/);
    assert.match(memoriaContent, /Recent Failure Count: 1/);

    const intentSnapshotPath = path.join(
      projectDir,
      'workspace',
      'context',
      'memory-intent-status.md'
    );
    const intentContent = fs.readFileSync(intentSnapshotPath, 'utf8');
    assert.match(intentContent, /# Memory Intent Status/);
    assert.match(intentContent, /rule: 1/);
    assert.match(intentContent, /req=req-intent/);
  });
});

// ---- issue 0018：各個 snapshot 互不牽連，開始失敗時記一次 runtime issue ----

const SNAPSHOT_FILES = [
  'runtime-status.md',
  'provider-status.md',
  'scheduler-status.md',
  'system-architecture.md',
  'operations-policy.md',
  'error-summary.md',
  'memory-status.md',
  'memoria-status.md',
  'memory-intent-status.md',
  'prompt-session-status.md'
];

/** 只實作 writeContextSnapshots 用到的兩個方法；failSchedules 為 true 時 scheduler-status 會 throw */
function stubMemory(state: { failSchedules: boolean }): MemoryManager {
  return {
    getActiveSchedules: () => {
      if (state.failSchedules) throw new Error('schedules table is broken');
      return [];
    },
    countIssuesByScope: () => []
  } as unknown as MemoryManager;
}

function withSnapshotDataDir<T>(fn: (projectDir: string, contextDir: string) => T): T {
  return withTempProject((projectDir) => {
    const prevDbDir = process.env.DB_DIR;
    process.env.DB_DIR = path.join(projectDir, 'data');
    fs.mkdirSync(process.env.DB_DIR, { recursive: true });
    try {
      return fn(projectDir, path.join(projectDir, 'workspace', 'context'));
    } finally {
      if (prevDbDir === undefined) delete process.env.DB_DIR;
      else process.env.DB_DIR = prevDbDir;
    }
  });
}

function issueCount(scope: string): number {
  return getRecentIssues()
    .filter((issue) => issue.scope === scope)
    .reduce((sum, issue) => sum + issue.count, 0);
}

function quietly<T>(fn: (logs: { warn: string[]; log: string[] }) => T): T {
  const logs = { warn: [] as string[], log: [] as string[] };
  const { warn, log } = console;
  console.warn = (...args: unknown[]) => void logs.warn.push(args.map(String).join(' '));
  console.log = (...args: unknown[]) => void logs.log.push(args.map(String).join(' '));
  try {
    return fn(logs);
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

test('AC-3：其中一個 snapshot throw 時，其他照常更新，失敗的保留上一次的內容', () => {
  withSnapshotDataDir((_projectDir, contextDir) => {
    const memoriaFile = path.join(contextDir, 'memoria-status.md');
    fs.writeFileSync(memoriaFile, 'previous memoria status');
    const broken = {} as MemoriaSyncStatus;
    Object.defineProperty(broken, 'mode', {
      get() {
        throw new Error('memoria status unavailable');
      }
    });

    quietly(() =>
      writeContextSnapshots(stubMemory({ failSchedules: false }), { memoriaStatus: broken })
    );

    assert.equal(fs.readFileSync(memoriaFile, 'utf8'), 'previous memoria status');
    for (const file of SNAPSHOT_FILES.filter((name) => name !== 'memoria-status.md')) {
      assert.ok(fs.existsSync(path.join(contextDir, file)), `${file} 應該要寫入`);
    }
    assert.match(
      fs.readFileSync(path.join(contextDir, 'memory-status.md'), 'utf8'),
      /# Memory Status/
    );
  });
});

test('AC-3：檢索資料庫不是 SQLite 時 memory-status 照常更新並標 error，其他檔案也都寫入', () => {
  withSnapshotDataDir((_projectDir, contextDir) => {
    fs.writeFileSync(path.join(process.env.DB_DIR!, 'memory.db'), 'not a sqlite file '.repeat(50));

    quietly(() => writeContextSnapshots(stubMemory({ failSchedules: false })));

    const memoryStatus = fs.readFileSync(path.join(contextDir, 'memory-status.md'), 'utf8');
    assert.match(memoryStatus, /- Retrieval Status: error\n/);
    for (const file of SNAPSHOT_FILES) {
      assert.ok(fs.existsSync(path.join(contextDir, file)), `${file} 應該要寫入`);
    }
  });
});

test('AC-4：snapshot 開始失敗時記一次 runtime issue，持續失敗不重複記，恢復時印 log', () => {
  withSnapshotDataDir(() => {
    const scope = 'context-snapshot:scheduler-status';
    const state = { failSchedules: true };
    const memory = stubMemory(state);
    const before = issueCount(scope);

    const logs = quietly((captured) => {
      for (const fail of [true, true, true, false, true]) {
        state.failSchedules = fail;
        writeContextSnapshots(memory);
      }
      return captured;
    });

    assert.equal(issueCount(scope) - before, 2);
    assert.equal(
      logs.log.filter((line) => line.includes('scheduler-status') && /恢復/.test(line)).length,
      1
    );
    // console.warn 照舊保留：每次失敗都印
    assert.equal(logs.warn.filter((line) => line.includes('scheduler-status')).length, 4);
  });
});
