import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessagePipeline } from '../src/core/message-pipeline.js';
import { MemoryManager } from '../src/core/memory.js';
import { ChatSessionStore } from '../src/services/chat-session-store.js';
import type { AIAgent, AIAgentOptions } from '../src/core/agent.js';
import type { AgentEvent, AgentStructuredResult } from '../src/core/agent-result.js';
import type { Connector, UnifiedMessage } from '../src/types/index.js';

/**
 * Issue 0012:pipeline 以綁定的 session 接續聊天,回合結束後改綁到結果的 session,
 * 綁定的 session 不存在時清除綁定、改開新 session 重跑一次。
 */

async function withTempProject(fn: (projectDir: string) => Promise<void>): Promise<void> {
  const saved = {
    cwd: process.cwd(),
    DB_PATH: process.env.DB_PATH,
    APP_PROJECT_DIR: process.env.APP_PROJECT_DIR,
    SUMMARY_FOLLOWUP_ENABLED: process.env.SUMMARY_FOLLOWUP_ENABLED,
    TELEGRAM_STREAMING_ENABLED: process.env.TELEGRAM_STREAMING_ENABLED
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-pipeline-session-'));
  fs.mkdirSync(path.join(tempDir, 'workspace', 'temp'), { recursive: true });
  process.chdir(tempDir);
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  process.env.APP_PROJECT_DIR = tempDir;
  process.env.SUMMARY_FOLLOWUP_ENABLED = 'false';
  process.env.TELEGRAM_STREAMING_ENABLED = 'false';
  try {
    await fn(tempDir);
  } finally {
    process.chdir(saved.cwd);
    for (const key of [
      'DB_PATH',
      'APP_PROJECT_DIR',
      'SUMMARY_FOLLOWUP_ENABLED',
      'TELEGRAM_STREAMING_ENABLED'
    ] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createConnector(): { connector: Connector; sent: string[] } {
  const sent: string[] = [];
  const connector: Connector = {
    name: 'test-connector',
    async initialize() {},
    async sendMessage(_chatId, text) {
      sent.push(text);
    },
    async sendPlaceholder() {
      return 'placeholder-1';
    },
    async editMessage() {},
    async deleteMessage() {},
    onMessage() {}
  };
  return { connector, sent };
}

function createMessage(content: string, raw?: unknown): UnifiedMessage {
  return {
    id: `msg-${Math.random()}`,
    chatId: 'chat-1',
    content,
    sender: { id: 'user-a', name: 'tester', platform: 'telegram' },
    timestamp: Date.now(),
    ...(raw ? { raw } : {})
  };
}

type Call = { sessionId: string | undefined; forceNewSession: boolean };

/** 依序回傳 results 的假 agent,記下每次呼叫帶的 session 選項。 */
function createScriptedAgent(results: AgentStructuredResult[]): { agent: AIAgent; calls: Call[] } {
  const calls: Call[] = [];
  const next = (options?: AIAgentOptions): AgentStructuredResult => {
    calls.push({
      sessionId: options?.sessionId,
      forceNewSession: options?.forceNewSession === true
    });
    const result = results.shift();
    assert.ok(result, 'agent 被呼叫的次數超過預期');
    return result;
  };
  const agent: AIAgent = {
    async chat(_prompt, options) {
      return next(options).text;
    },
    async chatStructured(_prompt, options) {
      return next(options);
    },
    async streamChat(_prompt, options, onEvent: (event: AgentEvent) => Promise<void> | void) {
      const result = next(options);
      // 與真正的 agent 相同:session-missing 不發任何事件。
      if (result.failure?.kind !== 'session-missing') {
        await onEvent({ type: 'done', text: result.text });
      }
      return result;
    },
    async summarize(text) {
      return `summary:${text}`;
    }
  };
  return { agent, calls };
}

function createPipeline(options: {
  connector: Connector;
  agent: AIAgent;
  store: ChatSessionStore;
  runtimeIssues?: string[];
  passthrough?: boolean;
}) {
  return createMessagePipeline({
    connector: options.connector,
    commandRouter: {
      async handleMessage(msg: UnifiedMessage, ctx: { requestNewSession: (id: string) => void }) {
        if (msg.content === '/new') {
          ctx.requestNewSession(msg.sender.id);
          return true;
        }
        return false;
      },
      isPassthroughCommand() {
        return options.passthrough === true;
      }
    } as never,
    memory: new MemoryManager(),
    scheduler: { resetSilenceTimer() {} } as never,
    userAgent: options.agent,
    chatRunnerAgent: options.agent,
    useRunnerForChat: false,
    chatRunnerPercent: 0,
    chatRunnerOnlyUsers: new Set(),
    chatSessionStore: options.store,
    shouldSummarize() {
      return false;
    },
    buildPrompt(userMessage) {
      return `PROMPT:${userMessage}`;
    },
    recordRuntimeIssue(scope) {
      options.runtimeIssues?.push(scope);
    },
    writeContextSnapshots() {}
  });
}

const reply = (text: string, sessionId?: string): AgentStructuredResult => ({
  provider: 'opencode',
  text,
  ...(sessionId ? { sessionId } : {})
});
const SESSION_MISSING: AgentStructuredResult = {
  provider: 'opencode',
  text: 'Opencode 找不到要接續的 session。',
  failure: { kind: 'session-missing', message: 'Session not found' }
};

for (const mode of ['non-stream', 'stream'] as const) {
  const raw = mode === 'stream' ? { streamResponse: () => {} } : undefined;

  test(`SCN-001/002 [${mode}]: 首次對話開新 session 並綁定,之後以它接續`, async () => {
    await withTempProject(async (dir) => {
      const { connector } = createConnector();
      const store = new ChatSessionStore(path.join(dir, 'data', 'chat-session-state.json'));
      const { agent, calls } = createScriptedAgent([reply('一', 'ses_1'), reply('二', 'ses_1')]);
      const pipeline = createPipeline({ connector, agent, store });

      await pipeline(createMessage('第一則', raw));
      await pipeline(createMessage('第二則', raw));

      assert.deepEqual(calls, [
        { sessionId: undefined, forceNewSession: false },
        { sessionId: 'ses_1', forceNewSession: false }
      ]);
      assert.equal(store.get('user-a'), 'ses_1');
    });
  });

  test(`SCN-002 [${mode}]: /new 之後開新 session 並改綁`, async () => {
    await withTempProject(async (dir) => {
      const { connector } = createConnector();
      const store = new ChatSessionStore(path.join(dir, 'data', 'chat-session-state.json'));
      store.set('user-a', 'ses_old');
      const { agent, calls } = createScriptedAgent([
        reply('新的', 'ses_new'),
        reply('接續', 'ses_new')
      ]);
      const pipeline = createPipeline({ connector, agent, store });

      await pipeline(createMessage('/new', raw));
      await pipeline(createMessage('換個話題', raw));
      await pipeline(createMessage('繼續這個話題', raw));

      assert.deepEqual(calls, [
        { sessionId: undefined, forceNewSession: true },
        { sessionId: 'ses_new', forceNewSession: false }
      ]);
      assert.equal(store.get('user-a'), 'ses_new');
    });
  });

  test(`SCN-003 [${mode}]: 綁定的 session 不存在時改開新 session 重跑,回覆使用者並改綁`, async () => {
    await withTempProject(async (dir) => {
      const { connector, sent } = createConnector();
      const store = new ChatSessionStore(path.join(dir, 'data', 'chat-session-state.json'));
      store.set('user-a', 'ses_gone');
      const runtimeIssues: string[] = [];
      const { agent, calls } = createScriptedAgent([
        SESSION_MISSING,
        reply('真正的回覆', 'ses_fresh')
      ]);
      const streamed: AgentEvent[] = [];
      const pipeline = createPipeline({ connector, agent, store, runtimeIssues });

      await pipeline(
        createMessage(
          '哈囉',
          mode === 'stream'
            ? { streamResponse: (event: AgentEvent) => void streamed.push(event) }
            : undefined
        )
      );

      assert.deepEqual(calls, [
        { sessionId: 'ses_gone', forceNewSession: false },
        { sessionId: undefined, forceNewSession: false }
      ]);
      assert.equal(store.get('user-a'), 'ses_fresh');
      assert.deepEqual(runtimeIssues, ['chat-session:missing']);
      if (mode === 'stream') {
        assert.deepEqual(
          streamed.filter((event) => event.type === 'done'),
          [{ type: 'done', text: '真正的回覆' }]
        );
      } else {
        assert.ok(sent.some((text) => text.includes('真正的回覆')));
        assert.equal(
          sent.some((text) => text.includes('找不到要接續的 session')),
          false
        );
      }
    });
  });
}

test('SCN-001 [passthrough]: passthrough 指令接續綁定的 session,不改綁', async () => {
  await withTempProject(async (dir) => {
    const { connector } = createConnector();
    const store = new ChatSessionStore(path.join(dir, 'data', 'chat-session-state.json'));
    store.set('user-a', 'ses_1');
    const { agent, calls } = createScriptedAgent([reply('compacted')]);
    const pipeline = createPipeline({ connector, agent, store, passthrough: true });

    await pipeline(createMessage('/compact'));

    assert.deepEqual(calls, [{ sessionId: 'ses_1', forceNewSession: false }]);
    assert.equal(store.get('user-a'), 'ses_1');
  });
});
