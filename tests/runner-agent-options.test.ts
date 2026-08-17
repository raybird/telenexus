import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentOptions } from '../src/core/runner-agent-options.js';

/**
 * 這組測試守的是一條靜默的斷鏈:runner 一直收得到 `lane`,卻沒有把它轉成 `fromScheduler`。
 * 排程結束後的 agent-browser session 清理靠這個旗標,少了它,走 runner 的排程
 * (`CHAT_USE_RUNNER_PERCENT > 0`)會完全不清理 —— 而且沒有任何錯誤訊息。
 */

test('lane=scheduled 轉成 fromScheduler', () => {
  const options = buildAgentOptions({ lane: 'scheduled' });
  assert.equal(options?.fromScheduler, true);
});

test('lane=interactive 不設 fromScheduler', () => {
  const options = buildAgentOptions({ lane: 'interactive' });
  assert.equal(options, undefined);
});

test('沒有 lane 時不設 fromScheduler', () => {
  const options = buildAgentOptions({ forceNewSession: true });
  assert.equal(options?.fromScheduler, undefined);
  assert.equal(options?.forceNewSession, true);
});

test('request 的 model 優先於設定檔的 model', () => {
  assert.equal(buildAgentOptions({ model: 'a' }, 'b')?.model, 'a');
  assert.equal(buildAgentOptions({}, 'b')?.model, 'b');
});

test('完全沒有選項時回傳 undefined,維持呼叫端既有語意', () => {
  assert.equal(buildAgentOptions({}), undefined);
  assert.equal(buildAgentOptions({}, undefined), undefined);
});

test('其餘旗標與 lane 並存,互不吃掉', () => {
  const options = buildAgentOptions(
    {
      lane: 'scheduled',
      isPassthroughCommand: true,
      forceNewSession: true,
      autoRecoveryNotice: true
    },
    'model-x'
  );
  assert.deepEqual(options, {
    model: 'model-x',
    isPassthroughCommand: true,
    forceNewSession: true,
    autoRecoveryNotice: true,
    fromScheduler: true
  });
});
