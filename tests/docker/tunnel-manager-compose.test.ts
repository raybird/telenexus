// issue 0030 Task 5.1（SCN-001／SCN-004 支援）：tunnel-manager 服務、面板連接埠與 cloudflared 安裝的靜態檢查。
// tunnel-manager 是唯一能開公開網址的容器，所以它的邊界要比其他服務更窄：
// 不放 Bot Token、不掛 data 與 Docker socket、不對主機開放連接埠、不是 privileged。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (name: string) => fs.readFileSync(path.join(ROOT, name), 'utf8');

// 釘版值來自 2026-11-17 實測：GitHub release asset 的 digest 與本機下載後 sha256sum 相同，`--version` 為 2026.11.0。
const CLOUDFLARED_VERSION = '2026.11.0';
const CLOUDFLARED_SHA256 = '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd';
const CLOUDFLARED_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`;
const KEY_DIR = '/run/telenexus-tunnel';

type Service = {
  image?: string;
  build?: unknown;
  command?: string[];
  env_file?: unknown;
  environment?: Record<string, unknown>;
  ports?: unknown[];
  volumes?: string[];
  privileged?: boolean;
  network_mode?: string;
  security_opt?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  init?: boolean;
  restart?: string;
  healthcheck?: unknown;
  mem_limit?: string;
  pids_limit?: number;
};
type Compose = { services: Record<string, Service>; volumes?: Record<string, unknown> };

const load = (name: string) => yaml.load(read(name)) as Compose;

function instructions(text: string): string[] {
  return text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

test('Dockerfile base stage 以固定版本下載 cloudflared，同一條 RUN 先驗 sha256 再安裝到 /usr/local/bin', () => {
  const dockerfile = read('Dockerfile');
  const base = dockerfile.split('FROM node:22-slim AS base')[1]?.split('FROM base AS dev')[0] ?? '';
  const runs = instructions(base).filter(
    (line) => line.startsWith('RUN ') && line.includes('cloudflared')
  );
  assert.equal(runs.length, 1, '安裝 cloudflared 的 RUN 只能有一條');
  const run = runs[0] ?? '';
  assert.ok(run.includes(CLOUDFLARED_URL), '下載固定版本的 linux-amd64 binary');
  assert.ok(run.includes(CLOUDFLARED_SHA256), '寫死 sha256');
  assert.match(run, /sha256sum -c/);
  assert.match(run, /\/usr\/local\/bin\/cloudflared/);
  assert.ok(
    run.indexOf('sha256sum -c') < run.indexOf('/usr/local/bin/cloudflared'),
    '先驗雜湊再放進 PATH'
  );
  for (const line of instructions(dockerfile).filter((l) => /cloudflared/i.test(l))) {
    assert.doesNotMatch(line, /releases\/latest/);
    assert.doesNotMatch(line, /\|\s*(ba)?sh\b/);
    assert.doesNotMatch(line, /apt-get install[^&]*cloudflared/);
  }
});

for (const filename of ['docker-compose.yml', 'docker-compose.release.yml']) {
  test(`${filename}：tunnel-manager 沿用主映像，只執行 dist/tunnel-manager.js`, () => {
    const { services } = load(filename);
    const tm = services['tunnel-manager'];
    const main = services.telenexus!;
    assert.ok(tm, '要有 tunnel-manager 服務');
    assert.deepEqual(tm.command, ['node', 'dist/tunnel-manager.js']);
    if (filename === 'docker-compose.release.yml') {
      assert.equal(tm.image, main.image, '與 telenexus 同一個映像，release.yml 不需另建');
    } else {
      assert.deepEqual(tm.build, main.build, '與 telenexus 同一份建置設定');
    }
    assert.equal(tm.init, true);
    assert.equal(tm.restart, 'unless-stopped');
    assert.ok(tm.healthcheck, '要有 healthcheck');
    assert.ok(tm.mem_limit, '要有記憶體上限');
    assert.ok(tm.pids_limit, '要有 pids 上限');
  });

  test(`${filename}：tunnel-manager 不開主機連接埠、不放 Bot Token、不掛 data 與 Docker socket、不是 privileged`, () => {
    const tm = load(filename).services['tunnel-manager']!;
    assert.equal(tm.ports, undefined, '不能有 ports:');
    assert.equal(tm.env_file, undefined, '不讀 .env（.env 有 Bot Token）');
    assert.notEqual(tm.privileged, true);
    assert.equal(tm.network_mode, undefined, '不用 host 網路');
    const env = tm.environment ?? {};
    for (const key of [
      'TELEGRAM_TOKEN',
      'ALLOWED_USER_ID',
      'RUNNER_SHARED_SECRET',
      'WEB_AUTH_TOKEN'
    ]) {
      assert.equal(key in env, false, `環境變數不能有 ${key}`);
    }
    const volumes = tm.volumes ?? [];
    assert.deepEqual(volumes, [`tunnel_key:${KEY_DIR}`], '只掛金鑰 volume');
    assert.ok(tm.security_opt?.includes('no-new-privileges:true'));
    assert.deepEqual(tm.cap_drop, ['ALL']);
    // init 以 root 轉送 SIGTERM 給非 root 主程序需要 KILL，否則 docker stop 會直接殺掉 cloudflared
    assert.deepEqual(tm.cap_add, ['CHOWN', 'SETUID', 'SETGID', 'FOWNER', 'DAC_OVERRIDE', 'KILL']);
    assert.equal(env.TUNNEL_KEY_FILE, `${KEY_DIR}/key`);
    assert.equal(env.TUNNEL_TARGET_URL, 'http://telenexus:3040');
  });

  test(`${filename}：telenexus 以唯讀掛金鑰、面板只在容器網路上，agent-runner 拿不到金鑰`, () => {
    const { services, volumes } = load(filename);
    const main = services.telenexus!;
    const runner = services['agent-runner']!;
    const env = main.environment ?? {};
    assert.equal(env.PANEL_BIND, '0.0.0.0', 'tunnel-manager 要從容器網路連到面板');
    assert.equal(env.PANEL_PORT, '3040');
    assert.equal(env.TUNNEL_MANAGER_URL, 'http://tunnel-manager:8790');
    assert.equal(env.TUNNEL_KEY_FILE, `${KEY_DIR}/key`);
    // 面板連接埠不對主機開放：ports 只有 Web Console
    assert.deepEqual(main.ports, ['${WEB_PORT:-3030}:${WEB_PORT:-3030}']);
    assert.ok(main.volumes?.includes(`tunnel_key:${KEY_DIR}:ro`), 'telenexus 唯讀掛金鑰');
    // telenexus 自己定義 volumes 會蓋掉共用清單，所以要確認共用的掛載一個都沒少
    for (const v of runner.volumes ?? []) {
      assert.ok(main.volumes?.includes(v), `telenexus 少了共用掛載 ${v}`);
    }
    assert.equal(
      (runner.volumes ?? []).some((v) => v.startsWith('tunnel_key:')),
      false,
      'agent-runner 不掛金鑰'
    );
    assert.ok(volumes && 'tunnel_key' in volumes, '頂層宣告 tunnel_key volume');
  });
}

test('release.yml 打包時的 sed 會把 tunnel-manager 的映像一起釘成版本號', () => {
  const workflow = read('.github/workflows/release.yml');
  const imageMain = /IMAGE_MAIN:\s*(\S+)/.exec(workflow)?.[1];
  const imageMemoria = /IMAGE_MEMORIA:\s*(\S+)/.exec(workflow)?.[1];
  assert.ok(imageMain && imageMemoria);
  assert.match(workflow, /sed -e "s\|\$\{IMAGE_MAIN\}:latest\|\$\{IMAGE_MAIN\}:\$\{VERSION\}\|"/);
  // 與 workflow 相同的替換（每行一次，不帶 g）
  const pinned = read('docker-compose.release.yml')
    .split('\n')
    .map((line) =>
      line
        .replace(`${imageMain}:latest`, `${imageMain}:v9.9.9`)
        .replace(`${imageMemoria}:latest`, `${imageMemoria}:v9.9.9`)
    )
    .join('\n');
  const imageLines = pinned.split('\n').filter((line) => /^\s*image:/.test(line));
  assert.equal(
    imageLines.length,
    4,
    '共用設定（telenexus 與 agent-runner）、tunnel-manager、memoria、memoria-ui'
  );
  for (const line of imageLines) assert.doesNotMatch(line, /:latest\b/);
  const services = (yaml.load(pinned) as Compose).services;
  assert.equal(services['tunnel-manager']?.image, `${imageMain}:v9.9.9`);
});

test('entrypoint 讓 node 使用者擁有金鑰目錄（PUID/PGID 對齊後），唯讀掛載時不中斷', () => {
  const entrypoint = read('scripts/docker-entrypoint.sh');
  assert.match(entrypoint, /TUNNEL_KEY_FILE/);
  const block = entrypoint.slice(entrypoint.indexOf('TUNNEL_KEY_FILE'));
  assert.match(block, /chown node:node "\$key_dir" 2>\/dev\/null \|\| true/);
  assert.ok(
    entrypoint.indexOf('TUNNEL_KEY_FILE') < entrypoint.indexOf('exec gosu node'),
    '在降權之前處理'
  );
});

test('.env.example 說明面板開關；連接埠由 compose 固定，不放進 .env', () => {
  const example = read('.env.example');
  assert.match(example, /^PANEL_ENABLED=true$/m);
  assert.match(example, /3040/);
  assert.doesNotMatch(example, /^PANEL_PORT=/m);
});
