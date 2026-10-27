import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { warnIfMemoryBackfillConfigured } from '../src/services/retired-memory-backfill.js';
import { startWebServer } from '../src/web/server.js';
import { MemoryManager } from '../src/core/memory.js';

/** issue 0022：記憶回填已移除。 */

for (const [label, value, expected] of [
  ['true', 'true', true],
  ['1（v2.32.0 的 parseBool 也當成開啟）', '1', true],
  ['false', 'false', false],
  ['未設定', undefined, false]
] as const) {
  test(`issue 0022 SCN-006 MEMORY_BACKFILL_ENABLED=${label} → ${expected ? '警告一行' : '不印'}`, () => {
    const lines: string[] = [];
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { MEMORY_BACKFILL_ENABLED: value };
    assert.equal(
      warnIfMemoryBackfillConfigured(env, (m) => lines.push(m)),
      expected
    );
    if (expected) {
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /回填已移除/);
      assert.match(lines[0]!, /MEMORY_BACKFILL_ENABLED 不再有作用/);
    } else {
      assert.deepEqual(lines, []);
    }
  });
}

test('issue 0022 SCN-005 GET /api/memory-backfill/report 回 404，其他 API 照常', async () => {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-retired-backfill-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  const port = 39241;
  const server = startWebServer({
    enabled: true,
    host: '127.0.0.1',
    port,
    trustPrivateNetwork: true,
    alertErrorThreshold: 10,
    alertRunnerSuccessWarnThreshold: 90,
    defaultUserId: 'web-user',
    commandRouter: {} as never,
    memory: new MemoryManager(),
    scheduler: {} as never,
    userAgent: {} as never,
    chatRunnerAgent: {} as never,
    useRunnerForChat: false,
    chatRunnerPercent: 0,
    chatRunnerOnlyUsers: new Set<string>(),
    shouldSummarize: () => false,
    buildPrompt: (m) => m,
    recordRuntimeIssue() {},
    writeContextSnapshots() {}
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const removed = await fetch(`http://127.0.0.1:${port}/api/memory-backfill/report?limit=6`);
    assert.equal(removed.status, 404);
    // 對照組：同一個 server 的健康 API 有回應，404 不是因為 server 沒起來
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    await server.close();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
