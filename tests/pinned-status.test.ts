import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/core/memory.js';
import { PinnedStatusManager } from '../src/services/pinned-status-manager.js';
import { countRecentErrors, startPinnedStatus } from '../src/services/pinned-status.js';
import type { PinnedSnapshot } from '../src/services/pinned-status-manager.js';
import { startIssueStore } from '../src/services/issue-store.js';
import { emitEvent } from '../src/services/event-bus.js';
import { recordRuntimeIssue } from '../src/utils/errors.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const prevDbPath = process.env.DB_PATH;
  const prevProjectDir = process.env.APP_PROJECT_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-pinned-status-db-'));
  process.env.DB_PATH = path.join(tempDir, 'moltbot.db');
  // emitEvent 會寫 workspace/context/events.jsonl，指到暫存目錄
  process.env.APP_PROJECT_DIR = tempDir;
  try {
    await fn();
  } finally {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    if (prevProjectDir === undefined) delete process.env.APP_PROJECT_DIR;
    else process.env.APP_PROJECT_DIR = prevProjectDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function recordingTarget() {
  const updates: PinnedSnapshot[] = [];
  return {
    updates,
    target: {
      initialize: async () => {},
      update: async (snapshot: PinnedSnapshot) => {
        updates.push(snapshot);
      }
    }
  };
}

function fixedSources(recentErrors: () => number | null) {
  return { model: () => 'm', activeSchedules: () => 0, memorySize: () => 0, recentErrors };
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

test('issue 0021 AC-1 新的 runtime issue 觸發的那次更新已經包含這一筆', async () => {
  await withTempDb(async () => {
    const memory = new MemoryManager();
    const store = startIssueStore(memory);
    const { target, updates } = recordingTarget();
    const pinned = await startPinnedStatus(
      target,
      fixedSources(() => countRecentErrors(memory))
    );
    try {
      recordRuntimeIssue('issue-0021-test', new Error(`ordering ${Date.now()}`));
      await tick();
      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.recentErrors, 1);
      assert.equal(typeof updates[0]?.lastRequestAt, 'number');
    } finally {
      pinned.stop();
      store.stop();
    }
  });
});

test('issue 0021 AC-2 錯誤超過 24 小時後，定期更新把數字改成新的值', async () => {
  await withTempDb(async () => {
    const t0 = Date.now();
    let clock = t0;
    const memory = new MemoryManager();
    memory.appendRuntimeIssue('scope-a', 'one hour ago', t0 - HOUR);
    const { connector, texts } = stubConnector();
    const manager = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 0 });
    const pinned = await startPinnedStatus(
      manager,
      fixedSources(() => countRecentErrors(memory, clock))
    );
    try {
      assert.match(texts.at(-1) ?? '', /^Recent errors \(24h\): 1$/m);

      clock = t0 + 23 * HOUR + 1000;
      pinned.refresh();
      await tick();
      assert.match(texts.at(-1) ?? '', /^Recent errors \(24h\): 0$/m);
      assert.equal(texts.length, 2);
    } finally {
      pinned.stop();
    }
  });
});

test('issue 0021 AC-2 數字沒變的定期更新不編輯訊息（Last request 的分鐘數不算）', async () => {
  let errors = 3;
  const { target, updates } = recordingTarget();
  const pinned = await startPinnedStatus(
    target,
    fixedSources(() => errors)
  );
  try {
    emitEvent('request_done', { ok: true });
    await tick();
    assert.equal(updates.length, 1);

    pinned.refresh();
    pinned.refresh();
    await tick();
    assert.equal(updates.length, 1, '數字沒變不應送出更新');

    errors = 2;
    pinned.refresh();
    await tick();
    assert.equal(updates.length, 2);
    assert.equal(updates[1]?.recentErrors, 2);

    // 送出後要記住新的數字，否則之後每次定期更新都會再送一次
    pinned.refresh();
    pinned.refresh();
    await tick();
    assert.equal(updates.length, 2, '已送出的數字不應重送');
  } finally {
    pinned.stop();
  }
});

test('issue 0021 讀取來源 throw 時，事件觸發的更新不讓程序崩潰', async () => {
  const { target, updates } = recordingTarget();
  let fail = false;
  const sources = {
    ...fixedSources(() => 0),
    activeSchedules: () => {
      if (fail) throw new Error('boom');
      return 0;
    }
  };
  const pinned = await startPinnedStatus(target, sources);
  try {
    fail = true;
    emitEvent('request_done', { ok: true });
    await tick();
    assert.equal(updates.length, 0);
  } finally {
    pinned.stop();
  }
});

test('issue 0021 定期更新時讀取來源 throw，不讓計時器崩潰也不送更新', async () => {
  const { target, updates } = recordingTarget();
  let errors: number | null = 1;
  let fail = false;
  const sources = {
    ...fixedSources(() => errors),
    activeSchedules: () => {
      if (fail) throw new Error('database is locked');
      return 0;
    }
  };
  const pinned = await startPinnedStatus(target, sources);
  try {
    // 資料庫讀不到時，錯誤數變成 null，其他來源也跟著 throw
    fail = true;
    errors = null;
    assert.doesNotThrow(() => pinned.refresh());
    await tick();
    assert.equal(updates.length, 0);

    // 恢復後，同一個 null 仍要補送出去
    fail = false;
    pinned.refresh();
    await tick();
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.recentErrors, null);
  } finally {
    pinned.stop();
  }
});

test('issue 0021 AC-3 查詢 throw 時，釘選訊息從啟動到事件更新都顯示 unknown', async () => {
  await withTempDb(async () => {
    const broken = {
      countIssuesByScope: () => {
        throw new Error('SqliteError: database disk image is malformed');
      }
    };
    const { connector, texts } = stubConnector();
    const manager = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 0 });
    const pinned = await startPinnedStatus(manager, {
      model: () => 'm',
      activeSchedules: () => 2,
      memorySize: () => 7,
      recentErrors: () => countRecentErrors(broken)
    });
    try {
      assert.match(texts.at(-1) ?? '', /^Recent errors \(24h\): unknown$/m);

      emitEvent('request_done', { ok: true });
      await tick();
      const last = texts.at(-1) ?? '';
      assert.equal(texts.length, 2, '事件更新照常送出');
      assert.match(last, /^Recent errors \(24h\): unknown$/m);
      assert.match(last, /^Active schedules: 2$/m);
      assert.match(last, /^Memory size: 7$/m);
      assert.match(last, /^Last request: 0m ago$/m);
    } finally {
      pinned.stop();
    }
  });
});
