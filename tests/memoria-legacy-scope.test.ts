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
/** 測試一律指向這個關閉的埠,服務檢查才會判定 Memoria 已停止。 */
const STOPPED_ENDPOINT = 'http://127.0.0.1:9';

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
        JSON.stringify(meta)
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

function startHealthServer(): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/v1/health' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done()))
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
  { session: { id: 'bad-content', rawUserContent: 'not json' }, reason: /文字/ }
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

test('CLI：前置檢查失敗時以非 0 結束並說明原因', async () => {
  await withTempDir(async (dir) => {
    const child = runCli(['--db', path.join(dir, 'missing.db')]);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /找不到/);
  });
});
