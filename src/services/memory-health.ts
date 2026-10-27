import fs from 'fs';
import Database from 'better-sqlite3';
import { getRecentIssues } from '../utils/errors.js';
import { resolveDbPath, resolveMemoriaSessionsDbPath } from '../utils/paths.js';

/**
 * 封存從哪裡讀：`local` 是本服務能直接開的 sessions.db（有設定 MEMORIA_ARCHIVE_DB / MEMORIA_HOME,
 * 或預設路徑真的存在）；`remote` 是官方 Compose 的拆分部署，封存在 memoria 服務自己的 volume,
 * 本服務不讀取（issue 0017 決定不為此呼叫 Memoria API）。
 */
export type ArchiveSource = 'local' | 'remote';
/** 讀取狀態：`unavailable` 是檔案不存在，`error` 是檔案在但讀不了；兩者的數字欄位都是 null */
export type ReadStatus = 'ok' | 'unavailable' | 'error';
export type ArchiveStatus = ReadStatus;

export type MemoryHealthReport = {
  ok: boolean;
  timestamp: number;
  generatedAt: string;
  paths: {
    operationalDb: string;
    archiveDb: string;
  };
  /** 數字欄位在 status 不是 ok 時是 null，不是 0 */
  operational: {
    exists: boolean;
    status: ReadStatus;
    detail: string | null;
    totalMessages: number | null;
    totalSchedules: number | null;
    lastMessageAt: string | null;
    modelResponses24h: number | null;
  };
  archive: {
    enabled: boolean;
    source: ArchiveSource;
    status: ArchiveStatus;
    /** status 不是 ok 時的原因；ok 時為 null */
    detail: string | null;
    exists: boolean;
    /** 以下四項在封存沒讀到時是 null，不是 0 */
    totalSessions: number | null;
    totalEvents: number | null;
    sessions24h: number | null;
    lastSessionAt: string | null;
    syncFailures24h: number;
    estimatedGapRecent24h: number | null;
  };
};

function countRecentMemoriaIssues(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return getRecentIssues()
    .filter((issue) => issue.timestamp >= cutoff)
    .filter((issue) => /memoria/i.test(issue.scope) || /memoria/i.test(issue.message))
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

type LocalRead<T> = {
  exists: boolean;
  status: ReadStatus;
  detail: string | null;
  values: T | null;
};

/**
 * 讀本機資料庫。讀不了（不是 SQLite、缺資料表…）時回 error 而不 throw：這份報告每輪 context
 * snapshot 都會重算，throw 會讓整批 snapshot 停止更新。比照封存，失敗只寫在報告裡、不記 runtime issue。
 */
function readLocalDb<T>(
  dbPath: string,
  label: string,
  read: (db: Database.Database) => T
): LocalRead<T> {
  if (!fs.existsSync(dbPath)) {
    return {
      exists: false,
      status: 'unavailable',
      detail: `找不到${label}：${dbPath}`,
      values: null
    };
  }
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return { exists: true, status: 'ok', detail: null, values: read(db) };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      exists: true,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
      values: null
    };
  }
}

type OperationalStats = {
  totalMessages: number;
  totalSchedules: number;
  lastMessageAt: string | null;
  modelResponses24h: number;
};

function readOperationalStats(db: Database.Database): OperationalStats {
  const messageStats = db
    .prepare(`SELECT COUNT(*) as total, MAX(timestamp) as last_message_at FROM messages`)
    .get() as { total?: number; last_message_at?: number };
  const scheduleStats = db.prepare(`SELECT COUNT(*) as count FROM schedules`).get() as {
    count?: number;
  };
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const modelStats = db
    .prepare(`SELECT COUNT(*) as count FROM messages WHERE role = 'model' AND timestamp >= ?`)
    .get(cutoffMs) as { count?: number };
  return {
    totalMessages: messageStats.total || 0,
    lastMessageAt:
      typeof messageStats.last_message_at === 'number' && messageStats.last_message_at > 0
        ? new Date(messageStats.last_message_at).toISOString()
        : null,
    totalSchedules: scheduleStats.count || 0,
    modelResponses24h: modelStats.count || 0
  };
}

type ArchiveRead = {
  source: ArchiveSource;
  status: ArchiveStatus;
  detail: string | null;
  exists: boolean;
  totalSessions: number | null;
  totalEvents: number | null;
  sessions24h: number | null;
  lastSessionAt: string | null;
};

function archiveConfiguredBy(): string | null {
  if (process.env.MEMORIA_ARCHIVE_DB?.trim()) return 'MEMORIA_ARCHIVE_DB';
  if (process.env.MEMORIA_HOME?.trim()) return 'MEMORIA_HOME';
  return null;
}

function archiveSourceOf(configuredBy: string | null, exists: boolean): ArchiveSource {
  return configuredBy || exists ? 'local' : 'remote';
}

/**
 * 讀不到封存時回傳 unavailable / error 與 null 統計，不 throw：這份報告每次 context snapshot
 * 都會重算，throw 會讓整批 snapshot 寫不出來。也不記 runtime issue —— 封存壞掉時每分鐘都會重算,
 * 記下去只會讓 ErrorAlerter 累積成告警洗版，原因已經寫在報告的 detail 裡。
 */
function readArchive(archiveDb: string): ArchiveRead {
  const configuredBy = archiveConfiguredBy();
  const exists = fs.existsSync(archiveDb);
  const source = archiveSourceOf(configuredBy, exists);
  const unread = {
    source,
    exists,
    totalSessions: null,
    totalEvents: null,
    sessions24h: null,
    lastSessionAt: null
  };

  if (!exists) {
    return {
      ...unread,
      status: 'unavailable',
      detail: configuredBy
        ? `找不到 ${configuredBy} 設定的封存路徑`
        : '遠端 Memoria 模式：封存在 memoria 服務的 volume，本服務不讀取'
    };
  }

  try {
    const db = new Database(archiveDb, { readonly: true, fileMustExist: true });
    try {
      const sessionStats = db
        .prepare(`SELECT COUNT(*) as total, MAX(timestamp) as last_session_at FROM sessions`)
        .get() as { total?: number; last_session_at?: string | null };
      const eventStats = db.prepare(`SELECT COUNT(*) as count FROM events`).get() as {
        count?: number;
      };
      const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recentStats = db
        .prepare(`SELECT COUNT(*) as count FROM sessions WHERE timestamp >= ?`)
        .get(cutoffIso) as { count?: number };
      return {
        source,
        status: 'ok',
        detail: null,
        exists,
        totalSessions: sessionStats.total || 0,
        totalEvents: eventStats.count || 0,
        sessions24h: recentStats.count || 0,
        lastSessionAt: parseIsoDate(sessionStats.last_session_at)
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      ...unread,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * ⚠ 不要在這裡加 `PRAGMA quick_check` / `integrity_check`。
 *
 * better-sqlite3 的長生命週期連線,只要 DB 裡有 FTS5 虛擬表(moltbot.db 有兩張:
 * messages_fts / messages_summary_fts)、又被**另一個行程**寫過,完整性檢查就會回
 * `malformed inverted index for FTS5 table …` —— 資料其實完好,壞的只是那條連線上
 * 的 FTS5 快取狀態。重新 prepare 清不掉,只有關閉重開連線有效;read-write 連線同樣
 * 會中,不是唯讀專屬。而 memory:cli / memory:health 都是獨立行程,
 * 跑過任何一個就滿足觸發條件。
 *
 * 上游 Memoria 的 /v1/health 就是這樣長期謊報損壞(2026-08-14 三方各自重現確認,
 * 見其 issue-14)。真要做完整性檢查,得用一條當場開、用完就關的專屬連線。
 */
export function collectMemoryHealthReport(): MemoryHealthReport {
  const operationalDb = resolveDbPath();
  const archiveDb = resolveMemoriaSessionsDbPath();
  const generatedAt = new Date().toISOString();

  const operational = readLocalDb(operationalDb, '運作資料庫', readOperationalStats);

  const archive = readArchive(archiveDb);

  const syncFailures24h = countRecentMemoriaIssues();
  const modelResponses24h = operational.values?.modelResponses24h ?? null;
  const estimatedGapRecent24h =
    archive.sessions24h === null || modelResponses24h === null
      ? null
      : Math.max(modelResponses24h - archive.sessions24h, 0);
  const archiveEnabled =
    (process.env.MEMORIA_SYNC_ENABLED || 'auto').trim().toLowerCase() !== 'off';

  return {
    ok: true,
    timestamp: Date.now(),
    generatedAt,
    paths: {
      operationalDb,
      archiveDb
    },
    operational: {
      exists: operational.exists,
      status: operational.status,
      detail: operational.detail,
      totalMessages: operational.values?.totalMessages ?? null,
      totalSchedules: operational.values?.totalSchedules ?? null,
      lastMessageAt: operational.values?.lastMessageAt ?? null,
      modelResponses24h
    },
    archive: {
      enabled: archiveEnabled,
      source: archive.source,
      status: archive.status,
      detail: archive.detail,
      exists: archive.exists,
      totalSessions: archive.totalSessions,
      totalEvents: archive.totalEvents,
      sessions24h: archive.sessions24h,
      lastSessionAt: archive.lastSessionAt,
      syncFailures24h,
      estimatedGapRecent24h
    }
  };
}

/** 沒讀到的值顯示 unknown，不讓它看起來像 0 */
function orUnknown(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

export function formatMemoryHealthMarkdown(report: MemoryHealthReport): string {
  const updated = new Date(report.timestamp).toLocaleString('zh-TW');
  return [
    '# Memory Status',
    '',
    `- Updated: ${updated}`,
    `- Archive Enabled: ${String(report.archive.enabled)}`,
    `- Archive Source: ${report.archive.source}`,
    `- Archive Status: ${report.archive.status}`,
    `- Archive Detail: ${report.archive.detail || '(none)'}`,
    `- Archive DB Exists: ${String(report.archive.exists)}`,
    `- Archive Total Sessions: ${orUnknown(report.archive.totalSessions)}`,
    `- Archive Total Events: ${orUnknown(report.archive.totalEvents)}`,
    `- Archive Last Session At: ${report.archive.status === 'ok' ? report.archive.lastSessionAt || '(none)' : 'unknown'}`,
    `- Archive Sessions 24h: ${orUnknown(report.archive.sessions24h)}`,
    `- Archive Sync Failures 24h: ${report.archive.syncFailures24h}`,
    `- Archive Estimated Gap Recent 24h: ${orUnknown(report.archive.estimatedGapRecent24h)}`,
    `- Operational DB Exists: ${String(report.operational.exists)}`,
    `- Operational Status: ${report.operational.status}`,
    `- Operational Detail: ${report.operational.detail || '(none)'}`,
    `- Operational Total Messages: ${orUnknown(report.operational.totalMessages)}`,
    `- Operational Total Schedules: ${orUnknown(report.operational.totalSchedules)}`,
    `- Operational Last Message At: ${report.operational.status === 'ok' ? report.operational.lastMessageAt || '(none)' : 'unknown'}`,
    `- Operational Model Responses 24h: ${orUnknown(report.operational.modelResponses24h)}`,
    '',
    '## Paths',
    `- operational_db: ${report.paths.operationalDb}`,
    `- archive_db: ${report.paths.archiveDb}`
  ].join('\n');
}
