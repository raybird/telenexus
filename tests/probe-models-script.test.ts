import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UPSTREAM_QUOTA_EXHAUSTED_PATTERN,
  UPSTREAM_RATE_LIMIT_PATTERN
} from '../src/core/rate-limit.js';
import { loadAiConfig } from '../src/core/config-loader.js';

/**
 * Issue 0008:scripts/probe-models.mjs 要認得上游的 error 事件。
 *
 * 這支腳本得在沒有原始碼的正式映像裡直接跑,所以判定是 TypeScript 端的刻意複本,而且
 * 一載入就執行 main()、沒有可匯入的函式。這裡把它當成黑盒子:實際執行腳本,PATH 最前面
 * 放一支吐回 fixture 的假 `opencode`。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'probe-models.mjs');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'opencode');

type FakeRun = { stdout?: string; stderr?: string; exit?: number; sleepSec?: number };
type Round = { verdict: string; statusCode?: number; rateLimitHits: number };
type ProbeResult = { model: string; verdict: string; rounds: Round[] };

let binDir = '';

before(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-fake-opencode-script-'));
  fs.writeFileSync(
    path.join(binDir, 'opencode'),
    `#!/bin/sh
if [ "$1" = models ] && [ -n "$FAKE_OPENCODE_MODELS" ]; then printf '%s\\n' "$FAKE_OPENCODE_MODELS"; exit 0; fi
[ -n "$FAKE_OPENCODE_STDERR" ] && cat "$FAKE_OPENCODE_STDERR" >&2
[ -n "$FAKE_OPENCODE_STDOUT" ] && cat "$FAKE_OPENCODE_STDOUT"
[ -n "$FAKE_OPENCODE_SLEEP" ] && exec sleep "$FAKE_OPENCODE_SLEEP"
exit "\${FAKE_OPENCODE_EXIT:-0}"
`,
    { mode: 0o755 }
  );
});

after(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

function runScript(run: FakeRun, extraArgs: string[] = []) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_OPENCODE_EXIT: String(run.exit ?? 0)
  };
  delete env.FAKE_OPENCODE_STDOUT;
  delete env.FAKE_OPENCODE_STDERR;
  delete env.FAKE_OPENCODE_SLEEP;
  if (run.sleepSec !== undefined) env.FAKE_OPENCODE_SLEEP = String(run.sleepSec);
  if (run.stdout) env.FAKE_OPENCODE_STDOUT = path.join(FIXTURES, run.stdout);
  if (run.stderr) env.FAKE_OPENCODE_STDERR = path.join(FIXTURES, run.stderr);

  return spawnSync(process.execPath, [SCRIPT, '--models', 'mock/model', ...extraArgs], {
    env,
    encoding: 'utf8',
    timeout: 30_000
  });
}

function probe(run: FakeRun): { result: ProbeResult; exitCode: number | null } {
  const child = runScript(run, ['--json']);
  const parsed = JSON.parse(child.stdout) as { results: ProbeResult[] };
  assert.equal(parsed.results.length, 1);
  return { result: parsed.results[0]!, exitCode: child.status };
}

const UPSTREAM_426: { label: string; run: FakeRun }[] = [
  { label: '1.15.10 exit 0', run: { stdout: '1.15.10-upstream-426.stdout.jsonl', exit: 0 } },
  {
    label: '1.18.34 exit 1',
    run: {
      stdout: '1.18.34-upstream-426.stdout.jsonl',
      stderr: '1.18.34-upstream-426.stderr.txt',
      exit: 1
    }
  }
];

for (const { label, run } of UPSTREAM_426) {
  test(`SCN-007 上游 426 標示為不可用並列出狀態碼,不是空輸出(${label})`, () => {
    const { result, exitCode } = probe(run);

    assert.equal(result.verdict, 'client-outdated');
    assert.equal(result.rounds[0]?.statusCode, 426);
    assert.equal(exitCode, 1, '有模型不可用時腳本以非 0 結束');
  });
}

test('SCN-007 表格輸出列出狀態碼與處置方向', () => {
  const child = runScript({ stdout: '1.15.10-upstream-426.stdout.jsonl', exit: 0 });

  assert.match(child.stdout, /HTTP 426/);
  assert.match(child.stdout, /升級 opencode/);
  assert.match(child.stdout, /可用 0 \/ 共測 1 顆/);
});

test('SCN-007 410 的 error 事件標示為已下架', () => {
  const { result } = probe({ stdout: '1.18.34-upstream-410.stdout.jsonl', exit: 1 });
  assert.equal(result.verdict, 'eol');
  assert.equal(result.rounds[0]?.statusCode, 410);
});

test('SCN-007 未列舉的狀態碼標示為上游錯誤', () => {
  const { result } = probe({ stdout: '1.18.34-upstream-404.stdout.jsonl', exit: 1 });
  assert.equal(result.verdict, 'upstream-error');
  assert.equal(result.rounds[0]?.statusCode, 404);
});

test('SCN-007 模型不存在仍由 stderr 判定', () => {
  const { result } = probe({
    stdout: '1.18.34-model-not-found.stdout.jsonl',
    stderr: '1.18.34-model-not-found.stderr.txt',
    exit: 1
  });
  assert.equal(result.verdict, 'not-found');
});

test('SCN-007 認得 opencode 1.18 stderr 裡的限流', () => {
  const { result } = probe({
    stdout: '1.18.34-ok-mentions-426.stdout.jsonl',
    stderr: '1.18.34-upstream-429-retry.stderr.txt',
    exit: 0
  });
  assert.equal(result.verdict, 'rate-limited');
  // fixture 裡主代理的 stream error 有 5 行,標題代理的 1 行不算。
  assert.equal(result.rounds[0]?.rateLimitHits, 5);
});

test('SCN-005 正常回合標示為可用,即使回覆文字提到 426 與 error', () => {
  const { result, exitCode } = probe({ stdout: '1.18.34-ok-mentions-426.stdout.jsonl', exit: 0 });
  assert.equal(result.verdict, 'ok');
  assert.equal(result.rounds[0]?.statusCode, undefined);
  assert.equal(exitCode, 0);
});

test('限流樣式與 src/core/rate-limit.ts 的那一份完全相同', () => {
  // 兩邊無法共用程式碼(腳本要在沒有建置的映像裡跑),只能靠這個斷言防止各自演化。
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const match = source.match(/const RATE_LIMIT_PATTERN =\s*\/(.+)\/i;/);
  assert.ok(match, '找不到 RATE_LIMIT_PATTERN 的定義');
  assert.equal(match[1], UPSTREAM_RATE_LIMIT_PATTERN.source);
  assert.equal(UPSTREAM_RATE_LIMIT_PATTERN.flags, 'i');
});

test('issue 0023 額度用完的樣式與 src/core/rate-limit.ts 的那一份完全相同', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const match = source.match(/const QUOTA_EXHAUSTED_PATTERN =\s*\/(.+)\/i;/);
  assert.ok(match, '找不到 QUOTA_EXHAUSTED_PATTERN 的定義');
  assert.equal(match[1], UPSTREAM_QUOTA_EXHAUSTED_PATTERN.source);
  assert.equal(UPSTREAM_QUOTA_EXHAUSTED_PATTERN.flags, 'i');
});

// ── issue 0023 SCN-004：免費額度用完 ───────────────────────────────────────

test('issue 0023 SCN-004 額度用完時該輪立刻結束，標示為額度用完而不是逾時', () => {
  // opencode 在背景重試、stdout 空白（步驟 1 實測）；--timeout 給 60 秒，該輪仍要很快結束。
  const startedAt = Date.now();
  const child = runScript({ stderr: '1.18.34-free-usage-limit.stderr.txt', sleepSec: 20 }, [
    '--json',
    '--rounds',
    '1',
    '--timeout',
    '60'
  ]);
  const elapsedMs = Date.now() - startedAt;
  const parsed = JSON.parse(child.stdout) as { results: ProbeResult[] };
  const result = parsed.results[0];

  assert.ok(elapsedMs < 8000, `應在幾秒內結束，實際 ${elapsedMs}ms`);
  assert.equal(result?.verdict, 'quota-exhausted');
  assert.equal(result?.rounds[0]?.verdict, 'quota-exhausted');
});

test('issue 0023 SCN-004 額度用完排在限流之前判定，表格顯示「⛔ 額度用完」', () => {
  const { result } = probe({ stderr: '1.18.34-free-usage-limit.stderr.txt', exit: 0 });
  assert.equal(result.verdict, 'quota-exhausted');

  const child = runScript({ stderr: '1.18.34-free-usage-limit.stderr.txt', exit: 0 }, [
    '--rounds',
    '1'
  ]);
  assert.match(child.stdout, /⛔ 額度用完/);
  assert.doesNotMatch(child.stdout, /⛔ 429 限流|⛔ 逾時|429×/);
  assert.equal(result.rounds[0]?.rateLimitHits, 0);
});

test('issue 0023 SCN-007 一般 429 仍是限流，不提早中止', () => {
  const startedAt = Date.now();
  const child = runScript({ stderr: '1.18.34-upstream-429-retry.stderr.txt', sleepSec: 20 }, [
    '--json',
    '--rounds',
    '1',
    '--timeout',
    '10'
  ]);
  const elapsedMs = Date.now() - startedAt;
  const parsed = JSON.parse(child.stdout) as { results: ProbeResult[] };

  assert.ok(elapsedMs >= 9500, `一般 429 應等到 --timeout，實際 ${elapsedMs}ms`);
  assert.equal(parsed.results[0]?.verdict, 'rate-limited');
});

// ── issue 0029：不帶參數時測合併 override 之後實際生效的模型 ─────────────────

type ConfigFiles = { base?: string; override?: string };
type ConfigInfo = {
  model: string | null;
  source: string | null;
  baseModel: string | null;
  overrideModel: string | null;
};
type ProjectRun = { stdout: string; stderr: string; status: number | null };

const OK_STDOUT = path.join(FIXTURES, '1.18.34-ok-mentions-426.stdout.jsonl');

/** 建一個暫存專案目錄放兩個設定檔；`undefined` 代表該檔不存在。 */
function makeProject(files: ConfigFiles): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-probe-config-'));
  fs.mkdirSync(path.join(dir, 'data'));
  if (files.base !== undefined) fs.writeFileSync(path.join(dir, 'ai-config.yaml'), files.base);
  if (files.override !== undefined) {
    fs.writeFileSync(path.join(dir, 'data', 'ai-config.override.yaml'), files.override);
  }
  return dir;
}

/** 在專案目錄裡執行腳本（與正式映像相同：cwd 與 APP_PROJECT_DIR 都是專案目錄）。 */
function runInProject(
  files: ConfigFiles,
  args: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {}
): ProjectRun {
  const dir = makeProject(files);
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      APP_PROJECT_DIR: dir,
      FAKE_OPENCODE_STDOUT: OK_STDOUT,
      FAKE_OPENCODE_EXIT: '0',
      ...extraEnv
    };
    delete env.FAKE_OPENCODE_STDERR;
    delete env.FAKE_OPENCODE_SLEEP;
    const child = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 30_000
    });
    return { stdout: child.stdout, stderr: child.stderr, status: child.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function probeConfig(files: ConfigFiles): {
  config?: ConfigInfo;
  models: string[];
  run: ProjectRun;
} {
  const run = runInProject(files, ['--json']);
  if (run.status !== 0) return { models: [], run };
  const parsed = JSON.parse(run.stdout) as { config?: ConfigInfo; results: ProbeResult[] };
  return {
    ...(parsed.config ? { config: parsed.config } : {}),
    models: parsed.results.map((r) => r.model),
    run
  };
}

/** config-loader 在同一個專案目錄上算出的模型（resolveOverridePath 依 APP_PROJECT_DIR）。 */
function loaderModel(files: ConfigFiles): string | null {
  const dir = makeProject(files);
  const saved = process.env.APP_PROJECT_DIR;
  process.env.APP_PROJECT_DIR = dir;
  try {
    return loadAiConfig({ basePath: path.join(dir, 'ai-config.yaml') }).model ?? null;
  } finally {
    if (saved === undefined) delete process.env.APP_PROJECT_DIR;
    else process.env.APP_PROJECT_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PARITY_CASES: { label: string; files: ConfigFiles }[] = [
  {
    label: '沒有 override 檔',
    files: { base: 'provider: opencode\nmodel: opencode/big-pickle\n' }
  },
  {
    label: 'override 與 ai-config.yaml 相同',
    files: { base: 'model: opencode/big-pickle\n', override: 'model: opencode/big-pickle\n' }
  },
  {
    label: 'override 與 ai-config.yaml 不同',
    files: { base: 'model: opencode/big-pickle\n', override: 'model: nvidia/z-ai/glm-5.3-flash\n' }
  },
  {
    label: 'override 的 model 空白',
    files: { base: 'model: opencode/big-pickle\n', override: 'model: "   "\n' }
  },
  {
    label: 'override 的 model 不是字串',
    files: { base: 'model: opencode/big-pickle\n', override: 'model: 123\n' }
  },
  {
    label: 'override 的 YAML 壞掉',
    files: { base: 'model: opencode/big-pickle\n', override: 'model: [nvidia/x\n' }
  },
  { label: 'override 檔是空的', files: { base: 'model: opencode/big-pickle\n', override: '' } },
  {
    label: '值加了引號與前後空白',
    files: { base: "model: '  opencode/big-pickle  '\n", override: 'model: "nvidia/quoted"\n' }
  },
  {
    label: 'ai-config.yaml 的值加引號、後面有註解',
    files: { base: 'model: "opencode/big-pickle" # 預設\n' }
  },
  { label: 'ai-config.yaml 的值前後有空白', files: { base: "model: '  opencode/big-pickle  '\n" } },
  { label: '缺 ai-config.yaml', files: { override: 'model: nvidia/z-ai/glm-5.3-flash\n' } },
  {
    label: 'model 在巢狀區塊裡不算頂層設定',
    files: { base: 'chat_prompt:\n  model: nested/x\nmodel: opencode/big-pickle\n' }
  },
  { label: '兩個檔都沒有模型', files: { base: 'provider: opencode\n' } }
];

for (const { label, files } of PARITY_CASES) {
  test(`issue 0029 AC-3 探針選出的模型與 loadAiConfig() 相同：${label}`, () => {
    const expected = loaderModel(files);
    const { config, models, run } = probeConfig(files);
    if (expected === null) {
      assert.equal(run.status, 1, '讀不到模型時以 1 結束');
      assert.deepEqual(models, []);
      return;
    }
    assert.deepEqual(models, [expected], '只探測生效的那一顆');
    assert.equal(config?.model, expected);
  });
}

test('issue 0029 AC-1 override 與 ai-config.yaml 不同時只測 override，並標明兩邊的來源', () => {
  const files = {
    base: 'model: opencode/big-pickle\n',
    override: 'model: nvidia/z-ai/glm-5.3-flash\n'
  };
  const { config, models } = probeConfig(files);
  assert.deepEqual(config, {
    model: 'nvidia/z-ai/glm-5.3-flash',
    source: 'data/ai-config.override.yaml',
    baseModel: 'opencode/big-pickle',
    overrideModel: 'nvidia/z-ai/glm-5.3-flash'
  });
  assert.deepEqual(models, ['nvidia/z-ai/glm-5.3-flash']);

  const text = runInProject(files).stdout;
  assert.match(
    text,
    /模型來源：data\/ai-config\.override\.yaml（\/set_model）＝nvidia\/z-ai\/glm-5\.3-flash/
  );
  assert.match(
    text,
    /ai-config\.yaml＝opencode\/big-pickle（已被覆寫，不測；要測請用 --models opencode\/big-pickle）/
  );
});

test('issue 0029 AC-2 沒有 override 時測 ai-config.yaml，來源標 ai-config.yaml', () => {
  const files = { base: 'model: opencode/big-pickle\n' };
  const { config, models } = probeConfig(files);
  assert.deepEqual(config, {
    model: 'opencode/big-pickle',
    source: 'ai-config.yaml',
    baseModel: 'opencode/big-pickle',
    overrideModel: null
  });
  assert.deepEqual(models, ['opencode/big-pickle']);
  const text = runInProject(files).stdout;
  assert.match(text, /模型來源：ai-config\.yaml＝opencode\/big-pickle/);
  assert.doesNotMatch(text, /override/);
});

test('issue 0029 AC-2 override 空白或不是字串時照 ai-config.yaml', () => {
  for (const override of ['model: ""\n', 'model: 123\n', 'model:\n  - a/b\n']) {
    const { config } = probeConfig({ base: 'model: opencode/big-pickle\n', override });
    assert.equal(config?.source, 'ai-config.yaml', override);
    assert.equal(config?.overrideModel, null, override);
  }
});

test('issue 0029 AC-2 override 與 ai-config.yaml 相同時來源標 override，註明兩檔相同', () => {
  const files = { base: 'model: opencode/big-pickle\n', override: 'model: opencode/big-pickle\n' };
  const { config } = probeConfig(files);
  assert.equal(config?.source, 'data/ai-config.override.yaml');
  const text = runInProject(files).stdout;
  assert.match(
    text,
    /模型來源：data\/ai-config\.override\.yaml（\/set_model）＝opencode\/big-pickle（與 ai-config\.yaml 相同）/
  );
  assert.doesNotMatch(text, /已被覆寫/);
});

test('issue 0029 AC-4 --models 與 --all 不讀設定檔、不印來源，也沒有 config 欄位', () => {
  const files = {
    base: 'model: opencode/big-pickle\n',
    override: 'model: nvidia/z-ai/glm-5.3-flash\n'
  };
  const viaModels = runInProject(files, ['--models', 'mock/a', '--json']);
  const parsedModels = JSON.parse(viaModels.stdout) as { config?: unknown; results: ProbeResult[] };
  assert.equal(parsedModels.config, undefined);
  assert.deepEqual(
    parsedModels.results.map((r) => r.model),
    ['mock/a']
  );
  const modelsText = runInProject(files, ['--models', 'mock/a']).stdout;
  assert.doesNotMatch(modelsText, /模型來源/);
  // 不讀設定檔、不知道有沒有 override，所以 /reset_model 的提醒一律附上（AC-5）。
  assert.match(modelsText, /\/set_model mock\/a/);
  assert.match(modelsText, /若有 \/set_model 的 override/);

  const allEnv = { FAKE_OPENCODE_MODELS: 'mock/b\nnvidia/baai/bge-m3' };
  const viaAll = runInProject(files, ['--all', '--json'], allEnv);
  const parsedAll = JSON.parse(viaAll.stdout) as { config?: unknown; results: ProbeResult[] };
  assert.equal(parsedAll.config, undefined);
  assert.deepEqual(
    parsedAll.results.map((r) => r.model),
    ['mock/b']
  );
  const allText = runInProject(files, ['--all'], allEnv).stdout;
  assert.doesNotMatch(allText, /模型來源/);
  assert.match(allText, /\/set_model mock\/b/);
  assert.match(allText, /若有 \/set_model 的 override/);
});

test('issue 0029 AC-5 結尾提示改用 /set_model，有 override 時註明要先 /reset_model', () => {
  const plain = runInProject({ base: 'model: opencode/big-pickle\n' }).stdout;
  assert.match(plain, /\/set_model opencode\/big-pickle/);
  assert.doesNotMatch(plain, /把其中一顆寫進 ai-config\.yaml/);
  assert.doesNotMatch(plain, /\/reset_model/);

  const overridden = runInProject({
    base: 'model: opencode/big-pickle\n',
    override: 'model: nvidia/z-ai/glm-5.3-flash\n'
  }).stdout;
  assert.match(overridden, /\/set_model nvidia\/z-ai\/glm-5\.3-flash/);
  assert.match(overridden, /直接改 ai-config\.yaml.*要先 \/reset_model/);
});

test('issue 0029 AC-6 兩個設定檔都沒有模型時點名兩個檔，以 1 結束', () => {
  const run = runInProject({ base: 'provider: opencode\n', override: 'model: ""\n' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ai-config\.yaml/);
  assert.match(run.stderr, /data\/ai-config\.override\.yaml/);
  assert.match(run.stderr, /--models 或 --all/);
});
