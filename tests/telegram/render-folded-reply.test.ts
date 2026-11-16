import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFoldedMessages } from '../../src/telegram/render/folded-reply.js';
import { renderMarkdownV2 } from '../../src/telegram/render/markdown-v2.js';

/**
 * Issue 0028 步驟 4:結論在前、過程收進可展開引言。寫法依步驟 2 實測定案
 * (docs/issues/issue-0028/evidence/step2-telegram-probe.md):第一行 `**>過程`,每行前加 `>`,
 * 段落之間一個空的引言行,最後一行結尾加 `||`。
 */
const render = (markdown: string): string => renderMarkdownV2(markdown);

test('SCN-001：一則訊息裡結論在前、過程摺疊在後，各段分開', () => {
  const messages = buildFoldedMessages(
    {
      conclusion: '[Opencode] **結論**：兩源一致。',
      process: ['數據已到手。', '改用 CoinGecko。']
    },
    render
  );
  assert.deepEqual(messages, [
    {
      markdownV2:
        '\\[Opencode\\] *結論*：兩源一致。\n\n**>過程\n>數據已到手。\n>\n>改用 CoinGecko。||',
      plain: '[Opencode] **結論**：兩源一致。\n\n過程\n\n數據已到手。\n\n改用 CoinGecko。'
    }
  ]);
});

test('SCN-001：過程段落裡的空行也寫成空的引言行', () => {
  const [message] = buildFoldedMessages(
    { conclusion: '結論', process: ['第一行\n\n- 項目 甲\n- 項目 乙'] },
    render
  );
  assert.equal(message?.markdownV2, '結論\n\n**>過程\n>第一行\n>\n>• 項目 甲\n>• 項目 乙||');
});

test('SCN-011：排程標頭在第一行，跳脫後接結論與過程', () => {
  const [message] = buildFoldedMessages(
    {
      header: '🕐 [排程: Crypto Monitor]',
      conclusion: '[Opencode] 偏弱整理。',
      process: ['已取得報價。']
    },
    render
  );
  assert.equal(
    message?.markdownV2,
    '🕐 \\[排程: Crypto Monitor\\]\n\n\\[Opencode\\] 偏弱整理。\n\n**>過程\n>已取得報價。||'
  );
  assert.equal(
    message?.plain,
    '🕐 [排程: Crypto Monitor]\n\n[Opencode] 偏弱整理。\n\n過程\n\n已取得報價。'
  );
});

test('過程以程式碼區塊結尾時，|| 接在結尾的 fence 後面', () => {
  const [message] = buildFoldedMessages(
    { conclusion: '結論', process: ['```\nls -la\n```'] },
    render
  );
  assert.equal(message?.markdownV2, '結論\n\n**>過程\n>```\n>ls -la\n>```||');
});

/** 每個字詞都帶唯一編號,合起來檢查有沒有遺漏。 */
const words = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
const paragraphs = (items: string[], perParagraph: number): string =>
  Array.from({ length: Math.ceil(items.length / perParagraph) }, (_, i) =>
    items.slice(i * perParagraph, (i + 1) * perParagraph).join(' ')
  ).join('\n\n');

function assertCompleteQuote(markdownV2: string): void {
  const lines = markdownV2.split('\n');
  assert.ok(lines[0]?.startsWith('**>過程'), `第一行應為 **>過程：${lines[0]}`);
  assert.ok(lines.at(-1)?.endsWith('||'), `最後一行應以 || 結尾：${lines.at(-1)}`);
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith('>'), `引言裡的每一行都要以 > 開頭：${line}`);
  }
}

test('SCN-004：超過 4096 字時，結論照現有切段送出，過程另起完整的摺疊引言，字詞都在', () => {
  const conclusionWords = words('結', 600);
  const processSegments = [words('甲', 300), words('乙', 300), words('丙', 300)];
  const conclusion = paragraphs(conclusionWords, 20);
  const messages = buildFoldedMessages(
    { conclusion, process: processSegments.map((segment) => paragraphs(segment, 20)) },
    render
  );

  assert.ok(messages.length >= 3, `應拆成多則，實際 ${messages.length} 則`);
  for (const message of messages) {
    assert.ok(message.markdownV2.length <= 4096, `每則不超過 4096：${message.markdownV2.length}`);
  }

  const firstProcess = messages.findIndex((message) => message.markdownV2.startsWith('**>'));
  assert.ok(firstProcess > 0, '過程在結論之後');
  const conclusionMessages = messages.slice(0, firstProcess);
  const processMessages = messages.slice(firstProcess);
  // 結論的切段與變更前的 sendMessage 相同:整段渲染後依行切成 4096 以內。
  assert.equal(conclusionMessages.map((m) => m.markdownV2).join('\n'), render(conclusion));
  for (const message of conclusionMessages) {
    assert.ok(!message.markdownV2.includes('**>'), '結論訊息不含引言');
  }
  for (const message of processMessages) {
    assertCompleteQuote(message.markdownV2);
  }

  const all = messages.map((message) => message.markdownV2).join('\n');
  for (const word of [...conclusionWords, ...processSegments.flat()]) {
    assert.ok(all.includes(word), `缺少字詞 ${word}`);
  }
});

test('SCN-004：單一段過程本身超過 4096 字時切成多則，每則都是完整引言', () => {
  const segmentWords = words('丁', 1200);
  const messages = buildFoldedMessages(
    { conclusion: '結論', process: [paragraphs(segmentWords, 20)] },
    render
  );
  const processMessages = messages.filter((message) => message.markdownV2.startsWith('**>'));
  assert.ok(processMessages.length >= 2, `應切成多則，實際 ${processMessages.length} 則`);
  for (const message of processMessages) {
    assert.ok(message.markdownV2.length <= 4096);
    assertCompleteQuote(message.markdownV2);
  }
  const all = messages.map((message) => message.markdownV2).join('\n');
  for (const word of segmentWords) {
    assert.ok(all.includes(word), `缺少字詞 ${word}`);
  }
});

test('SCN-006：每則的純文字版本都不含引言標記', () => {
  const messages = buildFoldedMessages(
    {
      header: '🕐 [排程: 測試]',
      conclusion: paragraphs(words('結', 600), 20),
      process: [paragraphs(words('甲', 300), 20), paragraphs(words('乙', 300), 20)]
    },
    render
  );
  for (const message of messages) {
    if (message.plain === undefined) continue;
    assert.ok(!message.plain.includes('**>'), message.plain.slice(0, 80));
    assert.ok(!message.plain.includes('||'), message.plain.slice(0, 80));
  }
  const processPlain = messages.filter((message) => message.markdownV2.startsWith('**>'));
  for (const message of processPlain) {
    assert.ok(message.plain?.startsWith('過程\n\n'), '過程訊息的純文字版以「過程」開頭');
  }
});

test('SCN-004：超長的程式碼區塊切在中間時，每則的 fence 都成對、內容仍是程式碼', () => {
  const codeWords = words('碼', 800);
  const segment = ['```bash', ...codeWords.map((word) => `echo ${word} (x) *y*`), '```'].join('\n');
  const messages = buildFoldedMessages({ conclusion: '結論', process: [segment] }, render);
  const processMessages = messages.filter((message) => message.markdownV2.startsWith('**>'));
  assert.ok(processMessages.length >= 2, `應切成多則，實際 ${processMessages.length} 則`);
  for (const message of processMessages) {
    assert.ok(message.markdownV2.length <= 4096);
    assertCompleteQuote(message.markdownV2);
    const fences = message.markdownV2.split('\n').filter((line) => /^\*{0,2}>```/.test(line));
    assert.equal(fences.length % 2, 0, `fence 不成對：${fences.join(' / ')}`);
    // 程式碼裡的 ( ) * 不跳脫；被當成一般文字時會變成 \( \) \*。
    assert.ok(!message.markdownV2.includes('\\('), '切開後的內容仍在程式碼區塊裡');
  }
  const all = messages.map((message) => message.markdownV2).join('\n');
  for (const word of codeWords) {
    assert.ok(all.includes(word), `缺少字詞 ${word}`);
  }
});
