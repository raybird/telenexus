import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  DEFAULT_CHAT_PROMPT_CONFIG,
  loadChatPromptConfig,
  warnIfRetiredMemoryPolicyLines
} from '../src/config/ai-config.js';
import { buildChatPrompt } from '../src/prompt/builder.js';

function withTempCwd<T>(files: Record<string, string>, fn: () => T): T {
  const prevCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-ai-config-test-'));

  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), content, 'utf8');
    }
    process.chdir(tempDir);
    return fn();
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('loadChatPromptConfig default prompt text uses current TeleNexus wording', () => {
  withTempCwd({}, () => {
    const config = loadChatPromptConfig();

    assert.match(config.roleSystem, /TeleNexus/);
    assert.doesNotMatch(config.roleSystem, /google_search|read_file/);
    assert.equal(config.memoryPolicyLines.length, 4);
    assert.ok(
      config.memoryPolicyLines.every(
        (line) => !/create_entities|create_relations|search_entities/.test(line)
      )
    );
  });
});

// ---- issue 0022：prompt 不再指示已退役的 MCP Memory 工具 ----

/** v2.32.0 以前 ai-config.example.yaml 出貨的條列，逐字抄錄，不從實作引用 */
const RETIRED_EXAMPLE_LINES = [
  '當對話包含重要資訊時，主動使用 create_entities 儲存',
  '當發現實體間關係時，使用 create_relations',
  '需要回想時，使用 search_entities'
];
const MCP_TOOL_PATTERN = /create_entities|create_relations|search_entities|MCP Memory/;

function aiConfigWithMemoryLines(lines: string[] | undefined): string {
  const body =
    lines === undefined
      ? ''
      : `  memory_policy_lines:\n${lines.map((line) => `    - ${line}`).join('\n')}\n`;
  return `provider: opencode\nchat_prompt:\n  memory_policy_enabled: true\n${body}`;
}

function warnings(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message: string) => messages.push(message), messages };
}

for (const [label, lines, expected, warned] of [
  ['和舊範例的三行完全相同', RETIRED_EXAMPLE_LINES, 'default', true],
  ['和舊範例相同、只差頭尾空白', RETIRED_EXAMPLE_LINES.map((line) => `${line}  `), 'default', true],
  [
    '使用者改過一個字',
    ['當對話包含重要資訊時，主動使用 create_entities 保存', ...RETIRED_EXAMPLE_LINES.slice(1)],
    'user',
    false
  ],
  ['只留舊範例的前兩行', RETIRED_EXAMPLE_LINES.slice(0, 2), 'user', false],
  ['使用者自己的條列', ['記住使用者的偏好'], 'user', false],
  ['未設定', undefined, 'default', false]
] as const) {
  test(`issue 0022 SCN-011 memory_policy_lines ${label}時用${expected === 'default' ? '預設條列' : '使用者的條列'}，${warned ? '' : '不'}warn`, () => {
    withTempCwd(
      { 'ai-config.yaml': aiConfigWithMemoryLines(lines === undefined ? undefined : [...lines]) },
      () => {
        const config = loadChatPromptConfig();
        const expectedLines =
          expected === 'default'
            ? DEFAULT_CHAT_PROMPT_CONFIG.memoryPolicyLines
            : (lines ?? []).map((line) => line.trim());
        assert.deepEqual(config.memoryPolicyLines, expectedLines);

        const { warn, messages } = warnings();
        assert.equal(warnIfRetiredMemoryPolicyLines(warn), warned);
        assert.equal(messages.length, warned ? 1 : 0);
        if (warned) assert.match(messages[0] ?? '', /memory_policy_lines/);
      }
    );
  });
}

test('issue 0022 SCN-010／SCN-011 舊範例設定組出的 full prompt 不再提 MCP Memory 工具', () => {
  withTempCwd({ 'ai-config.yaml': aiConfigWithMemoryLines(RETIRED_EXAMPLE_LINES) }, () => {
    const prompt = buildChatPrompt(loadChatPromptConfig(), '你好', '', 'full');
    assert.match(prompt, /【知識管理 - 重要】/);
    assert.doesNotMatch(prompt, MCP_TOOL_PATTERN);
    for (const line of DEFAULT_CHAT_PROMPT_CONFIG.memoryPolicyLines) {
      assert.ok(prompt.includes(`- ${line}`), line);
    }
  });
});

test('issue 0022 SCN-010 使用者自訂條列時，知識管理段落照用但標題不提 MCP Memory', () => {
  const prompt = buildChatPrompt(
    { ...DEFAULT_CHAT_PROMPT_CONFIG, memoryPolicyLines: ['記住使用者的偏好'] },
    '你好',
    '',
    'full'
  );
  assert.match(prompt, /【知識管理 - 重要】\n- 記住使用者的偏好/);
  assert.doesNotMatch(prompt, /MCP Memory/);
});

test('issue 0022 SCN-010 出貨的 ai-config.example.yaml 不點名 MCP Memory 工具，條列和預設相同', () => {
  const example = yaml.load(
    fs.readFileSync(new URL('../ai-config.example.yaml', import.meta.url), 'utf8')
  ) as { chat_prompt?: { memory_policy_lines?: string[] } };
  const lines = example.chat_prompt?.memory_policy_lines ?? [];
  assert.ok(lines.every((line) => !MCP_TOOL_PATTERN.test(line)));
  assert.deepEqual(lines, DEFAULT_CHAT_PROMPT_CONFIG.memoryPolicyLines);
});
