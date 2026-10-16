// 以編譯後的實作與真實 opencode CLI 反覆執行清理，直到沒有候選；每輪結果寫一行 JSON。
import fs from 'node:fs';
import {
  createOpencodeRetentionDeps,
  loadRetentionConfig,
  runRetentionOnce,
  RETENTION_BATCH_LIMIT
} from '/app/dist/services/opencode-session-retention.js';

const config = loadRetentionConfig();
const deps = createOpencodeRetentionDeps(() => true);
const reclaimState = { lastReclaimAt: null };
const log = fs.createWriteStream('/work/e2e-runs.jsonl', { flags: 'a' });
for (let round = 1; round <= 60; round += 1) {
  const result = await runRetentionOnce(config, deps, RETENTION_BATCH_LIMIT, reclaimState);
  log.write(JSON.stringify({ round, at: new Date().toISOString(), ...result }) + '\n');
  if (result.skipped || result.candidates === 0) break;
}
log.end();
