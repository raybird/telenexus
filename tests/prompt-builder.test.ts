import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/core/memory.js';
import { buildChatPrompt, buildMemoryContext, shouldSummarize } from '../src/prompt/builder.js';

function withTempDb<T>(fn: () => T): T {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-prompt-test-'));
  const dbPath = path.join(tempDir, 'test.db');
  process.env.DB_PATH = dbPath;

  try {
    return fn();
  } finally {
    if (prevDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = prevDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function seedSarRegressionFixtures(memory: MemoryManager, userId: string, baseTs: number): void {
  const fixtures = [
    {
      ts: baseTs + 1000,
      content: 'Gemini recovery memory',
      summary:
        'Gemini Recovery Rule: INVALID_ARGUMENT / ChatCompressionService.compress 先 /compress；RESOURCE_EXHAUSTED / MODEL_CAPACITY_EXHAUSTED 則等待重試或 fallback model/provider。',
      impactLevel: 3,
      tags: ['gemini', 'runner', 'memory', 'infra']
    },
    {
      ts: baseTs + 2000,
      content: 'Web chat history memory',
      summary:
        'Web Chat History Rule: 採用 cursor-based loading、incremental prepend、top-anchor scroll preserve，避免 offset pagination 與全量 re-render。',
      impactLevel: 3,
      tags: ['web', 'memory']
    },
    {
      ts: baseTs + 3000,
      content: 'Release workflow memory',
      summary:
        'Release Workflow Rule: 使用 npm run release:patch -- -m <commit message>，流程固定為 commit > npm version > tag > push，ai-config.yaml 不入版。',
      impactLevel: 3,
      tags: ['release', 'memory']
    },
    {
      ts: baseTs + 4000,
      content: 'Scheduler management memory',
      summary:
        'Scheduler CLI Management Rule: 以 scheduler-cli 作為主要治理入口，支援 list / add / update / remove / reload / health；更新後優先 HTTP reload。',
      impactLevel: 3,
      tags: ['scheduler', 'memory']
    }
  ];

  const originalNow = Date.now;
  try {
    for (const fixture of fixtures) {
      Date.now = () => fixture.ts;
      memory.addMessage(userId, 'model', fixture.content, {
        summary: fixture.summary,
        impactLevel: fixture.impactLevel,
        tags: fixture.tags
      });
    }
  } finally {
    Date.now = originalNow;
  }
}

test('shouldSummarize returns true for text longer than 200 chars', () => {
  const longText = 'a'.repeat(201);
  assert.equal(shouldSummarize(longText), true);
});

test('shouldSummarize returns true for text containing code fences', () => {
  assert.equal(shouldSummarize('Here is code:\n```\nconsole.log(1)\n```'), true);
});

test('shouldSummarize returns true for text containing tool_result', () => {
  assert.equal(shouldSummarize('tool_result: success'), true);
});

test('shouldSummarize returns true for text with 6 or more newlines', () => {
  const multiline = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
  assert.equal(shouldSummarize(multiline), true);
});

test('shouldSummarize returns false for short simple text', () => {
  assert.equal(shouldSummarize('hello world'), false);
});

test('shouldSummarize returns false for text just under thresholds', () => {
  const text = 'a'.repeat(200);
  assert.equal(shouldSummarize(text), false);

  const fewLines = 'line1\nline2\nline3\nline4\nline5\nline6';
  assert.equal(shouldSummarize(fewLines), false);
});

test('buildChatPrompt minimal mode keeps only short session reminder and user message', () => {
  const config = {
    language: '繁體中文',
    roleSystem: '你是 TeleNexus',
    yoloNoticeEnabled: true,
    memoryPolicyEnabled: true,
    workspacePolicyEnabled: true,
    includeAiResponseSuffix: true,
    memoryPolicyLines: ['記住重要規則'],
    workspacePolicyLines: ['工作目錄是 workspace/']
  };

  const prompt = buildChatPrompt(
    config,
    '再講詳細一點？',
    '【Memory Context】\n【核心決策回顧】\n- [2026-04-01] sample',
    'minimal'
  );

  assert.doesNotMatch(prompt, /System:/);
  assert.doesNotMatch(prompt, /【Memory Context】/);
  assert.doesNotMatch(prompt, /【SAR 使用規則】/);
  assert.match(prompt, /延續目前對話 Session/);
  assert.match(prompt, /User Message:\n再講詳細一點？/);
});

test('buildMemoryContext keeps older canonical anchor available for matching query', () => {
  withTempDb(() => {
    const originalNow = Date.now;
    const baseTs = Date.parse('2026-04-20T00:00:00Z');
    let ts = baseTs;
    Date.now = () => ts;

    try {
      const memory = new MemoryManager();

      ts = Date.parse('2026-01-01T00:00:00Z');
      memory.addMessage('user-a', 'model', 'Historic release workflow memory', {
        summary:
          'Release Workflow Rule: use npm run release:patch -- -m <commit message> and follow commit > npm version > tag > push.',
        impactLevel: 3,
        tags: ['release', 'memory']
      });

      for (let i = 0; i < 45; i += 1) {
        ts = baseTs + i * 1000;
        memory.addMessage('user-a', 'model', `Recent generic summary ${i}`, {
          summary: `General project status update ${i}`,
          impactLevel: 2,
          tags: ['memory']
        });
      }

      const context = buildMemoryContext(memory, 'user-a', '現在 release SOP 是什麼？');
      assert.match(context, /【核心決策回顧】/);
      assert.match(context, /Release Workflow Rule/);
      assert.match(context, /npm run release:patch/);
    } finally {
      Date.now = originalNow;
    }
  });
});

test('buildMemoryContext keeps high-signal release anchor ahead of newer weak release note', () => {
  withTempDb(() => {
    const originalNow = Date.now;
    let ts = Date.parse('2026-03-01T00:00:00Z');
    Date.now = () => ts;

    try {
      const memory = new MemoryManager();

      memory.addMessage('user-a', 'model', 'opaque note', {
        summary: 'Release Workflow Rule with npm run release:patch and tag push guidance',
        impactLevel: 3,
        tags: ['release', 'memory']
      });

      ts = Date.parse('2026-03-28T00:00:00Z');
      memory.addMessage('user-a', 'model', 'recent release mention in raw content only', {
        summary: 'General weekly release note',
        impactLevel: 1,
        tags: ['notes']
      });

      const context = buildMemoryContext(memory, 'user-a', 'release 現在 SOP 是什麼？');
      assert.match(context, /Release Workflow Rule/);

      const coreSection = context.split('【核心決策回顧】\n')[1]?.split('\n\n')[0] || '';
      const firstCoreLine =
        coreSection.split('\n').find((line) => line.trim().startsWith('- [')) || '';
      assert.match(firstCoreLine, /Release Workflow Rule/);
    } finally {
      Date.now = originalNow;
    }
  });
});

test('buildMemoryContext does not duplicate anchor into semantic section', () => {
  withTempDb(() => {
    const originalNow = Date.now;
    let ts = Date.parse('2026-04-20T00:00:00Z');
    Date.now = () => ts;

    try {
      const memory = new MemoryManager();
      memory.addMessage('user-a', 'model', 'Gemini recovery memory', {
        summary:
          'Gemini Recovery Rule: INVALID_ARGUMENT 先 /compress，RESOURCE_EXHAUSTED 則等待重試或 fallback provider。',
        impactLevel: 3,
        tags: ['gemini', 'runner', 'memory']
      });

      const context = buildMemoryContext(memory, 'user-a', '之前 Gemini 常壞是怎麼處理的？');
      const occurrences = (context.match(/Gemini Recovery Rule/g) || []).length;
      assert.equal(occurrences, 1);
    } finally {
      Date.now = originalNow;
    }
  });
});

test('buildMemoryContext keeps anchor and minimum recent lines under heavy budget pressure', () => {
  withTempDb(() => {
    const originalNow = Date.now;
    const baseTs = Date.parse('2026-04-20T00:00:00Z');
    let ts = baseTs;
    Date.now = () => ts;

    try {
      const memory = new MemoryManager();
      memory.addMessage('user-a', 'model', 'Scheduler management memory', {
        summary:
          'Scheduler CLI Management Rule: use scheduler-cli for list, add, update, remove, reload, and health operations.',
        impactLevel: 3,
        tags: ['scheduler', 'memory']
      });

      for (let i = 0; i < 10; i += 1) {
        ts = baseTs + i * 1000;
        memory.addMessage(
          'user-a',
          i % 2 === 0 ? 'user' : 'model',
          `Very long recent conversation ${i} ` + 'x'.repeat(260)
        );
      }

      for (let i = 0; i < 8; i += 1) {
        ts = baseTs + 20000 + i * 1000;
        memory.addMessage('user-a', 'model', `Scheduler semantic memory ${i}`, {
          summary: `Scheduler reload behavior note ${i} ` + 'y'.repeat(240),
          impactLevel: 2,
          tags: ['scheduler', 'memory']
        });
      }

      const context = buildMemoryContext(memory, 'user-a', 'scheduler CLI 現在的管理方式是什麼？');
      assert.match(context, /【核心決策回顧】/);
      assert.match(context, /Scheduler CLI Management Rule/);
      assert.match(context, /【近期對話】/);

      const recentSection = context.split('【近期對話】\n')[1] || '';
      const recentLines = recentSection.split('\n').filter((line) => line.trim().startsWith('- ['));
      assert.ok(recentLines.length >= 4);
      assert.ok(context.length <= 1500);
    } finally {
      Date.now = originalNow;
    }
  });
});

test('buildMemoryContext keeps at least one semantic item under heavy budget pressure', () => {
  withTempDb(() => {
    const originalNow = Date.now;
    const baseTs = Date.parse('2026-04-20T00:00:00Z');
    let ts = baseTs;
    Date.now = () => ts;

    try {
      const memory = new MemoryManager();
      memory.addMessage('user-a', 'model', 'Release workflow memory', {
        summary:
          'Release Workflow Rule: use npm run release:patch and keep commit, version, tag, push order.',
        impactLevel: 3,
        tags: ['release', 'memory']
      });

      for (let i = 0; i < 10; i += 1) {
        ts = baseTs + i * 1000;
        memory.addMessage(
          'user-a',
          i % 2 === 0 ? 'user' : 'model',
          `Very long release conversation ${i} ` + 'x'.repeat(260)
        );
      }

      for (let i = 0; i < 8; i += 1) {
        ts = baseTs + 20000 + i * 1000;
        memory.addMessage('user-a', 'model', `Release semantic memory ${i}`, {
          summary: `Release rollback note ${i} ` + 'y'.repeat(240),
          impactLevel: 1,
          tags: ['release', 'memory']
        });
      }

      const context = buildMemoryContext(memory, 'user-a', 'release rollback 現在怎麼處理？');
      assert.match(context, /【相關歷史摘要】/);

      const semanticSection =
        context.split('【相關歷史摘要】\n')[1]?.split('\n\n【近期對話】')[0] || '';
      const semanticLines = semanticSection
        .split('\n')
        .filter((line) => line.trim().startsWith('- ['));

      assert.ok(semanticLines.length >= 1);
      assert.ok(context.length <= 1500);
    } finally {
      Date.now = originalNow;
    }
  });
});

test('buildMemoryContext includes SAR wrapper and core section for gemini regression case', () => {
  withTempDb(() => {
    const baseTs = Date.parse('2026-04-20T00:00:00Z');
    const memory = new MemoryManager();
    seedSarRegressionFixtures(memory, 'user-a', baseTs);

    const context = buildMemoryContext(memory, 'user-a', '之前 Gemini 常壞是怎麼處理的？');
    assert.match(context, /^【記憶參考（TeleNexus SAR）】/);
    assert.match(context, /【核心決策回顧】/);
    assert.match(context, /Gemini Recovery Rule/);
    assert.match(context, /compress/);
    assert.match(context, /fallback model\/provider/);
  });
});

test('buildMemoryContext resolves web chat history canonical rule', () => {
  withTempDb(() => {
    const baseTs = Date.parse('2026-04-20T00:00:00Z');
    const memory = new MemoryManager();
    seedSarRegressionFixtures(memory, 'user-a', baseTs);

    const context = buildMemoryContext(memory, 'user-a', 'chat history 上滑載入最後怎麼修的？');
    assert.match(context, /Web Chat History Rule/);
    assert.match(context, /cursor-based loading/);
    assert.match(context, /incremental prepend/);
    assert.match(context, /top-anchor scroll preserve/);
  });
});

test('buildMemoryContext resolves scheduler CLI canonical rule', () => {
  withTempDb(() => {
    const baseTs = Date.parse('2026-04-20T00:00:00Z');
    const memory = new MemoryManager();
    seedSarRegressionFixtures(memory, 'user-a', baseTs);

    const context = buildMemoryContext(memory, 'user-a', 'scheduler CLI 現在的管理方式是什麼？');
    assert.match(context, /Scheduler CLI Management Rule/);
    assert.match(context, /scheduler-cli/);
    assert.match(context, /reload/);
    assert.match(context, /health/);
  });
});

test('buildMemoryContext resolves alias query normalization for release workflow', () => {
  withTempDb(() => {
    const baseTs = Date.parse('2026-04-20T00:00:00Z');
    const memory = new MemoryManager();
    seedSarRegressionFixtures(memory, 'user-a', baseTs);

    const context = buildMemoryContext(memory, 'user-a', '發版流程現在怎麼走？');
    assert.match(context, /Release Workflow Rule/);
    assert.match(context, /npm run release:patch/);
    assert.match(context, /commit > npm version > tag > push/);
    assert.match(context, /ai-config.yaml 不入版/);
  });
});

test('buildMemoryContext resolves alias query normalization for gemini recovery', () => {
  withTempDb(() => {
    const baseTs = Date.parse('2026-04-20T00:00:00Z');
    const memory = new MemoryManager();
    seedSarRegressionFixtures(memory, 'user-a', baseTs);

    const context = buildMemoryContext(memory, 'user-a', 'Gemini 壓縮壞掉時怎麼救？');
    assert.match(context, /Gemini Recovery Rule/);
    assert.match(context, /INVALID_ARGUMENT/);
    assert.match(context, /compress/);
  });
});
