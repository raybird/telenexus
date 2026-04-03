import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPromptSessionTraces,
  formatPromptSessionTraceMarkdown,
  getRecentPromptSessionTraces,
  recordPromptSessionTrace
} from '../src/services/prompt-session-telemetry.js';
import { shouldIncludeMemoryContext } from '../src/core/prompt-build.js';

test('prompt session telemetry stores and formats recent traces', () => {
  clearPromptSessionTraces();

  recordPromptSessionTrace({
    requestId: 'req-1',
    timestamp: Date.parse('2026-04-03T10:00:00Z'),
    channel: 'telegram',
    userId: 'user-a',
    executionMode: 'runner',
    promptMode: 'full',
    promptSelectionReason: 'periodic-full',
    promptLength: 1200,
    memoryContextLength: 450,
    memoryContextSectionCount: 3,
    usedMemoryContext: true,
    forceNewSession: false,
    isPassthroughCommand: false,
    durationMs: 1800,
    responseLength: 320,
    ok: true
  });

  recordPromptSessionTrace({
    requestId: 'req-2',
    timestamp: Date.parse('2026-04-03T10:01:00Z'),
    channel: 'web',
    userId: 'user-a',
    executionMode: 'local',
    promptMode: 'compact',
    promptSelectionReason: 'compact-followup',
    promptLength: 420,
    memoryContextLength: 0,
    memoryContextSectionCount: 0,
    usedMemoryContext: false,
    forceNewSession: false,
    isPassthroughCommand: false,
    durationMs: 950,
    responseLength: 120,
    ok: true
  });

  const traces = getRecentPromptSessionTraces();
  assert.equal(traces.length, 2);
  assert.equal(traces[1]?.requestId, 'req-2');

  const markdown = formatPromptSessionTraceMarkdown();
  assert.match(markdown, /# Prompt Session Status/);
  assert.match(markdown, /full: 1/);
  assert.match(markdown, /compact: 1/);
  assert.match(markdown, /req=req-2/);
  assert.match(markdown, /channel=web/);

  clearPromptSessionTraces();
});

test('compact memory injection policy stays off for simple follow-up and on for historical lookup', () => {
  assert.equal(shouldIncludeMemoryContext('minimal', '再講詳細一點？'), false);
  assert.equal(shouldIncludeMemoryContext('compact', '再講詳細一點？'), false);
  assert.equal(shouldIncludeMemoryContext('compact', '現在 release SOP 是什麼？'), true);
  assert.equal(
    shouldIncludeMemoryContext('compact', '幫我整理\n目前 scheduler 與 runner 的差異'),
    true
  );
  assert.equal(shouldIncludeMemoryContext('full', 'hello'), true);
});
