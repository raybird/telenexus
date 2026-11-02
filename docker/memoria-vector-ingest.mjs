import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const PACKAGE_ROOT = '/usr/local/lib/node_modules/@raybird.chen/memoria';
const DIM = 384;
const EMBEDDABLE_TYPES = new Set(['session', 'decision', 'skill', 'memory_node']);

// 向量庫是 rollback journal,預設不等鎖:查詢撞到寫入提交會立刻 SQLITE_BUSY,反過來寫入批次也會失敗。
export const BUSY_TIMEOUT_SQL = 'PRAGMA busy_timeout = 5000';

function integerOption(raw, fallback, minimum) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error('Invalid ingest configuration');
  return value;
}

/** Commit each small batch before resting, so a restart only repeats unfinished work. */
export async function ingestEntities({
  entities,
  store,
  embed,
  batchSize = 2,
  pauseMs = 1000,
  sleep: rest = sleep,
  report = async () => {}
}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(pauseMs) || pauseMs < 0) {
    throw new Error('Invalid ingest configuration');
  }
  const rows = (Array.isArray(entities) ? entities : [])
    .filter((e) => e && typeof e.id === 'string' && EMBEDDABLE_TYPES.has(String(e.type ?? '')))
    .map((e) => ({
      id: e.id,
      kind: String(e.type),
      text: [e.name, e.text].filter(Boolean).join('\n').slice(0, 2000) || String(e.id)
    }));
  const existing = await store.existing();
  const pending = rows.filter((row) => {
    const saved = existing.get(row.id);
    return !saved || saved.kind !== row.kind || saved.text !== row.text;
  });
  const state = {
    phase: 'starting',
    total: rows.length,
    completed: rows.length - pending.length,
    skipped: rows.length - pending.length,
    embedded: 0,
    batchSize,
    pauseMs
  };
  try {
    await report({ ...state });
    for (let start = 0; start < pending.length; start += batchSize) {
      const batch = pending.slice(start, start + batchSize);
      state.phase = 'embedding';
      await report({ ...state });
      const vectors = await embed(batch.map((row) => row.text));
      if (
        !Array.isArray(vectors) ||
        vectors.length !== batch.length ||
        vectors.some(
          (v) => !Array.isArray(v) || v.length !== DIM || v.some((n) => !Number.isFinite(n))
        )
      ) {
        throw new Error(`Expected ${DIM}-dimensional finite embeddings`);
      }
      await store.write(batch.map((row, i) => ({ ...row, vector: vectors[i] })));
      state.embedded += batch.length;
      state.completed += batch.length;
      state.phase = 'checkpoint';
      await report({ ...state });
      if (start + batchSize < pending.length && pauseMs > 0) {
        state.phase = 'resting';
        await report({ ...state });
        await rest(pauseMs);
      }
    }
    state.phase = 'complete';
    await report({ ...state });
    return state;
  } catch (error) {
    state.phase = 'error';
    await report({ ...state }).catch(() => {});
    throw error;
  }
}

/**
 * Reuse the official dependency/model cache with one native ONNX thread per session.
 * ONNX sizes its pool from the host, so under a CPU quota more threads make every step slower.
 */
export async function createEmbedder(packageRoot = PACKAGE_ROOT, kind = 'passage') {
  const helper = path.join(packageRoot, 'skills/memoria-vector');
  const { importDep, depsLocation } = await import(
    pathToFileURL(path.join(helper, 'deps.mjs')).href
  );
  let pipeline;
  return async (texts) => {
    if ((process.env.MEMORIA_EMBED_PROVIDER || 'local') === 'stub') {
      const { embedTexts } = await import(pathToFileURL(path.join(helper, 'embed.mjs')).href);
      return embedTexts(texts, kind);
    }
    if (process.env.MEMORIA_EMBED_PROVIDER && process.env.MEMORIA_EMBED_PROVIDER !== 'local') {
      throw new Error('Unsupported embedding provider');
    }
    if (!pipeline) {
      const transformers = await importDep('@huggingface/transformers');
      const { modelCacheDir } = depsLocation();
      if (modelCacheDir) transformers.env.cacheDir = modelCacheDir;
      pipeline = await transformers.pipeline(
        'feature-extraction',
        process.env.MEMORIA_EMBED_MODEL?.trim() || 'Xenova/multilingual-e5-small',
        {
          dtype: 'q8',
          session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
        }
      );
    }
    const output = await pipeline(
      texts.map((text) => `${kind}: ${text}`),
      { pooling: 'mean', normalize: true }
    );
    if (output.dims[0] !== texts.length || output.dims[1] !== DIM) {
      throw new Error('Embedding model dimension mismatch');
    }
    return texts.map((_, i) => Array.from(output.data.slice(i * DIM, (i + 1) * DIM)));
  };
}

/** Use the same schema and vector32 representation consumed by Memoria recall. */
export async function createVectorStore(url, packageRoot = PACKAGE_ROOT) {
  const helper = path.join(packageRoot, 'skills/memoria-vector/deps.mjs');
  const { importDep } = await import(pathToFileURL(helper).href);
  const { createClient } = await importDep('@libsql/client');
  const db = createClient({ url, authToken: process.env.LIBSQL_AUTH_TOKEN });
  try {
    await db.execute(BUSY_TIMEOUT_SQL);
    await db.execute(
      `CREATE TABLE IF NOT EXISTS memoria_vectors (name TEXT PRIMARY KEY, kind TEXT, text TEXT, updated_at TEXT, v F32_BLOB(${DIM}))`
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS memoria_vectors_idx ON memoria_vectors (libsql_vector_idx(v))'
    );
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    async existing() {
      const result = await db.execute('SELECT name, kind, text FROM memoria_vectors NOT INDEXED');
      return new Map(
        result.rows.map((row) => [String(row.name), { kind: row.kind, text: row.text }])
      );
    },
    async write(rows) {
      const now = new Date().toISOString();
      await db.batch(
        rows.map((row) => ({
          sql: `INSERT INTO memoria_vectors (name, kind, text, updated_at, v) VALUES (?, ?, ?, ?, vector32(?))
          ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, text=excluded.text, updated_at=excluded.updated_at, v=excluded.v`,
          args: [row.id, row.kind, row.text, now, JSON.stringify(row.vector)]
        })),
        'write'
      );
    },
    close: () => db.close()
  };
}

export async function main() {
  const payloadPath = process.argv[2];
  const url = process.env.LIBSQL_URL?.trim();
  if (!payloadPath || !url) throw new Error('Payload path and LIBSQL_URL are required');
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const progressFile =
    process.env.MEMORIA_VECTOR_PROGRESS_FILE ||
    path.join(process.env.MEMORIA_HOME || '/data', '.memory/vector-ingest-progress.json');
  const batchSize = integerOption(process.env.MEMORIA_EMBED_BATCH, 2, 1);
  const pauseMs = integerOption(process.env.MEMORIA_VECTOR_BATCH_PAUSE_MS, 1000, 0);
  const store = await createVectorStore(url);
  try {
    const result = await ingestEntities({
      entities: payload.entities,
      store,
      embed: await createEmbedder(),
      batchSize,
      pauseMs,
      async report(state) {
        await mkdir(path.dirname(progressFile), { recursive: true });
        await writeFile(
          `${progressFile}.tmp`,
          JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) + '\n',
          { mode: 0o600 }
        );
        await rename(`${progressFile}.tmp`, progressFile);
      }
    });
    console.log(
      JSON.stringify({
        ok: true,
        embedded: result.embedded,
        skipped: result.skipped,
        total: result.total
      })
    );
  } finally {
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // SQL/model errors can contain input text; expose failure type, not private memory.
    console.error(
      `[memoria-vector] ingest failed (${error?.code || error?.name || 'Error'}); completed batches retained`
    );
    process.exitCode = 1;
  });
}
