import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoriaSyncBridge } from '../src/core/memoria-sync.js';

function withTempProject<T>(fn: (projectDir: string) => T | Promise<T>): T | Promise<T> {
  const prevProjectDir = process.env.APP_PROJECT_DIR;
  const prevMemoriaHome = process.env.MEMORIA_HOME;
  const prevMode = process.env.MEMORIA_SYNC_ENABLED;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-memoria-status-'));

  const finalize = () => {
    if (prevProjectDir === undefined) delete process.env.APP_PROJECT_DIR;
    else process.env.APP_PROJECT_DIR = prevProjectDir;
    if (prevMemoriaHome === undefined) delete process.env.MEMORIA_HOME;
    else process.env.MEMORIA_HOME = prevMemoriaHome;
    if (prevMode === undefined) delete process.env.MEMORIA_SYNC_ENABLED;
    else process.env.MEMORIA_SYNC_ENABLED = prevMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    process.env.APP_PROJECT_DIR = tempDir;
    process.env.MEMORIA_HOME = path.join(tempDir, 'workspace', 'Memoria');
    const result = fn(tempDir);
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).finally(finalize);
    }
    finalize();
    return result;
  } finally {
    // async path finalizes via Promise.finally; sync path finalized above.
  }
}

test('MemoriaSyncBridge reports disabled status when auto mode and cli is missing', () => {
  withTempProject(() => {
    process.env.MEMORIA_SYNC_ENABLED = 'auto';
    const bridge = new MemoriaSyncBridge();
    const status = bridge.getStatus();

    assert.equal(status.mode, 'auto');
    assert.equal(status.available, false);
    assert.equal(status.disabled, true);
    assert.equal(status.cliDetected, false);
    assert.equal(status.recentFailureCount, 0);
    assert.equal(status.lastSyncAt, null);
  });
});

test('MemoriaSyncBridge notifies status change after successful sync', async () => {
  await withTempProject(async (projectDir) => {
    process.env.MEMORIA_SYNC_ENABLED = 'on';
    const memoriaHome = path.join(projectDir, 'workspace', 'Memoria');
    fs.mkdirSync(memoriaHome, { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'workspace', 'temp', 'memoria-sync'), { recursive: true });
    const cliPath = path.join(memoriaHome, 'cli');
    fs.writeFileSync(
      cliPath,
      '#!/usr/bin/env bash\nif [ "$1" = "sync" ]; then exit 0; fi\nexit 1\n',
      'utf8'
    );
    fs.chmodSync(cliPath, 0o755);

    let callbackCount = 0;
    let latestAvailable = false;
    const bridge = new MemoriaSyncBridge({
      projectDir,
      mode: 'on',
      onStatusChange(status) {
        callbackCount += 1;
        latestAvailable = status.available;
      }
    });

    bridge.enqueueTurn({
      userId: 'user-a',
      userMessage: '記住這條規則',
      modelMessage: '好的，我會保留這條規則。',
      platform: 'console',
      isPassthroughCommand: false,
      forceNewSession: false
    });
    await bridge.whenIdle();

    const status = bridge.getStatus();
    assert.ok(callbackCount >= 1);
    assert.equal(latestAvailable, true);
    assert.ok(typeof status.lastSyncAt === 'number');
    assert.equal(status.recentFailureCount, 0);
  });
});
