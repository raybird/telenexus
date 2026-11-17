// issue 0030 Task 1.2（SCN-002 外迴圈）：面板專用伺服器的公開面與授權邊界，以真實 HTTP 驗證。
// initData 字面值與 tests/web/panel-auth.test.ts 相同，由 Python hmac 另外算出。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PanelSessions } from '../../src/web/panel-auth.js';
import { startPanelServer, type PanelServerHandle } from '../../src/web/panel-server.js';

const BOT_TOKEN = '123456:TEST-token-for-unit-tests';
const ALLOWED = '424242';
const AUTH_DATE = 1763337600;
const USER_Q =
  'user=%7B%22id%22%3A424242%2C%22first_name%22%3A%22Test%22%2C%22username%22%3A%22tester%22%7D';
const VALID = `auth_date=${AUTH_DATE}&query_id=AAHtest&${USER_Q}&hash=902cb11e533a2f911a40ea3cb24425db197701682f9d0666dac6f591ba7622f4`;
const OTHER_USER = `auth_date=${AUTH_DATE}&query_id=AAHtest&user=%7B%22id%22%3A999%2C%22first_name%22%3A%22Other%22%7D&signature=c2lnbmF0dXJlLXBsYWNlaG9sZGVy&hash=0c61413f8159852795aa71511b47247f3694e719e37cf543b58857494670e5d4`;

type Ctx = { base: string; sessions: PanelSessions; server: PanelServerHandle; nowSec: number };

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const sessions = new PanelSessions();
  const ctx = { nowSec: AUTH_DATE + 30 } as Ctx;
  const server = await startPanelServer({
    host: '127.0.0.1',
    port: 0,
    botToken: BOT_TOKEN,
    allowedUserId: ALLOWED,
    sessions,
    now: () => ctx.nowSec * 1000
  });
  Object.assign(ctx, { base: `http://127.0.0.1:${server.port}`, sessions, server });
  try {
    await fn(ctx);
  } finally {
    await server.close();
  }
}

async function login(base: string, initData: string): Promise<Response> {
  return fetch(`${base}/panel-api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData })
  });
}

async function tokenFor(base: string): Promise<string> {
  const res = await login(base, VALID);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; token: string };
  assert.equal(body.ok, true);
  return body.token;
}

test('SCN-002：有效 initData 登入取得憑證，憑證可存取面板 API', async () => {
  await withServer(async ({ base }) => {
    const token = await tokenFor(base);
    const res = await fetch(`${base}/panel-api/session`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, userId: '424242' });
  });
});

test('SCN-002：偽造、非白名單、過期、空白的 initData 登入失敗且不發憑證', async () => {
  await withServer(async (ctx) => {
    const forged = VALID.replace('424242', '424243');
    for (const initData of [forged, OTHER_USER, '', 'hash=00']) {
      const res = await login(ctx.base, initData);
      assert.equal(res.status, 401, initData);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.ok, false);
      assert.equal(body.token, undefined);
    }
    ctx.nowSec = AUTH_DATE + 601;
    assert.equal((await login(ctx.base, VALID)).status, 401);
  });
});

test('SCN-002：登入請求不是 JSON 或太大時拒絕', async () => {
  await withServer(async ({ base }) => {
    const notJson = await fetch(`${base}/panel-api/login`, { method: 'POST', body: 'initData=x' });
    assert.equal(notJson.status, 400);
    const huge = await login(base, 'a'.repeat(64 * 1024));
    assert.ok(huge.status === 413 || huge.status === 400, `status ${huge.status}`);
    const wrongMethod = await fetch(`${base}/panel-api/login`);
    assert.equal(wrongMethod.status, 405);
  });
});

test('SCN-002：沒帶憑證、偽造憑證、放在網址的憑證都被拒絕', async () => {
  await withServer(async ({ base }) => {
    const token = await tokenFor(base);
    const cases: Array<[string, Record<string, string>]> = [
      [`${base}/panel-api/session`, {}],
      [`${base}/panel-api/session`, { authorization: 'Bearer forged-token' }],
      [`${base}/panel-api/session`, { authorization: token }],
      [`${base}/panel-api/session?token=${token}`, {}]
    ];
    for (const [url, headers] of cases) {
      const res = await fetch(url, { headers });
      assert.equal(res.status, 401, `${url} ${JSON.stringify(headers)}`);
    }
  });
});

test('SCN-002：本機、內網來源或 Host 不能取代憑證', async () => {
  await withServer(async ({ base }) => {
    const spoofed = [
      { 'x-forwarded-for': '127.0.0.1' },
      { 'x-forwarded-for': '10.0.0.5', 'x-real-ip': '192.168.1.2' },
      { host: 'localhost' },
      { host: '172.18.0.3:3040' }
    ];
    for (const headers of spoofed) {
      const res = await fetch(`${base}/panel-api/session`, { headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
  });
});

test('SCN-002：入口關閉或換網址（revokeAll）後舊憑證失效，重新登入才可用', async () => {
  await withServer(async ({ base, sessions }) => {
    const old = await tokenFor(base);
    sessions.revokeAll();
    const res = await fetch(`${base}/panel-api/session`, {
      headers: { authorization: `Bearer ${old}` }
    });
    assert.equal(res.status, 401);
    const fresh = await tokenFor(base);
    const ok = await fetch(`${base}/panel-api/session`, {
      headers: { authorization: `Bearer ${fresh}` }
    });
    assert.equal(ok.status, 200);
  });
});

test('SCN-002：既有 Web Console 的頁面與 API 不在面板連接埠上，不論 WEB_AUTH_TOKEN 與 WEB_TRUST_PRIVATE_NETWORK', async () => {
  const saved = {
    token: process.env.WEB_AUTH_TOKEN,
    trust: process.env.WEB_TRUST_PRIVATE_NETWORK
  };
  const legacy: Array<[string, string]> = [
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/app/main.js'],
    ['POST', '/api/chat'],
    ['GET', '/api/chat/stream'],
    ['GET', '/api/memory/export'],
    ['GET', '/api/memory/search?q=x'],
    ['GET', '/api/schedules'],
    ['POST', '/api/schedules/toggle'],
    ['GET', '/api/status'],
    ['GET', '/api/health'],
    ['GET', '/api/debug/version']
  ];
  try {
    for (const env of [
      { token: '', trust: 'true' },
      { token: 'some-token', trust: 'false' }
    ]) {
      process.env.WEB_AUTH_TOKEN = env.token;
      process.env.WEB_TRUST_PRIVATE_NETWORK = env.trust;
      await withServer(async ({ base }) => {
        const token = await tokenFor(base);
        for (const [method, p] of legacy) {
          for (const headers of [
            { 'x-forwarded-for': '127.0.0.1' },
            { authorization: `Bearer ${token}` }
          ]) {
            const res = await fetch(`${base}${p}`, {
              method,
              headers,
              ...(method === 'POST' ? { body: '{}' } : {})
            });
            assert.equal(res.status, 404, `${method} ${p} ${JSON.stringify(env)}`);
          }
        }
      });
    }
  } finally {
    if (saved.token === undefined) delete process.env.WEB_AUTH_TOKEN;
    else process.env.WEB_AUTH_TOKEN = saved.token;
    if (saved.trust === undefined) delete process.env.WEB_TRUST_PRIVATE_NETWORK;
    else process.env.WEB_TRUST_PRIVATE_NETWORK = saved.trust;
  }
});

test('SCN-002：未登入時不能探測面板 API 有哪些路徑，被拒的請求不改動模型設定', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-server-'));
  const overridePath = path.join(dir, 'data', 'ai-config.override.yaml');
  fs.mkdirSync(path.dirname(overridePath));
  fs.writeFileSync(overridePath, 'model: mock/original\n');
  const savedDir = process.env.APP_PROJECT_DIR;
  process.env.APP_PROJECT_DIR = dir;
  try {
    await withServer(async ({ base }) => {
      for (const p of [
        '/panel-api/model',
        '/panel-api/apply',
        '/panel-api/reset',
        '/panel-api/nope'
      ]) {
        const res = await fetch(`${base}${p}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
          body: JSON.stringify({ model: 'mock/evil' })
        });
        assert.equal(res.status, 401, p);
      }
    });
    assert.equal(fs.readFileSync(overridePath, 'utf8'), 'model: mock/original\n');
  } finally {
    if (savedDir === undefined) delete process.env.APP_PROJECT_DIR;
    else process.env.APP_PROJECT_DIR = savedDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
