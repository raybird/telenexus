#!/usr/bin/env node
// 假上游:OpenAI 相容的 /chat/completions,一律回 "OK"(串流與非串流都支援)。只聽 127.0.0.1。
import http from 'node:http';

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // 非 JSON 就當成非串流
    }
    const model = body.model || 'ok';
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} model=${model} stream=${Boolean(body.stream)}`);
    const base = { id: 'mock-1', created: 0, model };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: 'OK' }, null));
    res.write(
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
    );
    res.end('data: [DONE]\n\n');
  });
});
server.listen(Number(process.env.PORT || 18427), '127.0.0.1', () => {
  console.log(`listening ${server.address().port}`);
});
