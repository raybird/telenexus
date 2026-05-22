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
      cliDetected: true,
      memoriaHome: '/tmp/Memoria',
      cliPath: '/tmp/Memoria/cli',
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
