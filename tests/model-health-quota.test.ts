import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyFailure,
  decideAlert,
  defaultProbe,
  failureSignature,
  interpretProbeOutput,
  startModelHealthCheck,
  type HealthCheckOutcome
} from '../src/services/model-health-check.js';

/**
 * Issue 0023 SCN-003：健康檢查遇到免費額度用完，立刻結束、判成 quota-exhausted 並告警。
 * 樣本是 2026-10-28 正式部署額度用完時擷取的真實 stderr（步驟 1）。
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode');
const QUOTA_FIXTURE = path.join(FIXTURES, '1.18.34-free-usage-limit.stderr.txt');
const RATE_LIMIT_FIXTURE = path.join(FIXTURES, '1.18.34-upstream-429-retry.stderr.txt');
const REAL = fs.readFileSync(QUOTA_FIXTURE, 'utf8');
const UPSTREAM_SENTENCE = 'Free usage limit reached.';

/** 下一次探測的同一個故障：時間戳、run id 與 session id 每次都不同。 */
const NEXT_PROBE = REAL.replace(/timestamp=\S+/g, 'timestamp=2026-10-28T05:14:36.234Z')
  .replace(/\brun=\S+/g, 'run=0badc0de')
  .replace(/session\.id=\S+/g, 'session.id=ses_0000000000000000000000000');

function quotaOutcome(output: string): HealthCheckOutcome {
  return interpretProbeOutput(null, output, '');
}

test('issue 0023 SCN-003 額度用完判成 quota-exhausted，訊息是上游那句', () => {
  const outcome = quotaOutcome(REAL);
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.category, 'quota-exhausted');
  assert.ok(outcome.message.startsWith(UPSTREAM_SENTENCE), outcome.message);
  assert.doesNotMatch(outcome.message, /timestamp=|session\.id=/);
  assert.equal(classifyFailure(REAL), 'quota-exhausted');
});

test('issue 0023 SCN-003 額度用完的行重複出現時，不被數成限流', () => {
  const mainLine = REAL.split('\n').find((line) => line.includes('small=false'));
  assert.ok(mainLine);
  const outcome = interpretProbeOutput(0, [mainLine, mainLine, mainLine].join('\n'), '');
  assert.ok(!outcome.ok);
  assert.equal(outcome.category, 'quota-exhausted');
});

test('issue 0023 SCN-007 一般 429 的判定不變', () => {
  const outcome = interpretProbeOutput(0, fs.readFileSync(RATE_LIMIT_FIXTURE, 'utf8'), '');
  assert.ok(!outcome.ok);
  assert.equal(outcome.category, 'rate-limited');
});

test('issue 0023 SCN-003 每次探測都是同一個故障簽章，只在提醒間隔後提醒', () => {
  const first = quotaOutcome(REAL);
  const next = quotaOutcome(NEXT_PROBE);
  assert.notEqual(REAL, NEXT_PROBE);
  assert.equal(failureSignature(first), failureSignature(next));

  const remindMs = 6 * 60 * 60 * 1000;
  const opened = decideAlert(null, first, 0, remindMs);
  assert.equal(opened.alert, 'new-failure');
  const hourLater = decideAlert(opened.nextState, next, 60 * 60 * 1000, remindMs);
  assert.equal(hourLater.alert, 'none');
  const remindLater = decideAlert(hourLater.nextState, next, remindMs, remindMs);
  assert.equal(remindLater.alert, 'reminder');
});

test('issue 0023 SCN-003 Telegram 告警說明額度用完與處置方向', async () => {
  const sent: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-health-quota-'));
  try {
    const handle = startModelHealthCheck({
      connector: {
        sendMessage: async (_userId: string, text: string) => {
          sent.push(text);
        }
      } as never,
      adminUserId: 'admin',
      resolveModel: () => 'opencode/big-pickle',
      probe: async () => quotaOutcome(REAL),
      statePath: path.join(dir, 'state.json'),
      intervalMs: 0
    });
    await handle.runOnce();
    await handle.runOnce();
    handle.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(sent.length, 1, '同一個故障第二次探測不應再推播');
  const text = sent[0] ?? '';
  assert.match(text, /opencode\/big-pickle/);
  assert.match(text, /opencode 免費額度已用完/);
  assert.match(text, /其他免費模型/);
  assert.match(text, /OpenCode Go/);
  assert.match(text, /provider/);
  assert.doesNotMatch(text, /429/);
  assert.doesNotMatch(text, /無法確認/);
});

/** 假的 opencode：`run` 先吐 stderr 樣本再等 20 秒，模擬背景重試、stdout 空白。 */
async function probeWithStderr(
  stderrFixture: string,
  timeoutMs: number
): Promise<{ outcome: HealthCheckOutcome; elapsedMs: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-fake-opencode-quota-'));
  fs.writeFileSync(
    path.join(dir, 'opencode'),
    `#!/bin/sh
case "$1" in
  run) cat "${stderrFixture}" >&2; sleep 20; exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
  try {
    const startedAt = Date.now();
    const outcome = await defaultProbe('opencode/big-pickle', timeoutMs);
    return { outcome, elapsedMs: Date.now() - startedAt };
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('issue 0023 SCN-003 defaultProbe 看到額度用完就結束，不等到逾時', async () => {
  const { outcome, elapsedMs } = await probeWithStderr(QUOTA_FIXTURE, 8000);
  assert.ok(elapsedMs < 4000, `應在幾秒內結束，實際 ${elapsedMs}ms`);
  assert.ok(!outcome.ok);
  assert.equal(outcome.category, 'quota-exhausted');
});

test('issue 0023 SCN-007 defaultProbe 遇到一般 429 不提早中止', async () => {
  const { outcome, elapsedMs } = await probeWithStderr(RATE_LIMIT_FIXTURE, 1500);
  assert.ok(elapsedMs >= 1400, `一般 429 應等到逾時，實際 ${elapsedMs}ms`);
  assert.ok(!outcome.ok);
  assert.notEqual(outcome.category, 'quota-exhausted');
});
