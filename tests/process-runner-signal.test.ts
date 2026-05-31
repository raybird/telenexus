import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, ProcessError } from '../src/core/process-runner.js';

test('abort signal kills child and rejects with EABORTED', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(
    runProcess('sleep', ['10'], { signal: ac.signal }),
    (err: unknown) => err instanceof ProcessError && err.code === 'EABORTED'
  );
});

test('completed-before-abort does not reject', async () => {
  const ac = new AbortController();
  const result = await runProcess('echo', ['hi'], { signal: ac.signal });
  ac.abort();
  assert.equal(result.stdout.trim(), 'hi');
});
