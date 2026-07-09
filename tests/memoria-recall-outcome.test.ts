import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  MemoriaRecallClient,
  buildReuseOutcome,
  reportRecallOutcome,
  tokenCoverage
} from '../src/core/memoria-recall.js';

type CapturedRequest = { method: string; path: string; body: string };

async function withServer(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (endpoint: string, captured: CapturedRequest[]) => Promise<void>
): Promise<void> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      captured.push({ method: req.method ?? '', path: req.url ?? '', body });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('recallWithMeta 解析 Memoria 1.x envelope(data[] + meta.recall_id)', async () => {
  await withServer(
    (_req, res) =>
      jsonResponse(res, 200, {
        ok: true,
        data: [
          { id: 'hit-1', snippet: '排程規則 A', score: 0.9 },
          { id: 'hit-2', snippet: '  ', score: 0.5 },
          { snippet: '沒有 id 的 hit', score: 0.4 }
        ],
        meta: { recall_id: 'rt_abc123' }
      }),
    async (endpoint, captured) => {
      const client = new MemoriaRecallClient({ endpoint, timeoutMs: 2000 });
      const result = await client.recallWithMeta('排程', 'user:1');

      assert.equal(result.recallId, 'rt_abc123');
      assert.deepEqual(result.snippets, ['排程規則 A', '沒有 id 的 hit']);
      // hits 只保留同時有 id 與非空 snippet 的項目(可供 outcome 回報)
      assert.deepEqual(result.hits, [{ id: 'hit-1', snippet: '排程規則 A' }]);

      assert.equal(captured[0]?.method, 'POST');
      assert.equal(captured[0]?.path, '/v1/recall');
      const payload = JSON.parse(captured[0]?.body ?? '{}');
      assert.equal(payload.mode, 'hybrid');
      assert.equal(payload.scope, 'user:1');
      assert.equal(payload.project, 'TeleNexus');
    }
  );
});

test('recallWithMeta 相容舊版頂層 hits[] 回應', async () => {
  await withServer(
    (_req, res) =>
      jsonResponse(res, 200, {
        hits: [{ id: 'legacy-1', snippet: 'legacy snippet' }]
      }),
    async (endpoint) => {
      const client = new MemoriaRecallClient({ endpoint, timeoutMs: 2000 });
      const result = await client.recallWithMeta('query');

      assert.equal(result.recallId, undefined);
      assert.deepEqual(result.snippets, ['legacy snippet']);
      assert.deepEqual(result.hits, [{ id: 'legacy-1', snippet: 'legacy snippet' }]);
    }
  );
});

test('recallWithMeta 連線失敗時回空結果不 throw', async () => {
  const client = new MemoriaRecallClient({ endpoint: 'http://127.0.0.1:1', timeoutMs: 500 });
  const result = await client.recallWithMeta('query');
  assert.deepEqual(result, { snippets: [], hits: [] });
});

test('recall 維持舊介面,回傳 snippets 陣列', async () => {
  await withServer(
    (_req, res) =>
      jsonResponse(res, 200, {
        ok: true,
        data: [{ id: 'h1', snippet: 'snippet-1' }],
        meta: { recall_id: 'rt_1' }
      }),
    async (endpoint) => {
      const client = new MemoriaRecallClient({ endpoint, timeoutMs: 2000 });
      assert.deepEqual(await client.recall('query'), ['snippet-1']);
    }
  );
});

test('reportRecallOutcome POST 到 /v1/recall/:id/outcome 並回傳 true', async () => {
  await withServer(
    (_req, res) => jsonResponse(res, 200, { ok: true, data: { updated: true } }),
    async (endpoint, captured) => {
      const outcome = {
        signal: 'reuse',
        utility_score: 0.5,
        hits: [{ id: 'h1', utility_score: 0.5 }]
      };
      const ok = await reportRecallOutcome('rt_abc123', outcome, { endpoint, timeoutMs: 2000 });

      assert.equal(ok, true);
      assert.equal(captured[0]?.method, 'POST');
      assert.equal(captured[0]?.path, '/v1/recall/rt_abc123/outcome');
      assert.deepEqual(JSON.parse(captured[0]?.body ?? '{}'), outcome);
    }
  );
});

test('reportRecallOutcome 收到非 2xx 時回傳 false', async () => {
  await withServer(
    (_req, res) => jsonResponse(res, 400, { ok: false, error: 'bad payload' }),
    async (endpoint) => {
      const ok = await reportRecallOutcome(
        'rt_abc123',
        { signal: 'reuse' },
        { endpoint, timeoutMs: 2000 }
      );
      assert.equal(ok, false);
    }
  );
});

test('tokenCoverage 與 Memoria SDK 語意一致(CJK 連續字串為單一 token)', () => {
  assert.equal(tokenCoverage('deploy telenexus', 'we deploy telenexus now'), 1);
  assert.equal(tokenCoverage('deploy telenexus', 'we deploy something else'), 0.5);
  assert.equal(tokenCoverage('排程規則', '已依排程規則更新完成'), 1);
  assert.equal(tokenCoverage('排程規則', '完全無關的內容'), 0);
  // 長度 < 2 的 token 會被過濾,無有效 token 時回 0
  assert.equal(tokenCoverage('a b', 'a b c'), 0);
});

test('buildReuseOutcome 產生 per-hit 覆蓋率並以最大值為 utility_score', () => {
  const outcome = buildReuseOutcome(
    [
      { id: 'h1', snippet: 'alpha beta' },
      { id: 'h2', snippet: 'gamma' }
    ],
    'alpha beta appears here'
  );

  assert.equal(outcome.signal, 'reuse');
  assert.equal(outcome.utility_score, 1);
  assert.deepEqual(outcome.hits, [
    { id: 'h1', utility_score: 1 },
    { id: 'h2', utility_score: 0 }
  ]);
});

test('buildReuseOutcome 空 hits 時 utility_score 為 0', () => {
  const outcome = buildReuseOutcome([], 'any reply');
  assert.equal(outcome.utility_score, 0);
  assert.deepEqual(outcome.hits, []);
});
