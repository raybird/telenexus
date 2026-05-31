import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoriaSyncBridge } from '../src/core/memoria-sync.js';

function withTempProject<T>(fn: (projectDir: string) => T | Promise<T>): T | Promise<T> {
  const prevProjectDir = process.env.APP_PROJECT_DIR;
  const prevEndpoint = process.env.MEMORIA_ENDPOINT;
  const prevMode = process.env.MEMORIA_SYNC_ENABLED;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-memoria-status-'));

  const finalize = () => {
    if (prevProjectDir === undefined) delete process.env.APP_PROJECT_DIR;
    else process.env.APP_PROJECT_DIR = prevProjectDir;
    if (prevEndpoint === undefined) delete process.env.MEMORIA_ENDPOINT;
    else process.env.MEMORIA_ENDPOINT = prevEndpoint;
    if (prevMode === undefined) delete process.env.MEMORIA_SYNC_ENABLED;
    else process.env.MEMORIA_SYNC_ENABLED = prevMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    process.env.APP_PROJECT_DIR = tempDir;
    const result = fn(tempDir);
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).finally(finalize);
    }
    finalize();
    return result;
  } finally {
    // async path finalizes via Promise.finally; sync path finalized above.
  }
}

test('MemoriaSyncBridge is available (not disabled) in auto mode with an endpoint', () => {
  withTempProject(() => {
    process.env.MEMORIA_SYNC_ENABLED = 'auto';
    process.env.MEMORIA_ENDPOINT = 'http://127.0.0.1:59999';
    const bridge = new MemoriaSyncBridge();
    const status = bridge.getStatus();

    assert.equal(status.mode, 'auto');
    assert.equal(status.available, true);
    assert.equal(status.disabled, false);
    // 初始尚未 ping 成功;欄位存在且為布林。
    assert.equal(typeof status.endpointReachable, 'boolean');
    assert.equal(status.recentFailureCount, 0);
    assert.equal(status.lastSyncAt, null);
  });
});

test('MemoriaSyncBridge is disabled when mode=off', () => {
  withTempProject(() => {
    process.env.MEMORIA_SYNC_ENABLED = 'off';
    const bridge = new MemoriaSyncBridge();
    const status = bridge.getStatus();
    assert.equal(status.mode, 'off');
    assert.equal(status.available, false);
    assert.equal(status.disabled, true);
  });
});

test('MemoriaSyncBridge POSTs to /v1/remember and notifies status change after success', async () => {
  await withTempProject(async (projectDir) => {
    fs.mkdirSync(path.join(projectDir, 'workspace', 'temp', 'memoria-sync'), { recursive: true });

    let rememberCalls = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/remember') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          rememberCalls += 1;
          const parsed = JSON.parse(body);
          assert.ok(Array.isArray(parsed.events) && parsed.events.length === 2);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true,"sessionId":"test"}');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    process.env.MEMORIA_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.MEMORIA_SYNC_ENABLED = 'on';

    let callbackCount = 0;
    let latestAvailable = false;
    const bridge = new MemoriaSyncBridge({
      projectDir,
      mode: 'on',
      onStatusChange(status) {
        callbackCount += 1;
        latestAvailable = status.available;
      }
    });

    bridge.enqueueTurn({
      userId: 'user-a',
      userMessage: '記住這條規則',
      modelMessage: '好的，我會保留這條規則。',
      platform: 'console',
      isPassthroughCommand: false,
      forceNewSession: false
    });
    await bridge.whenIdle();

    const status = bridge.getStatus();
    assert.equal(rememberCalls, 1);
    assert.ok(callbackCount >= 1);
    assert.equal(latestAvailable, true);
    assert.equal(status.endpointReachable, true);
    assert.ok(typeof status.lastSyncAt === 'number');
    assert.equal(status.recentFailureCount, 0);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
