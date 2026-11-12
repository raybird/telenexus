// issue 0024 步驟 6：對照 control-steps.jsonl 與採樣、fixture 紀錄，列出每一步觀測到什麼。
import { readFileSync } from 'node:fs';
const out = process.argv[2];
const rows = (f) => readFileSync(`${out}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const proc = rows('control-proc.jsonl');
const fx = rows('fixture-requests.jsonl');
// 某時間點的狀態＝該時間點之前最後一列。
const stateAt = (t) => proc.filter((r) => r.t <= t).at(-1);
for (const s of rows('control-steps.jsonl')) {
  const inWindow = [stateAt(s.t0), ...proc.filter((r) => r.t > s.t0 && r.t <= s.t1)].filter(Boolean);
  const kinds = [...new Set(inWindow.flatMap((r) => r.procs.map((p) => p.kind)))];
  const tmp = [...new Set(inWindow.flatMap((r) => r.tmp))];
  const clients = [...new Set(fx.filter((r) => r.t >= s.t0 && r.t <= s.t1).map((r) => r.client))];
  console.log(JSON.stringify({ step: s.step, exit: s.exit, kinds, tmp, fixtureClients: clients }));
}
const last = proc.at(-1);
console.log(JSON.stringify({ step: 'final-row', final: last.final, procs: last.procs, tmp: last.tmp }));
