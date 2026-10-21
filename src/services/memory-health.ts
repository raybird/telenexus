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

/**
 * 封存從哪裡讀：`local` 是本服務能直接開的 sessions.db（有設定 MEMORIA_ARCHIVE_DB / MEMORIA_HOME,
 * 或預設路徑真的存在）；`remote` 是官方 Compose 的拆分部署，封存在 memoria 服務自己的 volume,
 * 本服務不讀取（issue 0017 決定不為此呼叫 Memoria API）。
 */
export type ArchiveSource = 'local' | 'remote';
/** 讀取狀態：`unavailable` 是檔案不存在，`error` 是檔案在但讀不了；兩者的數字欄位都是 null */
export type ReadStatus = 'ok' | 'unavailable' | 'error';
export type ArchiveStatus = ReadStatus;
/** `skipped` 是沒有可檢查的對象（例如沒有 checkpoint），視為通過；`unsupported` / `error` 是沒檢查到。 */
export type ConsistencyCheckStatus = 'checked' | 'skipped' | 'unsupported' | 'error';

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
  /** 以下兩個區塊的數字欄位在 status 不是 ok 時是 null，不是 0 */
  operational: {
    exists: boolean;
    status: ReadStatus;
    detail: string | null;
    totalMessages: number | null;
    totalSchedules: number | null;
    lastMessageAt: string | null;
    modelResponses24h: number | null;
  };
  retrieval: {
    exists: boolean;
    status: ReadStatus;
    detail: string | null;
    entities: number | null;
    observations: number | null;
    relations: number | null;
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
  backfill: {
    enabled: boolean;
    dryRun: boolean;
    /** 回填來源目前的狀態，與 worker 決定要不要執行用的是同一個判定 */
    sourceState: BackfillSourceState;
    sourceDetail: string;
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
    /** 查到問題為 false；每項都 checked 或 skipped 且沒問題才是 true；其餘（有項目沒檢查到）為 null */
    ok: boolean | null;
    checks: {
      orphanSourceSession: ConsistencyCheckStatus;
      checkpointSession: ConsistencyCheckStatus;
      checkpointAhead: ConsistencyCheckStatus;
    };
    /** 檢索資料庫讀不了時是 null */
    sourceSessionTaggedObservations: number | null;
    orphanSourceSessionObservations: number | null;
    observationsMissingSourceSession: number | null;
    checkpointAheadOfArchive: boolean | null;
    checkpointSessionMissing: boolean | null;
  };
};

type ConsistencyReport = MemoryHealthReport['consistency'];

export type BackfillSourceState =
  | 'remote-unsupported'
  | 'unavailable'
  | 'error'
  | 'empty'
  | 'up-to-date'
  | 'pending';

export type BackfillSourceAssessment = {
  source: ArchiveSource;
  state: BackfillSourceState;
  detail: string;
};

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

type RetrievalRows = {
  entities: number;
  observations: number;
  relations: number;
  /** 不含 `[source_session=` 字面值的觀察數 */
  untaggedObservations: number;
  /** 含該字面值、要再跑 regex 判定的觀察內容 */
  candidateContents: Array<string | undefined>;
};

function readRetrievalRows(db: Database.Database): RetrievalRows {
  const count = (sql: string) =>
    (db.prepare(sql).get() as { count?: number } | undefined)?.count || 0;
  // 這份報告每次 context snapshot 都會重算,先前是 `SELECT content FROM observations` 把整張表
  // 的內容拉進記憶體再逐列跑 regex。extractSourceSessionId 的 pattern 必然含 `[source_session=`
  // 這段字面值,而 SQLite 的 LIKE 對 ASCII 預設不分大小寫,和 regex 的 /i 一致——所以不含該
  // 子字串的列不可能命中,可以只用 COUNT 算掉、完全不搬運內容(實測生產資料 100% 屬於此類)。
  // 命中 LIKE 的列仍照舊跑原本的 regex,語意與先前逐列掃描完全相同。
  const MARKER_LIKE = '%[source_session=%';
  const untagged = db
    .prepare(
      `SELECT COUNT(*) as count FROM observations WHERE content IS NULL OR content NOT LIKE ?`
    )
    .get(MARKER_LIKE) as { count?: number } | undefined;
  const candidates = db
    .prepare(`SELECT content FROM observations WHERE content LIKE ?`)
    .all(MARKER_LIKE) as Array<{ content?: string }>;
  return {
    entities: count('SELECT COUNT(*) as count FROM entities'),
    observations: count('SELECT COUNT(*) as count FROM observations'),
    relations: count('SELECT COUNT(*) as count FROM relations'),
    untaggedObservations: untagged?.count || 0,
    candidateContents: candidates.map((row) => row.content)
  };
}

function extractSourceSessionId(content: string | null | undefined): string | null {
  if (typeof content !== 'string') {
    return null;
  }
  const match = content.match(/\[source_session=([^\]\s]+)\]/i);
  return match?.[1]?.trim() || null;
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
  sessionIds: Set<string> | null;
};

function archiveConfiguredBy(): string | null {
  if (process.env.MEMORIA_ARCHIVE_DB?.trim()) return 'MEMORIA_ARCHIVE_DB';
  if (process.env.MEMORIA_HOME?.trim()) return 'MEMORIA_HOME';
  return null;
}

function archiveSourceOf(configuredBy: string | null, exists: boolean): ArchiveSource {
  return configuredBy || exists ? 'local' : 'remote';
}

/** 只看設定與檔案是否存在，不開資料庫、不 throw；worker 的啟動訊息用 */
export function currentArchiveSource(): ArchiveSource {
  return archiveSourceOf(archiveConfiguredBy(), fs.existsSync(resolveMemoriaSessionsDbPath()));
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
    lastSessionAt: null,
    sessionIds: null
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
      const rows = db.prepare(`SELECT id FROM sessions`).all() as Array<{ id?: string }>;
      return {
        source,
        status: 'ok',
        detail: null,
        exists,
        totalSessions: sessionStats.total || 0,
        totalEvents: eventStats.count || 0,
        sessions24h: recentStats.count || 0,
        lastSessionAt: parseIsoDate(sessionStats.last_session_at),
        sessionIds: new Set(rows.map((row) => row.id).filter((id): id is string => Boolean(id)))
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
 * 回填來源的狀態。「有沒有新資料」沿用 worker 原本的比較：封存最新的 timestamp 與 checkpoint 的
 * lastProcessedTimestamp 都 trim 後做字串比較，checkpoint 沒有處理時間就從頭開始。
 */
function judgeBackfillSource(
  archive: ArchiveRead,
  checkpoint: BackfillCheckpoint | null,
  archiveDb: string
): BackfillSourceAssessment {
  const { source } = archive;
  if (archive.status === 'unavailable') {
    return source === 'remote'
      ? {
          source,
          state: 'remote-unsupported',
          detail: '遠端 Memoria 模式：回填只讀本機的 sessions.db，目前不支援遠端封存'
        }
      : { source, state: 'unavailable', detail: `${archive.detail}：${archiveDb}` };
  }
  if (archive.status === 'error') {
    return { source, state: 'error', detail: `封存讀取失敗：${archive.detail}` };
  }
  if (!archive.totalSessions) {
    return { source, state: 'empty', detail: '封存裡沒有任何 session' };
  }
  if (!archive.lastSessionAt) {
    // 舊版遇到 MAX(timestamp) 為空就不執行，維持一致
    return { source, state: 'up-to-date', detail: '封存的 session 都沒有時間，無從比較' };
  }
  const checkpointTimestamp = checkpoint?.lastProcessedTimestamp?.trim();
  if (!checkpointTimestamp) {
    return { source, state: 'pending', detail: '還沒有 checkpoint，從最舊的 session 開始' };
  }
  if (archive.lastSessionAt > checkpointTimestamp) {
    return {
      source,
      state: 'pending',
      detail: `封存最新的 session（${archive.lastSessionAt}）比 checkpoint（${checkpointTimestamp}）新`
    };
  }
  return {
    source,
    state: 'up-to-date',
    detail: `沒有比 checkpoint（${checkpointTimestamp}）更新的 session`
  };
}

/** worker 與 memory:backfill 用：以目前的設定判定回填來源 */
export function assessBackfillSource(): BackfillSourceAssessment {
  const archiveDb = resolveMemoriaSessionsDbPath();
  return judgeBackfillSource(
    readArchive(archiveDb),
    readCheckpoint(resolveMemoryBackfillCheckpointPath()),
    archiveDb
  );
}

type CheckpointCheck = { status: ConsistencyCheckStatus; problem: boolean | null };

/**
 * checkpoint 沒有該欄位時沒有東西可查：skipped、視為通過，與封存讀不讀得到無關（官方 Compose 的
 * 遠端模式預設沒有 checkpoint，正是這種情況）。有的話跟著封存的讀取狀態走，沒讀到時結果是 null。
 */
function checkCheckpointField(
  value: string | undefined,
  archive: ArchiveRead,
  archiveCheck: ConsistencyCheckStatus,
  isProblem: (value: string, sessionIds: Set<string>) => boolean
): CheckpointCheck {
  if (!value) return { status: 'skipped', problem: false };
  if (!archive.sessionIds) return { status: archiveCheck, problem: null };
  return { status: archiveCheck, problem: isProblem(value, archive.sessionIds) };
}

function collectConsistencyReport(
  retrieval: LocalRead<RetrievalRows>,
  archive: ArchiveRead,
  checkpoint: BackfillCheckpoint | null
): ConsistencyReport {
  // 需要封存內容的檢查：封存讀到了才算 checked，空封存也一樣要檢查
  const archiveCheck: ConsistencyCheckStatus =
    archive.status === 'ok' ? 'checked' : archive.status === 'error' ? 'error' : 'unsupported';
  const archiveSessionIds = archive.sessionIds;
  // orphan 檢查還要有觀察可查：檢索資料庫不存在就沒有對象（skipped），讀不了則是沒檢查到（error）
  const orphanCheck: ConsistencyCheckStatus =
    retrieval.status === 'error'
      ? 'error'
      : retrieval.status === 'unavailable'
        ? 'skipped'
        : archiveCheck;

  let sourceSessionTaggedObservations = 0;
  let observationsMissingSourceSession = retrieval.values?.untaggedObservations ?? 0;
  let orphanSourceSessionObservations = 0;

  for (const content of retrieval.values?.candidateContents ?? []) {
    const sessionId = extractSourceSessionId(content);
    if (!sessionId) {
      observationsMissingSourceSession += 1;
      continue;
    }
    sourceSessionTaggedObservations += 1;
    if (archiveSessionIds && !archiveSessionIds.has(sessionId)) {
      orphanSourceSessionObservations += 1;
    }
  }

  const checkpointSession = checkCheckpointField(
    checkpoint?.lastProcessedSessionId?.trim(),
    archive,
    archiveCheck,
    (sessionId, sessionIds) => !sessionIds.has(sessionId)
  );
  // 封存裡一筆 session 都沒有，checkpoint 卻記著處理過的時間：封存被清空或換過了
  const checkpointAhead = checkCheckpointField(
    checkpoint?.lastProcessedTimestamp?.trim(),
    archive,
    archiveCheck,
    (timestamp) =>
      archive.lastSessionAt ? timestamp > archive.lastSessionAt : archive.totalSessions === 0
  );

  const checks = {
    orphanSourceSession: orphanCheck,
    checkpointSession: checkpointSession.status,
    checkpointAhead: checkpointAhead.status
  };
  const foundProblem =
    (orphanCheck === 'checked' && orphanSourceSessionObservations > 0) ||
    checkpointSession.problem === true ||
    checkpointAhead.problem === true;
  const allChecked = Object.values(checks).every(
    (status) => status === 'checked' || status === 'skipped'
  );

  const retrievalRead = retrieval.status !== 'error';
  return {
    ok: foundProblem ? false : allChecked ? true : null,
    checks,
    sourceSessionTaggedObservations: retrievalRead ? sourceSessionTaggedObservations : null,
    orphanSourceSessionObservations:
      orphanCheck === 'checked' || orphanCheck === 'skipped'
        ? orphanSourceSessionObservations
        : null,
    observationsMissingSourceSession: retrievalRead ? observationsMissingSourceSession : null,
    checkpointAheadOfArchive: checkpointAhead.problem,
    checkpointSessionMissing: checkpointSession.problem
  };
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

  const operational = readLocalDb(operationalDb, '運作資料庫', readOperationalStats);
  const retrieval = readLocalDb(retrievalDb, '檢索資料庫', readRetrievalRows);

  const archive = readArchive(archiveDb);

  const syncFailures24h = countRecentMemoriaIssues();
  const modelResponses24h = operational.values?.modelResponses24h ?? null;
  const estimatedGapRecent24h =
    archive.sessions24h === null || modelResponses24h === null
      ? null
      : Math.max(modelResponses24h - archive.sessions24h, 0);
  const archiveEnabled =
    (process.env.MEMORIA_SYNC_ENABLED || 'auto').trim().toLowerCase() !== 'off';
  const backfillEnabled =
    (process.env.MEMORY_BACKFILL_ENABLED || 'false').trim().toLowerCase() === 'true';
  const dryRunRaw = (process.env.MEMORY_BACKFILL_DRY_RUN || 'true').trim().toLowerCase();
  const backfillDryRun = !(dryRunRaw === 'false' || dryRunRaw === '0' || dryRunRaw === 'off');
  const consistency = collectConsistencyReport(retrieval, archive, checkpoint);
  const backfillSource = judgeBackfillSource(archive, checkpoint, archiveDb);

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
      exists: operational.exists,
      status: operational.status,
      detail: operational.detail,
      totalMessages: operational.values?.totalMessages ?? null,
      totalSchedules: operational.values?.totalSchedules ?? null,
      lastMessageAt: operational.values?.lastMessageAt ?? null,
      modelResponses24h
    },
    retrieval: {
      exists: retrieval.exists,
      status: retrieval.status,
      detail: retrieval.detail,
      entities: retrieval.values?.entities ?? null,
      observations: retrieval.values?.observations ?? null,
      relations: retrieval.values?.relations ?? null
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
    },
    backfill: {
      enabled: backfillEnabled,
      dryRun: backfillDryRun,
      sourceState: backfillSource.state,
      sourceDetail: backfillSource.detail,
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

/** 沒讀到、沒檢查到的值顯示 unknown，不讓它看起來像 0 或 true */
function orUnknown(value: number | boolean | null): string {
  return value === null ? 'unknown' : String(value);
}

export function formatMemoryHealthMarkdown(report: MemoryHealthReport): string {
  const updated = new Date(report.timestamp).toLocaleString('zh-TW');
  const { checks } = report.consistency;
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
    `- Retrieval DB Exists: ${String(report.retrieval.exists)}`,
    `- Retrieval Status: ${report.retrieval.status}`,
    `- Retrieval Detail: ${report.retrieval.detail || '(none)'}`,
    `- Retrieval Entities: ${orUnknown(report.retrieval.entities)}`,
    `- Retrieval Observations: ${orUnknown(report.retrieval.observations)}`,
    `- Retrieval Relations: ${orUnknown(report.retrieval.relations)}`,
    `- Backfill Enabled: ${String(report.backfill.enabled)}`,
    `- Backfill Dry Run: ${String(report.backfill.dryRun)}`,
    `- Backfill Source State: ${report.backfill.sourceState}`,
    `- Backfill Source Detail: ${report.backfill.sourceDetail}`,
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
    `- Consistency OK: ${orUnknown(report.consistency.ok)}`,
    `- Consistency Check Orphan Source Session: ${checks.orphanSourceSession}`,
    `- Consistency Check Checkpoint Session: ${checks.checkpointSession}`,
    `- Consistency Check Checkpoint Ahead: ${checks.checkpointAhead}`,
    `- Consistency Tagged Observations: ${orUnknown(report.consistency.sourceSessionTaggedObservations)}`,
    `- Consistency Orphan Observations: ${orUnknown(report.consistency.orphanSourceSessionObservations)}`,
    `- Consistency Missing Source Session Tag: ${orUnknown(report.consistency.observationsMissingSourceSession)}`,
    `- Consistency Checkpoint Ahead Of Archive: ${orUnknown(report.consistency.checkpointAheadOfArchive)}`,
    `- Consistency Checkpoint Session Missing: ${orUnknown(report.consistency.checkpointSessionMissing)}`,
    '',
    '## Paths',
    `- operational_db: ${report.paths.operationalDb}`,
    `- retrieval_db: ${report.paths.retrievalDb}`,
    `- archive_db: ${report.paths.archiveDb}`,
    `- checkpoint_file: ${report.paths.checkpointFile}`
  ].join('\n');
}
