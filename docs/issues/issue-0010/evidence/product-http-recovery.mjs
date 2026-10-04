import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseStat, snapshot } from './proc-observer.mjs';

// 2026-10-04：同容器、同設定先真 JS 失敗再真 HTTP 成功；不替產品注入 browser MCP。
setInterval(() => {}, 1000);
const emit = value => console.log(JSON.stringify(value));
const chromeBinary = '/opt/telenexus/chrome/chrome-linux64/chrome';
emit({ event: 'startupfail-fixture-ready', chromeBinary });
const faultDeadline = Date.now() + 30000;
while (existsSync(chromeBinary)) {
  assert.ok(Date.now() < faultDeadline, '必須先於本測試容器注入 Chrome binary 缺少故障');
  await new Promise(resolve => setTimeout(resolve, 100));
}
const root = mkdtempSync('/tmp/i10r-');
for (const name of ['config', 'cache', 'data', 'state', 'workspace']) mkdirSync(join(root, name));
mkdirSync(join(root, 'config', 'opencode'));
const configPath = join(root, 'config', 'opencode', 'opencode.json');
const originalConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { memory: { type: 'local', command: ['node', '/probe/memory-mcp-fixture.mjs'] } } });
writeFileSync(configPath, originalConfig);
let phase;
let calls;
let toolVerified;
let memoryVerified;
let fixtureError;
let fixtureUrl;
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html');
      response.end(request.url === '/static' ? '<main>ISSUE10_RECOVERY_HTTP_BODY_20261004</main>' : '<main id="body">WAITING</main><script>document.querySelector("#body").textContent="ISSUE10_RECOVERY_JS_BODY_20261004"</script>');
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const tools = body.tools ?? [];
    emit({ event: 'provider-request', phase, tools: tools.map(tool => tool.function.name), messages: body.messages });
    let delta;
    let finish = 'stop';
    if (!tools.length) delta = { role: 'assistant', content: 'Product HTTP recovery probe' };
    else {
      assert.ok(tools.some(tool => tool.function.name === 'memory_merge_sentinel'), '既有 memory MCP 必須保留');
      memoryVerified = true;
      const wanted = phase === 'js-failure' ? 'telenexus_browser_navigate' : 'webfetch';
      if (calls === 0) {
        assert.ok(tools.some(tool => tool.function.name === wanted), `真產品必須提供 ${wanted}`);
        calls++;
        const argumentsValue = phase === 'js-failure' ? { url: fixtureUrl } : { url: fixtureUrl, format: 'text' };
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: `recovery-${phase}`, type: 'function', function: { name: wanted, arguments: JSON.stringify(argumentsValue) } }] };
        finish = 'tool_calls';
      } else {
        const content = JSON.stringify(body.messages.filter(message => message.role === 'tool'));
        if (phase === 'js-failure') {
          assert.ok(content.includes(`Browser was not found at the configured executablePath (${chromeBinary})`), '首次必須是真 binary 缺少工具錯誤');
          assert.ok(!content.includes('ISSUE10_RECOVERY_JS_BODY_20261004'), 'JS 失敗不能偽造正文');
        } else assert.ok(content.includes('ISSUE10_RECOVERY_HTTP_BODY_20261004'), '後續正文必須來自真 webfetch tool result');
        const sourceCall = body.messages.flatMap(message => message.tool_calls ?? []).find(call => call.function.name === wanted);
        assert.equal(JSON.parse(sourceCall.function.arguments).url, fixtureUrl);
        toolVerified = true;
        emit({ event: 'tool-result-verified', phase, content, source: fixtureUrl, chromeMissing: !existsSync(chromeBinary) });
        delta = { role: 'assistant', content: `${phase === 'js-failure' ? '無法完成讀取' : '已驗證工具回傳'}：${content}\n來源：${fixtureUrl}` };
      }
    }
    const common = { id: `recovery-${phase}`, object: 'chat.completion.chunk', created: 1, model: 'contract' };
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
    emit({ event: 'fixture-error', phase, message: fixtureError });
    response.writeHead(500);
    response.end(fixtureError);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const config = { provider: { probe: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${base}/v1`, apiKey: 'probe-only' }, models: { contract: { name: 'Recovery contract', limit: { context: 32768, output: 4096 } } } } }, model: 'probe/contract' };
assert.ok(!Object.hasOwn(config, 'mcp'), 'fixture 不得注入 browser MCP');
const environment = { ...process.env, APP_PROJECT_DIR: root, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_TASK_TIMEOUT_MS: '90000', TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') };
const summaries = [];
for (phase of ['js-failure', 'http-recovery']) {
  calls = 0;
  toolVerified = false;
  memoryVerified = false;
  assert.ok(!existsSync(chromeBinary), '兩個工作都必須維持同一 binary 缺少條件');
  fixtureUrl = `${base}/${phase === 'js-failure' ? 'dynamic' : 'static'}`;
  const baseline = new Set(snapshot().map(row => `${row.pid}:${row.starttime}`));
  const tracked = new Set();
  const chromeIdentities = new Set();
  function observe() {
    const rows = snapshot();
    for (const row of rows) if (!baseline.has(`${row.pid}:${row.starttime}`)) {
      tracked.add(`${row.pid}:${row.starttime}`);
      try {
        row.exe = readlinkSync(`/proc/${row.pid}/exe`);
        if (parseStat(readFileSync(`/proc/${row.pid}/stat`, 'utf8')).starttime !== row.starttime) continue;
        if (row.exe === chromeBinary && !chromeIdentities.has(`${row.pid}:${row.starttime}`)) {
          chromeIdentities.add(`${row.pid}:${row.starttime}`);
          emit({ event: 'browser-observed', phase, ...row });
        }
      } catch { row.exe = null; }
    }
    return rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`));
  }
  function sample(second) {
    const owned = observe();
    const roots = readdirSync('/tmp').filter(name => name.startsWith('tnb-')).map(name => join('/tmp', name));
    const profiles = roots.flatMap(directory => {
      try { return readdirSync(directory).filter(name => name.includes('profile')).map(name => join(directory, name)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    });
    const value = { event: 'sample', phase, second, owned, liveCount: owned.filter(row => row.state !== 'Z').length, zombieCount: owned.filter(row => row.state === 'Z').length, profiles, launcherRoots: roots };
    emit(value);
    return value;
  }
  const client = spawn('node', ['/probe/product-agent-client.mjs', 'structured', fixtureUrl, 'interactive'], { cwd: root, detached: true, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  emit({ event: 'work-start', phase, root, fixtureUrl, clientPid: client.pid, chromeMissing: !existsSync(chromeBinary) });
  let stdout = '';
  client.stdout.on('data', data => { stdout += data; emit({ event: 'product-output', phase, text: String(data) }); });
  client.stderr.on('data', data => emit({ event: 'product-stderr', phase, text: String(data) }));
  const watcher = setInterval(observe, 50);
  const sampler = setInterval(() => sample('running'), 1000);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; process.kill(-client.pid, 'SIGKILL'); }, 110000);
  const exit = await new Promise(resolve => client.on('exit', (code, signal) => resolve({ code, signal })));
  clearTimeout(timeout);
  clearInterval(sampler);
  emit({ event: 'work-exit', phase, ...exit });
  let final;
  for (let second = 0; second <= 15; second++) {
    final = sample(second);
    if (second < 15) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  clearInterval(watcher);
  const records = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = records.findLast(record => record.event === 'product-result')?.result;
  assert.ok(!fixtureError && !timedOut && toolVerified && memoryVerified, fixtureError || '真工具／memory 契約必須驗證成功');
  assert.equal(exit.code, 0);
  assert.ok(result && result.text.includes(fixtureUrl), '產品文字必須保留來源');
  if (phase === 'js-failure') assert.ok(result.text.includes('Browser was not found') && !result.text.includes('ISSUE10_RECOVERY_JS_BODY_20261004'), '第一次工作如實失敗');
  else assert.ok(result.text.includes('ISSUE10_RECOVERY_HTTP_BODY_20261004'), '同環境後續 HTTP 必須成功');
  assert.ok(!existsSync(chromeBinary), '後續 HTTP 成功不是偷偷恢復 Chrome');
  assert.equal(chromeIdentities.size, 0, '缺少 binary 的兩工作都不能啟動 Chrome');
  assert.equal(readFileSync(configPath, 'utf8'), originalConfig, 'memory MCP 檔案 byte-identical');
  const cleanupPassed = final.owned.length === 0 && final.profiles.length === 0 && final.launcherRoots.length === 0;
  assert.ok(cleanupPassed, '每工作 15 秒內 live／Z／profile／launcher root 均須零');
  const summary = { event: 'work-complete', phase, toolVerified, memoryVerified, chromeMissing: true, browserObserved: chromeIdentities.size, cleanupPassed, finalText: result.text, root, fixtureUrl };
  summaries.push(summary);
  emit(summary);
}
emit({ event: 'measurement-complete', sameContainer: true, sameRoot: root, sameEnvironment: true, chromeMissing: !existsSync(chromeBinary), works: summaries, cleanupPassed: summaries.every(value => value.cleanupPassed), observerStillAlive: true });
server.close();
