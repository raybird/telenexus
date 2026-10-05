import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-04：保存本次版本的完整 gate，不覆寫 Phase1 證據。
const evidence = dirname(fileURLToPath(import.meta.url));
const repo = resolve(evidence, '../../../..');
const records = [];
for (const script of ['build', 'test', 'lint']) {
  const result = spawnSync('npm', ['run', script], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(evidence, `phase2-${script}.log`), result.stdout + result.stderr);
  records.push({ date: '2026-10-04', command: `npm run ${script}`, exitCode: result.status,
    tests: result.stdout.match(/^# tests (\d+)$/m)?.[1] ?? null,
    fail: result.stdout.match(/^# fail (\d+)$/m)?.[1] ?? null });
  writeFileSync(join(evidence, 'phase2-project-gates.json'), JSON.stringify(records, null, 2));
  console.log(JSON.stringify(records.at(-1)));
  if (result.status !== 0) { process.exitCode = 1; break; }
}
