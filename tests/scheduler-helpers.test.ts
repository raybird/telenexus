import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/core/memory.js';
import {
  assessAiResponse,
  buildDailySummaryPrompt,
  buildReflectionPrompt,
  buildScheduledTaskPrompt,
  extractKeywords,
  hasUserActivitySinceLastReflection,
  isReflectionMessage,
  truncateInline
} from '../src/core/scheduler-helpers.js';

test('extractKeywords removes stopwords and keeps unique tokens', () => {
  const keywords = extractKeywords('請 幫我 看看 scheduler reload workflow workflow 現在 如何');

  assert.deepEqual(keywords, ['看看', 'scheduler', 'reload', 'workflow']);
});

test('assessAiResponse retries obvious execution stubs', () => {
  const result = assessAiResponse('我將先處理這件事，稍後回報');

  assert.equal(result.shouldRetry, true);
  assert.equal(result.reason, 'stub_without_result');
});

test('assessAiResponse accepts concrete bullet results', () => {
  const result = assessAiResponse('核心結論\n- 觀察一\n- 觀察二\n- 建議三');

  assert.equal(result.shouldRetry, false);
  assert.equal(result.reason, 'ok');
});

test('hasUserActivitySinceLastReflection detects no new user reply after follow-up', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'need follow-up', timestamp: 1000 },
    { role: 'model', content: '🔔 [追蹤提醒]\n\n待辦...', timestamp: 2000 },
    { role: 'model', content: '普通 AI 回覆', timestamp: 3000 }
  ];

  assert.equal(hasUserActivitySinceLastReflection(history), false);
  assert.equal(isReflectionMessage('✅ [追蹤檢查] 已完成檢查，目前沒有新的事項變化。'), true);
});

test('scheduler prompt builders keep core task wording', () => {
  const taskPrompt = buildScheduledTaskPrompt('daily-report', '請提供市場分析', '【記憶參考】');
  const reflectionPrompt = buildReflectionPrompt('[t] User: hi', '[t] AI: ok', '【記憶參考】');
  const dailyPrompt = buildDailySummaryPrompt('2026/03/29');

  assert.match(taskPrompt, /Scheduled Task: daily-report/);
  assert.match(reflectionPrompt, /過去 24 小時 User 對話/);
  assert.match(dailyPrompt, /📅 每日摘要 - 2026\/03\/29/);
  assert.equal(truncateInline('abcdef', 4), 'abc…');
});
