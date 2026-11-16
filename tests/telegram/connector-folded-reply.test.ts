import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramConnector } from '../../src/connectors/telegram.js';

/**
 * Issue 0028 SCN-006：帶過程的訊息被 Telegram 以 parse error 拒收時，改送原文組成的純文字，
 * 不把已渲染的 MarkdownV2 當純文字送出（`**>`、`||` 會外露）。bot 以假物件取代，不連網。
 */
type Sent = { text: string; parseMode?: string };

function createConnector(rejectMarkdownV2: (text: string) => boolean) {
  const sent: Sent[] = [];
  const connector = new TelegramConnector('test-token', ['1']);
  const parseError = Object.assign(new Error("400: Bad Request: can't parse entities"), {
    response: {
      error_code: 400,
      description:
        "Bad Request: can't parse entities: Character '.' is reserved and must be escaped with the preceding '\\'"
    }
  });
  (connector as unknown as { bot: unknown }).bot = {
    telegram: {
      async sendMessage(_chatId: string, text: string, extra?: { parse_mode?: string }) {
        if (extra?.parse_mode === 'MarkdownV2' && rejectMarkdownV2(text)) {
          throw parseError;
        }
        sent.push({ text, ...(extra?.parse_mode ? { parseMode: extra.parse_mode } : {}) });
        return { message_id: sent.length };
      }
    }
  };
  return { connector, sent };
}

const reply = {
  header: '🕐 [排程: 測試]',
  conclusion: '[Opencode] **結論**：兩源一致。',
  process: ['數據已到手。', '改用 CoinGecko。']
};

test('SCN-001：一則以 MarkdownV2 送出，結論在前、過程摺疊在後', async () => {
  const { connector, sent } = createConnector(() => false);
  await connector.sendFoldedReply('1', reply);
  assert.deepEqual(sent, [
    {
      text: '🕐 \\[排程: 測試\\]\n\n\\[Opencode\\] *結論*：兩源一致。\n\n**>過程\n>數據已到手。\n>\n>改用 CoinGecko。||',
      parseMode: 'MarkdownV2'
    }
  ]);
});

test('SCN-006：被拒收時改送原文的純文字，不含引言標記', async () => {
  const { connector, sent } = createConnector(() => true);
  await connector.sendFoldedReply('1', reply);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.parseMode, undefined);
  assert.equal(
    sent[0]?.text,
    '🕐 [排程: 測試]\n\n[Opencode] **結論**：兩源一致。\n\n過程\n\n數據已到手。\n\n改用 CoinGecko。'
  );
  assert.ok(!sent[0]?.text.includes('**>'));
  assert.ok(!sent[0]?.text.includes('||'));
});

test('SCN-004＋SCN-006：超長時只有被拒收的那則退回純文字，其他照 MarkdownV2 送', async () => {
  const words = Array.from({ length: 900 }, (_, i) => `字${String(i).padStart(4, '0')}`);
  const paragraph = (items: string[]) => items.join(' ');
  const { connector, sent } = createConnector((text) => text.startsWith('**>'));
  await connector.sendFoldedReply('1', {
    conclusion: paragraph(words.slice(0, 600)),
    process: [paragraph(words.slice(600, 750)), paragraph(words.slice(750))]
  });
  const conclusionMessages = sent.filter((item) => item.parseMode === 'MarkdownV2');
  const plainMessages = sent.filter((item) => item.parseMode === undefined);
  assert.ok(conclusionMessages.length >= 1);
  assert.ok(plainMessages.length >= 1);
  for (const item of plainMessages) {
    assert.ok(item.text.startsWith('過程\n\n'), item.text.slice(0, 40));
    assert.ok(!item.text.includes('**>') && !item.text.includes('||'));
  }
  const all = sent.map((item) => item.text).join('\n');
  for (const word of words) {
    assert.ok(all.includes(word), `缺少字詞 ${word}`);
  }
});

test('SCN-012：沒有過程時只送結論，不產生引言', async () => {
  const { connector, sent } = createConnector(() => false);
  await connector.sendFoldedReply('1', {
    header: '🕐 [排程: 測試]',
    conclusion: '[Opencode] 報告 1.5%',
    process: []
  });
  assert.deepEqual(sent, [
    { text: '🕐 \\[排程: 測試\\]\n\n\\[Opencode\\] 報告 1\\.5%', parseMode: 'MarkdownV2' }
  ]);
});
