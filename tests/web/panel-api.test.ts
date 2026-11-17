// issue 0030 Task 4.1（SCN-003 責任，SCN-004／SCN-006 支援）：面板 API 與靜態頁，以真實 HTTP 驗證。
// 有效模型的期望值是手寫字面值；cwd 與 APP_PROJECT_DIR 指向同一個暫存專案，與實際呼叫讀同一組檔。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAiConfig } from '../../src/core/config-loader.js';
import type { ModelListResult } from '../../src/core/model-config.js';
import { PanelSessions } from '../../src/web/panel-auth.js';
import { startPanelServer } from '../../src/web/panel-server.js';

const BOT_TOKEN = '123456:TEST-token-for-unit-tests';
const AUTH_DATE = 1763337600;
const USER_Q =
  'user=%7B%22id%22%3A424242%2C%22first_name%22%3A%22Test%22%2C%22username%22%3A%22tester%22%7D';
const VALID = `auth_date=${AUTH_DATE}&query_id=AAHtest&${USER_Q}&hash=902cb11e533a2f911a40ea3cb24425db197701682f9d0666dac6f591ba7622f4`;

const LISTED: ModelListResult = {
  ok: true,
  models: [
    { id: 'mock/a', provider: 'mock' },
    { id: 'mock/b', provider: 'mock' },
    { id: 'other/c', provider: 'other' }
  ]
};

type Ctx = {
  base: string;
  overridePath: string;
  writes: { begun: number; released: number };
  api(method: string, p: string, body?: unknown, auth?: boolean): Promise<Response>;
};

async function withPanel(
  opts: { list?: () => Promise<ModelListResult>; override?: string },
  fn: (ctx: Ctx) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-api-'));
  fs.writeFileSync(path.join(dir, 'ai-config.yaml'), 'model: mock/a\n');
  fs.mkdirSync(path.join(dir, 'data'));
  const overridePath = path.join(dir, 'data', 'ai-config.override.yaml');
  if (opts.override !== undefined) fs.writeFileSync(overridePath, opts.override);
  const savedCwd = process.cwd();
  const savedDir = process.env.APP_PROJECT_DIR;
  process.chdir(dir);
  process.env.APP_PROJECT_DIR = dir;
  const writes = { begun: 0, released: 0 };
  const server = await startPanelServer({
    host: '127.0.0.1',
    port: 0,
    botToken: BOT_TOKEN,
    allowedUserId: '424242',
    sessions: new PanelSessions(),
    now: () => (AUTH_DATE + 30) * 1000,
    listModels: opts.list ?? (async () => LISTED),
    beginWrite: () => {
      writes.begun += 1;
      return () => {
        writes.released += 1;
      };
    }
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const login = await fetch(`${base}/panel-api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: VALID })
    });
    const { token } = (await login.json()) as { token: string };
    await fn({
      base,
      overridePath,
      writes,
      api: (method, p, body, auth = true) =>
        fetch(`${base}${p}`, {
          method,
          headers: {
            'content-type': 'application/json',
            ...(auth ? { authorization: `Bearer ${token}` } : {})
          },
          ...(body === undefined
            ? {}
            : { body: typeof body === 'string' ? body : JSON.stringify(body) })
        })
    });
  } finally {
    await server.close();
    process.chdir(savedCwd);
    if (savedDir === undefined) delete process.env.APP_PROJECT_DIR;
    else process.env.APP_PROJECT_DIR = savedDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('SCN-003／SCN-006：目前設定顯示有效模型與來源，和實際呼叫相同', async () => {
  await withPanel({ override: 'model: mock/b\n' }, async ({ api }) => {
    const res = await api('GET', '/panel-api/state');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      model: { model: 'mock/b', source: 'override', baseModel: 'mock/a', overrideModel: 'mock/b' }
    });
    assert.equal(loadAiConfig().model, 'mock/b');
  });
});

test('SCN-003：模型清單附完整 ID 與 provider，provider 依出現順序去重', async () => {
  await withPanel({}, async ({ api }) => {
    const res = await api('GET', '/panel-api/models');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      models: [
        { id: 'mock/a', provider: 'mock' },
        { id: 'mock/b', provider: 'mock' },
        { id: 'other/c', provider: 'other' }
      ],
      providers: ['mock', 'other']
    });
  });
});

test('SCN-003：清單命令失敗回 502 並附原因；空清單回 200 與空陣列', async () => {
  await withPanel(
    { list: async () => ({ ok: false, error: 'spawn opencode ENOENT' }) },
    async ({ api }) => {
      const res = await api('GET', '/panel-api/models');
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), {
        ok: false,
        error: 'list-failed',
        message: 'spawn opencode ENOENT'
      });
    }
  );
  await withPanel({ list: async () => ({ ok: true, models: [] }) }, async ({ api }) => {
    const res = await api('GET', '/panel-api/models');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, models: [], providers: [] });
  });
});

test('SCN-004：套用清單內的模型後，新呼叫讀到它，回傳原本的 override 與新狀態', async () => {
  await withPanel({ override: 'model: mock/b\n' }, async ({ api, writes }) => {
    const res = await api('POST', '/panel-api/apply', { model: 'other/c' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      previous: 'mock/b',
      model: { model: 'other/c', source: 'override', baseModel: 'mock/a', overrideModel: 'other/c' }
    });
    assert.equal(loadAiConfig().model, 'other/c');
    assert.deepEqual(writes, { begun: 1, released: 1 });
  });
});

test('SCN-004：不在清單內、格式不合、清單取不到或 body 壞掉時拒絕，設定不變', async () => {
  const cases: Array<{
    body: unknown;
    list?: () => Promise<ModelListResult>;
    status: number;
    error: string;
  }> = [
    { body: { model: 'mock/zzz' }, status: 400, error: 'not-listed' },
    { body: { model: 'mock/a b' }, status: 400, error: 'invalid-model' },
    { body: { model: 42 }, status: 400, error: 'invalid-model' },
    { body: {}, status: 400, error: 'invalid-model' },
    { body: 'not json', status: 400, error: 'invalid-json' },
    {
      body: { model: 'mock/a' },
      list: async () => ({ ok: false, error: 'timeout' }),
      status: 502,
      error: 'list-failed'
    }
  ];
  for (const c of cases) {
    await withPanel(
      { override: 'model: mock/b\n', ...(c.list ? { list: c.list } : {}) },
      async ({ api, overridePath, writes }) => {
        const res = await api('POST', '/panel-api/apply', c.body);
        assert.equal(res.status, c.status, JSON.stringify(c.body));
        const body = (await res.json()) as { ok: boolean; error: string };
        assert.equal(body.ok, false);
        assert.equal(body.error, c.error);
        assert.equal(fs.readFileSync(overridePath, 'utf8'), 'model: mock/b\n');
        assert.equal(writes.begun, writes.released);
      }
    );
  }
});

test('SCN-004：恢復預設清除 override，新呼叫回到 base；沒有 override 時回 changed:false', async () => {
  await withPanel({ override: 'model: mock/b\n' }, async ({ api, overridePath }) => {
    const res = await api('POST', '/panel-api/reset');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      changed: true,
      previous: 'mock/b',
      model: { model: 'mock/a', source: 'base', baseModel: 'mock/a' }
    });
    assert.equal(fs.existsSync(overridePath), false);
    assert.equal(loadAiConfig().model, 'mock/a');
    const again = await api('POST', '/panel-api/reset');
    assert.deepEqual(await again.json(), {
      ok: true,
      changed: false,
      model: { model: 'mock/a', source: 'base', baseModel: 'mock/a' }
    });
  });
});

test('SCN-002：未登入的套用與恢復預設被拒，設定不變', async () => {
  await withPanel({ override: 'model: mock/b\n' }, async ({ api, overridePath }) => {
    for (const [method, p, body] of [
      ['POST', '/panel-api/apply', { model: 'mock/a' }],
      ['POST', '/panel-api/reset', undefined],
      ['GET', '/panel-api/state', undefined],
      ['GET', '/panel-api/models', undefined]
    ] as const) {
      const res = await api(method, p, body, false);
      assert.equal(res.status, 401, p);
    }
    assert.equal(fs.readFileSync(overridePath, 'utf8'), 'model: mock/b\n');
  });
});

test('SCN-003：方法不對的 API 回 405；不存在的 API（含物件原型上的名稱）回 404', async () => {
  await withPanel({}, async ({ api }) => {
    assert.equal((await api('GET', '/panel-api/apply')).status, 405);
    assert.equal((await api('POST', '/panel-api/state', {})).status, 405);
    for (const name of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal((await api('GET', `/panel-api/${name}`)).status, 404, name);
    }
  });
});

test('SCN-002：只供測試的 session 路由已移除，登入後也是 404', async () => {
  // review-87b6cf6 N7
  await withPanel({}, async ({ api }) => {
    assert.equal((await api('GET', '/panel-api/session')).status, 404);
  });
});

test('SCN-002：靜態檔只服務白名單檔名：隱藏檔、子目錄、大寫、其他副檔名都是 404', async () => {
  // review-87b6cf6 N4：這些路徑不會被 URL 正規化擋掉，只能靠檔名白名單
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-static-'));
  fs.writeFileSync(path.join(dir, 'ok.js'), 'ok');
  fs.writeFileSync(path.join(dir, '.hidden.js'), 'secret');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'x.js'), 'secret');
  fs.writeFileSync(path.join(dir, 'Upper.js'), 'secret');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'secret');
  const server = await startPanelServer({
    host: '127.0.0.1',
    port: 0,
    botToken: BOT_TOKEN,
    allowedUserId: '424242',
    sessions: new PanelSessions(),
    staticDir: dir
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/panel/ok.js`)).status, 200);
    for (const p of [
      '/panel/.hidden.js',
      '/panel/sub/x.js',
      '/panel/sub%2fx.js',
      '/panel/Upper.js',
      '/panel/notes.txt'
    ]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(await res.text(), /secret/, p);
    }
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCN-003：/panel/ 提供手機頁與同源資源，不能用 .. 讀到其他檔案', async () => {
  await withPanel({}, async ({ base }) => {
    const page = await fetch(`${base}/panel/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    const html = await page.text();
    assert.match(html, /telegram-web-app\.js/);
    assert.match(html, /列出不代表可以呼叫/);
    assert.match(html, /全域/);

    const js = await fetch(`${base}/panel/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    const code = await js.text();
    // 前端用相對路徑（../panel-api/），Tunnel 換網址不必改頁面
    assert.match(code, /\.\.\/panel-api\//);
    assert.match(code, /'login'/);
    assert.doesNotMatch(code, /innerHTML/);
    assert.doesNotMatch(code, /localStorage|sessionStorage/);

    for (const p of [
      '/panel/../panel-server.ts',
      '/panel/%2e%2e/panel-auth.ts',
      '/panel/nope.js',
      '/panel'
    ]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, p);
    }
  });
});
