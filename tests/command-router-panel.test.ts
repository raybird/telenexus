// issue 0030 Task 3.2（SCN-001、SCN-005）：/panel 與 /panel_close 指令。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter } from '../src/core/command-router.js';
import type { OpenResult } from '../src/services/panel-controller.js';

function makeConnector() {
  const sent: Array<[string, string]> = [];
  return {
    sent,
    connector: {
      name: 'stub',
      initialize: async () => {},
      sendMessage: async (chatId: string, text: string) => {
        sent.push([chatId, text]);
      },
      sendFile: async () => {},
      sendPlaceholder: async () => '',
      editMessage: async () => {},
      onMessage: () => {}
    }
  };
}

function makeMsg(
  content: string,
  opts: { userId?: string; chatId?: string; chatType?: string } = {}
) {
  const userId = opts.userId ?? '424242';
  return {
    id: '1',
    chatId: opts.chatId ?? userId,
    content,
    sender: { id: userId, name: 'x', platform: 'telegram' as const },
    timestamp: Date.now(),
    telegram: { updateId: 1, chatType: (opts.chatType ?? 'private') as 'private' }
  };
}

function makePanel(openResult: OpenResult, wasOpen = true) {
  const calls: string[] = [];
  return {
    calls,
    panel: {
      adminUserId: '424242',
      async open() {
        calls.push('open');
        return openResult;
      },
      async close(reason: 'manual') {
        calls.push(`close ${reason}`);
        return { wasOpen };
      }
    }
  };
}

async function run(router: CommandRouter, msg: ReturnType<typeof makeMsg>) {
  const { connector, sent } = makeConnector();
  const handled = await router.handleMessage(msg, {
    connector: connector as never,
    memory: {} as never,
    scheduler: {} as never,
    requestNewSession: () => {}
  });
  return { handled, sent };
}

test('SCN-001：管理員在私聊輸入 /panel，開啟成功時說明用選單按鈕進入與自動關閉', async () => {
  const router = new CommandRouter();
  const { panel, calls } = makePanel({
    ok: true,
    url: 'https://a.trycloudflare.com',
    reused: false
  });
  router.setPanel(panel);
  const { handled, sent } = await run(router, makeMsg('/panel'));
  assert.equal(handled, true);
  assert.deepEqual(calls, ['open']);
  assert.equal(sent.length, 1);
  const text = sent[0]![1];
  assert.match(text, /選單按鈕/);
  assert.match(text, /30 分鐘/);
  assert.match(text, /\/panel_close/);
  assert.match(text, /之前送出的/);
  assert.doesNotMatch(text, /trycloudflare/);
});

test('SCN-001：入口仍有效時回覆沿用', async () => {
  const router = new CommandRouter();
  router.setPanel(makePanel({ ok: true, url: 'https://a.trycloudflare.com', reused: true }).panel);
  const { sent } = await run(router, makeMsg('/panel'));
  assert.match(sent[0]![1], /仍然有效/);
});

test('SCN-001：開啟失敗時回報原因，並說明沒有發布新入口', async () => {
  const router = new CommandRouter();
  router.setPanel(makePanel({ ok: false, message: '連不到 tunnel-manager 服務' }).panel);
  const { sent } = await run(router, makeMsg('/panel'));
  assert.match(sent[0]![1], /^❌/);
  assert.match(sent[0]![1], /連不到 tunnel-manager 服務/);
  assert.match(sent[0]![1], /沒有發布新入口/);
});

test('SCN-002：群組裡或非管理員輸入 /panel 不會啟動 Tunnel', async () => {
  const router = new CommandRouter();
  const { panel, calls } = makePanel({ ok: true, url: 'https://a', reused: false });
  router.setPanel(panel);
  const group = await run(router, makeMsg('/panel', { chatId: '-100123', chatType: 'supergroup' }));
  assert.match(group.sent[0]![1], /私聊/);
  const other = await run(router, makeMsg('/panel', { userId: '999' }));
  assert.match(other.sent[0]![1], /^❌/);
  const closeOther = await run(router, makeMsg('/panel_close', { userId: '999' }));
  assert.match(closeOther.sent[0]![1], /^❌/);
  assert.deepEqual(calls, []);
});

test('SCN-002：Web Console 送來的 /panel、/panel_close 不會啟動或關閉 Tunnel（只限 Telegram 私聊）', async () => {
  // review-87b6cf6 M1：Web Console 的 /api/chat 建立的訊息沒有 telegram 欄位，sender 是管理員 ID
  const router = new CommandRouter();
  const { panel, calls } = makePanel({ ok: true, url: 'https://a', reused: false });
  router.setPanel(panel);
  const consoleMsg = (content: string) => ({
    id: '1',
    chatId: 'web',
    content,
    sender: { id: '424242', name: 'web', platform: 'console' as const },
    timestamp: Date.now()
  });
  for (const content of ['/panel', '/panel_close']) {
    const { handled, sent } = await run(router, consoleMsg(content) as never);
    assert.equal(handled, true, content);
    assert.match(sent[0]![1], /私聊/, content);
  }
  // 平台標成 telegram 卻沒有 chatType 的訊息也一樣拒絕
  const noChat = { ...makeMsg('/panel'), telegram: undefined };
  const { sent } = await run(router, noChat as never);
  assert.match(sent[0]![1], /私聊/);
  assert.deepEqual(calls, []);
});

test('SCN-005：/panel_close 關閉入口並回覆；沒有開啟時說明', async () => {
  const router = new CommandRouter();
  const open = makePanel({ ok: true, url: 'https://a', reused: false }, true);
  router.setPanel(open.panel);
  const closed = await run(router, makeMsg('/panel_close'));
  assert.deepEqual(open.calls, ['close manual']);
  assert.match(closed.sent[0]![1], /已關閉/);

  const idle = makePanel({ ok: true, url: 'https://a', reused: false }, false);
  router.setPanel(idle.panel);
  const notOpen = await run(router, makeMsg('/panel_close'));
  assert.match(notOpen.sent[0]![1], /沒有開啟/);
});

test('SCN-001：沒有設定面板時 /panel 回覆未啟用', async () => {
  const router = new CommandRouter();
  const { handled, sent } = await run(router, makeMsg('/panel'));
  assert.equal(handled, true);
  assert.match(sent[0]![1], /未啟用/);
});
