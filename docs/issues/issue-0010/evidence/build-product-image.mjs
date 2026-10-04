import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-04：僅建測試映像，不啟動 compose 或操作正式服務。
const evidence = dirname(fileURLToPath(import.meta.url));
const repo = resolve(evidence, '../../../..');
const label = process.argv[2] || '';
if (label && !/^[a-z0-9-]+$/.test(label)) throw new Error('不合法的證據版本標籤');
const suffix = label ? `-${label}` : '';
const codeHashes = Object.fromEntries([
  'Dockerfile', 'package.json', 'package-lock.json',
  'scripts/browser-mcp-launcher.mjs', 'src/core/opencode.ts', 'src/core/agent.ts', 'src/runner.ts'
].map(name => [name, createHash('sha256').update(readFileSync(join(repo, name))).digest('hex')]));
const args = ['build', '--progress=plain', '-t', 'issue10-product:20261004', '.'];
const result = spawnSync('docker', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
writeFileSync(join(evidence, `phase2-product-build${suffix}.log`), result.stdout + result.stderr);
const inspection = result.status === 0
  ? spawnSync('docker', ['image', 'inspect', 'issue10-product:20261004', '--format', '{{.Id}}'], { encoding: 'utf8' })
  : null;
const record = { date: '2026-10-04', command: ['docker', ...args], codeHashes, exitCode: result.status, imageId: inspection?.stdout.trim() ?? null };
writeFileSync(join(evidence, `phase2-product-build${suffix}.json`), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record));
process.exitCode = result.status ?? 1;
