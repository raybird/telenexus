import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
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

test('MemoryManager searchSummaries can find tag-only matches via summary FTS index', () => {
  withTempDb(() => {
    withMockedNow(() => {
      const memory = new MemoryManager();

      memory.addMessage('user-a', 'model', 'opaque note', {
        summary: 'General operational note',
        impactLevel: 2,
        tags: ['release']
      });

      const results = memory.searchSummaries('user-a', 'release', 2, 1);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.summary, 'General operational note');
      assert.ok(results[0]?.tags.includes('release'));
    });
  });
});

test('MemoryManager keeps summary FTS index in sync after metadata update', () => {
  withTempDb(() => {
    withMockedNow(() => {
      const memory = new MemoryManager();

      memory.addMessage('user-a', 'model', 'opaque note', {
        summary: 'General operational note',
        impactLevel: 1,
        tags: ['notes']
      });

      const initial = memory.searchSummaries('user-a', 'runner', 5, 1);
      assert.equal(initial.length, 0);

      const inserted = memory.listSummaryMessages('user-a', 5, 1)[0];
      assert.ok(inserted);

      memory.updateMessageMetadataById(inserted.id, {
        summary: inserted.summary,
        impactLevel: 2,
        tags: ['runner']
      });

      const updated = memory.searchSummaries('user-a', 'runner', 5, 1);
      assert.equal(updated.length, 1);
      assert.ok(updated[0]?.tags.includes('runner'));
      assert.equal(updated[0]?.summary, 'General operational note');
    });
  });
});

test('MemoryManager searchSummaries keeps high-signal summary matches ahead of newer weak matches', () => {
  withTempDb(() => {
    const originalNow = Date.now;
    let ts = Date.parse('2026-03-01T00:00:00Z');
    Date.now = () => ts;

    try {
      const memory = new MemoryManager();

      memory.addMessage('user-a', 'model', 'opaque note', {
        summary: 'Release Workflow Rule with npm run release:patch and tag push guidance',
        impactLevel: 3,
        tags: ['release', 'memory']
      });

      ts = Date.parse('2026-03-28T00:00:00Z');
      memory.addMessage('user-a', 'model', 'recent release mention in raw content only', {
        summary: 'General weekly note',
        impactLevel: 1,
        tags: ['notes']
      });

      const results = memory.searchSummaries('user-a', 'release', 2, 1);
      assert.equal(results.length, 2);
      assert.match(results[0]?.summary || '', /Release Workflow Rule/);
      assert.equal(results[0]?.impactLevel, 3);
    } finally {
      Date.now = originalNow;
    }
  });
});

test('SAR 的 summary 查詢會採用部分索引', () => {
  // 部分索引的 WHERE 條件必須與查詢完全一致，planner 才會採用它。查詢條件一改就會靜默
  // 退回整表候選（實測 115K 列時 74ms vs 7ms），所以這裡直接斷言 query plan。
  withTempDb((dbPath) => {
    const memory = new MemoryManager();
    memory.addMessage('u1', 'user', '有摘要的訊息', { summary: '一個決策', impactLevel: 2 });
    memory.addMessage('u1', 'model', '沒有摘要的訊息');
    memory.close?.();

    const db = new Database(dbPath, { readonly: true });
    try {
      const indexNames = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'`)
        .all()
        .map((r: { name: string }) => r.name);
      assert.ok(
        indexNames.includes('idx_messages_summary_lookup'),
        `部分索引不存在，實際有：${indexNames.join(', ')}`
      );

      // getRecentSummaries 的查詢
      const recentSql = `
        SELECT id, role, content, summary, impact_level, tags, timestamp
        FROM messages
        WHERE user_id = ?
          AND summary IS NOT NULL
          AND TRIM(summary) != ''
          AND impact_level >= ?
        ORDER BY timestamp DESC
        LIMIT ?`;
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${recentSql}`)
        .all('u1', 1, 10)
        .map((r: { detail: string }) => r.detail)
        .join(' | ');
      assert.ok(
        plan.includes('idx_messages_summary_lookup'),
        `getRecentSummaries 未採用部分索引，plan=${plan}`
      );
    } finally {
      db.close();
    }
  });
});
