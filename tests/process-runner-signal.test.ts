import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runProcess, ProcessError } from '../src/core/process-runner.js';

/**
 * pid 是否還「活著」。
 *
 * 不能只用 `process.kill(pid, 0)`:已死但尚未被 reap 的 zombie 仍有 pid entry,那樣會回 true,
 * 讓「descendants 有沒有被殺掉」的斷言在收屍空窗期偽陽性。Linux 上改讀 /proc 的 state 欄位,
 * Z 一律當成已死;沒有 /proc 時才退回訊號探測。
 */
function isRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // 格式:`pid (comm) state ...`;comm 可能含空白或括號,所以從最後一個 ')' 之後取。
    const state = stat.slice(stat.lastIndexOf(')') + 2)[0];
    return state !== 'Z';
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isRunning(pid);
}

/** 從 ProcessError 的 stdout 取出被測腳本 echo 出來的 pid。 */
function pidFromStdout(err: unknown): number {
  assert.ok(err instanceof ProcessError, 'expected ProcessError');
  const pid = Number((err.stdout ?? '').trim().split('\n')[0]);
  assert.ok(Number.isInteger(pid) && pid > 0, `expected a pid on stdout, got ${err.stdout}`);
  return pid;
}

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

// —— descendants 清理 ——
// 這組測試釘住的是實際事故:排程結束後 agent-browser + 12 個 chrome + 2 個 crashpad
// 在 Active Lanes=0 的狀態下存活 2 小時以上。成因是 kill 只送給直接 child,
// 孫程序不在收訊範圍內。以「背景孫程序」模擬 Chrome tree。

test('timeout kills descendants, not just the direct child', async () => {
  let grandchild = 0;
  await assert.rejects(
    // `sleep 30 &` 是背景孫程序(對應 Chrome tree),前景 sleep 讓 shell 本身活著。
    runProcess('sh', ['-c', 'sleep 30 & echo $!; sleep 30'], { timeoutMs: 300 }),
    (err: unknown) => {
      grandchild = pidFromStdout(err);
      return err instanceof ProcessError && err.code === 'ETIMEDOUT';
    }
  );
  assert.ok(
    await waitForExit(grandchild, 3000),
    `descendant ${grandchild} survived the timeout — process group was not terminated`
  );
});

test('abort signal kills descendants', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  let grandchild = 0;
  await assert.rejects(
    runProcess('sh', ['-c', 'sleep 30 & echo $!; sleep 30'], { signal: ac.signal }),
    (err: unknown) => {
      grandchild = pidFromStdout(err);
      return err instanceof ProcessError && err.code === 'EABORTED';
    }
  );
  assert.ok(
    await waitForExit(grandchild, 3000),
    `descendant ${grandchild} survived the abort`
  );
});

test('abortOnStderr kills descendants (429 fail-fast path)', async () => {
  let grandchild = 0;
  await assert.rejects(
    runProcess('sh', ['-c', 'sleep 30 & echo $!; echo "HTTP 429 Too Many Requests" >&2; sleep 30'], {
      abortOnStderr: { pattern: /\b429\b/, code: 'ERATELIMIT', message: 'rate limited' }
    }),
    (err: unknown) => {
      grandchild = pidFromStdout(err);
      return err instanceof ProcessError && err.code === 'ERATELIMIT';
    }
  );
  assert.ok(
    await waitForExit(grandchild, 3000),
    `descendant ${grandchild} survived the 429 abort`
  );
});

test('SIGTERM-ignoring child is escalated to SIGKILL', async () => {
  let child = 0;
  await assert.rejects(
    // trap "" TERM 讓它完全無視 SIGTERM —— 只有升級後的 SIGKILL 收得掉。
    runProcess('sh', ['-c', 'echo $$; trap "" TERM; while :; do sleep 0.2; done'], {
      timeoutMs: 300
    }),
    (err: unknown) => {
      child = pidFromStdout(err);
      return err instanceof ProcessError && err.code === 'ETIMEDOUT';
    }
  );
  // KILL_ESCALATION_MS 是 5s,留足緩衝。
  assert.ok(
    await waitForExit(child, 9000),
    `process ${child} ignored SIGTERM and was never escalated to SIGKILL`
  );
});
