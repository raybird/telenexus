import { createRequire } from 'node:module';
import { defaultProbe } from '/app/dist/services/model-health-check.js';
const require = createRequire(import.meta.url);
const D = require('/app/node_modules/better-sqlite3');
const db = () => new D('/home/node/.local/share/opencode/opencode.db', { readonly: true });
const t0 = Date.now();
const created = () => { const c = db(); const n = c.prepare('select count(*) n from session where time_created >= ?').get(t0).n; c.close(); return n; };
// 包一層 spawn 記錄探針實際建立的 session：在探針執行中每 200ms 掃一次新建的 session
const seen = new Set();
const timer = setInterval(() => { const c = db(); for (const r of c.prepare('select id from session where time_created >= ?').all(t0)) seen.add(r.id); c.close(); }, 200);
const outcome = await defaultProbe('opencode/big-pickle', 120000);
clearInterval(timer);
const c = db(); const remaining = [...seen].filter((id) => c.prepare('select count(*) n from session where id=?').get(id).n > 0); c.close();
console.log(JSON.stringify({ outcome, sessionsSeenDuringProbe: seen.size, remainingAfterProbe: remaining.length, createdSinceStartNow: created() }));
