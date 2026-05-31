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

test('heading -> bold line', () => {
  assert.equal(renderMarkdownV2('# Title'), '*Title*');
});

test('bullet list', () => {
  const out = renderMarkdownV2('- a\n- b');
  assert.equal(out, '• a\n• b');
});

test('link', () => {
  assert.equal(
    renderMarkdownV2('[GH](https://github.com/foo)'),
    '[GH](https://github.com/foo)'
  );
});

test('blockquote', () => {
  assert.equal(renderMarkdownV2('> quoted line'), '>quoted line');
});

test('falls back to escaped plain text on parse error', () => {
  const broken = '**unclosed';
  const out = renderMarkdownV2(broken);
  assert.ok(out.includes('unclosed'));
});
