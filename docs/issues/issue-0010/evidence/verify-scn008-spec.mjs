import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// 2026-10-05：新增驗收與核准集合必須相等，既有七項語意保持不變。
const path = 'docs/issues/issue-0010/README.md';
const current = readFileSync(path, 'utf8');
const approved = execFileSync('git', ['show', `d345ba1bc3f391bd2038f8ca0341ccbf742490d0:${path}`], { encoding: 'utf8' });
const scenarios = text => Object.fromEntries([...text.matchAll(/  @(SCN-\d{3})\n([\s\S]*?)(?=\n  @SCN-|\n```)/g)].map(match => [match[1], match[2].trim()]));
const now = scenarios(current);
assert.equal(Object.keys(now).length, 8);
for (const [id, value] of Object.entries(scenarios(approved))) assert.equal(now[id], value, id);
const rows = [...current.matchAll(/^\| (SCN-\d{3}) \| ([^|]+) \| 已核准 \|$/gm)].map(match => match[1]);
assert.deepEqual(rows, Object.keys(now));
const plan = readFileSync('docs/issues/issue-0010/implementation-plan.md', 'utf8');
assert.ok(plan.includes('責任驗收：SCN-008'));
for (const text of [current, plan]) {
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (match[1].startsWith('http')) continue;
    const target = match[1].split('#')[0];
    if (target) assert.ok(existsSync(`docs/issues/issue-0010/${target}`), target);
  }
}
console.log(JSON.stringify({ date: '2026-10-05', scenarios: Object.keys(now), approvedRows: rows, original001To007Unchanged: true, scn008Task: 'T4.3', localLinksValid: true }));
