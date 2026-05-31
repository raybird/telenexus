import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMemoryIntentRequests,
  parsePromptSessionRequests,
  toStructuredStatus
} from '../src/web/server.js';

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

test('parseMemoryIntentRequests parses recent intent lines', () => {
  const markdown = [
    '# Memory Intent Status',
    '',
    '## Recent Memory Intents',
    '- [2026/4/3 上午10:02:00] req=req-mi channel=web mode=full level=decision confidence=high reason=使用者指定固定策略'
  ].join('\n');

  const items = parseMemoryIntentRequests(markdown);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.requestId, 'req-mi');
  assert.equal(items[0]?.level, 'decision');
  assert.equal(items[0]?.confidence, 'high');
});

test('toStructuredStatus includes prompt session structured fields', () => {
  const structured = toStructuredStatus({
    runtime: '- Updated: 2026/4/3 上午10:00:00',
    provider: '- Provider: opencode\n- Model: nvidia/minimaxai/minimax-m2.7',
    scheduler: '- Active Schedules: 2\n- #1 | Daily | 0 9 * * * | user=user-a',
    error: '- [2026/4/3 上午10:00:00] (message-processing) boom',
    runner: '- Success Rate: 98%\n- Last 5m Success Rate: 100%',
    memory: '- Total Messages: 10',
    memoria: '- Mode: auto\n- Available: yes\n- Endpoint Reachable: yes\n- Recent Failure Count: 1',
    memoryIntent: [
      '- Sample Count: 1',
      '- decision: 1',
      '',
      '## Recent Memory Intents',
      '- [2026/4/3 上午10:02:00] req=req-mi channel=web mode=full level=decision confidence=high reason=使用者指定固定策略'
    ].join('\n'),
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
    memoryIntent?: {
      sampleCount?: number;
      recentRequests?: Array<{ requestId?: string; level?: string; confidence?: string }>;
    };
    memoria?: {
      mode?: string;
      available?: string;
      recent_failure_count?: string;
    };
  };

  assert.equal(structured.promptSession?.sampleCount, 2);
  assert.equal(structured.promptSession?.avg_prompt_length, '690');
  assert.equal(structured.promptSession?.recentRequests?.[0]?.requestId, 'req-2');
  assert.equal(structured.promptSession?.recentRequests?.[0]?.promptMode, 'minimal');
  assert.equal(structured.memoryIntent?.sampleCount, 1);
  assert.equal(structured.memoryIntent?.recentRequests?.[0]?.requestId, 'req-mi');
  assert.equal(structured.memoryIntent?.recentRequests?.[0]?.level, 'decision');
  assert.equal(structured.memoria?.mode, 'auto');
  assert.equal(structured.memoria?.available, 'yes');
  assert.equal(structured.memoria?.recent_failure_count, '1');
  assert.equal((structured.promptSession as Record<string, unknown>)['2026_4_3_7'], undefined);
  assert.equal((structured.memoryIntent as Record<string, unknown>)['2026_4_3_7'], undefined);
});
