// 用編譯後的 MemoriaRecallClient（dist/）跑凍結評估集，逐題比對「是否注入」與 evaluate.mjs 的離線結果。
// 用法：APP_PROJECT_DIR=<暫存目錄> node verify-client.mjs <dist/core/memoria-recall.js> <endpoint> <frozen.json> <raw.json> [<frozen.json> <raw.json> …]
//   raw.json 是同一份評估集以 strip-function-words-v2 收集的原始回應。
// 只輸出題號與比對結果。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { score } from './evaluate.mjs';

const [clientPath, endpoint, ...pairs] = process.argv.slice(2);
if (!clientPath || pairs.length === 0 || pairs.length % 2 !== 0) {
  console.error('用法：node verify-client.mjs <dist/core/memoria-recall.js> <endpoint> <frozen.json> <raw.json> […]');
  process.exit(2);
}
const { MemoriaRecallClient } = await import(pathToFileURL(clientPath).href);
const client = new MemoriaRecallClient({ endpoint, timeoutMs: 10000 });
const CRITERION = { threshold: 0.2, minMatched: 2, count: 'snippet-top' };

let total = 0;
const mismatches = [];
for (let i = 0; i < pairs.length; i += 2) {
  const frozen = JSON.parse(readFileSync(pairs[i], 'utf8'));
  const raw = JSON.parse(readFileSync(pairs[i + 1], 'utf8'));
  const offline = new Set(score(frozen, raw, CRITERION).injectedIds);
  for (const id of raw.results.map((r) => r.id)) {
    const item = frozen.items.find((x) => x.id === id);
    const result = await client.recallWithMeta(item.q, frozen.scope);
    const injected = result.snippets.length > 0;
    total += 1;
    if (injected !== offline.has(id)) mismatches.push(`${id}（client ${injected}，離線 ${offline.has(id)}）`);
  }
}
console.log(`比對 ${total} 題，不一致 ${mismatches.length} 題${mismatches.length ? '：' + mismatches.join('、') : ''}`);
process.exit(mismatches.length === 0 ? 0 : 1);
