import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';

// 2026-10-05：假 provider 只選工具；正文與 URL 必須由真 Chrome 回傳。
const root = '/tmp/scn008';
for (const path of [root, `${root}/workspace`, `${root}/data`, `${root}/config/opencode`]) mkdirSync(path, { recursive: true });
writeFileSync(`${root}/ai-config.yaml`, 'provider: opencode\nmodel: probe/contract\n');
writeFileSync(`${root}/config/opencode/opencode.json`, '{}');
let calls = 0;
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<main id="body">WAIT</main><script>document.querySelector("#body").textContent="SCN008_REAL_CHROME"</script>');
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    let delta = { role: 'assistant', content: 'Termination fixture' };
    let finish = 'stop';
    if (body.tools?.length) {
      if (calls === 2) {
        const content = JSON.stringify(body.messages.filter(message => message.role === 'tool'));
        assert.ok(content.includes('SCN008_REAL_CHROME') && content.includes('http://127.0.0.1:19112/page'));
        console.log(JSON.stringify({ event: 'browser-held', content }));
        return;
      }
      const name = calls++ === 0 ? 'telenexus_browser_navigate' : 'telenexus_browser_evaluate';
      assert.ok(body.tools.some(tool => tool.function.name === name));
      const args = name.endsWith('navigate') ? { url: 'http://127.0.0.1:19112/page' } : { script: 'JSON.stringify({body:document.querySelector("#body").textContent,url:location.href})' };
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: `termination-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      finish = 'tool_calls';
    }
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ id: 'scn008', object: 'chat.completion.chunk', created: 1, model: 'contract', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'scn008', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch (error) {
    console.log(JSON.stringify({ event: 'fixture-error', message: error.message }));
    response.writeHead(500); response.end(error.message);
  }
});
server.listen(19112, '127.0.0.1', async () => {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if ((await fetch('http://127.0.0.1:19110/health')).ok) break;
    } catch { /* 2026-10-05：runner 啟動前可重試。 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const response = await fetch('http://127.0.0.1:19110/run/stream', { method: 'POST', headers: { 'content-type': 'application/json', 'x-runner-token': 'scn008-fixture' }, body: JSON.stringify({ task: 'chat', input: '使用瀏覽器讀取 http://127.0.0.1:19112/page', provider: 'opencode', model: 'probe/contract', forceNewSession: true, lane: 'interactive', requestId: 'scn008-termination' }) });
  console.log(JSON.stringify({ event: 'runner-response', status: response.status }));
  console.log(JSON.stringify({ event: 'runner-response-end', body: await response.text() }));
});
