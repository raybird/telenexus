import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpencodeAgent } from '../src/core/opencode.js';
import type { AIAgentOptions } from '../src/core/agent.js';

/**
 * Issue 0012 SCN-004:回合只有工具呼叫、沒有文字時,追問要送進該回合自己的 session。
 *
 * 原本追問沿用原回合的 options:聊天回合用 `-c`,接到的是當下最後被更新的 session;
 * 排程回合帶 forceNewSession,追問會開一個沒有上下文的新 session。
 * 假的 `opencode` 依呼叫次序吐出不同輸出,並把每次的參數存成 argv-<n>.txt。
 */

const TOOL_ONLY_EVENTS = [
  '{"type":"step_start","sessionID":"ses_turn","part":{"type":"step-start"}}',
  '{"type":"tool_use","sessionID":"ses_turn","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"a.txt"}}}',
  '{"type":"step_finish","sessionID":"ses_turn","part":{"type":"step-finish","reason":"tool-calls"}}'
].join('\n');
const FOLLOW_UP_EVENTS = [
  '{"type":"step_start","sessionID":"ses_turn","part":{"type":"step-start"}}',
  '{"type":"text","sessionID":"ses_turn","part":{"type":"text","text":"整理好的結果"}}',
  '{"type":"step_finish","sessionID":"ses_turn","part":{"type":"step-finish","reason":"stop"}}'
].join('\n');

let tempDir = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'PATH',
  'APP_PROJECT_DIR',
  'OPENCODE_TASK_TIMEOUT_MS',
  'FAKE_OPENCODE_DIR',
  'FAKE_OPENCODE_SET'
];

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-tool-only-'));
  fs.mkdirSync(path.join(tempDir, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'bin'));
  fs.writeFileSync(path.join(tempDir, 'stdout-1'), TOOL_ONLY_EVENTS, 'utf8');
  fs.writeFileSync(path.join(tempDir, 'stdout-2'), FOLLOW_UP_EVENTS, 'utf8');
  const withoutSessionId = (events: string) => events.replaceAll('"sessionID":"ses_turn",', '');
  fs.writeFileSync(
    path.join(tempDir, 'nosid-stdout-1'),
    withoutSessionId(TOOL_ONLY_EVENTS),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tempDir, 'nosid-stdout-2'),
    withoutSessionId(FOLLOW_UP_EVENTS),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tempDir, 'bin', 'opencode'),
    `#!/bin/sh
n=$(cat "$FAKE_OPENCODE_DIR/count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FAKE_OPENCODE_DIR/count"
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$FAKE_OPENCODE_DIR/argv-$n.txt"
cat "$FAKE_OPENCODE_DIR/\${FAKE_OPENCODE_SET:-}stdout-$n"
`,
    { mode: 0o755 }
  );
  process.env.PATH = `${path.join(tempDir, 'bin')}${path.delimiter}${savedEnv.PATH ?? ''}`;
  process.env.APP_PROJECT_DIR = tempDir;
  process.env.OPENCODE_TASK_TIMEOUT_MS = '8000';
  process.env.FAKE_OPENCODE_DIR = tempDir;
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function argvOfCall(n: number): string[] {
  return fs
    .readFileSync(path.join(tempDir, `argv-${n}.txt`), 'utf8')
    .split('\n')
    .slice(0, -1);
}

function sessionFlagValue(argv: string[]): string | undefined {
  const index = argv.indexOf('-s');
  return index === -1 ? undefined : argv[index + 1];
}

const CASES: { label: string; options: AIAgentOptions | undefined }[] = [
  { label: '排程回合(forceNewSession)', options: { forceNewSession: true, fromScheduler: true } },
  { label: '首次聊天(沒有綁定)', options: undefined },
  { label: '接續綁定的聊天', options: { sessionId: 'ses_turn' } }
];

for (const { label, options } of CASES) {
  test(`SCN-004: ${label}的 tool_only 追問送進該回合的 session`, async () => {
    fs.rmSync(path.join(tempDir, 'count'), { force: true });
    const agent = new OpencodeAgent();
    const result = await agent.streamChat('列出檔案', options, () => {});

    assert.equal(result.text, '整理好的結果');
    const followUpArgv = argvOfCall(2);
    assert.equal(sessionFlagValue(followUpArgv), 'ses_turn');
    assert.equal(followUpArgv.at(-1), '請整理你剛才工具執行的結果並回答原問題');
  });
}

test('SCN-004: 事件沒有 sessionID 時,追問沿用原回合的選項(變更前的行為)', async () => {
  // opencode 1.18.34 的每個事件都帶 sessionID(步驟 1 實測),這只會在輸出格式改變時發生。
  fs.rmSync(path.join(tempDir, 'count'), { force: true });
  process.env.FAKE_OPENCODE_SET = 'nosid-';
  try {
    const agent = new OpencodeAgent();
    const result = await agent.streamChat('列出檔案', { forceNewSession: true }, () => {});
    assert.equal(result.text, '整理好的結果');
    assert.equal(argvOfCall(2).includes('-s'), false);
  } finally {
    delete process.env.FAKE_OPENCODE_SET;
  }
});
