import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStreamRenderer } from '../src/core/telegram-stream-renderer.js';
import type { Connector } from '../src/types/index.js';

type StubConnector = Connector & {
  sent: string[];
  edits: string[];
  deleted: string[];
  lastFormatMode?: string;
};

function makeStubConnector(opts: { withDelete?: boolean } = {}): StubConnector {
  const withDelete = opts.withDelete ?? true;
  const sent: string[] = [];
  const edits: string[] = [];
  const deleted: string[] = [];
  let lastFormatMode: string | undefined;
  const stub: Record<string, unknown> = {
    name: 'stub',
    sent,
    edits,
    deleted,
    get lastFormatMode() {
      return lastFormatMode;
    },
    async initialize() {},
    async sendMessage(_chatId: string, text: string) {
      sent.push(text);
    },
    async sendFile() {},
    async sendPlaceholder() {
      return 'PH';
    },
    async editMessage(_chat: string, _mid: string, text: string, options?: { formatMode?: string }) {
      edits.push(text);
      lastFormatMode = options?.formatMode;
    },
    onMessage() {}
  };
  if (withDelete) {
    stub.deleteMessage = async (_chat: string, mid: string) => {
      deleted.push(mid);
    };
  }
  return stub as unknown as StubConnector;
}

test('finalize uses markdown-v2 formatMode (edit-in-place path)', async () => {
  const stub = makeStubConnector();
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: false,
    finalizeAsNewMessage: false,
    editThrottleMs: 0,
    forceFlushMs: 0
  });
  await r.start();
  await r.handleEvent({ type: 'delta', text: 'hello' });
  await r.finalize('**bold**');
  assert.equal(stub.lastFormatMode, 'markdown-v2');
});

test('reasoning mode renders thinking, then deletes placeholder and sends a new final answer', async () => {
  const stub = makeStubConnector({ withDelete: true });
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    reasoningThrottleMs: 0,
    finalizeAsNewMessage: true
  });
  await r.start();

  await r.handleEvent({ type: 'reasoning', text: '先分析使用者的問題' });
  assert.ok(
    stub.edits.some((e) => e.includes('💭') && e.includes('先分析使用者的問題')),
    `reasoning should appear in placeholder, edits: ${JSON.stringify(stub.edits)}`
  );

  // 純 thinking 模式：答案不可在等待期間漸進顯示
  await r.handleEvent({ type: 'delta', text: '這是最終答案' });
  assert.ok(
    !stub.edits.some((e) => e.includes('回覆中')),
    `answer must not stream progressively, edits: ${JSON.stringify(stub.edits)}`
  );

  await r.finalize('這是最終答案');
  // 占位訊息被刪除，最終答案以新訊息送出（帶完成時間戳）
  assert.deepEqual(stub.deleted, ['PH']);
  assert.equal(stub.sent[stub.sent.length - 1], '這是最終答案');
});

test('reasoning mode falls back to edit-in-place when connector cannot delete', async () => {
  const stub = makeStubConnector({ withDelete: false });
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    reasoningThrottleMs: 0,
    finalizeAsNewMessage: true
  });
  await r.start();
  await r.handleEvent({ type: 'reasoning', text: '思考內容' });
  await r.finalize('答案');
  assert.equal(stub.deleted.length, 0);
  assert.equal(stub.sent.length, 0);
  assert.equal(stub.edits[stub.edits.length - 1], '答案');
});

test('reasoning mode ignores status events (only thinking is shown)', async () => {
  const stub = makeStubConnector();
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    finalizeAsNewMessage: true
  });
  await r.start();
  await r.handleEvent({ type: 'status', text: '🔍 搜尋專案：foo' });
  assert.ok(
    !stub.edits.some((e) => e.includes('搜尋專案')),
    `status must be suppressed in reasoning mode, edits: ${JSON.stringify(stub.edits)}`
  );
  await r.finalize('done');
});
