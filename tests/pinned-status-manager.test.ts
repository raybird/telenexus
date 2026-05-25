import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PinnedStatusManager } from '../src/services/pinned-status-manager.js';

function stubConnector() {
  const events: Array<{ op: string; payload: unknown }> = [];
  return {
    events,
    connector: {
      name: 'stub',
      initialize: async () => {},
      sendMessage: async () => {},
      sendFile: async () => {},
      sendPlaceholder: async (_c: string, text: string) => {
        events.push({ op: 'placeholder', payload: text });
        return 'M1';
      },
      editMessage: async (_c: string, _m: string, text: string) => {
        events.push({ op: 'edit', payload: text });
      },
      onMessage: () => {},
      pinMessage: async () => { events.push({ op: 'pin', payload: null }); },
      unpinMessage: async () => { events.push({ op: 'unpin', payload: null }); }
    }
  };
}

test('initialize sends placeholder and pins it', async () => {
  const { connector, events } = stubConnector();
  const mgr = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 0 });
  await mgr.initialize({ model: 'opus-4.7', activeSchedules: 0, recentErrors: 0, memorySize: 0 });
  assert.ok(events.some((e) => e.op === 'placeholder'));
  assert.ok(events.some((e) => e.op === 'pin'));
});

test('update is throttled', async () => {
  const { connector, events } = stubConnector();
  const mgr = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 50 });
  await mgr.initialize({ model: 'm', activeSchedules: 0, recentErrors: 0, memorySize: 0 });
  const baseline = events.filter((e) => e.op === 'edit').length;
  for (let i = 0; i < 5; i++) {
    await mgr.update({ model: `m${i}`, activeSchedules: i, recentErrors: 0, memorySize: 0 });
  }
  // throttled：5 次連續 update 不應產生 5 次 edit
  const after = events.filter((e) => e.op === 'edit').length;
  assert.ok(after - baseline < 5);
});

test('update skips unchanged payload', async () => {
  const { connector, events } = stubConnector();
  const mgr = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 0 });
  await mgr.initialize({ model: 'm', activeSchedules: 0, recentErrors: 0, memorySize: 0 });
  const before = events.filter((e) => e.op === 'edit').length;
  await mgr.update({ model: 'm', activeSchedules: 0, recentErrors: 0, memorySize: 0 });
  const after = events.filter((e) => e.op === 'edit').length;
  assert.equal(before, after);
});
