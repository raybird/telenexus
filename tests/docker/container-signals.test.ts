// issue 0031 AC-3：docker stop 的 SIGTERM 要送得到主程序。
// - init（tini）以 root 執行，主程序由 entrypoint 以 gosu 降成 node：root 送訊號給不同 UID 需要 KILL。
// - telenexus 的映像預設命令是 `npm start`，npm 把訊號轉給 `sh -c`；dash 不會再轉給子程序，
//   所以 start 腳本的最後一段要 `exec node …`，讓 node 取代 sh。
// 2026-11-17 實測（v2.40.0 映像）：沒有 KILL 時 tini 回報 Operation not permitted、exit 1；
// 有 KILL 但沒有 exec 時 exit 143，handler 沒有執行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (name: string) => fs.readFileSync(path.join(ROOT, name), 'utf8');

type Service = { init?: boolean; cap_add?: string[]; command?: string[] };
const services = (name: string) =>
  (yaml.load(read(name)) as { services: Record<string, Service> }).services;

// 以 entrypoint（root）啟動、再以 gosu 降權的服務
const DROPPED_TO_NODE = ['telenexus', 'agent-runner', 'tunnel-manager'];
// 映像本身就是 USER node，tini 也以 node 執行，不需要 KILL
const RUNS_AS_NODE = ['memoria', 'memoria-ui'];

for (const filename of ['docker-compose.yml', 'docker-compose.release.yml']) {
  test(`${filename}：以 init 執行且降權的服務，cap_add 都有 KILL`, () => {
    const all = services(filename);
    for (const name of DROPPED_TO_NODE) {
      const service = all[name];
      assert.ok(service, `${name} 存在`);
      assert.equal(service.init, true, `${name} 由 init 轉送訊號`);
      assert.ok(service.cap_add?.includes('KILL'), `${name} 的 cap_add 要有 KILL`);
    }
  });

  test(`${filename}：本來就以 node 執行的 memoria 不加 KILL`, () => {
    const all = services(filename);
    for (const name of RUNS_AS_NODE) {
      assert.ok(all[name], `${name} 存在`);
      assert.equal(all[name]?.cap_add?.includes('KILL') ?? false, false, `${name} 不需要 KILL`);
    }
  });

  test(`${filename}：agent-runner 直接執行 node，不經 npm`, () => {
    assert.deepEqual(services(filename)['agent-runner']?.command, ['node', 'dist/runner.js']);
  });
}

test('memoria 映像以 node 執行（所以不需要 KILL）', () => {
  assert.match(read('docker/memoria.Dockerfile'), /^USER node$/m);
});

test('telenexus 映像預設以 npm start 啟動，start 腳本最後以 exec 交給 node', () => {
  const dockerfile = read('Dockerfile');
  // production stage 在最後（release.yml 與 compose 都不指定 target）
  const lastCmd = [...dockerfile.matchAll(/^CMD (.+)$/gm)].at(-1)?.[1];
  assert.equal(lastCmd, '["npm", "start"]');
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  assert.match(scripts.start ?? '', /&& exec node dist\/main\.js$/);
  assert.match(scripts['start:runner'] ?? '', /&& exec node dist\/runner\.js$/);
});
