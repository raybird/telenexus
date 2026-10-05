import { DynamicAIAgent } from '/app/dist/core/agent.js';

// 2026-10-04：使用真正 DynamicAIAgent local 路徑，禁止 runner fallback 掩蓋失敗。
const [entry, url, configPath, lane = 'interactive'] = process.argv.slice(2);
const controller = new AbortController();
process.on('message', message => { if (message?.action === 'cancel') controller.abort(); });
const agent = new DynamicAIAgent(configPath, { preferRunner: false, fallbackToLocal: false });
const options = { model: 'probe/contract', forceNewSession: true, fromScheduler: lane === 'scheduled', signal: controller.signal };
try {
  const prompt = `使用工具讀取 ${url}`;
  const result = entry === 'stream'
    ? await agent.streamChat(prompt, options, value => console.log(JSON.stringify({ event: 'local-stream', value })))
    : { text: await agent.chat(prompt, options) };
  console.log(JSON.stringify({ event: 'local-result', result }));
} catch (error) {
  console.log(JSON.stringify({ event: 'local-error', message: error.message }));
  process.exitCode = 1;
} finally {
  process.disconnect();
}
