import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { snapshot } from './proc-observer.mjs';

// 2026-10-04：量測期間保留容器 PID1，不能靠容器退出製造收尾成功。
setInterval(() => {}, 1000);
const mode = process.argv[2] ?? 'eof';
const root = mkdtempSync(join(tmpdir(), `issue10-${mode}-`));
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Issue 10 fixture</title><main id="body">WAITING</main><script>document.querySelector("#body").textContent="ISSUE10_JS_BODY_20261004"</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/dynamic`;
const args = ['/opt/issue10-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js', '--headless', '--isolated', '--slim', '--no-usage-statistics', '--no-performance-crux', '--executable-path=/home/node/.agent-browser/browsers/chrome-154.0.8037.92/chrome'];
if (process.env.ISSUE10_NO_SANDBOX === '1') args.push('--chrome-arg=--no-sandbox');
if (process.env.ISSUE10_SHM_ONLY === '1') args.push('--chrome-arg=--disable-dev-shm-usage');
const baseline = new Set(snapshot().map(row => `${row.pid}:${row.starttime}`));
const launchArgs = process.env.ISSUE10_LAUNCHER === '1' ? ['/probe/task-owned-launcher.mjs', ...args] : args;
const child = spawn(process.execPath, launchArgs, { detached: process.env.ISSUE10_LAUNCHER === '1', env: { ...process.env, TMPDIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
console.log(JSON.stringify({ event: 'start', mode, root, url, pid: child.pid, args, sandboxDisabled: process.env.ISSUE10_NO_SANDBOX === '1' }));
child.stderr.on('data', data => console.log(JSON.stringify({ event: 'stderr', text: String(data) })));
child.on('exit', (code, signal) => console.log(JSON.stringify({ event: 'mcp-exit', code, signal })));
let sequence = 0;
let buffer = '';
const pending = new Map();
child.stdout.on('data', data => {
  buffer += data;
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
    } catch { console.log(JSON.stringify({ event: 'non-json', line })); }
  }
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const tracked = new Map();
function profilePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const path = join(directory, entry.name);
    return entry.name.includes('profile') ? [path] : profilePaths(path);
  });
}
function record(second) {
  const rows = snapshot();
  for (const row of rows) {
    if (!baseline.has(`${row.pid}:${row.starttime}`)) tracked.set(`${row.pid}:${row.starttime}`, row);
  }
  const owned = rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`));
  const profiles = profilePaths(root);
  const launcherRoots = readdirSync(root).filter(name => name.startsWith('launcher-owned-'));
  console.log(JSON.stringify({ event: 'sample', second, owned, liveCount: owned.filter(row => row.state !== 'Z').length, zombieCount: owned.filter(row => row.state === 'Z').length, profiles, launcherRoots }));
  return { owned, profiles, launcherRoots };
}
let readingPassed = false;
const sampler = setInterval(() => record('running'), 1000);
try {
  console.log(JSON.stringify({ event: 'initialize', result: await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'issue10-probe', version: '1' } }) }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await request('tools/list', {});
  console.log(JSON.stringify({ event: 'tools', result: list }));
  const navigate = list.result.tools.find(tool => tool.name === 'navigate');
  const evaluate = list.result.tools.find(tool => tool.name === 'evaluate');
  assert.ok(navigate && evaluate, '發布版須提供 slim navigate/evaluate');
  const navigation = await request('tools/call', { name: navigate.name, arguments: { url } });
  console.log(JSON.stringify({ event: 'navigate', result: navigation }));
  if (navigation.result?.isError || navigation.error) throw new Error('真實導覽失敗');
  const result = await request('tools/call', { name: evaluate.name, arguments: { script: 'JSON.stringify({body:document.querySelector("#body").textContent,url:location.href})' } });
  console.log(JSON.stringify({ event: 'evaluate', result }));
  const content = JSON.stringify(result.result?.content);
  assert.ok(!result.result?.isError && content.includes('ISSUE10_JS_BODY_20261004') && content.includes(url), '正文及網址須符合獨立 fixture');
  readingPassed = true;
} catch (error) { console.log(JSON.stringify({ event: 'read-failed', error: String(error) })); }
clearInterval(sampler);
const before = record(-1);
if (readingPassed) assert.ok(before.profiles.length >= 1, '故障注入前必須觀測到真 profile');
if (mode === 'kill') child.kill('SIGKILL');
else if (mode === 'kill-mcp') {
  const mcp = snapshot().find(row => row.ppid === child.pid && row.comm.startsWith('chrome-devtools'));
  assert.ok(mcp, '必須找到 launcher 的 MCP 子程序');
  process.kill(mcp.pid, 'SIGKILL');
  console.log(JSON.stringify({ event: 'mcp-child-killed', pid: mcp.pid }));
} else if (mode === 'client-eof') {
  console.log(JSON.stringify({ event: 'client-eof', note: '模擬 client 消失的 transport EOF，並非真的殺 OpenCode' }));
  child.stdin.end();
}
else if (mode === 'stopped-chrome' || mode === 'kill-launcher-stopped') {
  const chrome = snapshot().find(row => row.argv.includes('--user-data-dir=') && row.argv.includes(root) && !row.argv.includes('--type='));
  assert.ok(chrome, '必須有 Chrome root 才可驗證停止故障');
  process.kill(chrome.pid, 'SIGSTOP');
  console.log(JSON.stringify({ event: 'chrome-stopped', pid: chrome.pid }));
  if (mode === 'kill-launcher-stopped') child.kill('SIGKILL');
  else child.stdin.end();
} else child.stdin.end();
let final;
for (let second = 0; second <= 15; second++) {
  final = record(second);
  if (second < 15) await new Promise(resolve => setTimeout(resolve, 1000));
}
console.log(JSON.stringify({ event: 'measurement-complete', readingPassed, cleanupPassed: final.owned.length === 0 && final.profiles.length === 0 && final.launcherRoots.length === 0, observerStillAlive: true }));
server.close();
