import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';

// 2026-10-04：由外層 setsid 隔離；本程序自身 SIGKILL 無法執行收尾。
const root = mkdtempSync('/tmp/tnb-');
const tracked = new Map();
let childOutcome;
let closing = false;
let requestedSignal;
let resolveChildExit;
const childExited = new Promise(resolve => { resolveChildExit = resolve; });

function event(name, details = {}) {
  if (process.stderr.destroyed) return;
  process.stderr.write(`${JSON.stringify({ event: name, root, ...details })}\n`);
}

function readProcess(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid, state: fields[0], ppid: Number(fields[1]), starttime: fields[19] };
}

const [executable, ...args] = process.argv.slice(2);
const child = spawn(executable || process.execPath, executable ? args : ['--invalid-browser-mcp-command'], {
  env: { ...process.env, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let childIdentity;
try { childIdentity = readProcess(child.pid); } catch { /* 子程序可能已退出；不重新認領相同 PID。 */ }

function owned() {
  const rows = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const row = readProcess(Number(name));
      row.argv = '';
      row.hasRoot = false;
      try { row.argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { /* stat 身分仍須保留。 */ }
      try { row.hasRoot = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(`TMPDIR=${root}`); } catch { /* 親緣與已持有身分不依賴 environ 權限。 */ }
      return [row];
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return [];
      const held = [...tracked.values()].find(row => row.pid === Number(name));
      if (held) return [{ ...held, state: '?' }];
      return [];
    }
  });
  const descendants = new Set(rows.filter(row => row.pid === childIdentity?.pid && row.starttime === childIdentity.starttime).map(row => row.pid));
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  } while (changed);
  for (const row of rows) {
    if (descendants.has(row.pid) || row.hasRoot || row.argv.includes(root)) tracked.set(`${row.pid}:${row.starttime}`, row);
  }
  return rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`));
}

function signalOwned(signal) {
  for (const row of owned()) {
    if (row.state === 'Z') continue;
    try {
      const current = readProcess(row.pid);
      if (current.starttime === row.starttime && current.state !== 'Z') process.kill(row.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
    }
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sampler = setInterval(owned, 100);

async function close(signal) {
  if (signal) requestedSignal = signal;
  if (closing) return;
  closing = true;
  const deadline = performance.now() + 12000;
  process.stdin.unpipe(child.stdin);
  child.stdin.end();
  let cleanupError;
  let remaining = [];
  try {
    await Promise.race([childExited, delay(3500)]);
    signalOwned('SIGKILL');
    await Promise.race([childExited, delay(1000)]);
    while (owned().length > 0 && performance.now() < deadline) await delay(100);
    remaining = owned();
    if (remaining.length === 0) rmSync(root, { recursive: true });
  } catch (error) {
    cleanupError = { code: error.code, message: error.message };
  }
  clearInterval(sampler);
  const remainingIdentities = remaining.map(({ pid, starttime, state }) => ({ pid, starttime, state }));
  if (cleanupError || remaining.length > 0) {
    const record = { event: 'browser-mcp-cleanup-failed', launcherPid: process.pid, root, errorCode: cleanupError?.code || 'OWNED_PROCESSES_REMAIN', remaining: remainingIdentities };
    event(record.event, record);
    const auditPath = process.env.TELENEXUS_BROWSER_AUDIT_FILE;
    if (auditPath) {
      try {
        mkdirSync(dirname(auditPath), { recursive: true });
        appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      } catch (error) {
        event('browser-mcp-audit-error', { code: error.code });
      }
    }
  }
  event('browser-mcp-close', { remaining: remainingIdentities, childOutcome, cleanupError });
  const signalCode = requestedSignal || childOutcome?.signal;
  const code = signalCode ? 128 + (constants.signals[signalCode] || 0) : childOutcome?.code ?? 1;
  process.exit(cleanupError || remaining.length > 0 ? 1 : code);
}

for (const stream of [process.stdout, process.stderr, child.stdin]) {
  stream.on('error', error => {
    if (error.code === 'EPIPE') void close();
    else {
      event('browser-mcp-stream-error', { code: error.code, message: error.message });
      childOutcome = { code: 1 };
      void close();
    }
  });
}
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);
event('browser-mcp-start', { pid: process.pid, mcpPid: child.pid, childIdentity });
owned();
process.stdin.on('end', () => void close());
child.on('error', error => {
  childOutcome = { code: 1, error: { code: error.code, message: error.message } };
  event('browser-mcp-spawn-error', childOutcome.error);
  resolveChildExit();
  void close();
});
child.on('exit', (code, signal) => {
  childOutcome = { code, signal };
  resolveChildExit();
  void close();
});
process.on('SIGTERM', () => void close('SIGTERM'));
process.on('SIGINT', () => void close('SIGINT'));
