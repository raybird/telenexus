import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultProbe, findProbeSessionId } from '../src/services/model-health-check.js';
import { addIssueHook } from '../src/utils/errors.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode');
const OK_FIXTURE = path.join(FIXTURES, '1.18.34-ok.stdout.jsonl');
const OK_SESSION = 'ses_f09b0ff6cffevnDpBWcg79Sse9';
const S426_FIXTURE = path.join(FIXTURES, '1.18.34-upstream-426.stdout.jsonl');
const S426_SESSION = 'ses_f09b0a8b5ffee5DdG2kNnL0Tpv';

/**
 * 假的 opencode:`run` 吐指定的 stdout 並以指定 exit code 結束;`session delete` 記下參數,
 * deleteExit 非 0 時以該值失敗。
 */
async function withFakeOpencode(
  options: { runStdout?: string; runExit: number; deleteExit?: number },
  fn: (argsLog: string) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-fake-opencode-probe-session-'));
  const argsLog = path.join(dir, 'args.log');
  fs.writeFileSync(argsLog, '');
  fs.writeFileSync(
    path.join(dir, 'opencode'),
    `#!/bin/sh
case "$1" in
  run) ${options.runStdout ? `cat "${options.runStdout}"` : ':'}; exit ${options.runExit} ;;
  session) printf '%s\\n' "$*" >> "${argsLog}"; exit ${options.deleteExit ?? 0} ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
  try {
    await fn(argsLog);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function deleteCalls(argsLog: string): string[] {
  return fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean);
}

test('SCN-004: 從探針的事件取出這次的 session id', () => {
  assert.equal(findProbeSessionId(fs.readFileSync(OK_FIXTURE, 'utf8')), OK_SESSION);
  assert.equal(findProbeSessionId(''), undefined);
  assert.equal(findProbeSessionId('not json\n'), undefined);
});

test('SCN-004: 探測成功後刪除自己的 session', async () => {
  await withFakeOpencode({ runStdout: OK_FIXTURE, runExit: 0 }, async (argsLog) => {
    const outcome = await defaultProbe('mock/ok', 5000);
    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(deleteCalls(argsLog), [`session delete ${OK_SESSION}`]);
  });
});

test('SCN-004: 探測失敗時也刪除自己的 session', async () => {
  await withFakeOpencode({ runStdout: S426_FIXTURE, runExit: 1 }, async (argsLog) => {
    const outcome = await defaultProbe('mock/s426', 5000);
    assert.equal(outcome.ok, false);
    assert.deepEqual(deleteCalls(argsLog), [`session delete ${S426_SESSION}`]);
  });
});

test('SCN-004: 刪除失敗不改變探測結果，記 runtime issue', async () => {
  const scopes: string[] = [];
  const unhook = addIssueHook(({ scope }) => {
    scopes.push(scope);
  });
  try {
    await withFakeOpencode(
      { runStdout: OK_FIXTURE, runExit: 0, deleteExit: 1 },
      async (argsLog) => {
        const outcome = await defaultProbe('mock/ok-delete-fails', 5000);
        assert.deepEqual(outcome, { ok: true });
        assert.deepEqual(deleteCalls(argsLog), [`session delete ${OK_SESSION}`]);
      }
    );
    assert.deepEqual(scopes, ['model-health:probe-session-delete']);
  } finally {
    unhook();
  }
});

test('SCN-004: 沒有任何事件時不呼叫刪除', async () => {
  await withFakeOpencode({ runExit: 1 }, async (argsLog) => {
    await defaultProbe('mock/no-events', 5000);
    assert.deepEqual(deleteCalls(argsLog), []);
  });
});
