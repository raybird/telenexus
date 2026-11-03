import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../docker/memoria-vector-ingest.mjs')
).href;

type Stored = { id: string; kind: string; text: string; vector: number[] };
const entities = Array.from({ length: 5 }, (_, i) => ({
  id: `session:${i}`,
  type: 'session',
  name: `name-${i}`,
  text: `memory-${i}`
}));

test('low CPU ingest commits small batches and rests between them', async () => {
  const { ingestEntities } = await import(moduleUrl);
  const db = new Map<string, Stored>();
  const batches: number[] = [];
  const actions: string[] = [];
  const progress: Record<string, unknown>[] = [];
  const result = await ingestEntities({
    entities,
    store: {
      existing: async () => db,
      write: async (rows: Stored[]) => {
        actions.push('write');
        for (const row of rows) db.set(row.id, row);
      }
    },
    embed: async (texts: string[]) => {
      actions.push('embed');
      batches.push(texts.length);
      return texts.map(() => Array(384).fill(0));
    },
    sleep: async (ms: number) => {
      assert.equal(ms, 1000);
      actions.push('sleep');
    },
    report: async (state: Record<string, unknown>) => {
      progress.push({ ...state });
    }
  });
  assert.deepEqual(batches, [2, 2, 1]);
  assert.deepEqual(actions, [
    'embed',
    'write',
    'sleep',
    'embed',
    'write',
    'sleep',
    'embed',
    'write'
  ]);
  assert.equal(result.completed, 5);
  assert.equal(db.size, 5);
  assert.equal(db.get('session:0')?.text, 'name-0\nmemory-0');
  assert.deepEqual(
    progress.filter((s) => s.phase === 'checkpoint').map((s) => s.completed),
    [2, 4, 5]
  );
  assert.ok(progress.every((s) => !JSON.stringify(s).includes('memory-')));
});

test('restart skips checkpointed unchanged rows and embeds changed content', async () => {
  const { ingestEntities } = await import(moduleUrl);
  const db = new Map<string, Stored>();
  let attempt = 0;
  const store = {
    existing: async () => db,
    write: async (rows: Stored[]) => {
      for (const row of rows) db.set(row.id, row);
    }
  };
  await assert.rejects(
    ingestEntities({
      entities,
      store,
      embed: async (texts: string[]) => {
        if (++attempt === 2) throw new Error('model stopped');
        return texts.map(() => Array(384).fill(0));
      },
      sleep: async () => {},
      report: async () => {}
    }),
    /model stopped/
  );
  assert.equal(db.size, 2);
  const seen: string[] = [];
  const resumed = await ingestEntities({
    entities,
    store,
    embed: async (texts: string[]) => {
      seen.push(...texts);
      return texts.map(() => Array(384).fill(0));
    },
    sleep: async () => {},
    report: async () => {}
  });
  assert.equal(resumed.skipped, 2);
  assert.equal(resumed.embedded, 3);
  assert.ok(!seen.includes('name-0\nmemory-0'));
  const changed = await ingestEntities({
    entities: [{ ...entities[0], text: 'changed' }],
    store,
    embed: async (texts: string[]) => texts.map(() => Array(384).fill(0)),
    sleep: async () => {},
    report: async () => {}
  });
  assert.equal(changed.embedded, 1);
  assert.equal(db.get('session:0')?.text, 'name-0\nchanged');
});

test('unchanged corpus does not load model and unrelated entity kinds are ignored', async () => {
  const { ingestEntities } = await import(moduleUrl);
  const rows = new Map(
    entities.map((e) => [e.id, { id: e.id, kind: e.type, text: `${e.name}\n${e.text}` }])
  );
  const state = await ingestEntities({
    entities: [...entities, { id: 'project:x', type: 'project', text: 'not searchable' }],
    store: { existing: async () => rows, write: async () => assert.fail('no writes expected') },
    embed: async () => assert.fail('model must stay unloaded'),
    sleep: async () => assert.fail('no rest needed'),
    report: async () => {}
  });
  assert.equal(state.skipped, 5);
  assert.equal(state.total, 5);
  assert.equal(state.embedded, 0);
});

test('excluded memories are never embedded and their old vectors are removed', async () => {
  const { ingestEntities } = await import(moduleUrl);
  const db = new Map<string, Stored>([
    ['session:sched-old', { id: 'session:sched-old', kind: 'session', text: 'x', vector: [] }],
    ['session:chat-old', { id: 'session:chat-old', kind: 'session', text: 'y', vector: [] }]
  ]);
  const removed: string[][] = [];
  const embedded: string[] = [];
  const state = await ingestEntities({
    entities: [
      { id: 'session:sched-new', type: 'session', text: 'report' },
      { id: 'mem_node:sched-node', type: 'memory_node', text: 'report node' },
      { id: 'session:chat-new', type: 'session', text: 'chat' }
    ],
    excluded: new Set(['session:sched-old', 'session:sched-new', 'mem_node:sched-node']),
    store: {
      existing: async () => db,
      write: async (rows: Stored[]) => {
        for (const row of rows) db.set(row.id, row);
      },
      remove: async (names: string[]) => {
        removed.push(names);
        for (const name of names) db.delete(name);
      }
    },
    embed: async (texts: string[]) => {
      embedded.push(...texts);
      return texts.map(() => Array(384).fill(0));
    },
    sleep: async () => {},
    report: async () => {}
  });
  assert.deepEqual(removed, [['session:sched-old']]);
  assert.deepEqual(embedded, ['chat']);
  assert.equal(state.removed, 1);
  assert.equal(state.total, 1);
  assert.deepEqual([...db.keys()].sort(), ['session:chat-new', 'session:chat-old']);
});

test('excluded names cover scheduler sessions, their memory nodes and decisions only', async () => {
  const { excludedVectorNames } = await import(moduleUrl);
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, scope TEXT);
      CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, scope TEXT);
      CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT, event_type TEXT);
      INSERT INTO sessions VALUES ('s1', 'scheduler:42'), ('s2', 'user:42'), ('s3', NULL);
      INSERT INTO memory_nodes VALUES ('n1', 'scheduler:42'), ('n2', 'user:42'), ('n3', 'project:x');
      INSERT INTO events VALUES ('e1', 's1', 'DecisionMade'), ('e2', 's1', 'UserMessage'),
                                ('e3', 's2', 'DecisionMade');
    `);
    assert.deepEqual([...excludedVectorNames(db)].sort(), [
      'decision:e1',
      'mem_node:n1',
      'session:s1'
    ]);
  } finally {
    db.close();
  }
});

test('a failed compaction never fails an ingest whose vectors are already written', async () => {
  const { compactQuietly } = await import(moduleUrl);
  assert.equal(
    await compactQuietly({
      compact: async () => {
        throw new Error('SQLITE_BUSY');
      }
    }),
    'failed'
  );
  assert.equal(await compactQuietly({ compact: async () => true }), true);
});

test('invalid embeddings cannot become resumable checkpoints', async () => {
  const { ingestEntities } = await import(moduleUrl);
  let writes = 0;
  await assert.rejects(
    ingestEntities({
      entities: entities.slice(0, 1),
      store: {
        existing: async () => new Map(),
        write: async () => {
          writes++;
        }
      },
      embed: async () => [[1, 2]],
      sleep: async () => {},
      report: async () => {}
    }),
    /384/
  );
  assert.equal(writes, 0);
});
