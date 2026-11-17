// issue 0030 Task 3.2（SCN-001、SCN-005 責任）：面板入口的開啟、關閉、閒置與 Tunnel 中斷。
// 控制器單元測試用假的 tunnel 客戶端與選單；最後一支以真的 TunnelManager、內部 API、
// TunnelClient 搭假 cloudflared 跑端對端。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PanelSessions } from '../src/web/panel-auth.js';
import { PanelController, type PanelControllerOptions } from '../src/services/panel-controller.js';
import { TunnelClient, type TunnelClientResult } from '../src/tunnel/tunnel-client.js';
import { TunnelManager, type TunnelState } from '../src/tunnel/tunnel-manager.js';
import { ensureTunnelKey, startTunnelApi } from '../src/tunnel/tunnel-api.js';

const IDLE = 30 * 60 * 1000;

function ready(generation: number, url = `https://g${generation}.trycloudflare.com`): TunnelState {
  return { status: 'ready', generation, url };
}

function makeHarness(overrides: Partial<PanelControllerOptions> = {}) {
  const calls: string[] = [];
  const notes: string[] = [];
  let clock = 1_000_000;
  let startResult: TunnelClientResult = { ok: true, state: ready(1) };
  let statusResults: TunnelClientResult[] = [];
  const sessions = new PanelSessions();
  const client = {
    async start(): Promise<TunnelClientResult> {
      calls.push('start');
      await new Promise((r) => setTimeout(r, 5));
      return startResult;
    },
    async status(): Promise<TunnelClientResult> {
      calls.push('status');
      return statusResults.shift() ?? startResult;
    },
    async stop(): Promise<TunnelClientResult> {
      calls.push('stop');
      return { ok: true, state: { status: 'stopped', generation: 2 } };
    }
  };
  const menu = {
    async show(url: string) {
      calls.push(`show ${url}`);
    },
    async reset() {
      calls.push('reset');
    }
  };
  const controller = new PanelController({
    client,
    menu,
    sessions,
    notify: async (text) => {
      notes.push(text);
    },
    now: () => clock,
    ...overrides
  });
  return {
    controller,
    calls,
    notes,
    sessions,
    menu,
    setStart(r: TunnelClientResult) {
      startResult = r;
    },
    setStatuses(r: TunnelClientResult[]) {
      statusResults = r;
    },
    advance(ms: number) {
      clock += ms;
    }
  };
}

test('SCN-001：/panel 啟動 Tunnel 就緒後才設定選單按鈕；再開沿用同一入口', async () => {
  const h = makeHarness();
  const first = await h.controller.open();
  assert.deepEqual(first, { ok: true, url: 'https://g1.trycloudflare.com', reused: false });
  assert.deepEqual(h.calls, ['start', 'show https://g1.trycloudflare.com/panel/']);
  const again = await h.controller.open();
  assert.deepEqual(again, { ok: true, url: 'https://g1.trycloudflare.com', reused: true });
  // review-87b6cf6 N2：沿用時也重送一次選單（冪等），選單被別處重設過也能恢復
  assert.deepEqual(h.calls, [
    'start',
    'show https://g1.trycloudflare.com/panel/',
    'start',
    'show https://g1.trycloudflare.com/panel/'
  ]);
  assert.equal(h.controller.isOpen(), true);
});

test('SCN-005：開啟途中（設定選單時）被關閉，不會留下已發布的入口，選單最後是一般選單', async () => {
  // review-87b6cf6 N1
  let releaseShow: () => void = () => {};
  const h = makeHarness();
  h.menu.show = async (url: string) => {
    await new Promise<void>((r) => (releaseShow = r));
    // Telegram 在這時才真正套用選單，所以在完成時記錄
    h.calls.push(`show ${url}`);
  };
  const opening = h.controller.open();
  await new Promise((r) => setTimeout(r, 20));
  await h.controller.close('manual');
  releaseShow();
  const result = await opening;
  assert.equal(result.ok, false);
  assert.equal(h.controller.isOpen(), false);
  assert.equal(h.calls.at(-1), 'reset', '選單最後要還原');
  // 之後的輪詢不會誤報「Tunnel 已中斷」
  await h.controller.poll();
  assert.deepEqual(h.notes, []);
});

test('SCN-005：開啟途中（啟動 Tunnel 時）被關閉，不設定選單也不算開啟', async () => {
  let releaseStart: () => void = () => {};
  const h = makeHarness();
  const slowStart = async (): Promise<TunnelClientResult> => {
    h.calls.push('start');
    await new Promise<void>((r) => (releaseStart = r));
    return { ok: true, state: ready(1) };
  };
  (
    h.controller as unknown as { options: { client: { start: typeof slowStart } } }
  ).options.client.start = slowStart;
  const opening = h.controller.open();
  await new Promise((r) => setTimeout(r, 20));
  await h.controller.close('manual');
  releaseStart();
  const result = await opening;
  assert.equal(result.ok, false);
  assert.equal(h.controller.isOpen(), false);
  assert.equal(
    h.calls.some((c) => c.startsWith('show')),
    false
  );
});

test('SCN-005：狀態查詢期間入口被關閉，查詢回來後不再處理也不丟錯', async () => {
  // review-87b6cf6 N3
  const h = makeHarness();
  await h.controller.open();
  let releaseStatus: () => void = () => {};
  const client = (
    h.controller as unknown as {
      options: { client: { status: () => Promise<TunnelClientResult> } };
    }
  ).options.client;
  client.status = async () => {
    await new Promise<void>((r) => (releaseStatus = r));
    return { ok: true, state: ready(1) };
  };
  const polling = h.controller.poll();
  await new Promise((r) => setTimeout(r, 20));
  await h.controller.close('manual');
  releaseStatus();
  await polling;
  assert.deepEqual(h.notes, []);
});

test('SCN-001：並行的 /panel 只啟動一次', async () => {
  const h = makeHarness();
  const results = await Promise.all([h.controller.open(), h.controller.open()]);
  assert.equal(
    results.every((r) => r.ok),
    true
  );
  assert.equal(h.calls.filter((c) => c === 'start').length, 1);
  assert.equal(h.calls.filter((c) => c.startsWith('show')).length, 1);
});

test('SCN-001：tunnel-manager 不存在、拒絕、啟動失敗或逾時時回報原因，不設定選單', async () => {
  const cases: Array<[TunnelClientResult, RegExp]> = [
    [{ ok: false, reason: 'unreachable', message: 'connect ECONNREFUSED' }, /tunnel-manager/],
    [{ ok: false, reason: 'unauthorized', message: 'bad key' }, /金鑰/],
    [{ ok: false, reason: 'failed', message: '外部健康檢查逾時，未發布網址' }, /健康檢查逾時/],
    [{ ok: false, reason: 'timeout', message: 'timeout' }, /逾時/]
  ];
  for (const [result, pattern] of cases) {
    const h = makeHarness();
    h.setStart(result);
    const opened = await h.controller.open();
    assert.equal(opened.ok, false, result.ok ? '' : result.reason);
    assert.match(opened.ok ? '' : opened.message, pattern);
    assert.equal(
      h.calls.some((c) => c.startsWith('show')),
      false
    );
    assert.equal(h.controller.isOpen(), false);
  }
});

test('SCN-001：選單按鈕設定失敗時停掉 Tunnel，不算開啟', async () => {
  const h = makeHarness({
    menu: {
      async show() {
        throw new Error('Bad Request: chat not found');
      },
      async reset() {}
    }
  });
  const opened = await h.controller.open();
  assert.equal(opened.ok, false);
  assert.match(opened.ok ? '' : opened.message, /選單/);
  assert.deepEqual(h.calls, ['start', 'stop']);
  assert.equal(h.controller.isOpen(), false);
});

test('SCN-001：面板伺服器沒有啟動時不啟動 Tunnel', async () => {
  const h = makeHarness({ panelAvailable: () => false });
  const opened = await h.controller.open();
  assert.equal(opened.ok, false);
  assert.deepEqual(h.calls, []);
});

test('SCN-005：/panel_close 讓舊憑證失效、停 Tunnel、恢復一般選單，不另外通知', async () => {
  const h = makeHarness();
  await h.controller.open();
  const token = h.sessions.issue('424242');
  const closed = await h.controller.close('manual');
  assert.deepEqual(closed, { wasOpen: true });
  assert.equal(h.sessions.verify(token), null);
  assert.deepEqual(h.calls.slice(-2), ['stop', 'reset']);
  assert.deepEqual(h.notes, []);
  assert.equal(h.controller.isOpen(), false);
  assert.deepEqual(await h.controller.close('manual'), { wasOpen: false });
});

test('SCN-005：連續 30 分鐘沒有經過驗證的請求就關閉並通知；有活動則延後', async () => {
  const h = makeHarness();
  await h.controller.open();
  h.advance(IDLE - 1);
  await h.controller.checkIdle();
  assert.equal(h.controller.isOpen(), true);
  h.controller.touch();
  h.advance(IDLE - 1);
  await h.controller.checkIdle();
  assert.equal(h.controller.isOpen(), true);
  h.advance(1);
  await h.controller.checkIdle();
  assert.equal(h.controller.isOpen(), false);
  assert.deepEqual(h.calls.slice(-2), ['stop', 'reset']);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0]!, /閒置 30 分鐘/);
});

test('SCN-005：正在寫入設定時不因閒置而關閉，寫完後重新計時', async () => {
  const h = makeHarness();
  await h.controller.open();
  const release = h.controller.beginWrite();
  h.advance(IDLE * 2);
  await h.controller.checkIdle();
  assert.equal(h.controller.isOpen(), true);
  release();
  h.advance(IDLE - 1);
  await h.controller.checkIdle();
  assert.equal(h.controller.isOpen(), true);
  h.advance(1);
  await h.controller.checkIdle();
  assert.equal(h.controller.isOpen(), false);
});

test('SCN-005：Tunnel 意外結束（狀態不是就緒或世代改變）時關閉入口並通知', async () => {
  for (const status of [
    { ok: true, state: { status: 'stopped', generation: 2 } },
    { ok: true, state: ready(3) }
  ] as TunnelClientResult[]) {
    const h = makeHarness();
    await h.controller.open();
    const token = h.sessions.issue('424242');
    h.setStatuses([status]);
    await h.controller.poll();
    assert.equal(h.controller.isOpen(), false);
    assert.equal(h.sessions.verify(token), null);
    assert.equal(h.calls.at(-1), 'reset');
    assert.match(h.notes[0] ?? '', /重新輸入 \/panel/);
  }
});

test('SCN-005：狀態查詢偶發失敗一次不關閉，連續兩次才關閉', async () => {
  const h = makeHarness();
  await h.controller.open();
  const down: TunnelClientResult = { ok: false, reason: 'unreachable', message: 'ECONNREFUSED' };
  h.setStatuses([down, { ok: true, state: ready(1) }, down, down]);
  await h.controller.poll();
  assert.equal(h.controller.isOpen(), true);
  await h.controller.poll();
  await h.controller.poll();
  assert.equal(h.controller.isOpen(), true);
  await h.controller.poll();
  assert.equal(h.controller.isOpen(), false);
});

test('SCN-005：重新 /panel 取得新世代時，舊網址的憑證失效', async () => {
  const h = makeHarness();
  await h.controller.open();
  const old = h.sessions.issue('424242');
  h.setStart({ ok: true, state: ready(3) });
  const reopened = await h.controller.open();
  assert.deepEqual(reopened, { ok: true, url: 'https://g3.trycloudflare.com', reused: false });
  assert.equal(h.sessions.verify(old), null);
  assert.equal(h.calls.at(-1), 'show https://g3.trycloudflare.com/panel/');
});

test('SCN-005：服務啟動時停掉殘留的 Tunnel 並恢復一般選單', async () => {
  const h = makeHarness();
  await h.controller.boot();
  assert.deepEqual(h.calls, ['stop', 'reset']);
  assert.deepEqual(h.notes, []);
});

// ---- TunnelClient ----

test('SCN-001：TunnelClient 連不到服務、讀不到金鑰、金鑰不符時回報可區分的原因', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-client-'));
  try {
    const keyFile = path.join(dir, 'key');
    const unreachable = new TunnelClient({ baseUrl: 'http://127.0.0.1:9', keyFile });
    fs.writeFileSync(keyFile, 'k');
    const r1 = await unreachable.status();
    assert.equal(r1.ok === false && r1.reason, 'unreachable');

    const missing = new TunnelClient({
      baseUrl: 'http://127.0.0.1:9',
      keyFile: path.join(dir, 'nope')
    });
    const r2 = await missing.start();
    assert.equal(r2.ok === false && r2.reason, 'unauthorized');

    const env = makeFakeCloudflared('url');
    const manager = new TunnelManager({
      cloudflaredBin: env.bin,
      targetUrl: 'http://telenexus:3040',
      healthCheck: async () => true,
      startTimeoutMs: 1500,
      healthIntervalMs: 50
    });
    ensureTunnelKey(path.join(dir, 'real-key'));
    const api = await startTunnelApi({ host: '127.0.0.1', port: 0, key: 'right', manager });
    try {
      fs.writeFileSync(keyFile, 'wrong');
      const wrong = new TunnelClient({ baseUrl: `http://127.0.0.1:${api.port}`, keyFile });
      const r3 = await wrong.start();
      assert.equal(r3.ok === false && r3.reason, 'unauthorized');
      assert.equal(env.launches().length, 0);
    } finally {
      await api.close();
      await manager.stop();
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 端對端 ----

function makeFakeCloudflared(mode: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cf-'));
  const bin = path.join(dir, 'cloudflared');
  const log = path.join(dir, 'launch.log');
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'tunnel', 'fake-cloudflared.sh'), bin);
  fs.chmodSync(bin, 0o755);
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = log;
  return {
    bin,
    dir,
    launches: () =>
      fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  };
}

async function withRealStack(
  mode: string,
  fn: (ctx: {
    controller: PanelController;
    manager: TunnelManager;
    shown: string[];
    notes: string[];
  }) => Promise<void>
) {
  const env = makeFakeCloudflared(mode);
  const manager = new TunnelManager({
    cloudflaredBin: env.bin,
    targetUrl: 'http://telenexus:3040',
    healthCheck: async () => true,
    startTimeoutMs: 1500,
    healthIntervalMs: 50
  });
  const keyFile = path.join(env.dir, 'secret', 'key');
  const key = ensureTunnelKey(keyFile);
  const api = await startTunnelApi({ host: '127.0.0.1', port: 0, key, manager });
  const shown: string[] = [];
  const notes: string[] = [];
  const controller = new PanelController({
    client: new TunnelClient({ baseUrl: `http://127.0.0.1:${api.port}`, keyFile }),
    menu: {
      async show(url) {
        shown.push(url);
      },
      async reset() {
        shown.push('reset');
      }
    },
    sessions: new PanelSessions(),
    notify: async (t) => {
      notes.push(t);
    }
  });
  try {
    await fn({ controller, manager, shown, notes });
  } finally {
    await api.close();
    await manager.stop();
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
}

test('SCN-001／SCN-005 端對端：開啟後選單指向 Tunnel 網址，關閉後 Tunnel 停止', async () => {
  await withRealStack('url', async ({ controller, manager, shown }) => {
    const opened = await controller.open();
    assert.equal(opened.ok, true);
    assert.match(shown[0] ?? '', /^https:\/\/fake-\d+\.trycloudflare\.com\/panel\/$/);
    assert.equal(manager.status().status, 'ready');
    await controller.close('manual');
    assert.equal(manager.status().status, 'stopped');
    assert.equal(shown.at(-1), 'reset');
  });
});

test('SCN-005 端對端：cloudflared 意外結束後，下一次狀態檢查關閉入口；再 /panel 取得新網址', async () => {
  await withRealStack('url-then-exit', async ({ controller, manager, shown, notes }) => {
    const first = await controller.open();
    assert.equal(first.ok, true);
    const end = Date.now() + 3000;
    while (manager.status().status === 'ready' && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await controller.poll();
    assert.equal(controller.isOpen(), false);
    assert.equal(shown.at(-1), 'reset');
    assert.equal(notes.length, 1);
    const second = await controller.open();
    assert.equal(second.ok, true);
    assert.notEqual(second.ok && second.url, first.ok && first.url);
  });
});

test('SCN-001：tunnel-manager 回覆了網址但狀態不是就緒時不發布', async () => {
  const h = makeHarness();
  h.setStart({
    ok: true,
    state: { status: 'starting', generation: 0, url: 'https://x.trycloudflare.com' }
  });
  const opened = await h.controller.open();
  assert.equal(opened.ok, false);
  assert.equal(
    h.calls.some((c) => c.startsWith('show')),
    false
  );
});
