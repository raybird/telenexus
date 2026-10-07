import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/core/memory.js';

/**
 * Issue 0012 SCN-007:「近期對話」只列聊天的使用者訊息與回覆,不列排程輸出。
 *
 * 排程輸出以 role=model 寫進同一張表、沒有對應的 user 列,文字也沒有一致的前綴。
 * 規則:user 一律算聊天;model 只有在同一使用者的前一筆是 user 時才算聊天回覆。
 * 這條規則對上線前的既有資料一樣適用,不需要回填。
 */

function withMemory(fn: (memory: MemoryManager) => void): void {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-recent-chat-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  try {
    fn(new MemoryManager());
  } finally {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function contents(memory: MemoryManager, userId: string, limit = 10): string[] {
  return memory.getRecentConversation(userId, limit).map((item) => `${item.role}:${item.content}`);
}

test('SCN-007: 聊天與排程交錯時,只列出聊天訊息與它的回覆', () => {
  withMemory((memory) => {
    memory.addMessage('u', 'model', '📅 [每日摘要] 昨天的摘要');
    memory.addMessage('u', 'user', '清理殭屍程序');
    memory.addMessage('u', 'model', '已檢查,沒有殘留');
    memory.addMessage('u', 'model', '[Opencode] ## 早安市場分析');
    memory.addMessage('u', 'model', '🔔 [追蹤提醒] 尚未解決的問題');
    memory.addMessage('u', 'user', '那再查一次技能');
    memory.addMessage('u', 'model', '沒有可用的技能');
    memory.addMessage('u', 'model', '晚間市場動態');

    assert.deepEqual(contents(memory, 'u'), [
      'user:清理殭屍程序',
      'model:已檢查,沒有殘留',
      'user:那再查一次技能',
      'model:沒有可用的技能'
    ]);
  });
});

test('SCN-007: 只有排程輸出時,近期對話是空的', () => {
  withMemory((memory) => {
    memory.addMessage('u', 'model', '早安市場分析');
    memory.addMessage('u', 'model', '晚間市場動態');
    assert.deepEqual(contents(memory, 'u'), []);
  });
});

test('SCN-007: 沒有任何訊息時回傳空陣列', () => {
  withMemory((memory) => {
    assert.deepEqual(contents(memory, 'u'), []);
  });
});

test('SCN-007: limit 取最近的聊天訊息,依時間先後排列', () => {
  withMemory((memory) => {
    memory.addMessage('u', 'user', '第一題');
    memory.addMessage('u', 'model', '第一題的回覆');
    memory.addMessage('u', 'model', '排程輸出');
    memory.addMessage('u', 'user', '第二題');
    memory.addMessage('u', 'model', '第二題的回覆');
    assert.deepEqual(contents(memory, 'u', 3), [
      'model:第一題的回覆',
      'user:第二題',
      'model:第二題的回覆'
    ]);
  });
});

test('SCN-007: 前一筆的判斷只看同一位使用者', () => {
  withMemory((memory) => {
    memory.addMessage('a', 'user', 'A 的問題');
    memory.addMessage('b', 'model', 'B 的排程輸出');
    memory.addMessage('a', 'model', 'A 的回覆');
    assert.deepEqual(contents(memory, 'a'), ['user:A 的問題', 'model:A 的回覆']);
    assert.deepEqual(contents(memory, 'b'), []);
  });
});

test('SCN-007 已知限制: 聊天回合進行中寫入的排程輸出會被當成回覆', () => {
  // 聊天回合還沒結束時排程先寫入,規則只看前一筆,所以排程輸出被當成回覆,
  // 真正的回覆因為前一筆不是 user 而被排除。誤判率見 evidence/step5-recent-conversation-inventory.md。
  withMemory((memory) => {
    memory.addMessage('u', 'user', '問題');
    memory.addMessage('u', 'model', '排程輸出');
    memory.addMessage('u', 'model', '真正的回覆');
    assert.deepEqual(contents(memory, 'u'), ['user:問題', 'model:排程輸出']);
  });
});
