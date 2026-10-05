import { OpencodeAgent } from '/app/dist/core/opencode.js';

// 2026-10-04：只透過產品公開入口執行，browser MCP 設定必須由產品自行注入。
const [entry = 'structured', url, lane = 'interactive'] = process.argv.slice(2);
const controller = new AbortController();
process.on('message', message => {
  if (message?.action === 'cancel') controller.abort();
});
const options = { model: 'probe/contract', forceNewSession: true, fromScheduler: lane === 'scheduled', signal: controller.signal };
try {
  const agent = new OpencodeAgent();
  const prompt = `使用工具讀取 ${url}`;
  const result = entry === 'stream'
    ? await agent.streamChat(prompt, options, event => console.log(JSON.stringify({ event: 'product-stream', value: event })))
    : await agent.chatStructured(prompt, options);
  console.log(JSON.stringify({ event: 'product-result', result }));
  process.disconnect();
} catch (error) {
  console.log(JSON.stringify({ event: 'product-error', message: error.message }));
  process.exitCode = 1;
  process.disconnect();
}
