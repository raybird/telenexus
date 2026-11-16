import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DynamicAIAgent } from '../src/core/agent.js';
import type { AgentStructuredResult, ReplyParts } from '../src/core/agent-result.js';

/**
 * Issue 0028 SCN-008:聊天由 runner 或本機執行、走串流或非串流,過程與結論都一樣傳到呼叫端,
 * `[Opencode]` 前綴加在全文與結論前面,過程不加。
 */
const STRUCTURED: AgentStructuredResult = {
  provider: 'opencode',
  text: '先查資料。答案是 42。',
  replyParts: { process: ['先查資料。'], conclusion: '答案是 42。' }
};
const EXPECTED_PARTS: ReplyParts = {
  process: ['先查資料。'],
  conclusion: '[Opencode] 答案是 42。'
};

function writeConfig(): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-reply-parts-agent-'));
  const configPath = path.join(dir, 'ai-config.yaml');
  fs.writeFileSync(configPath, 'provider: opencode\n', 'utf8');
  return { dir, configPath };
}

async function withRunner(run: (endpoint: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const result = {
      ok: true,
      provider: 'opencode',
      output: STRUCTURED.text,
      structured: STRUCTURED
    };
    if (req.method === 'POST' && req.url === '/run/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`event: done\ndata: ${JSON.stringify({ text: STRUCTURED.text })}\n\n`);
      res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/run') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('SCN-008：runner 串流與非串流都帶回過程與結論，前綴加在結論前', async () => {
  const { dir, configPath } = writeConfig();
  try {
    await withRunner(async (endpoint) => {
      const agent = new DynamicAIAgent(configPath, {
        preferRunner: true,
        fallbackToLocal: false,
        runnerEndpoint: endpoint,
        runnerTimeoutMs: 5000
      });
      const streamed = await agent.streamChat('問題', undefined, () => undefined);
      const nonStreamed = await agent.chatStructured('問題');
      for (const result of [streamed, nonStreamed]) {
        assert.equal(result.text, '[Opencode] 先查資料。答案是 42。');
        assert.deepEqual(result.replyParts, EXPECTED_PARTS);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCN-008：本機串流與非串流都帶回過程與結論，前綴加在結論前', async () => {
  const { dir, configPath } = writeConfig();
  try {
    const agent = new DynamicAIAgent(configPath, { preferRunner: false, fallbackToLocal: true });
    const opencodeAgent = (
      agent as unknown as {
        opencodeAgent: { streamChat: unknown; chatStructured: unknown };
      }
    ).opencodeAgent;
    opencodeAgent.streamChat = async () => structuredClone(STRUCTURED);
    opencodeAgent.chatStructured = async () => structuredClone(STRUCTURED);

    const streamed = await agent.streamChat('問題', undefined, () => undefined);
    const nonStreamed = await agent.chatStructured('問題');
    for (const result of [streamed, nonStreamed]) {
      assert.equal(result.text, '[Opencode] 先查資料。答案是 42。');
      assert.deepEqual(result.replyParts, EXPECTED_PARTS);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('沒有 replyParts 的結果維持只有全文', async () => {
  const { dir, configPath } = writeConfig();
  try {
    const agent = new DynamicAIAgent(configPath, { preferRunner: false, fallbackToLocal: true });
    const opencodeAgent = (agent as unknown as { opencodeAgent: { chatStructured: unknown } })
      .opencodeAgent;
    opencodeAgent.chatStructured = async () => ({ provider: 'opencode', text: 'OK' });
    const result = await agent.chatStructured('問題');
    assert.equal(result.text, '[Opencode] OK');
    assert.equal(result.replyParts, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
