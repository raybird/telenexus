import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { MemoriaRecallClient } from '../src/core/memoria-recall.js';
import {
  countMatchedContentTokens,
  stripFunctionWords,
  tokenizeQuery
} from '../src/core/memoria-recall-query.js';
import { MemoryManager } from '../src/core/memory.js';
import { addEventHook } from '../src/services/event-bus.js';
import {
  addMemoriaRecallTraceHook,
  type MemoriaRecallTrace
} from '../src/services/memoria-recall-telemetry.js';
import { startRecallMetricsStore } from '../src/services/recall-metrics-store.js';

/**
 * Issue 0019 AC-3:注入判準改成「拿掉疑問詞與虛詞再送出,confidence 達門檻,
 * 而且第一筆 snippet 至少含 2 個不是純數字的問句 token」。
 * 判準的量測見 docs/issues/issue-0019/evidence/step2-criteria.md。
 */

let projectDir = '';
let savedProjectDir: string | undefined;
before(() => {
  savedProjectDir = process.env.APP_PROJECT_DIR;
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-recall-criteria-'));
  process.env.APP_PROJECT_DIR = projectDir;
});
after(() => {
  if (savedProjectDir === undefined) delete process.env.APP_PROJECT_DIR;
  else process.env.APP_PROJECT_DIR = savedProjectDir;
  fs.rmSync(projectDir, { recursive: true, force: true });
});

const SNIPPET = '那次清理殭屍程序的結論是改用 /proc 統計，每 15 分鐘跑一次，保留 30 天';

/** 假的 Memoria:回傳一筆 hit 與指定的 confidence,並記下收到的 query。 */
async function withMemoria(
  confidence: number | null,
  fn: (endpoint: string, queries: string[]) => Promise<void>
): Promise<void> {
  const queries: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      queries.push((JSON.parse(body) as { query: string }).query);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'hit-1', snippet: SNIPPET, score: 0.3 }],
          meta: {
            recall_id: 'rc-1',
            route_mode: 'hybrid_fallback',
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
    await fn(`http://127.0.0.1:${port}`, queries);
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

async function recallOnce(
  query: string,
  confidence: number | null
): Promise<{ snippets: string[]; recallId?: string; sent: string }> {
  let out: { snippets: string[]; recallId?: string; sent: string } = { snippets: [], sent: '' };
  await withMemoria(confidence, async (endpoint, queries) => {
    const client = new MemoriaRecallClient({ endpoint, timeoutMs: 2000 });
    const result = await client.recallWithMeta(query, 'user:u');
    out = {
      snippets: result.snippets,
      ...(result.recallId ? { recallId: result.recallId } : {}),
      sent: queries[0] ?? ''
    };
  });
  return out;
}

test('stripFunctionWords 把疑問詞與虛詞換成空白,前後的字不會接成新詞', () => {
  assert.equal(stripFunctionWords('晚餐吃什麼好？'), '晚餐吃 好？');
  assert.equal(stripFunctionWords('殭屍程序後來怎麼處理的呢'), '殭屍程序 處理');
  // 單字虛詞也拿掉:「要準備」只剩「準備」,不會留下「要準」這個窗格
  assert.equal(stripFunctionWords('出國前要準備什麼東西？'), '出國前 準備 東西？');
  assert.equal(stripFunctionWords('什麼？'), '？');
});

test('tokenizeQuery 與 Memoria 1.28.1 相同:英數字整段、中文切成 2 字窗格', () => {
  assert.deepEqual(tokenizeQuery('Taonix 排程 改成'), ['taonix', '排程', '改成']);
  assert.deepEqual(tokenizeQuery('殭屍程序 處理'), ['殭屍', '屍程', '程序', '處理']);
  assert.deepEqual(tokenizeQuery('17 乘以 23'), ['17', '乘以', '23']);
  // 單一中文字與單一數字長度不足 2,丟掉
  assert.deepEqual(tokenizeQuery('5 公斤 磅'), ['公斤']);
});

test('countMatchedContentTokens 只算不是純數字、而且出現在 snippet 裡的 token', () => {
  assert.equal(countMatchedContentTokens('殭屍程序 處理', SNIPPET), 3);
  assert.equal(countMatchedContentTokens('15 分鐘', SNIPPET), 1);
  assert.equal(countMatchedContentTokens('PROC 統計', SNIPPET), 2);
});

test('AC-3:送給 Memoria 的是拿掉疑問詞與虛詞後的問句', async () => {
  const { sent } = await recallOnce('殭屍程序後來怎麼處理的呢', 0.5);
  assert.equal(sent, '殭屍程序 處理');
});

test('AC-3:整句都是疑問詞時改送原句,而且不注入', async () => {
  await withThresholdEnv(undefined, async () => {
    const { sent, snippets } = await recallOnce('為什麼呢', 0.5);
    assert.equal(sent, '為什麼呢');
    assert.deepEqual(snippets, []);
  });
});

const CASES: {
  label: string;
  env: string | undefined;
  query: string;
  confidence: number | null;
  kept: boolean;
}[] = [
  {
    label: 'confidence 達門檻、命中 3 個內容 token',
    env: undefined,
    query: '殭屍程序後來怎麼處理',
    confidence: 0.5,
    kept: true
  },
  {
    label: 'confidence 達門檻、只命中 1 個內容 token',
    env: undefined,
    query: '每天要跑幾次統計',
    confidence: 0.5,
    kept: false
  },
  // 兩個數字都在 snippet 裡;數字若也算命中就會湊滿 2 個
  {
    label: '命中的只有數字',
    env: undefined,
    query: '15 加 30 是多少',
    confidence: 0.5,
    kept: false
  },
  // 原句的「結論是什麼」在 snippet 裡有「結論」「論是」兩個窗格,拿掉虛詞後只剩「結論」
  {
    label: '第二個命中是虛詞拼成的窗格',
    env: undefined,
    query: '結論是什麼',
    confidence: 0.5,
    kept: false
  },
  {
    label: '命中 2 個內容 token 但 confidence 低於門檻',
    env: undefined,
    query: '殭屍程序 處理',
    confidence: 0.1,
    kept: false
  },
  {
    label: 'confidence 為 null 時照常注入',
    env: undefined,
    query: '每天要跑幾次統計',
    confidence: null,
    kept: true
  },
  {
    label: '門檻設為 0 時停用整個判準',
    env: '0',
    query: '每天要跑幾次統計',
    confidence: 0.05,
    kept: true
  }
];

for (const { label, env, query, confidence, kept } of CASES) {
  test(`AC-3:${label} → ${kept ? '注入' : '不注入'}`, async () => {
    await withThresholdEnv(env, async () => {
      assert.deepEqual((await recallOnce(query, confidence)).snippets, kept ? [SNIPPET] : []);
    });
  });
}

test('AC-3:被新判準擋下時,事件與 trace 都記為丟棄、未注入,也不回傳 recall_id', async () => {
  const events: Record<string, unknown>[] = [];
  const traces: MemoriaRecallTrace[] = [];
  const offEvent = addEventHook((type, payload) => {
    if (type === 'memoria_recall') events.push(payload);
  });
  const offTrace = addMemoriaRecallTraceHook((trace) => traces.push(trace));
  try {
    await withThresholdEnv(undefined, async () => {
      const dropped = await recallOnce('每天要跑幾次統計', 0.5);
      assert.equal(dropped.recallId, undefined);
      const kept = await recallOnce('殭屍程序後來怎麼處理', 0.5);
      assert.equal(kept.recallId, 'rc-1');
    });
  } finally {
    offEvent();
    offTrace();
  }
  assert.equal(events.length, 2);
  assert.equal(events[0]?.dropped_low_confidence, true);
  assert.equal(events[0]?.min_confidence, 0.2);
  assert.equal(events[0]?.matched_tokens, 1);
  assert.equal(events[0]?.min_matched_tokens, 2);
  assert.equal(events[1]?.dropped_low_confidence, undefined);
  assert.deepEqual(
    traces.map((t) => [t.droppedLowConfidence, t.injected]),
    [
      [true, false],
      [false, true]
    ]
  );
});

test('AC-3:被新判準擋下的召回,#20 的指標記為未注入', async () => {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-recall-criteria-db-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  const memory = new MemoryManager();
  const store = startRecallMetricsStore(memory, { appVersion: '9.9.9' });
  try {
    await withThresholdEnv(undefined, async () => {
      await recallOnce('每天要跑幾次統計', 0.5);
    });
    const [summary] = memory.summarizeMemoriaRecallByVersion();
    assert.equal(summary?.version, '9.9.9');
    assert.equal(summary?.succeeded, 1);
    assert.equal(summary?.withHits, 1);
    assert.equal(summary?.injected, 0);
  } finally {
    store.stop();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
