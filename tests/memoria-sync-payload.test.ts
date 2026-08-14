import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { MemoriaSyncTurn } from '../src/core/memoria-sync.js';

/**
 * remember payload 的形狀迴歸測試。
 *
 * 背景:Memoria 的關鍵字召回語料只有 sessions.summary + DecisionMade/SkillLearned 事件,
 * 而 scope 是等值比對。先前 summary 放 metadata、payload 不帶 scope,結果是正式環境
 * 905 個 session 同步成功卻永遠召回 0 筆。這兩個欄位一退化就會靜默失效,所以釘住。
 */
async function withCapturedPayload(
  turn: MemoriaSyncTurn,
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

test('decision 意圖會多送一個 DecisionMade 事件', async () => {
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: '以後市場相關的回覆都要附上資料來源',
      modelMessage: '了解，之後一律附上來源連結。',
      isPassthroughCommand: false,
      forceNewSession: false,
      memoryIntent: {
        level: 'decision',
        confidence: 'high',
        reason: '使用者明確要求改變回覆格式',
        summary: '市場相關回覆一律附上資料來源連結'
      }
    },
    (payload) => {
      const events = payload.events as Array<{ type: string; content: Record<string, unknown> }>;
      assert.equal(events.length, 3);
      const decision = events.find((e) => e.type === 'DecisionMade');
      assert.ok(decision, ' 應產生 DecisionMade 事件');
      // Memoria 用 parseDecisionEvent(...).decision 當標題,欄位名不能改
      assert.equal(decision.content.decision, '市場相關回覆一律附上資料來源連結');
      assert.equal(decision.content.rationale, '使用者明確要求改變回覆格式');
      assert.equal(decision.content.impact_level, 'high');
    }
  );
});

test('rule 也走 DecisionMade,且 impact_level 為 high', async () => {
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: '以後都用繁體中文',
      modelMessage: '好的。',
      isPassthroughCommand: false,
      forceNewSession: false,
      memoryIntent: {
        level: 'rule',
        confidence: 'medium',
        reason: '語言偏好是長期約束',
        summary: '一律使用台灣用語的繁體中文回覆'
      }
    },
    (payload) => {
      const events = payload.events as Array<{ type: string; content: Record<string, unknown> }>;
      const decision = events.find((e) => e.type === 'DecisionMade');
      assert.ok(decision);
      // rule 是長期約束,即使 confidence 只有 medium 也算 high impact
      assert.equal(decision.content.impact_level, 'high');
    }
  );
});

test('skill 意圖走 SkillLearned,欄位名符合 Memoria 的 parseSkillEvent', async () => {
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: '這個 bug 怎麼查的',
      modelMessage: '先看 recall_fts 的 body 是不是 metadata。',
      isPassthroughCommand: false,
      forceNewSession: false,
      memoryIntent: {
        level: 'skill',
        confidence: 'high',
        reason: '這個判斷法可重複使用',
        summary: '判斷 Memoria 召回是否健康：看 recall_fts 的 body 是散文還是 metadata'
      }
    },
    (payload) => {
      const events = payload.events as Array<{ type: string; content: Record<string, unknown> }>;
      const skill = events.find((e) => e.type === 'SkillLearned');
      assert.ok(skill, ' 應產生 SkillLearned 事件');
      assert.match(String(skill.content.skill_name), /recall_fts/);
      assert.equal(skill.content.pattern, '這個判斷法可重複使用');
      assert.equal(skill.content.category, 'telenexus');
    }
  );
});

test('不夠格的意圖不寫入,寧可少也不要污染語料', async () => {
  const cases = [
    { name: 'long-term-candidate 不算', intent: { level: 'long-term-candidate' as const, confidence: 'high' as const, reason: 'r', summary: 's' } },
    { name: 'low confidence 不算', intent: { level: 'decision' as const, confidence: 'low' as const, reason: 'r', summary: 's' } },
    { name: '沒有 summary 不算', intent: { level: 'decision' as const, confidence: 'high' as const, reason: 'r' } },
    { name: 'summary 只有空白不算', intent: { level: 'rule' as const, confidence: 'high' as const, reason: 'r', summary: '   ' } }
  ];

  for (const c of cases) {
    await withCapturedPayload(
      {
        userId: '42',
        userMessage: 'hello',
        modelMessage: 'hi',
        isPassthroughCommand: false,
        forceNewSession: false,
        memoryIntent: c.intent
      },
      (payload) => {
        const events = payload.events as Array<{ type: string }>;
        assert.equal(events.length, 2, `${c.name}：應維持只有兩個對話事件`);
        assert.ok(!events.some((e) => e.type === 'DecisionMade' || e.type === 'SkillLearned'), c.name);
      }
    );
  }
});

test('夠格的意圖也接進 summary —— Memoria 的 snippet 只取 summary,不接就會配到卻看不到', async () => {
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: '這樣處理可以嗎',
      modelMessage: '可以，我照你說的辦。',
      isPassthroughCommand: false,
      forceNewSession: false,
      memoryIntent: {
        level: 'decision',
        confidence: 'high',
        reason: '使用者拍板',
        summary: '所有對外請求都要留下稽核軌跡'
      }
    },
    (payload) => {
      const summary = String(payload.summary);
      assert.match(summary, /【決策】/);
      assert.match(summary, /所有對外請求都要留下稽核軌跡/);
      // 對話本文仍在,決策是附加而非取代
      assert.match(summary, /這樣處理可以嗎/);
    }
  );
});

test('不夠格的意圖不會污染 summary', async () => {
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: 'hello',
      modelMessage: 'hi',
      isPassthroughCommand: false,
      forceNewSession: false,
      memoryIntent: { level: 'decision', confidence: 'low', reason: 'r', summary: '不該出現' }
    },
    (payload) => {
      assert.doesNotMatch(String(payload.summary), /不該出現|【決策】/);
    }
  );
});

test('沒有意圖時維持原本的兩個事件', async () => {
  await withCapturedPayload(
    {
      userId: '42',
      userMessage: 'hello',
      modelMessage: 'hi',
      isPassthroughCommand: false,
      forceNewSession: false
    },
    (payload) => {
      const events = payload.events as Array<{ type: string }>;
      assert.deepEqual(events.map((e) => e.type), ['UserMessage', 'ModelMessage']);
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
