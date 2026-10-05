import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-04：新版映像四組真 local／runner 並行回歸，只操作本腳本建立的具名容器。
const directory = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] || 'v1';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('label 僅接受小寫字母、數字與連字號');
const image = process.argv[3] || 'sha256:c5ccc64de963ea1e9a2b6701eab54dbefdcfc81609f9098de2c2db3559944fca';
if (!image.trim()) throw new Error('必須提供實際映像 ID 或 tag');
const codeHashes = Object.fromEntries(['run-final-concurrency.mjs', 'product-runner-concurrency.mjs', 'product-dynamic-client.mjs', 'proc-observer.mjs', 'memory-mcp-fixture.mjs'].map(file => [file, createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')]));
const cases = [
  ['structured', 'interactive', 'local'],
  ['stream', 'scheduled', 'local'],
  ['stream', 'interactive', 'runner'],
  ['structured', 'scheduled', 'runner']
];
const records = [];
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10000 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result;
}
for (const [entry, lane, cancelTarget] of cases) {
  const prefix = `final-concurrency-${entry}-${lane}-${cancelTarget}-${label}`;
  const name = `issue10-${prefix}-20261004`;
  const args = ['run', '--detach', '--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'node', '--memory', '2g', '--pids-limit', '1024', '--name', name, '--mount', `type=bind,src=${directory},dst=/probe,readonly`, '--entrypoint', 'node', image, '/probe/product-runner-concurrency.mjs', entry, lane, cancelTarget];
  const id = docker(args).stdout.trim();
  console.log(JSON.stringify({ event: 'started', entry, lane, cancelTarget, name, containerId: id }));
  const deadline = Date.now() + 120000;
  let result;
  let raw;
  let timedOut = false;
  while (true) {
    raw = docker(['logs', name]);
    const rows = raw.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    result = rows.findLast(row => row.event === 'measurement-complete');
    const running = docker(['inspect', '--format', '{{.State.Running}}', name]).stdout.trim() === 'true';
    if (result || !running) break;
    if (Date.now() >= deadline) { timedOut = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  writeFileSync(join(directory, `${prefix}.jsonl`), raw.stdout);
  if (raw.stderr) writeFileSync(join(directory, `${prefix}.stderr.log`), raw.stderr);
  const inspection = JSON.parse(docker(['inspect', name]).stdout)[0];
  const passed = !timedOut && inspection.State.Running && inspection.HostConfig.Init === true && result?.scn === 'SCN-004' && result.verified === true && result.mergeVerified === true && result.browserObserved > 0 && result.runnerStillAlive === true && result.cleanupPassed === true;
  const record = { date: '2026-10-05', entry, lane, cancelTarget, name, containerId: id, requestedImage: image, image: inspection.Image, command: ['docker', ...args], codeHashes, deadlineMs: 120000, timedOut, init: inspection.HostConfig.Init, runningAtCollection: inspection.State.Running, raw: `${prefix}.jsonl`, stderr: raw.stderr ? `${prefix}.stderr.log` : null, result: result ?? null, passed };
  records.push(record);
  writeFileSync(join(directory, `${prefix}-summary.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(directory, `final-concurrency-${label}-summary.json`), JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ event: 'result', entry, lane, cancelTarget, passed, record }));
  if (inspection.State.Running) docker(['stop', '--time', '2', name]);
  if (!passed) { process.exitCode = 1; break; }
}
