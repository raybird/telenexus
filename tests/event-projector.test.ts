import test from 'node:test';
import assert from 'node:assert/strict';
import { initEventProjector } from '../src/services/event-projector.js';
import { emitEvent } from '../src/services/event-bus.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('連續事件只會收斂成一次 leading + 一次 trailing snapshot', async () => {
  let calls = 0;
  const stop = initEventProjector(() => {
    calls += 1;
  }, { minIntervalMs: 80 });

  try {
    // 一次排程任務就會連續送出這些事件,先前每一個都各寫一輪完整快照。
    emitEvent('schedule_fire', { scheduleId: 1 });
    emitEvent('runner_request_done', { ok: true });
    emitEvent('request_done', { ok: true });
    emitEvent('schedule_done', { scheduleId: 1 });

    assert.equal(calls, 1, '第一個事件應立即寫出(leading edge)');

    await sleep(160);
    assert.equal(calls, 2, '其餘三個事件應合併成一次尾端補寫');
  } finally {
    stop();
  }
});

test('間隔足夠的事件仍各自立即寫出', async () => {
  let calls = 0;
  const stop = initEventProjector(() => {
    calls += 1;
  }, { minIntervalMs: 20 });

  try {
    emitEvent('request_done', { ok: true });
    assert.equal(calls, 1);

    await sleep(50);
    emitEvent('request_done', { ok: true });
    assert.equal(calls, 2, '距上次已超過 minInterval,應維持即時反映');
  } finally {
    stop();
  }
});

test('非觸發類事件不會寫出 snapshot', async () => {
  let calls = 0;
  const stop = initEventProjector(() => {
    calls += 1;
  }, { minIntervalMs: 20 });

  try {
    emitEvent('opencode_start', {});
    emitEvent('request_start', {});
    await sleep(50);
    assert.equal(calls, 0);
  } finally {
    stop();
  }
});

test('unsubscribe 會取消尚未寫出的 trailing snapshot', async () => {
  let calls = 0;
  const stop = initEventProjector(() => {
    calls += 1;
  }, { minIntervalMs: 60 });

  emitEvent('request_done', { ok: true }); // leading
  emitEvent('request_done', { ok: true }); // 排入 trailing
  assert.equal(calls, 1);

  stop();
  await sleep(120);
  assert.equal(calls, 1, 'stop() 後不該再寫出');
});
