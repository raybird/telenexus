import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { MemoriaRecallClient } from '../src/core/memoria-recall.js';
import { MemoryManager } from '../src/core/memory.js';
import { buildMemoryContextAsync } from '../src/prompt/builder.js';
import { addEventHook } from '../src/services/event-bus.js';

/**
 * Issue 0012 SCN-008:Memoria 召回的 confidence 低於門檻時不注入。
 *
 * 門檻預設 0.2,取自正式資料快照的抽樣:無關問題最高 0.143、相關問題最低 0.25
 * (docs/issues/issue-0012/evidence/step6-confidence-sampling.md)。
 * confidence 為 null 代表該路由無法判斷,維持注入(與變更前相同)。
 */

// recall 會 emitEvent 到 <APP_PROJECT_DIR>/workspace/context/events.jsonl,導到暫存目錄。
let projectDir = '';
let savedProjectDir: string | undefined;
before(() => {
  savedProjectDir = process.env.APP_PROJECT_DIR;
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-recall-threshold-'));
  process.env.APP_PROJECT_DIR = projectDir;
});
after(() => {
  if (savedProjectDir === undefined) delete process.env.APP_PROJECT_DIR;
  else process.env.APP_PROJECT_DIR = savedProjectDir;
  fs.rmSync(projectDir, { recursive: true, force: true });
});

const MEMORIA_SNIPPET = '那次清理殭屍程序的結論是改用 /proc 統計';

async function withMemoria(
  confidence: number | null,
  fn: (endpoint: string) => Promise<void>
): Promise<void> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'hit-1', snippet: MEMORIA_SNIPPET, score: 0.3 }],
          meta: {
            recall_id: 'rc-1',
            route_mode: 'hybrid_tree',
            confidence,
            confidence_basis: confidence === null ? 'unavailable' : 'lexical_coverage'
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

async function withThresholdEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.MEMORIA_RECALL_MIN_CONFIDENCE;
  if (value === undefined) delete process.env.MEMORIA_RECALL_MIN_CONFIDENCE;
  else process.env.MEMORIA_RECALL_MIN_CONFIDENCE = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.MEMORIA_RECALL_MIN_CONFIDENCE;
    else process.env.MEMORIA_RECALL_MIN_CONFIDENCE = saved;
  }
}

async function recallSnippets(confidence: number | null): Promise<string[]> {
  let snippets: string[] = [];
  await withMemoria(confidence, async (endpoint) => {
    const client = new MemoriaRecallClient({ endpoint, timeoutMs: 2000 });
    snippets = (await client.recallWithMeta('問題', 'user:u')).snippets;
  });
  return snippets;
}

const CASES: {
  label: string;
  env: string | undefined;
  confidence: number | null;
  kept: boolean;
}[] = [
  { label: '預設門檻,0.143(無關問題的最高值)', env: undefined, confidence: 0.143, kept: false },
  { label: '預設門檻,等於 0.2', env: undefined, confidence: 0.2, kept: true },
  { label: '預設門檻,0.25(相關問題的最低值)', env: undefined, confidence: 0.25, kept: true },
  { label: '預設門檻,confidence 為 null', env: undefined, confidence: null, kept: true },
  { label: '門檻設為 0(停用)', env: '0', confidence: 0.05, kept: true },
  { label: '門檻設為 0.5', env: '0.5', confidence: 0.375, kept: false },
  { label: '門檻設定無效時用預設值', env: 'abc', confidence: 0.143, kept: false },
  { label: '門檻超過 1 時用預設值', env: '1.5', confidence: 0.25, kept: true }
];

for (const { label, env, confidence, kept } of CASES) {
  test(`SCN-008: ${label} → ${kept ? '注入' : '不注入'}`, async () => {
    await withThresholdEnv(env, async () => {
      assert.deepEqual(await recallSnippets(confidence), kept ? [MEMORIA_SNIPPET] : []);
    });
  });
}

test('SCN-008: 丟棄時 memoria_recall 事件帶有標記與門檻', async () => {
  const events: Record<string, unknown>[] = [];
  const off = addEventHook((type, payload) => {
    if (type === 'memoria_recall') events.push(payload);
  });
  try {
    await withThresholdEnv(undefined, async () => {
      await recallSnippets(0.1);
      await recallSnippets(0.3);
    });
  } finally {
    off();
  }
  assert.equal(events.length, 2);
  assert.equal(events[0]?.dropped_low_confidence, true);
  assert.equal(events[0]?.min_confidence, 0.2);
  assert.equal(events[0]?.hit_count, 1);
  assert.equal(events[1]?.dropped_low_confidence, undefined);
});

test('SCN-008: 信心過低時,「相關歷史摘要」不含 Memoria 的結果', async () => {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-recall-threshold-db-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  try {
    const memory = new MemoryManager();
    memory.addMessage('u', 'user', '之前殭屍程序的問題');
    memory.addMessage('u', 'model', '已檢查');
    for (const [confidence, expected] of [
      [0.1, false],
      [0.3, true]
    ] as const) {
      await withMemoria(confidence, async (endpoint) => {
        const client = new MemoriaRecallClient({ endpoint, timeoutMs: 2000 });
        const context = await buildMemoryContextAsync(memory, 'u', '殭屍程序後來怎麼處理', (q, s) =>
          client.recall(q, s)
        );
        assert.equal(context.includes(MEMORIA_SNIPPET), expected);
      });
    }
  } finally {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
