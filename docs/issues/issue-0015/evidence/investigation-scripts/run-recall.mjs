// 對一個已啟動的 memoria serve 打凍結問句，payload 與 MemoriaRecallClient 相同。
// 用法：node run-recall.mjs <port> <questions.json> <user-scope> <sessions.db> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [port, qPath, scope, dbPath, outPath] = process.argv.slice(2);
const MIN_CONFIDENCE = 0.2; // DEFAULT_RECALL_MIN_CONFIDENCE
const questions = JSON.parse(readFileSync(qPath, 'utf8'));
const db = new DatabaseSync(dbPath, { readOnly: true });
const sessionInfo = db.prepare(
  `SELECT s.scope, json_extract(e.metadata, '$.platform') AS platform, s.summary
     FROM sessions s LEFT JOIN events e ON e.session_id = s.id AND e.event_type = 'UserMessage'
    WHERE s.id = ?`
);

async function recall(query) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/recall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, project: 'TeleNexus', scope, top_k: 5, mode: 'hybrid' })
  });
  const body = await res.json();
  const hits = (body.data ?? body.hits ?? []).filter((h) => (h.snippet ?? '').trim());
  const confidence = typeof body.meta?.confidence === 'number' ? body.meta.confidence : null;
  const dropped = hits.length > 0 && confidence !== null && confidence < MIN_CONFIDENCE;
  const injected = dropped ? [] : hits;
  return {
    query,
    route: body.meta?.route_mode ?? 'unknown',
    confidence,
    rawHits: hits.length,
    injected: injected.map((h) => {
      const info = sessionInfo.get(h.session_id) ?? {};
      return { session_id: h.session_id, scope: info.scope ?? null, platform: info.platform ?? null };
    })
  };
}

const out = { old: [], current: [], control: [] };
for (const item of questions.old) {
  const r = await recall(item.q);
  out.old.push({ ...r, expect: item.expect, hit: r.injected.some((h) => h.session_id === item.expect) });
}
for (const item of questions.current) {
  const r = await recall(item.q);
  const ids = db
    .prepare('SELECT id FROM sessions WHERE scope = ? AND summary LIKE ?')
    .all(scope, item.expectSummaryLike)
    .map((x) => x.id);
  out.current.push({ ...r, hit: r.injected.some((h) => ids.includes(h.session_id)) });
}
for (const q of questions.control) out.control.push(await recall(q));

const injectedAll = [...out.old, ...out.current, ...out.control].flatMap((r) => r.injected);
out.summary = {
  oldHits: `${out.old.filter((r) => r.hit).length}/${out.old.length}`,
  currentHits: `${out.current.filter((r) => r.hit).length}/${out.current.length}`,
  controlInjected: `${out.control.filter((r) => r.injected.length > 0).length}/${out.control.length}`,
  injectedTotal: injectedAll.length,
  injectedFromScheduler: injectedAll.filter((h) => h.platform === 'scheduler').length,
  injectedOutsideScope: injectedAll.filter((h) => h.scope !== scope).length
};
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary));
