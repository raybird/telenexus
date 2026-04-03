import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryIntent } from '../src/core/memory-intent.js';
import {
  clearMemoryIntentTraces,
  formatMemoryIntentTraceMarkdown,
  recordMemoryIntentTrace
} from '../src/services/memory-intent-telemetry.js';

test('parseMemoryIntent extracts trailing structured block and cleans response', () => {
  const parsed = parseMemoryIntent(
    '這是正文。\n\n[[MEMORY_INTENT:{"level":"rule","confidence":"high","reason":"這是穩定 SOP","summary":"release workflow rule"}]]'
  );

  assert.equal(parsed.cleanedResponse, '這是正文。');
  assert.deepEqual(parsed.intent, {
    level: 'rule',
    confidence: 'high',
    reason: '這是穩定 SOP',
    summary: 'release workflow rule'
  });
});

test('parseMemoryIntent ignores invalid block and leaves response unchanged', () => {
  const raw = '正文\n\n[[MEMORY_INTENT:{"level":"bad","confidence":"high","reason":"x"}]]';
  const parsed = parseMemoryIntent(raw);
  assert.equal(parsed.cleanedResponse, raw);
  assert.equal(parsed.intent, null);
});

test('memory intent telemetry stores and formats observations', () => {
  clearMemoryIntentTraces();
  recordMemoryIntentTrace({
    requestId: 'req-mi',
    timestamp: Date.parse('2026-04-03T12:00:00Z'),
    userId: 'user-a',
    channel: 'telegram',
    promptMode: 'full',
    intent: {
      level: 'decision',
      confidence: 'medium',
      reason: '使用者明確指定策略',
      summary: 'prefer minor release for shell features'
    }
  });

  const markdown = formatMemoryIntentTraceMarkdown();
  assert.match(markdown, /# Memory Intent Status/);
  assert.match(markdown, /decision: 1/);
  assert.match(markdown, /req=req-mi/);
  clearMemoryIntentTraces();
});
