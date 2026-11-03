import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BUSY_TIMEOUT_SQL, createEmbedder } from './memoria-vector-ingest.mjs';

const PACKAGE_ROOT = '/usr/local/lib/node_modules/@raybird.chen/memoria';

// 官方 helper 的上限。Memoria 用 topK×3 取候選後才濾 scope;排程記憶已不建向量,
// 留著寬一點的候選給其他 user scope 共用同一個向量庫的情況。
const CANDIDATE_POOL = 100;

// Memoria 的向量結果沒有信心值,TeleNexus 擋不掉無關結果,只能在這裡依距離過濾。
// 上游不建議對 cosine 設門檻;這個值的校準與限制見 docs/memoria-semantic-rollout.md。
export const DEFAULT_MAX_DISTANCE = 0.145;

export function parseMaxDistance(raw) {
  const value = Number(raw);
  return raw && value > 0 && value < 2 ? value : DEFAULT_MAX_DISTANCE;
}

/** worker 在首次全量索引完成時才移除 rebuild 標記,所以「檔案存在且無標記」代表索引已就緒。 */
export function isVectorIndexReady({ enabled, vectorUrl }) {
  if (!enabled || !vectorUrl) return false;
  if (!vectorUrl.startsWith('file:')) return true;
  const store = vectorUrl.slice('file:'.length);
  return existsSync(store) && !existsSync(`${store}.rebuild-pending`);
}

function lastIndexRunFailed(home) {
  try {
    const status = readFileSync(path.join(home, '.memory/vector-worker-status.json'), 'utf8');
    return JSON.parse(status).phase === 'error';
  } catch {
    return false;
  }
}

export async function recallHits({ query, embed, search, maxDistance }) {
  if (!query) return [];
  const [vector] = await embed([query]);
  const rows = await search(vector, CANDIDATE_POOL);
  return rows.filter((row) => row.distance <= maxDistance);
}

/**
 * 精確掃描。官方 vector-recall.mjs 走 DiskANN 索引,但這個向量庫不建索引(見 memoria-vector-ingest.mjs);
 * 官方 helper 也不能指定執行緒數,所以不直接呼叫它。
 */
async function searchVectors(url, vector, limit) {
  const helper = path.join(PACKAGE_ROOT, 'skills/memoria-vector/deps.mjs');
  const { importDep } = await import(pathToFileURL(helper).href);
  const { createClient } = await importDep('@libsql/client');
  const db = createClient({ url, authToken: process.env.LIBSQL_AUTH_TOKEN });
  const target = JSON.stringify(vector);
  try {
    await db.execute(BUSY_TIMEOUT_SQL);
    const result = await db.execute({
      sql: `SELECT name, kind, vector_distance_cos(v, vector32(?)) AS distance
            FROM memoria_vectors ORDER BY distance LIMIT ?`,
      args: [target, limit]
    });
    return result.rows.map((row) => ({
      name: String(row.name),
      kind: String(row.kind ?? ''),
      distance: Number(row.distance)
    }));
  } finally {
    db.close();
  }
}

export async function main() {
  // Memoria 會寫 stdin 且沒有處理管線錯誤,一定要讀完才能回答。
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  const vectorUrl = process.env.LIBSQL_URL?.trim();
  const enabled = process.env.MEMORIA_VECTOR_ENABLED === '1';
  if (!isVectorIndexReady({ enabled, vectorUrl })) {
    // 回空會走 keyword 路由,看不出索引壞了;失敗才會被 Memoria 記成降級並進告警。
    if (enabled && lastIndexRunFailed(process.env.MEMORIA_HOME || '/data')) {
      throw new Error('vector index failed');
    }
    console.log(JSON.stringify({ hits: [] }));
    return;
  }
  const hits = await recallHits({
    query: JSON.parse(input).query,
    embed: await createEmbedder(PACKAGE_ROOT, 'query'),
    search: (vector, limit) => searchVectors(vectorUrl, vector, limit),
    maxDistance: parseMaxDistance(process.env.MEMORIA_VECTOR_MAX_DISTANCE)
  });
  console.log(JSON.stringify({ hits }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    // 非零結束讓 Memoria 記成 vector_unavailable;錯誤內容可能含查詢文字,不輸出。
    process.exitCode = 1;
  });
}
