// issue 0024 步驟 6：在 runner 容器內呼叫 POST /run，送一則使用者訊息。
// cancel 模式：看到 wrapper 程序出現後 3 秒中斷 HTTP 連線，runner 會依連線關閉取消這個回合
// （與 telenexus 取消時的路徑相同）。150 秒內沒看到 wrapper 也中斷，並如實記錄。
import { readFileSync, readdirSync } from 'node:fs';

const [mode, url, promptMode = 'raw'] = process.argv.slice(2);
const userMessage = `幫我讀這個網頁，告訴我正文寫了什麼，並附上網址：${url}`;
// full：與 src/main.ts 的 buildPromptFn 在 full 模式組出的提示詞相同（新使用者、沒有記憶內容、
// 沒有排程與異常、Memoria 可用），skills-summary 取自技能同步剛產生的檔案。
async function buildFullPrompt() {
  const { buildChatPrompt } = await import('/app/dist/prompt/builder.js');
  const { loadChatPromptConfig } = await import('/app/dist/config/ai-config.js');
  const { buildMemoriaCapabilityHint } = await import('/app/dist/prompt/memoria-capability.js');
  const systemSummary = ['- 活躍排程：0 個', '- 最近 15 分鐘異常：0 筆', '- 記憶庫：0 條訊息'].join('\n');
  const skillsHint = readFileSync('/app/workspace/context/skills-summary.md', 'utf8').trim();
  return buildChatPrompt(loadChatPromptConfig(), userMessage, '', 'full', buildMemoriaCapabilityHint(true), systemSummary, skillsHint);
}
const input = promptMode === 'full' ? await buildFullPrompt() : userMessage;
const started = Date.now();
const controller = new AbortController();
let wrapperSeenAt = null;
let abortedAt = null;
const wrapperRunning = () => readdirSync('/proc').some((pid) => {
  try { return /^\d+$/.test(pid) && readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'opencode' && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('telenexus-moli-fetch'); } catch { return false; }
});
if (mode === 'cancel') {
  const poll = setInterval(() => {
    if (!wrapperSeenAt && wrapperRunning()) {
      wrapperSeenAt = Date.now();
      setTimeout(() => { abortedAt = Date.now(); controller.abort(); }, 3000);
      clearInterval(poll);
    } else if (Date.now() - started > 150000) { abortedAt = Date.now(); controller.abort(); clearInterval(poll); }
  }, 100);
}
const result = { mode, promptMode, url, input, started };
// 2026-11-12 第四輪：改用 http.request。全域 fetch 有 300 秒的 headersTimeout，
// 慢模型的回合超過時 client 斷線，runner 會把它當成取消。
const http = await import('node:http');
try {
  const { status, text } = await new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:8787/run', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ task: 'chat', input, forceNewSession: true, lane: 'interactive' }));
  });
  result.httpStatus = status;
  result.body = JSON.parse(text);
} catch (err) {
  result.error = String(err?.name || err);
}
Object.assign(result, { ended: Date.now(), wrapperSeenAt, abortedAt });
console.log(JSON.stringify(result));
process.exit(0);
