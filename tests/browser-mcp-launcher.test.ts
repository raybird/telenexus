import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const launcher = resolve('scripts/browser-mcp-launcher.mjs');
const fixture = `
  const fs = require('node:fs');
  fs.mkdirSync(process.env.TMPDIR + '/profile');
  if (process.env.FIXTURE_BREAK_CLEANUP) fs.chmodSync(process.env.TMPDIR, 0o500);
  process.stdout.write(JSON.stringify({ root: process.env.TMPDIR, pid: process.pid }) + '\\n');
  process.stdin.resume();
  process.stdin.on('data', data => process.stdout.write(data));
  process.stdin.on('end', () => process.exit(Number(process.env.FIXTURE_EXIT || 0)));
`;

function start(args = [process.execPath, '-e', fixture], extraEnv: Record<string, string> = {}) {
  const baseline = process.env.BROWSER_LAUNCHER_BASELINE === '1';
  const characterization = process.env.BROWSER_LAUNCHER_CHARACTERIZATION === '1';
  const baselineSource = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const root = fs.mkdtempSync('/tmp/tnb-baseline-');
    process.stderr.write(JSON.stringify({event:'browser-mcp-start',root})+'\\n');
    const child = cp.spawn(process.argv[1], process.argv.slice(2), {env:{...process.env,TMPDIR:root},stdio:['pipe','pipe','pipe']});
    process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.on('exit', code => process.exit(code));
    child.on('error', () => process.exit(1));
  `;
  const commandArgs = characterization
    ? [resolve('docs/issues/issue-0010/evidence/task-owned-launcher.mjs'), ...args.slice(1)]
    : baseline ? ['-e', baselineSource, ...args] : [launcher, ...args];
  const child = spawn(process.execPath, commandArgs, {
    env: { ...process.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => { stdout += data; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    child.on('exit', (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exited, stderr: () => stderr, stdout: () => stdout };
}

async function until(predicate: () => boolean, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '等待程序或收尾超過 15 秒');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  }
}

function rootOf(run: ReturnType<typeof start>) {
  const line = run.stderr().split('\n').find(value => value.includes('"event":"browser-mcp-start"') || value.includes('"event":"launcher-start"'));
  return line ? JSON.parse(line).root as string : undefined;
}

async function finish(run: ReturnType<typeof start>) {
  const result = await Promise.race([run.exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('收尾超過 15 秒')), 15000).unref())]);
  const root = rootOf(run);
  assert.ok(root, '必須回報工作專屬 root');
  try { assert.equal(existsSync(root), false, '工作結束後 profile 與完整 root 必須移除'); }
  finally { if (existsSync(root)) rmSync(root, { recursive: true }); }
  return result;
}

test('SCN-003 EOF 轉送原始 stdio，移除真實 profile 與 root', async () => {
  const run = start();
  await until(() => run.stdout().includes('"pid":'));
  const fixturePid = JSON.parse(run.stdout().split('\n')[0]).pid;
  run.child.stdin.write('protocol-line\n');
  await until(() => run.stdout().includes('protocol-line\n'));
  run.child.stdin.end();
  assert.equal((await finish(run)).code, 0);
  assert.equal(existsSync(`/proc/${fixturePid}`), false);
});

test('SCN-003 子程序非零退出不能被收尾成功掩蓋', async () => {
  const run = start(undefined, { FIXTURE_EXIT: '7' });
  await until(() => run.stdout().includes('"pid":'));
  run.child.stdin.end();
  assert.equal((await finish(run)).code, 7);
});

test('SCN-005 executable spawn 失敗亦清理已建立 root', async () => {
  const run = start(['/nonexistent-telenexus-browser-mcp']);
  assert.equal((await finish(run)).code, 1);
  assert.match(run.stderr(), /ENOENT/);
});

test('SCN-003 SIGTERM 仍回報取消而非成功', async () => {
  const run = start();
  await until(() => run.stdout().includes('"pid":'));
  run.child.kill('SIGTERM');
  assert.equal((await finish(run)).code, 143);
});

test('SCN-003 MCP 被 SIGKILL 後保留失敗結果並清理 profile', async () => {
  const run = start();
  await until(() => run.stdout().includes('"pid":'));
  const pid = JSON.parse(run.stdout().split('\n')[0]).pid;
  process.kill(pid, 'SIGKILL');
  assert.equal((await finish(run)).code, 137);
});

test('SCN-003 子程序停止回應 EOF 時限本工作強制收尾', async () => {
  const run = start();
  await until(() => run.stdout().includes('"pid":'));
  const pid = JSON.parse(run.stdout().split('\n')[0]).pid;
  process.kill(pid, 'SIGSTOP');
  run.child.stdin.end();
  assert.equal((await finish(run)).code, 137);
  assert.equal(existsSync(`/proc/${pid}`), false);
});

test('SCN-004 A 收尾不影響 B 的程序、profile 或 stdio', async () => {
  const a = start();
  const b = start();
  await until(() => a.stdout().includes('"pid":') && b.stdout().includes('"pid":'));
  assert.notEqual(rootOf(a), rootOf(b));
  try {
    a.child.stdin.end();
    assert.equal((await finish(a)).code, 0);
    assert.equal(existsSync(rootOf(b)!), true);
    b.child.stdin.write('B-still-works\n');
    await until(() => b.stdout().includes('B-still-works\n'));
  } finally {
    b.child.stdin.end();
    assert.equal((await finish(b)).code, 0);
  }
});

test('SCN-003 收尾失敗須留下不含正文與參數的持久紀錄', async () => {
  const evidenceRoot = mkdtempSync('/tmp/tnb-audit-test-');
  const auditPath = resolve(evidenceRoot, 'audit', 'failure.jsonl');
  const run = start(undefined, { FIXTURE_BREAK_CLEANUP: '1', TELENEXUS_BROWSER_AUDIT_FILE: auditPath });
  try {
    await until(() => run.stdout().includes('"pid":'));
    run.child.stdin.end();
    assert.equal((await run.exited).code, 1);
    assert.equal(existsSync(rootOf(run)!), true);
    assert.equal(existsSync(auditPath), true, '收尾失敗不能只寫可能被 OpenCode 隱藏的 stderr');
    const record = JSON.parse(readFileSync(auditPath, 'utf8').trim());
    assert.equal(record.event, 'browser-mcp-cleanup-failed');
    assert.equal(record.root, rootOf(run));
    assert.match(record.errorCode, /EACCES|EPERM/);
    assert.deepEqual(record.remaining, []);
    assert.equal('argv' in record, false);
    assert.equal('url' in record, false);
  } finally {
    const root = rootOf(run);
    if (root && existsSync(root)) {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true });
    }
    rmSync(evidenceRoot, { recursive: true });
  }
});
