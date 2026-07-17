import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStreamRenderer } from '../src/core/telegram-stream-renderer.js';
import type { Connector } from '../src/types/index.js';

type StubConnector = Connector & {
  sent: string[];
  edits: string[];
  deleted: string[];
  placeholderCount: number;
  lastFormatMode?: string;
};

function makeStubConnector(opts: { withDelete?: boolean } = {}): StubConnector {
  const withDelete = opts.withDelete ?? true;
  const sent: string[] = [];
  const edits: string[] = [];
  const deleted: string[] = [];
  let placeholderCount = 0;
  let lastFormatMode: string | undefined;
  const stub: Record<string, unknown> = {
    name: 'stub',
    sent,
    edits,
    deleted,
    get placeholderCount() {
      return placeholderCount;
    },
    get lastFormatMode() {
      return lastFormatMode;
    },
    async initialize() {},
    async sendMessage(_chatId: string, text: string) {
      sent.push(text);
    },
    async sendFile() {},
    async sendPlaceholder() {
      placeholderCount += 1;
      return 'PH';
    },
    async editMessage(
      _chat: string,
      _mid: string,
      text: string,
      options?: { formatMode?: string }
    ) {
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
  assert.deepEqual(stub.sent, ['答案']);
  assert.equal(stub.edits[stub.edits.length - 1], '✅ 已完成');
});

test('reasoning mode renders tool status in the progress display', async () => {
  const stub = makeStubConnector();
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    finalizeAsNewMessage: true
  });
  await r.start();
  await r.handleEvent({ type: 'status', text: '🔍 搜尋專案：foo' });
  assert.ok(stub.edits.some((e) => e.includes('搜尋專案')));
  await r.finalize('done');
});

test('native draft reuses one id and sends the final answer as a normal message', async () => {
  const stub = makeStubConnector();
  const drafts: Array<{
    draftId: number;
    text: string;
    messageThreadId?: number;
  }> = [];
  let finalMessageThreadId: number | undefined;
  stub.sendMessageDraft = async (_chatId, draftId, text, options) => {
    drafts.push({
      draftId,
      text,
      ...(options?.messageThreadId !== undefined
        ? { messageThreadId: options.messageThreadId }
        : {})
    });
  };
  stub.sendChatAction = async () => {};
  stub.sendMessage = async (_chatId, text, options) => {
    stub.sent.push(text);
    finalMessageThreadId = options?.messageThreadId;
  };

  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    reasoningThrottleMs: 0,
    nativeDraft: { draftId: 88, messageThreadId: 7 },
    draftRefreshMs: 60_000,
    typingRefreshMs: 60_000
  });
  await r.start();
  await r.handleEvent({ type: 'reasoning', text: '先分析問題' });
  await r.handleEvent({ type: 'status', text: '🔍 搜尋專案：foo' });
  await r.finalize('最終答案');

  assert.equal(stub.placeholderCount, 0);
  assert.ok(drafts.length >= 3);
  assert.ok(drafts.every((draft) => draft.draftId === 88));
  assert.ok(drafts.some((draft) => draft.text.includes('搜尋專案')));
  assert.equal(finalMessageThreadId, 7);
  assert.deepEqual(stub.sent, ['最終答案']);
  assert.deepEqual(stub.deleted, []);
});

test('native draft start failure falls back to one persistent progress message', async () => {
  const stub = makeStubConnector();
  stub.sendMessageDraft = async () => {
    throw new Error('draft unsupported');
  };
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    nativeDraft: { draftId: 89 }
  });

  await r.start();
  await r.handleEvent({ type: 'status', text: '🔍 fallback status' });
  await r.finalize('fallback answer');

  assert.equal(stub.placeholderCount, 1);
  assert.ok(stub.edits.some((text) => text.includes('fallback status')));
  assert.deepEqual(stub.deleted, ['PH']);
  assert.deepEqual(stub.sent, ['fallback answer']);
});

test('midstream native draft failure transitions to fallback only once', async () => {
  const stub = makeStubConnector();
  let draftCalls = 0;
  stub.sendMessageDraft = async () => {
    draftCalls += 1;
    if (draftCalls === 2) {
      throw new Error('draft expired');
    }
  };
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    nativeDraft: { draftId: 90 },
    draftRefreshMs: 60_000
  });

  await r.start();
  await r.handleEvent({ type: 'status', text: '🔍 first status' });
  await r.handleEvent({ type: 'status', text: '📖 second status' });
  await r.finalize('done after fallback');

  assert.equal(draftCalls, 2);
  assert.equal(stub.placeholderCount, 1);
  assert.ok(stub.edits.some((text) => text.includes('second status')));
  assert.deepEqual(stub.sent, ['done after fallback']);
});

test('native draft bounds long reasoning without broken UTF-16 pairs', async () => {
  const stub = makeStubConnector();
  const draftTexts: string[] = [];
  stub.sendMessageDraft = async (_chatId, _draftId, text) => {
    draftTexts.push(text);
  };
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    reasoningThrottleMs: 0,
    nativeDraft: { draftId: 91 },
    draftRefreshMs: 60_000
  });

  await r.start();
  await r.handleEvent({ type: 'reasoning', text: '😀'.repeat(2500) });
  const rendered = draftTexts[draftTexts.length - 1]!;
  assert.ok(rendered.length <= 3900);
  for (let index = 0; index < rendered.length; index += 1) {
    const code = rendered.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = rendered.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff);
      index += 1;
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff);
    }
  }
  await r.finalize('done');
});

test('native draft failure path sends errors as normal messages', async () => {
  const stub = makeStubConnector();
  const drafts: string[] = [];
  stub.sendMessageDraft = async (_chatId, _draftId, text) => {
    drafts.push(text);
  };
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    nativeDraft: { draftId: 92 },
    draftRefreshMs: 60_000
  });

  await r.start();
  await r.fail('⚠️ 生成失敗');

  assert.deepEqual(stub.sent, ['⚠️ 生成失敗']);
  assert.equal(stub.placeholderCount, 0);
  assert.equal(drafts.length, 1);
});

test('failed final delivery keeps fallback progress available for recovery', async () => {
  const stub = makeStubConnector();
  stub.sendMessage = async () => {
    throw new Error('final delivery failed');
  };
  const r = new TelegramStreamRenderer(stub, '123', {
    reasoningMode: true,
    finalizeAsNewMessage: true
  });

  await r.start();
  await r.handleEvent({ type: 'reasoning', text: '仍在處理' });
  await assert.rejects(() => r.finalize('不能送達的答案'), /final delivery failed/);

  assert.deepEqual(stub.deleted, []);
  assert.ok(!stub.edits.includes('✅ 已完成'));
});
