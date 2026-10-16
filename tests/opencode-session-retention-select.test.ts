import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectSessionsToDelete,
  type RetentionCandidate
} from '../src/services/opencode-session-retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

function session(id: string, ageDays: number | null, parentId: string | null = null): RetentionCandidate {
  return { id, updatedAt: ageDays === null ? null : NOW - ageDays * DAY, parentId };
}

function select(
  sessions: RetentionCandidate[],
  options: { protectedIds?: string[]; retentionDays?: number; limit?: number } = {}
): string[] {
  return selectSessionsToDelete({
    sessions,
    protectedIds: new Set(options.protectedIds ?? []),
    now: NOW,
    retentionDays: options.retentionDays ?? 30,
    limit: options.limit ?? 100
  });
}

test('SCN-001: 只選最後更新早於保留期的 session，剛好在邊界上的保留', () => {
  const result = select([session('new', 10), session('old', 40), session('edge', 30)]);
  assert.deepEqual(result, ['old']);
});

test('SCN-001: 保留天數可調整', () => {
  const result = select([session('a', 10), session('b', 40)], { retentionDays: 7 });
  assert.deepEqual(result, ['b', 'a']);
});

test('SCN-002: 綁定中的聊天 session 已過期也不選', () => {
  const result = select([session('bound', 100), session('other', 50)], { protectedIds: ['bound'] });
  assert.deepEqual(result, ['other']);
});

test('SCN-002: 沒有任何綁定時，過期的全部依最舊優先選出', () => {
  const result = select([session('b', 45), session('a', 90), session('c', 31)]);
  assert.deepEqual(result, ['a', 'b', 'c']);
});

test('SCN-001: session 清單為空時不選任何 session', () => {
  assert.deepEqual(select([]), []);
});

test('SCN-001: 超過上限時只取最舊的幾個', () => {
  const result = select(
    [session('d', 60), session('a', 200), session('e', 35), session('b', 150), session('c', 90)],
    { limit: 2 }
  );
  assert.deepEqual(result, ['a', 'b']);
});

test('SCN-001: 最後更新時間缺漏的 session 不選', () => {
  const result = select([
    session('missing', null),
    { id: 'nan', updatedAt: Number.NaN, parentId: null },
    session('old', 40)
  ]);
  assert.deepEqual(result, ['old']);
});

test('SCN-001: 子 session 不單獨選，它會隨父 session 一併刪除', () => {
  const result = select([session('parent', 40), session('child', 40, 'parent')]);
  assert.deepEqual(result, ['parent']);
});
