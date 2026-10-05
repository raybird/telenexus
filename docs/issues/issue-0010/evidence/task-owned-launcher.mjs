import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, parseStat } from './proc-observer.mjs';

// 2026-10-04：僅驗證自有工作 supervisor，未接入產品；自身 SIGKILL 無法執行收尾。
const root = mkdtempSync(join(tmpdir(), 'launcher-owned-'));
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', error => { if (error.code !== 'EPIPE') throw error; });
}
const child = spawn(process.execPath, process.argv.slice(2), {
  env: { ...process.env, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const tracked = new Map();
const firstChild = snapshot().find(row => row.pid === child.pid);
const childIdentity = firstChild ? `${firstChild.pid}:${firstChild.starttime}` : undefined;
function owned() {
  const rows = snapshot();
  const currentChild = rows.find(row => row.pid === child.pid);
  const descendants = new Set(currentChild && `${currentChild.pid}:${currentChild.starttime}` === childIdentity ? [child.pid] : []);
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
    }
  } while (changed);
  for (const row of rows) {
    if (descendants.has(row.pid) || row.argv.includes(root)) tracked.set(`${row.pid}:${row.starttime}`, row);
  }
  return rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`));
}
function signalOwned(signal) {
  for (const row of owned()) {
    if (row.state === 'Z') continue;
    try {
      const current = parseStat(readFileSync(`/proc/${row.pid}/stat`, 'utf8'));
      if (current.starttime === row.starttime && current.state !== 'Z') process.kill(row.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error; }
  }
}
process.stderr.write(`${JSON.stringify({ event: 'launcher-start', pid: process.pid, mcpPid: child.pid, root })}\n`);
const sampler = setInterval(owned, 100);
owned();
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);
child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
let closing = false;
let childOutcome;
let resolveChildExit;
const childExited = new Promise(resolve => { resolveChildExit = resolve; });
async function close() {
  if (closing) return;
  closing = true;
  process.stdin.unpipe(child.stdin);
  child.stdin.end();
  await Promise.race([childExited, new Promise(resolve => setTimeout(resolve, 3500))]);
  signalOwned('SIGKILL');
  for (let attempt = 0; attempt < 10 && owned().length > 0; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  clearInterval(sampler);
  const remaining = owned();
  if (remaining.length === 0) rmSync(root, { recursive: true });
  process.stderr.write(`${JSON.stringify({ event: 'launcher-close', root, remaining, childOutcome })}\n`);
  const childCode = childOutcome?.signal ? 128 : childOutcome?.code ?? 1;
  process.exit(remaining.length === 0 ? childCode : 1);
}
process.stdin.on('end', close);
child.on('exit', (code, signal) => { childOutcome = { code, signal }; resolveChildExit(); close(); });
process.on('SIGTERM', close);
process.on('SIGINT', close);
