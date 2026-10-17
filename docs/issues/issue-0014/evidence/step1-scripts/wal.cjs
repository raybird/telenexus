// issue 0014 步驟 1：VACUUM 與 wal_checkpoint(TRUNCATE) 對 WAL 檔大小的影響。只在複本上執行。
// 用法：node /work/wal.cjs free <比例>   以 SQL 刪除最舊的頂層 session，直到可回收頁數達到該比例
//       node /work/wal.cjs run           依序量測各時間點的主檔與 WAL 大小
const D = require('/app/node_modules/better-sqlite3');
const fs = require('fs');
const { spawnSync } = require('child_process');
const DB = '/home/node/.local/share/opencode/opencode.db';

const size = (p) => (fs.existsSync(p) ? fs.statSync(p).size : null);
const sizes = () => ({ db: size(DB), wal: size(DB + '-wal'), shm: size(DB + '-shm') });
const pages = () => {
  const db = new D(DB, { readonly: true });
  const r = { pages: db.pragma('page_count', { simple: true }), freelist: db.pragma('freelist_count', { simple: true }) };
  db.close();
  return r;
};
// 和 TeleNexus 的 runProcess 一樣：stdin ignore（地雷 L-12）、讀 stdout。
const oc = (...args) => {
  const t0 = Date.now();
  const r = spawnSync('opencode', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return { exit: r.status, ms: Date.now() - t0, stdout: r.stdout.trim().slice(0, 300), stderr: r.stderr.trim().slice(0, 300) };
};
const step = (label, extra = {}) => console.log(JSON.stringify({ step: label, ...extra, ...sizes(), ...pages() }));
const CKPT = 'PRAGMA wal_checkpoint(TRUNCATE)';

const mode = process.argv[2];
if (mode === 'free') {
  const target = Number(process.argv[3]);
  const db = new D(DB);
  db.pragma('foreign_keys = ON');
  const del = db.prepare('delete from session where id = ?');
  const pick = db.prepare('select id from session where parent_id is null order by time_updated limit 50');
  let deleted = 0;
  while (db.pragma('freelist_count', { simple: true }) / db.pragma('page_count', { simple: true }) < target) {
    const ids = pick.all().map((r) => r.id);
    if (ids.length === 0) break;
    db.transaction(() => ids.forEach((id) => del.run(id)))();
    deleted += ids.length;
  }
  db.close();
  step('free', { deletedTopLevel: deleted });
}
if (mode === 'run') {
  step('baseline');
  step('after-opencode-select', { oc: oc('db', '--format', 'json', 'select count(*) as n from session') });
  step('connection-pragmas', { oc: oc('db', '--format', 'json', 'select * from pragma_journal_mode(), pragma_journal_size_limit(), pragma_busy_timeout()') });
  step('after-vacuum', { oc: oc('db', 'VACUUM') });
  step('after-truncate', { oc: oc('db', '--format', 'json', CKPT) });

  step('after-vacuum-2', { oc: oc('db', 'VACUUM') });
  const reader = new D(DB, { readonly: true });
  reader.prepare('begin').run();
  reader.prepare('select count(*) from session').get();
  step('truncate-with-open-read-txn', { oc: oc('db', '--format', 'json', CKPT) });
  reader.prepare('commit').run();
  reader.close();
  step('after-reader-closed');
  step('truncate-after-reader-closed', { oc: oc('db', '--format', 'json', CKPT) });
}
