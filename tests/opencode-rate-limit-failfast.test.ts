import test from 'node:test';
import assert from 'node:assert/strict';
import { OpencodeAgent } from '../src/core/opencode.js';
import { UPSTREAM_RATE_LIMIT_PATTERN } from '../src/core/rate-limit.js';
import { deriveRunOutcome } from '../src/core/run-outcome.js';
import { buildTextOnlyStructuredResult } from '../src/core/agent-result.js';
import type { AIAgentOptions } from '../src/core/agent.js';

/** buildChatArgs 是 protected —— 開個測試用子類把它露出來。 */
class ArgsProbe extends OpencodeAgent {
  publicArgs(options?: AIAgentOptions): string[] {
    return this.buildChatArgs(options, 'json');
  }
}

test('buildChatArgs 一律帶上 --print-logs,否則 429 fail-fast 攔不到任何東西', () => {
  const args = new ArgsProbe().publicArgs({ model: 'nvidia/openai/gpt-oss-120b' });

  const logLevelIndex = args.indexOf('--log-level');
  assert.ok(
    args.includes('--print-logs'),
    '缺少 --print-logs：opencode 只會把 429 寫進自己的 log 檔'
  );
  assert.notEqual(logLevelIndex, -1, '缺少 --log-level');
  assert.equal(args[logLevelIndex + 1], 'ERROR', '預設 INFO 會把每次 bus publish 都灌進 stderr');
});

test('buildChatArgs 對 passthrough 指令同樣帶上 log 旗標', () => {
  const args = new ArgsProbe().publicArgs({ isPassthroughCommand: true });
  assert.ok(args.includes('--print-logs'), 'passthrough 一樣可能撞到上游 429');
});

test('stderr 429 pattern 命中 opencode 真實錯誤格式', () => {
  // 取自 2026-08-29 正式環境事故的 stderr（已截短）。
  const realStderr =
    'ERROR 2026-08-29T08:17:04 +310ms service=llm providerID=nvidia modelID=minimaxai/minimax-m3 ' +
    'error={"error":{"name":"AI_APICallError","url":"https://integrate.api.nvidia.com/v1/chat/completions",' +
    '"statusCode":429,"responseBody":"{\\"status\\":429,\\"title\\":\\"Too Many Requests\\"}","isRetryable":true}}';

  assert.ok(UPSTREAM_RATE_LIMIT_PATTERN.test(realStderr));
  assert.ok(UPSTREAM_RATE_LIMIT_PATTERN.test('"status":429'));
  assert.ok(UPSTREAM_RATE_LIMIT_PATTERN.test('code=RESOURCE_EXHAUSTED'));
});

test('stderr 429 pattern 不被 prompt 裡的數字 429 誤觸', () => {
  // --print-logs 會把整包 request body（含 prompt 與工具輸出）印進 ERROR 行。
  // 加密貨幣／股市排程的內容出現 429 這個數字完全正常，誤判會砍掉本來會成功的任務。
  const marketData =
    'ERROR service=llm error={"requestBodyValues":{"messages":[{"role":"user",' +
    '"content":"比特幣 24h 成交量 429 億美元，前高 429.5"}]}}';

  assert.equal(UPSTREAM_RATE_LIMIT_PATTERN.test(marketData), false);
  assert.equal(UPSTREAM_RATE_LIMIT_PATTERN.test('HTTP 429 是什麼意思？'), false);
  // 對照：舊的寬鬆 pattern 在這兩筆上都會誤判。
  assert.ok(/\b429\b|Too Many Requests|RESOURCE_EXHAUSTED/i.test(marketData));
});

test('deriveRunOutcome：沒有 failure 就是成功', () => {
  assert.deepEqual(deriveRunOutcome(buildTextOnlyStructuredResult('opencode', '答案')), {
    ok: true
  });
  assert.deepEqual(deriveRunOutcome(undefined), { ok: true });
});

test('deriveRunOutcome：逾時與限流要記成失敗,不能算進成功率', () => {
  const timedOut = buildTextOnlyStructuredResult('opencode', '✨ 30分鐘內未完成', {
    failure: { kind: 'timeout', message: 'Process timed out' }
  });
  assert.deepEqual(deriveRunOutcome(timedOut), {
    ok: false,
    failureKind: 'timeout',
    error: 'Process timed out'
  });

  const rateLimited = buildTextOnlyStructuredResult('opencode', '⏳ 上游配額已達上限', {
    failure: { kind: 'rate-limit', message: 'upstream 429' }
  });
  assert.equal(deriveRunOutcome(rateLimited).ok, false);
  assert.equal(deriveRunOutcome(rateLimited).failureKind, 'rate-limit');
});
