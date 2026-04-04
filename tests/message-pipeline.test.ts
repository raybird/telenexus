import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessagePipeline } from '../src/core/message-pipeline.js';
import { MemoryManager } from '../src/core/memory.js';
import {
  clearPromptSessionTraces,
  getRecentPromptSessionTraces
} from '../src/services/prompt-session-telemetry.js';
import {
  clearMemoryIntentTraces as clearIntentTelemetry,
  getRecentMemoryIntentTraces
} from '../src/services/memory-intent-telemetry.js';
import type { AIAgent } from '../src/core/agent.js';
import type { Connector, UnifiedMessage } from '../src/types/index.js';

type SentMessage = {
  chatId: string;
  text: string;
};

function withTempProject<T>(fn: (projectDir: string) => Promise<T> | T): Promise<T> | T {
  const prevCwd = process.cwd();
  const prevDbPath = process.env.DB_PATH;
  const prevProjectDir = process.env.GEMINI_PROJECT_DIR;
  const prevSummaryFollowup = process.env.SUMMARY_FOLLOWUP_ENABLED;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-message-pipeline-'));
  const dbPath = path.join(tempDir, 'test.db');

  fs.mkdirSync(path.join(tempDir, 'workspace', 'temp'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'workspace', 'reports'), { recursive: true });
  process.chdir(tempDir);
  process.env.DB_PATH = dbPath;
  process.env.GEMINI_PROJECT_DIR = tempDir;
  process.env.SUMMARY_FOLLOWUP_ENABLED = 'false';

  const finalize = () => {
    clearPromptSessionTraces();
    clearIntentTelemetry();
    process.chdir(prevCwd);
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    if (prevProjectDir === undefined) delete process.env.GEMINI_PROJECT_DIR;
    else process.env.GEMINI_PROJECT_DIR = prevProjectDir;
    if (prevSummaryFollowup === undefined) delete process.env.SUMMARY_FOLLOWUP_ENABLED;
    else process.env.SUMMARY_FOLLOWUP_ENABLED = prevSummaryFollowup;
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    const result = fn(tempDir);
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).finally(finalize);
    }
    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
}

function createConnectorRecorder() {
  const sentMessages: SentMessage[] = [];
  const sentFiles: Array<{ chatId: string; filePath: string; caption?: string }> = [];
  const placeholders: Array<{ chatId: string; text: string }> = [];
  const edits: Array<{ chatId: string; messageId: string; text: string }> = [];

  const connector: Connector = {
    name: 'test-connector',
    async initialize() {},
    async sendMessage(chatId, text) {
      sentMessages.push({ chatId, text });
    },
    async sendFile(chatId, filePath, caption) {
      sentFiles.push({ chatId, filePath, ...(caption ? { caption } : {}) });
    },
    async sendPlaceholder(chatId, text) {
      placeholders.push({ chatId, text });
      return `placeholder-${placeholders.length}`;
    },
    async editMessage(chatId, messageId, text) {
      edits.push({ chatId, messageId, text });
    },
    onMessage() {}
  };

  return { connector, sentMessages, sentFiles, placeholders, edits };
}

function createAgentStub(overrides: Partial<AIAgent> = {}): AIAgent {
  return {
    async chat() {
      return 'ok';
    },
    async summarize(text: string) {
      return `summary:${text}`;
    },
    ...overrides
  };
}

function createMessage(content: string, overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: overrides.id || `msg-${Date.now()}`,
    chatId: overrides.chatId || 'chat-1',
    content,
    sender: overrides.sender || {
      id: 'user-a',
      name: 'Raybird',
      platform: 'telegram'
    },
    timestamp: overrides.timestamp || Date.now(),
    ...(overrides.attachments ? { attachments: overrides.attachments } : {}),
    ...(overrides.raw ? { raw: overrides.raw } : {})
  };
}

test('message pipeline merges pending images and only auto-sends files from workspace/temp', async () => {
  await withTempProject(async (projectDir) => {
    const validFile = path.join(projectDir, 'workspace', 'temp', 'report.txt');
    const invalidFile = path.join(projectDir, 'workspace', 'reports', 'notes.txt');
    fs.writeFileSync(validFile, 'report', 'utf8');
    fs.writeFileSync(invalidFile, 'notes', 'utf8');

    const { connector, sentMessages, sentFiles, placeholders, edits } = createConnectorRecorder();
    const memory = new MemoryManager();
    const chatCalls: string[] = [];
    const buildPromptModes: Array<'full' | 'compact' | 'minimal'> = [];
    const enqueueTurns: Array<{ userMessage: string; modelMessage: string }> = [];

    const pipeline = createMessagePipeline({
      connector,
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
      userAgent: createAgentStub({
        async chat(prompt) {
          chatCalls.push(prompt);
          return [
            '分析完成。',
            '[[SEND_FILE: workspace/temp/report.txt | 分析報告]]',
            '[[SEND_FILE: workspace/reports/notes.txt | 不應自動送出]]'
          ].join('\n');
        }
      }),
      chatRunnerAgent: createAgentStub(),
      useRunnerForChat: false,
      chatRunnerPercent: 100,
      chatRunnerOnlyUsers: new Set(),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage, _userId, mode = 'full') {
        buildPromptModes.push(mode);
        return {
          prompt: `PROMPT:${userMessage}`,
          mode,
          memoryContextLength: 42,
          usedMemoryContext: true,
          memoryContextSectionCount: 3
        };
      },
      enqueueMemoriaSync(turn) {
        enqueueTurns.push({ userMessage: turn.userMessage, modelMessage: turn.modelMessage });
      },
      recordRuntimeIssue() {},
      writeContextSnapshots() {}
    });

    await pipeline(
      createMessage('使用者上傳了一張圖片', {
        id: 'img-1',
        attachments: [
          {
            kind: 'image',
            path: path.join(projectDir, 'workspace', 'temp', 'image.png'),
            fileName: 'image.png'
          }
        ]
      })
    );

    assert.equal(
      sentMessages[0]?.text,
      '📎 已收到圖片。請再傳一則文字描述你要我做的事，我會搭配圖片一起處理。'
    );
    assert.equal(chatCalls.length, 0);

    await pipeline(createMessage('幫我分析這張圖片'));

    assert.equal(chatCalls.length, 1);
    assert.match(chatCalls[0] || '', /PROMPT:幫我分析這張圖片/);
    assert.match(chatCalls[0] || '', /【使用者上傳圖片】/);
    assert.equal(buildPromptModes[0], 'full');
    assert.equal(placeholders.length, 1);
    assert.ok(edits.some((item) => item.text === '✅ 已完成，回覆如下：'));
    assert.ok(sentMessages.some((item) => item.text === '分析完成。'));
    assert.ok(
      sentMessages.some((item) =>
        item.text.includes(
          '檔案傳送略過：workspace/reports/notes.txt（自動回傳檔案僅允許 workspace/temp/ 路徑）'
        )
      )
    );
    assert.deepEqual(sentFiles, [{ chatId: 'chat-1', filePath: validFile, caption: '分析報告' }]);
    assert.deepEqual(enqueueTurns, [
      { userMessage: '幫我分析這張圖片', modelMessage: '分析完成。' }
    ]);
    const traces = getRecentPromptSessionTraces();
    assert.equal(traces.length, 1);
    assert.equal(traces[0]?.promptMode, 'full');
    assert.equal(traces[0]?.memoryContextLength, 42);
    assert.equal(traces[0]?.memoryContextSectionCount, 3);
    assert.equal(traces[0]?.channel, 'telegram');
  });
});

test('message pipeline reports agent errors and still delivers fallback response', async () => {
  await withTempProject(async () => {
    const { connector, sentMessages, placeholders, edits } = createConnectorRecorder();
    const memory = new MemoryManager();
    const runtimeIssues: string[] = [];

    const pipeline = createMessagePipeline({
      connector,
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
      userAgent: createAgentStub({
        async chat() {
          throw new Error('boom');
        }
      }),
      chatRunnerAgent: createAgentStub(),
      useRunnerForChat: false,
      chatRunnerPercent: 100,
      chatRunnerOnlyUsers: new Set(),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage) {
        return `PROMPT:${userMessage}`;
      },
      recordRuntimeIssue(scope) {
        runtimeIssues.push(scope);
      },
      writeContextSnapshots() {}
    });

    await pipeline(createMessage('這次會失敗'));

    assert.equal(placeholders.length, 1);
    assert.ok(edits.some((item) => item.text === '✅ 已完成，回覆如下：'));
    assert.ok(
      sentMessages.some(
        (item) => item.text === 'Sorry, I encountered an error while exercising my powers.'
      )
    );
    assert.deepEqual(runtimeIssues, ['message-processing']);
  });
});

test('message pipeline sends queue notice when another task is already running', async () => {
  await withTempProject(async () => {
    const { connector, sentMessages } = createConnectorRecorder();
    const memory = new MemoryManager();
    let gateResolved = false;
    let resolveGatePromise!: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      resolveGatePromise = () => {
        if (!gateResolved) {
          gateResolved = true;
          resolve();
        }
      };
    });

    const slowAgent = createAgentStub({
      async chat() {
        await gatePromise;
        return 'first response';
      }
    });

    const fastAgent = createAgentStub({
      async chat() {
        return 'second response';
      }
    });

    const pipeline = createMessagePipeline({
      connector,
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
      userAgent: slowAgent,
      chatRunnerAgent: fastAgent,
      useRunnerForChat: false,
      chatRunnerPercent: 100,
      chatRunnerOnlyUsers: new Set(),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage) {
        return `PROMPT:${userMessage}`;
      },
      recordRuntimeIssue() {},
      writeContextSnapshots() {}
    });

    const first = pipeline(createMessage('第一則，會卡住', { id: 'first' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = pipeline(createMessage('第二則，應顯示排隊', { id: 'second' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    resolveGatePromise();
    await first;
    await second;

    assert.ok(
      sentMessages.some((item) => item.text.includes('目前有任務執行中（來源：chat），已幫你排隊'))
    );
  });
});

test('message pipeline can route selected users to runner agent', async () => {
  await withTempProject(async () => {
    const { connector, sentMessages } = createConnectorRecorder();
    const memory = new MemoryManager();
    const localCalls: string[] = [];
    const runnerCalls: string[] = [];

    const pipeline = createMessagePipeline({
      connector,
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
      userAgent: createAgentStub({
        async chat(prompt) {
          localCalls.push(prompt);
          return 'local response';
        }
      }),
      chatRunnerAgent: createAgentStub({
        async chat(prompt) {
          runnerCalls.push(prompt);
          return 'runner response';
        }
      }),
      useRunnerForChat: true,
      chatRunnerPercent: 100,
      chatRunnerOnlyUsers: new Set(['user-a']),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage) {
        return `PROMPT:${userMessage}`;
      },
      recordRuntimeIssue() {},
      writeContextSnapshots() {}
    });

    await pipeline(createMessage('應走 runner', { id: 'runner-1' }));

    assert.equal(localCalls.length, 0);
    assert.equal(runnerCalls.length, 1);
    assert.ok(sentMessages.some((item) => item.text === 'runner response'));
  });
});

test('message pipeline uses minimal prompt mode for short follow-up messages', async () => {
  await withTempProject(async () => {
    const { connector, sentMessages } = createConnectorRecorder();
    const memory = new MemoryManager();
    const buildPromptModes: string[] = [];

    const pipeline = createMessagePipeline({
      connector,
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
      userAgent: createAgentStub({
        async chat() {
          return 'ok';
        }
      }),
      chatRunnerAgent: createAgentStub(),
      useRunnerForChat: false,
      chatRunnerPercent: 100,
      chatRunnerOnlyUsers: new Set(),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage, _userId, mode = 'full') {
        buildPromptModes.push(mode);
        return {
          prompt: `MODE:${mode}\n${userMessage}`,
          mode,
          memoryContextLength: mode === 'minimal' ? 0 : 20,
          usedMemoryContext: mode !== 'minimal',
          memoryContextSectionCount: mode === 'minimal' ? 0 : 1
        };
      },
      recordRuntimeIssue() {},
      writeContextSnapshots() {}
    });

    await pipeline(createMessage('先幫我整理重點', { id: 'm1' }));
    await pipeline(createMessage('再講詳細一點？', { id: 'm2' }));

    assert.deepEqual(buildPromptModes, ['full', 'minimal']);
    const traces = getRecentPromptSessionTraces();
    assert.equal(traces.length, 2);
    assert.equal(traces[1]?.promptMode, 'minimal');
    assert.equal(traces[1]?.memoryContextLength, 0);
    assert.ok(sentMessages.some((item) => item.text === 'ok'));
  });
});

test('message pipeline keeps compact mode but skips memory context for simple follow-up', async () => {
  await withTempProject(async () => {
    const { connector } = createConnectorRecorder();
    const memory = new MemoryManager();

    const pipeline = createMessagePipeline({
      connector,
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
      userAgent: createAgentStub({
        async chat() {
          return 'ok';
        }
      }),
      chatRunnerAgent: createAgentStub(),
      useRunnerForChat: false,
      chatRunnerPercent: 0,
      chatRunnerOnlyUsers: new Set(),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage, _userId, mode = 'full') {
        return {
          prompt: `MODE:${mode}\n${userMessage}`,
          mode,
          memoryContextLength: mode === 'compact' ? 0 : 30,
          usedMemoryContext: mode !== 'compact',
          memoryContextSectionCount: mode === 'compact' ? 0 : 1
        };
      },
      recordRuntimeIssue() {},
      writeContextSnapshots() {}
    });

    await pipeline(createMessage('第一輪先建立 session', { id: 'c1' }));
    await pipeline(createMessage('請繼續', { id: 'c2' }));
    await pipeline(createMessage('補充更多細節與背景說明，包含目前狀態與已知限制。', { id: 'c3' }));

    const traces = getRecentPromptSessionTraces();
    assert.equal(traces.length, 3);
    assert.equal(traces[1]?.promptMode, 'compact');
    assert.equal(traces[1]?.memoryContextLength, 0);
    assert.equal(traces[2]?.promptMode, 'compact');
    assert.equal(traces[2]?.memoryContextLength, 0);
  });
});

test('message pipeline keeps memory context in compact mode for historical rule lookup', async () => {
  await withTempProject(async () => {
    const { connector } = createConnectorRecorder();
    const memory = new MemoryManager();

    const pipeline = createMessagePipeline({
      connector,
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
      userAgent: createAgentStub({
        async chat() {
          return 'ok';
        }
      }),
      chatRunnerAgent: createAgentStub(),
      useRunnerForChat: false,
      chatRunnerPercent: 0,
      chatRunnerOnlyUsers: new Set(),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage, _userId, mode = 'full') {
        return {
          prompt: `MODE:${mode}\n${userMessage}`,
          mode,
          memoryContextLength:
            mode === 'compact' && /release SOP/i.test(userMessage)
              ? 80
              : mode === 'minimal'
                ? 0
                : 30,
          usedMemoryContext:
            mode !== 'minimal' && !(/請繼續/.test(userMessage) && mode === 'compact'),
          memoryContextSectionCount:
            mode === 'compact' && /release SOP/i.test(userMessage) ? 2 : mode === 'minimal' ? 0 : 1
        };
      },
      recordRuntimeIssue() {},
      writeContextSnapshots() {}
    });

    await pipeline(createMessage('第一輪先建立 session', { id: 'r1' }));
    await pipeline(createMessage('現在 release SOP 是什麼？', { id: 'r2' }));

    const traces = getRecentPromptSessionTraces();
    assert.equal(traces.length, 2);
    assert.equal(traces[1]?.promptMode, 'compact');
    assert.equal(traces[1]?.memoryContextLength, 80);
    assert.equal(traces[1]?.memoryContextSectionCount, 2);
  });
});

test('message pipeline observes memory intent and strips marker from delivered response', async () => {
  await withTempProject(async () => {
    const { connector, sentMessages } = createConnectorRecorder();
    const memory = new MemoryManager();

    const pipeline = createMessagePipeline({
      connector,
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
      userAgent: createAgentStub({
        async chat() {
          return '這是正文。\n\n[[MEMORY_INTENT:{"level":"decision","confidence":"high","reason":"使用者指定固定策略","summary":"keep shell as control plane"}]]';
        }
      }),
      chatRunnerAgent: createAgentStub(),
      useRunnerForChat: false,
      chatRunnerPercent: 0,
      chatRunnerOnlyUsers: new Set(),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage, _userId, mode = 'full') {
        return {
          prompt: `MODE:${mode}\n${userMessage}`,
          mode,
          memoryContextLength: 20,
          usedMemoryContext: true,
          memoryContextSectionCount: 1
        };
      },
      recordRuntimeIssue() {},
      writeContextSnapshots() {}
    });

    await pipeline(createMessage('請整理這輪策略', { id: 'mi-1' }));

    const intents = getRecentMemoryIntentTraces();
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.intent.level, 'decision');
    assert.ok(sentMessages.some((item) => item.text === '這是正文。'));
    assert.ok(!sentMessages.some((item) => /MEMORY_INTENT/.test(item.text)));
  });
});

test('message pipeline refreshes snapshots immediately after successful response', async () => {
  await withTempProject(async () => {
    const { connector } = createConnectorRecorder();
    const memory = new MemoryManager();
    let snapshotWrites = 0;

    const pipeline = createMessagePipeline({
      connector,
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
      userAgent: createAgentStub({
        async chat() {
          return 'ok';
        }
      }),
      chatRunnerAgent: createAgentStub(),
      useRunnerForChat: false,
      chatRunnerPercent: 0,
      chatRunnerOnlyUsers: new Set(),
      shouldSummarize() {
        return false;
      },
      buildPrompt(userMessage, _userId, mode = 'full') {
        return {
          prompt: `MODE:${mode}\n${userMessage}`,
          mode,
          memoryContextLength: 0,
          usedMemoryContext: false,
          memoryContextSectionCount: 0
        };
      },
      recordRuntimeIssue() {},
      writeContextSnapshots() {
        snapshotWrites += 1;
      }
    });

    await pipeline(createMessage('更新快照測試', { id: 'snap-1' }));

    assert.ok(snapshotWrites >= 1);
  });
});

test('message pipeline uses throttled telegram streaming renderer for telegram chats', async () => {
  await withTempProject(async () => {
    const prevStreamingEnabled = process.env.TELEGRAM_STREAMING_ENABLED;
    const prevThrottleMs = process.env.TELEGRAM_STREAM_EDIT_THROTTLE_MS;
    const prevMinDeltaChars = process.env.TELEGRAM_STREAM_MIN_DELTA_CHARS;
    const prevForceFlushMs = process.env.TELEGRAM_STREAM_FORCE_FLUSH_MS;
    const prevEarlyFlushChars = process.env.TELEGRAM_STREAM_EARLY_FLUSH_CHARS;

    process.env.TELEGRAM_STREAMING_ENABLED = 'true';
    process.env.TELEGRAM_STREAM_EDIT_THROTTLE_MS = '1';
    process.env.TELEGRAM_STREAM_MIN_DELTA_CHARS = '1';
    process.env.TELEGRAM_STREAM_FORCE_FLUSH_MS = '1';
    process.env.TELEGRAM_STREAM_EARLY_FLUSH_CHARS = '1';

    try {
      const { connector, sentMessages, placeholders, edits } = createConnectorRecorder();
      const memory = new MemoryManager();
      const streamedPrompts: string[] = [];
      const agent = createAgentStub({
        async streamChat(prompt, _options, onEvent) {
          streamedPrompts.push(prompt);
          await onEvent({ type: 'start', provider: 'gemini' });
          await onEvent({ type: 'delta', text: 'Hello' });
          await onEvent({ type: 'delta', text: ' world' });
          await onEvent({ type: 'done', text: 'Hello world' });
          return { provider: 'gemini', text: 'Hello world' };
        }
      });

      const pipeline = createMessagePipeline({
        connector,
        commandRouter: {
          async handleMessage() {
            return false;
          },
          isPassthroughCommand() {
            return false;
          }
        } as never,
        memory,
        scheduler: { resetSilenceTimer() {} } as never,
        userAgent: agent,
        chatRunnerAgent: agent,
        useRunnerForChat: false,
        chatRunnerPercent: 0,
        chatRunnerOnlyUsers: new Set(),
        shouldSummarize: () => false,
        buildPrompt: (userMessage) => `PROMPT:${userMessage}`,
        recordRuntimeIssue() {},
        writeContextSnapshots() {}
      });

      await pipeline(createMessage('請開始串流'));

      assert.equal(streamedPrompts.length, 1);
      assert.equal(placeholders.length, 1);
      assert.equal(placeholders[0]?.text, '🤔 思考中...');
      assert.equal(sentMessages.length, 0);
      assert.ok(edits.some((item) => item.text.includes('✍️ 回覆中...')));
      assert.equal(edits[edits.length - 1]?.text, 'Hello world');
    } finally {
      if (prevStreamingEnabled === undefined) delete process.env.TELEGRAM_STREAMING_ENABLED;
      else process.env.TELEGRAM_STREAMING_ENABLED = prevStreamingEnabled;
      if (prevThrottleMs === undefined) delete process.env.TELEGRAM_STREAM_EDIT_THROTTLE_MS;
      else process.env.TELEGRAM_STREAM_EDIT_THROTTLE_MS = prevThrottleMs;
      if (prevMinDeltaChars === undefined) delete process.env.TELEGRAM_STREAM_MIN_DELTA_CHARS;
      else process.env.TELEGRAM_STREAM_MIN_DELTA_CHARS = prevMinDeltaChars;
      if (prevForceFlushMs === undefined) delete process.env.TELEGRAM_STREAM_FORCE_FLUSH_MS;
      else process.env.TELEGRAM_STREAM_FORCE_FLUSH_MS = prevForceFlushMs;
      if (prevEarlyFlushChars === undefined) delete process.env.TELEGRAM_STREAM_EARLY_FLUSH_CHARS;
      else process.env.TELEGRAM_STREAM_EARLY_FLUSH_CHARS = prevEarlyFlushChars;
    }
  });
});
