import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_RATE_LIMIT_PATTERN } from '../src/core/rate-limit.js';

/**
 * Issue 0008:scripts/probe-models.mjs 要認得上游的 error 事件。
 *
 * 這支腳本得在沒有原始碼的正式映像裡直接跑,所以判定是 TypeScript 端的刻意複本,而且
 * 一載入就執行 main()、沒有可匯入的函式。這裡把它當成黑盒子:實際執行腳本,PATH 最前面
 * 放一支吐回 fixture 的假 `opencode`。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'probe-models.mjs');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'opencode');

type FakeRun = { stdout?: string; stderr?: string; exit?: number };
type Round = { verdict: string; statusCode?: number; rateLimitHits: number };
type ProbeResult = { model: string; verdict: string; rounds: Round[] };

let binDir = '';

before(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-fake-opencode-script-'));
  fs.writeFileSync(
    path.join(binDir, 'opencode'),
    `#!/bin/sh
[ -n "$FAKE_OPENCODE_STDERR" ] && cat "$FAKE_OPENCODE_STDERR" >&2
[ -n "$FAKE_OPENCODE_STDOUT" ] && cat "$FAKE_OPENCODE_STDOUT"
exit "\${FAKE_OPENCODE_EXIT:-0}"
`,
    { mode: 0o755 }
  );
});

after(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

function runScript(run: FakeRun, extraArgs: string[] = []) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_OPENCODE_EXIT: String(run.exit ?? 0)
  };
  delete env.FAKE_OPENCODE_STDOUT;
  delete env.FAKE_OPENCODE_STDERR;
  if (run.stdout) env.FAKE_OPENCODE_STDOUT = path.join(FIXTURES, run.stdout);
  if (run.stderr) env.FAKE_OPENCODE_STDERR = path.join(FIXTURES, run.stderr);

  return spawnSync(process.execPath, [SCRIPT, '--models', 'mock/model', ...extraArgs], {
    env,
    encoding: 'utf8',
    timeout: 30_000
  });
}

function probe(run: FakeRun): { result: ProbeResult; exitCode: number | null } {
  const child = runScript(run, ['--json']);
  const parsed = JSON.parse(child.stdout) as { results: ProbeResult[] };
  assert.equal(parsed.results.length, 1);
  return { result: parsed.results[0]!, exitCode: child.status };
}

const UPSTREAM_426: { label: string; run: FakeRun }[] = [
  { label: '1.15.10 exit 0', run: { stdout: '1.15.10-upstream-426.stdout.jsonl', exit: 0 } },
  {
    label: '1.18.34 exit 1',
    run: {
      stdout: '1.18.34-upstream-426.stdout.jsonl',
      stderr: '1.18.34-upstream-426.stderr.txt',
      exit: 1
    }
  }
];

for (const { label, run } of UPSTREAM_426) {
  test(`SCN-007 上游 426 標示為不可用並列出狀態碼,不是空輸出(${label})`, () => {
    const { result, exitCode } = probe(run);

    assert.equal(result.verdict, 'client-outdated');
    assert.equal(result.rounds[0]?.statusCode, 426);
    assert.equal(exitCode, 1, '有模型不可用時腳本以非 0 結束');
  });
}

test('SCN-007 表格輸出列出狀態碼與處置方向', () => {
  const child = runScript({ stdout: '1.15.10-upstream-426.stdout.jsonl', exit: 0 });

  assert.match(child.stdout, /HTTP 426/);
  assert.match(child.stdout, /升級 opencode/);
  assert.match(child.stdout, /可用 0 \/ 共測 1 顆/);
});

test('SCN-007 410 的 error 事件標示為已下架', () => {
  const { result } = probe({ stdout: '1.18.34-upstream-410.stdout.jsonl', exit: 1 });
  assert.equal(result.verdict, 'eol');
  assert.equal(result.rounds[0]?.statusCode, 410);
});

test('SCN-007 未列舉的狀態碼標示為上游錯誤', () => {
  const { result } = probe({ stdout: '1.18.34-upstream-404.stdout.jsonl', exit: 1 });
  assert.equal(result.verdict, 'upstream-error');
  assert.equal(result.rounds[0]?.statusCode, 404);
});

test('SCN-007 模型不存在仍由 stderr 判定', () => {
  const { result } = probe({
    stdout: '1.18.34-model-not-found.stdout.jsonl',
    stderr: '1.18.34-model-not-found.stderr.txt',
    exit: 1
  });
  assert.equal(result.verdict, 'not-found');
});

test('SCN-007 認得 opencode 1.18 stderr 裡的限流', () => {
  const { result } = probe({
    stdout: '1.18.34-ok-mentions-426.stdout.jsonl',
    stderr: '1.18.34-upstream-429-retry.stderr.txt',
    exit: 0
  });
  assert.equal(result.verdict, 'rate-limited');
  // fixture 裡主代理的 stream error 有 5 行,標題代理的 1 行不算。
  assert.equal(result.rounds[0]?.rateLimitHits, 5);
});

test('SCN-005 正常回合標示為可用,即使回覆文字提到 426 與 error', () => {
  const { result, exitCode } = probe({ stdout: '1.18.34-ok-mentions-426.stdout.jsonl', exit: 0 });
  assert.equal(result.verdict, 'ok');
  assert.equal(result.rounds[0]?.statusCode, undefined);
  assert.equal(exitCode, 0);
});

test('限流樣式與 src/core/rate-limit.ts 的那一份完全相同', () => {
  // 兩邊無法共用程式碼(腳本要在沒有建置的映像裡跑),只能靠這個斷言防止各自演化。
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const match = source.match(/const RATE_LIMIT_PATTERN =\s*\/(.+)\/i;/);
  assert.ok(match, '找不到 RATE_LIMIT_PATTERN 的定義');
  assert.equal(match[1], UPSTREAM_RATE_LIMIT_PATTERN.source);
  assert.equal(UPSTREAM_RATE_LIMIT_PATTERN.flags, 'i');
});
