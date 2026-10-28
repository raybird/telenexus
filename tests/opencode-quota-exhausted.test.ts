import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  UPSTREAM_QUOTA_EXHAUSTED_PATTERN,
  UPSTREAM_RATE_LIMIT_PATTERN,
  isUpstreamQuotaExhausted
} from '../src/core/rate-limit.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'opencode');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// 2026-10-28 正式部署額度用完時擷取的真實 stderr（issue 0023 步驟 1）
const REAL = fixture('1.18.34-free-usage-limit.stderr.txt');
const [MAIN_LINE = '', TITLE_LINE = ''] = REAL.split('\n').filter(Boolean);
const REAL_MESSAGE =
  'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go';

function mainAgentLine(message: string): string {
  return MAIN_LINE.replace(REAL_MESSAGE, message);
}

test('issue 0023 樣本：主代理與標題代理各一行', () => {
  assert.match(MAIN_LINE, /small=false/);
  assert.match(TITLE_LINE, /small=true/);
  assert.ok(MAIN_LINE.includes(REAL_MESSAGE));
});

test('issue 0023 SCN-005 真實樣本判定為額度用完，也觸發快速失敗', () => {
  assert.equal(isUpstreamQuotaExhausted(REAL), true);
  assert.equal(UPSTREAM_RATE_LIMIT_PATTERN.test(REAL), true);
});

for (const message of [
  REAL_MESSAGE,
  'Usage limit reached',
  'Monthly usage limit reached for this plan',
  'USAGE LIMIT REACHED'
]) {
  test(`issue 0023 SCN-005 認得「${message.slice(0, 40)}」`, () => {
    const line = mainAgentLine(message);
    assert.equal(isUpstreamQuotaExhausted(line), true);
    assert.equal(UPSTREAM_RATE_LIMIT_PATTERN.test(line), true);
  });
}

const NEGATIVES: Array<[string, string]> = [
  ['標題代理（small=true）那一行', TITLE_LINE],
  [
    '標題代理（small=true）回 AI_APICallError 的同一句',
    MAIN_LINE.replace('small=false agent=build', 'small=true agent=title')
  ],
  [
    '不是 stream error 的 log 行',
    MAIN_LINE.replace('message="stream error"', 'message="session error"')
  ],
  [
    'error.error 以外的欄位',
    MAIN_LINE.replace(/error\.error="[^"]*"/, 'error.error="AI_APICallError: Bad Request"') +
      ' note="usage limit reached"'
  ],
  [
    '正常回合的回覆文字',
    JSON.stringify({
      type: 'text',
      part: { text: 'API 回應 usage limit reached 時要換金鑰；small=false 也一樣。' }
    })
  ]
];

for (const [name, output] of NEGATIVES) {
  test(`issue 0023 SCN-006 ${name}不判定為額度用完，也不觸發快速失敗`, () => {
    assert.equal(isUpstreamQuotaExhausted(output), false);
    assert.equal(UPSTREAM_RATE_LIMIT_PATTERN.test(output), false);
  });
}

for (const name of [
  '1.18.34-upstream-429-retry.stderr.txt',
  '1.18.34-upstream-429-retry-status-text.stderr.txt'
]) {
  test(`issue 0023 SCN-007 一般 429（${name}）仍是限流，不是額度用完`, () => {
    const output = fixture(name);
    assert.equal(UPSTREAM_RATE_LIMIT_PATTERN.test(output), true);
    assert.equal(isUpstreamQuotaExhausted(output), false);
  });
}

test('issue 0023 額度用完的樣式只認主代理 stream error 的 error.error 欄位', () => {
  assert.equal(UPSTREAM_QUOTA_EXHAUSTED_PATTERN.flags, 'i');
  assert.match(UPSTREAM_QUOTA_EXHAUSTED_PATTERN.source, /stream error/);
  assert.match(UPSTREAM_QUOTA_EXHAUSTED_PATTERN.source, /small=false/);
});
