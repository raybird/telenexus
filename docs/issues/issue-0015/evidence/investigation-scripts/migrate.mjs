// 模擬 #15 遷移：把 project:TeleNexus 舊 session 依 events.metadata 分到 user:/scheduler:，
// full 模式另外依 memoria-sync.ts buildSummary() 的格式重建 summary。
// 之後刪除這些 session 的 memory_nodes / memory_node_sources，交給 `memoria index build` 重建。
// 用法：node migrate.mjs <sessions.db> <rescope|full> <report.json>
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const [dbPath, mode, reportPath] = process.argv.slice(2);
if (!dbPath || !['rescope', 'full'].includes(mode) || !reportPath) {
  console.error('usage: node migrate.mjs <sessions.db> <rescope|full> <report.json>');
  process.exit(2);
}

const OLD_SCOPE = 'project:TeleNexus';
const SIDE_LIMIT = 240; // 同 SUMMARY_SIDE_CHAR_LIMIT
const collapse = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const trunc = (t) => {
  const c = collapse(t);
  return c.length <= SIDE_LIMIT ? c : `${c.slice(0, SIDE_LIMIT - 1)}…`;
};
const parse = (s) => {
  try {
    return JSON.parse(s ?? '');
  } catch {
    return null;
  }
};

const db = new DatabaseSync(dbPath);
const rows = db
  .prepare(
    `SELECT s.id, s.summary,
            u.metadata AS umeta, u.content AS ucontent, m.content AS mcontent
       FROM sessions s
       LEFT JOIN events u ON u.session_id = s.id AND u.event_type = 'UserMessage'
       LEFT JOIN events m ON m.session_id = s.id AND m.event_type = 'ModelMessage'
      WHERE s.scope = ?`
  )
  .all(OLD_SCOPE);

const plan = [];
const review = [];
for (const r of rows) {
  const meta = parse(r.umeta) ?? {};
  const platform = meta.platform;
  const uid = meta.user_id;
  if (!uid || !['telegram', 'console', 'scheduler'].includes(platform)) {
    review.push({ id: r.id, reason: 'missing user_id or unknown platform', platform: platform ?? null });
    continue;
  }
  const scope = platform === 'scheduler' ? `scheduler:${uid}` : `user:${uid}`;
  const userText = parse(r.ucontent)?.text ?? '';
  const modelText = parse(r.mcontent)?.text ?? '';
  const user = trunc(userText);
  const model = trunc(modelText);
  const summary = mode === 'full' ? (model ? `${user} → ${model}` : user) : r.summary;
  plan.push({ id: r.id, from: OLD_SCOPE, to: scope, basis: `events.metadata.platform=${platform}`, summary });
}

const updateSession = db.prepare('UPDATE sessions SET scope = ?, summary = ? WHERE id = ?');
const deleteSources = db.prepare('DELETE FROM memory_node_sources WHERE session_id = ?');
const deleteSessionNode = db.prepare('DELETE FROM memory_nodes WHERE id = ?');

db.exec('BEGIN');
try {
  for (const p of plan) {
    updateSession.run(p.to, p.summary, p.id);
    deleteSources.run(p.id);
    deleteSessionNode.run(`node:session:${p.id}`);
  }
  // 舊分區裡失去所有來源的 topic node，以及沒有子節點的 root node
  const orphanTopics = db
    .prepare(
      `DELETE FROM memory_nodes
        WHERE scope = ? AND level = 1
          AND id NOT IN (SELECT node_id FROM memory_node_sources)`
    )
    .run(OLD_SCOPE).changes;
  const orphanRoots = db
    .prepare(
      `DELETE FROM memory_nodes
        WHERE scope = ? AND level = 0
          AND id NOT IN (SELECT parent_id FROM memory_nodes WHERE parent_id IS NOT NULL)`
    )
    .run(OLD_SCOPE).changes;
  db.exec('COMMIT');

  const counts = {};
  for (const p of plan) counts[p.to.replace(/:.*/, ':<id>')] = (counts[p.to.replace(/:.*/, ':<id>')] ?? 0) + 1;
  writeFileSync(
    reportPath,
    JSON.stringify(
      { mode, migrated: plan.length, counts, review, orphanTopics, orphanRoots, mapping: plan.map(({ summary, ...rest }) => rest) },
      null,
      2
    )
  );
  console.log(JSON.stringify({ mode, migrated: plan.length, counts, review, orphanTopics, orphanRoots }));
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
