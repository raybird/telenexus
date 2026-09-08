import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyFailure,
  decideAlert,
  failureSignature,
  interpretProbeOutput,
  isRealSuccessEvent,
  startModelHealthCheck,
  type HealthCheckOutcome,
  type HealthState
} from '../src/services/model-health-check.js';
import { addIssueHook } from '../src/utils/errors.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-health-'));
  return path.join(dir, 'model-health-state.json');
}

function fakeConnector() {
  const sent: { userId: string; text: string }[] = [];
  return {
    sent,
    connector: {
      sendMessage: async (userId: string, text: string) => {
        sent.push({ userId, text });
      }
    } as never
  };
}

const OK: HealthCheckOutcome = { ok: true };
const MODEL_GONE: HealthCheckOutcome = {
  ok: false,
  category: 'model-invalid',
  message: 'Model not found: opencode/deepseek-v4-flash-free. Did you mean: hy3-free?'
};
const AUTH_FAIL: HealthCheckOutcome = {
  ok: false,
  category: 'unknown',
  message: 'Error: 401 Unauthorized'
};

// ── 失效分類（判定邏輯） ───────────────────────────────────────────────

test('classifyFailure 認得下架與 EOL 兩種樣式', () => {
  assert.equal(
    classifyFailure('Model not found: opencode/foo. Did you mean: bar?'),
    'model-invalid'
  );
  assert.equal(
    classifyFailure(`Gone: {"status":410,"detail":"The model 'x' has reached its end of life"}`),
    'model-invalid'
  );
});

test('classifyFailure 對無法歸因的錯誤回 unknown,不猜成模型下架', () => {
  assert.equal(classifyFailure('Error: connect ETIMEDOUT'), 'unknown');
  assert.equal(classifyFailure('Error: 401 Unauthorized'), 'unknown');
});

test('classifyFailure 認得上游限流，不歸到 unknown', () => {
  assert.equal(
    classifyFailure('ERROR service=llm error={"name":"AI_APICallError","statusCode":429}'),
    'rate-limited'
  );
  assert.equal(classifyFailure('code=RESOURCE_EXHAUSTED'), 'rate-limited');
});

test('classifyFailure 不被輸出裡的數字 429 誤判成限流', () => {
  // 探針帶 --print-logs 後，錯誤行會回吐整包 request body。
  assert.equal(classifyFailure('Error: 比特幣成交量 429 億美元，connect ETIMEDOUT'), 'unknown');
});

test('探測「重試多次但最終成功」要判成降級，不能算健康', async () => {
  const statePath = tempStatePath();
  const outcomes: HealthCheckOutcome[] = [];

  // 模擬 exit 0 但過程被限流 —— 舊版探針只看 exit code，會把這種模型判成健康，
  // 而它跑真實排程任務時會 429 到逾時（2026-08-29 的 kimi-k3 實測）。
  const handle = startModelHealthCheck({
    resolveModel: () => 'nvidia/moonshotai/kimi-k3',
    statePath,
    enabled: true,
    intervalMs: 0,
    remindMs: 60_000,
    probe: async () => {
      const outcome: HealthCheckOutcome = {
        ok: false,
        category: 'rate-limited',
        message: '模型仍能回應，但這次探測被上游限流 5 次 (HTTP 429)。'
      };
      outcomes.push(outcome);
      return outcome;
    }
  });

  await handle.runOnce();
  handle.stop();

  assert.equal(outcomes.length, 1);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as HealthState;
  assert.equal(state.status, 'failing', '限流狀態必須進入 failing，才會推播與提醒');
  assert.ok(state.signature?.startsWith('rate-limited:'));
});

// ── 狀態機（AC-7 / AC-8 / AC-9） ──────────────────────────────────────

test('AC-7 相同簽章連續失敗只在第一次推播,直到提醒間隔過後', () => {
  const remindMs = 6 * 60 * 60 * 1000;
  const first = decideAlert(null, MODEL_GONE, 1000, remindMs);
  assert.equal(first.alert, 'new-failure');

  const second = decideAlert(first.nextState, MODEL_GONE, 2000, remindMs);
  assert.equal(second.alert, 'none', '相同簽章不應重複推播');

  const later = decideAlert(second.nextState, MODEL_GONE, 1000 + remindMs + 1, remindMs);
  assert.equal(later.alert, 'reminder', '超過提醒間隔應推一則仍未恢復');
});

test('AC-8 失敗簽章改變時立刻推播', () => {
  const first = decideAlert(null, MODEL_GONE, 1000, 999_999);
  const changed = decideAlert(first.nextState, AUTH_FAIL, 2000, 999_999);
  assert.equal(changed.alert, 'changed-failure');
});

test('AC-9 恢復時推播,且帶得出故障持續時間', () => {
  const failed = decideAlert(null, MODEL_GONE, 1000, 999_999);
  const recovered = decideAlert(failed.nextState, OK, 61_000, 999_999);
  assert.equal(recovered.alert, 'recovered');
  assert.equal(recovered.outageMs, 60_000);
});

test('健康到健康不推播', () => {
  const a = decideAlert(null, OK, 1000, 999_999);
  assert.equal(a.alert, 'none');
  const b = decideAlert(a.nextState, OK, 2000, 999_999);
  assert.equal(b.alert, 'none');
});

test('failureSignature 只受類別與訊息前段影響', () => {
  // 前段必須超過 120 字,否則尾端差異仍落在比對範圍內
  const long = { ...MODEL_GONE, message: 'x'.repeat(130) };
  const a = failureSignature(long);
  const b = failureSignature({ ...long, message: long.message + ' 尾端不同' });
  assert.equal(a, b, '訊息前 120 字相同應視為同一故障');
  assert.notEqual(a, failureSignature(AUTH_FAIL));
});

// ── 執行時行為 ────────────────────────────────────────────────────────

test('AC-1 模型失效時推播,內容點名模型', async () => {
  const { sent, connector } = fakeConnector();
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'opencode/deepseek-v4-flash-free',
    probe: async () => MODEL_GONE,
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.userId, 'admin-1');
  assert.match(sent[0]?.text ?? '', /opencode\/deepseek-v4-flash-free/);
});

test('AC-2 模型可用時不推播', async () => {
  const { sent, connector } = fakeConnector();
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'good-model',
    probe: async () => OK,
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();
  assert.equal(sent.length, 0);
});

test('AC-3 失敗時以 model-health scope 記錄 runtime issue', async () => {
  const scopes: string[] = [];
  const unhook = addIssueHook(({ scope }) => {
    scopes.push(scope);
  });
  try {
    const { connector } = fakeConnector();
    const handle = startModelHealthCheck({
      connector,
      adminUserId: 'admin-1',
      resolveModel: () => 'bad',
      probe: async (): Promise<HealthCheckOutcome> => ({
        ok: false,
        category: 'model-invalid',
        message: 'Model not found: ac3-unique-model'
      }),
      statePath: tempStatePath(),
      intervalMs: 0
    });
    await handle.runOnce();
    handle.stop();
  } finally {
    unhook();
  }
  assert.ok(
    scopes.some((s) => s.startsWith('model-health')),
    `應含 model-health scope,實際: ${scopes.join(', ')}`
  );
});

test('AC-4 啟動不被永不完成的檢查阻塞', async () => {
  const { connector } = fakeConnector();
  let started = false;
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'slow',
    probe: () =>
      new Promise<HealthCheckOutcome>(() => {
        started = true;
      }),
    statePath: tempStatePath(),
    intervalMs: 50
  });
  // start 本身必須同步返回,不等待 probe
  await sleep(30);
  handle.stop();
  assert.equal(started, true, 'probe 應已觸發');
});

test('AC-5 無法歸因的錯誤照樣推播,但不得宣稱模型已下架', async () => {
  const { sent, connector } = fakeConnector();
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'some-model',
    probe: async () => AUTH_FAIL,
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();

  assert.equal(sent.length, 1, '非模型類錯誤同樣要推播');
  const text = sent[0]?.text ?? '';
  assert.match(text, /401 Unauthorized/, '應附上原始錯誤片段');
  assert.doesNotMatch(text, /已下架|end of life|EOL/i, '不得誤歸因為模型下架');
});

test('AC-6 停用時完全不執行檢查', async () => {
  const { sent, connector } = fakeConnector();
  let probed = 0;
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    enabled: false,
    resolveModel: () => 'x',
    probe: async () => {
      probed += 1;
      return MODEL_GONE;
    },
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();
  assert.equal(probed, 0);
  assert.equal(sent.length, 0);
});

test('AC-10 失敗狀態跨重啟存活,重啟後不重複推首次告警', async () => {
  const statePath = tempStatePath();
  const first = fakeConnector();
  const h1 = startModelHealthCheck({
    connector: first.connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'bad',
    probe: async () => MODEL_GONE,
    statePath,
    intervalMs: 0
  });
  await h1.runOnce();
  h1.stop();
  assert.equal(first.sent.length, 1, '首次應推播');

  // 模擬重啟:新的 instance 讀同一份狀態檔
  const second = fakeConnector();
  const h2 = startModelHealthCheck({
    connector: second.connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'bad',
    probe: async () => MODEL_GONE,
    statePath,
    intervalMs: 0
  });
  await h2.runOnce();
  h2.stop();
  assert.equal(second.sent.length, 0, '重啟後相同故障不應重推');
});

test('AC-11 週期內有真實成功流量時跳過 ping', async () => {
  const { sent, connector } = fakeConnector();
  let probed = 0;
  const now = 1_000_000;
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'x',
    probe: async () => {
      probed += 1;
      return MODEL_GONE;
    },
    statePath: tempStatePath(),
    intervalMs: 0,
    exemptionWindowMs: 60_000,
    now: () => now,
    lastSuccessAt: () => now - 30_000
  });
  await handle.runOnce();
  handle.stop();

  assert.equal(probed, 0, '有近期成功流量就不該再 ping');
  assert.equal(sent.length, 0);
});

test('流量豁免只在週期內有效,過期仍會 ping', async () => {
  const { connector } = fakeConnector();
  let probed = 0;
  const now = 1_000_000;
  const handle = startModelHealthCheck({
    connector,
    adminUserId: 'admin-1',
    resolveModel: () => 'x',
    probe: async () => {
      probed += 1;
      return OK;
    },
    statePath: tempStatePath(),
    intervalMs: 0,
    exemptionWindowMs: 60_000,
    now: () => now,
    lastSuccessAt: () => now - 120_000
  });
  await handle.runOnce();
  handle.stop();
  assert.equal(probed, 1);
});

test('無 connector 時(runner 端)不推播但仍記錄', async () => {
  const scopes: string[] = [];
  const unhook = addIssueHook(({ scope }) => {
    scopes.push(scope);
  });
  try {
    const handle = startModelHealthCheck({
      resolveModel: () => 'bad',
      probe: async (): Promise<HealthCheckOutcome> => ({
        ok: false,
        category: 'model-invalid',
        message: 'Model not found: runner-side-unique-model'
      }),
      statePath: tempStatePath(),
      intervalMs: 0
    });
    await handle.runOnce();
    handle.stop();
  } finally {
    unhook();
  }
  assert.ok(scopes.some((s) => s.startsWith('model-health')));
});

test('推播失敗不得讓檢查拋出', async () => {
  const handle = startModelHealthCheck({
    connector: {
      sendMessage: async () => {
        throw new Error('Telegram down');
      }
    } as never,
    adminUserId: 'admin-1',
    resolveModel: () => 'bad',
    probe: async () => MODEL_GONE,
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();
});

test('未設定 model 時視為不檢查', async () => {
  let probed = 0;
  const handle = startModelHealthCheck({
    resolveModel: () => undefined,
    probe: async () => {
      probed += 1;
      return OK;
    },
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();
  assert.equal(probed, 0);
});

// 型別出口存在性(編譯期即可擋住漏匯出)
test('HealthState 型別可被引用', () => {
  const s: HealthState = { status: 'healthy', signature: null, since: 0, lastAlertAt: 0 };
  assert.equal(s.status, 'healthy');
});

test('resolveModel 拋錯不得讓檢查逸出例外(避免 bootstrap 內的 unhandled rejection)', async () => {
  const handle = startModelHealthCheck({
    resolveModel: () => {
      throw new Error('config unreadable');
    },
    probe: async () => OK,
    statePath: tempStatePath(),
    intervalMs: 0
  });
  await handle.runOnce();
  handle.stop();
});

// ── 2026-09-08 下架事故:三層漏判的迴歸測試 ──────────────────────────────
//
// nvidia/openai/gpt-oss-120b 下架後,opencode 吞掉 AI_APICallError、吐出降級文字
// 並以 exit 0 收場。三層防護各自獨立地漏掉它,共 9 天零告警。以下一層一個測試。

/** 真實 stderr 的形狀:--print-logs 會把整包 request body 也印出來。 */
const EOL_STDERR =
  'ERROR service=llm providerID=nvidia modelID=openai/gpt-oss-120b ' +
  'error={"error":{"name":"AI_APICallError","url":"https://integrate.api.nvidia.com/v1/chat/completions",' +
  '"statusCode":410,"message":"The model has reached its end of life"}}';

test('第 1 層:帶 upstreamInvalid 的 opencode_done 不算真實成功流量', () => {
  assert.equal(
    isRealSuccessEvent('opencode_done', { outputLen: 815, upstreamInvalid: true }),
    false,
    '模型下架時 opencode 仍 exit 0;若採信這種假成功,流量豁免會讓探針永遠不跑'
  );
  assert.equal(isRealSuccessEvent('opencode_done', { outputLen: 815 }), true);
  assert.equal(isRealSuccessEvent('opencode_start', {}), false);
});

test('第 2 層:exit 0 但 stderr 有下架訊號,必須判成 model-invalid', () => {
  const outcome = interpretProbeOutput(0, EOL_STDERR);
  assert.equal(outcome.ok, false, 'exit code 不是健康的證據 —— 這正是舊版漏判的原因');
  assert.equal(outcome.ok === false && outcome.category, 'model-invalid');
});

test('第 3 層:classifyFailure 認得結構化的 statusCode 410', () => {
  assert.equal(classifyFailure(EOL_STDERR), 'model-invalid');
});

test('乾淨的 exit 0 仍然判健康(不得因為修 bug 而全面誤報)', () => {
  assert.deepEqual(interpretProbeOutput(0, 'OK'), { ok: true });
});

test('限流優先於下架判定:被節流時上游沒機會回下架訊息', () => {
  const outcome = interpretProbeOutput(0, '"statusCode":429 "statusCode":429');
  assert.equal(outcome.ok === false && outcome.category, 'rate-limited');
});

test('市場數據裡的 410 不得被誤判成模型下架', () => {
  // --print-logs 會回吐整包 request body,排程任務內容常出現這種數字。
  const outcome = interpretProbeOutput(0, '比特幣 24 小時成交量 410 億美元,以太幣 410 億');
  assert.deepEqual(outcome, { ok: true }, '寬鬆比對會把健康的模型誤砍');
});

test('非 0 exit 且無結構化訊號時,仍誠實回 unknown', () => {
  const outcome = interpretProbeOutput(1, 'Error: 401 Unauthorized');
  assert.equal(outcome.ok === false && outcome.category, 'unknown');
});

test('端到端:假成功不更新豁免視窗,探針因此仍會執行', async () => {
  const statePath = tempStatePath();
  let probeCalls = 0;
  let lastSuccess: number | null = null;

  // 模擬 main.ts / runner.ts 的 hook:餵進一筆下架造成的假成功。
  if (isRealSuccessEvent('opencode_done', { upstreamInvalid: true })) {
    lastSuccess = Date.now();
  }

  const handle = startModelHealthCheck({
    resolveModel: () => 'nvidia/openai/gpt-oss-120b',
    statePath,
    enabled: true,
    intervalMs: 0,
    exemptionWindowMs: 60 * 60 * 1000,
    lastSuccessAt: () => lastSuccess,
    probe: async () => {
      probeCalls += 1;
      return interpretProbeOutput(0, EOL_STDERR);
    }
  });

  await handle.runOnce();
  handle.stop();

  assert.equal(probeCalls, 1, '假成功不得讓探針被豁免跳過');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as HealthState;
  assert.equal(state.status, 'failing', '下架必須進入 failing 才會推播');
  assert.ok(state.signature?.startsWith('model-invalid:'));
});
