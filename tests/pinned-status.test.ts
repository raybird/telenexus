import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/core/memory.js';
import { PinnedStatusManager } from '../src/services/pinned-status-manager.js';
import { countRecentErrors } from '../src/services/pinned-status.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-pinned-status-db-'));
  process.env.DB_PATH = path.join(tempDir, 'moltbot.db');
  try {
    await fn();
  } finally {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function stubConnector() {
  const texts: string[] = [];
  return {
    texts,
    connector: {
      name: 'stub',
      initialize: async () => {},
      sendMessage: async () => {},
      sendFile: async () => {},
      sendPlaceholder: async (_c: string, text: string) => {
        texts.push(text);
        return 'M1';
      },
      editMessage: async (_c: string, _m: string, text: string) => {
        texts.push(text);
      },
      onMessage: () => {}
    }
  };
}

function seedIssues(memory: MemoryManager, now: number): void {
  // 24 小時內 25 列（超過記憶體緩衝的上限 20），訊息各不相同才不會被 60 秒去重併掉
  for (let i = 0; i < 24; i += 1) {
    memory.appendRuntimeIssue(`scope-${i % 3}`, `recent ${i}`, now - i * HOUR - 1000);
  }
  memory.appendRuntimeIssue('scope-edge', 'just inside', now - DAY + 1000);
  // 24 小時前的不算
  memory.appendRuntimeIssue('scope-edge', 'just outside', now - DAY - 1000);
  memory.appendRuntimeIssue('scope-old', 'two days ago', now - 2 * DAY);
}

test('issue 0021 AC-1 計數是 runtime_issues 最近 24 小時的列數，超過 20 照實顯示', async () => {
  await withTempDb(async () => {
    const now = Date.now();
    const memory = new MemoryManager();
    seedIssues(memory, now);

    assert.equal(countRecentErrors(memory, now), 25);
    const persisted = memory.countIssuesByScope(now - DAY).reduce((sum, row) => sum + row.count, 0);
    assert.equal(countRecentErrors(memory, now), persisted);
  });
});

test('issue 0021 AC-1 重新開啟資料庫後，重啟前 24 小時內的錯誤仍然算在內', async () => {
  await withTempDb(async () => {
    const now = Date.now();
    seedIssues(new MemoryManager(), now);

    const reopened = new MemoryManager();
    assert.equal(countRecentErrors(reopened, now), 25);
  });
});

test('issue 0021 AC-3 讀不到 runtime_issues 時回傳 null，不 throw', () => {
  const broken = {
    countIssuesByScope: () => {
      throw new Error('SqliteError: database disk image is malformed');
    }
  };
  assert.equal(countRecentErrors(broken), null);
});

test('issue 0021 AC-3 計數未知時顯示 unknown，其他欄位照常', async () => {
  const { connector, texts } = stubConnector();
  const mgr = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 0 });
  await mgr.initialize({ model: 'm', activeSchedules: 2, recentErrors: 0, memorySize: 7 });
  await mgr.update({ model: 'm', activeSchedules: 2, recentErrors: null, memorySize: 7 });

  const last = texts.at(-1) ?? '';
  assert.match(last, /^Recent errors \(24h\): unknown$/m);
  assert.match(last, /^Model: `m`$/m);
  assert.match(last, /^Active schedules: 2$/m);
  assert.match(last, /^Memory size: 7$/m);
});

test('issue 0021 AC-1 有數字時照實顯示', async () => {
  const { connector, texts } = stubConnector();
  const mgr = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 0 });
  await mgr.initialize({ model: 'm', activeSchedules: 0, recentErrors: 30, memorySize: 0 });
  assert.match(texts.at(-1) ?? '', /^Recent errors \(24h\): 30$/m);
});
