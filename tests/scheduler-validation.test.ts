import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemoryManager } from '../src/core/memory.js';
import { Scheduler } from '../src/core/scheduler.js';
import type { AIAgent } from '../src/core/agent.js';
import type { Connector } from '../src/types/index.js';

function withTempDb<T>(fn: () => T): T {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-scheduler-test-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');

  try {
    return fn();
  } finally {
    if (prevDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = prevDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createAgentStub(): AIAgent {
  return {
    async chat(): Promise<string> {
      return 'ok';
    },
    async summarize(text: string): Promise<string> {
      return text;
    }
  };
}

function createCountingAgentStub(counter: { chatCalls: number }): AIAgent {
  return {
    async chat(): Promise<string> {
      counter.chatCalls += 1;
      return 'ok';
    },
    async summarize(text: string): Promise<string> {
      return text;
    }
  };
}

function createConnectorStub(): Connector {
  return {
    name: 'test',
    async initialize(): Promise<void> {
      return;
    },
    async sendMessage(): Promise<void> {
      return;
    },
    async sendPlaceholder(): Promise<string> {
      return 'placeholder-id';
    },
    async editMessage(): Promise<void> {
      return;
    },
    onMessage(): void {
      return;
    }
  };
}

test('Scheduler validates cron input and supports schedule update', () => {
  withTempDb(() => {
    const memory = new MemoryManager();
    const scheduler = new Scheduler(memory, createAgentStub(), createConnectorStub());

    assert.throws(() => {
      scheduler.addSchedule('user-a', 'invalid', '*/5 * *', 'test prompt');
    }, /5 fields/);

    const scheduleId = scheduler.addSchedule('user-a', 'daily-report', '0 9 * * 1-5', 'old prompt');

    assert.throws(() => {
      scheduler.updateSchedule('user-a', scheduleId, 'daily-report', 'invalid cron', 'new prompt');
    }, /Invalid cron expression|5 fields/);

    const updated = scheduler.updateSchedule(
      'user-a',
      scheduleId,
      'global-market-report',
      '30 8 * * 1-5',
      'new prompt'
    );

    assert.equal(updated.name, 'global-market-report');
    assert.equal(updated.cron, '30 8 * * 1-5');
    assert.equal(updated.prompt, 'new prompt');

    assert.throws(() => {
      scheduler.updateSchedule('user-b', scheduleId, 'x', '0 9 * * *', 'x');
    }, /does not belong/);

    scheduler.shutdown();
  });
});

test('Scheduler keeps only one silence timer when reflection re-schedules', async () => {
  await withTempDb(async () => {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    let id = 0;
    const activeTimers = new Set<number>();
    const clearedTimers: number[] = [];

    (global as any).setTimeout = (_fn: (...args: any[]) => void, _delay?: number) => {
      id += 1;
      activeTimers.add(id);
      return id as unknown as NodeJS.Timeout;
    };

    (global as any).clearTimeout = (timer: NodeJS.Timeout) => {
      const timerId = Number(timer);
      clearedTimers.push(timerId);
      activeTimers.delete(timerId);
    };

    try {
      const memory = new MemoryManager();
      const scheduler = new Scheduler(memory, createAgentStub(), createConnectorStub());

      memory.addMessage('user-a', 'user', 'follow-up me');
      scheduler.resetSilenceTimer('user-a');

      await scheduler.triggerReflection('user-a', 'silence');

      assert.equal(activeTimers.size, 1);
      assert.ok(clearedTimers.length >= 1);

      scheduler.shutdown();
    } finally {
      (global as any).setTimeout = originalSetTimeout;
      (global as any).clearTimeout = originalClearTimeout;
    }
  });
});

test('Scheduler skips repeated silence reflection when no user reply after follow-up', async () => {
  await withTempDb(async () => {
    const counter = { chatCalls: 0 };
    const memory = new MemoryManager();
    const scheduler = new Scheduler(memory, createCountingAgentStub(counter), createConnectorStub());

    memory.addMessage('user-a', 'user', 'follow-up me');

    await scheduler.triggerReflection('user-a', 'silence');
    await scheduler.triggerReflection('user-a', 'silence');

    assert.equal(counter.chatCalls, 1);

    scheduler.shutdown();
  });
});
