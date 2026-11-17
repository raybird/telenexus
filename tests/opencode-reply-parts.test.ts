import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpencodeAgent } from '../src/core/opencode.js';
import type { AgentStructuredResult } from '../src/core/agent-result.js';
import { StepTextCollector } from '../src/core/reply-parts.js';

/**
 * Issue 0028 步驟 3:opencode 的回合依 step 分出過程與結論。
 *
 * 以 tool-calls 結束的 step 的文字是過程,最後一個 step 的文字是結論;`text` 維持全文不變。
 * 假的 `opencode` 把 stdout 原樣吐回去,串流與非串流兩條路徑各跑一次,結果必須相同。
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode');

let tempDir = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['PATH', 'APP_PROJECT_DIR', 'OPENCODE_TASK_TIMEOUT_MS', 'FAKE_OPENCODE_STDOUT'];

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-reply-parts-'));
  fs.mkdirSync(path.join(tempDir, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'bin'));
  fs.writeFileSync(
    path.join(tempDir, 'bin', 'opencode'),
    '#!/bin/sh\ncat "$FAKE_OPENCODE_STDOUT"\n',
    { mode: 0o755 }
  );
  process.env.PATH = `${path.join(tempDir, 'bin')}${path.delimiter}${savedEnv.PATH ?? ''}`;
  process.env.APP_PROJECT_DIR = tempDir;
  process.env.OPENCODE_TASK_TIMEOUT_MS = '8000';
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const ev = {
  start: () => JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
  text: (text: string) => JSON.stringify({ type: 'text', part: { type: 'text', text } }),
  tool: () =>
    JSON.stringify({
      type: 'tool_use',
      part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } }
    }),
  finish: (reason: string) =>
    JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason } })
};

let stdoutCounter = 0;
function writeStdout(lines: string[]): string {
  stdoutCounter += 1;
  const file = path.join(tempDir, `stdout-${stdoutCounter}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

async function runBoth(stdoutFile: string): Promise<AgentStructuredResult[]> {
  process.env.FAKE_OPENCODE_STDOUT = stdoutFile;
  const agent = new OpencodeAgent();
  const streamed = await agent.streamChat('問題', { forceNewSession: true }, () => undefined);
  const nonStreamed = await agent.chatStructured('問題', { forceNewSession: true });
  return [streamed, nonStreamed];
}

test('SCN-001 前提：真實的工具呼叫回合分出過程與結論，text 維持全文', async () => {
  for (const result of await runBoth(path.join(FIXTURES, '1.18.34-tool-use.stdout.jsonl'))) {
    assert.deepEqual(result.replyParts, {
      process: ["I'll run that command now."],
      conclusion: 'The command printed `tool-probe-42`.'
    });
    assert.equal(result.text, "I'll run that command now.The command printed `tool-probe-42`.");
  }
});

test('SCN-001 前提：多個過程 step 依產生順序各自成段，空的 step 不算', async () => {
  const file = writeStdout([
    ev.start(),
    ev.text('數據已到手。'),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.text('接著抓第二個來源。'),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.text('**結論**：兩個來源一致。'),
    ev.finish('stop')
  ]);
  for (const result of await runBoth(file)) {
    assert.deepEqual(result.replyParts, {
      process: ['數據已到手。', '接著抓第二個來源。'],
      conclusion: '**結論**：兩個來源一致。'
    });
    assert.equal(result.text, '數據已到手。接著抓第二個來源。**結論**：兩個來源一致。');
  }
});

test('SCN-002：只有一個 step 的回合沒有 replyParts', async () => {
  for (const result of await runBoth(path.join(FIXTURES, '1.18.34-ok.stdout.jsonl'))) {
    assert.equal(result.replyParts, undefined);
    assert.equal(result.text, 'OK');
  }
});

test('SCN-002：工具呼叫前沒有說話的回合沒有 replyParts', async () => {
  const file = writeStdout([
    ev.start(),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.text('答案在這裡。'),
    ev.finish('stop')
  ]);
  for (const result of await runBoth(file)) {
    assert.equal(result.replyParts, undefined);
    assert.equal(result.text, '答案在這裡。');
  }
});

test('SCN-003：最後一個 step 沒有文字時沒有 replyParts', async () => {
  const file = writeStdout([
    ev.start(),
    ev.text('先查一下資料。'),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.finish('stop')
  ]);
  for (const result of await runBoth(file)) {
    assert.equal(result.replyParts, undefined);
    assert.equal(result.text, '先查一下資料。');
  }
});

test('SCN-005：think 結束標籤前的推理文字歸入過程，標籤本身不留', async () => {
  const file = writeStdout([
    ev.start(),
    ev.text('I should fetch prices first.</think>'),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.text('Let me write concise final result.</think># 晚間市場分析\n\n**核心結論** 偏弱。'),
    ev.finish('stop')
  ]);
  for (const result of await runBoth(file)) {
    assert.deepEqual(result.replyParts, {
      process: ['I should fetch prices first.', 'Let me write concise final result.'],
      conclusion: '# 晚間市場分析\n\n**核心結論** 偏弱。'
    });
  }
});

test('SCN-005：沒有工具的單一 step 帶推理文字時，同樣分出過程', async () => {
  const file = writeStdout([
    ev.start(),
    ev.text('The user wants a summary.</think>這是摘要。'),
    ev.finish('stop')
  ]);
  for (const result of await runBoth(file)) {
    assert.deepEqual(result.replyParts, {
      process: ['The user wants a summary.'],
      conclusion: '這是摘要。'
    });
  }
});

test('SCN-003＋SCN-005：結論整段都是推理文字時沒有 replyParts', async () => {
  const file = writeStdout([
    ev.start(),
    ev.text('The klines files did not write.'),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.text('Now let me analyze these files with python.</think>'),
    ev.finish('stop')
  ]);
  for (const result of await runBoth(file)) {
    assert.equal(result.replyParts, undefined);
  }
});

test('SCN-007：上游錯誤的回合即使前面有過程也沒有 replyParts', async () => {
  const file = writeStdout([
    ev.start(),
    ev.text('先查一下資料。'),
    ev.tool(),
    ev.finish('tool-calls'),
    JSON.stringify({
      type: 'error',
      error: { name: 'APIError', data: { message: 'mock: gone', statusCode: 410 } }
    })
  ]);
  process.env.FAKE_OPENCODE_STDOUT = file;
  const agent = new OpencodeAgent();
  const streamed = await agent.streamChat('問題', { forceNewSession: true }, () => undefined);
  assert.equal(streamed.failure?.kind, 'upstream-error');
  assert.equal(streamed.replyParts, undefined);
});

test('SCN-003：回合停在以 tool-calls 結束的 step 時沒有 replyParts', () => {
  // 例如工具呼叫後 opencode 就結束(非 0 結束但有文字的成功出口):最後一段是過程,沒有結論。
  const collector = new StepTextCollector();
  collector.addText('先讀檔。');
  collector.finishStep('tool-calls');
  collector.addText('再查一個來源。');
  collector.finishStep('tool-calls');
  assert.equal(
    collector.build((text) => text, '先讀檔。再查一個來源。'),
    undefined
  );
});

test('SCN-001 定義：非最後的 step 有文字但不是以 tool-calls 結束時沒有 replyParts', async () => {
  // 「過程」只指以 tool-calls 結束的 step;結束原因不明的 step 不當成過程,照舊送全文。
  const file = writeStdout([
    ev.start(),
    ev.text('先說明一下。'),
    ev.finish('unknown'),
    ev.start(),
    ev.text('結論在此。'),
    ev.finish('stop')
  ]);
  for (const result of await runBoth(file)) {
    assert.equal(result.replyParts, undefined);
    assert.equal(result.text, '先說明一下。結論在此。');
  }
});

test('跨 step 的 <thinking> 區塊只有全文清洗得掉時沒有 replyParts，摺疊版面與全文一致', async () => {
  const file = writeStdout([
    ev.start(),
    ev.text('前言。<thinking>內部'),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.text('推理</thinking>結論。'),
    ev.finish('stop')
  ]);
  for (const result of await runBoth(file)) {
    assert.equal(result.text, '前言。結論。');
    assert.equal(result.replyParts, undefined);
  }
});

test('只有某一段觸發工具呼叫外洩的警示時沒有 replyParts，不讓摺疊版面顯示全文沒有的警示', async () => {
  const conclusion = '結論：'.padEnd(60, '甲');
  const file = writeStdout([
    ev.start(),
    ev.text('</function>'.repeat(6)),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.text('前一步的說明。'),
    ev.tool(),
    ev.finish('tool-calls'),
    ev.start(),
    ev.text(conclusion),
    ev.finish('stop')
  ]);
  for (const result of await runBoth(file)) {
    assert.equal(result.text, `前一步的說明。${conclusion}`);
    assert.equal(result.replyParts, undefined);
  }
});
