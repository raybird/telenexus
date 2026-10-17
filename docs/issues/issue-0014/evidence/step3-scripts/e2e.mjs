// issue 0014 步驟 3：以 /app/dist 的實作與真實 opencode CLI 跑一輪清理，量回收前、VACUUM 後、該輪結束後的檔案大小。
// /app/dist 是映像內建的變更前程式，或掛載進來的本版程式（見 run.sh）。只在複本上執行。
import fs from 'node:fs';
import {
  createOpencodeRetentionDeps,
  loadRetentionConfig,
  runRetentionOnce,
  RETENTION_BATCH_LIMIT
} from '/app/dist/services/opencode-session-retention.js';

const DB = '/home/node/.local/share/opencode/opencode.db';
const size = (p) => (fs.existsSync(p) ? fs.statSync(p).size : null);
const sizes = () => ({ db: size(DB), wal: size(DB + '-wal') });

const deps = createOpencodeRetentionDeps(() => true);
const realVacuum = deps.vacuum;
let afterVacuum = null;
deps.vacuum = async () => {
  await realVacuum();
  afterVacuum = sizes();
};
const before = sizes();
const result = await runRetentionOnce(loadRetentionConfig(), deps, RETENTION_BATCH_LIMIT, {
  lastReclaimAt: null
});
console.log(JSON.stringify({ hasTruncateDep: typeof deps.truncateWal === 'function', before, afterVacuum, afterRound: sizes(), result }));
