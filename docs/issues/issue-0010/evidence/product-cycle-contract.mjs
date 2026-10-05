import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseStat, snapshot } from './proc-observer.mjs';

// 2026-10-04：同一存活容器與觀測器連續 45 工作，不以重建容器隱藏累積。
const emit = value => console.log(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = '/opt/telenexus/chrome/chrome-linux64/chrome';
const root = mkdtempSync('/tmp/i10c-');
for (const name of ['config', 'cache', 'data', 'state', 'workspace']) mkdirSync(join(root, name));
mkdirSync(join(root, 'config', 'opencode'));
const configPath = join(root, 'config', 'opencode', 'opencode.json');
const originalConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { memory: { type: 'local', command: ['node', '/probe/memory-mcp-fixture.mjs'] } } });
writeFileSync(configPath, originalConfig);
const baselineRows = snapshot();
const baseline = new Set(baselineRows.map(row => `${row.pid}:${row.starttime}`));
const tracked = new Set();
const cgroupPath = '/sys/fs/cgroup';
function cgroup() {
  const current = Number(readFileSync(join(cgroupPath, 'pids.current'), 'utf8').trim());
  const procs = readFileSync(join(cgroupPath, 'cgroup.procs'), 'utf8').trim().split(/\s+/).map(Number);
  assert.ok(Number.isInteger(current) && current > 0 && procs.includes(process.pid) && procs.includes(1), 'cgroup 正對照必須含觀測器與本容器 PID1');
  return { current, procs };
}
const initialCgroup = cgroup();
emit({ event: 'container-baseline', root, baselineRows, cgroup: initialCgroup, selfCgroup: readFileSync('/proc/self/cgroup', 'utf8'), cgroupMount: readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(line => line.includes(' /sys/fs/cgroup ')) });
let cycle;
let mode;
let calls;
let verified;
let memoryVerified;
let stalled;
let injected;
let client;
let fixtureUrl;
let fixtureError;
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      if (mode === 'navigationtimeout') { stalled = true; emit({ event: 'navigation-stalled', cycle, url: request.url }); return; }
      response.setHeader('Content-Type', 'text/html');
      response.end('<main id="body">WAITING</main><script>document.querySelector("#body").textContent="ISSUE10_CYCLE_JS_BODY_20261004"</script>');
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const tools = body.tools ?? [];
    emit({ event: 'provider-request', cycle, mode, toolNames: tools.map(tool => tool.function.name), messages: body.messages });
    let delta;
    let finish = 'stop';
    if (!tools.length) delta = { role: 'assistant', content: 'Product cycle probe' };
    else {
      assert.ok(tools.some(tool => tool.function.name === 'memory_merge_sentinel'), 'memory MCP 必須保留');
      memoryVerified = true;
      if (mode === 'upstreamfail' && calls >= 1) {
        emit({ event: 'upstream-failure', cycle, status: 401 });
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'ISSUE10_INJECTED_PROVIDER_FAILURE', type: 'authentication_error' } }));
        return;
      }
      const failedMode = mode === 'startupfail' || mode === 'navigationtimeout';
      const wanted = calls === 0 ? 'telenexus_browser_navigate' : 'telenexus_browser_evaluate';
      if (calls < (failedMode ? 1 : 2)) {
        assert.ok(tools.some(tool => tool.function.name === wanted), `真產品必須有 ${wanted}`);
        calls++;
        const args = wanted.endsWith('_navigate') ? { url: fixtureUrl } : { script: 'JSON.stringify({body:document.querySelector("#body").textContent,url:location.href})' };
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: `cycle-${cycle}-${calls}`, type: 'function', function: { name: wanted, arguments: JSON.stringify(args) } }] };
        finish = 'tool_calls';
      } else {
        const content = JSON.stringify(body.messages.filter(message => message.role === 'tool'));
        if (failedMode) assert.match(content, mode === 'startupfail' ? /Browser was not found at the configured executablePath/ : /timed out|timeout/i, '必須取得指定真工具故障');
        else assert.ok(content.includes('ISSUE10_CYCLE_JS_BODY_20261004') && content.includes(fixtureUrl), '正文與 URL 必須來自真工具結果');
        verified = true;
        emit({ event: 'tool-result-verified', cycle, mode, content, fixtureUrl });
        if (mode === 'cancel' || mode === 'groupkill') {
          const rows = snapshot();
          const opencode = rows.find(row => row.argv.includes('opencode') && row.argv.includes(' run '));
          const launcher = rows.find(row => row.argv.includes('/usr/local/lib/telenexus/browser-mcp-launcher.mjs'));
          assert.ok(opencode && launcher && opencode.pgid !== launcher.pgid, 'OpenCode 與 launcher PGID 必須獨立');
          emit({ event: 'kill-boundary', cycle, opencode, launcher, clientPid: client.pid });
          injected = true;
          if (mode === 'cancel') client.send({ action: 'cancel' });
          else process.kill(-opencode.pgid, 'SIGKILL');
          response.destroy();
          return;
        }
        const sourceCall = body.messages.flatMap(message => message.tool_calls ?? []).find(call => call.function.name === 'telenexus_browser_navigate');
        assert.equal(JSON.parse(sourceCall.function.arguments).url, fixtureUrl);
        delta = { role: 'assistant', content: `${failedMode ? '無法完成讀取' : '已驗證工具回傳'}：${content}\n來源：${fixtureUrl}` };
      }
    }
    const common = { id: `cycle-${cycle}`, object: 'chat.completion.chunk', created: 1, model: 'contract' };
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
    emit({ event: 'fixture-error', cycle, message: fixtureError });
    response.writeHead(500); response.end(fixtureError);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const config = { provider: { probe: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${base}/v1`, apiKey: 'probe-only' }, models: { contract: { name: 'Cycle contract', limit: { context: 32768, output: 4096 } } } } }, model: 'probe/contract' };
const environment = { ...process.env, APP_PROJECT_DIR: root, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_TASK_TIMEOUT_MS: '90000', TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') };
assert.ok(!Object.hasOwn(config, 'mcp'), '不替產品注入 browser MCP');
let browserIdentities;
function observe() {
  const rows = snapshot();
  for (const row of rows) if (!baseline.has(`${row.pid}:${row.starttime}`)) {
    tracked.add(`${row.pid}:${row.starttime}`);
    try {
      row.exe = readlinkSync(`/proc/${row.pid}/exe`);
      if (parseStat(readFileSync(`/proc/${row.pid}/stat`, 'utf8')).starttime !== row.starttime) continue;
      if (row.exe === chrome && !browserIdentities.has(`${row.pid}:${row.starttime}`)) {
        browserIdentities.add(`${row.pid}:${row.starttime}`); emit({ event: 'browser-observed', cycle, ...row });
      }
    } catch { row.exe = null; }
  }
  return rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`));
}
function profiles(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? item.name.includes('profile') ? [join(directory, item.name)] : profiles(join(directory, item.name)) : []);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function sample(second) {
  const owned = observe();
  const launcherRoots = readdirSync('/tmp').filter(name => name.startsWith('tnb-')).map(name => join('/tmp', name));
  const value = { event: 'sample', cycle, mode, second, owned, liveCount: owned.filter(row => row.state !== 'Z').length, zombieCount: owned.filter(row => row.state === 'Z').length, launcherRoots, profiles: [...profiles(root), ...launcherRoots.flatMap(profiles)], cgroup: cgroup() };
  emit(value); return value;
}
const summaries = [];
const modes = [...Array(20).fill('dynamic'), ...['startupfail', 'navigationtimeout', 'cancel', 'upstreamfail', 'groupkill'].flatMap(value => Array(5).fill(value))];
for (let index = 0; index < modes.length; index++) {
  cycle = index + 1; mode = modes[index]; calls = 0; verified = false; memoryVerified = false; stalled = false; injected = false; fixtureError = null; browserIdentities = new Set();
  if (mode === 'startupfail') {
    emit({ event: 'request-chrome-fault', cycle, chrome });
    const deadline = Date.now() + 30000;
    while (existsSync(chrome)) { assert.ok(Date.now() < deadline, '缺少 Chrome 故障握手逾時'); await delay(100); }
  } else assert.ok(existsSync(chrome), '非 startupfail 必須有正式 Chrome binary');
  const before = sample('before');
  assert.equal(before.owned.length + before.profiles.length + before.launcherRoots.length, 0, '前輪殘留不得被新 baseline 排除');
  fixtureUrl = `${base}/dynamic?cycle=${cycle}`;
  client = spawn('node', ['/probe/product-agent-client.mjs', 'structured', fixtureUrl, 'interactive'], { cwd: root, detached: true, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  emit({ event: 'work-start', cycle, mode, pid: client.pid, fixtureUrl, root, cgroupBaseline: before.cgroup });
  let stdout = '';
  client.stdout.on('data', data => { stdout += data; emit({ event: 'product-output', cycle, text: String(data) }); });
  client.stderr.on('data', data => emit({ event: 'product-stderr', cycle, text: String(data) }));
  const watcher = setInterval(observe, 50);
  const sampler = setInterval(() => sample('running'), 1000);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; process.kill(-client.pid, 'SIGKILL'); }, 110000);
  const exit = await new Promise(resolve => client.on('exit', (code, signal) => resolve({ code, signal })));
  clearTimeout(timeout); clearInterval(sampler);
  emit({ event: 'work-exit', cycle, mode, ...exit });
  let final;
  for (let second = 0; second <= 15; second++) { final = sample(second); if (second < 15) await delay(1000); }
  clearInterval(watcher);
  const records = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = records.findLast(record => record.event === 'product-result')?.result;
  const error = records.findLast(record => record.event === 'product-error')?.message;
  assert.ok(!fixtureError && !timedOut && memoryVerified, fixtureError || '工作必須符合真工具契約，不可用外層逾時替代');
  if (mode === 'groupkill') { assert.ok(injected && !result); assert.equal(exit.code, 1); assert.equal(error, 'Error calling Opencode: Process terminated with signal SIGKILL'); }
  else {
    assert.ok(result); assert.equal(exit.code, 0);
    if (mode === 'dynamic') assert.ok(verified && result.text.includes('ISSUE10_CYCLE_JS_BODY_20261004') && result.text.includes(fixtureUrl));
    if (mode === 'startupfail' || mode === 'navigationtimeout') assert.ok(verified && result.text.includes('無法完成讀取') && !result.text.includes('ISSUE10_CYCLE_JS_BODY_20261004'));
    if (mode === 'cancel') assert.ok(injected && /中止|取消/.test(result.text) && !result.text.includes('ISSUE10_CYCLE_JS_BODY_20261004'));
    if (mode === 'upstreamfail') assert.equal(result.failure?.kind, 'upstream-error');
  }
  if (mode === 'navigationtimeout') assert.ok(stalled, 'fixture 必須收到真導覽並刻意阻塞');
  assert.equal(browserIdentities.size > 0, mode !== 'startupfail', 'Chrome 程序正負對照');
  assert.equal(readFileSync(configPath, 'utf8'), originalConfig, 'memory 設定 byte-identical');
  const cleanupPassed = final.owned.length === 0 && final.profiles.length === 0 && final.launcherRoots.length === 0;
  assert.ok(cleanupPassed, '每輪 15 秒內全部工作程序／Z／profile／root 必須零');
  const summary = { event: 'cycle-complete', cycle, mode, verified, memoryVerified, cleanupPassed, browserObserved: browserIdentities.size, cgroupBaseline: before.cgroup.current, cgroupFinal: final.cgroup.current, finalText: result?.text ?? '', productError: error ?? null };
  summaries.push(summary); emit(summary);
  if (mode === 'startupfail') {
    emit({ event: 'request-chrome-restore', cycle, chrome });
    const deadline = Date.now() + 30000;
    while (!existsSync(chrome)) { assert.ok(Date.now() < deadline, 'Chrome 復原握手逾時'); await delay(100); }
  }
}
const finalCgroup = cgroup();
emit({ event: 'measurement-complete', sameContainer: true, cycles: summaries, initialCgroup, finalCgroup, cgroupTrend: summaries.map(value => ({ cycle: value.cycle, baseline: value.cgroupBaseline, final: value.cgroupFinal })), cleanupPassed: summaries.length === 45 && summaries.every(value => value.cleanupPassed), observerStillAlive: true });
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
// 2026-10-04：供 host inspect 量測時確認 PID1／容器仍存活，不停止觀測容器。
setInterval(() => {}, 1000);
