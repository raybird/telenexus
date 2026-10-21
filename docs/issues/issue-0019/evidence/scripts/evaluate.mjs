// 用 collect-recall.mjs 存下的原始回應離線計算候選判準的兩個指標：
//   相關命中率＝注入的結果含目標 session 的相關題數 ÷ 相關題數
//   無關注入率＝有任何注入的無關題數 ÷ 無關題數
// 用法：node evaluate.mjs <frozen.json> <raw.json> [--grid | --threshold <t> --min-matched <m> [--count <mode>]]
//   count：命中數的算法。confidence＝round(confidence × token 數)（預設）；
//          snippet-top／snippet-any＝不是純數字的問句 token 出現在第一筆／任何一筆 snippet 的個數。
// 只輸出題號與數字，不輸出問句與 snippet。
import { readFileSync } from 'node:fs';

// Memoria 1.28.1 tokenizeQuery（src/core/utils.ts）的複製：英數字串整段一個 token，
// 中文切成 2 字窗格，長度不足 2 的丟掉。用來把 confidence 換回「命中幾個 token」。
const TOKEN_SPLIT_PATTERN = /[^a-z0-9一-鿿]+/;
const CJK_RUN_PATTERN = /[一-鿿]+/g;
function expandCjkRuns(token, n) {
  if (!/[一-鿿]/.test(token)) return [token];
  const out = [];
  let cursor = 0;
  for (const match of token.matchAll(CJK_RUN_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) out.push(token.slice(cursor, start));
    const run = match[0];
    if (run.length <= n) out.push(run);
    else for (let i = 0; i + n <= run.length; i += 1) out.push(run.slice(i, i + n));
    cursor = start + run.length;
  }
  if (cursor < token.length) out.push(token.slice(cursor));
  return out;
}
export function tokenizeQuery(query, minLength = 2) {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(TOKEN_SPLIT_PATTERN)
        .flatMap((t) => expandCjkRuns(t, minLength))
        .map((t) => t.trim())
        .filter((t) => t.length >= minLength)
    )
  );
}

export function decide(result, { threshold, minMatched, count = 'confidence' }) {
  const hits = result.hits.filter((h) => h.snippet.trim().length > 0);
  if (hits.length === 0) return { injected: false, hits };
  const confidence = typeof result.meta.confidence === 'number' ? result.meta.confidence : null;
  if (confidence === null) return { injected: true, hits }; // 語意路由無法判斷，照常注入
  return { injected: confidence >= threshold && countMatched(result, hits, count) >= minMatched, hits };
}

function countMatched(result, hits, count) {
  const tokens = tokenizeQuery(result.query);
  if (count === 'confidence') return Math.round(result.meta.confidence * tokens.length);
  const texts = (count === 'snippet-top' ? hits.slice(0, 1) : hits).map((h) => h.snippet.toLowerCase());
  return tokens.filter((t) => !/^\d+$/.test(t) && texts.some((text) => text.includes(t))).length;
}

export function score(frozen, raw, criterion) {
  const targets = new Map(frozen.items.map((i) => [i.id, new Set(i.targetSessionIds)]));
  const rows = raw.results.map((r) => {
    const { injected, hits } = decide(r, criterion);
    const hit = injected && hits.some((h) => targets.get(r.id).has(h.session_id));
    return { id: r.id, kind: r.kind, injected, hit };
  });
  const related = rows.filter((r) => r.kind === 'related');
  const control = rows.filter((r) => r.kind === 'control');
  return {
    relatedHits: related.filter((r) => r.hit).length,
    relatedTotal: related.length,
    controlInjected: control.filter((r) => r.injected).length,
    controlTotal: control.length,
    injectedControlIds: control.filter((r) => r.injected).map((r) => r.id),
    missedRelatedIds: related.filter((r) => !r.hit).map((r) => r.id)
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const [frozenPath, rawPath] = args;
  const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'));
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;
  const line = (c, s) =>
    `threshold=${c.threshold} minMatched=${c.minMatched} count=${c.count ?? 'confidence'}：相關命中 ${s.relatedHits}/${s.relatedTotal}（${pct(s.relatedHits, s.relatedTotal)}）、` +
    `無關注入 ${s.controlInjected}/${s.controlTotal}（${pct(s.controlInjected, s.controlTotal)}）`;
  console.log(`# ${raw.split} transform=${raw.transform}`);
  if (args.includes('--grid')) {
    for (const count of ['confidence', 'snippet-top', 'snippet-any']) {
      for (const minMatched of [1, 2, 3]) {
        for (const threshold of [0, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45]) {
          const c = { threshold, minMatched, count };
          console.log(line(c, score(frozen, raw, c)));
        }
      }
    }
  } else {
    const c = {
      threshold: Number(args[args.indexOf('--threshold') + 1]),
      minMatched: Number(args[args.indexOf('--min-matched') + 1]),
      count: args.includes('--count') ? args[args.indexOf('--count') + 1] : 'confidence'
    };
    const s = score(frozen, raw, c);
    console.log(line(c, s));
    console.log(`被注入的無關題：${s.injectedControlIds.join(' ') || '（無）'}`);
    console.log(`沒命中的相關題：${s.missedRelatedIds.join(' ') || '（無）'}`);
  }
}
