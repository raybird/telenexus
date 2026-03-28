import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemoryManager } from '../src/core/memory.js';

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-memory-test-'));
  const dbPath = path.join(tempDir, 'test.db');
  process.env.DB_PATH = dbPath;

  try {
    return fn(dbPath);
  } finally {
    if (prevDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = prevDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withMockedNow<T>(fn: () => T): T {
  const originalNow = Date.now;
  let ts = 1700000000000;
  Date.now = () => (ts += 1000);

  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

test('MemoryManager returns paged history with total/offset/limit', () => {
  withTempDb(() => {
    withMockedNow(() => {
      const memory = new MemoryManager();
      for (let i = 1; i <= 5; i += 1) {
        memory.addMessage('user-a', 'user', `message-${i}`);
      }
      memory.addMessage('user-b', 'user', 'other-user-message');

      const firstPage = memory.getMessagesPage('user-a', 0, 2);
      assert.equal(firstPage.total, 5);
      assert.equal(firstPage.offset, 0);
      assert.equal(firstPage.limit, 2);
      assert.deepEqual(
        firstPage.items.map((item) => item.content),
        ['message-5', 'message-4']
      );

      const secondPage = memory.getMessagesPage('user-a', 2, 2);
      assert.equal(secondPage.total, 5);
      assert.deepEqual(
        secondPage.items.map((item) => item.content),
        ['message-3', 'message-2']
      );
    });
  });
});

test('MemoryManager searchSummaries prefers summary and tag matches over content-only matches', () => {
  withTempDb(() => {
    withMockedNow(() => {
      const memory = new MemoryManager();

      memory.addMessage('user-a', 'model', 'general deployment discussion mentioning release', {
        summary: 'General deployment retrospective',
        impactLevel: 2,
        tags: ['infra']
      });

      memory.addMessage('user-a', 'model', 'short content without keyword', {
        summary: 'Release Workflow Rule with release SOP and npm run release:patch guidance',
        impactLevel: 3,
        tags: ['release', 'memory']
      });

      const results = memory.searchSummaries('user-a', 'release', 2, 1);
      assert.equal(results.length, 2);
      assert.match(results[0]?.summary || '', /Release Workflow Rule/);
      assert.ok(results[0]?.tags.includes('release'));
    });
  });
});

test('MemoryManager searchSummaries can find summary/tag matches when content FTS misses', () => {
  withTempDb(() => {
    withMockedNow(() => {
      const memory = new MemoryManager();

      memory.addMessage('user-a', 'model', 'opaque note', {
        summary: 'Scheduler CLI Management Rule for reload and health checks',
        impactLevel: 3,
        tags: ['scheduler', 'memory']
      });

      const results = memory.searchSummaries('user-a', 'scheduler', 3, 1);
      assert.equal(results.length, 1);
      assert.match(results[0]?.summary || '', /Scheduler CLI Management Rule/);
    });
  });
});
