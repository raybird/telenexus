import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStreamRenderer } from '../src/core/telegram-stream-renderer.js';
import type { Connector } from '../src/types/index.js';

function makeStubConnector(): Connector & { sent: string[]; edits: string[]; lastFormatMode?: string } {
  const sent: string[] = [];
  const edits: string[] = [];
  let lastFormatMode: string | undefined;
  const stub = {
    name: 'stub',
    sent,
    edits,
    get lastFormatMode() { return lastFormatMode; },
    async initialize() {},
    async sendMessage(_chatId: string, text: string) { sent.push(text); },
    async sendFile() {},
    async sendPlaceholder() { return 'PH'; },
    async editMessage(_chat: string, _mid: string, text: string, opts?: { formatMode?: string }) {
      edits.push(text);
      lastFormatMode = opts?.formatMode;
    },
    onMessage() {}
  };
  return stub as unknown as Connector & { sent: string[]; edits: string[]; lastFormatMode?: string };
}

test('finalize uses markdown-v2 formatMode', async () => {
  const stub = makeStubConnector();
  const r = new TelegramStreamRenderer(stub, '123', { editThrottleMs: 0, forceFlushMs: 0 });
  await r.start();
  await r.handleEvent({ type: 'delta', text: 'hello' });
  await r.finalize('**bold**');
  assert.equal(stub.lastFormatMode, 'markdown-v2');
});
