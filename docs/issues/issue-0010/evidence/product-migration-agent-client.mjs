import { OpencodeAgent } from '/app/dist/core/opencode.js';

// 2026-10-04：只包裝產品入口；stdout／stderr 由外層完整保存，不覆寫共用 logger。
const [prompt, forceNewSession] = process.argv.slice(2);
try {
  const result = await new OpencodeAgent().chatStructured(prompt, { model: 'probe/contract', forceNewSession: forceNewSession === 'true' });
  console.log(JSON.stringify({ event: 'migration-client-result', result }));
} catch (error) {
  console.log(JSON.stringify({ event: 'migration-client-error', message: error.message }));
  process.exitCode = 1;
}
