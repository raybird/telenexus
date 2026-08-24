import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyFailure,
  decideAlert,
  failureSignature,
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
  assert.equal(classifyFailure('Model not found: opencode/foo. Did you mean: bar?'), 'model-invalid');
  assert.equal(
    classifyFailure(`Gone: {"status":410,"detail":"The model 'x' has reached its end of life"}`),
    'model-invalid'
  );
});

test('classifyFailure 對無法歸因的錯誤回 unknown,不猜成模型下架', () => {
  assert.equal(classifyFailure('Error: connect ETIMEDOUT'), 'unknown');
  assert.equal(classifyFailure('Error: 401 Unauthorized'), 'unknown');
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
