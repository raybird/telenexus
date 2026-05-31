import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionQueue } from '../src/core/execution-queue.js';

test('cancel rejects current task with EABORTED and aborts signal', async () => {
  const q = new ExecutionQueue();
  let observedAbort = false;
  const task = q.enqueue('u1', 'chat', 'high', async ({ signal }) => {
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        observedAbort = true;
        reject(new Error('aborted'));
      });
    });
  });
  setTimeout(() => q.cancel('u1'), 30);
  await assert.rejects(task, /aborted/);
  assert.equal(observedAbort, true);
});

test('cancel clears pending tasks', async () => {
  const q = new ExecutionQueue();
  let running = 0;
  const slow = q.enqueue('u1', 'a', 'high', async () => {
    running++;
    await new Promise((r) => setTimeout(r, 100));
    return 'slow-done';
  });
  const pending = q.enqueue('u1', 'b', 'normal', async () => 'pending-done');
  setTimeout(() => q.cancel('u1'), 20);
  await assert.rejects(slow);
  await assert.rejects(pending);
  assert.equal(running, 1);
});

test('cancel on idle user is a no-op', () => {
  const q = new ExecutionQueue();
  assert.equal(q.cancel('nobody'), false);
});
