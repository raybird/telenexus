import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { buildSummary } from '../src/core/memoria-sync.js';
import {
  LegacyScopeMigrationError,
  runLegacyScopeMigration
} from '../src/services/memoria-legacy-scope.js';

/**
 * Issue 0015:把舊版 `project:TeleNexus` 分區的 Memoria session 分到 `user:` / `scheduler:`。
 *
 * 資料庫結構取自 Memoria 1.28.1(tests/fixtures/memoria/),連同 recall_fts 的 trigger 一起建,
 * 所以 summary 改寫後 FTS 語料的變化也看得到。資料全是合成的。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCHEMA = fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'memoria', 'sessions-schema-1.28.1.sql'),
  'utf8'
);
const CLI = path.join(ROOT, 'src', 'tools', 'memoria-legacy-scope-cli.ts');
const LEGACY = 'project:TeleNexus';
/**
 * 測試一律指向這個沒有服務在聽的埠,服務檢查才會判定 Memoria 已停止。
 * 不用 9 這類小埠號:fetch 會直接擋掉,工具會(正確地)判定無法確認。
 */
const STOPPED_ENDPOINT = await new Promise<string>((resolve) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(`http://127.0.0.1:${port}`));
  });
});

type LegacySession = {
  id: string;
  platform?: string | null;
  userId?: string | null;
  userText?: string;
  modelText?: string;
  passthrough?: boolean;
  scope?: string;
  /** 覆寫 ModelMessage 的 metadata 欄位,用來做不一致的情況。 */
  modelMeta?: Record<string, unknown>;
  /** 覆寫 UserMessage 的 metadata 欄位。 */
  userMeta?: Record<string, unknown>;
  userEvents?: number;
  modelEvents?: number;
  rawUserContent?: string;
};

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-legacy-scope-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function legacyMetadata(s: LegacySession): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    source: 'telenexus',
    is_passthrough_command: s.passthrough === true,
    force_new_session: false
  };
  if (s.userId !== null) meta.user_id = s.userId ?? 'u1';
  if (s.platform !== null) meta.platform = s.platform ?? 'telegram';
  return meta;
}

/** 建一個像 Memoria 1.28.1 的 sessions.db:每個 session 有 level-2 node,掛在同一個 topic 下。 */
function createArchive(dir: string, sessions: LegacySession[]): string {
  const dbPath = path.join(dir, '.memory', 'sessions.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const now = '2026-03-01T00:00:00.000Z';
  const insertNode = db.prepare(
    `INSERT INTO memory_nodes (id, parent_id, project, title, summary, level, path_key, created_at, updated_at, last_synced_at, scope)
     VALUES (?, ?, 'TeleNexus', ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSource = db.prepare(
    'INSERT INTO memory_node_sources (node_id, session_id, created_at) VALUES (?, ?, ?)'
  );
  const roots = new Set<string>();

  for (const s of sessions) {
    const scope = s.scope ?? LEGACY;
    const meta = legacyMetadata(s);
    const summary = `user=${s.userId ?? 'u1'} platform=${s.platform ?? 'telegram'} source=pipeline passthrough=${s.passthrough === true}`;
    db.prepare(
      `INSERT INTO sessions (id, timestamp, project, event_count, summary, scope) VALUES (?, ?, 'TeleNexus', 2, ?, ?)`
    ).run(s.id, now, summary, scope);

    const userCount = s.userEvents ?? 1;
    for (let i = 0; i < userCount; i += 1) {
      db.prepare(
        `INSERT INTO events (id, session_id, timestamp, event_type, content, metadata) VALUES (?, ?, ?, 'UserMessage', ?, ?)`
      ).run(
        `${s.id}-u${i}`,
        s.id,
        now,
        s.rawUserContent ?? JSON.stringify({ role: 'user', text: s.userText ?? `問題 ${s.id}` }),
        JSON.stringify({ ...meta, ...(s.userMeta ?? {}) })
      );
    }
    const modelCount = s.modelEvents ?? 1;
    for (let i = 0; i < modelCount; i += 1) {
      db.prepare(
        `INSERT INTO events (id, session_id, timestamp, event_type, content, metadata) VALUES (?, ?, ?, 'ModelMessage', ?, ?)`
      ).run(
        `${s.id}-m${i}`,
        s.id,
        now,
        JSON.stringify({ role: 'assistant', text: s.modelText ?? `回答 ${s.id}` }),
        JSON.stringify({ ...meta, ...(s.modelMeta ?? {}) })
      );
    }

    const root = `node:root:${scope}`;
    const topic = `node:topic:${scope}:general`;
    if (!roots.has(scope)) {
      roots.add(scope);
      insertNode.run(root, null, 'root', 'root', 0, scope, now, now, now, scope);
      insertNode.run(
        topic,
        root,
        'general',
        'general',
        1,
        `${scope}/general`,
        now,
        now,
        now,
        scope
      );
    }
    insertNode.run(
      `node:session:${s.id}`,
      topic,
      summary,
      summary,
      2,
      `${scope}/general/${s.id}`,
      now,
      now,
      now,
      scope
    );
    insertSource.run(`node:session:${s.id}`, s.id, now);
    insertSource.run(topic, s.id, now);
  }
  db.close();
  return dbPath;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listTree(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

/** 假的 Memoria:預設 /v1/health 回 200;`hang` 時收下請求但永遠不回。 */
function startHealthServer(
  behavior: { status?: number; hang?: boolean; redirectTo?: string } = {}
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (behavior.hang) return;
    if (behavior.redirectTo) {
      res.writeHead(302, { Location: `${behavior.redirectTo}${req.url ?? ''}` });
      res.end();
      return;
    }
    const status = req.url === '/v1/health' ? (behavior.status ?? 200) : 404;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          })
      });
    });
  });
}

const MIXED: LegacySession[] = [
  { id: 'chat-1', platform: 'telegram', userText: '工具用完要清理嗎', modelText: '要，跑清理腳本' },
  { id: 'chat-2', platform: 'console', userText: '儀表板說明幾個字', modelText: '兩百字以內' },
  {
    id: 'pass-1',
    platform: 'telegram',
    userText: '/compress',
    modelText: '已壓縮',
    passthrough: true
  },
  { id: 'sched-1', platform: 'scheduler', userText: '[排程任務] 每日報告', modelText: '報告內容' },
  { id: 'other-1', platform: 'telegram', userId: 'u2', userText: '第二位使用者的問題' }
];

// ---- SCN-001 預設只預覽 ----

test('SCN-001: 不加 write 只預覽，資料庫不變也不產生備份', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, MIXED);
    const before = sha256(dbPath);
    const treeBefore = listTree(dir);

    const report = await runLegacyScopeMigration({ dbPath, memoriaEndpoint: STOPPED_ENDPOINT });

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.fromScope, LEGACY);
    assert.deepEqual(report.byTargetScope, { 'user:u1': 3, 'scheduler:u1': 1, 'user:u2': 1 });
    assert.equal(report.totals.migrate, 5);
    assert.equal(report.totals.review, 0);
    assert.equal(report.migrated, 0);
    assert.equal(report.backupPath, null);
    assert.equal(report.recordPath, null);
    assert.equal(report.serviceCheck, null, '預覽不需要停止 Memoria');
    assert.equal(sha256(dbPath), before);
    assert.deepEqual(listTree(dir), treeBefore);
  });
});

test('SCN-001: 預覽時 Memoria 仍在執行也照樣完成', async () => {
  const server = await startHealthServer();
  try {
    await withTempDir(async (dir) => {
      const dbPath = createArchive(dir, MIXED);
      const report = await runLegacyScopeMigration({ dbPath, memoriaEndpoint: server.endpoint });
      assert.equal(report.mode, 'dry-run');
      assert.equal(report.totals.migrate, 5);
    });
  } finally {
    await server.close();
  }
});

test('SCN-002（分類）：依事件記錄的 platform 決定分區，summary 用同步時的組法', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, MIXED);
    const report = await runLegacyScopeMigration({ dbPath, memoriaEndpoint: STOPPED_ENDPOINT });
    const byId = new Map(report.plan.map((p) => [p.sessionId, p]));

    assert.equal(byId.get('chat-1')?.toScope, 'user:u1');
    assert.equal(byId.get('chat-2')?.toScope, 'user:u1', 'console 也是真人對話');
    assert.equal(byId.get('pass-1')?.toScope, 'user:u1', 'passthrough 指令也歸使用者');
    assert.equal(byId.get('sched-1')?.toScope, 'scheduler:u1');
    assert.equal(byId.get('other-1')?.toScope, 'user:u2');
    assert.equal(byId.get('sched-1')?.basis, 'events.metadata.platform=scheduler');
    assert.equal(
      byId.get('chat-1')?.summary,
      buildSummary({
        userId: 'u1',
        userMessage: '工具用完要清理嗎',
        modelMessage: '要，跑清理腳本',
        isPassthroughCommand: false,
        forceNewSession: false
      })
    );
    assert.equal(byId.get('chat-1')?.summary, '工具用完要清理嗎 → 要，跑清理腳本');
  });
});

test('SCN-001: 只處理指定的舊分區，其他分區不列入', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, [
      ...MIXED,
      { id: 'new-1', platform: 'telegram', scope: 'user:u1' },
      { id: 'new-2', platform: 'scheduler', scope: 'scheduler:u1' }
    ]);
    const report = await runLegacyScopeMigration({ dbPath, memoriaEndpoint: STOPPED_ENDPOINT });
    assert.equal(report.totals.candidates, 5);
    assert.ok(!report.plan.some((p) => p.sessionId.startsWith('new-')));
  });
});

// ---- SCN-004 歸屬不明的不遷移 ----

const UNCLEAR: Array<{ session: LegacySession; reason: RegExp }> = [
  { session: { id: 'no-user-id', userId: null }, reason: /user_id/ },
  { session: { id: 'no-platform', platform: null }, reason: /platform/ },
  { session: { id: 'line', platform: 'line' }, reason: /platform/ },
  { session: { id: 'no-user-msg', userEvents: 0 }, reason: /UserMessage/ },
  { session: { id: 'two-user-msg', userEvents: 2 }, reason: /UserMessage/ },
  { session: { id: 'model-platform', modelMeta: { platform: 'scheduler' } }, reason: /不一致/ },
  { session: { id: 'model-user', modelMeta: { user_id: 'u9' } }, reason: /不一致/ },
  { session: { id: 'bad-content', rawUserContent: 'not json' }, reason: /文字/ },
  { session: { id: 'two-model-msg', modelEvents: 2 }, reason: /ModelMessage 超過一筆/ },
  {
    session: { id: 'num-user', userMeta: { user_id: 42 }, modelMeta: { user_id: 42 } },
    reason: /有效的字串/
  }
];

test('SCN-004: 歸屬或內容不明的 session 列入人工審閱，不列入遷移', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, [MIXED[0]!, ...UNCLEAR.map((c) => c.session)]);
    const report = await runLegacyScopeMigration({ dbPath, memoriaEndpoint: STOPPED_ENDPOINT });

    assert.deepEqual(
      report.plan.map((p) => p.sessionId),
      ['chat-1']
    );
    assert.equal(report.totals.review, UNCLEAR.length);
    for (const { session, reason } of UNCLEAR) {
      const item = report.review.find((r) => r.sessionId === session.id);
      assert.ok(item, `${session.id} 應列入人工審閱`);
      assert.match(item.reason, reason, session.id);
    }
  });
});

// ---- SCN-007 Memoria 仍在執行時拒絕寫入 ----

test('SCN-007: 連得上 Memoria 時拒絕寫入，資料庫不變也沒有備份', async () => {
  const server = await startHealthServer();
  try {
    await withTempDir(async (dir) => {
      const dbPath = createArchive(dir, MIXED);
      const before = sha256(dbPath);
      const treeBefore = listTree(dir);

      await assert.rejects(
        runLegacyScopeMigration({ dbPath, write: true, memoriaEndpoint: server.endpoint }),
        (err: unknown) =>
          err instanceof LegacyScopeMigrationError && /停止 Memoria/.test(err.message)
      );
      assert.equal(sha256(dbPath), before);
      assert.deepEqual(listTree(dir), treeBefore);
    });
  } finally {
    await server.close();
  }
});

for (const [label, behavior] of [
  ['回 503（Memoria 自我檢查失敗）', { status: 503 }],
  ['逾時沒有回應', { hang: true }],
  ['轉址到沒有服務在聽的位址', { redirectTo: STOPPED_ENDPOINT }]
] as const) {
  test(`SCN-007: Memoria ${label}時也拒絕寫入，不當成已停止`, async () => {
    const server = await startHealthServer(behavior);
    try {
      await withTempDir(async (dir) => {
        const dbPath = createArchive(dir, MIXED);
        const before = sha256(dbPath);
        const treeBefore = listTree(dir);

        await assert.rejects(
          runLegacyScopeMigration({
            dbPath,
            write: true,
            memoriaEndpoint: server.endpoint,
            memoriaTimeoutMs: 300
          }),
          (err: unknown) =>
            err instanceof LegacyScopeMigrationError && /停止 Memoria/.test(err.message)
        );
        assert.equal(sha256(dbPath), before);
        assert.deepEqual(listTree(dir), treeBefore);
      });
    } finally {
      await server.close();
    }
  });
}

// ---- SCN-008 資料不符預期時中止 ----

for (const write of [false, true]) {
  const mode = write ? 'write' : 'dry-run';

  test(`SCN-008（${mode}）：資料庫不存在時中止，不建立任何檔案`, async () => {
    await withTempDir(async (dir) => {
      const dbPath = path.join(dir, '.memory', 'sessions.db');
      await assert.rejects(
        runLegacyScopeMigration({ dbPath, write, memoriaEndpoint: STOPPED_ENDPOINT }),
        (err: unknown) => err instanceof LegacyScopeMigrationError && /找不到/.test(err.message)
      );
      assert.deepEqual(listTree(dir), []);
    });
  });

  test(`SCN-008（${mode}）：缺少需要的欄位時中止，資料庫不變`, async () => {
    await withTempDir(async (dir) => {
      const dbPath = path.join(dir, 'sessions.db');
      const db = new Database(dbPath);
      db.exec(
        SCHEMA.replace(', scope TEXT);', ');').replace(
          /^CREATE INDEX idx_sessions_scope_timestamp.*$/m,
          ''
        )
      );
      db.close();
      const before = sha256(dbPath);

      await assert.rejects(
        runLegacyScopeMigration({ dbPath, write, memoriaEndpoint: STOPPED_ENDPOINT }),
        (err: unknown) =>
          err instanceof LegacyScopeMigrationError && /sessions\.scope/.test(err.message)
      );
      assert.equal(sha256(dbPath), before);
      assert.deepEqual(listTree(dir), ['sessions.db']);
    });
  });

  test(`SCN-008（${mode}）：完整性檢查沒通過時中止，資料庫不變`, async () => {
    await withTempDir(async (dir) => {
      const dbPath = createArchive(dir, MIXED);
      // 第 2 頁之後整段寫成垃圾:檔頭還在,能開檔,但 B-tree 已經壞了
      const buf = fs.readFileSync(dbPath);
      const pageSize = buf.readUInt16BE(16);
      buf.fill(0xab, pageSize * 2, Math.min(buf.length, pageSize * 6));
      fs.writeFileSync(dbPath, buf);
      const before = sha256(dbPath);
      const treeBefore = listTree(dir);

      await assert.rejects(
        runLegacyScopeMigration({ dbPath, write, memoriaEndpoint: STOPPED_ENDPOINT }),
        (err: unknown) => err instanceof LegacyScopeMigrationError
      );
      assert.equal(sha256(dbPath), before);
      assert.deepEqual(listTree(dir), treeBefore);
    });
  });
}

// ---- CLI ----

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, MEMORIA_ENDPOINT: STOPPED_ENDPOINT },
    encoding: 'utf8',
    timeout: 60_000
  });
}

test('CLI：預覽輸出各分區筆數，結束碼 0', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, MIXED);
    const child = runCli(['--db', dbPath, '--json']);
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout) as {
      mode: string;
      byTargetScope: Record<string, number>;
    };
    assert.equal(report.mode, 'dry-run');
    assert.deepEqual(report.byTargetScope, { 'user:u1': 3, 'scheduler:u1': 1, 'user:u2': 1 });
  });
});

test('CLI：沒有指定 --db 時拒絕執行，不沿用 MEMORIA_HOME', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, MIXED);
    const before = sha256(dbPath);
    const child = spawnSync(process.execPath, ['--import', 'tsx', CLI, '--write'], {
      cwd: ROOT,
      env: { ...process.env, MEMORIA_HOME: dir, MEMORIA_ENDPOINT: STOPPED_ENDPOINT },
      encoding: 'utf8',
      timeout: 60_000
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /--db/);
    assert.equal(sha256(dbPath), before);
  });
});

test('CLI：前置檢查失敗時以非 0 結束並說明原因', async () => {
  await withTempDir(async (dir) => {
    const child = runCli(['--db', path.join(dir, 'missing.db')]);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /找不到/);
  });
});

// ---- 步驟 3：寫入、備份、紀錄與回滾 ----

/** 每張表依主鍵排序後的完整內容,用來比對「內容相同」。 */
function dumpTables(dbPath: string): Record<string, unknown[]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const order: Record<string, string> = {
      sessions: 'id',
      events: 'id',
      memory_nodes: 'id',
      memory_node_sources: 'node_id, session_id',
      recall_fts: 'ref_id, kind'
    };
    return Object.fromEntries(
      Object.entries(order).map(([t, o]) => [
        t,
        db.prepare(`SELECT * FROM ${t} ORDER BY ${o}`).all()
      ])
    );
  } finally {
    db.close();
  }
}

function sessionRow(dbPath: string, id: string): { scope: string; summary: string } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT scope, summary FROM sessions WHERE id = ?').get(id) as {
      scope: string;
      summary: string;
    };
  } finally {
    db.close();
  }
}

function query<T>(dbPath: string, sql: string, ...params: unknown[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

test('SCN-002: 寫入後依分類改 scope、重建 summary，移除舊索引節點，事件不變', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, MIXED);
    const before = dumpTables(dbPath);

    const report = await runLegacyScopeMigration({
      dbPath,
      write: true,
      memoriaEndpoint: STOPPED_ENDPOINT
    });

    assert.equal(report.mode, 'write');
    assert.equal(report.migrated, 5);
    assert.deepEqual(report.serviceCheck, {
      endpoint: STOPPED_ENDPOINT,
      reachable: false,
      detail: 'ECONNREFUSED'
    });
    assert.deepEqual(sessionRow(dbPath, 'chat-1'), {
      scope: 'user:u1',
      summary: '工具用完要清理嗎 → 要，跑清理腳本'
    });
    assert.equal(sessionRow(dbPath, 'chat-2').scope, 'user:u1');
    assert.equal(sessionRow(dbPath, 'pass-1').scope, 'user:u1');
    assert.equal(sessionRow(dbPath, 'sched-1').scope, 'scheduler:u1');
    assert.equal(sessionRow(dbPath, 'other-1').scope, 'user:u2');

    const after = dumpTables(dbPath);
    assert.deepEqual(after.events, before.events, '事件的筆數與內容都不變');
    assert.deepEqual(
      (after.sessions as Array<{ id: string }>).map((s) => s.id),
      (before.sessions as Array<{ id: string }>).map((s) => s.id),
      'session ID 不變'
    );
    // recall_fts 由 Memoria 的 trigger 跟著 summary 重建
    const fts = query<{ body: string }>(
      dbPath,
      "SELECT body FROM recall_fts WHERE kind = 'session' AND ref_id = ?",
      'chat-1'
    );
    assert.deepEqual(fts, [{ body: '工具用完要清理嗎 → 要，跑清理腳本 TeleNexus' }]);
    // 舊索引整個移除,交給 memoria index build 重建
    assert.deepEqual(query(dbPath, 'SELECT * FROM memory_node_sources'), []);
    assert.deepEqual(query(dbPath, 'SELECT * FROM memory_nodes'), []);
  });
});

test('SCN-004: 寫入時歸屬不明的 session 與它們的索引都不動', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, [MIXED[0]!, ...UNCLEAR.map((c) => c.session)]);
    const before = dumpTables(dbPath);

    const report = await runLegacyScopeMigration({
      dbPath,
      write: true,
      memoriaEndpoint: STOPPED_ENDPOINT
    });

    assert.equal(report.migrated, 1);
    const beforeSessions = new Map(
      (before.sessions as Array<{ id: string }>).map((s) => [s.id, s])
    );
    for (const { session } of UNCLEAR) {
      const row = query<{ id: string }>(
        dbPath,
        'SELECT * FROM sessions WHERE id = ?',
        session.id
      )[0];
      assert.deepEqual(
        row,
        beforeSessions.get(session.id),
        `${session.id} 的 scope 與 summary 不變`
      );
      assert.equal(
        query(dbPath, 'SELECT * FROM memory_node_sources WHERE session_id = ?', session.id).length,
        2,
        `${session.id} 的索引來源還在`
      );
    }
    // 還有來源的 topic 與它的 root 都要留著
    assert.equal(
      query(dbPath, 'SELECT id FROM memory_nodes WHERE level IN (0, 1) AND scope = ?', LEGACY)
        .length,
      2
    );
    assert.equal(
      query(dbPath, "SELECT id FROM memory_nodes WHERE id = 'node:session:chat-1'").length,
      0
    );
  });
});

test('SCN-005（分區）：不同使用者的對話分到各自的 user scope', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, MIXED);
    await runLegacyScopeMigration({ dbPath, write: true, memoriaEndpoint: STOPPED_ENDPOINT });
    const rows = query<{ id: string; scope: string }>(
      dbPath,
      'SELECT id, scope FROM sessions ORDER BY id'
    );
    assert.deepEqual(rows, [
      { id: 'chat-1', scope: 'user:u1' },
      { id: 'chat-2', scope: 'user:u1' },
      { id: 'other-1', scope: 'user:u2' },
      { id: 'pass-1', scope: 'user:u1' },
      { id: 'sched-1', scope: 'scheduler:u1' }
    ]);
  });
});

test('SCN-003: 改寫前備份整個資料庫，並留下逐筆的遷移紀錄', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, [...MIXED, UNCLEAR[0]!.session]);
    const before = dumpTables(dbPath);

    const report = await runLegacyScopeMigration({
      dbPath,
      write: true,
      memoriaEndpoint: STOPPED_ENDPOINT
    });

    assert.ok(report.backupPath && report.recordPath);
    const outDir = path.dirname(report.backupPath);
    assert.equal(path.dirname(report.recordPath), outDir);
    assert.equal(path.dirname(path.dirname(outDir)), path.dirname(dbPath), '放在資料庫所在目錄下');
    assert.equal(path.basename(path.dirname(outDir)), 'legacy-scope-migration');
    assert.deepEqual(dumpTables(report.backupPath), before, '備份與寫入前內容相同');

    const record = JSON.parse(fs.readFileSync(report.recordPath, 'utf8')) as {
      fromScope: string;
      totals: { candidates: number; migrate: number; review: number };
      byTargetScope: Record<string, number>;
      migrated: Array<Record<string, string>>;
      review: Array<{ sessionId: string; reason: string }>;
    };
    assert.equal(record.fromScope, LEGACY);
    assert.deepEqual(record.totals, { candidates: 6, migrate: 5, review: 1 });
    assert.deepEqual(record.byTargetScope, { 'user:u1': 3, 'scheduler:u1': 1, 'user:u2': 1 });
    assert.deepEqual(
      record.migrated.find((m) => m.sessionId === 'sched-1'),
      {
        sessionId: 'sched-1',
        fromScope: LEGACY,
        toScope: 'scheduler:u1',
        basis: 'events.metadata.platform=scheduler'
      }
    );
    assert.equal(record.migrated.length, 5);
    assert.deepEqual(
      record.review.map((r) => r.sessionId),
      ['no-user-id']
    );
  });
});

test('SCN-006: 重跑時遷移 0 筆，不產生新備份，資料庫不變', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, [...MIXED, UNCLEAR[0]!.session]);
    await runLegacyScopeMigration({ dbPath, write: true, memoriaEndpoint: STOPPED_ENDPOINT });
    const afterFirst = sha256(dbPath);
    const treeAfterFirst = listTree(dir);

    const second = await runLegacyScopeMigration({
      dbPath,
      write: true,
      memoriaEndpoint: STOPPED_ENDPOINT
    });

    assert.equal(second.migrated, 0);
    assert.equal(second.totals.migrate, 0);
    assert.equal(second.backupPath, null);
    assert.equal(second.recordPath, null);
    assert.deepEqual(
      second.review.map((r) => r.sessionId),
      ['no-user-id']
    );
    assert.equal(sha256(dbPath), afterFirst);
    assert.deepEqual(listTree(dir), treeAfterFirst);
  });
});

test('SCN-009: 改寫中途失敗時整批回滾，資料庫內容與執行前相同', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, MIXED);
    // 改到第三筆時讓 SQLite 自己丟錯,模擬寫到一半出事
    const db = new Database(dbPath);
    db.exec(`CREATE TRIGGER fail_midway BEFORE UPDATE ON sessions WHEN new.id = 'pass-1'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    db.close();
    const before = dumpTables(dbPath);

    await assert.rejects(
      runLegacyScopeMigration({ dbPath, write: true, memoriaEndpoint: STOPPED_ENDPOINT }),
      (err: unknown) =>
        err instanceof LegacyScopeMigrationError &&
        /回滾/.test(err.message) &&
        /injected failure/.test(err.message)
    );
    assert.deepEqual(dumpTables(dbPath), before);
  });
});

test('CLI：寫入時列出備份與遷移紀錄的位置', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, MIXED);
    const child = runCli(['--db', dbPath, '--write']);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /已遷移：5 筆/);
    assert.match(child.stdout, /備份：.*sessions\.backup\.db/);
    assert.match(child.stdout, /遷移紀錄：.*\.json/);
  });
});

test('SCN-002: 寫入不動其他 scope 的索引節點', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, [
      ...MIXED,
      { id: 'new-1', platform: 'telegram', scope: 'user:u1' },
      { id: 'new-2', platform: 'scheduler', scope: 'scheduler:u1' }
    ]);
    const others = () =>
      query(dbPath, 'SELECT * FROM memory_nodes WHERE scope != ? ORDER BY id', LEGACY);
    const otherSources = () =>
      query(
        dbPath,
        "SELECT * FROM memory_node_sources WHERE session_id LIKE 'new-%' ORDER BY node_id"
      );
    // 其他 scope 也可能有沒有來源的 topic、沒有子節點的 root;遷移只能清自己分區的
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO memory_nodes (id, parent_id, project, title, summary, level, path_key, scope)
       VALUES ('node:topic:user:u1:stale', 'node:root:user:u1', 'TeleNexus', 'stale', 'stale', 1, 'stale', 'user:u1'),
              ('node:root:user:u9', NULL, 'TeleNexus', 'root', 'root', 0, 'user:u9', 'user:u9')`
    ).run();
    db.close();
    const nodesBefore = others();
    const sourcesBefore = otherSources();
    assert.equal(
      nodesBefore.length,
      8,
      '兩個 scope 各有 root、topic 與 session node，另加兩個孤立節點'
    );

    await runLegacyScopeMigration({ dbPath, write: true, memoriaEndpoint: STOPPED_ENDPOINT });

    assert.deepEqual(others(), nodesBefore);
    assert.deepEqual(otherSources(), sourcesBefore);
  });
});

test('SCN-009: commit 前的自我檢查發現 events 被改動時整批回滾', async () => {
  await withTempDir(async (dir) => {
    const dbPath = createArchive(dir, MIXED);
    // 模擬改寫 sessions 時連帶動到 events(例如 Memoria 改版加了這種 trigger)
    const db = new Database(dbPath);
    db.exec(`CREATE TRIGGER touch_events AFTER UPDATE ON sessions
             BEGIN UPDATE events SET content = content || ' ' WHERE session_id = new.id; END;`);
    db.close();
    const before = dumpTables(dbPath);

    await assert.rejects(
      runLegacyScopeMigration({ dbPath, write: true, memoriaEndpoint: STOPPED_ENDPOINT }),
      (err: unknown) =>
        err instanceof LegacyScopeMigrationError &&
        /回滾/.test(err.message) &&
        /自我檢查/.test(err.message)
    );
    assert.deepEqual(dumpTables(dbPath), before);
  });
});
