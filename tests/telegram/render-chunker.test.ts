import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdownV2 } from '../../src/telegram/render/chunker.js';

test('short text returns single chunk', () => {
  const chunks = chunkMarkdownV2('hello', 4096);
  assert.deepEqual(chunks, ['hello']);
});

test('splits at paragraph boundary', () => {
  const para = 'a'.repeat(2000);
  const input = `${para}\n\n${para}\n\n${para}`;
  const chunks = chunkMarkdownV2(input, 4096);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0]!.length <= 4096);
});

test('does not break inside fenced code block', () => {
  const code = '```\n' + 'x'.repeat(100) + '\n```';
  const filler = 'y'.repeat(4000);
  const input = `${filler}\n\n${code}`;
  const chunks = chunkMarkdownV2(input, 4096);
  for (const chunk of chunks) {
    const opens = (chunk.match(/```/g) ?? []).length;
    assert.equal(opens % 2, 0, 'code fences must be balanced inside a chunk');
  }
});

test('hard split a single oversized line', () => {
  const huge = 'a'.repeat(10000);
  const chunks = chunkMarkdownV2(huge, 4096);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 4096);
});
