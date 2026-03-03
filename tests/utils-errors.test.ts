import test from 'node:test';
import assert from 'node:assert/strict';
import { toErrorMessage, recordRuntimeIssue, getRecentIssues } from '../src/utils/errors.js';

test('toErrorMessage formats Error objects', () => {
  const err = new TypeError('bad input');
  assert.equal(toErrorMessage(err), 'TypeError: bad input');
});

test('toErrorMessage returns string as-is', () => {
  assert.equal(toErrorMessage('plain error'), 'plain error');
});

test('toErrorMessage stringifies other types', () => {
  assert.equal(toErrorMessage(42), '42');
  assert.equal(toErrorMessage(null), 'null');
  assert.equal(toErrorMessage({ code: 'ERR' }), '{"code":"ERR"}');
});

test('recordRuntimeIssue stores issues up to limit', () => {
  const before = getRecentIssues().length;

  for (let i = 0; i < 25; i += 1) {
    recordRuntimeIssue('test-scope', `error-${i}`);
  }

  const issues = getRecentIssues();
  assert.ok(issues.length <= 20, `expected at most 20 issues, got ${issues.length}`);
  assert.ok(issues.length > 0, 'expected at least 1 issue');

  const last = issues[issues.length - 1]!;
  assert.equal(last.scope, 'test-scope');
  assert.equal(last.message, 'error-24');
  assert.equal(typeof last.timestamp, 'number');
});
