#!/usr/bin/env node
// 本機假上游(工具呼叫版):主代理的第一個請求回一個 read 工具呼叫(讀工作目錄外的檔案),
// 收到工具結果後回一句文字。用來在不需要真實模型的情況下,比較各版本的權限行為。
import http from 'node:http';

const target = process.env.MARKER_PATH;
const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
};
const chunk = (delta, finish = null) => ({
  id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'tool-read',
  choices: [{ index: 0, delta, finish_reason: finish }]
});
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const toolMsg = body.messages.filter((m) => m.role === 'tool').pop();
      let kind;
      if (!hasTools) {
        kind = 'title';
        sse(res, [chunk({ role: 'assistant', content: 'mock title' }), { ...chunk({}, 'stop'), usage }]);
      } else if (!toolMsg) {
        kind = 'tool-call';
        sse(res, [
          chunk({
            role: 'assistant', content: null,
            tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ filePath: target }) } }]
          }),
          { ...chunk({}, 'tool_calls'), usage }
        ]);
      } else {
        kind = 'final';
        const content = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content);
        sse(res, [chunk({ role: 'assistant', content: `tool result was: ${content.slice(0, 120)}` }), { ...chunk({}, 'stop'), usage }]);
      }
      console.log(`${new Date().toISOString()} ${kind}`);
    });
  })
  .listen(18427, '127.0.0.1', () => console.log('listening 18427'));
