import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-04：45 輪只共用本次建立的單一隔離容器，binary 故障操作限此容器。
const directory = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] || 'v1';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('label 僅接受小寫字母、數字與連字號');
const name = `issue10-product-cycles-${label}-20261004`;
const image = 'issue10-product:20261004';
const codeHashes = Object.fromEntries(['product-cycle-contract.mjs', 'run-product-cycles.mjs', 'product-agent-client.mjs', 'proc-observer.mjs', 'memory-mcp-fixture.mjs'].map(file => [file, createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')]));
const commands = [];
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result;
}
const args = ['run', '--detach', '--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'node', '--memory', '2g', '--pids-limit', '1024', '--name', name, '--mount', `type=bind,src=${directory},dst=/probe,readonly`, '--entrypoint', 'node', image, '/probe/product-cycle-contract.mjs'];
commands.push(['docker', ...args]);
const id = docker(args).stdout.trim();
console.log(JSON.stringify({ event: 'started', name, containerId: id }));
const handled = new Set();
let raw;
let result;
let lastReported = 0;
for (let attempt = 0; attempt < 1800; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  raw = docker(['logs', name]);
  const rows = raw.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  for (const request of rows.filter(row => row.event === 'request-chrome-fault' || row.event === 'request-chrome-restore')) {
    const key = `${request.cycle}:${request.event}`;
    if (handled.has(key)) continue;
    const binary = '/opt/telenexus/chrome/chrome-linux64/chrome';
    if (request.chrome !== binary) throw new Error('故障操作必須限定固定測試 binary');
    const disabled = `${binary}-fixture-disabled`;
    const command = ['exec', '--user', 'root', name, 'mv', ...(request.event === 'request-chrome-fault' ? [binary, disabled] : [disabled, binary])];
    commands.push(['docker', ...command]);
    docker(command); handled.add(key);
    console.log(JSON.stringify({ event: 'fault-handshake', cycle: request.cycle, action: request.event, command: ['docker', ...command] }));
  }
  result = rows.findLast(row => row.event === 'measurement-complete');
  const running = docker(['inspect', '--format', '{{.State.Running}}', name]).stdout.trim() === 'true';
  const completed = rows.filter(row => row.event === 'cycle-complete');
  if (completed.length && completed.length !== lastReported) {
    lastReported = completed.length;
    console.log(JSON.stringify({ event: 'progress', complete: completed.length, latest: completed.at(-1) }));
  }
  if (result || !running) break;
}
writeFileSync(join(directory, `product-cycles-${label}.jsonl`), raw?.stdout || '');
if (raw?.stderr) writeFileSync(join(directory, `product-cycles-${label}.stderr.log`), raw.stderr);
const inspection = JSON.parse(docker(['inspect', name]).stdout)[0];
const summary = { date: '2026-10-05', name, containerId: id, image: inspection.Image, init: inspection.HostConfig.Init, runningAtMeasurement: inspection.State.Running, codeHashes, commands, result: result ?? null };
writeFileSync(join(directory, `product-cycles-${label}-summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ event: 'result', summary }));
if (inspection.State.Running) docker(['stop', '--time', '2', name]);
if (!result?.cleanupPassed || result.cycles.length !== 45 || !inspection.State.Running) process.exitCode = 1;
