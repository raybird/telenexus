import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-04：保存真實容器輸出；量測完成前不停止 PID1，不操作正式服務。
const [name, output] = process.argv.slice(2);
if (!/^issue10-[a-z0-9-]+-20261004$/.test(name) || !/^[a-z0-9-]+\.jsonl$/.test(output)) throw new Error('探測目標不合法');
const collected = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
if (collected.status !== 0) throw new Error(collected.stderr || String(collected.error));
const log = collected.stdout;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), output), log);
if (collected.stderr) writeFileSync(join(dirname(fileURLToPath(import.meta.url)), output.replace('.jsonl', '.stderr.log')), collected.stderr);
const rows = log.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const result = rows.findLast(row => row.event === 'measurement-complete');
console.log(JSON.stringify({ name, result: result ?? null }));
if (!result || !result.cleanupPassed) process.exitCode = 1;
