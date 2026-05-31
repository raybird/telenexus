import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter } from '../src/core/command-router.js';
import { interactionGuard } from '../src/services/interaction-guard.js';

function makeStubConnector() {
  const sent: string[] = [];
  return {
    sent,
    connector: {
      name: 'stub',
      initialize: async () => {},
      sendMessage: async (_c: string, text: string) => { sent.push(text); },
      sendFile: async () => {},
      sendPlaceholder: async () => '',
      editMessage: async () => {},
      onMessage: () => {}
    }
  };
}

function makeMsg(content: string, userId = 'u1') {
  return {
    id: '1',
    chatId: userId,
    content,
    sender: { id: userId, name: 'x', platform: 'telegram' as const },
    timestamp: 0
  };
}

const fakeDeps = (connector: unknown) => ({
  connector: connector as never,
  memory: {} as never,
  scheduler: {} as never,
  requestNewSession: () => {}
});

test('blocks non-whitelisted command during interaction', async () => {
  interactionGuard.start('u_guard1', { kind: 'add_schedule', expectedInput: 'time', allowedCommands: ['/abort'] });
  const { connector, sent } = makeStubConnector();
  const router = new CommandRouter();

  await router.handleMessage(makeMsg('/start', 'u_guard1'), fakeDeps(connector));

  assert.ok(sent[0]?.includes('add_schedule'), `expected add_schedule in: ${sent[0]}`);
  interactionGuard.clear('u_guard1', 'test-cleanup');
});

test('allows /abort during interaction', async () => {
  interactionGuard.start('u_guard2', { kind: 'add_schedule', expectedInput: 'time', allowedCommands: ['/abort'] });
  const { connector, sent } = makeStubConnector();
  const router = new CommandRouter();

  await router.handleMessage(makeMsg('/abort', 'u_guard2'), fakeDeps(connector));

  assert.ok(!sent[0]?.includes('流程中'), `should not show guard message, got: ${sent[0]}`);
  interactionGuard.clear('u_guard2', 'test-cleanup');
});

test('no guard: normal command passes through', async () => {
  const { connector, sent } = makeStubConnector();
  const router = new CommandRouter();

  const handled = await router.handleMessage(makeMsg('/start', 'u_guard3'), fakeDeps(connector));

  assert.equal(handled, true);
  assert.ok(sent.length > 0);
});
