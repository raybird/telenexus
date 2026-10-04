import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-04：重跑固定版隔離契約，僅操作本腳本建立且逐一明列的探測容器。
const directory = dirname(fileURLToPath(import.meta.url));
const modes = ['static', 'dynamic', 'startupfail', 'navigationtimeout', 'cancel', 'upstreamfail', 'groupkill'];
const codeHashes = Object.fromEntries(['opencode-contract.mjs', 'task-owned-launcher.mjs', 'proc-observer.mjs', 'memory-mcp-fixture.mjs'].map(name => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]));
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result;
}
const records = [];
for (const mode of modes) {
  const name = `issue10-matrix-${mode}-v6-20261004`;
  const args = ['run', '--detach', '--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'node', '--memory', '2g', '--pids-limit', '1024', '--name', name, '--mount', `type=bind,src=${directory},dst=/probe,readonly`, '--entrypoint', 'node', 'issue10-mcp-probe:20261004', '/probe/opencode-contract.mjs', mode];
  const started = docker(args).stdout.trim();
  console.log(JSON.stringify({ event: 'started', mode, name, containerId: started }));
  let result;
  let raw;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    raw = docker(['logs', name]);
    const rows = raw.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    result = rows.findLast(row => row.event === 'measurement-complete');
    const running = docker(['inspect', '--format', '{{.State.Running}}', name]).stdout.trim() === 'true';
    if (result || !running) break;
  }
  writeFileSync(join(directory, `matrix-${mode}-v6.jsonl`), raw.stdout);
  if (raw.stderr) writeFileSync(join(directory, `matrix-${mode}-v6.stderr.log`), raw.stderr);
  const inspection = JSON.parse(docker(['inspect', name]).stdout)[0];
  records.push({ date: '2026-10-04', mode, command: ['docker', ...args], containerId: started, codeHashes, image: inspection.Image, init: inspection.HostConfig.Init, runningAtMeasurement: inspection.State.Running, result: result ?? null });
  writeFileSync(join(directory, 'matrix-v6-summary.json'), JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ event: 'result', mode, result: result ?? null }));
  if (inspection.State.Running) docker(['stop', '--time', '2', name]);
  if (!result || !result.cleanupPassed || !result.mergeVerified || !inspection.State.Running) {
    process.exitCode = 1;
    break;
  }
}
