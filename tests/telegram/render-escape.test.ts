import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeMarkdownV2, escapeMarkdownV2Code } from '../../src/telegram/render/escape.js';

test('escape special chars: _*[]()~`>#+-=|{}.!', () => {
  assert.equal(
    escapeMarkdownV2('hello_world (test) 1.2!'),
    'hello\\_world \\(test\\) 1\\.2\\!'
  );
});

test('escape preserves CJK and ASCII alphanumerics', () => {
  assert.equal(escapeMarkdownV2('你好 abc 123'), '你好 abc 123');
});

test('code escape only handles ` and \\', () => {
  assert.equal(escapeMarkdownV2Code('a`b\\c'), 'a\\`b\\\\c');
});
