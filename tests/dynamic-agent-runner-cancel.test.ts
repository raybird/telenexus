import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DynamicAIAgent } from '../src/core/agent.js';

for (const mode of ['chat', 'stream'] as const) {
  test(`SCN-003 ${mode} 已取消的工作不送 runner 請求`, async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const controller = new AbortController();
    controller.abort();
    const agent = new DynamicAIAgent('fixture-missing.yaml', {
      runnerEndpoint: `http://127.0.0.1:${address.port}`,
      preferRunner: true,
      fallbackToLocal: false
    });
    try {
      const result =
        mode === 'chat'
          ? await agent.chat('fixture', { signal: controller.signal })
          : (await agent.streamChat('fixture', { signal: controller.signal }, () => {})).text;
      assert.equal(requests, 0);
      assert.match(result, /取消|中止/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test(`SCN-003 ${mode} 取消 runner HTTP 請求，且不轉回 local`, async () => {
    const controller = new AbortController();
    let disconnected = false;
    let localCalls = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.on('close', () => {
          if (!res.writableEnded) disconnected = true;
        });
        controller.abort();
        // 2026-10-04：保險絲讓未修復版本也會結束，不以逾時本身充當目標紅燈。
        setTimeout(() => {
          if (mode === 'stream') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('event: result\ndata: {"ok":false,"error":"fixture"}\n\n');
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end('{"ok":false,"error":"fixture"}');
          }
        }, 200);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const agent = new DynamicAIAgent('fixture-missing.yaml', {
      runnerEndpoint: `http://127.0.0.1:${address.port}`,
      preferRunner: true,
      fallbackToLocal: true,
      runnerTimeoutMs: 3000
    });
    const internals = agent as unknown as {
      executeLocal: () => Promise<string>;
      opencodeAgent: { streamChat: () => Promise<{ provider: 'opencode'; text: string }> };
    };
    internals.executeLocal = async () => {
      localCalls++;
      return 'UNEXPECTED_LOCAL';
    };
    internals.opencodeAgent.streamChat = async () => {
      localCalls++;
      return { provider: 'opencode', text: 'UNEXPECTED_LOCAL' };
    };
    try {
      const result =
        mode === 'chat'
          ? await agent.chat('fixture', { signal: controller.signal })
          : (await agent.streamChat('fixture', { signal: controller.signal }, () => {})).text;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(disconnected, true, 'AbortSignal 必須真的中斷 HTTP 傳輸');
      assert.equal(localCalls, 0, '取消後不得啟動本地 fallback 工作');
      assert.match(result, /取消|中止/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
