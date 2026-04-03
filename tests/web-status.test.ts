import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePromptSessionRequests, toStructuredStatus } from '../src/web/server.js';

test('parsePromptSessionRequests parses recent request lines', () => {
  const markdown = [
    '# Prompt Session Status',
    '',
    '## Recent Requests',
    '- [2026/4/3 上午10:00:00] req=req-1 channel=telegram exec=runner mode=full reason=periodic-full prompt=1200 memory=450 sections=3 duration=1800ms status=ok',
    '- [2026/4/3 上午10:01:00] req=req-2 channel=web exec=local mode=minimal reason=minimal-followup prompt=180 memory=0 sections=0 duration=300ms status=ok'
  ].join('\n');

  const items = parsePromptSessionRequests(markdown);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.requestId, 'req-1');
  assert.equal(items[0]?.memoryLength, 450);
  assert.equal(items[1]?.promptMode, 'minimal');
  assert.equal(items[1]?.durationMs, 300);
});

test('toStructuredStatus includes prompt session structured fields', () => {
  const structured = toStructuredStatus({
    runtime: '- Updated: 2026/4/3 上午10:00:00',
    provider: '- Provider: gemini\n- Model: gemini-2.5-pro',
    scheduler: '- Active Schedules: 2\n- #1 | Daily | 0 9 * * * | user=user-a',
    error: '- [2026/4/3 上午10:00:00] (message-processing) boom',
    runner: '- Success Rate: 98%\n- Last 5m Success Rate: 100%',
    memory: '- Total Messages: 10',
    promptSession: [
      '- Sample Count: 2',
      '- Avg Prompt Length: 690',
      '- Avg Memory Context Length: 225',
      '',
      '## Recent Requests',
      '- [2026/4/3 上午10:01:00] req=req-2 channel=web exec=local mode=minimal reason=minimal-followup prompt=180 memory=0 sections=0 duration=300ms status=ok'
    ].join('\n')
  }) as {
    promptSession?: {
      sampleCount?: number;
      avg_prompt_length?: string;
      recentRequests?: Array<{ requestId?: string; promptMode?: string }>;
    };
  };

  assert.equal(structured.promptSession?.sampleCount, 2);
  assert.equal(structured.promptSession?.avg_prompt_length, '690');
  assert.equal(structured.promptSession?.recentRequests?.[0]?.requestId, 'req-2');
  assert.equal(structured.promptSession?.recentRequests?.[0]?.promptMode, 'minimal');
});
