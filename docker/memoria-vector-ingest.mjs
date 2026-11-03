import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const PACKAGE_ROOT = '/usr/local/lib/node_modules/@raybird.chen/memoria';
const DIM = 384;
const EMBEDDABLE_TYPES = new Set(['session', 'decision', 'skill', 'memory_node']);
const DELETE_CHUNK = 500;

// 向量庫是 rollback journal,預設不等鎖:查詢撞到寫入提交會立刻 SQLITE_BUSY,反過來寫入批次也會失敗。
export const BUSY_TIMEOUT_SQL = 'PRAGMA busy_timeout = 5000';

// 聊天召回只查 user: scope,排程報告從來不會被召回,卻佔了九成八的記憶。
// 不建它們的向量,原始內容仍留在 Memoria 與 moltbot.db。
const SCHEDULER_SCOPE = 'scheduler:%';
const EXCLUDED_NAMES_SQL = `
  SELECT 'session:' || id AS name FROM sessions WHERE scope LIKE @scope
  UNION ALL
  SELECT 'mem_node:' || id FROM memory_nodes WHERE scope LIKE @scope
  UNION ALL
  SELECT 'decision:' || e.id FROM events e JOIN sessions s ON s.id = e.session_id
   WHERE e.event_type = 'DecisionMade' AND s.scope LIKE @scope`;

/** 向量庫中不該出現的名稱:排程 session、它們的記憶節點與決策。db 是 better-sqlite3。 */
export function excludedVectorNames(db) {
  return new Set(
    db
      .prepare(EXCLUDED_NAMES_SQL)
      .all({ scope: SCHEDULER_SCOPE })
      .map((row) => String(row.name))
  );
}

function loadExcludedNames(home, packageRoot = PACKAGE_ROOT) {
  const Database = createRequire(path.join(packageRoot, 'package.json'))('better-sqlite3');
  const db = new Database(path.join(home, '.memory/sessions.db'), {
    readonly: true,
    fileMustExist: true
  });
  try {
    return excludedVectorNames(db);
  } finally {
    db.close();
  }
}

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
  excluded = new Set(),
  batchSize = 2,
  pauseMs = 1000,
  sleep: rest = sleep,
  report = async () => {}
}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(pauseMs) || pauseMs < 0) {
    throw new Error('Invalid ingest configuration');
  }
  const rows = (Array.isArray(entities) ? entities : [])
    .filter(
      (e) =>
        e &&
        typeof e.id === 'string' &&
        EMBEDDABLE_TYPES.has(String(e.type ?? '')) &&
        !excluded.has(e.id)
    )
    .map((e) => ({
      id: e.id,
      kind: String(e.type),
      text: [e.name, e.text].filter(Boolean).join('\n').slice(0, 2000) || String(e.id)
    }));
  const existing = await store.existing();
  // 排除名單以 Memoria 目前的資料為準,所以也會清掉這個版本之前建好的排程向量。
  const stale = [...existing.keys()].filter((name) => excluded.has(name));
  if (stale.length > 0) await store.remove(stale);
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
    removed: stale.length,
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

/**
 * Use the same schema and vector32 representation consumed by Memoria recall.
 *
 * 不建 libSQL 的 DiskANN 索引:它每筆約 82 KB(正式資料 4,379 筆佔 358 MB,向量本身只有 6.7 MB),
 * 前 15 名又只有 88% 與精確掃描相同;只索引聊天記憶後,精確掃描只要幾毫秒。舊版建過的索引在這裡移除。
 */
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
    await db.execute('DROP INDEX IF EXISTS memoria_vectors_idx');
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
    async remove(names) {
      const statements = [];
      for (let i = 0; i < names.length; i += DELETE_CHUNK) {
        const chunk = names.slice(i, i + DELETE_CHUNK);
        statements.push({
          sql: `DELETE FROM memoria_vectors WHERE name IN (${chunk.map(() => '?').join(', ')})`,
          args: chunk
        });
      }
      await db.batch(statements, 'write');
    },
    /** 空頁超過四分之一時重寫檔案;拿掉索引與排程向量後,舊庫的空間要靠這步才會還給磁碟。 */
    async compact() {
      if (!url.startsWith('file:')) return false;
      const pages = Number((await db.execute('PRAGMA page_count')).rows[0][0]);
      const free = Number((await db.execute('PRAGMA freelist_count')).rows[0][0]);
      if (free < 256 || free * 4 < pages) return false;
      await db.execute('VACUUM');
      return true;
    },
    close: () => db.close()
  };
}

/**
 * 壓縮只是回收空間。向量已經寫入,壓縮失敗(查詢持鎖超過 busy_timeout、磁碟滿)若讓 ingest 失敗,
 * worker 就不提交游標,全量重建還會一直停在未就緒;下一輪 ingest 會再試。
 */
export async function compactQuietly(store) {
  try {
    return await store.compact();
  } catch {
    return 'failed';
  }
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
  const excluded = loadExcludedNames(process.env.MEMORIA_HOME || '/data');
  const store = await createVectorStore(url);
  try {
    const result = await ingestEntities({
      entities: payload.entities,
      store,
      embed: await createEmbedder(),
      excluded,
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
    const compacted = await compactQuietly(store);
    console.log(
      JSON.stringify({
        ok: true,
        embedded: result.embedded,
        skipped: result.skipped,
        removed: result.removed,
        compacted,
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
