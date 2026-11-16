import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/core/memory.js';
import { Scheduler } from '../src/core/scheduler.js';
import type { AIAgent } from '../src/core/agent.js';
import type { AgentStructuredResult } from '../src/core/agent-result.js';
import type { Connector, FoldedReply } from '../src/types/index.js';
import type { MemoriaSyncTurn } from '../src/core/memoria-sync.js';

/**
 * Issue 0028 SCN-011、SCN-012、SCN-009：排程結果走與聊天相同的摺疊版面與 MarkdownV2，
 * 重試判斷、記憶與 Memoria 同步仍用全文。
 */
async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-scheduler-folded-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  try {
    return await fn();
  } finally {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

type Recorder = { folded: FoldedReply[]; sent: string[] };

function createConnector(withFolded: boolean): Connector & Recorder {
  const folded: FoldedReply[] = [];
  const sent: string[] = [];
  const connector: Connector & Recorder = {
    name: 'test',
    folded,
    sent,
    async initialize() {},
    async sendMessage(_chatId, text) {
      sent.push(text);
    },
    async sendFile() {},
    async sendPlaceholder() {
      return 'ph';
    },
    async editMessage() {},
    onMessage() {}
  };
  if (withFolded) {
    connector.sendFoldedReply = async (_chatId, reply) => {
      folded.push(reply);
    };
  }
  return connector;
}

function createAgent(results: AgentStructuredResult[]): AIAgent & { prompts: number } {
  const agent = {
    prompts: 0,
    async chat(): Promise<string> {
      throw new Error('排程應改用 chatStructured');
    },
    async chatStructured(): Promise<AgentStructuredResult> {
      const result = results[Math.min(agent.prompts, results.length - 1)]!;
      agent.prompts += 1;
      return result;
    },
    async summarize(text: string): Promise<string> {
      return text;
    }
  };
  return agent;
}

async function runSchedule(
  agent: AIAgent,
  connector: Connector
): Promise<{ synced: MemoriaSyncTurn[]; stored: string[] }> {
  const memory = new MemoryManager();
  const synced: MemoriaSyncTurn[] = [];
  const scheduler = new Scheduler(memory, agent, connector, (turn) => synced.push(turn));
  try {
    const id = scheduler.addSchedule('user-a', 'Crypto Monitor', '0 9 * * 1-5', '看盤');
    const schedule = memory.getScheduleById(id);
    assert.ok(schedule);
    await (scheduler as unknown as { executeTask(s: unknown): Promise<void> }).executeTask(
      schedule
    );
    const stored = memory
      .getRecentMessages('user-a', 10)
      .filter((message) => message.role === 'model')
      .map((message) => message.content);
    return { synced, stored };
  } finally {
    scheduler.shutdown();
  }
}

const withProcess: AgentStructuredResult = {
  provider: 'opencode',
  text: '[Opencode] 數據已到手。BTC 偏弱整理。',
  replyParts: { process: ['數據已到手。'], conclusion: '[Opencode] BTC 偏弱整理。' }
};

test('SCN-011：有過程的排程結果，標頭在第一行、結論在前、過程摺疊', async () => {
  await withTempDb(async () => {
    const connector = createConnector(true);
    const { synced, stored } = await runSchedule(createAgent([withProcess]), connector);

    assert.deepEqual(connector.folded, [
      {
        header: '🕐 [排程: Crypto Monitor]',
        conclusion: '[Opencode] BTC 偏弱整理。',
        process: ['數據已到手。']
      }
    ]);
    assert.deepEqual(connector.sent, []);
    // SCN-009：記憶與 Memoria 同步收到全文。
    assert.deepEqual(stored, [withProcess.text]);
    assert.equal(synced[0]?.modelMessage, withProcess.text);
  });
});

test('SCN-012：沒有過程的排程結果也走 MarkdownV2 版面，不產生過程', async () => {
  await withTempDb(async () => {
    const connector = createConnector(true);
    const plain: AgentStructuredResult = { provider: 'opencode', text: '[Opencode] 報告全文' };
    await runSchedule(createAgent([plain]), connector);

    assert.deepEqual(connector.folded, [
      { header: '🕐 [排程: Crypto Monitor]', conclusion: '[Opencode] 報告全文', process: [] }
    ]);
    assert.deepEqual(connector.sent, []);
  });
});

test('SCN-009：重試判斷看全文，重試後送出的是第二次的結果', async () => {
  await withTempDb(async () => {
    const connector = createConnector(true);
    const agent = createAgent([
      { provider: 'opencode', text: 'Error calling Opencode: upstream reset' },
      withProcess
    ]);
    const { stored } = await runSchedule(agent, connector);

    assert.equal(agent.prompts, 2, '第一次的全文是錯誤訊息，應重試');
    assert.deepEqual(connector.folded, [
      {
        header: '🕐 [排程: Crypto Monitor]',
        conclusion: '[Opencode] BTC 偏弱整理。',
        process: ['數據已到手。']
      }
    ]);
    assert.deepEqual(stored, [withProcess.text]);
  });
});

test('連接器沒有 sendFoldedReply 時照舊送標頭加全文', async () => {
  await withTempDb(async () => {
    const connector = createConnector(false);
    await runSchedule(createAgent([withProcess]), connector);
    assert.deepEqual(connector.sent, [`🕐 [排程: Crypto Monitor]\n\n${withProcess.text}`]);
  });
});
