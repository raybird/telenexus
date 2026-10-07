import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/core/memory.js';
import { buildMemoryContext, buildMemoryContextAsync } from '../src/prompt/builder.js';

/**
 * Issue 0012 SCN-006:接續綁定的 session 時,最近幾回合本來就在 session 裡,
 * 記憶區塊不再放「近期對話」段;開新 session 時照舊放。
 */

function withMemory(fn: (memory: MemoryManager) => Promise<void>): Promise<void> {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-recent-skip-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  const memory = new MemoryManager();
  memory.addMessage('u', 'user', '幫我整理 release 流程');
  memory.addMessage('u', 'model', '已整理 release SOP');
  return fn(memory).finally(() => {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

const RECALLED = '上次決定 release 前先跑 npm run test';
const recallFn = async (): Promise<string[]> => [RECALLED];

test('SCN-006: 開新 session 時(預設)含「近期對話」段', async () => {
  await withMemory(async (memory) => {
    assert.match(buildMemoryContext(memory, 'u', 'release 怎麼做'), /【近期對話】/);
    assert.match(
      await buildMemoryContextAsync(memory, 'u', 'release 怎麼做', recallFn),
      /【近期對話】/
    );
  });
});

test('SCN-006: 接續綁定的 session 時不含「近期對話」段(本機 SAR 路徑)', async () => {
  await withMemory(async (memory) => {
    const context = buildMemoryContext(memory, 'u', 'release 怎麼做', {
      includeRecentConversation: false
    });
    assert.doesNotMatch(context, /【近期對話】/);
    assert.doesNotMatch(context, /已整理 release SOP/);
  });
});

test('SCN-006: 接續綁定的 session 時不含「近期對話」段,Memoria 召回照常保留', async () => {
  await withMemory(async (memory) => {
    const context = await buildMemoryContextAsync(memory, 'u', 'release 怎麼做', recallFn, {
      includeRecentConversation: false
    });
    assert.doesNotMatch(context, /【近期對話】/);
    assert.match(context, /【相關歷史摘要】/);
    assert.ok(context.includes(RECALLED));
  });
});
