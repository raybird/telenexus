import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { MemoriaRecallClient } from '../src/core/memoria-recall.js';
import { MemoryManager } from '../src/core/memory.js';
import { startRecallMetricsStore } from '../src/services/recall-metrics-store.js';
import { getRecentIssues } from '../src/utils/errors.js';

/**
 * Issue 0020 AC-1：每次聊天召回逐筆存進 moltbot.db 的 memoria_recall_events，跨重啟保留。
 */

// recall 會 emitEvent 到 <APP_PROJECT_DIR>/workspace/context/events.jsonl，導到暫存目錄。
let projectDir = '';
let savedProjectDir: string | undefined;
before(() => {
  savedProjectDir = process.env.APP_PROJECT_DIR;
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-recall-metrics-'));
  process.env.APP_PROJECT_DIR = projectDir;
});
after(() => {
  if (savedProjectDir === undefined) delete process.env.APP_PROJECT_DIR;
  else process.env.APP_PROJECT_DIR = savedProjectDir;
  fs.rmSync(projectDir, { recursive: true, force: true });
});

const QUERY = '上次清理殭屍程序的結論是什麼';
const SNIPPET = '那次清理殭屍程序的結論是改用 /proc 統計';
const DAY_MS = 24 * 60 * 60 * 1000;

type FakeReply =
  | { status: 200; hits: number; confidence: number | null; routeMode?: string }
  | { status: 500 };

async function withMemoria(
  reply: FakeReply,
  fn: (endpoint: string) => Promise<void>
): Promise<void> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (reply.status === 500) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: Array.from({ length: reply.hits }, (_, i) => ({
            id: `hit-${i}`,
            snippet: SNIPPET,
            score: 0.3
          })),
          meta: {
            recall_id: 'rc-1',
            route_mode: reply.routeMode ?? 'hybrid_tree',
            confidence: reply.confidence,
            confidence_basis: reply.confidence === null ? 'unavailable' : 'lexical_coverage'
          }
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withTempDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-recall-metrics-db-'));
  const dbPath = path.join(tempDir, 'moltbot.db');
  process.env.DB_PATH = dbPath;
  try {
    await fn(dbPath);
  } finally {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

type EventRow = {
  ts: number;
  app_version: string;
  scope_kind: string;
  ok: number;
  route_mode: string;
  hit_count: number;
  dropped_low_confidence: number;
  injected: number;
  degraded: number;
  latency_ms: number;
};

function readRows(dbPath: string): EventRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM memoria_recall_events ORDER BY id`).all() as EventRow[];
  } finally {
    db.close();
  }
}

async function recallOnce(
  reply: FakeReply,
  scope: string | undefined = 'user:u1'
): Promise<string[]> {
  let snippets: string[] = [];
  await withMemoria(reply, async (endpoint) => {
    const client = new MemoriaRecallClient({ endpoint, timeoutMs: 2000 });
    snippets = (await client.recallWithMeta(QUERY, scope)).snippets;
  });
  return snippets;
}

const CASES: Array<{
  label: string;
  reply: FakeReply;
  expected: Partial<EventRow>;
  injected: boolean;
}> = [
  {
    label: '成功有命中',
    reply: { status: 200, hits: 2, confidence: 0.5 },
    expected: {
      ok: 1,
      route_mode: 'hybrid_tree',
      hit_count: 2,
      dropped_low_confidence: 0,
      degraded: 0
    },
    injected: true
  },
  {
    label: '成功零命中',
    reply: { status: 200, hits: 0, confidence: null },
    expected: { ok: 1, hit_count: 0, dropped_low_confidence: 0, degraded: 0 },
    injected: false
  },
  {
    label: '信心低於門檻而丟棄',
    reply: { status: 200, hits: 3, confidence: 0.1 },
    expected: { ok: 1, hit_count: 3, dropped_low_confidence: 1, degraded: 0 },
    injected: false
  },
  {
    label: '語意索引退回字面（降級）',
    reply: { status: 200, hits: 1, confidence: 0.5, routeMode: 'vector_unavailable' },
    expected: { ok: 1, route_mode: 'vector_unavailable', hit_count: 1, degraded: 1 },
    injected: true
  },
  {
    label: 'HTTP 失敗',
    reply: { status: 500 },
    expected: { ok: 0, route_mode: 'error', hit_count: 0, dropped_low_confidence: 0, degraded: 0 },
    injected: false
  }
];

for (const { label, reply, expected, injected } of CASES) {
  test(`AC-1：${label}時寫入一筆，injected=${injected}`, async () => {
    await withTempDb(async (dbPath) => {
      const memory = new MemoryManager();
      const store = startRecallMetricsStore(memory, { appVersion: '9.9.9' });
      let snippets: string[] = [];
      try {
        snippets = await recallOnce(reply);
      } finally {
        store.stop();
      }

      const rows = readRows(dbPath);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(row[key as keyof EventRow], value, key);
      }
      assert.equal(row.app_version, '9.9.9');
      assert.equal(row.scope_kind, 'user');
      assert.equal(row.injected, injected ? 1 : 0);
      // injected 要和召回實際交給 prompt 組裝的 snippet 一致
      assert.equal(snippets.length > 0, injected);
      assert.ok(row.latency_ms >= 0);
    });
  });
}

test('AC-1：不存問句、snippet 與使用者 ID', async () => {
  await withTempDb(async (dbPath) => {
    const memory = new MemoryManager();
    const store = startRecallMetricsStore(memory, { appVersion: '9.9.9' });
    try {
      await recallOnce({ status: 200, hits: 1, confidence: 0.5 }, 'user:secret-user-42');
    } finally {
      store.stop();
    }
    const serialized = JSON.stringify(readRows(dbPath));
    assert.ok(!serialized.includes(QUERY));
    assert.ok(!serialized.includes(SNIPPET));
    assert.ok(!serialized.includes('secret-user-42'));
  });
});

test('AC-1：重新開啟資料庫後資料仍在', async () => {
  await withTempDb(async () => {
    const first = new MemoryManager();
    const store = startRecallMetricsStore(first, { appVersion: '9.9.9' });
    try {
      await recallOnce({ status: 200, hits: 1, confidence: 0.5 });
    } finally {
      store.stop();
    }

    const reopened = new MemoryManager();
    const [summary] = reopened.summarizeMemoriaRecallByVersion();
    assert.equal(summary?.version, '9.9.9');
    assert.equal(summary?.total, 1);
  });
});

test('AC-1：啟動時清掉超過 30 天的資料', async () => {
  await withTempDb(async (dbPath) => {
    const memory = new MemoryManager();
    const base = {
      appVersion: '9.9.8',
      scopeKind: 'user',
      ok: true,
      routeMode: 'hybrid_tree',
      hitCount: 1,
      droppedLowConfidence: false,
      injected: true,
      degraded: false,
      latencyMs: 10
    };
    memory.appendMemoriaRecallEvent({ ...base, ts: Date.now() - 31 * DAY_MS });
    memory.appendMemoriaRecallEvent({ ...base, ts: Date.now() - 29 * DAY_MS });

    const store = startRecallMetricsStore(memory, { appVersion: '9.9.9' });
    store.stop();

    const rows = readRows(dbPath);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.ts > Date.now() - 30 * DAY_MS);
  });
});

test('AC-1：寫入失敗不影響召回，只印 warn，不記 runtime issue', async () => {
  const broken = {
    appendMemoriaRecallEvent: () => {
      throw new Error('database is locked');
    },
    purgeOldMemoriaRecallEvents: () => 0
  } as unknown as MemoryManager;
  const issuesBefore = getRecentIssues().reduce((sum, issue) => sum + issue.count, 0);
  const warnings: string[] = [];
  const { warn } = console;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
  const store = startRecallMetricsStore(broken, { appVersion: '9.9.9' });
  let snippets: string[] = [];
  try {
    snippets = await recallOnce({ status: 200, hits: 1, confidence: 0.5 });
  } finally {
    store.stop();
    console.warn = warn;
  }

  assert.deepEqual(snippets, [SNIPPET]);
  assert.ok(warnings.some((line) => line.includes('database is locked')));
  assert.equal(
    getRecentIssues().reduce((sum, issue) => sum + issue.count, 0),
    issuesBefore
  );
});
