import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { snapshot } from './proc-observer.mjs';

// 2026-10-04：只驗證兩個真實 MCP 的隔離；OpenCode 退出另由 opencode-contract 驗證。
setInterval(() => {}, 1000);
const root = mkdtempSync(join(tmpdir(), 'issue10-concurrent-'));
const baseline = new Set(snapshot().map(row => `${row.pid}:${row.starttime}`));
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(`<main id="body">WAITING</main><script>document.querySelector('#body').textContent=${JSON.stringify(request.url === '/a' ? 'ISSUE10_CONCURRENT_A' : 'ISSUE10_CONCURRENT_B')}</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
function client(name) {
  const directory = join(root, name);
  mkdirSync(directory);
  const child = spawn(process.execPath, ['/probe/task-owned-launcher.mjs', '/opt/issue10-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js', '--headless', '--isolated', '--slim', '--no-usage-statistics', '--no-performance-crux', '--executable-path=/home/node/.agent-browser/browsers/chrome-154.0.8037.92/chrome', '--chrome-arg=--no-sandbox', '--chrome-arg=--disable-dev-shm-usage'], {
    detached: true, env: { ...process.env, TMPDIR: directory }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const identity = snapshot().find(row => row.pid === child.pid);
  assert.ok(identity, '必須取得 launcher 初始身分');
  const tracked = new Map();
  const pending = new Map();
  let buffer = '';
  let sequence = 0;
  child.stdout.on('data', data => {
    buffer += data;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = pending.get(message.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); }
    }
  });
  child.stderr.on('data', data => console.log(JSON.stringify({ event: 'stderr', name, text: String(data) })));
  child.on('exit', (code, signal) => console.log(JSON.stringify({ event: 'launcher-exit', name, code, signal })));
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} ${method} timeout`)); }, 30000);
      pending.set(id, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  function resources() {
    const rows = snapshot();
    const liveLauncher = rows.some(row => row.pid === identity.pid && row.starttime === identity.starttime);
    const descendants = new Set(liveLauncher ? [child.pid] : []);
    let changed;
    do {
      changed = false;
      for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
    } while (changed);
    for (const row of rows) if (descendants.has(row.pid) || row.argv.includes(directory)) tracked.set(`${row.pid}:${row.starttime}`, row);
    return { owned: rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`)), roots: readdirSync(directory).filter(entry => entry.startsWith('launcher-owned-')) };
  }
  return { name, child, directory, request, resources };
}
const a = client('a');
const b = client('b');
const sampler = setInterval(() => console.log(JSON.stringify({ event: 'running', a: a.resources(), b: b.resources() })), 100);
async function initialize(work) {
  const result = await work.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'issue10-concurrency', version: '1' } });
  assert.ok(result.result);
  work.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await work.request('tools/list', {});
  assert.ok(list.result.tools.some(tool => tool.name === 'navigate') && list.result.tools.some(tool => tool.name === 'evaluate'));
  const navigation = await work.request('tools/call', { name: 'navigate', arguments: { url: `${base}/${work.name}` } });
  assert.ok(!navigation.error && !navigation.result.isError, '真實導覽須成功');
}
async function evaluate(work, script) {
  const result = await work.request('tools/call', { name: 'evaluate', arguments: { script } });
  assert.ok(!result.error && !result.result.isError, '真實 evaluate 須成功');
  console.log(JSON.stringify({ event: 'evaluate', name: work.name, result }));
  return JSON.stringify(result.result.content);
}
await Promise.all([initialize(a), initialize(b)]);
await evaluate(a, 'document.cookie="owner=A; Path=/"; document.cookie');
await evaluate(b, 'document.cookie="owner=B; Path=/"; document.cookie');
const readScript = 'JSON.stringify({cookie:document.cookie,body:document.querySelector("#body").textContent,url:location.href})';
const beforeA = await evaluate(a, readScript);
const beforeB = await evaluate(b, readScript);
assert.ok(beforeA.includes('owner=A') && !beforeA.includes('owner=B') && beforeA.includes('ISSUE10_CONCURRENT_A') && beforeA.includes(`${base}/a`));
assert.ok(beforeB.includes('owner=B') && !beforeB.includes('owner=A') && beforeB.includes('ISSUE10_CONCURRENT_B') && beforeB.includes(`${base}/b`));
const aRoots = a.resources().roots;
const bRoots = b.resources().roots;
assert.equal(aRoots.length, 1);
assert.equal(bRoots.length, 1);
console.log(JSON.stringify({ event: 'isolated-before-cancel', aRoot: join(a.directory, aRoots[0]), bRoot: join(b.directory, bRoots[0]) }));
// 2026-10-04：A 的 transport EOF 不等同實際 OpenCode SIGTERM；只檢查收尾互不干擾。
a.child.stdin.end();
for (let second = 0; second <= 15; second++) {
  console.log(JSON.stringify({ event: 'a-cleanup-sample', second, a: a.resources(), b: b.resources() }));
  if (second < 15) await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(a.resources().owned.length, 0);
assert.equal(a.resources().roots.length, 0);
assert.ok(b.resources().owned.length > 0 && b.resources().roots.length === 1);
const afterB = await evaluate(b, readScript);
assert.ok(afterB.includes('owner=B') && !afterB.includes('owner=A') && afterB.includes('ISSUE10_CONCURRENT_B') && afterB.includes(`${base}/b`));
console.log(JSON.stringify({ event: 'b-survived-a-cleanup', verified: true }));
b.child.stdin.end();
clearInterval(sampler);
let final;
for (let second = 0; second <= 15; second++) {
  const owned = snapshot().filter(row => !baseline.has(`${row.pid}:${row.starttime}`));
  final = { owned, aRoots: a.resources().roots, bRoots: b.resources().roots };
  console.log(JSON.stringify({ event: 'final-sample', second, ...final }));
  if (second < 15) await new Promise(resolve => setTimeout(resolve, 1000));
}
console.log(JSON.stringify({ event: 'measurement-complete', verified: true, cleanupPassed: final.owned.length === 0 && final.aRoots.length === 0 && final.bRoots.length === 0, observerStillAlive: true }));
server.close();
