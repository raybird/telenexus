import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// 2026-10-04：只讀取 Compose 的 init 欄位，不輸出環境值、不啟動 bot stack。
const evidence = dirname(fileURLToPath(import.meta.url));
const repo = resolve(evidence, '../../../..');
function docker(args) {
  const result = spawnSync('docker', args, { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout;
}
const configurations = [
  { name: 'base', files: ['docker-compose.yml'] },
  { name: 'release', files: ['docker-compose.release.yml'] },
  { name: 'dev', files: ['docker-compose.yml', 'docker-compose.dev.yml'] },
];
const records = [];
for (const configuration of configurations) {
  const configArgs = ['compose', '--env-file', '/dev/null', ...configuration.files.flatMap(file => ['-f', file]), 'config', '--format', 'json', '--no-env-resolution', '--no-interpolate'];
  const resolved = JSON.parse(docker(configArgs));
  for (const service of ['telenexus', 'agent-runner']) {
    const settings = resolved.services[service];
    assert.equal(settings.init, true);
    if (service === 'agent-runner') assert.equal(settings.pids_limit, 1024);
    const name = `issue10-init-${configuration.name}-${service}-20261004`;
    const runArgs = ['run', '--detach', '--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'node', '--memory', '256m', '--pids-limit', '64', '--name', name, '--mount', `type=bind,src=${evidence},dst=/probe,readonly`, '--entrypoint', 'node', 'ghcr.io/raybird/telenexus@sha256:4fd13c3bbdcc1e6f2dd8cb37cbbdaae3a8c48287928d59c63fa36db2630d8236', '/probe/orphan-control.mjs'];
    docker(runArgs);
    let raw;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      raw = docker(['logs', name]);
      if (raw.includes('measurement-complete')) break;
    }
    writeFileSync(join(evidence, `init-${configuration.name}-${service}.jsonl`), raw);
    const rows = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
    const final = rows.findLast(row => row.event === 'sample');
    const inspection = JSON.parse(docker(['inspect', name]))[0];
    assert.ok(rows.some(row => row.event === 'measurement-complete'));
    assert.equal(final.target, null);
    assert.equal(final.zombieCount, 0);
    assert.ok(final.observerAlive && inspection.State.Running && inspection.HostConfig.Init);
    records.push({ date: '2026-10-04', configuration: configuration.name, service, resolvedInit: settings.init, runnerPidsLimit: settings.pids_limit ?? null, configCommand: ['docker', ...configArgs], fixtureCommand: ['docker', ...runArgs], containerInit: inspection.HostConfig.Init, runningAtMeasurement: inspection.State.Running, final });
    writeFileSync(join(evidence, 'compose-init-summary.json'), JSON.stringify(records, null, 2));
    console.log(JSON.stringify({ configuration: configuration.name, service, init: true, zombieCount: final.zombieCount, runningAtMeasurement: true }));
    docker(['stop', '--timeout', '2', name]);
  }
}
