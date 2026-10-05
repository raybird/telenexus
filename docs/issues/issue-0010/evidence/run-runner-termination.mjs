import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-05：停止前先證明宿主觀測能看見真 Chrome；停止後不用 docker exec 判零。
const directory = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] || 'v1';
assert.match(label, /^[a-z0-9-]+$/);
const image = 'sha256:445ce68d079d87c65a11bde4d9effcad26b2e1b6a0e2a4723a8557428cdbefb0';
const records = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function docker(args, timeout = 15000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout;
}
function identity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    let exe = null;
    let argv = '';
    try { exe = readlinkSync(`/proc/${pid}/exe`); } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    return { pid: Number(pid), state: fields[0], ppid: Number(fields[1]), starttime: fields[19], exe, argv };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}
function cgroupMembers(path) {
  try { return { exists: true, pids: readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(Number) }; }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, pids: [] };
    throw error;
  }
}
// 2026-10-05：已知 Z 正對照。Python 父程序不 wait，子程序退出；觀測器必須保留 Z/stat 身分。
const zombieParent = spawn('python3', ['-u', '-c', 'import os,time\npid=os.fork()\nif pid==0: os._exit(0)\nprint(pid,flush=True)\ntime.sleep(20)']);
const zombiePid = await new Promise((resolve, reject) => {
  zombieParent.once('error', reject);
  zombieParent.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
});
let zombie;
for (let attempt = 0; attempt < 100; attempt++) {
  zombie = identity(zombiePid);
  if (zombie?.state === 'Z') break;
  await wait(10);
}
assert.equal(zombie?.state, 'Z');
assert.equal(zombie.exe, null);
zombieParent.kill('SIGTERM');
await new Promise(resolve => zombieParent.once('close', resolve));
const absenceControl = cgroupMembers('/sys/fs/cgroup/issue10-scn008-deliberately-absent/cgroup.procs');
assert.deepEqual(absenceControl, { exists: false, pids: [] });
let deniedCode;
try { cgroupMembers('/proc/1/mem'); } catch (error) { deniedCode = error.code; }
assert.ok(deniedCode && deniedCode !== 'ENOENT', '讀取權限或 I/O 失敗必須拋錯，不得判空');
const observerControls = { zombie, absenceControl, deniedCode, passed: true };
const codeHashes = Object.fromEntries(['run-runner-termination.mjs', 'runner-termination-fixture.mjs'].map(file => [file, createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')]));
for (const mode of ['sigterm', 'deadline-force']) {
  const name = `issue10-scn008-${mode}-${label}-20261005`;
  const config = { provider: { probe: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:19112/v1', apiKey: 'fixture-only' }, models: { contract: { name: 'SCN008 fixture', limit: { context: 32768, output: 4096 } } } } }, model: 'probe/contract' };
  const environment = { APP_PROJECT_DIR: '/tmp/scn008', RUNNER_PORT: '19110', RUNNER_SHARED_SECRET: 'scn008-fixture', MODEL_HEALTH_CHECK_ENABLED: 'false', OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_TASK_TIMEOUT_MS: '120000', XDG_CONFIG_HOME: '/tmp/scn008/config', XDG_CACHE_HOME: '/tmp/scn008/cache', XDG_DATA_HOME: '/tmp/scn008/xdg-data', XDG_STATE_HOME: '/tmp/scn008/state' };
  const args = ['run', '--detach', '--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'node', '--memory', '2g', '--pids-limit', '1024', '--name', name, '--mount', `type=bind,src=${directory},dst=/probe,readonly`, ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--entrypoint', '/bin/sh', image, '-c', 'node /probe/runner-termination-fixture.mjs & exec node /app/dist/runner.js'];
  const id = docker(args).trim();
  const tracked = new Map();
  const samples = [];
  let cgroupPath;
  let ready = false;
  let failure;
  let inspection;
  let before;
  let stopCommand;
  let events;
  let versions;
  const since = Math.floor(Date.now() / 1000) - 1;
  try {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const rows = docker(['top', name, '-eo', 'pid']).trim().split('\n').slice(1).map(pid => identity(pid.trim())).filter(Boolean);
      for (const row of rows) tracked.set(`${row.pid}:${row.starttime}`, row);
      const logs = docker(['logs', name]);
      if (logs.includes('"event":"fixture-error"')) throw new Error(logs);
      if (logs.includes('"event":"browser-held"')) { ready = true; before = rows; break; }
      await wait(50);
    }
    assert.ok(ready, '真 browser 必須先讀到 fixture 正文及 URL');
    inspection = JSON.parse(docker(['inspect', name]))[0];
    assert.equal(inspection.HostConfig.Init, true);
    assert.equal(inspection.Image, image);
    assert.equal(inspection.HostConfig.NetworkMode, 'none');
    versions = docker(['exec', name, '/bin/sh', '-c', 'node --version && opencode --version && /opt/telenexus/chrome/chrome-linux64/chrome --version && sha256sum /app/dist/runner.js /app/dist/core/opencode.js /usr/local/lib/telenexus/browser-mcp-launcher.mjs']);
    const init = identity(inspection.State.Pid);
    const runner = before.find(row => row.ppid === init.pid && row.argv.includes('/app/dist/runner.js'));
    const browser = before.filter(row => row.exe === '/opt/telenexus/chrome/chrome-linux64/chrome');
    const opencode = before.find(row => row.argv.includes('opencode run'));
    const launcher = before.find(row => row.argv.includes('browser-mcp-launcher.mjs'));
    assert.ok(runner && opencode && launcher && browser.length > 0, '正對照：init、runner、OpenCode、MCP launcher、真 Chrome 必須同時存活');
    assert.equal(opencode.ppid, runner.pid);
    assert.equal(launcher.ppid, opencode.pid);
    for (const row of browser) {
      let ancestor = row;
      while (ancestor && ancestor.pid !== launcher.pid) ancestor = before.find(parent => parent.pid === ancestor.ppid);
      assert.ok(ancestor, '每個真 Chrome 都必須是 launcher descendant');
    }
    for (const row of browser) assert.notEqual(identity(row.pid)?.state, 'Z');
    const cgroup = readFileSync(`/proc/${init.pid}/cgroup`, 'utf8').trim().split(':').at(-1);
    cgroupPath = join('/sys/fs/cgroup', cgroup, 'cgroup.procs');
    const initialCgroup = cgroupMembers(cgroupPath);
    assert.ok(initialCgroup.exists, 'cgroup 取數路徑必須存在');
    const initialCgroupPids = initialCgroup.pids;
    for (const pid of initialCgroupPids) {
      const row = identity(pid);
      if (row) tracked.set(`${row.pid}:${row.starttime}`, row);
    }
    assert.ok(browser.every(row => initialCgroupPids.includes(row.pid)), 'cgroup 正對照必須包含真 Chrome');
    if (mode === 'deadline-force') {
      const nsPid = readFileSync(`/proc/${runner.pid}/status`, 'utf8').match(/^NSpid:\s+(.+)$/m)[1].trim().split(/\s+/).at(-1);
      docker(['exec', name, '/bin/sh', '-c', `kill -STOP ${nsPid}`]);
      assert.equal(identity(runner.pid)?.state, 'T', '注入 SIGSTOP 必須真的凍結 runner');
    }
    const seconds = mode === 'sigterm' ? '10' : '2';
    stopCommand = ['docker', 'stop', '--time', seconds, name];
    const started = Date.now();
    docker(stopCommand.slice(1), 20000);
    const durationMs = Date.now() - started;
    for (let second = 0; second <= 15; second++) {
      const remaining = [...tracked.values()].map(row => identity(row.pid)).filter(row => row && tracked.has(`${row.pid}:${row.starttime}`));
      const { exists: cgroupExists, pids: cgroupPids } = cgroupMembers(cgroupPath);
      for (const pid of cgroupPids) {
        const row = identity(pid);
        if (row) tracked.set(`${row.pid}:${row.starttime}`, row);
      }
      samples.push({ second, remaining, live: remaining.filter(row => row.state !== 'Z').length, zombies: remaining.filter(row => row.state === 'Z').length, cgroupExists, cgroupPids });
      if (second < 15) await wait(1000);
    }
    inspection = JSON.parse(docker(['inspect', name]))[0];
    events = docker(['events', '--since', String(since), '--until', String(Math.ceil(Date.now() / 1000)), '--filter', `container=${id}`, '--format', '{{json .}}']);
    writeFileSync(join(directory, `scn008-${mode}-${label}-events.jsonl`), events);
    const parsedEvents = events.trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(parsedEvents.some(event => event.Action === 'kill' && event.Actor.Attributes.signal === '15'), '必須真實送 SIGTERM');
    if (mode === 'deadline-force') {
      assert.ok(durationMs >= 1900, '必須等候 graceful deadline');
      assert.ok(parsedEvents.some(event => event.Action === 'kill' && event.Actor.Attributes.signal === '9'), 'deadline 後必須真實 SIGKILL');
      assert.equal(inspection.State.ExitCode, 137);
    } else {
      assert.ok(!parsedEvents.some(event => event.Action === 'kill' && event.Actor.Attributes.signal === '9'), '正常 SIGTERM 不得靠 deadline SIGKILL 通過');
      assert.match(docker(['logs', name]), /shutdown signal=SIGTERM terminatedChildren=[1-9][0-9]*/);
      assert.equal(inspection.State.ExitCode, 0);
    }
    assert.equal(inspection.State.Running, false);
    assert.ok(samples.every(sample => sample.remaining.length === 0 && sample.cgroupPids.length === 0), '宿主 PID 身分與整個 cgroup 不得留下存活或 Z');
    const diff = docker(['diff', name]);
    writeFileSync(join(directory, `scn008-${mode}-${label}-diff.log`), diff);
    records.push({ scn: 'SCN-008', date: '2026-10-05', mode, name, containerId: id, image, versions, command: ['docker', ...args], stopCommand, durationMs, positiveControl: { runner, opencode, launcher, chrome: browser, cgroupPath, initialCgroupPids }, tracked: [...tracked.values()], samples, exitCode: inspection.State.ExitCode, init: inspection.HostConfig.Init, persistentMounts: inspection.Mounts, writableLayerProfileRemains: /\/tmp\/tnb-/.test(diff), passed: true });
  } catch (error) {
    failure = error.message;
    records.push({ scn: 'SCN-008', date: '2026-10-05', mode, name, containerId: id, image, command: ['docker', ...args], before, tracked: [...tracked.values()], samples, failure, passed: false });
    try { docker(['stop', '--time', '2', name], 20000); } catch { /* 2026-10-05：失敗容器保留，不刪除。 */ }
  }
  writeFileSync(join(directory, `scn008-${mode}-${label}.jsonl`), docker(['logs', name]));
  writeFileSync(join(directory, `scn008-${label}-summary.json`), JSON.stringify({ observerControls, codeHashes, records }, null, 2) + '\n');
  console.log(JSON.stringify({ mode, passed: records.at(-1).passed, failure, summary: `scn008-${label}-summary.json` }));
  if (failure) { process.exitCode = 1; break; }
}
