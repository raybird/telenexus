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

test('recordRuntimeIssue 的 dedupe 不會因陣列順序被打亂而失效', () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;

  try {
    // 命中 dedupe 時會就地改寫 timestamp。若該筆留在原位,陣列就不再依 timestamp 遞增,
    // 反向掃描會在它後方那筆較舊的項目上誤判「超出視窗」而 break,掃不到仍在視窗內的同類項。
    clock = 1_000_000;
    recordRuntimeIssue('dedupe-order-a', 'boom');
    clock = 1_001_000;
    recordRuntimeIssue('dedupe-order-b', 'other');
    clock = 1_059_000;
    recordRuntimeIssue('dedupe-order-a', 'boom'); // 命中 dedupe(距首次 59s,仍在 60s 視窗內)
    clock = 1_062_000;
    recordRuntimeIssue('dedupe-order-a', 'boom'); // 距上一次僅 3s,必須同樣命中 dedupe

    const mine = getRecentIssues().filter((issue) => issue.scope === 'dedupe-order-a');
    assert.equal(mine.length, 1, '同 scope+message 在視窗內只該有一筆');
    assert.equal(mine[0]!.count, 3, '三次相同 issue 應累加到同一筆的 count');
  } finally {
    Date.now = realNow;
  }
});

test('recordRuntimeIssue 超出視窗後仍會建立新筆', () => {
  const realNow = Date.now;
  let clock = 2_000_000;
  Date.now = () => clock;

  try {
    recordRuntimeIssue('dedupe-window', 'expired');
    clock = 2_000_000 + 60_001; // 剛好超出 60s 視窗
    recordRuntimeIssue('dedupe-window', 'expired');

    const mine = getRecentIssues().filter((issue) => issue.scope === 'dedupe-window');
    assert.equal(mine.length, 2, '超出視窗應視為新事件');
  } finally {
    Date.now = realNow;
  }
});
