// issue 0030 Task 3.1（SCN-001、SCN-005 支援）：tunnel-manager 的生命週期與內部 API。
// cloudflared 用假腳本（真的 spawn 子程序），外部健康檢查注入；不連外。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TunnelManager, type TunnelState } from '../../src/tunnel/tunnel-manager.js';
import { ensureTunnelKey, startTunnelApi } from '../../src/tunnel/tunnel-api.js';

const FAKE = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'fixtures', 'tunnel', 'fake-cloudflared.sh'),
  'utf8'
);

type Env = { bin: string; log: string; dir: string; launches(): string[] };

function makeEnv(mode: string): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-'));
  const bin = path.join(dir, 'cloudflared');
  const log = path.join(dir, 'launch.log');
  fs.writeFileSync(bin, FAKE);
  fs.chmodSync(bin, 0o755);
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = log;
  return {
    bin,
    log,
    dir,
    launches: () =>
      fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  };
}

function makeManager(env: Env, healthy: (url: string) => Promise<boolean> = async () => true) {
  return new TunnelManager({
    cloudflaredBin: env.bin,
    targetUrl: 'http://telenexus:3040',
    healthCheck: healthy,
    startTimeoutMs: 1500,
    healthIntervalMs: 50
  });
}

async function cleanup(manager: TunnelManager, env: Env) {
  await manager.stop();
  fs.rmSync(env.dir, { recursive: true, force: true });
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('SCN-001：啟動後取得 trycloudflare 網址，健康檢查通過才算就緒', async () => {
  const env = makeEnv('url');
  const checked: string[] = [];
  const manager = makeManager(env, async (url) => {
    checked.push(url);
    return true;
  });
  try {
    assert.equal(manager.status().status, 'stopped');
    const state = await manager.start();
    assert.equal(state.status, 'ready');
    assert.match(state.url ?? '', /^https:\/\/fake-\d+\.trycloudflare\.com$/);
    assert.deepEqual(checked, [state.url]);
    assert.equal(state.generation, 1);
    assert.deepEqual(env.launches(), ['tunnel --no-autoupdate --url http://telenexus:3040']);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-001：並行的啟動請求只開一個 cloudflared，結果相同；就緒後再要求沿用', async () => {
  const env = makeEnv('url');
  const manager = makeManager(env);
  try {
    const results = await Promise.all([manager.start(), manager.start(), manager.start()]);
    assert.equal(new Set(results.map((r) => r.url)).size, 1);
    assert.equal(env.launches().length, 1);
    const again = await manager.start();
    assert.equal(again.url, results[0]!.url);
    assert.equal(env.launches().length, 1);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-001：健康檢查一直失敗時逾時回報失敗，不給網址並收掉子程序', async () => {
  const env = makeEnv('url');
  const manager = makeManager(env, async () => false);
  try {
    const state = await manager.start();
    assert.equal(state.status, 'failed');
    assert.equal(state.url, undefined);
    assert.match(state.error ?? '', /健康檢查/);
    assert.equal(manager.hasChild(), false);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-001：cloudflared 沒給網址就結束時回報失敗', async () => {
  const env = makeEnv('exit-early');
  const manager = makeManager(env);
  try {
    const state = await manager.start();
    assert.equal(state.status, 'failed');
    assert.equal(state.url, undefined);
    assert.match(state.error ?? '', /結束/);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-001：一直等不到網址時逾時回報失敗並收掉子程序', async () => {
  const env = makeEnv('no-url');
  const manager = makeManager(env);
  try {
    const state = await manager.start();
    assert.equal(state.status, 'failed');
    assert.match(state.error ?? '', /逾時/);
    assert.equal(manager.hasChild(), false);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-001：cloudflared 執行檔不存在時回報失敗', async () => {
  const env = makeEnv('url');
  const manager = new TunnelManager({
    cloudflaredBin: path.join(env.dir, 'missing'),
    targetUrl: 'http://telenexus:3040',
    healthCheck: async () => true,
    startTimeoutMs: 1500,
    healthIntervalMs: 50
  });
  try {
    const state = await manager.start();
    assert.equal(state.status, 'failed');
    assert.equal(state.url, undefined);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-005：就緒後 cloudflared 意外結束，狀態回到停止、世代遞增、網址清除', async () => {
  const env = makeEnv('url-then-exit');
  const manager = makeManager(env);
  try {
    const ready = await manager.start();
    assert.equal(ready.status, 'ready');
    await waitFor(() => manager.status().status === 'stopped');
    const after = manager.status();
    assert.equal(after.url, undefined);
    assert.equal(after.generation, ready.generation + 1);
    assert.match(after.error ?? '', /意外結束/);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-005：停止會收掉子程序、世代遞增；之後再啟動取得新網址', async () => {
  const env = makeEnv('url');
  const manager = makeManager(env);
  try {
    const first = await manager.start();
    const stopped = await manager.stop();
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.url, undefined);
    assert.equal(stopped.generation, first.generation + 1);
    assert.equal(manager.hasChild(), false);
    const noop = await manager.stop();
    assert.equal(noop.generation, stopped.generation);
    const second = await manager.start();
    assert.equal(second.status, 'ready');
    assert.notEqual(second.url, first.url);
    assert.equal(env.launches().length, 2);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-005：啟動中收到停止時，不會在停止後變成就緒', async () => {
  const env = makeEnv('url');
  let release: (v: boolean) => void = () => {};
  const manager = makeManager(env, () => new Promise<boolean>((r) => (release = r)));
  try {
    const starting = manager.start();
    await waitFor(() => env.launches().length === 1);
    await new Promise((r) => setTimeout(r, 100));
    const stopped = await manager.stop();
    release(true);
    const result = await starting;
    assert.equal(stopped.status, 'stopped');
    assert.notEqual(result.status, 'ready');
    assert.equal(manager.status().status, 'stopped');
    assert.equal(manager.hasChild(), false);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-005：停止時 cloudflared 還在收尾、健康檢查先回成功，也不會在停止後變成就緒', async () => {
  // review-87b6cf6 S1：真的 cloudflared 收到 SIGTERM 會收尾一段時間，exited 還是 false
  const env = makeEnv('slow-term');
  let release: (v: boolean) => void = () => {};
  const manager = makeManager(env, () => new Promise<boolean>((r) => (release = r)));
  try {
    const starting = manager.start();
    await waitFor(() => env.launches().length === 1);
    await new Promise((r) => setTimeout(r, 100));
    const stopping = manager.stop();
    await new Promise((r) => setTimeout(r, 100));
    release(true);
    const result = await starting;
    const stopped = await stopping;
    assert.notEqual(result.status, 'ready');
    assert.equal(stopped.status, 'stopped');
    assert.equal(manager.status().status, 'stopped');
    assert.equal(manager.hasChild(), false);
  } finally {
    await cleanup(manager, env);
  }
});

test('SCN-001：cloudflared 錯誤訊息裡的 api.trycloudflare.com 不會被當成 Tunnel 網址', async () => {
  // review-87b6cf6 N9
  const env = makeEnv('api-url-first');
  const checked: string[] = [];
  const manager = makeManager(env, async (url) => {
    checked.push(url);
    return true;
  });
  try {
    const state = await manager.start();
    assert.equal(state.status, 'ready');
    assert.match(state.url ?? '', /^https:\/\/fake-\d+\.trycloudflare\.com$/);
    assert.equal(
      checked.some((u) => u.includes('api.trycloudflare.com')),
      false
    );
  } finally {
    await cleanup(manager, env);
  }
});

// ---- 內部 API ----

async function withApi(
  fn: (ctx: { base: string; key: string; manager: TunnelManager; env: Env }) => Promise<void>
) {
  const env = makeEnv('url');
  const manager = makeManager(env);
  const keyFile = path.join(env.dir, 'secret', 'key');
  const key = ensureTunnelKey(keyFile);
  const api = await startTunnelApi({ host: '127.0.0.1', port: 0, key, manager });
  try {
    await fn({ base: `http://127.0.0.1:${api.port}`, key, manager, env });
  } finally {
    await api.close();
    await cleanup(manager, env);
  }
}

test('SCN-001：內部金鑰檔由 tunnel-manager 產生，隨機且只有擁有者可讀寫', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-key-'));
  try {
    const file = path.join(dir, 'sub', 'key');
    const a = ensureTunnelKey(file);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fs.readFileSync(file, 'utf8'), a);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    const b = ensureTunnelKey(path.join(dir, 'other'));
    assert.notEqual(a, b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCN-001：內部 API 沒帶或帶錯金鑰一律 401，不啟動 Tunnel', async () => {
  await withApi(async ({ base, env }) => {
    for (const headers of [{}, { 'x-tunnel-key': 'wrong' }, { authorization: 'Bearer wrong' }]) {
      for (const [method, p] of [
        ['POST', '/tunnel/start'],
        ['GET', '/tunnel/status'],
        ['POST', '/tunnel/stop']
      ] as const) {
        const res = await fetch(`${base}${p}`, { method, headers });
        assert.equal(res.status, 401, `${method} ${p} ${JSON.stringify(headers)}`);
      }
    }
    assert.equal(env.launches().length, 0);
  });
});

test('SCN-001：帶正確金鑰可啟動、查狀態、停止；未知路徑 404', async () => {
  await withApi(async ({ base, key }) => {
    const headers = { 'x-tunnel-key': key };
    const started = (await (
      await fetch(`${base}/tunnel/start`, { method: 'POST', headers })
    ).json()) as TunnelState;
    assert.equal(started.status, 'ready');
    const status = (await (
      await fetch(`${base}/tunnel/status`, { headers })
    ).json()) as TunnelState;
    assert.equal(status.url, started.url);
    const stopped = (await (
      await fetch(`${base}/tunnel/stop`, { method: 'POST', headers })
    ).json()) as TunnelState;
    assert.equal(stopped.status, 'stopped');
    assert.equal((await fetch(`${base}/tunnel/other`, { headers })).status, 404);
  });
});

test('SCN-001：啟動失敗時內部 API 回 502 並附原因', async () => {
  const env = makeEnv('exit-early');
  const manager = makeManager(env);
  const key = ensureTunnelKey(path.join(env.dir, 'key'));
  const api = await startTunnelApi({ host: '127.0.0.1', port: 0, key, manager });
  try {
    const res = await fetch(`http://127.0.0.1:${api.port}/tunnel/start`, {
      method: 'POST',
      headers: { 'x-tunnel-key': key }
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as TunnelState;
    assert.equal(body.status, 'failed');
    assert.equal(body.url, undefined);
  } finally {
    await api.close();
    await cleanup(manager, env);
  }
});
