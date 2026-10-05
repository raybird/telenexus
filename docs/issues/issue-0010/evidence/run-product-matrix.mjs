import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-04：只建立、量測、停止本腳本具名的拋棄式產品測試容器。
const directory = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] || 'v1';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('label 僅接受小寫字母、數字與連字號');
const image = 'issue10-product:20261004';
const cases = ['static', 'dynamic', 'startupfail', 'navigationtimeout', 'cancel', 'upstreamfail', 'groupkill'].map(mode => ({ mode, entry: 'structured', lane: 'interactive' }));
cases.push({ mode: 'dynamic', entry: 'stream', lane: 'interactive' }, { mode: 'dynamic', entry: 'structured', lane: 'scheduled' }, { mode: 'dynamic', entry: 'stream', lane: 'scheduled' });
const codeHashes = Object.fromEntries(['product-agent-client.mjs', 'product-opencode-contract.mjs', 'run-product-matrix.mjs', 'proc-observer.mjs', 'memory-mcp-fixture.mjs'].map(name => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]));
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result;
}
const records = [];
for (const { mode, entry, lane } of cases) {
  const name = `issue10-product-${mode}-${entry}-${lane}-${label}-20261004`;
  const args = ['run', '--detach', '--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g', '--pids-limit', '1024', '--name', name, '--mount', `type=bind,src=${directory},dst=/probe,readonly`];
  args.push('--user', 'node', '--entrypoint', 'node', image, '/probe/product-opencode-contract.mjs', mode, entry, lane);
  const started = docker(args).stdout.trim();
  const faultCommand = mode === 'startupfail' ? ['exec', '--user', 'root', name, 'mv', '/opt/telenexus/chrome/chrome-linux64/chrome', '/opt/telenexus/chrome/chrome-linux64/chrome-fixture-disabled'] : null;
  if (faultCommand) docker(faultCommand);
  console.log(JSON.stringify({ event: 'started', mode, entry, lane, name, containerId: started }));
  let result;
  let raw;
  for (let attempt = 0; attempt < 75; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    raw = docker(['logs', name]);
    const rows = raw.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    result = rows.findLast(row => row.event === 'measurement-complete');
    const running = docker(['inspect', '--format', '{{.State.Running}}', name]).stdout.trim() === 'true';
    if (result || !running) break;
  }
  const prefix = `product-${mode}-${entry}-${lane}-${label}`;
  writeFileSync(join(directory, `${prefix}.jsonl`), raw.stdout);
  if (raw.stderr) writeFileSync(join(directory, `${prefix}.stderr.log`), raw.stderr);
  const inspection = JSON.parse(docker(['inspect', name]).stdout)[0];
  records.push({ date: '2026-10-04', mode, entry, lane, command: ['docker', ...args], faultCommand: faultCommand ? ['docker', ...faultCommand] : null, containerId: started, codeHashes, image: inspection.Image, init: inspection.HostConfig.Init, runningAtMeasurement: inspection.State.Running, result: result ?? null });
  writeFileSync(join(directory, `product-matrix-${label}-summary.json`), JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ event: 'result', mode, entry, lane, result: result ?? null }));
  if (inspection.State.Running) docker(['stop', '--time', '2', name]);
  if (!result || !result.cleanupPassed || !result.mergeVerified || !inspection.State.Running) { process.exitCode = 1; break; }
}
