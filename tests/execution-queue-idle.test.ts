import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionQueue } from '../src/core/execution-queue.js';

test('issue 0009 SCN-006: 沒有任何工作時 isIdle 為 true，執行中與排隊中為 false', async () => {
  const q = new ExecutionQueue();
  assert.equal(q.isIdle(), true);

  let releaseFirst: () => void = () => {};
  const first = q.enqueue(
    'u1',
    'chat',
    'high',
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })
  );
  let releaseSecond: () => void = () => {};
  const second = q.enqueue(
    'u2',
    'scheduler-task',
    'low',
    () =>
      new Promise<void>((resolve) => {
        releaseSecond = resolve;
      })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(q.isIdle(), false);

  releaseFirst();
  await first;
  assert.equal(q.isIdle(), false);

  releaseSecond();
  await second;
  assert.equal(q.isIdle(), true);
});
