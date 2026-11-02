import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

const PACKAGE_ROOT = '/usr/local/lib/node_modules/@raybird.chen/memoria';
const EMBEDDABLE_TYPES = new Set(['session', 'decision', 'skill', 'memory_node']);

/** Keep the serve process and index helpers under the same shutdown boundary. */
export function createChildRunner() {
  const children = new Set();
  let stopped = false;
  return {
    activeCount: () => children.size,
    run(command, args, options = {}) {
      if (stopped) return Promise.reject(new Error('worker stopped'));
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
        children.add(child);
        let stdout = '';
        child.stdout?.on('data', (chunk) => {
          stdout = (stdout + chunk).slice(-65536);
        });
        // Do not forward helper errors: payloads can contain private memory text.
        child.stderr?.resume();
        child.once('error', (error) => {
          children.delete(child);
          reject(error);
        });
        child.once('close', (code, signal) => {
          children.delete(child);
          if (code === 0) resolve(stdout);
          else reject(new Error(`${path.basename(args[0] || command)} failed (${signal || code})`));
        });
      });
    },
    stop() {
      stopped = true;
      for (const child of children) {
        child.kill('SIGTERM');
        const deadline = setTimeout(() => {
          if (children.has(child)) child.kill('SIGKILL');
        }, 5000);
        deadline.unref();
        child.once('close', () => clearTimeout(deadline));
      }
    }
  };
}

/** The source DB owns a dedicated cursor; only a successful vector ingest advances it. */
export function createVectorWorker({
  home,
  packageRoot = PACKAGE_ROOT,
  run,
  intervalMs = 60000,
  vectorUrl = process.env.LIBSQL_URL || `file:${path.join(home, '.memory/vectors.db')}`
}) {
  const scripts = path.join(packageRoot, 'skills/memoria-memory-sync/scripts');
  const ingest = '/usr/local/bin/memoria-vector-ingest.mjs';
  const statusPath = path.join(home, '.memory/vector-worker-status.json');
  const status = {
    phase: 'idle',
    lastSuccessAt: null,
    lastError: null,
    entities: 0,
    updatedAt: null
  };
  let busy = false;
  let stopped = false;
  let timer;

  async function save(phase) {
    status.phase = phase;
    status.updatedAt = new Date().toISOString();
    await mkdir(path.dirname(statusPath), { recursive: true });
    await writeFile(`${statusPath}.tmp`, JSON.stringify(status) + '\n', { mode: 0o600 });
    await rename(`${statusPath}.tmp`, statusPath);
  }

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    let scratch;
    try {
      scratch = await mkdtemp(path.join(tmpdir(), 'memoria-vector-'));
      await save('building');
      const localStore = vectorUrl.startsWith('file:') ? vectorUrl.slice(5) : null;
      const rebuildMarker = localStore ? `${localStore}.rebuild-pending` : null;
      const storeMissing =
        localStore &&
        (!(await access(localStore).then(
          () => true,
          () => false
        )) ||
          (await access(rebuildMarker).then(
            () => true,
            () => false
          )));
      if (storeMissing) {
        await mkdir(path.dirname(localStore), { recursive: true });
        await writeFile(rebuildMarker, 'Full vector rebuild required\n', { mode: 0o600 });
      }
      // "full" alone still honors a saved cursor upstream. A never-committed recovery
      // target forces a complete payload if the vector store was lost or never created.
      const target = storeMissing ? `telenexus-vector-rebuild-${randomUUID()}` : 'telenexus-vector';
      const output = await run(process.execPath, [
        path.join(scripts, 'build-mcp-bridge-payload.mjs'),
        '--memoria-home',
        home,
        '--sync-target',
        target,
        '--out',
        scratch,
        ...(storeMissing ? ['--payload-mode', 'full'] : [])
      ]);
      const payloadPath = path.resolve(output.trim());
      if (path.dirname(payloadPath) !== scratch) throw new Error('invalid payload path');
      const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
      status.entities = (payload.entities || []).filter((entity) =>
        EMBEDDABLE_TYPES.has(entity.type)
      ).length;
      if (status.entities > 0 && !stopped) {
        await save('embedding');
        await run(process.execPath, [ingest, payloadPath]);
        if (stopped) return;
        await save('committing');
        await run(process.execPath, [
          path.join(scripts, 'update-mcp-sync-state.mjs'),
          '--payload',
          payloadPath,
          '--target',
          'telenexus-vector'
        ]);
        if (rebuildMarker) await rm(rebuildMarker, { force: true });
      }
      status.lastSuccessAt = new Date().toISOString();
      status.lastError = null;
      await save('idle');
    } catch (error) {
      // The command runner emits only command names/exit codes, never the payload itself.
      status.lastError = `${status.phase} failed; cursor retained`;
      await save('error').catch(() => {});
      console.error('[memoria-vector] indexing failed; cursor retained, retrying next interval');
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
      busy = false;
    }
  }

  return {
    tick,
    start() {
      // Serve initializes the DB independently; retrying also handles a brand-new empty root.
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      void tick();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

export async function main() {
  const enabled = process.env.MEMORIA_VECTOR_ENABLED === '1';
  const home = process.env.MEMORIA_HOME || '/data';
  const args = process.argv.slice(2);
  let command = 'memoria';
  if (args[0] === 'memoria') {
    args.shift();
  } else if (args[0] && !args[0].startsWith('-')) {
    // Preserve the base image's arbitrary-command entry point (e.g. shell recovery).
    const candidates = args[0].includes('/')
      ? [args[0]]
      : (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, args[0]));
    for (const candidate of candidates) {
      if (
        await access(candidate, constants.X_OK).then(
          () => true,
          () => false
        )
      ) {
        command = args.shift();
        break;
      }
    }
  }
  if (args.length === 0 && command === 'memoria') args.push('serve');
  // 守門腳本一律掛上:關閉語意搜尋或索引未就緒時它直接回空,Memoria 走字面搜尋且不記成降級。
  process.env.LIBSQL_URL ||= `file:${path.join(home, '.memory/vectors.db')}`;
  process.env.MEMORIA_VECTOR_RECALL_CMD ||= '/usr/local/bin/memoria-vector-recall.mjs';
  if (enabled) {
    process.env.MEMORIA_EMBED_PROVIDER ||= 'local';
  }
  const runner = createChildRunner();
  const interval = Number(process.env.MEMORIA_VECTOR_SYNC_INTERVAL_MS);
  const worker =
    enabled && command === 'memoria' && args[0] === 'serve'
      ? createVectorWorker({
          home,
          run: runner.run,
          intervalMs: Number.isFinite(interval) && interval >= 1000 ? interval : 60000
        })
      : null;
  let shuttingDown = false;
  const shutdown = () => {
    shuttingDown = true;
    worker?.stop();
    runner.stop();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  const serve = runner.run(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  worker?.start();
  try {
    await serve;
  } catch {
    if (!shuttingDown) process.exitCode = 1;
  } finally {
    shutdown();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
