import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseStat, snapshot } from './proc-observer.mjs';

// 2026-10-04：假 provider 只選工具；正文、URL、程序及 profile 均由真產品路徑取得。
setInterval(() => {}, 1000);
const [mode = 'dynamic', entry = 'structured', lane = 'interactive'] = process.argv.slice(2);
const root = mkdtempSync(join(tmpdir(), 'i10p-'));
let client;
let fixtureUrl;
let calls = 0;
let verified = false;
let mergeVerified = false;
let stalledNavigation = false;
let injectedTermination = false;
let fixtureError;
let cleanupFaultRoot;
const emit = value => console.log(JSON.stringify(value));
if (mode === 'startupfail') {
  emit({ event: 'startupfail-fixture-ready' });
  const deadline = Date.now() + 30000;
  while (existsSync('/opt/telenexus/chrome/chrome-linux64/chrome')) {
    assert.ok(Date.now() < deadline, '測試容器 Chrome binary 缺少故障注入');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      if (mode === 'navigationtimeout' && request.url === '/dynamic') {
        stalledNavigation = true;
        emit({ event: 'navigation-stalled', url: request.url });
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
    emit({ event: 'provider-request', stream: body.stream, toolNames: tools.map(tool => tool.function.name), messages: body.messages });
    let delta;
    let finish = 'stop';
    if (!tools.length) delta = { role: 'assistant', content: 'Issue 10 product probe' };
    else {
      assert.ok(tools.some(tool => tool.function.name === 'memory_merge_sentinel'), 'memory MCP 必須保留');
      mergeVerified = true;
      const staticMode = mode === 'static';
      const failedMode = mode === 'startupfail' || mode === 'navigationtimeout';
      if (mode === 'upstreamfail' && calls >= 1) {
        emit({ event: 'upstream-failure', status: 401 });
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'ISSUE10_INJECTED_PROVIDER_FAILURE', type: 'authentication_error' } }));
        return;
      }
      const wanted = staticMode ? 'webfetch' : calls === 0 ? 'telenexus_browser_navigate' : 'telenexus_browser_evaluate';
      const maxCalls = staticMode || failedMode ? 1 : 2;
      if (calls < maxCalls) {
        assert.ok(tools.some(tool => tool.function.name === wanted), `產品工具清單必須有 ${wanted}`);
        const args = wanted === 'webfetch' ? { url: fixtureUrl, format: 'text' } : wanted.endsWith('_navigate') ? { url: fixtureUrl } : { script: 'JSON.stringify({body:document.querySelector("#body").textContent,url:location.href})' };
        calls++;
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: `product-call-${calls}`, type: 'function', function: { name: wanted, arguments: JSON.stringify(args) } }] };
        finish = 'tool_calls';
      } else {
        const content = JSON.stringify(body.messages.filter(message => message.role === 'tool'));
        if (failedMode) assert.match(content, mode === 'startupfail' ? /not found|executable|ENOENT|does not exist|Could not find/i : /timed out|timeout/i, '必須是預期真工具失敗');
        else {
          assert.ok(content.includes(staticMode ? 'ISSUE10_HTTP_BODY_20261004' : 'ISSUE10_JS_BODY_20261004'), '真工具必須回傳獨立正文');
          assert.ok(staticMode || content.includes(fixtureUrl), 'JS 工具必須回傳實際來源 URL');
        }
        verified = true;
        emit({ event: 'tool-result-verified', fixtureUrl });
        if (mode === 'cleanupfailure') {
          const roots = readdirSync('/tmp').filter(name => name.startsWith('tnb-'));
          assert.equal(roots.length, 1, '負對照只可修改本測試容器唯一工作 root');
          cleanupFaultRoot = join('/tmp', roots[0]);
          const rows = snapshot();
          const launcher = rows.find(row => row.argv.includes('/usr/local/lib/telenexus/browser-mcp-launcher.mjs'));
          assert.ok(launcher && rows.some(row => row.ppid === launcher.pid && readFileSync(`/proc/${row.pid}/environ`, 'utf8').split('\0').includes(`TMPDIR=${cleanupFaultRoot}`)), '工作 root 必須屬真產品 launcher 的 MCP child');
          const before = statSync(cleanupFaultRoot);
          assert.equal(before.uid, process.getuid(), '只修改自己的工作 root');
          chmodSync(cleanupFaultRoot, 0o500);
          emit({ event: 'cleanup-failure-injected', root: cleanupFaultRoot, launcher, inode: before.ino, uid: before.uid, beforeMode: before.mode & 0o777, afterMode: statSync(cleanupFaultRoot).mode & 0o777 });
        }
        if (mode === 'cancel' || mode === 'groupkill') {
          const rows = snapshot();
          const opencode = rows.find(row => row.argv.includes('opencode') && row.argv.includes(' run '));
          const launcher = rows.find(row => row.argv.includes('/usr/local/lib/telenexus/browser-mcp-launcher.mjs'));
          assert.ok(opencode && launcher && opencode.pgid !== launcher.pgid, 'OpenCode 與工作 launcher 必須不同 PGID');
          emit({ event: 'kill-boundary', client: rows.find(row => row.pid === client.pid), opencode, launcher });
          injectedTermination = true;
          if (mode === 'cancel') client.send({ action: 'cancel' });
          else process.kill(-opencode.pgid, 'SIGKILL');
          response.destroy();
          return;
        }
        const sourceCall = body.messages.flatMap(message => message.tool_calls ?? []).find(call => call.function.name === (staticMode ? 'webfetch' : 'telenexus_browser_navigate'));
        assert.equal(JSON.parse(sourceCall.function.arguments).url, fixtureUrl);
        delta = { role: 'assistant', content: `${failedMode ? '無法完成讀取' : '已驗證工具回傳'}：${content}\n來源：${fixtureUrl}` };
      }
    }
    const common = { id: `product-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'contract' };
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
    response.writeHead(500);
    response.end(fixtureError);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
fixtureUrl = `${base}/${mode === 'static' ? 'static' : 'dynamic'}`;
for (const name of ['config', 'cache', 'data', 'state', 'workspace']) mkdirSync(join(root, name));
mkdirSync(join(root, 'config', 'opencode'));
const existingConfigPath = join(root, 'config', 'opencode', 'opencode.json');
const existingConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { memory: { type: 'local', command: ['node', '/probe/memory-mcp-fixture.mjs'] } } });
writeFileSync(existingConfigPath, existingConfig);
const config = {
  provider: { probe: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${base}/v1`, apiKey: 'probe-only' }, models: { contract: { name: 'Product contract probe', limit: { context: 32768, output: 4096 } } } } },
  model: 'probe/contract'
};
assert.ok(!Object.hasOwn(config, 'mcp'), 'fixture 不得替產品注入 browser 設定');
const baseline = new Set(snapshot().map(row => `${row.pid}:${row.starttime}`));
client = spawn('node', ['/probe/product-agent-client.mjs', entry, fixtureUrl, lane], {
  cwd: root, detached: true,
  env: { ...process.env, APP_PROJECT_DIR: root, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_TASK_TIMEOUT_MS: '90000', TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc']
});
emit({ event: 'start', mode, entry, lane, root, fixtureUrl, pid: client.pid, config });
let stdout = '';
client.stdout.on('data', data => { stdout += data; emit({ event: 'product-output', text: String(data) }); });
client.stderr.on('data', data => emit({ event: 'product-stderr', text: String(data) }));
const tracked = new Map();
const browserIdentities = new Set();
const chromeBinary = '/opt/telenexus/chrome/chrome-linux64/chrome';
function profiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    if (!item.isDirectory()) return [];
    const path = join(directory, item.name);
    try { return item.name.includes('profile') ? [path] : profiles(path); } catch { return []; }
  });
}
function observe() {
  const rows = snapshot();
  for (const row of rows) if (!baseline.has(`${row.pid}:${row.starttime}`)) {
    try {
      row.exe = readlinkSync(`/proc/${row.pid}/exe`);
      const current = parseStat(readFileSync(`/proc/${row.pid}/stat`, 'utf8'));
      if (current.starttime !== row.starttime) continue;
    } catch { row.exe = null; }
    tracked.set(`${row.pid}:${row.starttime}`, row);
    if (row.exe === chromeBinary && !browserIdentities.has(`${row.pid}:${row.starttime}`)) {
      browserIdentities.add(`${row.pid}:${row.starttime}`);
      emit({ event: 'browser-observed', ...row });
    }
  }
  return rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`));
}
function sample(second) {
  const owned = observe();
  const launcherRoots = readdirSync('/tmp').filter(name => name.startsWith('tnb-')).map(name => join('/tmp', name));
  const foundProfiles = [...profiles(root), ...launcherRoots.flatMap(path => { try { return profiles(path); } catch { return []; } })];
  emit({ event: 'sample', second, owned, liveCount: owned.filter(row => row.state !== 'Z').length, zombieCount: owned.filter(row => row.state === 'Z').length, profiles: foundProfiles, launcherRoots });
  return { owned, profiles: foundProfiles, launcherRoots };
}
const watcher = setInterval(observe, 50);
const sampler = setInterval(() => sample('running'), 1000);
let probeTimedOut = false;
const timeout = setTimeout(() => { probeTimedOut = true; process.kill(-client.pid, 'SIGKILL'); emit({ event: 'probe-timeout' }); }, 110000);
const exit = await new Promise(resolve => client.on('exit', (code, signal) => resolve({ code, signal })));
clearTimeout(timeout);
clearInterval(sampler);
emit({ event: 'product-exit', ...exit });
let final;
for (let second = 0; second <= 15; second++) {
  final = sample(second);
  if (second < 15) await new Promise(resolve => setTimeout(resolve, 1000));
}
clearInterval(watcher);
const records = stdout.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.event ? [value] : []; } catch { return []; } });
const result = records.findLast(record => record.event === 'product-result')?.result;
const productError = records.findLast(record => record.event === 'product-error');
const auditPath = join(root, 'data', 'browser-lifecycle.jsonl');
const audit = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
assert.ok(!fixtureError && !probeTimedOut, fixtureError || 'probe 外層逾時不是預期工具結果');
if (mode === 'groupkill') {
  assert.ok(injectedTermination, '必須實際注入 OpenCode PGID SIGKILL');
  assert.equal(exit.code, 1, '強制終止必須造成產品 client 失敗退出');
  assert.equal(productError?.message, 'Error calling Opencode: Process terminated with signal SIGKILL', '保留既有產品 hardkill 錯誤契約');
  assert.ok(!result, 'SIGKILL 不得被冒充為成功結構化結果');
  assert.ok(!records.some(record => record.event === 'product-stream' && record.value?.type === 'done' && record.value.text?.includes('ISSUE10_JS_BODY_20261004')), '強制終止不得輸出成功正文');
} else assert.ok(result, '產品入口必須回傳結構化結果');
if (mode === 'static' || mode === 'dynamic' || mode === 'cleanupfailure') {
  assert.ok(result.text.includes(mode === 'static' ? 'ISSUE10_HTTP_BODY_20261004' : 'ISSUE10_JS_BODY_20261004') && result.text.includes(fixtureUrl), '最終產品文字必須包含真正文／URL');
  assert.equal(browserIdentities.size > 0, mode !== 'static', 'Chrome 真程序正／負對照');
}
if (mode === 'startupfail' || mode === 'navigationtimeout') assert.ok(result.text.includes('無法完成讀取') && !result.text.includes('ISSUE10_JS_BODY_20261004'), '工具失敗不得偽造正文');
if (mode === 'navigationtimeout') assert.ok(stalledNavigation, '導覽必須送達刻意阻塞 fixture');
if (mode === 'cancel') assert.ok(injectedTermination && /中止|取消/.test(result.text) && !result.text.includes('ISSUE10_JS_BODY_20261004'), '必須經產品取消路徑回傳');
if (mode === 'upstreamfail') assert.equal(result.failure?.kind, 'upstream-error', '上游錯誤必須保留產品失敗分類');
assert.ok(mergeVerified && readFileSync(existingConfigPath, 'utf8') === existingConfig, '既有 memory MCP 設定不得改寫');
const cleanupPassed = final.owned.length === 0 && final.profiles.length === 0 && final.launcherRoots.length === 0;
const negativeControl = mode === 'cleanupfailure';
let expectedFailureObserved = null;
if (negativeControl) {
  const auditRecords = audit.trim().split('\n').filter(Boolean).map(JSON.parse);
  const failure = auditRecords.find(record => record.event === 'browser-mcp-cleanup-failed' && record.errorCode === 'EACCES' && record.root === cleanupFaultRoot);
  expectedFailureObserved = Boolean(failure && final.launcherRoots.includes(cleanupFaultRoot) && !cleanupPassed);
  assert.ok(expectedFailureObserved, '真實 audit 檔必須記錄本工作 EACCES 且保留故障 root');
  assert.equal(final.owned.length, 0, '負對照不能用程序未退出混淆 profile 清理故障');
  emit({ event: 'cleanup-failure-audit-verified', auditPath, failure, retainedRoot: cleanupFaultRoot, cleanupPassed });
}
emit({ event: 'measurement-complete', mode, entry, lane, verified, mergeVerified, calls, finalText: result?.text ?? '', productError: productError?.message ?? null, browserObserved: browserIdentities.size, auditPath, audit, negativeControl, expectedFailureObserved, cleanupPassed, observerStillAlive: true });
server.close();
