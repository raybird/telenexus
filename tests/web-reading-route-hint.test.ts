import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CHAT_PROMPT_CONFIG } from '../src/config/ai-config.js';
import { buildChatPrompt } from '../src/prompt/builder.js';

// issue 0024 SCN-009：2026-11-12 步驟 6 實測，模型有 9/20 次沒有載入 web-reading 技能，
// 沒載入就不知道有 Moli 這一層。讀取順序因此放在每回合都會送的聊天提示詞裡。
const modes = ['full', 'compact', 'minimal'] as const;

for (const mode of modes) {
  test(`SCN-009 ${mode} 模式的聊天提示詞含網頁讀取順序`, () => {
    const prompt = buildChatPrompt(DEFAULT_CHAT_PROMPT_CONFIG, '幫我讀這個網頁', '', mode);
    const hint = prompt.slice(prompt.indexOf('【網頁讀取】'));
    assert.ok(prompt.includes('【網頁讀取】'), '要有網頁讀取段落');
    const webfetch = hint.indexOf('webfetch');
    const moli = hint.indexOf("telenexus-moli-fetch '");
    const chrome = hint.indexOf('telenexus_browser');
    assert.ok(webfetch >= 0 && moli > webfetch && chrome > moli, `順序要是 webfetch → Moli → Chrome：${hint.slice(0, 200)}`);
    assert.match(hint, /讀到所需正文就以它回答/);
    // 讀取順序是系統規則，要在使用者訊息之前。
    assert.ok(prompt.indexOf('【網頁讀取】') < prompt.indexOf('User Message:'));
  });
}
