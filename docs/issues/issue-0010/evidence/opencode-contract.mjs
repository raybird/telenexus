import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { snapshot } from './proc-observer.mjs';

// 2026-10-04：無正式認證的假 provider 只決定工具呼叫，答案必須來自真實工具結果。
setInterval(() => {}, 1000);
const mode = process.argv[2] ?? 'dynamic';
// 2026-10-04：Chrome SingletonSocket 路徑有長度上限，probe root 使用短前綴。
const root = mkdtempSync(join(tmpdir(), 'i10-'));
let calls = 0;
let verified = false;
let pendingKill = false;
let stalledNavigation = false;
let mergeVerified = false;
const server = createServer(async (request, response) => {
  if (request.method === 'GET') {
    if (mode === 'navigationtimeout' && request.url === '/dynamic') {
      stalledNavigation = true;
      console.log(JSON.stringify({ event: 'navigation-stalled', url: request.url }));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/static' ? '<main>ISSUE10_HTTP_BODY_20261004</main>' : '<main id="body">WAITING</main><script>document.querySelector("#body").textContent="ISSUE10_JS_BODY_20261004"</script>');
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const tools = body.tools ?? [];
  console.log(JSON.stringify({ event: 'provider-request', path: request.url, stream: body.stream, toolNames: tools.map(tool => tool.function.name), messages: body.messages }));
  let delta;
  let finish = 'stop';
  if (tools.length === 0) delta = { role: 'assistant', content: 'Issue 10 isolated probe' };
  else {
    assert.ok(tools.some(tool => tool.function.name === 'memory_merge_sentinel'), '既有 memory MCP 必須保留於真 OpenCode 工具清單');
    mergeVerified = true;
    const staticMode = mode === 'static';
    const failedMode = mode === 'startupfail' || mode === 'navigationtimeout';
    if (mode === 'upstreamfail' && calls >= 1) {
      console.log(JSON.stringify({ event: 'upstream-failure', status: 401 }));
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'ISSUE10_INJECTED_PROVIDER_FAILURE', type: 'authentication_error' } }));
      return;
    }
    const wanted = staticMode ? 'webfetch' : calls === 0 ? 'navigate' : 'evaluate';
    const tool = tools.find(item => item.function.name === wanted || item.function.name.endsWith(`_${wanted}`));
    const maxCalls = staticMode || failedMode ? 1 : 2;
    if (calls < maxCalls) {
      assert.ok(tool, `真 OpenCode tools 必須有 ${wanted}`);
      const args = wanted === 'webfetch' ? { url: fixtureUrl, format: 'text' } : wanted === 'navigate' ? { url: fixtureUrl } : { script: 'JSON.stringify({body:document.querySelector("#body").textContent,url:location.href})' };
      calls++;
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: `probe-call-${calls}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] };
      finish = 'tool_calls';
    } else {
      const content = JSON.stringify(body.messages.filter(message => message.role === 'tool'));
      const expected = staticMode ? 'ISSUE10_HTTP_BODY_20261004' : 'ISSUE10_JS_BODY_20261004';
      if (failedMode) assert.match(content, mode === 'startupfail' ? /not found|executable|ENOENT|does not exist|Could not find/i : /timed out|timeout/i, '必須讀到預期真工具失敗原因，非其他環境錯誤');
      else {
        assert.ok(content.includes(expected), '正文必須出現在真 OpenCode tool 回傳');
        assert.ok(staticMode || content.includes(fixtureUrl), 'JS tool 回傳必須有實際 URL');
      }
      verified = true;
      console.log(JSON.stringify({ event: 'tool-result-verified', expected, fixtureUrl }));
      if (mode === 'groupkill' || mode === 'pidkill' || mode === 'cancel') {
        const rows = snapshot();
        const owner = rows.find(row => row.pid === client.pid);
        const launcher = rows.find(row => row.argv.includes('/probe/task-owned-launcher.mjs'));
        assert.ok(owner && launcher && owner.pgid === client.pid && launcher.pgid !== owner.pgid, '真 OpenCode launcher 必須有獨立 PGID');
        console.log(JSON.stringify({ event: 'kill-boundary', owner, launcher }));
        pendingKill = true;
        process.kill(mode === 'pidkill' ? client.pid : -owner.pgid, mode === 'cancel' ? 'SIGTERM' : 'SIGKILL');
        console.log(JSON.stringify({ event: 'client-killed', mode, pid: client.pid }));
        response.destroy();
        return;
      }
      const actualCalls = body.messages.flatMap(message => message.tool_calls ?? []);
      const sourceCall = actualCalls.find(call => call.function.name.endsWith(staticMode ? 'webfetch' : 'navigate'));
      const sourceUrl = JSON.parse(sourceCall.function.arguments).url;
      assert.equal(sourceUrl, fixtureUrl);
      delta = { role: 'assistant', content: `${failedMode ? '無法完成讀取' : '已驗證工具回傳'}：${content}\n來源：${sourceUrl}` };
    }
  }
  const common = { id: `probe-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'contract' };
  if (body.stream) {
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } else {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: delta, finish_reason: finish }] }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const fixtureUrl = `${base}/${mode === 'static' ? 'static' : 'dynamic'}`;
const chromeLaunchLog = join(root, 'chrome-launch.log');
const chromeExecutable = join(root, 'chrome-executable');
writeFileSync(chromeExecutable, '#!/bin/sh\nprintf "launched\\n" >> "$ISSUE10_BROWSER_LAUNCH_LOG"\nexec /home/node/.agent-browser/browsers/chrome-154.0.8037.92/chrome "$@"\n', { mode: 0o700 });
const config = {
  provider: { probe: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${base}/v1`, apiKey: 'probe-only' }, models: { contract: { name: 'Contract probe', limit: { context: 32768, output: 4096 } } } } },
  model: 'probe/contract',
  mcp: { browser: { type: 'local', command: ['setsid', 'node', '/probe/task-owned-launcher.mjs', '/opt/issue10-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js', '--headless', '--isolated', '--slim', '--no-usage-statistics', '--no-performance-crux', `--executable-path=${mode === 'startupfail' ? join(root, 'missing-chrome') : chromeExecutable}`, '--chrome-arg=--no-sandbox', '--chrome-arg=--disable-dev-shm-usage', '--chrome-arg=--enable-logging', `--chrome-arg=--log-file=${join(root, 'chrome-debug.log')}`], timeout: 20000 } },
};
for (const name of ['config', 'cache', 'data', 'state', 'workspace']) mkdirSync(join(root, name));
mkdirSync(join(root, 'config', 'opencode'));
const existingConfigPath = join(root, 'config', 'opencode', 'opencode.json');
const existingConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { memory: { type: 'local', command: ['node', '/probe/memory-mcp-fixture.mjs'] } } });
writeFileSync(existingConfigPath, existingConfig);
const baseline = new Set(snapshot().map(row => `${row.pid}:${row.starttime}`));
const client = spawn('opencode', ['run', '--format', 'json', '--model', 'probe/contract', `使用工具讀取 ${fixtureUrl}`], {
  cwd: join(root, 'workspace'), detached: true,
  env: { ...process.env, ISSUE10_BROWSER_LAUNCH_LOG: chromeLaunchLog, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(JSON.stringify({ event: 'start', mode, root, fixtureUrl, pid: client.pid, config }));
let stdout = '';
client.stdout.on('data', data => { stdout += data; console.log(JSON.stringify({ event: 'opencode-output', text: String(data) })); });
client.stderr.on('data', data => console.log(JSON.stringify({ event: 'opencode-stderr', text: String(data) })));
const tracked = new Map();
function profiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const path = join(dir, entry.name);
    return entry.name.includes('profile') ? [path] : profiles(path);
  });
}
function sample(second) {
  const rows = snapshot();
  for (const row of rows) if (!baseline.has(`${row.pid}:${row.starttime}`)) tracked.set(`${row.pid}:${row.starttime}`, row);
  const owned = rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`));
  const foundProfiles = profiles(root);
  const launcherRoots = readdirSync(root).filter(name => name.startsWith('launcher-owned-'));
  console.log(JSON.stringify({ event: 'sample', second, owned, liveCount: owned.filter(row => row.state !== 'Z').length, zombieCount: owned.filter(row => row.state === 'Z').length, profiles: foundProfiles, launcherRoots }));
  return { owned, profiles: foundProfiles, launcherRoots };
}
const sampler = setInterval(() => sample('running'), 1000);
const timeout = setTimeout(() => { process.kill(-client.pid, 'SIGKILL'); console.log(JSON.stringify({ event: 'probe-timeout' })); }, 90000);
const exit = await new Promise(resolve => client.on('exit', (code, signal) => resolve({ code, signal })));
clearTimeout(timeout);
clearInterval(sampler);
console.log(JSON.stringify({ event: 'opencode-exit', ...exit, pendingKill }));
let final;
for (let second = 0; second <= 15; second++) {
  final = sample(second);
  if (second < 15) await new Promise(resolve => setTimeout(resolve, 1000));
}
const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const finalText = events.filter(event => event.type === 'text').map(event => event.part.text).join('\n');
const chromeLaunches = existsSync(chromeLaunchLog) ? readFileSync(chromeLaunchLog, 'utf8').trim().split('\n').length : 0;
if (mode === 'static' || mode === 'dynamic') {
  const expected = mode === 'static' ? 'ISSUE10_HTTP_BODY_20261004' : 'ISSUE10_JS_BODY_20261004';
  assert.ok(finalText.includes(expected) && finalText.includes(fixtureUrl), '最終 OpenCode 文字必須含真正文與來源');
  assert.equal(chromeLaunches, mode === 'static' ? 0 : 1, 'browser executable 啟動事件必須符合路徑');
}
if (mode === 'startupfail' || mode === 'navigationtimeout') assert.ok(finalText.includes('無法完成讀取') && !finalText.includes('ISSUE10_JS_BODY_20261004'), '失敗不能假裝取得正文');
if (mode === 'navigationtimeout') assert.ok(stalledNavigation, '導覽必須真實送達刻意阻塞的 fixture');
if (mode === 'upstreamfail') assert.ok(events.some(event => event.type === 'error') && !finalText.includes('ISSUE10_JS_BODY_20261004'), '上游失敗需真 error 事件');
assert.ok(mergeVerified && readFileSync(existingConfigPath, 'utf8') === existingConfig, 'runtime browser 設定不得覆寫既有 MCP 檔案');
console.log(JSON.stringify({ event: 'measurement-complete', verified, mergeVerified, calls, finalText, chromeLaunches, cleanupPassed: final.owned.length === 0 && final.profiles.length === 0 && final.launcherRoots.length === 0, observerStillAlive: true }));
server.close();
