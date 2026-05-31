import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter } from '../src/core/command-router.js';
import { executionQueue } from '../src/core/execution-queue.js';

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
    timestamp: Date.now()
  };
}

const fakeDeps = (connector: unknown) => ({
  connector: connector as never,
  memory: {} as never,
  scheduler: {} as never,
  requestNewSession: () => {}
});

test('/abort cancels the running task', async () => {
  const { connector, sent } = makeStubConnector();
  const router = new CommandRouter();

  void executionQueue.enqueue('u1', 'chat', 'high', async ({ signal }) =>
    new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('done'))))
  ).catch(() => {});

  await new Promise((r) => setTimeout(r, 10));

  await router.handleMessage(makeMsg('/abort'), fakeDeps(connector));

  assert.ok(sent.length > 0, 'should have sent a reply');
  assert.ok(sent[0]!.includes('已中止'), `expected 已中止, got: ${sent[0]}`);
});

test('/abort on idle returns info message', async () => {
  const { connector, sent } = makeStubConnector();
  const router = new CommandRouter();

  await router.handleMessage(makeMsg('/abort', 'u_idle'), fakeDeps(connector));

  assert.ok(sent.length > 0);
  assert.ok(sent[0]!.includes('沒有正在執行'), `expected 沒有正在執行, got: ${sent[0]}`);
});
