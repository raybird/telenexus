import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-05：SCN-008 補證後重跑完整 gate；GitHub branch check 並未配置。
const directory = dirname(fileURLToPath(import.meta.url));
const repo = resolve(directory, '../../../..');
const records = [];
for (const script of ['build', 'test', 'lint', 'test:installer']) {
  const result = spawnSync('npm', ['run', script], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const log = `scn008-${script.replace(':', '-')}-20261005.log`;
  // 2026-10-05：只正規化顯示用 CR／行尾空白，不修改測試結果。
  writeFileSync(join(directory, log), (result.stdout + result.stderr).replaceAll('\r', '').split('\n').map(line => line.trimEnd()).join('\n').trimEnd() + '\n');
  records.push({ date: '2026-10-05', command: `npm run ${script}`, exitCode: result.status, tests: result.stdout.match(/^# tests (\d+)$/m)?.[1] ?? null, fail: result.stdout.match(/^# fail (\d+)$/m)?.[1] ?? null, log });
  writeFileSync(join(directory, 'scn008-project-gates.json'), JSON.stringify(records, null, 2) + '\n');
  console.log(JSON.stringify(records.at(-1)));
  if (result.status !== 0) { process.exitCode = 1; break; }
}
