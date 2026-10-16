import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createOpencodeRetentionDeps,
  loadRetentionConfig,
  parseCandidateRows,
  parseSpaceStats,
  runRetentionOnce,
  shouldMainRunRetention,
  startOpencodeSessionRetention,
  type RetentionCandidate,
  type RetentionDeps
} from '../src/services/opencode-session-retention.js';
import { addIssueHook } from '../src/utils/errors.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const ENABLED = { enabled: true, retentionDays: 30 };

function candidate(id: string, ageDays: number): RetentionCandidate {
  return { id, updatedAt: NOW - ageDays * DAY, parentId: null };
}

function fakeDeps(overrides: Partial<RetentionDeps> = {}): RetentionDeps & {
  deleted: string[];
  queriedLimits: number[];
} {
  const deleted: string[] = [];
  const queriedLimits: number[] = [];
  return {
    deleted,
    queriedLimits,
    queryCandidates: async (limit) => {
      queriedLimits.push(limit);
      return [
        candidate('fresh', 5),
        candidate('old-a', 90),
        candidate('bound', 120),
        candidate('old-b', 40)
      ];
    },
    deleteSession: async (id) => {
      deleted.push(id);
    },
    readProtectedIds: () => new Set(['bound']),
    readSpaceStats: async () => ({ pageCount: 1000, freelistCount: 0 }),
    vacuum: async () => {},
    isIdle: () => true,
    now: () => NOW,
    ...overrides
  };
}

function captureIssueScopes(): { scopes: string[]; unhook: () => void } {
  const scopes: string[] = [];
  const unhook = addIssueHook(({ scope }) => {
    scopes.push(scope);
  });
  return { scopes, unhook };
}

test('SCN-003: 未設定時預設啟用並保留 30 天', () => {
  assert.deepEqual(loadRetentionConfig({}), { enabled: true, retentionDays: 30 });
});

test('SCN-003: 保留天數可設定，停用旗標生效', () => {
  assert.deepEqual(loadRetentionConfig({ OPENCODE_SESSION_RETENTION_DAYS: '7' }), {
    enabled: true,
    retentionDays: 7
  });
  assert.deepEqual(loadRetentionConfig({ OPENCODE_SESSION_RETENTION_ENABLED: 'false' }), {
    enabled: false,
    retentionDays: 30
  });
});

test('SCN-003: 無效的保留天數退回預設 30 天，不會變成 0 天刪光', () => {
  assert.equal(loadRetentionConfig({ OPENCODE_SESSION_RETENTION_DAYS: '0' }).retentionDays, 30);
  assert.equal(loadRetentionConfig({ OPENCODE_SESSION_RETENTION_DAYS: 'abc' }).retentionDays, 30);
  assert.equal(loadRetentionConfig({ OPENCODE_SESSION_RETENTION_DAYS: '-5' }).retentionDays, 30);
});

test('SCN-001: 解析 opencode db 的 JSON 輸出', () => {
  const stdout =
    '[\n  {"id":"ses_a","time_updated":1792136722433,"parent_id":null},\n' +
    '  {"id":"ses_b","time_updated":1700000000000,"parent_id":"ses_a"},\n' +
    '  {"id":"ses_c","parent_id":null}\n]\n';
  assert.deepEqual(parseCandidateRows(stdout), [
    { id: 'ses_a', updatedAt: 1792136722433, parentId: null },
    { id: 'ses_b', updatedAt: 1700000000000, parentId: 'ses_a' },
    { id: 'ses_c', updatedAt: null, parentId: null }
  ]);
  assert.deepEqual(parseCandidateRows('[]\n'), []);
});

test('SCN-005: 被截斷或格式不符的輸出視為失敗，不以部分結果刪除', () => {
  assert.throws(() => parseCandidateRows('[\n  {"id":"ses_a","time_updated":17921'));
  assert.throws(() => parseCandidateRows('{"id":"ses_a"}'));
  assert.throws(() => parseCandidateRows('[{"time_updated":1}]'));
});

test('SCN-001/SCN-002: 刪除過期的 session，綁定中與未過期的保留', async () => {
  const deps = fakeDeps();
  const result = await runRetentionOnce(ENABLED, deps, 100);
  assert.deepEqual(deps.deleted, ['old-a', 'old-b']);
  assert.deepEqual(deps.queriedLimits, [101]);
  assert.equal(result.skipped, undefined);
  assert.equal(result.candidates, 2);
  assert.equal(result.deleted, 2);
  assert.equal(result.failed, 0);
});

test('SCN-003: 停用時不查詢也不刪除', async () => {
  const deps = fakeDeps();
  const result = await runRetentionOnce({ enabled: false, retentionDays: 30 }, deps, 100);
  assert.equal(result.skipped, 'disabled');
  assert.deepEqual(deps.queriedLimits, []);
  assert.deepEqual(deps.deleted, []);
});

test('SCN-002/SCN-005: 讀不到綁定時跳過這次清理並記錄 runtime issue', async () => {
  const { scopes, unhook } = captureIssueScopes();
  try {
    const deps = fakeDeps({
      readProtectedIds: () => {
        throw new Error('chat session state is not an object (retention test)');
      }
    });
    const result = await runRetentionOnce(ENABLED, deps, 100);
    assert.equal(result.skipped, 'protected-ids-unavailable');
    assert.deepEqual(deps.deleted, []);
    assert.deepEqual(scopes, ['opencode-retention:protected-ids']);
  } finally {
    unhook();
  }
});

test('SCN-005: 查詢失敗時記錄 runtime issue，不拋出', async () => {
  const { scopes, unhook } = captureIssueScopes();
  try {
    const deps = fakeDeps({
      queryCandidates: async () => {
        throw new Error('database is locked (retention query test)');
      }
    });
    const result = await runRetentionOnce(ENABLED, deps, 100);
    assert.equal(result.skipped, 'query-failed');
    assert.deepEqual(deps.deleted, []);
    assert.deepEqual(scopes, ['opencode-retention:query']);
  } finally {
    unhook();
  }
});

test('SCN-005: 單一 session 刪除失敗時繼續刪其他的，並記錄 runtime issue', async () => {
  const { scopes, unhook } = captureIssueScopes();
  try {
    const attempted: string[] = [];
    const deps = fakeDeps({
      deleteSession: async (id) => {
        attempted.push(id);
        if (id === 'old-a') throw new Error('Process exited with code 1 (retention delete test)');
      }
    });
    const result = await runRetentionOnce(ENABLED, deps, 100);
    assert.deepEqual(attempted, ['old-a', 'old-b']);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(scopes, ['opencode-retention:delete']);
  } finally {
    unhook();
  }
});

test('有 runner 時主服務不清理，沒有 runner 時由主服務清理', () => {
  assert.equal(shouldMainRunRetention('http://agent-runner:8787'), false);
  assert.equal(shouldMainRunRetention(''), true);
  assert.equal(shouldMainRunRetention(undefined), true);
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('SCN-003: 啟動時不立刻清理，到達間隔才執行，stop 後不再執行', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const deps = fakeDeps();
    const handle = startOpencodeSessionRetention(ENABLED, deps, 1000);
    await flush();
    assert.deepEqual(deps.queriedLimits, []);
    mock.timers.tick(1000);
    await flush();
    assert.deepEqual(deps.queriedLimits, [101]);
    handle.stop();
    mock.timers.tick(5000);
    await flush();
    assert.deepEqual(deps.queriedLimits, [101]);
  } finally {
    mock.timers.reset();
  }
});

test('SCN-003: 停用時不排程任何清理', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const deps = fakeDeps();
    startOpencodeSessionRetention({ enabled: false, retentionDays: 30 }, deps, 1000);
    mock.timers.tick(5000);
    await flush();
    assert.deepEqual(deps.queriedLimits, []);
  } finally {
    mock.timers.reset();
  }
});

test('SCN-005: 上一次清理還沒結束時，這一輪跳過', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let release: () => void = () => {};
    const deps = fakeDeps({
      deleteSession: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    });
    const handle = startOpencodeSessionRetention(ENABLED, deps, 1000);
    mock.timers.tick(1000);
    await flush();
    mock.timers.tick(1000);
    await flush();
    assert.deepEqual(deps.queriedLimits, [101]);
    release();
    handle.stop();
  } finally {
    mock.timers.reset();
  }
});

test('SCN-001/SCN-005: 實際的 deps 以 opencode CLI 查詢與刪除，刪除失敗會拋出', async () => {
  // 假的 opencode：記下每次的參數；db 吐固定的 JSON，刪除 ses_fail 時以 exit 1 失敗。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-fake-opencode-retention-'));
  const argsLog = path.join(dir, 'args.log');
  fs.writeFileSync(
    path.join(dir, 'opencode'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${argsLog}"
case "$1" in
  db) printf '[{"id":"ses_old","time_updated":1700000000000,"parent_id":null}]\\n' ;;
  session) [ "$3" = "ses_fail" ] && { echo "Error: boom" >&2; exit 1; } ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
  try {
    const deps = createOpencodeRetentionDeps(() => true);
    assert.deepEqual(await deps.queryCandidates(3), [
      { id: 'ses_old', updatedAt: 1700000000000, parentId: null }
    ]);
    await deps.deleteSession('ses_ok');
    await assert.rejects(deps.deleteSession('ses_fail'));
    assert.deepEqual(fs.readFileSync(argsLog, 'utf8').trim().split('\n'), [
      'db --format json select id, time_updated, parent_id from session where parent_id is null order by time_updated asc limit 3',
      'session delete ses_ok',
      'session delete ses_fail'
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function reclaimDeps(
  stats: { pageCount: number; freelistCount: number },
  overrides: Partial<RetentionDeps> = {}
): ReturnType<typeof fakeDeps> & { vacuums: number } {
  const deps = fakeDeps({ readSpaceStats: async () => stats, ...overrides });
  const tracked = Object.assign(deps, { vacuums: 0 });
  const vacuum = overrides.vacuum;
  tracked.vacuum = async () => {
    tracked.vacuums += 1;
    if (vacuum) await vacuum();
  };
  return tracked;
}

test('SCN-006: 可回收空間達總頁數 20% 且沒有任務在執行時回收', async () => {
  const deps = reclaimDeps({ pageCount: 1000, freelistCount: 200 });
  const result = await runRetentionOnce(ENABLED, deps, 100, { lastReclaimAt: null });
  assert.equal(result.reclaim, 'reclaimed');
  assert.equal(deps.vacuums, 1);
});

test('SCN-006: 可回收空間低於門檻時不回收', async () => {
  const deps = reclaimDeps({ pageCount: 1000, freelistCount: 199 });
  const result = await runRetentionOnce(ENABLED, deps, 100, { lastReclaimAt: null });
  assert.equal(result.reclaim, 'below-threshold');
  assert.equal(deps.vacuums, 0);
});

test('SCN-006: 有任務在執行時不回收', async () => {
  const deps = reclaimDeps({ pageCount: 1000, freelistCount: 500 }, { isIdle: () => false });
  const result = await runRetentionOnce(ENABLED, deps, 100, { lastReclaimAt: null });
  assert.equal(result.reclaim, 'busy');
  assert.equal(deps.vacuums, 0);
});

test('SCN-006: 一天內最多回收一次', async () => {
  const state = { lastReclaimAt: NOW - 23 * 60 * 60 * 1000 };
  const deps = reclaimDeps({ pageCount: 1000, freelistCount: 500 });
  const result = await runRetentionOnce(ENABLED, deps, 100, state);
  assert.equal(result.reclaim, 'recently-reclaimed');
  assert.equal(deps.vacuums, 0);

  const later = { lastReclaimAt: NOW - 25 * 60 * 60 * 1000 };
  const again = await runRetentionOnce(ENABLED, deps, 100, later);
  assert.equal(again.reclaim, 'reclaimed');
  assert.equal(deps.vacuums, 1);
  assert.equal(later.lastReclaimAt, NOW);
});

test('SCN-005/SCN-006: 回收失敗時記錄 runtime issue，不拋出', async () => {
  const { scopes, unhook } = captureIssueScopes();
  try {
    const deps = reclaimDeps(
      { pageCount: 1000, freelistCount: 500 },
      {
        vacuum: async () => {
          throw new Error('database is locked (retention vacuum test)');
        }
      }
    );
    const result = await runRetentionOnce(ENABLED, deps, 100, { lastReclaimAt: null });
    assert.equal(result.reclaim, 'failed');
    assert.deepEqual(scopes, ['opencode-retention:vacuum']);
  } finally {
    unhook();
  }
});

test('SCN-003/SCN-006: 停用時不讀取空間也不回收', async () => {
  let reads = 0;
  const deps = reclaimDeps(
    { pageCount: 1000, freelistCount: 500 },
    {
      readSpaceStats: async () => {
        reads += 1;
        return { pageCount: 1000, freelistCount: 500 };
      }
    }
  );
  const result = await runRetentionOnce({ enabled: false, retentionDays: 30 }, deps, 100, {
    lastReclaimAt: null
  });
  assert.equal(result.reclaim, undefined);
  assert.equal(reads, 0);
  assert.equal(deps.vacuums, 0);
});

test('SCN-006: 解析 page_count 與 freelist_count，格式不符時拋出', () => {
  assert.deepEqual(
    parseSpaceStats('[\n  {"page_count": 53928, "freelist_count": 10757, "page_size": 4096}\n]\n'),
    { pageCount: 53928, freelistCount: 10757 }
  );
  assert.throws(() => parseSpaceStats('[{"page_count": 10}]'));
  assert.throws(() => parseSpaceStats('[]'));
  assert.throws(() => parseSpaceStats('[\n  {"page_count": 53'));
});

test('SCN-006: 實際的 deps 以 opencode db 讀取空間並執行 VACUUM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-fake-opencode-vacuum-'));
  const argsLog = path.join(dir, 'args.log');
  fs.writeFileSync(
    path.join(dir, 'opencode'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${argsLog}"
case "$4" in
  *pragma_page_count*) printf '[{"page_count":100,"freelist_count":30,"page_size":4096}]\\n' ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
  try {
    const deps = createOpencodeRetentionDeps(() => true);
    assert.deepEqual(await deps.readSpaceStats(), { pageCount: 100, freelistCount: 30 });
    await deps.vacuum();
    assert.deepEqual(fs.readFileSync(argsLog, 'utf8').trim().split('\n'), [
      'db --format json select * from pragma_page_count(), pragma_freelist_count(), pragma_page_size()',
      'db VACUUM'
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
