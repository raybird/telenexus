import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { snapshot } from './proc-observer.mjs';

// 2026-10-04：SCN-004 真 local／runner 並行；假 provider 只選工具，不提供 fixture 答案。
// cancelTarget=runner 可重現 HTTP 斷線未取消工作；未實作 signal 傳遞前應紅燈。
setInterval(() => {}, 1000);
const [entry = 'structured', lane = 'interactive', cancelTarget = 'local'] = process.argv.slice(2);
assert.ok(['structured', 'stream'].includes(entry) && ['interactive', 'scheduled'].includes(lane));
assert.ok(['local', 'runner'].includes(cancelTarget));
const root = mkdtempSync('/tmp/i10rc-');
const emit = value => console.log(JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const states = { A: { calls: 0, ready: false }, B: { calls: 0, ready: false } };
const held = [];
let fixtureError;
let releaseB;
const bReleased = new Promise(resolve => { releaseB = resolve; });
let base;
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      const owner = request.url === '/a' ? 'A' : 'B';
      response.setHeader('Content-Type', 'text/html');
      response.end(`<main id="body">WAITING</main><script>document.querySelector('#body').textContent=${JSON.stringify(`ISSUE10_PRODUCT_CONCURRENT_${owner}`)}</script>`);
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const tools = body.tools ?? [];
    const owner = JSON.stringify(body.messages).includes(`${base}/a`) ? 'A' : 'B';
    const state = states[owner];
    let delta;
    let finish = 'stop';
    if (!tools.length) delta = { role: 'assistant', content: 'Issue 10 concurrency probe' };
    else {
      assert.ok(tools.some(tool => tool.function.name === 'memory_merge_sentinel'), '既有 memory MCP 必須可用');
      const url = `${base}/${owner.toLowerCase()}`;
      emit({ event: 'provider-request', owner, calls: state.calls, toolNames: tools.map(tool => tool.function.name) });
      if (state.calls === 2) {
        const content = JSON.stringify(body.messages.filter(message => message.role === 'tool'));
        assert.ok(content.includes(`owner=${owner}`) && !content.includes(`owner=${owner === 'A' ? 'B' : 'A'}`));
        assert.ok(content.includes(`ISSUE10_PRODUCT_CONCURRENT_${owner}`) && content.includes(url), '正文、cookie、URL 必須來自真 browser');
        state.ready = true;
        emit({ event: 'browser-ready', owner, url, content });
        if (owner === 'A') { held.push(response); return; }
        await bReleased;
      }
      if (state.calls < 3) {
        const name = state.calls === 0 ? 'telenexus_browser_navigate' : 'telenexus_browser_evaluate';
        assert.ok(tools.some(tool => tool.function.name === name));
        const read = 'JSON.stringify({cookie:document.cookie,body:document.querySelector("#body").textContent,url:location.href})';
        const args = state.calls === 0 ? { url } : { script: state.calls === 1 ? `document.cookie="owner=${owner}; Path=/"; ${read}` : read };
        state.calls++;
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: `rc-${owner}-${state.calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
        finish = 'tool_calls';
      } else {
        const latest = body.messages.filter(message => message.role === 'tool').at(-1);
        const content = JSON.stringify(latest);
        assert.ok(content.includes('owner=B') && !content.includes('owner=A') && content.includes('ISSUE10_PRODUCT_CONCURRENT_B') && content.includes(url), 'A 收尾後 B 必須再次取得自己的 cookie／正文／URL');
        state.verified = true;
        delta = { role: 'assistant', content: `工具實際結果：${content}\n來源：${url}` };
        emit({ event: 'b-survived-a-cleanup', verified: true, url });
      }
    }
    const common = { id: `rc-${owner}-${state.calls}`, object: 'chat.completion.chunk', created: 1, model: 'contract' };
    if (body.stream) {
      response.setHeader('Content-Type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: delta, finish_reason: finish }] }));
    }
  } catch (error) {
    fixtureError = error.message;
    emit({ event: 'fixture-error', message: fixtureError });
    response.writeHead(500); response.end(fixtureError);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
for (const name of ['config', 'cache', 'data', 'state', 'local', 'runner']) mkdirSync(join(root, name));
for (const name of ['local', 'runner']) {
  mkdirSync(join(root, name, 'workspace'));
  mkdirSync(join(root, name, 'data'));
  writeFileSync(join(root, name, 'ai-config.yaml'), 'provider: opencode\nmodel: probe/contract\n');
}
mkdirSync(join(root, 'config', 'opencode'));
const existingConfigPath = join(root, 'config', 'opencode', 'opencode.json');
const existingConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { memory: { type: 'local', command: ['node', '/probe/memory-mcp-fixture.mjs'] } } });
writeFileSync(existingConfigPath, existingConfig);
const config = { provider: { probe: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${base}/v1`, apiKey: 'fixture-only' }, models: { contract: { name: 'Runner concurrency fixture', limit: { context: 32768, output: 4096 } } } } }, model: 'probe/contract' };
const sharedEnv = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_TASK_TIMEOUT_MS: '90000', TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') };
const runnerPort = 19110;
const runner = spawn('node', ['/app/dist/runner.js'], { cwd: join(root, 'runner'), detached: true, env: { ...sharedEnv, APP_PROJECT_DIR: join(root, 'runner'), RUNNER_PORT: String(runnerPort), RUNNER_SHARED_SECRET: 'issue10-fixture-secret', MODEL_HEALTH_CHECK_ENABLED: 'false', RUNNER_STATUS_PATH: join(root, 'runner', 'status.md'), RUNNER_AUDIT_PATH: join(root, 'runner', 'audit.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
runner.stdout.on('data', data => emit({ event: 'runner-output', text: String(data) }));
runner.stderr.on('data', data => emit({ event: 'runner-stderr', text: String(data) }));
const startupDeadline = Date.now() + 20000;
while (true) {
  assert.ok(Date.now() < startupDeadline && runner.exitCode === null, 'runner 必須健康啟動');
  try { const response = await fetch(`http://127.0.0.1:${runnerPort}/health`); if (response.ok) break; } catch { /* 啟動前連線拒絕可重試。 */ }
  await wait(100);
}
const runnerIdentity = snapshot().find(row => row.pid === runner.pid);
assert.ok(runnerIdentity);
const baseline = new Set(snapshot().map(row => `${row.pid}:${row.starttime}`));
let runnerRequest;
let runnerRaw = '';
const runnerPromise = new Promise((resolve, reject) => {
  const payload = JSON.stringify({ task: 'chat', input: `使用工具讀取 ${base}/${cancelTarget === 'runner' ? 'a' : 'b'}`, provider: 'opencode', model: 'probe/contract', forceNewSession: true, lane, requestId: 'issue10-runner-concurrent' });
  runnerRequest = httpRequest({ hostname: '127.0.0.1', port: runnerPort, path: entry === 'stream' ? '/run/stream' : '/run', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-runner-token': 'issue10-fixture-secret' } }, response => {
    response.setEncoding('utf8');
    response.on('data', chunk => { runnerRaw += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, raw: runnerRaw }));
    response.on('aborted', () => resolve({ aborted: true, raw: runnerRaw }));
    response.on('error', reject);
  });
  runnerRequest.on('error', error => cancelTarget === 'runner' && error.message === 'ISSUE10_CANCEL_RUNNER' ? resolve({ aborted: true }) : reject(error));
  runnerRequest.end(payload);
});
const local = spawn('node', ['/probe/product-dynamic-client.mjs', entry, `${base}/${cancelTarget === 'local' ? 'a' : 'b'}`, join(root, 'local', 'ai-config.yaml'), 'interactive'], { cwd: join(root, 'local'), detached: true, env: { ...sharedEnv, APP_PROJECT_DIR: join(root, 'local') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let localRaw = '';
local.stdout.on('data', data => { localRaw += data; emit({ event: 'local-output', text: String(data) }); });
local.stderr.on('data', data => emit({ event: 'local-stderr', text: String(data) }));
const localPromise = new Promise(resolve => local.on('close', (code, signal) => resolve({ code, signal })));
const tracked = new Map();
const rootOwners = new Map();
const browserSeen = new Set();
function observe() {
  const rows = snapshot();
  for (const row of rows) {
    const id = `${row.pid}:${row.starttime}`;
    if (baseline.has(id)) continue;
    tracked.set(id, row);
    try { row.exe = readlinkSync(`/proc/${row.pid}/exe`); } catch { row.exe = null; }
    if (row.exe === '/opt/telenexus/chrome/chrome-linux64/chrome') browserSeen.add(id);
    if (row.argv.split(' ').includes('/usr/local/lib/telenexus/browser-mcp-launcher.mjs')) {
      try {
        const env = readFileSync(`/proc/${row.pid}/environ`, 'utf8').split('\0');
        const project = env.find(item => item.startsWith('APP_PROJECT_DIR='));
        const owner = project === `APP_PROJECT_DIR=${join(root, 'local')}` ? (cancelTarget === 'local' ? 'A' : 'B') : (cancelTarget === 'runner' ? 'A' : 'B');
        const children = rows.filter(child => child.ppid === row.pid);
        for (const child of children) {
          const childEnv = readFileSync(`/proc/${child.pid}/environ`, 'utf8').split('\0');
          const ownedRoot = childEnv.find(item => item.startsWith('TMPDIR=/tmp/tnb-'))?.slice(7);
          if (ownedRoot) rootOwners.set(ownedRoot, owner);
        }
      } catch { /* 退出競態；後續樣本仍須取得兩個 root 才能通過。 */ }
    }
  }
  return rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`));
}
function profilePaths(directory) {
  try { return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? item.name.includes('profile') ? [join(directory, item.name)] : profilePaths(join(directory, item.name)) : []); } catch { return []; }
}
function sample(second) {
  const owned = observe();
  const roots = readdirSync('/tmp').filter(name => name.startsWith('tnb-')).map(name => join('/tmp', name));
  const profiles = roots.flatMap(profilePaths);
  const result = { owned, roots, profiles, liveCount: owned.filter(row => row.state !== 'Z').length, zombieCount: owned.filter(row => row.state === 'Z').length };
  emit({ event: 'sample', second, ...result });
  return result;
}
const watcher = setInterval(observe, 50);
const sampler = setInterval(() => sample('running'), 1000);
emit({ event: 'start', entry, lane, cancelTarget, root, runnerPid: runner.pid, localPid: local.pid, fixtureOrigin: base });
const readyDeadline = Date.now() + 90000;
while (!states.A.ready || !states.B.ready) {
  assert.ok(!fixtureError && Date.now() < readyDeadline, fixtureError || '兩個真 browser 未就緒');
  await wait(100);
}
observe();
assert.equal([...rootOwners.values()].filter(owner => owner === 'A').length, 1, 'A 須有獨立工作 root');
assert.equal([...rootOwners.values()].filter(owner => owner === 'B').length, 1, 'B 須有獨立工作 root');
emit({ event: 'isolated-before-cancel', rootOwners: [...rootOwners] });
if (cancelTarget === 'local') local.send({ action: 'cancel' });
else runnerRequest.destroy(new Error('ISSUE10_CANCEL_RUNNER'));
await Promise.race([cancelTarget === 'local' ? localPromise : runnerPromise, wait(15000).then(() => { throw new Error('取消入口未於 15 秒內結束'); })]);
clearInterval(sampler);
for (let second = 0; second <= 15; second++) {
  sample(`a-cleanup-${second}`);
  if (second < 15) await wait(1000);
}
const aRoot = [...rootOwners].find(([, owner]) => owner === 'A')[0];
const bRoot = [...rootOwners].find(([, owner]) => owner === 'B')[0];
assert.ok(!readdirSync('/tmp').includes(aRoot.slice('/tmp/'.length)), '取消 A 必須清除自己的 root；runner 斷線未傳 signal 應在此紅燈');
assert.ok(readdirSync('/tmp').includes(bRoot.slice('/tmp/'.length)), 'B 的 root 必須仍存活');
releaseB();
const [localExit, runnerResult] = await Promise.race([Promise.all([localPromise, runnerPromise]), wait(90000).then(() => { throw new Error('B 未完成'); })]);
emit({ event: 'client-results', localExit, localRaw, runnerResult });
assert.ok(states.B.verified && !fixtureError, fixtureError || 'B 必須在 A 收尾後再取真正文');
if (cancelTarget === 'local') {
  assert.match(localRaw, /中止|取消/);
  assert.ok(runnerResult.status === 200 && runnerResult.raw.includes('ISSUE10_PRODUCT_CONCURRENT_B') && runnerResult.raw.includes(`${base}/b`));
} else assert.ok(localRaw.includes('ISSUE10_PRODUCT_CONCURRENT_B') && localRaw.includes(`${base}/b`));
let final;
for (let second = 0; second <= 15; second++) {
  final = sample(`final-${second}`);
  if (second < 15) await wait(1000);
}
clearInterval(watcher);
const stillRunning = snapshot().some(row => row.pid === runnerIdentity.pid && row.starttime === runnerIdentity.starttime);
assert.ok(stillRunning && browserSeen.size > 0, '測量時 runner 與觀測器仍存活，且真的啟動 Chrome');
assert.equal(readFileSync(existingConfigPath, 'utf8'), existingConfig, '共享 memory MCP 檔案不可改寫');
emit({ event: 'measurement-complete', entry, lane, cancelTarget, scn: 'SCN-004', verified: states.B.verified, mergeVerified: true, browserObserved: browserSeen.size, runnerStillAlive: stillRunning, cleanupPassed: final.owned.length === 0 && final.roots.length === 0 && final.profiles.length === 0, observerStillAlive: true });
// 2026-10-04：完成且保存終態後才停止測試 runner；不能用服務退出製造 cleanup 綠燈。
runner.kill('SIGTERM');
for (const response of held) response.destroy();
server.close();
