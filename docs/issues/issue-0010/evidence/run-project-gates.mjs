import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-04：依專案指定順序保存 build／test／lint 真實輸出，不啟動服務。
const evidence = dirname(fileURLToPath(import.meta.url));
const repo = resolve(evidence, '../../../..');
const records = [];
for (const script of ['build', 'test', 'lint']) {
  const result = spawnSync('npm', ['run', script], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(evidence, `phase1-${script}.log`), result.stdout + result.stderr);
  const record = { date: '2026-10-04', command: `npm run ${script}`, exitCode: result.status, tests: result.stdout.match(/^# tests (\d+)$/m)?.[1] ?? null, fail: result.stdout.match(/^# fail (\d+)$/m)?.[1] ?? null };
  records.push(record);
  writeFileSync(join(evidence, 'phase1-project-gates.json'), JSON.stringify(records, null, 2));
  console.log(JSON.stringify(record));
  if (result.status !== 0) { process.exitCode = 1; break; }
}
