import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownV2 } from '../../src/telegram/render/markdown-v2.js';

test('plain paragraph escapes specials', () => {
  assert.equal(renderMarkdownV2('hello (world).'), 'hello \\(world\\)\\.');
});

test('bold via **', () => {
  assert.equal(renderMarkdownV2('see **here** now'), 'see *here* now');
});

test('italic via _', () => {
  assert.equal(renderMarkdownV2('a *b* c'), 'a _b_ c');
});

test('inline code', () => {
  assert.equal(renderMarkdownV2('use `npm run` to start'), 'use `npm run` to start');
});

test('fenced code with language', () => {
  const md = '```ts\nconst x = 1;\n```';
  const out = renderMarkdownV2(md);
  assert.ok(out.startsWith('```ts\n'));
  assert.ok(out.endsWith('\n```'));
  assert.ok(out.includes('const x = 1;'));
});

test('heading -> bold + underline for level 1', () => {
  assert.equal(renderMarkdownV2('# Title'), '*__Title__*');
});

test('bullet list', () => {
  const out = renderMarkdownV2('- a\n- b');
  assert.equal(out, '• a\n• b');
});

test('link', () => {
  assert.equal(renderMarkdownV2('[GH](https://github.com/foo)'), '[GH](https://github.com/foo)');
});

test('blockquote', () => {
  assert.equal(renderMarkdownV2('> quoted line'), '>quoted line');
});

test('falls back to escaped plain text on parse error', () => {
  const broken = '**unclosed';
  const out = renderMarkdownV2(broken);
  assert.ok(out.includes('unclosed'));
});

// ---- issue 0027 ----

/** 去掉 MarkdownV2 的跳脫，留下可比對字詞的純文字。 */
function unescapeV2(text: string): string {
  return text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1');
}

/** 原文的每個字詞（依空白切開）都要出現在去掉跳脫後的輸出裡。 */
function assertKeepsWords(md: string, words: string[]): void {
  const plain = unescapeV2(renderMarkdownV2(md));
  for (const w of words) {
    assert.ok(plain.includes(w), `missing "${w}" in:\n${plain}`);
  }
}

test('AC-1: nested lists keep every level with indent and level bullets', () => {
  const md = [
    '- 第一層 A',
    '  - 第二層 A-1',
    '    - 第三層 A-1-a',
    '      - 第四層',
    '  - 第二層 A-2',
    '- 第一層 B'
  ].join('\n');
  assert.equal(
    renderMarkdownV2(md),
    [
      '• 第一層 A',
      '  ◦ 第二層 A\\-1',
      '    ▪ 第三層 A\\-1\\-a',
      '      ▪ 第四層',
      '  ◦ 第二層 A\\-2',
      '• 第一層 B'
    ].join('\n')
  );
});

test('AC-1: ordered inside unordered and unordered inside ordered', () => {
  const md = [
    '1. 第一點',
    '   - 子項 甲',
    '   - 子項 乙',
    '2. 第二點',
    '   1. 子編號一',
    '   2. 子編號二'
  ].join('\n');
  assert.equal(
    renderMarkdownV2(md),
    [
      '1\\. 第一點',
      '  ◦ 子項 甲',
      '  ◦ 子項 乙',
      '2\\. 第二點',
      '  1\\. 子編號一',
      '  2\\. 子編號二'
    ].join('\n')
  );
});

test('AC-1: later paragraphs of an item start a new line at the item indent', () => {
  assert.equal(renderMarkdownV2('- 第一段\n\n  第二段'), '• 第一段\n第二段');
  assert.equal(
    renderMarkdownV2('- 外層\n  - 第一段\n\n    第二段'),
    '• 外層\n  ◦ 第一段\n  第二段'
  );
});

test('AC-2: ordered list keeps start number and escapes the dot', () => {
  assert.equal(renderMarkdownV2('1. 甲\n2. 乙'), '1\\. 甲\n2\\. 乙');
  assert.equal(renderMarkdownV2('3. 丙\n4. 丁\n5. 戊'), '3\\. 丙\n4\\. 丁\n5\\. 戊');
});

test('AC-3: heading levels 1-2 bold+underline, 3-6 bold, separated by blank lines', () => {
  const md = ['# H1', '## H2', '### H3', '#### H4', '##### H5', '###### H6'].join('\n');
  assert.equal(
    renderMarkdownV2(md),
    ['*__H1__*', '*__H2__*', '*H3*', '*H4*', '*H5*', '*H6*'].join('\n\n')
  );
});

test('AC-4: code block inside a list item is kept as a code block', () => {
  const md = '1. 執行：\n\n   ```bash\n   npm test\n   ```\n2. 完成';
  const out = renderMarkdownV2(md);
  assert.ok(out.includes('```bash\nnpm test\n```'), out);
  assert.ok(out.startsWith('1\\. 執行：'), out);
  assert.ok(out.includes('2\\. 完成'), out);
});

test('AC-4: blockquote and heading inside a list item are kept', () => {
  const md = '- 項目\n\n  > 引言內容\n\n  ### 小標題';
  const out = renderMarkdownV2(md);
  assert.ok(out.split('\n').includes('>引言內容'), out);
  assert.ok(out.includes('*小標題*'), out);
});

test('AC-4: list and code inside a blockquote are kept, every line quoted', () => {
  const md = '> 引言一\n>\n> - 引言清單 甲\n> - 引言清單 乙\n>\n> ```\n> code line\n> ```';
  const out = renderMarkdownV2(md);
  const lines = out.split('\n');
  assert.ok(
    lines.every((l) => l.startsWith('>')),
    out
  );
  // Telegram 的引言裡不能放程式碼區塊：程式碼改成純文字，不留 fence。
  assert.ok(!out.includes('```'), out);
  assert.ok(lines.includes('>code line'), out);
  assertKeepsWords(md, ['引言一', '甲', '乙', 'code', 'line']);
});

test('AC-4: unknown block and inline nodes fall back to escaped source', () => {
  assert.equal(renderMarkdownV2('前 <b>粗</b> 後'), '前 <b\\>粗</b\\> 後');
  assert.equal(
    renderMarkdownV2('看 ![圖說](https://x.y/a.png) 這'),
    '看 \\!\\[圖說\\]\\(https://x\\.y/a\\.png\\) 這'
  );
  assert.equal(renderMarkdownV2('<div>\n區塊\n</div>'), '<div\\>\n區塊\n</div\\>');
});

test('AC-4: think tags are dropped but surrounding text is kept', () => {
  assert.equal(renderMarkdownV2('reasoning done.</think>結論在此'), 'reasoning done\\.結論在此');
  assert.equal(renderMarkdownV2('推理\n\n</think>\n\n# 報告'), '推理\n\n*__報告__*');
  const out = renderMarkdownV2('</think>\n結論 甲');
  assert.ok(!out.includes('think'), out);
  assert.ok(unescapeV2(out).includes('結論 甲'), out);
});

test('AC-4: no word of a mixed document is lost', () => {
  const md = [
    '## 結論',
    '1. 技術面',
    '   - BTC：支撐 **$76,326**',
    '     - 跌破 看 $74,000',
    '   - ETH：支撐 $2,174',
    '2. 指令',
    '   ```',
    '   npm run build',
    '   ```',
    '   > 注意 事項',
    '',
    '> 引言 開頭',
    '> 1. 引言 編號',
    '',
    '<span>標籤 文字</span> 與 ![替代 文字](https://example.com/p.png)'
  ].join('\n');
  assertKeepsWords(md, [
    '結論',
    '技術面',
    'BTC：支撐',
    '$76,326',
    '跌破',
    '$74,000',
    'ETH：支撐',
    '$2,174',
    '指令',
    'npm',
    'run',
    'build',
    '注意',
    '事項',
    '引言',
    '開頭',
    '編號',
    '<span>標籤',
    '文字</span>',
    '替代',
    'https://example.com/p.png'
  ]);
});

test('AC-6: paragraph-only bullet lists and blockquotes render as before', () => {
  assert.equal(renderMarkdownV2('- 甲\n- 乙\n\n段落'), '• 甲\n• 乙\n\n段落');
  assert.equal(renderMarkdownV2('> 第一行\n>\n> 第二段'), '>第一行\n>第二段');
});
