import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-04：只保存明列的本期測試容器證據，不停止／移除任何容器。
const [name, label] = process.argv.slice(2);
if (!/^issue10-[a-z0-9-]+-20261004$/.test(name || '') || !/^[a-z0-9-]+$/.test(label || '')) {
  throw new Error('僅接受本期測試容器名稱與安全證據標籤');
}
const directory = dirname(fileURLToPath(import.meta.url));
const raw = spawnSync('docker', ['logs', name], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
if (raw.status !== 0) throw new Error(raw.stderr);
const inspection = spawnSync('docker', ['inspect', name], {encoding: 'utf8'});
if (inspection.status !== 0) throw new Error(inspection.stderr);
const container = JSON.parse(inspection.stdout)[0];
const rows = raw.stdout.split('\n').filter(Boolean).map(JSON.parse);
writeFileSync(join(directory, `${label}.jsonl`), raw.stdout);
if (raw.stderr) writeFileSync(join(directory, `${label}.stderr.log`), raw.stderr);
const record = {date: '2026-10-04', container: name, containerId: container.Id, image: container.Image,
  init: container.HostConfig.Init, runningAtCollection: container.State.Running,
  command: ['docker', 'logs', name], lastSample: rows.findLast(row => row.event === 'sample'),
  result: rows.findLast(row => row.event === 'measurement-complete') ?? null};
writeFileSync(join(directory, `${label}-summary.json`), JSON.stringify(record, null, 2));
console.log(JSON.stringify({container: name, samples: rows.filter(row => row.event === 'sample').length,
  result: record.result, lastSampleStage: record.lastSample?.stage, liveCount: record.lastSample?.liveCount,
  rootCount: record.lastSample?.roots?.length}));
