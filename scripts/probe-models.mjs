#!/usr/bin/env node
/**
 * 模型可用性探針 —— 換模型前的實測工具。
 *
 * 為什麼不能只打 "ping":
 *   上游的 429 是按 **token 流量** 計費而不是請求數。2026-08-29 實測,
 *   nvidia/moonshotai/kimi-k3 對一句 "hi" 回 200、工具呼叫一切正常,但一放進
 *   opencode 的完整 system prompt + 全套工具定義就吃了 12 次 429 跑到逾時。
 *   用最小 prompt 探測會把這種模型判成健康的 —— 這正是 2026-08-25 那次
 *   全面失效沒被及早發現的原因之一。
 *   所以本工具預設用「會動用網路工具、要求中文摘要」的真實任務形狀 prompt。
 *
 * 為什麼要 --print-logs:
 *   opencode 預設把上游錯誤只寫進 ~/.local/share/opencode/log/*.log,stderr 與
 *   stdout 全程沒有任何線索。少了這個旗標,429 與 EOL 都只會表現成「跑很久然後
 *   沒有輸出」,分不出是哪一種。
 *
 * 為什麼一次只跑一顆:
 *   並行探測會自己製造出 429,把健康的模型冤枉成限流。慢一點但結論可信。
 *
 * 用法:
 *   node scripts/probe-models.mjs                          # 測 ai-config.yaml 目前這顆
 *   node scripts/probe-models.mjs --all                    # 測 `opencode models` 全清單
 *   node scripts/probe-models.mjs --models a,b,c           # 測指定的幾顆
 *   node scripts/probe-models.mjs --all --rounds 3         # 每顆跑 3 輪看穩定性
 *   node scripts/probe-models.mjs --json                   # 機器可讀輸出
 *
 * 正式環境(無原始碼)請用:
 *   docker compose exec agent-runner node scripts/probe-models.mjs --all
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 真實任務形狀的 prompt:必須逼模型動用工具,並且要求可驗證的中文輸出。 */
const DEFAULT_PROMPT =
  '請搜尋比特幣目前價格，並用繁體中文給我一段 3 行以內的簡短摘要。請直接給最終結果。';

const DEFAULT_TIMEOUT_SEC = 240;
const DEFAULT_ROUNDS = 1;
/** 低於這個字數視為沒有實際產出 —— 空輸出跟成功長得一樣,必須分開。 */
const MIN_USEFUL_TEXT_LENGTH = 10;

/**
 * 非對話類模型:embedding / 圖像 / 語音 / 電腦視覺 / 安全分類器。
 * 這些打 chat/completions 會回 404 或根本不該進排程,--all 時直接略過。
 */
const NON_CHAT_PATTERN =
  /bge-m3|black-forest-labs|paligemma|esm2|esmfold|llama-guard|active-speaker|bevformer|cosmos-|gliner-pii|nemoretriever|embed|rerank|magpie-tts|content-safety|safety-guard|voicechat|riva-translate|sparsedrive|streampetr|studiovoice|synthetic-video|usdcode|usdvalidate|whisper|qwen-image/;

const VERDICTS = {
  ok: { label: '✅ 可用', order: 0 },
  'empty-output': { label: '⚠️  空輸出', order: 1 },
  'rate-limited': { label: '⛔ 429 限流', order: 2 },
  eol: { label: '⛔ 已下架', order: 3 },
  'not-found': { label: '⛔ 模型不存在', order: 4 },
  timeout: { label: '⛔ 逾時', order: 5 },
  error: { label: '⛔ 錯誤', order: 6 }
};

function parseArgs(argv) {
  const options = {
    all: false,
    models: [],
    rounds: DEFAULT_ROUNDS,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    prompt: DEFAULT_PROMPT,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === '--all') options.all = true;
    else if (arg === '--models') options.models = (next() || '').split(',').filter(Boolean);
    else if (arg === '--rounds') options.rounds = Math.max(1, Number.parseInt(next(), 10) || 1);
    else if (arg === '--timeout')
      options.timeoutSec = Math.max(10, Number.parseInt(next(), 10) || DEFAULT_TIMEOUT_SEC);
    else if (arg === '--prompt') options.prompt = next() || DEFAULT_PROMPT;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`未知參數: ${arg}\n`);
      printUsage();
      process.exit(1);
    }
  }
  return options;
}

function printUsage() {
  console.log(`模型可用性探針

  --all              測 \`opencode models\` 全清單（自動略過非對話類模型）
  --models a,b,c     測指定模型（逗號分隔）
  --rounds N         每顆模型跑 N 輪，看穩定性（預設 ${DEFAULT_ROUNDS}）
  --timeout S        每輪逾時秒數（預設 ${DEFAULT_TIMEOUT_SEC}）
  --prompt "..."     自訂探測 prompt（預設是會動用網路工具的真實任務）
  --json             輸出 JSON

不給 --all / --models 時，測 ai-config.yaml 目前設定的那一顆。`);
}

/** 讀 ai-config.yaml 的 model —— 只做單行比對，不引 YAML 套件（此腳本要能在無 devDeps 的正式映像裡跑）。 */
function readConfiguredModel() {
  const configPath = path.resolve(process.env.APP_PROJECT_DIR || process.cwd(), 'ai-config.yaml');
  try {
    for (const line of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^model:\s*(\S+)/);
      if (match) return match[1];
    }
  } catch {
    // 讀不到就讓呼叫端報錯，不要猜。
  }
  return null;
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error), timedOut, durationMs: 0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    });
  });
}

async function listAllModels(timeoutMs) {
  const { stdout, code } = await runCommand('opencode', ['models'], timeoutMs);
  if (code !== 0) {
    throw new Error('`opencode models` 執行失敗，無法取得模型清單');
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((model) => !NON_CHAT_PATTERN.test(model));
}

/** 從 opencode 的 JSON events 取出最終回覆文字。 */
function extractText(stdout) {
  let text = '';
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      if (event.part?.type === 'text' && typeof event.part.text === 'string') {
        text = event.part.text;
      }
    } catch {
      // 半行 / 非 JSON 直接略過。
    }
  }
  return text.trim();
}

/**
 * 上游限流判定。必須與 src/core/rate-limit.ts 的 UPSTREAM_RATE_LIMIT_PATTERN 保持一致 ——
 * 這支腳本要能在沒有原始碼、沒有建置的正式映像裡直接跑，無法 import 那邊的 TypeScript。
 * 刻意只認結構化 HTTP 欄位：--print-logs 會回吐整包 request body，寬鬆的 \b429\b 會被
 * 「成交量 429 億美元」這種市場數據誤觸。
 */
const RATE_LIMIT_PATTERN =
  /"status(?:Code)?"\s*:\s*429\b|\bstatus(?:Code)?[=\s]+429\b|RESOURCE_EXHAUSTED/i;

function classify({ code, stdout, stderr, timedOut }) {
  // 先看結構化的 HTTP 訊號 —— 它比 exit code 精確。
  if (RATE_LIMIT_PATTERN.test(stderr)) return 'rate-limited';
  if (/"status(?:Code)?"\s*:\s*410\b|end of life|\bGone\b/i.test(stderr)) return 'eol';
  if (/ProviderModelNotFoundError|Model not found/i.test(stderr)) return 'not-found';
  if (timedOut) return 'timeout';
  if (code !== 0) return 'error';

  const text = extractText(stdout);
  if (text.length < MIN_USEFUL_TEXT_LENGTH) return 'empty-output';
  return 'ok';
}

function count429(stderr) {
  return (stderr.match(new RegExp(RATE_LIMIT_PATTERN.source, 'gi')) || []).length;
}

/** 多輪取最差結果 —— 間歇性故障比平均值重要；能跑但偶爾掛掉的模型不能進排程。 */
function worstVerdict(rounds) {
  return rounds.reduce(
    (worst, round) =>
      VERDICTS[round.verdict].order > VERDICTS[worst].order ? round.verdict : worst,
    'ok'
  );
}

async function probeModel(model, options) {
  const rounds = [];
  for (let round = 1; round <= options.rounds; round += 1) {
    const result = await runCommand(
      'opencode',
      [
        'run',
        '--format',
        'json',
        '--print-logs',
        '--log-level',
        'ERROR',
        '--model',
        model,
        options.prompt
      ],
      options.timeoutSec * 1000
    );
    rounds.push({
      round,
      verdict: classify(result),
      durationMs: result.durationMs,
      textLength: extractText(result.stdout).length,
      rateLimitHits: count429(result.stderr),
      sample: extractText(result.stdout).replace(/\s+/g, ' ').slice(0, 70)
    });
  }
  return { model, verdict: worstVerdict(rounds), rounds };
}

function renderTable(results) {
  const sorted = [...results].sort(
    (a, b) =>
      VERDICTS[a.verdict].order - VERDICTS[b.verdict].order || a.model.localeCompare(b.model)
  );
  const modelWidth = Math.max(...sorted.map((r) => r.model.length), 5);

  console.log('');
  for (const result of sorted) {
    const durations = result.rounds.map((r) => `${Math.round(r.durationMs / 1000)}s`).join('/');
    const hits = result.rounds.reduce((sum, r) => sum + r.rateLimitHits, 0);
    const lengths = result.rounds.map((r) => r.textLength).join('/');
    console.log(
      `${VERDICTS[result.verdict].label.padEnd(14)} ${result.model.padEnd(modelWidth)}  ` +
        `${durations.padStart(10)}  len=${lengths.padEnd(10)}` +
        (hits > 0 ? `  429×${hits}` : '')
    );
    const sample = result.rounds.find((r) => r.sample)?.sample;
    if (sample) console.log(`${' '.repeat(16)}↳ ${sample}`);
  }

  const usable = sorted.filter((r) => r.verdict === 'ok');
  console.log(`\n可用 ${usable.length} / 共測 ${sorted.length} 顆`);
  if (usable.length > 0) {
    console.log('\n把其中一顆寫進 ai-config.yaml 的 model:');
    for (const result of usable) console.log(`  model: ${result.model}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let models;
  if (options.all) {
    models = await listAllModels(60_000);
  } else if (options.models.length > 0) {
    models = options.models;
  } else {
    const configured = readConfiguredModel();
    if (!configured) {
      console.error('讀不到 ai-config.yaml 的 model，請改用 --models 或 --all');
      process.exit(1);
    }
    models = [configured];
  }

  if (!options.json) {
    console.log(`探測 ${models.length} 顆模型，每顆 ${options.rounds} 輪，逐一執行（不並行）。`);
    console.log(`prompt: ${options.prompt}`);
    console.log(`預估最長耗時: ${models.length * options.rounds * options.timeoutSec} 秒\n`);
  }

  const results = [];
  for (const [index, model] of models.entries()) {
    if (!options.json) process.stderr.write(`[${index + 1}/${models.length}] ${model} ... `);
    const result = await probeModel(model, options);
    results.push(result);
    if (!options.json) process.stderr.write(`${VERDICTS[result.verdict].label}\n`);
  }

  if (options.json) {
    console.log(JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
  } else {
    renderTable(results);
  }

  // 有任何一顆不可用就給非零 exit code，方便接 CI 或排程告警。
  process.exit(results.every((r) => r.verdict === 'ok') ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
