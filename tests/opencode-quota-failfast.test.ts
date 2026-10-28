import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpencodeAgent } from '../src/core/opencode.js';
import { deriveRunOutcome } from '../src/core/run-outcome.js';
import { getRecentIssues } from '../src/utils/errors.js';
import type { AgentStructuredResult } from '../src/core/agent-result.js';

/**
 * Issue 0023 SCN-001、002、007：真正的 OpencodeAgent 遇到額度用完時要快速失敗並說明原因。
 *
 * 假的 `opencode` 先把真實樣本寫到 stderr，再睡 20 秒，模擬 opencode 在背景退避重試、
 * stdout 一直空白（步驟 1 實測）。OPENCODE_TASK_TIMEOUT_MS 設 8 秒當保險絲：快速失敗失效時，
 * 測試會在幾秒內失敗，而不是等滿 30 分鐘。
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode');
const QUOTA_STDERR = '1.18.34-free-usage-limit.stderr.txt';
const RATE_LIMIT_STDERR = '1.18.34-upstream-429-retry.stderr.txt';

let tempDir = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['PATH', 'APP_PROJECT_DIR', 'OPENCODE_TASK_TIMEOUT_MS', 'FAKE_OPENCODE_STDERR'];

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-quota-failfast-'));
  fs.mkdirSync(path.join(tempDir, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'bin'));
  fs.writeFileSync(
    path.join(tempDir, 'bin', 'opencode'),
    `#!/bin/sh
cat "$FAKE_OPENCODE_STDERR" >&2
sleep 20
exit 0
`,
    { mode: 0o755 }
  );
  process.env.PATH = `${path.join(tempDir, 'bin')}${path.delimiter}${savedEnv.PATH ?? ''}`;
  process.env.APP_PROJECT_DIR = tempDir;
  process.env.OPENCODE_TASK_TIMEOUT_MS = '8000';
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function issueCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of getRecentIssues()) {
    counts.set(issue.scope, (counts.get(issue.scope) ?? 0) + issue.count);
  }
  return counts;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runTurn(
  mode: 'stream' | 'non-stream',
  stderrFixture: string
): Promise<{ result: AgentStructuredResult; newScopes: string[]; elapsedMs: number }> {
  process.env.FAKE_OPENCODE_STDERR = path.join(FIXTURES, stderrFixture);
  const before = issueCounts();
  const startedAt = Date.now();
  const agent = new OpencodeAgent();
  const result =
    mode === 'stream'
      ? // 正式環境的回呼是 Telegram 編輯訊息，不會同步返回（L-05）
        await agent.streamChat('hi', { forceNewSession: true }, async () => {
          await sleep(30);
        })
      : await agent.chatStructured('hi', { forceNewSession: true });
  const newScopes = [...issueCounts()]
    .filter(([scope, count]) => count > (before.get(scope) ?? 0))
    .map(([scope]) => scope);
  return { result, newScopes, elapsedMs: Date.now() - startedAt };
}

for (const mode of ['non-stream', 'stream'] as const) {
  test(`issue 0023 SCN-001 ${mode} 遇到額度用完，快速失敗並說明原因`, async () => {
    const { result, newScopes, elapsedMs } = await runTurn(mode, QUOTA_STDERR);

    assert.ok(elapsedMs < 4000, `應在幾秒內結束，實際 ${elapsedMs}ms`);
    assert.match(result.text, /免費額度已用完/);
    assert.match(result.text, /其他免費模型/);
    assert.match(result.text, /OpenCode Go/);
    assert.match(result.text, /provider/);
    assert.doesNotMatch(result.text, /429/);
    assert.equal(result.failure?.kind, 'rate-limit');
    assert.equal(deriveRunOutcome(result).ok, false);
    assert.ok(newScopes.includes('opencode:quota-exhausted'), `scopes: ${newScopes.join(',')}`);
    assert.ok(!newScopes.includes('opencode:rate-limit'), `scopes: ${newScopes.join(',')}`);
    // runner-status.md 的 Last Error 與 error-summary.md 顯示的是這兩段訊息，不能寫成 429。
    assert.ok(result.failure?.message, '缺少 failure.message');
    assert.doesNotMatch(result.failure.message, /429|rate-limit/i);
    assert.match(result.failure.message, /quota exhausted/i);
    const issues = getRecentIssues().filter((entry) => entry.scope === 'opencode:quota-exhausted');
    assert.ok(issues.length > 0);
    for (const issue of issues) assert.doesNotMatch(issue.message, /429|rate-limit/i);
  });

  test(`issue 0023 SCN-007 ${mode} 一般 429 仍回限流訊息與 opencode:rate-limit`, async () => {
    const { result, newScopes, elapsedMs } = await runTurn(mode, RATE_LIMIT_STDERR);

    assert.ok(elapsedMs < 4000, `應在幾秒內結束，實際 ${elapsedMs}ms`);
    assert.match(result.text, /HTTP 429/);
    assert.doesNotMatch(result.text, /免費額度已用完/);
    assert.equal(result.failure?.kind, 'rate-limit');
    assert.ok(newScopes.includes('opencode:rate-limit'), `scopes: ${newScopes.join(',')}`);
    assert.ok(!newScopes.includes('opencode:quota-exhausted'), `scopes: ${newScopes.join(',')}`);
  });
}
