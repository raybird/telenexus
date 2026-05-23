import test from 'node:test';
import assert from 'node:assert/strict';
import { OpencodeAgent } from '../src/core/opencode.js';

class TestOpencodeAgent extends OpencodeAgent {
  parse(line: string) {
    return this.parseStreamLine(line);
  }
}

test('OpencodeAgent parseStreamLine maps JSON tool events to status updates', () => {
  const agent = new TestOpencodeAgent();

  assert.deepEqual(
    agent.parse(JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: {} })),
    {
      sessionId: 'ses_1',
      emitStart: true,
      statusText: '開始處理請求...'
    }
  );

  assert.deepEqual(
    agent.parse(
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses_1',
        part: {
          tool: 'read',
          state: {
            input: { filePath: '/app/workspace/projects/three-kingdoms-map/README.md' }
          }
        }
      })
    ),
    {
      sessionId: 'ses_1',
      statusText: '正在讀取檔案：/app/workspace/projects/three-kingdoms-map/README.md...'
    }
  );

  assert.deepEqual(
    agent.parse(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_1',
        part: { reason: 'tool-calls', tokens: { total: 10 } }
      })
    ),
    {
      sessionId: 'ses_1',
      statusText: '工具執行完成，等待模型整理回覆...',
      stats: { tokens: { total: 10 }, reason: 'tool-calls' }
    }
  );

  assert.deepEqual(
    agent.parse(JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: '完成' } })),
    {
      sessionId: 'ses_1',
      deltaText: '完成'
    }
  );
});
