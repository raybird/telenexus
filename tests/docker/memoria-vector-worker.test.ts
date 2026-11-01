import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../docker/memoria-entrypoint.mjs')
).href;

async function fixture(options: { failIngest?: boolean; empty?: boolean } = {}) {
  const { createVectorWorker } = await import(moduleUrl);
  const home = await mkdtemp(path.join(tmpdir(), 'memoria-worker-test-'));
  // Existing store represents the ordinary incremental path.
  await writeFile(path.join(home, 'vectors.db'), 'existing store');
  const calls: string[] = [];
  const argumentsByCall: string[][] = [];
  let payloadPath = '';
  const worker = createVectorWorker({
    home,
    vectorUrl: `file:${path.join(home, 'vectors.db')}`,
    packageRoot: '/official/memoria',
    run: async (_command: string, args: string[]) => {
      const script = path.basename(args[0]!);
      calls.push(script);
      argumentsByCall.push(args);
      if (script === 'build-mcp-bridge-payload.mjs') {
        const dir = args[args.indexOf('--out') + 1]!;
        payloadPath = path.join(dir, 'payload.json');
        await writeFile(
          payloadPath,
          JSON.stringify({
            entities: options.empty
              ? []
              : [{ id: 'session:old', type: 'session', text: 'a real memory' }],
            sync: { changed_node_count: options.empty ? 0 : 1 }
          })
        );
        return payloadPath + '\n';
      }
      if (script === 'memoria-vector-ingest.mjs' && options.failIngest)
        throw new Error('ingest unavailable');
      return '{"ok":true}';
    }
  });
  return { worker, home, calls, argumentsByCall, payload: () => payloadPath };
}

test('vector worker ingests before committing its dedicated cursor and removes payloads', async () => {
  const f = await fixture();
  try {
    await f.worker.tick();
    assert.deepEqual(f.calls, [
      'build-mcp-bridge-payload.mjs',
      'memoria-vector-ingest.mjs',
      'update-mcp-sync-state.mjs'
    ]);
    assert.equal(
      f.argumentsByCall[0]![f.argumentsByCall[0]!.indexOf('--sync-target') + 1],
      'telenexus-vector'
    );
    assert.equal(
      f.argumentsByCall[2]![f.argumentsByCall[2]!.indexOf('--target') + 1],
      'telenexus-vector'
    );
    await assert.rejects(access(f.payload()));
    const status = JSON.parse(
      await readFile(path.join(f.home, '.memory/vector-worker-status.json'), 'utf8')
    );
    assert.equal(status.phase, 'idle');
    assert.ok(status.lastSuccessAt);
    assert.equal(status.lastError, null);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('failed embedding never commits a cursor, cleans payload and retries next tick', async () => {
  const f = await fixture({ failIngest: true });
  try {
    await f.worker.tick();
    await f.worker.tick();
    assert.equal(f.calls.filter((c) => c === 'update-mcp-sync-state.mjs').length, 0);
    assert.equal(f.calls.filter((c) => c === 'memoria-vector-ingest.mjs').length, 2);
    await assert.rejects(access(f.payload()));
    const status = JSON.parse(
      await readFile(path.join(f.home, '.memory/vector-worker-status.json'), 'utf8')
    );
    assert.equal(status.phase, 'error');
    assert.equal(status.lastSuccessAt, null);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('empty incremental payload never loads the embedding model', async () => {
  const f = await fixture({ empty: true });
  try {
    await f.worker.tick();
    assert.deepEqual(f.calls, ['build-mcp-bridge-payload.mjs']);
    await assert.rejects(access(f.payload()));
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('overlapping ticks do not start concurrent embedding processes', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.worker.tick(), f.worker.tick(), f.worker.tick()]);
    assert.equal(f.calls.filter((c) => c === 'memoria-vector-ingest.mjs').length, 1);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('child runner stop terminates an active helper and rejects its pending call', async () => {
  const { createChildRunner } = await import(moduleUrl);
  const runner = createChildRunner();
  const task = runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  runner.stop();
  await assert.rejects(task);
  assert.equal(runner.activeCount(), 0);
});

test('a lost vector store bypasses its old cursor with a fresh full-rebuild target', async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.home, 'vectors.db'));
    await f.worker.tick();
    const build = f.argumentsByCall[0]!;
    assert.match(build[build.indexOf('--sync-target') + 1]!, /^telenexus-vector-rebuild-/);
    assert.equal(build[build.indexOf('--payload-mode') + 1], 'full');
    const commit = f.argumentsByCall[2]!;
    assert.equal(commit[commit.indexOf('--target') + 1], 'telenexus-vector');
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('a partially rebuilt store keeps requesting full payloads until ingest succeeds', async () => {
  const f = await fixture({ failIngest: true });
  try {
    await rm(path.join(f.home, 'vectors.db'));
    await f.worker.tick();
    // A failed ingest may already have created its DB and some vectors.
    await writeFile(path.join(f.home, 'vectors.db'), 'partial store');
    await f.worker.tick();
    const builds = f.argumentsByCall.filter(
      (args) => path.basename(args[0]!) === 'build-mcp-bridge-payload.mjs'
    );
    assert.equal(builds.length, 2);
    for (const args of builds) assert.equal(args[args.indexOf('--payload-mode') + 1], 'full');
    assert.notEqual(
      builds[0]![builds[0]!.indexOf('--sync-target') + 1],
      builds[1]![builds[1]!.indexOf('--sync-target') + 1]
    );
    assert.ok(await access(path.join(f.home, 'vectors.db.rebuild-pending')).then(() => true));
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('entrypoint preserves prefixed and unprefixed CLI arguments without starting a worker', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'memoria-cli-test-'));
  try {
    const binary = path.join(home, 'memoria');
    await writeFile(
      binary,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n'
    );
    await chmod(binary, 0o755);
    const entrypoint = path.resolve(import.meta.dirname, '../../docker/memoria-entrypoint.mjs');
    const env = {
      ...process.env,
      PATH: `${home}:${process.env.PATH}`,
      MEMORIA_HOME: home,
      MEMORIA_VECTOR_ENABLED: '1'
    };
    const execute = promisify(execFile);
    const version = await execute(process.execPath, [entrypoint, 'memoria', '--version'], { env });
    assert.deepEqual(JSON.parse(version.stdout), ['--version']);
    const index = await execute(process.execPath, [entrypoint, 'index', 'build'], { env });
    assert.deepEqual(JSON.parse(index.stdout), ['index', 'build']);
    const shell = await execute(
      process.execPath,
      [entrypoint, 'sh', '-c', 'printf recovery-command'],
      { env }
    );
    assert.equal(shell.stdout, 'recovery-command');
    await assert.rejects(access(path.join(home, '.memory/vector-worker-status.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
