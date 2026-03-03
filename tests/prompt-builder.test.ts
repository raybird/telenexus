import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSummarize } from '../src/prompt/builder.js';

test('shouldSummarize returns true for text longer than 200 chars', () => {
  const longText = 'a'.repeat(201);
  assert.equal(shouldSummarize(longText), true);
});

test('shouldSummarize returns true for text containing code fences', () => {
  assert.equal(shouldSummarize('Here is code:\n```\nconsole.log(1)\n```'), true);
});

test('shouldSummarize returns true for text containing tool_result', () => {
  assert.equal(shouldSummarize('tool_result: success'), true);
});

test('shouldSummarize returns true for text with 6 or more newlines', () => {
  const multiline = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
  assert.equal(shouldSummarize(multiline), true);
});

test('shouldSummarize returns false for short simple text', () => {
  assert.equal(shouldSummarize('hello world'), false);
});

test('shouldSummarize returns false for text just under thresholds', () => {
  const text = 'a'.repeat(200);
  assert.equal(shouldSummarize(text), false);

  const fewLines = 'line1\nline2\nline3\nline4\nline5\nline6';
  assert.equal(shouldSummarize(fewLines), false);
});
