import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoriaRecallClient } from '../src/core/memoria-recall.js';

test('vector recall preserves scope and accepts a paraphrase without lexical overlap', async () => {
  const savedMode = process.env.MEMORIA_RECALL_MODE;
  const savedProject = process.env.APP_PROJECT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-recall-'));
  process.env.APP_PROJECT_DIR = dir;
  const payloads: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      payloads.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [{ id: 'semantic-memory', snippet: '使用者偏好繁體中文回覆。' }],
          meta: {
            recall_id: 'semantic-recall',
            route_mode: 'vector',
            confidence: null,
            confidence_basis: 'unavailable',
            fallback_used: false
          }
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    process.env.MEMORIA_RECALL_MODE = 'vector';
    const result = await new MemoriaRecallClient({ endpoint }).recallWithMeta(
      'Which language should you answer in?',
      'user:semantic-check'
    );
    assert.equal(payloads[0]?.mode, 'vector');
    assert.equal(payloads[0]?.scope, 'user:semantic-check');
    assert.deepEqual(result.snippets, ['使用者偏好繁體中文回覆。']);
    assert.equal(result.recallId, 'semantic-recall');

    process.env.MEMORIA_RECALL_MODE = 'invalid';
    await new MemoriaRecallClient({ endpoint }).recall('test');
    assert.equal(payloads[1]?.mode, 'hybrid');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (savedMode === undefined) delete process.env.MEMORIA_RECALL_MODE;
    else process.env.MEMORIA_RECALL_MODE = savedMode;
    if (savedProject === undefined) delete process.env.APP_PROJECT_DIR;
    else process.env.APP_PROJECT_DIR = savedProject;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未設定 timeout 時依召回模式決定，空字串視同未設定', () => {
  const saved = {
    mode: process.env.MEMORIA_RECALL_MODE,
    timeout: process.env.MEMORIA_RECALL_TIMEOUT_MS
  };
  const timeoutOf = () =>
    (
      new MemoriaRecallClient({ endpoint: 'http://127.0.0.1:1' }) as unknown as {
        timeoutMs: number;
      }
    ).timeoutMs;
  try {
    process.env.MEMORIA_RECALL_TIMEOUT_MS = '';
    process.env.MEMORIA_RECALL_MODE = 'hybrid';
    assert.equal(timeoutOf(), 1500);
    process.env.MEMORIA_RECALL_MODE = 'vector';
    assert.equal(timeoutOf(), 20000);
    process.env.MEMORIA_RECALL_TIMEOUT_MS = '2500';
    assert.equal(timeoutOf(), 2500);
  } finally {
    if (saved.mode === undefined) delete process.env.MEMORIA_RECALL_MODE;
    else process.env.MEMORIA_RECALL_MODE = saved.mode;
    if (saved.timeout === undefined) delete process.env.MEMORIA_RECALL_TIMEOUT_MS;
    else process.env.MEMORIA_RECALL_TIMEOUT_MS = saved.timeout;
  }
});

test('Compose 與範例設定不替 hybrid 寫死向量用的逾時', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.release.yml']) {
    const compose = fs.readFileSync(file, 'utf8');
    assert.match(compose, /MEMORIA_RECALL_TIMEOUT_MS: \$\{MEMORIA_RECALL_TIMEOUT_MS:-\}/, file);
  }
  assert.doesNotMatch(fs.readFileSync('.env.example', 'utf8'), /^MEMORIA_RECALL_TIMEOUT_MS=/m);
});
