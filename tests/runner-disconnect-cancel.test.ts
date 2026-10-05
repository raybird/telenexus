import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const endpoint of ['/run', '/run/stream']) {
  test(`SCN-003 runner ${endpoint} 斷線會停止真正執行中的子程序`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-runner-cancel-'));
    fs.mkdirSync(path.join(root, 'workspace'));
    const marker = path.join(root, 'opencode.pid');
    fs.writeFileSync(
      path.join(root, 'opencode'),
      `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.CANCEL_TEST_PID, String(process.pid));
setInterval(() => {}, 1000);
`,
      { mode: 0o700 }
    );
    const runner = spawn(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        fileURLToPath(new URL('../src/runner.ts', import.meta.url))
      ],
      {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          APP_PROJECT_DIR: root,
          RUNNER_PORT: '0',
          RUNNER_SHARED_SECRET: '',
          MODEL_HEALTH_CHECK_ENABLED: 'false',
          CANCEL_TEST_PID: marker,
          PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let output = '';
    runner.stdout.on('data', (chunk) => {
      output += chunk;
    });
    runner.stderr.on('data', (chunk) => {
      output += chunk;
    });
    let req: http.ClientRequest | undefined;
    let childPid: number | undefined;
    try {
      // 2026-10-04：port=0 的 logger 印的是設定值，從 /proc TCP listener 取得真分配埠。
      let port = 0;
      for (let attempt = 0; attempt < 100 && !port; attempt++) {
        await delay(30);
        if (runner.exitCode !== null) throw new Error(output);
        const sockets = fs.readdirSync(`/proc/${runner.pid}/fd`).flatMap((fd) => {
          try {
            return [fs.readlinkSync(`/proc/${runner.pid}/fd/${fd}`)];
          } catch {
            return [];
          }
        });
        const rows = fs.readFileSync(`/proc/${runner.pid}/net/tcp`, 'utf8').split('\n');
        for (const row of rows) {
          const fields = row.trim().split(/\s+/);
          if (fields[3] === '0A' && sockets.includes(`socket:[${fields[9]}]`)) {
            port = Number.parseInt(fields[1]!.split(':')[1]!, 16);
          }
        }
      }
      assert.ok(port, `runner 必須真的啟動：${output}`);
      req = http.request({ hostname: '127.0.0.1', port, path: endpoint, method: 'POST' });
      req.on('error', () => {});
      req.on('response', (res) => res.resume());
      req.end(JSON.stringify({ task: 'chat', input: 'fixture', forceNewSession: true }));
      for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt++) await delay(20);
      assert.ok(fs.existsSync(marker), '目標子程序必須確實開始，不以無程序充當成功');
      childPid = Number(fs.readFileSync(marker, 'utf8'));
      req.destroy();
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(childPid, 0);
        } catch {
          alive = false;
          break;
        }
        await delay(20);
      }
      assert.equal(alive, false, 'HTTP 斷線後子程序仍存活，取消訊號未送到 OpenCode');
      assert.equal(runner.exitCode, null, '不能靠關閉 runner 通過收尾');
    } finally {
      req?.destroy();
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {}
      }
      if (runner.pid) {
        try {
          process.kill(-runner.pid, 'SIGTERM');
        } catch {}
      }
      await new Promise<void>((resolve) =>
        runner.exitCode !== null ? resolve() : runner.once('exit', () => resolve())
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
