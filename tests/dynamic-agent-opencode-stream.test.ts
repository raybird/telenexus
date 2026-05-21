import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DynamicAIAgent } from '../src/core/agent.js';
import type { AgentEvent } from '../src/core/agent-result.js';

test('DynamicAIAgent streamChat uses local opencode streamChat when provider is opencode', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-opencode-stream-test-'));
  const configPath = path.join(tempDir, 'ai-config.yaml');
  fs.writeFileSync(configPath, 'provider: opencode\n', 'utf8');

  try {
    const agent = new DynamicAIAgent(configPath, {
      preferRunner: false,
      fallbackToLocal: true
    });

    const recorded: AgentEvent[] = [];
    let called = false;
    const opencodeAgent = (agent as unknown as { opencodeAgent: { streamChat: Function } })
      .opencodeAgent;
    opencodeAgent.streamChat = async (
      prompt: string,
      _options: unknown,
      onEvent: (event: AgentEvent) => Promise<void> | void
    ) => {
      called = true;
      assert.equal(prompt, 'hello');
      await onEvent({ type: 'start', provider: 'opencode' });
      await onEvent({ type: 'delta', text: 'Open' });
      await onEvent({ type: 'delta', text: 'Code' });
      await onEvent({ type: 'done', text: 'OpenCode' });
      return { provider: 'opencode', text: 'OpenCode' };
    };

    const result = await agent.streamChat('hello', undefined, async (event) => {
      recorded.push(event);
    });

    assert.equal(called, true);
    assert.equal(result.text, '[Opencode] OpenCode');
    assert.deepEqual(recorded, [
      { type: 'start', provider: 'opencode' },
      { type: 'delta', text: 'Open' },
      { type: 'delta', text: 'Code' },
      { type: 'done', text: 'OpenCode' }
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
