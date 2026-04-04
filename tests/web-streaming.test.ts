import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWebServer } from '../src/web/server.js';
import { MemoryManager } from '../src/core/memory.js';
import type { AIAgent, AIAgentOptions } from '../src/core/agent.js';
import type { AgentEvent, AgentStructuredResult } from '../src/core/agent-result.js';

function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-web-stream-test-'));
  const dbPath = path.join(tempDir, 'test.db');
  process.env.DB_PATH = dbPath;

  return fn().finally(() => {
    if (prevDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = prevDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

class StreamingAgentStub implements AIAgent {
  async chat(): Promise<string> {
    return 'fallback chat';
  }

  async summarize(): Promise<string> {
    return 'summary';
  }

  async streamChat(
    _prompt: string,
    _options: AIAgentOptions | undefined,
    onEvent: (event: AgentEvent) => Promise<void> | void
  ): Promise<AgentStructuredResult> {
    await onEvent({ type: 'start', provider: 'gemini' });
    await onEvent({ type: 'delta', text: 'Hello' });
    await onEvent({ type: 'delta', text: ' world' });
    await onEvent({ type: 'usage', stats: { total_tokens: 12 } });
    await onEvent({ type: 'done', text: 'Hello world' });
    return {
      provider: 'gemini',
      text: 'Hello world',
      stats: { total_tokens: 12 }
    };
  }
}

async function readSseEvents(response: Response): Promise<Array<{ event: string; payload: any }>> {
  assert.ok(response.body, 'response body should exist');
  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  let buffer = '';
  const events: Array<{ event: string; payload: any }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let splitIndex = buffer.indexOf('\n\n');
    while (splitIndex !== -1) {
      const rawEvent = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      splitIndex = buffer.indexOf('\n\n');

      const lines = rawEvent.split('\n');
      let eventName = 'message';
      let dataText = '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataText += line.slice(5).trim();
        }
      }

      events.push({
        event: eventName,
        payload: dataText ? JSON.parse(dataText) : {}
      });
    }
  }

  return events;
}

test('web chat stream emits chunks before done and keeps final reply aligned', async () => {
  await withTempDb(async () => {
    const memory = new MemoryManager();
    const agent = new StreamingAgentStub();
    const port = 39231;
    const server = startWebServer({
      enabled: true,
      host: '127.0.0.1',
      port,
      trustPrivateNetwork: true,
      alertErrorThreshold: 10,
      alertRunnerSuccessWarnThreshold: 90,
      defaultUserId: 'web-user',
      commandRouter: {
        async handleMessage() {
          return false;
        },
        isPassthroughCommand() {
          return false;
        }
      } as never,
      memory,
      scheduler: {
        resetSilenceTimer() {}
      } as never,
      userAgent: agent,
      chatRunnerAgent: agent,
      useRunnerForChat: false,
      chatRunnerPercent: 0,
      chatRunnerOnlyUsers: new Set<string>(),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage) {
        return `PROMPT:${userMessage}`;
      },
      recordRuntimeIssue() {},
      writeContextSnapshots() {}
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test stream' })
      });

      assert.equal(response.status, 200);
      const events = await readSseEvents(response);
      const eventNames = events.map((item) => item.event);
      const chunkTexts = events
        .filter((item) => item.event === 'chunk')
        .map((item) => item.payload.text);
      const usageEvent = events.find((item) => item.event === 'usage');
      const doneEvent = events.find((item) => item.event === 'done');

      assert.ok(eventNames.includes('start'));
      assert.ok(eventNames.includes('chunk'));
      assert.ok(eventNames.includes('done'));
      assert.equal(chunkTexts.join(''), 'Hello world');
      assert.deepEqual(usageEvent?.payload, { stats: { total_tokens: 12 } });
      assert.equal(doneEvent?.payload.reply, 'Hello world');
      assert.ok(eventNames.indexOf('chunk') < eventNames.indexOf('done'));
    } finally {
      await server.close();
    }
  });
});
