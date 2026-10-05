import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-05：獨立核對已保存數值與對照組回收，不修改原始量測。
const directory = dirname(fileURLToPath(import.meta.url));
const summary = JSON.parse(readFileSync(join(directory, 'scn008-v3-summary.json'), 'utf8'));
assert.equal(summary.records.length, 2);
assert.equal(summary.observerControls.zombie.state, 'Z');
assert.equal(summary.observerControls.zombie.exe, null);
assert.equal(summary.observerControls.deniedCode, 'EACCES');
let controlGone;
try {
  const stat = readFileSync(`/proc/${summary.observerControls.zombie.pid}/stat`, 'utf8');
  const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  controlGone = starttime !== summary.observerControls.zombie.starttime;
} catch (error) {
  if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  controlGone = true;
}
assert.ok(controlGone, '已知 Z 對照組自身必須被回收');
for (const [file, hash] of Object.entries(summary.codeHashes)) assert.equal(createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'), hash);
const checks = summary.records.map(record => {
  assert.equal(record.samples.length, 16);
  assert.ok(record.samples.every((sample, index) => sample.second === index && sample.remaining.length === 0 && sample.live === 0 && sample.zombies === 0 && sample.cgroupPids.length === 0));
  assert.ok(record.positiveControl.chrome.length > 0);
  assert.ok(record.positiveControl.chrome.every(row => row.exe === '/opt/telenexus/chrome/chrome-linux64/chrome' && row.state !== 'Z'));
  const events = readFileSync(join(directory, `scn008-${record.mode}-v3-events.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const signals = events.filter(event => event.Action === 'kill').map(event => event.Actor.Attributes.signal);
  assert.deepEqual(signals, record.mode === 'sigterm' ? ['15'] : ['15', '9']);
  assert.equal(record.exitCode, record.mode === 'sigterm' ? 0 : 137);
  assert.equal(record.writableLayerProfileRemains, record.mode === 'deadline-force');
  if (record.mode === 'sigterm') assert.match(readFileSync(join(directory, 'scn008-sigterm-v3.jsonl'), 'utf8'), /shutdown signal=SIGTERM terminatedChildren=1/);
  return { mode: record.mode, samples: 16, chromePositiveControl: record.positiveControl.chrome.length, signals, exitCode: record.exitCode, live: 0, zombies: 0, cgroupPids: 0, profileRemains: record.writableLayerProfileRemains, passed: true };
});
writeFileSync(join(directory, 'scn008-independent-counts.json'), JSON.stringify({ date: '2026-10-05', command: 'node docs/issues/issue-0010/evidence/verify-scn008-observations.mjs', controlGone, checks, passed: true }, null, 2) + '\n');
console.log(JSON.stringify({ controlGone, checks, passed: true }));
