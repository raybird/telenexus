import test from 'node:test';
import assert from 'node:assert/strict';
import { CliAgentBase, type CliAgentConfig } from '../src/core/cli-agent-base.js';
import type { AIAgentOptions } from '../src/core/agent.js';
import type { AgentEvent, AgentStructuredResult } from '../src/core/agent-result.js';

/**
 * onRunFinished 是 agent-browser 這類「不在我們 process group 裡的常駐程序」唯一的收尾點,
 * 所以它必須在**每一條**結束路徑都跑到 —— 尤其是失敗與逾時,那正是殘留最容易發生的時候。
 * 這裡用假子類直接驗 finally 的保證,不啟動任何真實程序。
 */
class FakeAgent extends CliAgentBase {
  protected readonly config: CliAgentConfig = {
    provider: 'opencode',
    binary: 'true',
    rateLimitPattern: /never-matches/,
    rateLimitMessage: 'rate limited',
    timeoutMessage: 'timed out'
  };

  finishedWith: (AIAgentOptions | undefined)[] = [];
  behaviour: 'resolve' | 'reject' = 'resolve';

  protected buildChatArgs(): string[] {
    return [];
  }
  protected parseStreamLine(): null {
    return null;
  }
  protected cleanOutput(text: string): string {
    return text;
  }
  async chatStructured(): Promise<AgentStructuredResult> {
    return { provider: 'opencode', text: 'x' };
  }
  async summarize(): Promise<string> {
    return 'x';
  }

  protected override async onRunFinished(options?: AIAgentOptions): Promise<void> {
    this.finishedWith.push(options);
  }

  // 取代真正會 spawn 的實作,只保留 streamChat 外層的 try/finally 行為。
  protected override async runStreamChat(): Promise<AgentStructuredResult> {
    if (this.behaviour === 'reject') throw new Error('boom');
    return { provider: 'opencode', text: 'ok' };
  }
}

const noopEvent = (_e: AgentEvent): void => {};

test('streamChat 成功時會呼叫 onRunFinished', async () => {
  const agent = new FakeAgent();
  await agent.streamChat('p', { fromScheduler: true }, noopEvent);
  assert.equal(agent.finishedWith.length, 1);
  assert.equal(agent.finishedWith[0]?.fromScheduler, true);
});

test('streamChat 失敗時仍會呼叫 onRunFinished', async () => {
  const agent = new FakeAgent();
  agent.behaviour = 'reject';
  await assert.rejects(agent.streamChat('p', { fromScheduler: true }, noopEvent), /boom/);
  assert.equal(agent.finishedWith.length, 1, '失敗路徑漏掉收尾 —— 殘留最常發生在這裡');
});

test('onRunFinished 拿得到原本的 options,收尾才判斷得出是不是排程', async () => {
  const agent = new FakeAgent();
  await agent.streamChat('p', undefined, noopEvent);
  assert.equal(agent.finishedWith[0], undefined);
});

test('CliAgentBase 的預設 onRunFinished 是 no-op,不影響既有子類', async () => {
  class Bare extends FakeAgent {
    protected override async onRunFinished(): Promise<void> {
      await CliAgentBase.prototype['onRunFinished'].call(this);
    }
  }
  const agent = new Bare();
  await agent.streamChat('p', { fromScheduler: true }, noopEvent);
  assert.equal(agent.finishedWith.length, 0);
});
