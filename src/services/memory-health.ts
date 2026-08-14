import fs from 'fs';
import Database from 'better-sqlite3';
import { getRecentIssues } from '../utils/errors.js';
import {
  resolveDbPath,
  resolveMemoryBackfillCheckpointPath,
  resolveMemoryDbPath,
  resolveMemoriaSessionsDbPath
} from '../utils/paths.js';

export type BackfillCheckpoint = {
  lastProcessedSessionId?: string;
  lastProcessedTimestamp?: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastRunStatus?: string;
  lastError?: string;
  lastScannedSessions?: number;
  lastCandidates?: number;
  lastWritten?: number;
  lastDuplicates?: number;
};

export type MemoryHealthReport = {
  ok: boolean;
  timestamp: number;
  generatedAt: string;
  paths: {
    operationalDb: string;
    retrievalDb: string;
    archiveDb: string;
    checkpointFile: string;
  };
  operational: {
    exists: boolean;
    totalMessages: number;
    totalSchedules: number;
    lastMessageAt: string | null;
    modelResponses24h: number;
  };
  retrieval: {
    exists: boolean;
    entities: number;
    observations: number;
    relations: number;
  };
  archive: {
    enabled: boolean;
    exists: boolean;
    totalSessions: number;
    totalEvents: number;
    sessions24h: number;
    lastSessionAt: string | null;
    syncFailures24h: number;
    estimatedGapRecent24h: number;
  };
  backfill: {
    enabled: boolean;
    dryRun: boolean;
    checkpointExists: boolean;
    checkpoint: BackfillCheckpoint | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastScannedSessions: number;
    lastCandidates: number;
    lastWritten: number;
    lastDuplicates: number;
  };
  consistency: {
    ok: boolean;
    sourceSessionTaggedObservations: number;
    orphanSourceSessionObservations: number;
    observationsMissingSourceSession: number;
    checkpointAheadOfArchive: boolean;
    checkpointSessionMissing: boolean;
  };
};

type ConsistencyReport = MemoryHealthReport['consistency'];

function countRecentMemoriaIssues(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return getRecentIssues()
    .filter((issue) => issue.timestamp >= cutoff)
    .filter(
      (issue) =>
        /memoria|memory-backfill/i.test(issue.scope) || /memoria|backfill/i.test(issue.message)
    )
    .reduce((sum, issue) => sum + (issue.count || 1), 0);
}

function parseIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function readCheckpoint(checkpointPath: string): BackfillCheckpoint | null {
  try {
    if (!fs.existsSync(checkpointPath)) {
      return null;
    }
    const raw = fs.readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw) as BackfillCheckpoint;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getSqliteCounts(
  dbPath: string,
  queries: Array<{ key: string; sql: string }>
): Record<string, number> {
  if (!fs.existsSync(dbPath)) {
    return Object.fromEntries(queries.map((item) => [item.key, 0]));
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const counts: Record<string, number> = {};
    for (const query of queries) {
      const row = db.prepare(query.sql).get() as { count?: number } | undefined;
      counts[query.key] = row?.count || 0;
    }
    return counts;
  } finally {
    db.close();
  }
}

function extractSourceSessionId(content: string | null | undefined): string | null {
  if (typeof content !== 'string') {
    return null;
  }
  const match = content.match(/\[source_session=([^\]\s]+)\]/i);
  return match?.[1]?.trim() || null;
}

function collectConsistencyReport(
  retrievalDb: string,
  archiveDb: string,
  checkpoint: BackfillCheckpoint | null,
  archiveLastSessionAt: string | null
): ConsistencyReport {
  const empty: ConsistencyReport = {
    ok: true,
    sourceSessionTaggedObservations: 0,
    orphanSourceSessionObservations: 0,
    observationsMissingSourceSession: 0,
    checkpointAheadOfArchive: false,
    checkpointSessionMissing: false
  };

  let archiveSessionIds = new Set<string>();
  if (fs.existsSync(archiveDb)) {
    const db = new Database(archiveDb, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`SELECT id FROM sessions`).all() as Array<{ id?: string }>;
      archiveSessionIds = new Set(
        rows.map((row) => row.id).filter((id): id is string => Boolean(id))
      );
    } finally {
      db.close();
    }
  }

  if (fs.existsSync(retrievalDb)) {
    const db = new Database(retrievalDb, { readonly: true, fileMustExist: true });
    try {
      // 這份報告每次 context snapshot 都會重算,先前是 `SELECT content FROM observations` 把整張表
      // 的內容拉進記憶體再逐列跑 regex。extractSourceSessionId 的 pattern 必然含 `[source_session=`
      // 這段字面值,而 SQLite 的 LIKE 對 ASCII 預設不分大小寫,和 regex 的 /i 一致——所以不含該
      // 子字串的列不可能命中,可以只用 COUNT 算掉、完全不搬運內容(實測生產資料 100% 屬於此類)。
      // 命中 LIKE 的列仍照舊跑原本的 regex,語意與先前逐列掃描完全相同。
      const MARKER_LIKE = '%[source_session=%';
      const missingRow = db
        .prepare(
          `SELECT COUNT(*) as count FROM observations WHERE content IS NULL OR content NOT LIKE ?`
        )
        .get(MARKER_LIKE) as { count?: number } | undefined;
      empty.observationsMissingSourceSession = missingRow?.count || 0;

      const candidates = db
        .prepare(`SELECT content FROM observations WHERE content LIKE ?`)
        .all(MARKER_LIKE) as Array<{ content?: string }>;
      for (const row of candidates) {
        const sessionId = extractSourceSessionId(row.content);
        if (!sessionId) {
          empty.observationsMissingSourceSession += 1;
          continue;
        }
        empty.sourceSessionTaggedObservations += 1;
        if (archiveSessionIds.size > 0 && !archiveSessionIds.has(sessionId)) {
          empty.orphanSourceSessionObservations += 1;
        }
      }
    } finally {
      db.close();
    }
  }

  const checkpointSessionId = checkpoint?.lastProcessedSessionId?.trim();
  if (checkpointSessionId) {
    empty.checkpointSessionMissing =
      archiveSessionIds.size > 0 && !archiveSessionIds.has(checkpointSessionId);
  }

  const checkpointTimestamp = checkpoint?.lastProcessedTimestamp?.trim();
  if (checkpointTimestamp && archiveLastSessionAt) {
    empty.checkpointAheadOfArchive = checkpointTimestamp > archiveLastSessionAt;
  }

  empty.ok =
    empty.orphanSourceSessionObservations === 0 &&
    !empty.checkpointAheadOfArchive &&
    !empty.checkpointSessionMissing;

  return empty;
}

/**
 * ⚠ 不要在這裡加 `PRAGMA quick_check` / `integrity_check`。
 *
 * better-sqlite3 的長生命週期連線,只要 DB 裡有 FTS5 虛擬表(memory.db 有兩張:
 * messages_fts / messages_summary_fts)、又被**另一個行程**寫過,完整性檢查就會回
 * `malformed inverted index for FTS5 table …` —— 資料其實完好,壞的只是那條連線上
 * 的 FTS5 快取狀態。重新 prepare 清不掉,只有關閉重開連線有效;read-write 連線同樣
 * 會中,不是唯讀專屬。而 memory:cli / memory:health / memory:backfill 都是獨立行程,
 * 跑過任何一個就滿足觸發條件。
 *
 * 上游 Memoria 的 /v1/health 就是這樣長期謊報損壞(2026-08-14 三方各自重現確認,
 * 見其 issue-14)。真要做完整性檢查,得用一條當場開、用完就關的專屬連線。
 */
export function collectMemoryHealthReport(): MemoryHealthReport {
  const operationalDb = resolveDbPath();
  const retrievalDb = resolveMemoryDbPath();
  const archiveDb = resolveMemoriaSessionsDbPath();
  const checkpointFile = resolveMemoryBackfillCheckpointPath();
  const checkpoint = readCheckpoint(checkpointFile);
  const generatedAt = new Date().toISOString();

  let totalMessages = 0;
  let totalSchedules = 0;
  let lastMessageAt: string | null = null;
  let modelResponses24h = 0;

  if (fs.existsSync(operationalDb)) {
    const db = new Database(operationalDb, { readonly: true, fileMustExist: true });
    try {
      const messageStats = db
        .prepare(`SELECT COUNT(*) as total, MAX(timestamp) as last_message_at FROM messages`)
        .get() as { total?: number; last_message_at?: number };
      totalMessages = messageStats.total || 0;
      lastMessageAt =
        typeof messageStats.last_message_at === 'number' && messageStats.last_message_at > 0
          ? new Date(messageStats.last_message_at).toISOString()
          : null;

      const scheduleStats = db.prepare(`SELECT COUNT(*) as count FROM schedules`).get() as {
        count?: number;
      };
      totalSchedules = scheduleStats.count || 0;

      const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
      const modelStats = db
        .prepare(`SELECT COUNT(*) as count FROM messages WHERE role = 'model' AND timestamp >= ?`)
        .get(cutoffMs) as { count?: number };
      modelResponses24h = modelStats.count || 0;
    } finally {
      db.close();
    }
  }

  const retrievalCounts = getSqliteCounts(retrievalDb, [
    { key: 'entities', sql: 'SELECT COUNT(*) as count FROM entities' },
    { key: 'observations', sql: 'SELECT COUNT(*) as count FROM observations' },
    { key: 'relations', sql: 'SELECT COUNT(*) as count FROM relations' }
  ]);

  let totalSessions = 0;
  let totalEvents = 0;
  let sessions24h = 0;
  let lastSessionAt: string | null = null;
  if (fs.existsSync(archiveDb)) {
    const db = new Database(archiveDb, { readonly: true, fileMustExist: true });
    try {
      const sessionStats = db
        .prepare(`SELECT COUNT(*) as total, MAX(timestamp) as last_session_at FROM sessions`)
        .get() as { total?: number; last_session_at?: string | null };
      totalSessions = sessionStats.total || 0;
      lastSessionAt = parseIsoDate(sessionStats.last_session_at);

      const eventStats = db.prepare(`SELECT COUNT(*) as count FROM events`).get() as {
        count?: number;
      };
      totalEvents = eventStats.count || 0;

      const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recentStats = db
        .prepare(`SELECT COUNT(*) as count FROM sessions WHERE timestamp >= ?`)
        .get(cutoffIso) as { count?: number };
      sessions24h = recentStats.count || 0;
    } finally {
      db.close();
    }
  }

  const syncFailures24h = countRecentMemoriaIssues();
  const estimatedGapRecent24h = Math.max(modelResponses24h - sessions24h, 0);
  const archiveEnabled =
    (process.env.MEMORIA_SYNC_ENABLED || 'auto').trim().toLowerCase() !== 'off';
  const backfillEnabled =
    (process.env.MEMORY_BACKFILL_ENABLED || 'false').trim().toLowerCase() === 'true';
  const dryRunRaw = (process.env.MEMORY_BACKFILL_DRY_RUN || 'true').trim().toLowerCase();
  const backfillDryRun = !(dryRunRaw === 'false' || dryRunRaw === '0' || dryRunRaw === 'off');
  const consistency = collectConsistencyReport(retrievalDb, archiveDb, checkpoint, lastSessionAt);

  return {
    ok: true,
    timestamp: Date.now(),
    generatedAt,
    paths: {
      operationalDb,
      retrievalDb,
      archiveDb,
      checkpointFile
    },
    operational: {
      exists: fs.existsSync(operationalDb),
      totalMessages,
      totalSchedules,
      lastMessageAt,
      modelResponses24h
    },
    retrieval: {
      exists: fs.existsSync(retrievalDb),
      entities: retrievalCounts.entities || 0,
      observations: retrievalCounts.observations || 0,
      relations: retrievalCounts.relations || 0
    },
    archive: {
      enabled: archiveEnabled,
      exists: fs.existsSync(archiveDb),
      totalSessions,
      totalEvents,
      sessions24h,
      lastSessionAt,
      syncFailures24h,
      estimatedGapRecent24h
    },
    backfill: {
      enabled: backfillEnabled,
      dryRun: backfillDryRun,
      checkpointExists: fs.existsSync(checkpointFile),
      checkpoint,
      lastRunStatus: checkpoint?.lastRunStatus || null,
      lastRunAt: checkpoint?.lastRunAt || null,
      lastSuccessAt: checkpoint?.lastSuccessAt || null,
      lastScannedSessions: checkpoint?.lastScannedSessions || 0,
      lastCandidates: checkpoint?.lastCandidates || 0,
      lastWritten: checkpoint?.lastWritten || 0,
      lastDuplicates: checkpoint?.lastDuplicates || 0
    },
    consistency
  };
}

export function formatMemoryHealthMarkdown(report: MemoryHealthReport): string {
  const updated = new Date(report.timestamp).toLocaleString('zh-TW');
  return [
    '# Memory Status',
    '',
    `- Updated: ${updated}`,
    `- Archive Enabled: ${String(report.archive.enabled)}`,
    `- Archive DB Exists: ${String(report.archive.exists)}`,
    `- Archive Total Sessions: ${report.archive.totalSessions}`,
    `- Archive Total Events: ${report.archive.totalEvents}`,
    `- Archive Last Session At: ${report.archive.lastSessionAt || '(none)'}`,
    `- Archive Sessions 24h: ${report.archive.sessions24h}`,
    `- Archive Sync Failures 24h: ${report.archive.syncFailures24h}`,
    `- Archive Estimated Gap Recent 24h: ${report.archive.estimatedGapRecent24h}`,
    `- Operational DB Exists: ${String(report.operational.exists)}`,
    `- Operational Total Messages: ${report.operational.totalMessages}`,
    `- Operational Total Schedules: ${report.operational.totalSchedules}`,
    `- Operational Last Message At: ${report.operational.lastMessageAt || '(none)'}`,
    `- Operational Model Responses 24h: ${report.operational.modelResponses24h}`,
    `- Retrieval DB Exists: ${String(report.retrieval.exists)}`,
    `- Retrieval Entities: ${report.retrieval.entities}`,
    `- Retrieval Observations: ${report.retrieval.observations}`,
    `- Retrieval Relations: ${report.retrieval.relations}`,
    `- Backfill Enabled: ${String(report.backfill.enabled)}`,
    `- Backfill Dry Run: ${String(report.backfill.dryRun)}`,
    `- Backfill Checkpoint Exists: ${String(report.backfill.checkpointExists)}`,
    `- Backfill Last Run Status: ${report.backfill.lastRunStatus || '(none)'}`,
    `- Backfill Last Run At: ${report.backfill.lastRunAt || '(none)'}`,
    `- Backfill Last Success At: ${report.backfill.lastSuccessAt || '(none)'}`,
    `- Backfill Last Scanned Sessions: ${report.backfill.lastScannedSessions}`,
    `- Backfill Last Candidates: ${report.backfill.lastCandidates}`,
    `- Backfill Last Written: ${report.backfill.lastWritten}`,
    `- Backfill Last Duplicates: ${report.backfill.lastDuplicates}`,
    `- Backfill Checkpoint Timestamp: ${report.backfill.checkpoint?.lastProcessedTimestamp || '(none)'}`,
    `- Backfill Checkpoint Session ID: ${report.backfill.checkpoint?.lastProcessedSessionId || '(none)'}`,
    `- Consistency OK: ${String(report.consistency.ok)}`,
    `- Consistency Tagged Observations: ${report.consistency.sourceSessionTaggedObservations}`,
    `- Consistency Orphan Observations: ${report.consistency.orphanSourceSessionObservations}`,
    `- Consistency Missing Source Session Tag: ${report.consistency.observationsMissingSourceSession}`,
    `- Consistency Checkpoint Ahead Of Archive: ${String(report.consistency.checkpointAheadOfArchive)}`,
    `- Consistency Checkpoint Session Missing: ${String(report.consistency.checkpointSessionMissing)}`,
    '',
    '## Paths',
    `- operational_db: ${report.paths.operationalDb}`,
    `- retrieval_db: ${report.paths.retrievalDb}`,
    `- archive_db: ${report.paths.archiveDb}`,
    `- checkpoint_file: ${report.paths.checkpointFile}`
  ].join('\n');
}
