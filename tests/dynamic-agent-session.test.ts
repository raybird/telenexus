import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DynamicAIAgent } from '../src/core/agent.js';
import type { AgentStructuredResult } from '../src/core/agent-result.js';

/**
 * Issue 0012:聊天綁定的 session 要經 DynamicAIAgent 傳到 runner,
 * runner 回傳的 sessionId 與 session-missing 失敗也要傳回 pipeline,
 * pipeline 才能更新綁定、在 session 不存在時改開新 session。
 */

type Received = { url: string; body: Record<string, unknown> };

async function withRunner(
  structured: AgentStructuredResult,
  fn: (agent: DynamicAIAgent, received: Received[]) => Promise<void>
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-agent-session-'));
  const configPath = path.join(tempDir, 'ai-config.yaml');
  fs.writeFileSync(configPath, 'provider: opencode\n', 'utf8');
  const received: Received[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
      const payload = { ok: true, provider: 'opencode', output: structured.text, structured };
      if (req.url === '/run/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const agent = new DynamicAIAgent(configPath, {
      preferRunner: true,
      fallbackToLocal: false,
      runnerEndpoint: `http://127.0.0.1:${address.port}`,
      runnerTimeoutMs: 5000
    });
    await fn(agent, received);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const OK_RESULT: AgentStructuredResult = {
  provider: 'opencode',
  text: 'OK',
  sessionId: 'ses_from_runner'
};
const MISSING_RESULT: AgentStructuredResult = {
  provider: 'opencode',
  text: 'Opencode 找不到要接續的 session。',
  failure: { kind: 'session-missing', message: 'Session not found' }
};

test('SCN-001 [stream]: 綁定的 sessionId 送到 runner,回傳的 sessionId 保留', async () => {
  await withRunner(OK_RESULT, async (agent, received) => {
    const result = await agent.streamChat('hi', { sessionId: 'ses_bound' }, () => {});
    assert.equal(received[0]?.url, '/run/stream');
    assert.equal(received[0]?.body.sessionId, 'ses_bound');
    assert.equal(result.sessionId, 'ses_from_runner');
    assert.equal(result.text, '[Opencode] OK');
  });
});

test('SCN-003 [stream]: runner 回傳的 session-missing 失敗保留給呼叫端', async () => {
  await withRunner(MISSING_RESULT, async (agent) => {
    const result = await agent.streamChat('hi', { sessionId: 'ses_gone' }, () => {});
    assert.equal(result.failure?.kind, 'session-missing');
  });
});

test('SCN-001 [non-stream]: chatStructured 送出 sessionId 並回傳 runner 的 sessionId', async () => {
  await withRunner(OK_RESULT, async (agent, received) => {
    const result = await agent.chatStructured('hi', { sessionId: 'ses_bound' });
    assert.equal(received[0]?.url, '/run');
    assert.equal(received[0]?.body.sessionId, 'ses_bound');
    assert.equal(result.sessionId, 'ses_from_runner');
    assert.equal(result.text, '[Opencode] OK');
  });
});

test('SCN-003 [non-stream]: chatStructured 保留 session-missing 失敗', async () => {
  await withRunner(MISSING_RESULT, async (agent) => {
    const result = await agent.chatStructured('/compact', {
      isPassthroughCommand: true,
      sessionId: 'ses_gone'
    });
    assert.equal(result.failure?.kind, 'session-missing');
  });
});

test('chat() 仍回傳帶前綴的字串,沒有 sessionId 時不送出該欄位', async () => {
  await withRunner(OK_RESULT, async (agent, received) => {
    assert.equal(await agent.chat('hi'), '[Opencode] OK');
    assert.equal('sessionId' in (received[0]?.body ?? {}), false);
  });
});
