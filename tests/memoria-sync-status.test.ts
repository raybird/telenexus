import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoriaSyncBridge } from '../src/core/memoria-sync.js';

function withTempProject<T>(fn: (projectDir: string) => T): T {
  const prevProjectDir = process.env.GEMINI_PROJECT_DIR;
  const prevMemoriaHome = process.env.MEMORIA_HOME;
  const prevMode = process.env.MEMORIA_SYNC_ENABLED;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-memoria-status-'));

  try {
    process.env.GEMINI_PROJECT_DIR = tempDir;
    process.env.MEMORIA_HOME = path.join(tempDir, 'workspace', 'Memoria');
    return fn(tempDir);
  } finally {
    if (prevProjectDir === undefined) delete process.env.GEMINI_PROJECT_DIR;
    else process.env.GEMINI_PROJECT_DIR = prevProjectDir;
    if (prevMemoriaHome === undefined) delete process.env.MEMORIA_HOME;
    else process.env.MEMORIA_HOME = prevMemoriaHome;
    if (prevMode === undefined) delete process.env.MEMORIA_SYNC_ENABLED;
    else process.env.MEMORIA_SYNC_ENABLED = prevMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
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
