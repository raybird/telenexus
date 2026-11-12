import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, describe } from 'node:test';

// issue 0024 SCN-003／005／006：用假的 moli 驅動 scripts/moli-fetch.sh。
// 假 moli 的行為照 2026-11-12 步驟 1 對真 Moli 的實測：只寫 TMPDIR/moli-storage-*，
// 正常結束會清掉，被 SIGTERM／SIGKILL 中斷時會留下（docs/issues/issue-0024/evidence/step1-moli-probe.md）。
const wrapper = resolve('scripts/moli-fetch.sh');

const FAKE_MOLI = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_DIR/args"
env | grep '^MOLI_' > "$FAKE_DIR/moli-env" || true
echo $$ > "$FAKE_DIR/pid"
storage="$TMPDIR/moli-storage-fake"
mkdir -p "$storage" && echo x > "$storage/cookies.sqlite"
case "$FAKE_MODE" in
  ok) rm -rf "$storage"; printf 'FAKEBODY\\n' ;;
  empty) rm -rf "$storage"; printf '  \\n' ;;
  fail) rm -rf "$storage"; echo 'fake moli failed' >&2; exit 7 ;;
  hang) trap 'exit 143' TERM; while :; do sleep 0.1; done ;;
  hang-ignore-term) trap '' TERM; while :; do sleep 0.1; done ;;
esac
`;

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

const contexts: Array<ReturnType<typeof setup>> = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tn24-wrapper-test-'));
  const fakeDir = join(dir, 'fake');
  const tmp = join(dir, 'tmp');
  mkdirSync(fakeDir);
  mkdirSync(tmp);
  const fake = join(fakeDir, 'moli');
  writeFileSync(fake, FAKE_MOLI);
  chmodSync(fake, 0o755);
  const ctx = { dir, fakeDir, tmp, fake };
  contexts.push(ctx);
  return ctx;
}

// wrapper 收尾壞掉時（例如 timeout 沒作用），假 moli 會一直活著，測試逾時後 finally 也不會執行，
// 整個測試程序就會卡住。這裡在所有測試結束後一律收掉，讓失敗只呈現為失敗。
after(() => {
  for (const ctx of contexts) {
    const pid = fakePid(ctx);
    if (alive(pid)) process.kill(pid!, 'SIGKILL');
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

function start(ctx: ReturnType<typeof setup>, args: string[], mode = 'ok', detached = false) {
  const child = spawn(wrapper, args, {
    env: {
      ...process.env,
      TELENEXUS_MOLI_BIN: ctx.fake,
      FAKE_DIR: ctx.fakeDir,
      FAKE_MODE: mode,
      TMPDIR: ctx.tmp,
      MOLI_BLOCK_PRIVATE_NETWORKS: '0',
      MOLI_LAYOUT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  });
  const t0 = Date.now();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  // 等 close（所有持有 stdout／stderr 的程序都關閉），不是 exit：
  // opencode 的 bash 工具也是等管線關閉才回傳。
  const done = new Promise<Run>((resolveRun) => {
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr, ms: Date.now() - t0 }));
  });
  return { child, done };
}

function fakePid(ctx: ReturnType<typeof setup>): number | undefined {
  try { return Number(readFileSync(join(ctx.fakeDir, 'pid'), 'utf8').trim()); } catch { return undefined; }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch { return false; }
}

/** TMPDIR 底下還留著的項目（wrapper 的暫存目錄、Moli 的 storage）。 */
function leftovers(ctx: ReturnType<typeof setup>): string[] {
  return readdirSync(ctx.tmp);
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return check();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REJECTED: Array<[string, string[]]> = [
  ['沒有參數', []],
  ['兩個網址', ['https://example.com/a', 'https://example.com/b']],
  ['file 網址', ['file:///etc/hostname']],
  ['data 網址', ['data:text/html,<p>x</p>']],
  ['夾帶 Moli 參數', ['--dump', 'html', 'https://example.com']],
  ['只有參數', ['--layout']],
  ['javascript 網址', ['javascript:alert(1)']],
];

for (const [name, args] of REJECTED) {
  test(`SCN-006 ${name}：exit 2、stdout 沒有內容、不啟動 Moli`, async () => {
    const ctx = setup();
    try {
      const run = await start(ctx, args).done;
      assert.equal(run.code, 2);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /\S/);
      assert.equal(existsSync(join(ctx.fakeDir, 'args')), false, 'Moli 不應該被啟動');
      assert.deepEqual(leftovers(ctx), []);
    } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
  });
}

test('SCN-006 http/https 網址：以固定參數呼叫 Moli、封鎖內網、不帶 MOLI_ 環境變數', async () => {
  for (const url of ['https://example.com/page?q=1', 'HTTP://example.com/']) {
    const ctx = setup();
    try {
      const run = await start(ctx, [url]).done;
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stdout, 'FAKEBODY\n');
      const args = readFileSync(join(ctx.fakeDir, 'args'), 'utf8').trim().split('\n');
      assert.equal(args[0], 'fetch');
      assert.ok(args.includes('--block-private-networks'));
      assert.deepEqual(args.slice(args.indexOf('--dump'), args.indexOf('--dump') + 2), ['--dump', 'markdown']);
      assert.ok(args.includes('--fail'));
      assert.deepEqual(args.slice(-2), ['--', url], '網址放在 -- 之後、而且是最後一個參數');
      assert.equal(readFileSync(join(ctx.fakeDir, 'moli-env'), 'utf8'), '', 'MOLI_ 環境變數不能影響 Moli');
      assert.ok(run.ms < 5000, `正常讀取不能被背景清理程序拖住（實際 ${run.ms}ms）`);
      assert.deepEqual(leftovers(ctx), []);
    } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
  }
});

test('SCN-003 Moli 輸出只有空白：exit 3 並說明沒有正文', async () => {
  const ctx = setup();
  try {
    const run = await start(ctx, ['https://example.com/'], 'empty').done;
    assert.equal(run.code, 3);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /正文/);
    assert.deepEqual(leftovers(ctx), []);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('SCN-003 Moli 以非 0 結束：原樣傳回結束碼', async () => {
  const ctx = setup();
  try {
    const run = await start(ctx, ['https://example.com/'], 'fail').done;
    assert.equal(run.code, 7);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /fake moli failed/);
    assert.deepEqual(leftovers(ctx), []);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

// 這幾個測試各要等 5～45 秒，彼此獨立（各自的暫存目錄與假 moli），平行跑才不會拖慢整套測試。
describe('SCN-005 收尾', { concurrency: true }, () => {
  test('SCN-005 超過 30 秒：exit 124，Moli 被終止，暫存檔清掉', { timeout: 60_000 }, async () => {
    const ctx = setup();
    try {
      const run = await start(ctx, ['https://example.com/'], 'hang').done;
      assert.equal(run.code, 124);
      assert.ok(run.ms >= 29_000 && run.ms < 35_000, `應在 30 秒左右結束（實際 ${run.ms}ms）`);
      assert.match(run.stderr, /逾時/);
      assert.equal(alive(fakePid(ctx)), false);
      assert.deepEqual(leftovers(ctx), []);
    } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
  });

  test('SCN-005 Moli 不理會 SIGTERM：35 秒時被 SIGKILL，exit 124，暫存檔清掉', { timeout: 60_000 }, async () => {
    const ctx = setup();
    try {
      const run = await start(ctx, ['https://example.com/'], 'hang-ignore-term').done;
      assert.equal(run.code, 124);
      assert.ok(run.ms >= 34_000 && run.ms < 40_000, `應在 35 秒左右結束（實際 ${run.ms}ms）`);
      assert.equal(alive(fakePid(ctx)), false);
      assert.deepEqual(leftovers(ctx), []);
    } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
  });

  test('SCN-005 wrapper 收到 SIGTERM：Moli 一起結束，暫存檔清掉', { timeout: 30_000 }, async () => {
    const ctx = setup();
    try {
      const { child, done } = start(ctx, ['https://example.com/'], 'hang');
      assert.ok(await waitUntil(() => alive(fakePid(ctx)), 5000), 'Moli 應該已啟動');
      child.kill('SIGTERM');
      const run = await done;
      assert.ok(run.ms < 10_000, `應該很快結束（實際 ${run.ms}ms）`);
      assert.ok(await waitUntil(() => !alive(fakePid(ctx)), 5000), 'Moli 應該已結束');
      assert.ok(await waitUntil(() => leftovers(ctx).length === 0, 5000), `殘留：${leftovers(ctx).join(', ')}`);
    } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
  });

  test('SCN-005 整個 process group 被 SIGKILL：背景清理程序仍會刪掉暫存檔', { timeout: 30_000 }, async () => {
    const ctx = setup();
    try {
      const { child, done } = start(ctx, ['https://example.com/'], 'hang', true);
      assert.ok(await waitUntil(() => alive(fakePid(ctx)), 5000), 'Moli 應該已啟動');
      assert.ok(child.pid);
      process.kill(-child.pid, 'SIGKILL');
      await done;
      assert.ok(await waitUntil(() => !alive(fakePid(ctx)), 5000), 'Moli 應該已結束');
      assert.ok(await waitUntil(() => leftovers(ctx).length === 0, 10_000), `殘留：${leftovers(ctx).join(', ')}`);
    } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
  });

  test('SCN-005 只有 wrapper 被 SIGKILL：啟動後 45 秒內 Moli 結束、暫存檔清掉', { timeout: 70_000 }, async () => {
    const ctx = setup();
    try {
      const t0 = Date.now();
      const { child, done } = start(ctx, ['https://example.com/'], 'hang');
      assert.ok(await waitUntil(() => alive(fakePid(ctx)), 5000), 'Moli 應該已啟動');
      child.kill('SIGKILL');
      await done.catch(() => undefined);
      const remaining = 45_000 - (Date.now() - t0);
      assert.ok(await waitUntil(() => !alive(fakePid(ctx)) && leftovers(ctx).length === 0, remaining),
        `45 秒內應收尾；Moli 存活=${alive(fakePid(ctx))}，殘留：${leftovers(ctx).join(', ')}`);
    } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
  });
});
