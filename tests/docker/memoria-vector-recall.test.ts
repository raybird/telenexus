import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const script = path.resolve(import.meta.dirname, '../../docker/memoria-vector-recall.mjs');
const moduleUrl = pathToFileURL(script).href;

type Outcome = { code: number | null; stdout: string };

function runGate(env: Record<string, string>, stdin = '{"query":"q","topK":15}'): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'ignore']
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

test('vector store is ready only after the first full ingest finished', async () => {
  const { isVectorIndexReady } = await import(moduleUrl);
  const dir = await mkdtemp(path.join(tmpdir(), 'vector-gate-ready-'));
  const store = path.join(dir, 'vectors.db');
  const vectorUrl = `file:${store}`;
  try {
    assert.equal(isVectorIndexReady({ enabled: true, vectorUrl }), false);
    await writeFile(store, 'partial');
    await writeFile(`${store}.rebuild-pending`, 'pending');
    assert.equal(isVectorIndexReady({ enabled: true, vectorUrl }), false);
    await rm(`${store}.rebuild-pending`);
    assert.equal(isVectorIndexReady({ enabled: true, vectorUrl }), true);
    assert.equal(isVectorIndexReady({ enabled: false, vectorUrl }), false);
    assert.equal(isVectorIndexReady({ enabled: true, vectorUrl: 'libsql://remote' }), true);
    assert.equal(isVectorIndexReady({ enabled: true, vectorUrl: undefined }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('not ready answers empty hits without loading the model', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vector-gate-empty-'));
  try {
    // 官方套件不在測試環境:只要嘗試載入模型就會失敗結束,所以 exit 0 代表沒有載入。
    const result = await runGate({
      MEMORIA_VECTOR_ENABLED: '1',
      LIBSQL_URL: `file:${path.join(dir, 'missing.db')}`
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { hits: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed first index surfaces as a failed query instead of a silent keyword route', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vector-gate-indexfail-'));
  const statusFile = path.join(dir, '.memory/vector-worker-status.json');
  await mkdir(path.dirname(statusFile));
  const gate = (enabled: string) =>
    runGate({
      MEMORIA_HOME: dir,
      MEMORIA_VECTOR_ENABLED: enabled,
      LIBSQL_URL: `file:${path.join(dir, 'missing.db')}`
    });
  try {
    await writeFile(statusFile, JSON.stringify({ phase: 'error' }));
    const failed = await gate('1');
    assert.notEqual(failed.code, 0);
    assert.equal(failed.stdout, '');

    // 關閉語意搜尋時舊狀態檔不算數;重試中也不算,首次索引可能跑很久
    assert.equal((await gate('0')).code, 0);
    await writeFile(statusFile, JSON.stringify({ phase: 'embedding', lastError: 'old' }));
    assert.equal((await gate('1')).code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('disabled semantic search stays silent even when a vector store exists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vector-gate-off-'));
  const store = path.join(dir, 'vectors.db');
  await writeFile(store, 'store');
  try {
    const result = await runGate({
      MEMORIA_VECTOR_ENABLED: '0',
      LIBSQL_URL: `file:${store}`
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { hits: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the parent can write its query after an early answer without a broken pipe', async () => {
  const large = JSON.stringify({ query: 'x'.repeat(1024 * 1024), topK: 15 });
  const result = await runGate({ MEMORIA_VECTOR_ENABLED: '0' }, large);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { hits: [] });
});

test('ready index searches a wider pool and drops hits beyond the distance limit', async () => {
  const { recallHits } = await import(moduleUrl);
  const searched: unknown[][] = [];
  const hits = await recallHits({
    query: 'q',
    embed: async (texts: string[]) => texts.map(() => [0.5]),
    search: async (vector: number[], limit: number) => {
      searched.push([vector, limit]);
      return [
        { name: 'session:close', kind: 'session', distance: 0.1 },
        { name: 'session:edge', kind: 'session', distance: 0.13 },
        { name: 'session:far', kind: 'session', distance: 0.2 }
      ];
    },
    maxDistance: 0.13
  });
  assert.deepEqual(
    hits.map((hit: { name: string }) => hit.name),
    ['session:close', 'session:edge']
  );
  assert.deepEqual(searched, [[[0.5], 100]]);
});

test('an empty query never loads the model', async () => {
  const { recallHits } = await import(moduleUrl);
  const hits = await recallHits({
    query: '',
    embed: async () => assert.fail('model loaded'),
    search: async () => assert.fail('searched'),
    maxDistance: 0.13
  });
  assert.deepEqual(hits, []);
});

test('an unusable distance limit keeps the default instead of opening the gate', async () => {
  const { DEFAULT_MAX_DISTANCE, parseMaxDistance } = await import(moduleUrl);
  assert.equal(parseMaxDistance(undefined), DEFAULT_MAX_DISTANCE);
  assert.equal(parseMaxDistance(''), DEFAULT_MAX_DISTANCE);
  assert.equal(parseMaxDistance('abc'), DEFAULT_MAX_DISTANCE);
  assert.equal(parseMaxDistance('0'), DEFAULT_MAX_DISTANCE);
  assert.equal(parseMaxDistance('3'), DEFAULT_MAX_DISTANCE);
  assert.equal(parseMaxDistance('0.2'), 0.2);
});

test('a query that cannot run fails so Memoria records the degraded route', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vector-gate-fail-'));
  const store = path.join(dir, 'vectors.db');
  await writeFile(store, 'store');
  try {
    // 測試環境沒有官方套件,就緒後載入模型必然失敗,正好代表真實的查詢失敗。
    const result = await runGate({
      MEMORIA_VECTOR_ENABLED: '1',
      LIBSQL_URL: `file:${store}`
    });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
