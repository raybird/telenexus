import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHAT_PROMPT_CONFIG } from '../src/config/ai-config.js';
import { parseMemoryIntent } from '../src/core/memory-intent.js';
import { buildChatPrompt } from '../src/prompt/builder.js';
import { buildMemoriaCapabilityHint } from '../src/prompt/memoria-capability.js';

test('memory reporting is absent when Memoria is disabled', () => {
  const hint = buildMemoriaCapabilityHint(false);
  assert.equal(hint, '');
  for (const mode of ['full', 'compact', 'minimal'] as const) {
    const prompt = buildChatPrompt(DEFAULT_CHAT_PROMPT_CONFIG, '你好', '', mode, hint);
    assert.doesNotMatch(prompt, /MEMORY_INTENT/);
  }
});

for (const mode of ['full', 'compact', 'minimal'] as const) {
  test(`${mode} asks for memory reporting even without recalled history`, () => {
    const prompt = buildChatPrompt(
      DEFAULT_CHAT_PROMPT_CONFIG,
      '以後都用繁體中文回答',
      '',
      mode,
      buildMemoriaCapabilityHint(true)
    );
    assert.match(prompt, /每輪回覆前私下判斷/);
    assert.match(prompt, /使用者明確表達的穩定偏好或規則/);
    assert.match(prompt, /已採納的決策/);
    assert.match(prompt, /經實際驗證的可重用技巧/);
    assert.match(prompt, /不要把猜測、尚未採納的建議、驗證用假資料或短期雜訊/);
    assert.match(prompt, /不要在回覆正文解釋或重複它/);
    assert.doesNotMatch(prompt, /【SAR 使用規則】/);
    const marker = prompt.match(/\[\[MEMORY_INTENT:.*?\]\]/)?.[0];
    assert.ok(marker, 'prompt must provide a concrete valid no-memory marker');
    assert.deepEqual(parseMemoryIntent(`收到。\n${marker}`).intent, {
      level: 'none',
      confidence: 'high',
      reason: '本輪沒有新的長期記憶'
    });
  });
}
