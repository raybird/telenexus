// 把評估集草稿凍結成量測用的檔案：相關題的目標 session 由 summary 的 LIKE 樣式解析成 id，
// 再分成調整集（tuning）與驗收集（acceptance）：相關題、無關題各自依題號的雜湊排序，前三分之一進驗收集。
// 用法：node freeze-eval-set.mjs <draft.json> <sessions.db> <user-scope> <out.json> [--all-acceptance]
//   --all-acceptance：整份都當驗收集（第二版判準用的全新驗收題）。
// 草稿、輸出與資料庫都含私人對話，只能放在 repo 之外。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [draftPath, dbPath, scope, outPath] = process.argv.slice(2);
const allAcceptance = process.argv.includes('--all-acceptance');
if (!outPath) {
  console.error('用法：node freeze-eval-set.mjs <draft.json> <sessions.db> <user-scope> <out.json>');
  process.exit(2);
}

const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
const db = new DatabaseSync(dbPath, { readOnly: true });
const byPattern = db.prepare('SELECT id FROM sessions WHERE scope = ? AND summary LIKE ? ORDER BY id');

const rank = (id) => createHash('sha256').update(`issue-0019:${id}`).digest('hex');
function assignSplits(list) {
  const acceptance = new Set(
    [...list]
      .sort((a, b) => rank(a.id).localeCompare(rank(b.id)))
      .slice(0, Math.round(list.length / 3))
      .map((x) => x.id)
  );
  return (id) => (allAcceptance || acceptance.has(id) ? 'acceptance' : 'tuning');
}
const relatedSplit = assignSplits(draft.related);
const controlSplit = assignSplits(draft.control);

const items = [];
for (const r of draft.related) {
  const ids = new Set();
  for (const pattern of r.targets) for (const row of byPattern.all(scope, pattern)) ids.add(row.id);
  if (ids.size === 0) throw new Error(`${r.id} 的目標樣式在 ${scope} 找不到任何 session`);
  items.push({ id: r.id, kind: 'related', split: relatedSplit(r.id), q: r.q, targetSessionIds: [...ids].sort() });
}
for (const c of draft.control) {
  items.push({ id: c.id, kind: 'control', split: controlSplit(c.id), q: c.q, targetSessionIds: [] });
}

const frozen = { scope, frozenAt: new Date().toISOString(), items };
const text = JSON.stringify(frozen, null, 1) + '\n';
writeFileSync(outPath, text);

const count = (kind, split) => items.filter((i) => i.kind === kind && i.split === split).length;
const withDigit = (kind, split) =>
  items.filter((i) => i.kind === kind && i.split === split && /\d/.test(i.q)).length;
console.log(`sha256 ${createHash('sha256').update(text).digest('hex')}`);
for (const split of ['tuning', 'acceptance']) {
  console.log(
    `${split}: related ${count('related', split)}（含數字 ${withDigit('related', split)}）、` +
      `control ${count('control', split)}（含數字 ${withDigit('control', split)}）`
  );
}
