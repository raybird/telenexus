import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpencodeAgent } from '../src/core/opencode.js';
import { interpretEvent, parseEventLine } from '../src/core/opencode-event-parser.js';
import { UPSTREAM_RATE_LIMIT_PATTERN } from '../src/core/rate-limit.js';
import { deriveRunOutcome } from '../src/core/run-outcome.js';
import { getRecentIssues } from '../src/utils/errors.js';
import { addEventHook } from '../src/services/event-bus.js';
import { isRealSuccessEvent } from '../src/services/model-health-check.js';
import type { AgentEvent, AgentStructuredResult } from '../src/core/agent-result.js';

/**
 * Issue 0008:上游回 error 事件的回合要被判為失敗。
 *
 * fixture 是 2026-10-01 擷取的真實 opencode 輸出(來源見 tests/fixtures/opencode/README.md)。
 * 這裡放一支假的 `opencode` 到 PATH 最前面,把 fixture 原樣吐回去,讓真正的 OpencodeAgent
 * 走完整條路徑 —— 被測的是 agent 對這些輸出的判定,不是 opencode 本身。
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode');
const fixture = (name: string): string => path.join(FIXTURES, name);
const readFixture = (name: string): string => fs.readFileSync(fixture(name), 'utf8');

type FakeRun = { stdout?: string; stderr?: string; exit?: number; sleepSec?: number };

let tempDir = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'PATH',
  'APP_PROJECT_DIR',
  'OPENCODE_TASK_TIMEOUT_MS',
  'FAKE_OPENCODE_STDOUT',
  'FAKE_OPENCODE_STDERR',
  'FAKE_OPENCODE_EXIT',
  'FAKE_OPENCODE_SLEEP'
];

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-upstream-error-'));
  fs.mkdirSync(path.join(tempDir, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'bin'));
  fs.writeFileSync(
    path.join(tempDir, 'bin', 'opencode'),
    `#!/bin/sh
[ -n "$FAKE_OPENCODE_STDERR" ] && cat "$FAKE_OPENCODE_STDERR" >&2
[ -n "$FAKE_OPENCODE_STDOUT" ] && cat "$FAKE_OPENCODE_STDOUT"
[ -n "$FAKE_OPENCODE_SLEEP" ] && sleep "$FAKE_OPENCODE_SLEEP"
exit "\${FAKE_OPENCODE_EXIT:-0}"
`,
    { mode: 0o755 }
  );

  process.env.PATH = `${path.join(tempDir, 'bin')}${path.delimiter}${savedEnv.PATH ?? ''}`;
  // workspace 與 events.jsonl 都落在暫存目錄,不碰 repo 的執行期狀態。
  process.env.APP_PROJECT_DIR = tempDir;
  // 保險絲:快速中止若失效,測試要在幾秒內失敗,而不是掛滿 30 分鐘預設值。
  process.env.OPENCODE_TASK_TIMEOUT_MS = '8000';
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function setFakeRun(run: FakeRun): void {
  const set = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  // 絕對路徑是測試自己組出來的暫存檔,其餘是 fixture 檔名。
  const stdoutPath = run.stdout && (path.isAbsolute(run.stdout) ? run.stdout : fixture(run.stdout));
  set('FAKE_OPENCODE_STDOUT', stdoutPath || undefined);
  set('FAKE_OPENCODE_STDERR', run.stderr ? fixture(run.stderr) : undefined);
  set('FAKE_OPENCODE_EXIT', run.exit === undefined ? undefined : String(run.exit));
  set('FAKE_OPENCODE_SLEEP', run.sleepSec === undefined ? undefined : String(run.sleepSec));
}

type Observed = {
  result: AgentStructuredResult;
  issueScopes: string[];
  doneEvents: Record<string, unknown>[];
  streamEvents: AgentEvent[];
  elapsedMs: number;
};

/** 各 scope 目前累計的次數。 */
function issueCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of getRecentIssues()) {
    counts.set(issue.scope, (counts.get(issue.scope) ?? 0) + issue.count);
  }
  return counts;
}

async function runTurn(mode: 'stream' | 'non-stream', run: FakeRun): Promise<Observed> {
  setFakeRun(run);
  const doneEvents: Record<string, unknown>[] = [];
  const streamEvents: AgentEvent[] = [];
  // 不用 issue hook:同一個 scope 與訊息在 60 秒內重複時只累加次數、不再呼叫 hook,
  // 而這個檔案的測試會連續送出相同的錯誤。改看次數有沒有增加。
  const issuesBefore = issueCounts();
  const offEvent = addEventHook((type, payload) => {
    if (type === 'opencode_done') doneEvents.push(payload);
  });
  const startedAt = Date.now();
  try {
    const agent = new OpencodeAgent();
    const result =
      mode === 'stream'
        ? await agent.streamChat('hi', { forceNewSession: true }, (event) => {
            streamEvents.push(event);
          })
        : await agent.chatStructured('hi', { forceNewSession: true });
    const issueScopes = [...issueCounts()]
      .filter(([scope, count]) => count > (issuesBefore.get(scope) ?? 0))
      .map(([scope]) => scope);
    return { result, issueScopes, doneEvents, streamEvents, elapsedMs: Date.now() - startedAt };
  } finally {
    offEvent();
  }
}

const UPSTREAM_426_RUNS: { label: string; run: FakeRun }[] = [
  // 1.15.10 的真實 426:上游拒絕後 opencode 仍以 exit 0 結束。
  { label: '1.15.10 exit 0', run: { stdout: '1.15.10-upstream-426.stdout.jsonl', exit: 0 } },
  // 1.18 起同樣的錯誤改以 exit 1 結束,stdout 的事件結構不變。
  {
    label: '1.18.34 exit 1',
    run: {
      stdout: '1.18.34-upstream-426.stdout.jsonl',
      stderr: '1.18.34-upstream-426.stderr.txt',
      exit: 1
    }
  }
];

test('SCN-001 interpretEvent 從 error 事件取出狀態碼、名稱與訊息', () => {
  const event = parseEventLine(readFixture('1.15.10-upstream-426.stdout.jsonl').trim());
  assert.ok(event, 'fixture 應是單行 JSON 事件');

  const interpreted = interpretEvent(event);
  // 期望值是 fixture 裡上游回的原文,不由解析器重算。
  assert.deepEqual(interpreted.upstreamError, {
    statusCode: 426,
    name: 'APIError',
    message:
      'Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier'
  });
  assert.equal(interpreted.text, undefined, 'error 事件不是可渲染的文字');
});

test('SCN-001 沒有 statusCode 的 error 事件一樣被辨識', () => {
  const event = parseEventLine(readFixture('1.18.34-model-not-found.stdout.jsonl').trim());
  assert.ok(event);

  assert.deepEqual(interpretEvent(event).upstreamError, {
    name: 'UnknownError',
    message: 'Unexpected server error. Check server logs for details.'
  });
});

for (const { label, run } of UPSTREAM_426_RUNS) {
  test(`SCN-001 非串流:上游 426 的回合被判為失敗(${label})`, async () => {
    const { result, issueScopes, doneEvents } = await runTurn('non-stream', run);

    assert.equal(result.failure?.kind, 'upstream-error');
    assert.equal(result.failure?.statusCode, 426);
    assert.match(result.text, /426/, '使用者要看得到狀態碼');
    assert.match(result.text, /升級 opencode/, '426 要指出該升級 opencode');
    assert.doesNotMatch(result.text, /沒有返回任何文字內容|沒有任何輸出/);

    // runner 的 audit 與成功率由 deriveRunOutcome 決定。
    const outcome = deriveRunOutcome(result);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failureKind, 'upstream-error');

    assert.ok(
      issueScopes.includes('opencode:upstream-error:426'),
      `runtime issue 的 scope 要帶狀態碼,實際:${JSON.stringify(issueScopes)}`
    );

    assert.equal(doneEvents.length, 1, '回合結束要留下一筆 opencode_done');
    assert.equal(
      isRealSuccessEvent('opencode_done', doneEvents[0]!),
      false,
      '上游錯誤的回合不能被健康檢查當成真實成功'
    );
  });

  test(`SCN-001 串流:上游 426 的回合被判為失敗(${label})`, async () => {
    const { result, issueScopes, doneEvents, streamEvents } = await runTurn('stream', run);

    assert.equal(result.failure?.kind, 'upstream-error');
    assert.equal(result.failure?.statusCode, 426);
    assert.match(result.text, /426/);
    assert.match(result.text, /升級 opencode/);
    assert.equal(deriveRunOutcome(result).ok, false);
    assert.ok(issueScopes.includes('opencode:upstream-error:426'));
    assert.equal(
      issueScopes.some((scope) => scope.includes('empty-output')),
      false,
      '上游錯誤不該再被歸類成空輸出'
    );
    assert.deepEqual(
      streamEvents.at(-1),
      { type: 'done', text: result.text },
      '串流的最後一則訊息就是給使用者的說明'
    );
    assert.equal(
      doneEvents.some((payload) => isRealSuccessEvent('opencode_done', payload)),
      false
    );
  });

  test(`SCN-002 串流與非串流對同一份輸出的判定一致(${label})`, async () => {
    const nonStream = await runTurn('non-stream', run);
    const stream = await runTurn('stream', run);

    assert.deepEqual(stream.result.failure, nonStream.result.failure);
    assert.equal(stream.result.text, nonStream.result.text);
    assert.equal(nonStream.result.failure?.statusCode, 426);
  });
}

test('SCN-004 410 的 error 事件帶出狀態碼(1.18 的 stderr 已不含 410)', async () => {
  const run: FakeRun = { stdout: '1.18.34-upstream-410.stdout.jsonl', exit: 1 };
  for (const mode of ['non-stream', 'stream'] as const) {
    const { result, issueScopes } = await runTurn(mode, run);
    assert.equal(result.failure?.kind, 'upstream-error', mode);
    assert.equal(result.failure?.statusCode, 410, mode);
    assert.match(result.text, /410/, mode);
    assert.match(result.text, /模型已失效/, mode);
    assert.ok(issueScopes.includes('opencode:upstream-error:410'), mode);
  }
});

test('SCN-001 已經產出的文字保留在上游錯誤說明之前', async () => {
  // 把兩份真實輸出接在一起:正常回合的 step_start 與 text("OK"),接著 426 的 error 事件。
  // 這個組合沒有被實際擷取到,用來確認「做到一半才被拒絕」時前半段不會被丟掉。
  const okLines = readFixture('1.18.34-ok.stdout.jsonl').trim().split('\n').slice(0, 2);
  const composed = path.join(tempDir, 'partial-then-426.jsonl');
  fs.writeFileSync(
    composed,
    [...okLines, readFixture('1.18.34-upstream-426.stdout.jsonl').trim()].join('\n') + '\n'
  );

  for (const mode of ['non-stream', 'stream'] as const) {
    const { result } = await runTurn(mode, { stdout: composed, exit: 1 });
    assert.equal(result.failure?.statusCode, 426, mode);
    assert.ok(result.text.startsWith('OK\n\n'), `${mode}: ${result.text}`);
    assert.match(result.text, /426/, mode);
  }
});

test('opencode 自己失敗(exit 1 且沒有 error 事件)仍然丟出例外,不留下成功事件', async () => {
  setFakeRun({ exit: 1 });
  const doneEvents: Record<string, unknown>[] = [];
  const offEvent = addEventHook((type, payload) => {
    if (type === 'opencode_done') doneEvents.push(payload);
  });
  try {
    await assert.rejects(
      new OpencodeAgent().chatStructured('hi', { forceNewSession: true }),
      /Error calling Opencode/
    );
    // 這條路徑沒有上游錯誤可回報;若在這裡發出 opencode_done,健康檢查會把它當成真實成功。
    assert.deepEqual(doneEvents, []);
  } finally {
    offEvent();
  }
});

test('SCN-005 回覆內容提到 426、error、429 的正常回合不受影響', async () => {
  const run: FakeRun = { stdout: '1.18.34-ok-mentions-426.stdout.jsonl', exit: 0 };
  // 模型在這個回合實際輸出的句子(fixture 的 text 事件原文)。
  const expected =
    'The upstream returned HTTP 426 error "statusCode":426 (Upgrade Required), not a 429 rate limit error.';

  const nonStream = await runTurn('non-stream', run);
  assert.equal(nonStream.result.failure, undefined);
  assert.equal(nonStream.result.text, expected);
  assert.deepEqual(deriveRunOutcome(nonStream.result), { ok: true });
  assert.deepEqual(nonStream.issueScopes, []);
  assert.equal(nonStream.doneEvents.length, 1);
  assert.equal(isRealSuccessEvent('opencode_done', nonStream.doneEvents[0]!), true);

  const stream = await runTurn('stream', run);
  assert.equal(stream.result.failure, undefined);
  assert.equal(stream.result.text, expected);
  assert.deepEqual(stream.issueScopes, []);
});

test('SCN-004 限流樣式認得 opencode 1.18 的 stderr', () => {
  // 1.18 的 --print-logs 不再有 "statusCode":429,只剩上游訊息的文字。
  assert.ok(UPSTREAM_RATE_LIMIT_PATTERN.test(readFixture('1.18.34-upstream-429-retry.stderr.txt')));
  assert.ok(
    UPSTREAM_RATE_LIMIT_PATTERN.test(
      readFixture('1.18.34-upstream-429-retry-status-text.stderr.txt')
    )
  );
});

test('SCN-004 限流樣式不被其他上游錯誤、標題代理或模型名誤觸', () => {
  // 500 與 426 的 fixture 裡,模型名分別是 s500 與 s426;500 那份同樣在重試中。
  assert.equal(
    UPSTREAM_RATE_LIMIT_PATTERN.test(readFixture('1.18.34-upstream-500-retry.stderr.txt')),
    false
  );
  assert.equal(
    UPSTREAM_RATE_LIMIT_PATTERN.test(readFixture('1.18.34-upstream-426.stderr.txt')),
    false
  );

  const lines = readFixture('1.18.34-upstream-429-retry-status-text.stderr.txt')
    .split('\n')
    .filter(Boolean);
  // 標題代理(small=true)用的是另一顆小模型,它被限流不代表主模型不能用。
  const titleAgentOnly = lines.filter((line) => line.includes('small=true')).join('\n');
  assert.ok(titleAgentOnly.includes('Too Many Requests'), 'fixture 應含標題代理的限流行');
  assert.equal(UPSTREAM_RATE_LIMIT_PATTERN.test(titleAgentOnly), false);

  // 模型名是 n429,訊息換成與限流無關的內容後就不該命中。
  const mainAgentLine = lines.find((line) => line.includes('small=false'));
  assert.ok(mainAgentLine?.includes('modelID=n429'));
  assert.equal(
    UPSTREAM_RATE_LIMIT_PATTERN.test(
      mainAgentLine.replace('Too Many Requests', 'upstream connect error')
    ),
    false
  );
});

for (const mode of ['non-stream', 'stream'] as const) {
  test(`SCN-004 ${mode}:1.18 的 429 仍快速中止並判為限流`, async () => {
    // 吐完 stderr 之後睡很久:快速中止若沒作用,會撞到 8 秒的保險絲並得到逾時而不是限流。
    const { result, elapsedMs } = await runTurn(mode, {
      stderr: '1.18.34-upstream-429-retry.stderr.txt',
      sleepSec: 60
    });

    assert.equal(result.failure?.kind, 'rate-limit');
    assert.ok(elapsedMs < 5000, `應在 429 出現時立即中止,實際耗時 ${elapsedMs}ms`);
  });
}
