import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DynamicAIAgent } from '../src/core/agent.js';
import type { AgentEvent } from '../src/core/agent-result.js';

function writeSseEvent(
  res: http.ServerResponse,
  event: string,
  payload: Record<string, unknown>
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

test('DynamicAIAgent streamChat consumes runner SSE stream', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-runner-stream-test-'));
  const configPath = path.join(tempDir, 'ai-config.yaml');
  fs.writeFileSync(configPath, 'provider: gemini\n', 'utf8');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/run/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      writeSseEvent(res, 'start', { provider: 'gemini' });
      writeSseEvent(res, 'delta', { text: 'Hello' });
      writeSseEvent(res, 'delta', { text: ' runner' });
      writeSseEvent(res, 'usage', { stats: { total_tokens: 9 } });
      writeSseEvent(res, 'done', { text: 'Hello runner' });
      writeSseEvent(res, 'result', {
        ok: true,
        provider: 'gemini',
        output: 'Hello runner',
        structured: {
          provider: 'gemini',
          text: 'Hello runner',
          stats: { total_tokens: 9 }
        }
      });
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    const agent = new DynamicAIAgent(configPath, {
      preferRunner: true,
      fallbackToLocal: false,
      runnerEndpoint: endpoint,
      runnerTimeoutMs: 5000
    });

    const events: AgentEvent[] = [];
    const result = await agent.streamChat('test', undefined, async (event) => {
      events.push(event);
    });

    assert.equal(result.text, 'Hello runner');
    assert.deepEqual(events, [
      { type: 'start', provider: 'gemini' },
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ' runner' },
      { type: 'usage', stats: { total_tokens: 9 } },
      { type: 'done', text: 'Hello runner' }
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
