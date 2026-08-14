import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * remember payload 的形狀迴歸測試。
 *
 * 背景:Memoria 的關鍵字召回語料只有 sessions.summary + DecisionMade/SkillLearned 事件,
 * 而 scope 是等值比對。先前 summary 放 metadata、payload 不帶 scope,結果是正式環境
 * 905 個 session 同步成功卻永遠召回 0 筆。這兩個欄位一退化就會靜默失效,所以釘住。
 */
async function withCapturedPayload(
  turn: {
    userId: string;
    userMessage: string;
    modelMessage: string;
    platform?: string;
    isPassthroughCommand: boolean;
    forceNewSession: boolean;
  },
  assertPayload: (payload: Record<string, unknown>) => void
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-sync-test-'));
  const prevEndpoint = process.env.MEMORIA_ENDPOINT;
  const prevHookQueue = process.env.MEMORIA_HOOK_QUEUE_ENABLED;

  let resolvePayload: (value: Record<string, unknown>) => void;
  const received = new Promise<Record<string, unknown>>((resolve) => {
    resolvePayload = resolve;
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.url === '/v1/remember') {
        resolvePayload(JSON.parse(body) as Record<string, unknown>);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  process.env.MEMORIA_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.MEMORIA_HOOK_QUEUE_ENABLED = 'false';

  try {
    const { MemoriaSyncBridge } = await import('../src/core/memoria-sync.js');
    const bridge = new MemoriaSyncBridge({ projectDir: tempDir, mode: 'on' });
    bridge.enqueueTurn(turn);
    assertPayload(await received);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevEndpoint === undefined) delete process.env.MEMORIA_ENDPOINT;
    else process.env.MEMORIA_ENDPOINT = prevEndpoint;
    if (prevHookQueue === undefined) delete process.env.MEMORIA_HOOK_QUEUE_ENABLED;
    else process.env.MEMORIA_HOOK_QUEUE_ENABLED = prevHookQueue;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('remember payload 的 summary 是可搜尋內容,不是 metadata', async () => {
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: '幫我把早上八點的排程改成九點',
      modelMessage: '好的,已經改成 0 9 * * *。',
      platform: 'telegram',
      isPassthroughCommand: false,
      forceNewSession: false
    },
    (payload) => {
      const summary = String(payload.summary);
      // 使用者訊息與回覆都要在 summary 裡 —— 這是 Memoria 唯一搜得到的欄位
      assert.match(summary, /排程/);
      assert.match(summary, /0 9 \* \* \*/);
      // 舊的 metadata 形狀不可以再出現
      assert.doesNotMatch(summary, /platform=/);
      assert.doesNotMatch(summary, /passthrough=/);
    }
  );
});

test('remember payload 的 scope 與召回端一致(user:<id>)', async () => {
  await withCapturedPayload(
    {
      userId: '915354960',
      userMessage: 'hello',
      modelMessage: 'hi',
      isPassthroughCommand: false,
      forceNewSession: false
    },
    (payload) => {
      // prompt/builder.ts 召回時傳 `user:<id>`,Memoria 的 scope 是等值比對
      assert.equal(payload.scope, 'user:915354960');
      assert.equal(payload.project, 'TeleNexus');
    }
  );
});

test('排程輪次寫進 scheduler 分區,不與真人對話同一個 scope', async () => {
  await withCapturedPayload(
    {
      userId: '915354960',
      userMessage: '[排程任務] Crypto Monitor: 請抓取行情',
      modelMessage: '## 加密貨幣監控報告…',
      platform: 'scheduler',
      isPassthroughCommand: false,
      forceNewSession: false
    },
    (payload) => {
      // 聊天召回只查 user:<id>,排程分到另一區才不會擠掉真人對話的召回名額
      assert.equal(payload.scope, 'scheduler:915354960');
      // 內容仍然完整保留 —— 分區是隔離,不是丟棄
      assert.match(String(payload.summary), /Crypto Monitor/);
      assert.match(String(payload.summary), /加密貨幣監控報告/);
    }
  );
});

test('web console 的對話算真人對話,仍走 user 分區', async () => {
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: 'hello',
      modelMessage: 'hi',
      platform: 'console',
      isPassthroughCommand: false,
      forceNewSession: false
    },
    (payload) => {
      assert.equal(payload.scope, 'user:42');
    }
  );
});

test('診斷用的 metadata 移到事件層,沒有隨 summary 一起消失', async () => {
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: 'hello',
      modelMessage: 'hi',
      platform: 'console',
      isPassthroughCommand: true,
      forceNewSession: true
    },
    (payload) => {
      const events = payload.events as Array<{ metadata: Record<string, unknown> }>;
      assert.equal(events.length, 2);
      for (const event of events) {
        assert.equal(event.metadata.platform, 'console');
        assert.equal(event.metadata.user_id, '42');
        assert.equal(event.metadata.is_passthrough_command, true);
        assert.equal(event.metadata.force_new_session, true);
        assert.equal(event.metadata.sync_source, 'pipeline');
      }
    }
  );
});

test('過長的訊息在 summary 裡會被截斷', async () => {
  const long = '排'.repeat(500);
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: long,
      modelMessage: long,
      isPassthroughCommand: false,
      forceNewSession: false
    },
    (payload) => {
      const summary = String(payload.summary);
      assert.ok(summary.length < 520, `summary 應被截斷,實際長度 ${summary.length}`);
      assert.match(summary, /…/);
    }
  );
});
