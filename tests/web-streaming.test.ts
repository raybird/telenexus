import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWebServer } from '../src/web/server.js';
import { MARKER_ONLY_NOTICE } from '../src/core/message-pipeline-chat.js';
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
  constructor(private readonly deltas: string[] = ['Hello', ' world']) {}

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
    await onEvent({ type: 'start', provider: 'opencode' });
    for (const text of this.deltas) {
      await onEvent({ type: 'delta', text });
    }
    const fullText = this.deltas.join('');
    await onEvent({ type: 'usage', stats: { total_tokens: 12 } });
    await onEvent({ type: 'done', text: fullText });
    return {
      provider: 'opencode',
      text: fullText,
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

function startStubServer(agent: AIAgent, port: number) {
  return startWebServer({
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
    memory: new MemoryManager(),
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
}

test('web chat stream emits chunks before done and keeps final reply aligned', async () => {
  await withTempDb(async () => {
    const port = 39231;
    const server = startStubServer(new StreamingAgentStub(), port);

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

test('web chat stream 的片段與最終回覆都不含記憶標記', async () => {
  await withTempDb(async () => {
    const port = 39232;
    const server = startStubServer(
      new StreamingAgentStub([
        '這是正文',
        '\n\n[[MEMO',
        'RY_INTENT:{"level":"none","confidence":"high","reason":"無"}]]'
      ]),
      port
    );

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test marker' })
      });

      const events = await readSseEvents(response);
      const chunks = events
        .filter((item) => item.event === 'chunk')
        .map((item) => item.payload.text);
      assert.equal(chunks.join('').trimEnd(), '這是正文');
      assert.equal(events.find((item) => item.event === 'done')?.payload.reply, '這是正文');
    } finally {
      await server.close();
    }
  });
});

test('web chat stream 保留標記之後的正文', async () => {
  await withTempDb(async () => {
    const port = 39233;
    const marker = '[[MEMORY_INTENT:{"level":"none","confidence":"high","reason":"無"}]]';
    const server = startStubServer(new StreamingAgentStub([`我先查${marker}`, '\n\n結果']), port);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test marker body' })
      });

      const events = await readSseEvents(response);
      const reply = events.find((item) => item.event === 'done')?.payload.reply;
      assert.equal(reply, '我先查\n\n結果');
    } finally {
      await server.close();
    }
  });
});

test('web chat stream 回覆只有標記時回傳提示', async () => {
  await withTempDb(async () => {
    const port = 39234;
    const marker = '[[MEMORY_INTENT:{"level":"none","confidence":"high","reason":"無"}]]';
    const server = startStubServer(new StreamingAgentStub([marker]), port);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test marker only' })
      });

      const events = await readSseEvents(response);
      assert.equal(events.find((item) => item.event === 'done')?.payload.reply, MARKER_ONLY_NOTICE);
    } finally {
      await server.close();
    }
  });
});
