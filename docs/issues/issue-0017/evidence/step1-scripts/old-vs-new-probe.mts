// 用舊版 memory-health.ts 對 AC-2（遠端）與 AC-3（空封存）的資料印出判定結果
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const repo = process.argv[2]!;
const Database = createRequire(path.join(repo, 'package.json'))('better-sqlite3');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-0017-'));
const dbDir = path.join(tmp, 'data');
fs.mkdirSync(dbDir);
for (const k of ['MEMORIA_HOME', 'MEMORIA_ARCHIVE_DB']) delete process.env[k];
process.env.DB_DIR = dbDir;
process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = path.join(tmp, 'cp.json');
fs.writeFileSync(process.env.MEMORY_BACKFILL_CHECKPOINT_FILE, JSON.stringify({ lastProcessedSessionId: 'session-from-checkpoint', lastProcessedTimestamp: '2026-05-31T10:38:00.556Z' }));
const r = new Database(path.join(dbDir, 'memory.db'));
r.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY); CREATE TABLE relations (id INTEGER PRIMARY KEY); CREATE TABLE observations (id INTEGER PRIMARY KEY, content TEXT);');
r.prepare('INSERT INTO observations (content) VALUES (?)').run('tagged [source_session=session-x]');
r.close();
const { collectMemoryHealthReport } = await import(path.join(repo, 'src/services/memory-health.ts'));
const pick = (rep: any) => ({ archive: { exists: rep.archive.exists, totalSessions: rep.archive.totalSessions, estimatedGapRecent24h: rep.archive.estimatedGapRecent24h }, consistency: rep.consistency });
console.log('AC-2 remote     ', JSON.stringify(pick(collectMemoryHealthReport())));
const a = path.join(tmp, 'archive.db');
const d = new Database(a); d.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL); CREATE TABLE events (id INTEGER PRIMARY KEY);'); d.close();
process.env.MEMORIA_ARCHIVE_DB = a;
console.log('AC-3 empty local', JSON.stringify(pick(collectMemoryHealthReport())));
fs.rmSync(tmp, { recursive: true, force: true });
