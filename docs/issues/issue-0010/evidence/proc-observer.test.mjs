import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStat, snapshot } from './proc-observer.mjs';

test('2026-10-04：已知 Linux stat 樣本區分活程序與 Z，保留 PID 身分', () => {
  const sample = '71 (worker (test)) Z 1 71 71 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 98765 4096';
  assert.deepEqual(parseStat(sample), { pid: 71, comm: 'worker (test)', state: 'Z', ppid: 1, pgid: 71, sid: 71, starttime: '98765' });
  assert.equal(parseStat(sample.replace(' Z ', ' S ')).state, 'S');
});

test('2026-10-04：觀測器活 PID 存在，不存在的 PID 不列入', () => {
  const rows = snapshot();
  assert.notEqual(rows.find(row => row.pid === process.pid)?.state, 'Z');
  assert.ok(rows.some(row => row.pid === process.pid));
  assert.equal(rows.some(row => row.pid === 2147483647), false);
});
