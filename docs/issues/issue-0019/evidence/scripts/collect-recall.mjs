// 對 Memoria 服務送出凍結評估集的問句，把每題的原始回應存下來，供 evaluate.mjs 離線比較判準。
// payload 與 MemoriaRecallClient.recallWithMeta 相同（project=TeleNexus、top_k=5、mode=hybrid）。
// 用法：node collect-recall.mjs <frozen.json> <endpoint> <split> <out.json> [--transform <name>]
//   split：tuning 或 acceptance。驗收集在判準定案前不跑。
//   transform：送出前改寫問句（none、strip-digits、strip-function-words），用來比較問句前處理的判準。
// 輸出含 snippet 原文，只能放在 repo 之外。
import { readFileSync, writeFileSync } from 'node:fs';
import { stripFunctionWords } from './function-words.mjs';

const args = process.argv.slice(2);
const [frozenPath, endpoint, split, outPath] = args;
const transformName = args.includes('--transform') ? args[args.indexOf('--transform') + 1] : 'none';
if (!outPath || !['tuning', 'acceptance'].includes(split)) {
  console.error('用法：node collect-recall.mjs <frozen.json> <endpoint> <tuning|acceptance> <out.json> [--transform <name>]');
  process.exit(2);
}

const TRANSFORMS = {
  none: (q) => q,
  // 拿掉獨立的數字（含小數、百分比），其餘原樣保留
  'strip-digits': (q) => q.replace(/\d+(?:\.\d+)?%?/g, ' ').replace(/\s+/g, ' ').trim(),
  // 拿掉疑問詞與虛詞（清單見 function-words.mjs），換成空白，讓前後的字不會組成新的 2 字窗格
  'strip-function-words': (q) => stripFunctionWords(q)
};
const transform = TRANSFORMS[transformName];
if (!transform) throw new Error(`未知的 transform：${transformName}`);

const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'));
const results = [];
for (const item of frozen.items.filter((i) => i.split === split)) {
  const query = transform(item.q);
  const res = await fetch(`${endpoint}/v1/recall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, project: 'TeleNexus', scope: frozen.scope, top_k: 5, mode: 'hybrid' })
  });
  if (!res.ok) throw new Error(`${item.id}: HTTP ${res.status}`);
  const body = await res.json();
  results.push({
    id: item.id,
    kind: item.kind,
    query,
    meta: body.meta ?? {},
    hits: (body.data ?? body.hits ?? []).map((h) => ({
      id: h.id,
      type: h.type,
      session_id: h.session_id,
      snippet: h.snippet ?? '',
      score: h.score,
      relevance: h.relevance
    }))
  });
}
writeFileSync(outPath, JSON.stringify({ split, transform: transformName, collectedAt: new Date().toISOString(), results }, null, 1) + '\n');
console.log(`${split}：${results.length} 題，transform=${transformName}`);
