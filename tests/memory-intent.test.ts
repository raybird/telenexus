import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryIntentStreamFilter,
  createVisibleEventFilter,
  parseMemoryIntent
} from '../src/core/memory-intent.js';
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

const NONE = '[[MEMORY_INTENT:{"level":"none","confidence":"high","reason":"無"}]]';
const DECISION = '[[MEMORY_INTENT:{"level":"decision","confidence":"high","reason":"已採納"}]]';

test('parseMemoryIntent 移除無效標記，不寫入 intent', () => {
  for (const block of [
    '[[MEMORY_INTENT:{"level":"bad","confidence":"high","reason":"x"}]]',
    '[[MEMORY_INTENT:{"level":"none","confidence":"high"}]]',
    '[[MEMORY_INTENT:{not json}]]',
    '[[MEMORY_INTENT:none]]',
    '[[MEMORY_INTENT:{"level":"none"'
  ]) {
    const parsed = parseMemoryIntent(`正文\n\n${block}`);
    assert.equal(parsed.cleanedResponse, '正文', block);
    assert.equal(parsed.intent, null, block);
  }
});

test('parseMemoryIntent 移除中段標記並保留段落，intent 只採用結尾標記', () => {
  const parsed = parseMemoryIntent(`前文\n\n${DECISION}\n\n後文`);
  assert.equal(parsed.cleanedResponse, '前文\n\n後文');
  assert.equal(parsed.intent, null);
});

test('parseMemoryIntent 處理多個標記時採用結尾的標記', () => {
  const parsed = parseMemoryIntent(`我先查${NONE}\n\n結果${DECISION}`);
  assert.equal(parsed.cleanedResponse, '我先查\n\n結果');
  assert.equal(parsed.intent?.level, 'decision');

  const lastInvalid = parseMemoryIntent(`我先查${DECISION}\n\n結果[[MEMORY_INTENT:壞掉]]`);
  assert.equal(lastInvalid.cleanedResponse, '我先查\n\n結果');
  assert.equal(lastInvalid.intent, null);
});

test('程式碼區塊引用的範例標記不會寫成記憶', () => {
  const parsed = parseMemoryIntent(`範例：\n\n\`\`\`\n${DECISION}\n\`\`\`\n\n說明結束`);
  assert.doesNotMatch(parsed.cleanedResponse, /MEMORY_INTENT/);
  assert.equal(parsed.intent, null);
});

test('parseMemoryIntent 保留標記之後接上的說明', () => {
  const parsed = parseMemoryIntent(`正文${NONE}\n\n⚠️ 上游錯誤`);
  assert.equal(parsed.cleanedResponse, '正文\n\n⚠️ 上游錯誤');
});

test('移除標記時保留前後段落的分隔', () => {
  assert.equal(parseMemoryIntent(`第一段\n\n${NONE}## 標題`).cleanedResponse, '第一段\n\n## 標題');
  assert.equal(parseMemoryIntent(`我先查${NONE}\n\n結果`).cleanedResponse, '我先查\n\n結果');
  assert.equal(parseMemoryIntent(`甲 ${NONE} 乙`).cleanedResponse, '甲 乙');
});

test('格式壞掉的標記不會吃掉後面幾行的正文', () => {
  const missingBrace = '[[MEMORY_INTENT:{"level":"none","reason":"x"]]';
  const body = '正文\nmatrix = [[{"a":1}]]\n結尾';
  assert.equal(parseMemoryIntent(`${missingBrace}\n${body}`).cleanedResponse, body);

  const quoted = 'x = "[[MEMORY_INTENT:{"\ny = [[{"a":1}]]\n結尾';
  assert.equal(parseMemoryIntent(quoted).cleanedResponse, quoted);

  const multiLine = '[[MEMORY_INTENT:{\n正文\n}]]';
  assert.equal(parseMemoryIntent(multiLine).cleanedResponse, multiLine);
});

test('討論標記的文字不會被整行移除', () => {
  const prose = '標記以 `[[MEMORY_INTENT:` 開頭，後面接 JSON。\n下一行';
  assert.equal(parseMemoryIntent(prose).cleanedResponse, prose);
  assert.equal(
    parseMemoryIntent('[[MEMORY_INTENT: 整行正文').cleanedResponse,
    '[[MEMORY_INTENT: 整行正文'
  );
});

test('沒有收尾的標記只有在最後一行才移除', () => {
  assert.equal(parseMemoryIntent('正文\n[[MEMORY_INTENT:{"level":"no').cleanedResponse, '正文');
  const midway = '[[MEMORY_INTENT:{"level":"no\n後面的正文';
  assert.equal(parseMemoryIntent(midway).cleanedResponse, midway);
});

test('標記可以跨行，JSON 字串裡的括號不算收尾', () => {
  const multiLine =
    '[[MEMORY_INTENT:{\n  "level":"rule",\n  "confidence":"high",\n  "reason":"x"\n}]]';
  assert.equal(parseMemoryIntent(`正文\n${multiLine}`).intent?.level, 'rule');

  const tricky = '[[MEMORY_INTENT:{"level":"rule","confidence":"high","reason":"a}]]b"}]]';
  const parsed = parseMemoryIntent(`正文${tricky}`);
  assert.equal(parsed.cleanedResponse, '正文');
  assert.equal(parsed.intent?.reason, 'a}]]b');
});

test('標記之後的文字不受前一個區塊影響', () => {
  assert.equal(parseMemoryIntent(`${NONE}\n後文 [[1]]`).cleanedResponse, '後文 [[1]]');
  assert.equal(parseMemoryIntent('[[MEMORY_INTENT:壞掉]] 同行後文').cleanedResponse, '同行後文');
});

test('標記支援巢狀 JSON、跳脫引號與前後換行', () => {
  const nested =
    '[[MEMORY_INTENT:{"level":"rule","confidence":"high","reason":"x","extra":{"a":1}}]]';
  const escaped = '[[MEMORY_INTENT:{"level":"rule","confidence":"high","reason":"a\\"}]]b"}]]';
  const padded = '[[MEMORY_INTENT:\n{"level":"rule","confidence":"high","reason":"x"}\n]]';

  for (const block of [nested, escaped, padded]) {
    const parsed = parseMemoryIntent(`正文${block}`);
    assert.equal(parsed.cleanedResponse, '正文', block);
    assert.equal(parsed.intent?.level, 'rule', block);
  }
});

test('壞標記不影響後面的有效標記', () => {
  const parsed = parseMemoryIntent(`正文[[MEMORY_INTENT:壞掉]]\n${DECISION}`);
  assert.equal(parsed.cleanedResponse, '正文');
  assert.equal(parsed.intent?.level, 'decision');
});

test('沒有收尾的標記後面還有標記時保留中間的文字', () => {
  const parsed = parseMemoryIntent(`[[MEMORY_INTENT:{"level":"no 中間內文 ${DECISION}`);
  assert.equal(parsed.cleanedResponse, '[[MEMORY_INTENT:{"level":"no 中間內文');
  assert.equal(parsed.intent?.level, 'decision');
});

test('不合法的 confidence 不會寫成 intent', () => {
  const block = '[[MEMORY_INTENT:{"level":"rule","confidence":"sure","reason":"x"}]]';
  assert.equal(parseMemoryIntent(`正文${block}`).intent, null);
});

test('清單項目在標記移除後仍維持換行', () => {
  assert.equal(parseMemoryIntent(`- 甲 ${NONE}\n- 乙`).cleanedResponse, '- 甲\n- 乙');
  assert.equal(parseMemoryIntent(`第一行  ${NONE}\n第二行`).cleanedResponse, '第一行\n第二行');
});

test('parseMemoryIntent 不改動沒有標記的回覆', () => {
  const raw = '  提到 [[MEMORY_INTENT]] 這個詞，沒有冒號就不是標記  \n';
  assert.deepEqual(parseMemoryIntent(raw), { cleanedResponse: raw, intent: null });
});

test('回覆只有標記時清理後為空，intent 仍保留', () => {
  const parsed = parseMemoryIntent(DECISION);
  assert.equal(parsed.cleanedResponse, '');
  assert.equal(parsed.intent?.level, 'decision');
});

test('parseMemoryIntent 處理大量空白與重複開頭仍維持線性時間', () => {
  const inputs = [
    `${' '.repeat(200_000)}${NONE}`,
    '[[MEMORY_INTENT:{'.repeat(50_000),
    `[[MEMORY_INTENT:{${'"'.repeat(200_000)}`,
    '[[MEMORY_INTENT:{"\\'.repeat(100_000),
    '[[MEMORY_INTENT:]]內文'.repeat(200_000)
  ];
  const startedAt = Date.now();
  for (const input of inputs) {
    parseMemoryIntent(input);
  }
  assert.ok(Date.now() - startedAt < 1000, `took ${Date.now() - startedAt}ms`);
});

test('stream filter 擋下被切到不同 chunk 的標記', () => {
  const visible = createMemoryIntentStreamFilter();
  const chunks = ['正文', '\n\n[', '[MEMO', 'RY_INTENT:{"level":"none",', '"confidence":"high"}]]'];

  assert.equal(chunks.map(visible).join('').trimEnd(), '正文');
});

test('stream filter 處理切在冒號前的標記', () => {
  const visible = createMemoryIntentStreamFilter();
  assert.equal(visible('正文[[MEMORY_INTENT'), '正文');
  assert.equal(visible(':{"level":"none"}]]'), '');
});

test('stream filter 放行不是標記的方括號', () => {
  const visible = createMemoryIntentStreamFilter();

  assert.equal(visible('連結 ['), '連結 ');
  assert.equal(visible('[文件](url)'), '[[文件](url)');
  assert.equal(visible('結尾 [['), '結尾 ');
  assert.equal(visible('MEMO 不是標記'), '[[MEMO 不是標記');
});

test('stream filter 看到標記後不再輸出，正文交給最終文字', () => {
  const visible = createMemoryIntentStreamFilter();

  assert.equal(visible('前文[[MEMORY_INTENT:{}]]後文'), '前文');
  assert.equal(visible('更多文字'), '');
});

test('visible event filter 過濾 delta 與 reasoning，start 時兩者都重設', () => {
  const visible = createVisibleEventFilter();

  assert.deepEqual(visible({ type: 'delta', text: `正文${NONE}` }), {
    type: 'delta',
    text: '正文'
  });
  assert.equal(visible({ type: 'delta', text: '被擋下' }), null);
  assert.deepEqual(visible({ type: 'reasoning', text: `想${NONE}` }), {
    type: 'reasoning',
    text: '想'
  });
  assert.equal(visible({ type: 'reasoning', text: '被擋下' }), null);

  visible({ type: 'start', provider: 'opencode' });
  assert.deepEqual(visible({ type: 'delta', text: '重跑' }), { type: 'delta', text: '重跑' });
  assert.deepEqual(visible({ type: 'reasoning', text: '重想' }), {
    type: 'reasoning',
    text: '重想'
  });
});

test('visible event filter 清理 done 文字，其他事件原樣通過', () => {
  const visible = createVisibleEventFilter();

  assert.deepEqual(visible({ type: 'done', text: `正文${NONE}` }), { type: 'done', text: '正文' });
  assert.deepEqual(visible({ type: 'status', text: '處理中' }), { type: 'status', text: '處理中' });
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
