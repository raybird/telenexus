import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramConnector } from '../../src/connectors/telegram.js';

/**
 * issue 0030 Task 3.2（SCN-001、SCN-005）：私聊選單按鈕的設定與恢復。
 * 參數形狀依 Bot API setChatMenuButton／MenuButtonWebApp／MenuButtonDefault。bot 以假物件取代，不連網。
 */
function createConnector() {
  const calls: unknown[] = [];
  const connector = new TelegramConnector('test-token', ['424242']);
  (connector as unknown as { bot: unknown }).bot = {
    telegram: {
      async setChatMenuButton(args: unknown) {
        calls.push(args);
        return true;
      }
    }
  };
  return { connector, calls };
}

test('SCN-001：入口開啟時把私聊的選單按鈕設成 web_app，指向面板網址', async () => {
  const { connector, calls } = createConnector();
  await connector.setPanelMenuButton('424242', 'https://a-b.trycloudflare.com/panel/');
  assert.deepEqual(calls, [
    {
      chatId: 424242,
      menuButton: {
        type: 'web_app',
        text: '模型設定',
        web_app: { url: 'https://a-b.trycloudflare.com/panel/' }
      }
    }
  ]);
});

test('SCN-005：入口關閉時恢復成一般選單', async () => {
  const { connector, calls } = createConnector();
  await connector.setPanelMenuButton('424242', null);
  assert.deepEqual(calls, [{ chatId: 424242, menuButton: { type: 'default' } }]);
});

test('SCN-001：不是 HTTPS 的網址不送出（Bot API 要求 HTTPS）', async () => {
  const { connector, calls } = createConnector();
  await assert.rejects(connector.setPanelMenuButton('424242', 'http://telenexus:3040/panel/'));
  assert.deepEqual(calls, []);
});
