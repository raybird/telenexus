import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultProbe,
  failureSignature,
  interpretProbeOutput,
  isRealSuccessEvent,
  startModelHealthCheck,
  type HealthCheckOutcome,
  type HealthState
} from '../src/services/model-health-check.js';

/**
 * Issue 0008:健康檢查探針依 opencode 的 error 事件判定,任何上游錯誤都是不健康。
 *
 * fixture 是 2026-10-01 擷取的真實 opencode 輸出(來源見 tests/fixtures/opencode/README.md)。
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode');
const readFixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-health-upstream-'));
  return path.join(dir, 'model-health-state.json');
}

function fakeConnector() {
  const sent: { userId: string; text: string }[] = [];
  return {
    sent,
    connector: {
      sendMessage: async (userId: string, text: string) => {
        sent.push({ userId, text });
      }
    } as never
  };
}

function assertFailing(
  outcome: HealthCheckOutcome
): asserts outcome is Extract<HealthCheckOutcome, { ok: false }> {
  assert.equal(outcome.ok, false, '上游回了錯誤事件,探測結果必須是不健康');
}

// 1.15.10 的真實 426 是 exit 0、stderr 是舊格式;1.18.34 是 exit 1、stderr 是 logfmt。
const PROBE_426: { label: string; code: number; stderr: string; stdout: string }[] = [
  {
    label: '1.15.10 exit 0',
    code: 0,
    stderr: '',
    stdout: readFixture('1.15.10-upstream-426.stdout.jsonl')
  },
  {
    label: '1.18.34 exit 1',
    code: 1,
    stderr: readFixture('1.18.34-upstream-426.stderr.txt'),
    stdout: readFixture('1.18.34-upstream-426.stdout.jsonl')
  }
];

for (const sample of PROBE_426) {
  test(`SCN-003 探針把上游 426 判為不健康並帶出狀態碼(${sample.label})`, () => {
    const outcome = interpretProbeOutput(sample.code, sample.stderr, sample.stdout);

    assertFailing(outcome);
    assert.equal(outcome.category, 'client-outdated');
    assert.equal(outcome.statusCode, 426);
  });
}

test('SCN-003 426 的告警含狀態碼並指出要升級 opencode,不說成模型下架', async () => {
  const { sent, connector } = fakeConnector();
  const statePath = tempStatePath();
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'opencode/big-pickle',
    probe: async () =>
      interpretProbeOutput(0, '', readFixture('1.15.10-upstream-426.stdout.jsonl')),
    statePath,
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();

  assert.equal(sent.length, 1, '426 要推播');
  const text = sent[0]?.text ?? '';
  assert.match(text, /opencode\/big-pickle/);
  assert.match(text, /426/);
  assert.match(text, /升級 opencode/);
  assert.doesNotMatch(text, /下架|EOL/, '模型沒有下架,是客戶端版本太舊');
  // 上游的原文要讓維護者看得到要升到哪一版。
  assert.match(text, /OpenCode 1\.18\.0 or newer is required/);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as HealthState;
  assert.equal(state.status, 'failing');
});

test('SCN-003 帶上游錯誤的 opencode_done 不豁免探測', async () => {
  let probeCalls = 0;
  let lastSuccess: number | null = null;

  // 2026-09-17 事故期間 events.jsonl 裡每一筆的形狀,加上新的旗標。
  const payload = { outputLen: 736, upstreamInvalid: false, upstreamError: true, statusCode: 426 };
  if (isRealSuccessEvent('opencode_done', payload)) {
    lastSuccess = Date.now();
  }

  const handle = startModelHealthCheck({
    resolveModel: () => 'opencode/big-pickle',
    statePath: tempStatePath(),
    intervalMs: 0,
    exemptionWindowMs: 60 * 60 * 1000,
    lastSuccessAt: () => lastSuccess,
    probe: async () => {
      probeCalls += 1;
      return { ok: true };
    }
  });
  await handle.runOnce();
  handle.stop();

  assert.equal(probeCalls, 1, '假成功不得讓探針被豁免跳過');
  assert.equal(
    isRealSuccessEvent('opencode_done', { outputLen: 922, upstreamError: false }),
    true,
    '沒有上游錯誤的回合仍然算真實成功'
  );
});

test('SCN-003 狀態碼改變時簽章不同,視為新的故障立即推播', async () => {
  const base = { ok: false, category: 'upstream-error', message: '同一句上游訊息' } as const;
  assert.notEqual(
    failureSignature({ ...base, statusCode: 500 }),
    failureSignature({ ...base, statusCode: 502 })
  );

  const { sent, connector } = fakeConnector();
  const outcomes: HealthCheckOutcome[] = [
    interpretProbeOutput(0, '', readFixture('1.15.10-upstream-426.stdout.jsonl')),
    interpretProbeOutput(1, '', readFixture('1.18.34-upstream-410.stdout.jsonl'))
  ];
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'opencode/big-pickle',
    probe: async () => outcomes.shift() ?? { ok: true },
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  await handle.runOnce();
  handle.stop();

  assert.equal(sent.length, 2, '426 之後變成 410 是新資訊,不能被當成同一個故障壓掉');
  assert.match(sent[1]?.text ?? '', /410/);
});

test('SCN-004 410 的 error 事件判為模型失效(1.18 的 stderr 只剩 Gone)', async () => {
  const outcome = interpretProbeOutput(1, '', readFixture('1.18.34-upstream-410.stdout.jsonl'));
  assertFailing(outcome);
  assert.equal(outcome.category, 'model-invalid');
  assert.equal(outcome.statusCode, 410);

  const { sent, connector } = fakeConnector();
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'mock/s410',
    probe: async () => outcome,
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();
  assert.match(sent[0]?.text ?? '', /模型已失效/);
  assert.match(sent[0]?.text ?? '', /410/);
});

test('SCN-004 模型不存在:error 事件沒有狀態碼時仍由 stderr 判為模型失效', () => {
  const outcome = interpretProbeOutput(
    1,
    readFixture('1.18.34-model-not-found.stderr.txt'),
    readFixture('1.18.34-model-not-found.stdout.jsonl')
  );
  assertFailing(outcome);
  assert.equal(outcome.category, 'model-invalid');
  assert.match(outcome.message, /Model not found/, '訊息要用 stderr 的原因,不是事件裡的通用句子');
});

test('同一個故障在不同時間探測,簽章相同(不因 log 的時間戳與 run id 而改變)', () => {
  const stdout = readFixture('1.18.34-model-not-found.stdout.jsonl');
  const stderr = readFixture('1.18.34-model-not-found.stderr.txt');
  // 一小時後的下一次探測:同樣的錯誤,只有每一行開頭的時間戳與 run id 不同。
  const nextProbeStderr = stderr
    .replace(/timestamp=\S+/g, 'timestamp=2026-10-01T09:00:00.000Z')
    .replace(/run=\S+/g, 'run=0a1b2c3d');
  assert.notEqual(nextProbeStderr, stderr, 'fixture 應含 timestamp 與 run 欄位');

  assert.equal(
    failureSignature(interpretProbeOutput(1, nextProbeStderr, stdout)),
    failureSignature(interpretProbeOutput(1, stderr, stdout))
  );

  // 舊格式的行首是 `ERROR <時間> +<毫秒>ms`。
  const oldFormat = (time: string, delta: string): HealthCheckOutcome => ({
    ok: false,
    category: 'unknown',
    message: `ERROR ${time} ${delta} service=llm providerID=x error=boom`
  });
  assert.equal(
    failureSignature(oldFormat('2026-08-29T08:17:04', '+310ms')),
    failureSignature(oldFormat('2026-08-29T09:17:09', '+12ms'))
  );
  assert.notEqual(
    failureSignature(oldFormat('2026-08-29T08:17:04', '+310ms')),
    failureSignature({ ok: false, category: 'unknown', message: 'ERROR service=llm other failure' })
  );
});

test('持續被限流時,命中次數不同仍是同一個簽章', () => {
  const stdout = readFixture('1.18.34-ok.stdout.jsonl');
  const stderr = readFixture('1.18.34-upstream-429-retry.stderr.txt');
  const mainAgentLines = stderr.split('\n').filter((line) => line.includes('small=false'));
  const fiveHits = interpretProbeOutput(0, stderr, stdout);
  const threeHits = interpretProbeOutput(0, mainAgentLines.slice(0, 3).join('\n'), stdout);

  assertFailing(fiveHits);
  assertFailing(threeHits);
  assert.notEqual(fiveHits.message, threeHits.message, '兩次探測的命中次數應該不同');
  assert.equal(failureSignature(threeHits), failureSignature(fiveHits));
});

test('SCN-004 探測期間被限流多次仍判為限流(1.18 的 stderr)', () => {
  // 重試後最終成功的情況:exit 0,stdout 是正常回合,stderr 留下重試期間的限流紀錄。
  const outcome = interpretProbeOutput(
    0,
    readFixture('1.18.34-upstream-429-retry.stderr.txt'),
    readFixture('1.18.34-ok.stdout.jsonl')
  );
  assertFailing(outcome);
  assert.equal(outcome.category, 'rate-limited');
});

test('SCN-003 未列舉的狀態碼一樣不健康,告警帶狀態碼且不猜成模型下架', async () => {
  const outcome = interpretProbeOutput(1, '', readFixture('1.18.34-upstream-404.stdout.jsonl'));
  assertFailing(outcome);
  assert.equal(outcome.category, 'upstream-error');
  assert.equal(outcome.statusCode, 404);

  const { sent, connector } = fakeConnector();
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'mock/s404',
    probe: async () => outcome,
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();
  assert.match(sent[0]?.text ?? '', /404/);
  assert.doesNotMatch(sent[0]?.text ?? '', /下架|EOL/);
});

test('SCN-005 正常回合判為健康,即使回覆文字提到 426 與 error', () => {
  assert.deepEqual(interpretProbeOutput(0, '', readFixture('1.18.34-ok.stdout.jsonl')), {
    ok: true
  });
  assert.deepEqual(
    interpretProbeOutput(0, '', readFixture('1.18.34-ok-mentions-426.stdout.jsonl')),
    { ok: true }
  );
});

test('SCN-003 defaultProbe 以 JSON 格式執行,拿得到 error 事件', async () => {
  // 假的 opencode:只有帶 --format json 才吐事件,否則跟真實的預設格式一樣 stdout 是空的。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-fake-opencode-probe-'));
  const stdoutFixture = path.join(FIXTURES, '1.18.34-upstream-426.stdout.jsonl');
  const stderrFixture = path.join(FIXTURES, '1.18.34-upstream-426.stderr.txt');
  fs.writeFileSync(
    path.join(dir, 'opencode'),
    `#!/bin/sh
cat "${stderrFixture}" >&2
case " $* " in
  *" --format json "*) cat "${stdoutFixture}" ;;
esac
exit 1
`,
    { mode: 0o755 }
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
  try {
    const outcome = await defaultProbe('mock/s426', 5000);
    assertFailing(outcome);
    assert.equal(outcome.category, 'client-outdated');
    assert.equal(outcome.statusCode, 426);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
