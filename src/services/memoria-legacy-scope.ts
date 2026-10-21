import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildSummary } from '../core/memoria-sync.js';
import { getMemoriaEndpoint, pingMemoriaEndpoint } from '../core/memoria-recall.js';

/**
 * 舊版 Memoria 記憶的分類遷移(issue 0015)。
 *
 * 2026-08-14 以前同步的 session 全落在 `project:TeleNexus`,summary 是 `user=… platform=…`
 * 這種 metadata;現在聊天只查 `user:<id>`、排程寫進 `scheduler:<id>`,所以這區舊資料
 * 聊天看不到,看得到也沒有內容可比對。歸屬依每個 session 事件 metadata 裡的
 * platform / user_id 判定(與 summary 字串一致 0 筆不符,見 issue 0015 調查),
 * summary 則從事件重建成目前同步寫入的格式。
 */

export const DEFAULT_LEGACY_SCOPE = 'project:TeleNexus';

const SUPPORTED_PLATFORMS = new Set(['telegram', 'console', 'scheduler']);

/** 遷移會讀寫的欄位;Memoria 改版少了任何一個就不碰這個資料庫。 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  sessions: ['id', 'scope', 'summary'],
  events: ['id', 'session_id', 'event_type', 'content', 'metadata'],
  memory_nodes: ['id', 'parent_id', 'level', 'scope'],
  memory_node_sources: ['node_id', 'session_id']
};

export class LegacyScopeMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyScopeMigrationError';
  }
}

export type LegacyScopePlanItem = {
  sessionId: string;
  fromScope: string;
  toScope: string;
  basis: string;
  summary: string;
};

export type LegacyScopeReviewItem = { sessionId: string; reason: string };

export type LegacyScopeReport = {
  mode: 'dry-run' | 'write';
  dbPath: string;
  fromScope: string;
  /** 只在 write 時檢查;預覽不需要停止 Memoria。 */
  serviceCheck: { endpoint: string; reachable: boolean } | null;
  totals: { candidates: number; migrate: number; review: number };
  byTargetScope: Record<string, number>;
  plan: LegacyScopePlanItem[];
  review: LegacyScopeReviewItem[];
  migrated: number;
  backupPath: string | null;
  recordPath: string | null;
};

export type LegacyScopeOptions = {
  dbPath: string;
  fromScope?: string;
  write?: boolean;
  /** 預設與聊天召回相同(`MEMORIA_ENDPOINT`)。 */
  memoriaEndpoint?: string;
};

type EventRow = {
  session_id: string;
  event_type: string;
  content: string | null;
  metadata: string | null;
};

type Owner = { platform: string; userId: string };

function parseObject(raw: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw ?? '');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function ownerOf(metadata: string | null): Owner | string {
  const meta = parseObject(metadata);
  if (!meta) return 'metadata 無法解析';
  const userId = typeof meta.user_id === 'string' ? meta.user_id.trim() : '';
  if (!userId) return '缺少 user_id';
  const platform = typeof meta.platform === 'string' ? meta.platform : '';
  if (!SUPPORTED_PLATFORMS.has(platform)) return `platform 不支援：${platform || '（無）'}`;
  return { platform, userId };
}

function textOf(content: string | null): string | null {
  const text = parseObject(content)?.text;
  return typeof text === 'string' ? text : null;
}

/** 單一 session 的歸屬判定;回傳字串代表要人工審閱的原因。 */
function classifySession(
  sessionId: string,
  fromScope: string,
  events: EventRow[]
): LegacyScopePlanItem | string {
  const users = events.filter((e) => e.event_type === 'UserMessage');
  const models = events.filter((e) => e.event_type === 'ModelMessage');
  if (users.length !== 1) return `UserMessage 不是剛好一筆（${users.length} 筆）`;
  if (models.length > 1) return `ModelMessage 超過一筆（${models.length} 筆）`;
  const user = users[0]!;
  const model = models[0];

  const owner = ownerOf(user.metadata);
  if (typeof owner === 'string') return owner;
  if (model) {
    const modelOwner = ownerOf(model.metadata);
    if (
      typeof modelOwner === 'string' ||
      modelOwner.platform !== owner.platform ||
      modelOwner.userId !== owner.userId
    ) {
      return 'ModelMessage 與 UserMessage 的 platform 或 user_id 不一致';
    }
  }

  const userText = textOf(user.content);
  const modelText = model ? textOf(model.content) : '';
  if (userText === null || modelText === null) return '事件內容無法取出文字';

  return {
    sessionId,
    fromScope,
    // 與 memoria-sync.ts 的 buildScope() 相同:只有 scheduler 走另一區
    toScope: owner.platform === 'scheduler' ? `scheduler:${owner.userId}` : `user:${owner.userId}`,
    basis: `events.metadata.platform=${owner.platform}`,
    summary: buildSummary({
      userId: owner.userId,
      userMessage: userText,
      modelMessage: modelText,
      isPassthroughCommand: false,
      forceNewSession: false
    })
  };
}

function assertUsable(db: Database.Database): void {
  let integrity: string;
  try {
    integrity = String(db.pragma('quick_check', { simple: true }));
  } catch (err) {
    throw new LegacyScopeMigrationError(`資料庫完整性檢查失敗：${(err as Error).message}`);
  }
  if (integrity !== 'ok') {
    throw new LegacyScopeMigrationError(`資料庫完整性檢查沒有通過：${integrity}`);
  }
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(
      (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
    );
    const missing = columns.filter((c) => !present.has(c)).map((c) => `${table}.${c}`);
    if (missing.length > 0) {
      throw new LegacyScopeMigrationError(
        `資料庫缺少遷移需要的欄位：${missing.join('、')}（Memoria 版本可能不相容）`
      );
    }
  }
}

function planMigration(
  db: Database.Database,
  fromScope: string
): { plan: LegacyScopePlanItem[]; review: LegacyScopeReviewItem[]; candidates: number } {
  const sessionIds = (
    db.prepare('SELECT id FROM sessions WHERE scope = ? ORDER BY id').all(fromScope) as Array<{
      id: string;
    }>
  ).map((r) => r.id);
  const events = db
    .prepare(
      `SELECT e.session_id, e.event_type, e.content, e.metadata
       FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE s.scope = ? AND e.event_type IN ('UserMessage', 'ModelMessage')`
    )
    .all(fromScope) as EventRow[];
  const bySession = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = bySession.get(e.session_id) ?? [];
    list.push(e);
    bySession.set(e.session_id, list);
  }

  const plan: LegacyScopePlanItem[] = [];
  const review: LegacyScopeReviewItem[] = [];
  for (const id of sessionIds) {
    const result = classifySession(id, fromScope, bySession.get(id) ?? []);
    if (typeof result === 'string') review.push({ sessionId: id, reason: result });
    else plan.push(result);
  }
  return { plan, review, candidates: sessionIds.length };
}

function countByScope(plan: LegacyScopePlanItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of plan) counts[p.toScope] = (counts[p.toScope] ?? 0) + 1;
  return counts;
}

function openDatabase(dbPath: string, readonly: boolean): Database.Database {
  if (!fs.existsSync(dbPath)) {
    throw new LegacyScopeMigrationError(`找不到 Memoria 資料庫：${dbPath}`);
  }
  try {
    return new Database(dbPath, { readonly, fileMustExist: true });
  } catch (err) {
    throw new LegacyScopeMigrationError(`無法開啟 Memoria 資料庫：${(err as Error).message}`);
  }
}

type Planned = ReturnType<typeof planMigration>;

/** events 全表的內容雜湊;遷移只該動 sessions 與索引,commit 前拿它自我檢查。 */
function digestEvents(db: Database.Database): string {
  const hash = createHash('sha256');
  for (const row of db.prepare('SELECT * FROM events ORDER BY id').iterate()) {
    hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

/**
 * 在呼叫端開好的 transaction 裡改寫。計畫在鎖內重算,與預覽之後才寫入的資料無關。
 *
 * 索引不手寫:刪掉這些 session 的 memory_node_sources 與 level-2 node,
 * `memoria index build` 就會把它們當成未索引的 session 重建(它只看有沒有 sources)。
 * 舊分區因此失去所有來源的 topic,以及沒有子節點的 root,一併刪掉。
 */
function applyPlan(db: Database.Database, fromScope: string): Planned {
  const eventsBefore = digestEvents(db);
  const planned = planMigration(db, fromScope);

  const updateSession = db.prepare('UPDATE sessions SET scope = ?, summary = ? WHERE id = ?');
  const deleteSources = db.prepare('DELETE FROM memory_node_sources WHERE session_id = ?');
  const deleteSessionNode = db.prepare('DELETE FROM memory_nodes WHERE id = ?');
  for (const item of planned.plan) {
    updateSession.run(item.toScope, item.summary, item.sessionId);
    deleteSources.run(item.sessionId);
    deleteSessionNode.run(`node:session:${item.sessionId}`);
  }
  db.prepare(
    `DELETE FROM memory_nodes
      WHERE scope = ? AND level = 1
        AND id NOT IN (SELECT node_id FROM memory_node_sources)`
  ).run(fromScope);
  db.prepare(
    `DELETE FROM memory_nodes
      WHERE scope = ? AND level = 0
        AND id NOT IN (SELECT parent_id FROM memory_nodes WHERE parent_id IS NOT NULL)`
  ).run(fromScope);

  if (digestEvents(db) !== eventsBefore) {
    throw new Error('自我檢查失敗：events 有變動');
  }
  const remaining = (
    db.prepare('SELECT count(*) AS n FROM sessions WHERE scope = ?').get(fromScope) as { n: number }
  ).n;
  if (remaining !== planned.review.length) {
    throw new Error(
      `自我檢查失敗：舊分區剩 ${remaining} 筆，預期只剩人工審閱的 ${planned.review.length} 筆`
    );
  }
  return planned;
}

function writeMigration(
  dbPath: string,
  fromScope: string
): { planned: Planned; backupPath: string; recordPath: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(path.dirname(dbPath), 'legacy-scope-migration', stamp);
  const backupPath = path.join(outDir, 'sessions.backup.db');
  const recordPath = path.join(outDir, 'record.json');

  const db = openDatabase(dbPath, false);
  let planned: Planned;
  try {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      db.prepare('VACUUM INTO ?').run(backupPath);
    } catch (err) {
      throw new LegacyScopeMigrationError(`備份失敗，沒有改寫資料庫：${(err as Error).message}`);
    }
    try {
      planned = db.transaction(() => applyPlan(db, fromScope)).immediate();
    } catch (err) {
      throw new LegacyScopeMigrationError(
        `改寫失敗，已整批回滾，資料庫沒有改動：${(err as Error).message}（備份：${backupPath}）`
      );
    }
  } finally {
    db.close();
  }

  const record = {
    createdAt: new Date().toISOString(),
    dbPath,
    fromScope,
    backupPath,
    totals: {
      candidates: planned.candidates,
      migrate: planned.plan.length,
      review: planned.review.length
    },
    byTargetScope: countByScope(planned.plan),
    migrated: planned.plan.map(({ sessionId, fromScope: from, toScope, basis }) => ({
      sessionId,
      fromScope: from,
      toScope,
      basis
    })),
    review: planned.review
  };
  try {
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  } catch (err) {
    throw new LegacyScopeMigrationError(
      `遷移已完成，但遷移紀錄寫入失敗：${(err as Error).message}（備份：${backupPath}）`
    );
  }
  return { planned, backupPath, recordPath };
}

function buildReport(
  mode: LegacyScopeReport['mode'],
  options: LegacyScopeOptions,
  fromScope: string,
  planned: Planned,
  extra: Pick<LegacyScopeReport, 'serviceCheck' | 'migrated' | 'backupPath' | 'recordPath'>
): LegacyScopeReport {
  return {
    mode,
    dbPath: options.dbPath,
    fromScope,
    serviceCheck: extra.serviceCheck,
    totals: {
      candidates: planned.candidates,
      migrate: planned.plan.length,
      review: planned.review.length
    },
    byTargetScope: countByScope(planned.plan),
    plan: planned.plan,
    review: planned.review,
    migrated: extra.migrated,
    backupPath: extra.backupPath,
    recordPath: extra.recordPath
  };
}

export async function runLegacyScopeMigration(
  options: LegacyScopeOptions
): Promise<LegacyScopeReport> {
  const fromScope = options.fromScope ?? DEFAULT_LEGACY_SCOPE;

  // 先唯讀檢查與預覽,連 journal 都不會產生
  const db = openDatabase(options.dbPath, true);
  let planned: Planned;
  try {
    assertUsable(db);
    planned = planMigration(db, fromScope);
  } finally {
    db.close();
  }

  if (options.write !== true) {
    return buildReport('dry-run', options, fromScope, planned, {
      serviceCheck: null,
      migrated: 0,
      backupPath: null,
      recordPath: null
    });
  }

  const endpoint = options.memoriaEndpoint ?? getMemoriaEndpoint();
  const reachable = await pingMemoriaEndpoint({ endpoint, timeoutMs: 2000 });
  const serviceCheck = { endpoint, reachable };
  if (reachable) {
    throw new LegacyScopeMigrationError(
      `Memoria 服務仍在執行（${endpoint}），請先停止 Memoria 再寫入`
    );
  }

  // 沒東西可搬就不備份、不開 transaction:重跑不留下新檔案
  if (planned.plan.length === 0) {
    return buildReport('write', options, fromScope, planned, {
      serviceCheck,
      migrated: 0,
      backupPath: null,
      recordPath: null
    });
  }

  const written = writeMigration(options.dbPath, fromScope);
  return buildReport('write', options, fromScope, written.planned, {
    serviceCheck,
    migrated: written.planned.plan.length,
    backupPath: written.backupPath,
    recordPath: written.recordPath
  });
}
