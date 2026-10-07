import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpencodeAgent } from '../src/core/opencode.js';
import { ProcessError } from '../src/core/process-runner.js';
import { deriveRunOutcome } from '../src/core/run-outcome.js';
import { buildAgentOptions } from '../src/core/runner-agent-options.js';
import type { AIAgentOptions } from '../src/core/agent.js';
import type { AgentEvent, AgentStructuredResult } from '../src/core/agent-result.js';

/**
 * Issue 0012:聊天以 `-s <綁定的 id>` 接續自己的 session,不再用 `-c`。
 *
 * `-c` 接的是「最後被更新的 session」,排程、摘要與健康探針都會搶走它。
 * 輸出格式與 session 不存在時的行為取自 opencode 1.18.34 的實測
 * (docs/issues/issue-0012/evidence/step1-session-flag-probe.md)。
 * 假的 `opencode` 會把收到的參數逐行寫進檔案,被測的是我們送出的參數與對輸出的判定。
 */

const SESSION_EVENTS = [
  '{"type":"step_start","sessionID":"ses_from_events","part":{"type":"step-start"}}',
  '{"type":"text","sessionID":"ses_from_events","part":{"type":"text","text":"OK"}}',
  '{"type":"step_finish","sessionID":"ses_from_events","part":{"type":"step-finish","reason":"stop"}}'
].join('\n');
// 實測的 stderr 原文,含 ANSI 色碼。
const SESSION_NOT_FOUND_STDERR = '\u001b[91m\u001b[1mError: \u001b[0mSession not found\n';

let tempDir = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'PATH',
  'APP_PROJECT_DIR',
  'OPENCODE_TASK_TIMEOUT_MS',
  'FAKE_OPENCODE_ARGV',
  'FAKE_OPENCODE_STDOUT',
  'FAKE_OPENCODE_STDERR',
  'FAKE_OPENCODE_EXIT'
];

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-session-args-'));
  fs.mkdirSync(path.join(tempDir, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'bin'));
  fs.writeFileSync(
    path.join(tempDir, 'bin', 'opencode'),
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$FAKE_OPENCODE_ARGV"
[ -n "$FAKE_OPENCODE_STDERR" ] && cat "$FAKE_OPENCODE_STDERR" >&2
[ -n "$FAKE_OPENCODE_STDOUT" ] && cat "$FAKE_OPENCODE_STDOUT"
exit "\${FAKE_OPENCODE_EXIT:-0}"
`,
    { mode: 0o755 }
  );
  process.env.PATH = `${path.join(tempDir, 'bin')}${path.delimiter}${savedEnv.PATH ?? ''}`;
  process.env.APP_PROJECT_DIR = tempDir;
  process.env.OPENCODE_TASK_TIMEOUT_MS = '8000';
  process.env.FAKE_OPENCODE_ARGV = path.join(tempDir, 'argv.txt');
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeTemp(name: string, content: string): string {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function setFakeRun(run: { stdout?: string; stderr?: string; exit?: number }): void {
  const set = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set(
    'FAKE_OPENCODE_STDOUT',
    run.stdout === undefined ? undefined : writeTemp('stdout', run.stdout)
  );
  set(
    'FAKE_OPENCODE_STDERR',
    run.stderr === undefined ? undefined : writeTemp('stderr', run.stderr)
  );
  set('FAKE_OPENCODE_EXIT', run.exit === undefined ? undefined : String(run.exit));
}

function recordedArgv(): string[] {
  return fs.readFileSync(process.env.FAKE_OPENCODE_ARGV!, 'utf8').split('\n').slice(0, -1);
}

type Mode = 'stream' | 'non-stream';

async function runTurn(
  mode: Mode,
  options: AIAgentOptions | undefined,
  run: { stdout?: string; stderr?: string; exit?: number } = { stdout: SESSION_EVENTS }
): Promise<{ result: AgentStructuredResult; argv: string[]; events: AgentEvent[] }> {
  setFakeRun(run);
  const events: AgentEvent[] = [];
  const agent = new OpencodeAgent();
  const result =
    mode === 'stream'
      ? await agent.streamChat('hi', options, async (event) => {
          events.push(event);
        })
      : await agent.chatStructured('hi', options);
  return { result, argv: recordedArgv(), events };
}

/** `-s` 後面緊接的值;沒有 `-s` 時回 undefined。 */
function sessionFlagValue(argv: string[]): string | undefined {
  const index = argv.indexOf('-s');
  return index === -1 ? undefined : argv[index + 1];
}

for (const mode of ['stream', 'non-stream'] as const) {
  test(`SCN-001 [${mode}]: 有綁定的 session 時以 -s 接續,不用 -c`, async () => {
    const { result, argv } = await runTurn(mode, { sessionId: 'ses_bound' });
    assert.equal(sessionFlagValue(argv), 'ses_bound');
    assert.equal(argv.includes('-c'), false);
    assert.equal(result.sessionId, 'ses_from_events');
    assert.equal(result.failure, undefined);
  });

  test(`SCN-002 [${mode}]: /new(forceNewSession)時不帶接續參數,即使有綁定`, async () => {
    const { argv } = await runTurn(mode, { forceNewSession: true, sessionId: 'ses_bound' });
    assert.equal(argv.includes('-s'), false);
    assert.equal(argv.includes('-c'), false);
  });

  test(`SCN-002 [${mode}]: 沒有綁定時開新 session,不用 -c`, async () => {
    const { result, argv } = await runTurn(mode, undefined);
    assert.equal(argv.includes('-s'), false);
    assert.equal(argv.includes('-c'), false);
    assert.equal(result.sessionId, 'ses_from_events');
  });

  test(`SCN-003 [${mode}]: 綁定的 session 不存在時回傳 session-missing,不發事件`, async () => {
    const startedAt = Date.now();
    const { result, events } = await runTurn(
      mode,
      { sessionId: 'ses_gone' },
      { stderr: SESSION_NOT_FOUND_STDERR, exit: 1 }
    );
    assert.equal(result.failure?.kind, 'session-missing');
    assert.equal(result.sessionId, undefined);
    assert.deepEqual(events, []);
    assert.ok(Date.now() - startedAt < 5000);
  });

  test(`SCN-003 [${mode}]: 其他 exit 1 的錯誤維持原本的失敗方式`, async () => {
    await assert.rejects(
      runTurn(mode, { sessionId: 'ses_bound' }, { stderr: 'Error: boom\n', exit: 1 }),
      ProcessError
    );
  });
}

test('SCN-001 [passthrough]: passthrough 指令也接續綁定的 session', async () => {
  const { argv } = await runTurn(
    'non-stream',
    { isPassthroughCommand: true, sessionId: 'ses_bound' },
    { stdout: 'compacted\n' }
  );
  assert.equal(sessionFlagValue(argv), 'ses_bound');
  assert.equal(argv.includes('-c'), false);
  assert.equal(argv.includes('--format'), false);
});

test('SCN-003 [passthrough]: passthrough 遇到 session 不存在也回傳 session-missing', async () => {
  const { result } = await runTurn(
    'non-stream',
    { isPassthroughCommand: true, sessionId: 'ses_gone' },
    { stderr: SESSION_NOT_FOUND_STDERR, exit: 1 }
  );
  assert.equal(result.failure?.kind, 'session-missing');
});

test('SCN-003: session-missing 在 runner audit 記為失敗', () => {
  assert.deepEqual(
    deriveRunOutcome({
      provider: 'opencode',
      text: 'x',
      failure: { kind: 'session-missing', message: 'Session not found' }
    }),
    { ok: false, failureKind: 'session-missing', error: 'Session not found' }
  );
});

test('SCN-001: runner 請求的 sessionId 傳給 agent', () => {
  assert.equal(buildAgentOptions({ sessionId: 'ses_bound' })?.sessionId, 'ses_bound');
  assert.equal(buildAgentOptions({})?.sessionId, undefined);
});
