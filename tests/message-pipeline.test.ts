import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessagePipeline } from '../src/core/message-pipeline.js';
import { MemoryManager } from '../src/core/memory.js';
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
    const buildPromptModes: Array<'full' | 'compact'> = [];
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
        return `PROMPT:${userMessage}`;
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
