/**
 * opencode session 的保留期清理（issue 0009）。
 *
 * opencode 把每次執行的對話與工具輸出存進 opencode.db 且從不清理；TeleNexus 自己另存對話紀錄，
 * 不會回頭讀舊的 opencode session，所以超過保留期的 session 可以刪除。
 * 一律經 opencode 的 CLI 操作，不直接寫它的資料表；刪除與回收的實測見
 * docs/issues/issue-0009/evidence/step1-delete-vacuum-probe.md。
 */
import { createLogger } from '../core/logger.js';
import { OPENCODE_SESSION_NOT_FOUND_PATTERN } from '../core/opencode.js';
import { ProcessError, runProcess } from '../core/process-runner.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import path from 'node:path';
import { parseBool, parsePositiveInt } from '../utils/env.js';
import { resolveProjectDir } from '../utils/paths.js';
import { readBoundSessionIds } from './chat-session-store.js';

const log = createLogger('opencode-retention');

export const RETENTION_BATCH_LIMIT = 100;
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const OPENCODE_COMMAND_TIMEOUT_MS = 60 * 1000;
/** 可回收頁數達總頁數的這個比例才回收（issue 0009 TBD-2）。 */
export const RECLAIM_FREELIST_RATIO = 0.2;
const RECLAIM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 全庫最近這段時間內有 session 更新，就當作還有任務在執行。 */
const RECLAIM_QUIET_MS = 5 * 60 * 1000;
/** VACUUM 要複製整個資料庫；實測 220 MB 不到 1 秒，上限放寬給更大的資料庫與較慢的磁碟。 */
const VACUUM_TIMEOUT_MS = 10 * 60 * 1000;

/** 挑選用的 session 摘要，來自 `opencode db` 查詢的 `id`、`time_updated`、`parent_id`。 */
export interface RetentionCandidate {
  id: string;
  /** 最後更新時間（毫秒）。缺漏或無法解析時為 null。 */
  updatedAt: number | null;
  parentId: string | null;
}

export interface SelectSessionsInput {
  sessions: readonly RetentionCandidate[];
  /** 綁定中的聊天 session，不論多舊都保留。 */
  protectedIds: ReadonlySet<string>;
  now: number;
  retentionDays: number;
  limit: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 以最後更新時間判斷過期，不看建立時間：長期沿用的聊天 session 建立得早但一直在更新。
 * 子 session 不單獨選，`opencode session delete` 刪父 session 時會一併刪掉它們。
 */
export function selectSessionsToDelete(input: SelectSessionsInput): string[] {
  const cutoff = input.now - input.retentionDays * DAY_MS;
  return input.sessions
    .filter(
      (session): session is RetentionCandidate & { updatedAt: number } =>
        session.parentId === null &&
        !input.protectedIds.has(session.id) &&
        Number.isFinite(session.updatedAt) &&
        (session.updatedAt as number) < cutoff
    )
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, input.limit)
    .map((session) => session.id);
}

export interface RetentionConfig {
  enabled: boolean;
  retentionDays: number;
}

export function loadRetentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  return {
    enabled: parseBool(env.OPENCODE_SESSION_RETENTION_ENABLED, true),
    // 0 或負數退回預設：保留 0 天等於每次把所有 session 刪光。
    retentionDays: parsePositiveInt(env.OPENCODE_SESSION_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
  };
}

/**
 * 解析 `opencode db --format json` 的輸出。opencode 的輸出超過約 64 KB 時，經 pipe 會被截斷而
 * exit 仍是 0，所以解析不了就拋出，不能拿部分結果去刪。
 */
export function parseCandidateRows(stdout: string): RetentionCandidate[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('opencode db output is not an array');
  }
  return parsed.map((row: unknown) => {
    const record = (row ?? {}) as Record<string, unknown>;
    if (typeof record['id'] !== 'string' || record['id'].length === 0) {
      throw new Error('opencode db row has no session id');
    }
    const updated = record['time_updated'];
    const parentId = record['parent_id'];
    return {
      id: record['id'],
      updatedAt: typeof updated === 'number' && Number.isFinite(updated) ? updated : null,
      parentId: typeof parentId === 'string' ? parentId : null
    };
  });
}

export interface RetentionDeps {
  /** 依最後更新時間由舊到新取頂層 session，最多 limit 個。 */
  queryCandidates: (limit: number) => Promise<RetentionCandidate[]>;
  deleteSession: (id: string) => Promise<void>;
  /** 讀不到綁定時拋出例外：沒有保護清單就不能刪。 */
  readProtectedIds: () => Set<string>;
  /** `page_count` 與 `freelist_count`。 */
  readSpaceStats: () => Promise<SpaceStats>;
  vacuum: () => Promise<void>;
  /** `PRAGMA wal_checkpoint(TRUNCATE)`。 */
  truncateWal: () => Promise<WalCheckpointResult>;
  /** 沒有 opencode 任務在執行。 */
  isIdle: () => boolean;
  now?: () => number;
}

export interface SpaceStats {
  pageCount: number;
  freelistCount: number;
  /** 全庫最後一次有 session 更新的時間；兩個服務共用這份資料庫，所以看得到彼此的任務。 */
  latestSessionUpdate: number | null;
}

/** `PRAGMA wal_checkpoint(TRUNCATE)` 回傳的一列。 */
export interface WalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

/** 解析 `opencode db --format json "PRAGMA wal_checkpoint(TRUNCATE)"` 的輸出。 */
export function parseWalCheckpoint(stdout: string): WalCheckpointResult {
  const parsed: unknown = JSON.parse(stdout);
  const row = (Array.isArray(parsed) ? parsed[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  const busy = row?.['busy'];
  const log = row?.['log'];
  const checkpointed = row?.['checkpointed'];
  if (typeof busy !== 'number' || typeof log !== 'number' || typeof checkpointed !== 'number') {
    throw new Error('opencode db output has no busy / log / checkpointed');
  }
  return { busy, log, checkpointed };
}

export type ReclaimOutcome =
  | 'reclaimed'
  | 'below-threshold'
  | 'busy'
  | 'recently-reclaimed'
  | 'failed'
  | 'wal-truncate-pending';

/** truncated：WAL 已縮回 0；not-truncated：這次沒截斷成功，之後重試；deferred：有任務在執行，留到閒置。 */
export type WalTruncateOutcome = 'truncated' | 'not-truncated' | 'deferred';

/** 跨輪次保存的回收狀態，由排程持有；只在記憶體中，服務重啟後不保留。 */
export interface ReclaimState {
  lastReclaimAt: number | null;
  /** 回收後的截斷還沒成功，之後的輪次只重試截斷、不再 VACUUM。 */
  walTruncatePending?: boolean;
}

interface ReclaimResult {
  reclaim: ReclaimOutcome;
  walTruncate?: WalTruncateOutcome;
}

/** 解析 `select * from pragma_page_count(), pragma_freelist_count()` 的 JSON 輸出。 */
export function parseSpaceStats(stdout: string): SpaceStats {
  const parsed: unknown = JSON.parse(stdout);
  const row = (Array.isArray(parsed) ? parsed[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  const pageCount = row?.['page_count'];
  const freelistCount = row?.['freelist_count'];
  if (typeof pageCount !== 'number' || typeof freelistCount !== 'number') {
    throw new Error('opencode db output has no page_count / freelist_count');
  }
  const latest = row?.['latest_session_update'];
  return {
    pageCount,
    freelistCount,
    latestSessionUpdate: typeof latest === 'number' && Number.isFinite(latest) ? latest : null
  };
}

/**
 * runner 看不到 telenexus 本機執行的任務（反之亦然），但兩邊寫的是同一份資料庫，
 * 所以再看全庫最近有沒有 session 被更新。
 */
function isQuiet(deps: RetentionDeps, stats: SpaceStats, at: number): boolean {
  return (
    deps.isIdle() &&
    (stats.latestSessionUpdate === null || at - stats.latestSessionUpdate >= RECLAIM_QUIET_MS)
  );
}

/**
 * WAL 模式下 VACUUM 會把整個新資料庫寫進 WAL，checkpoint 不會縮小 WAL 檔，opencode 結束時也不刪它，
 * 所以要截斷（issue 0014）。有其他連線在讀時回傳 busy=1 但 exit 仍是 0，只能看 busy 判斷。
 */
async function truncateWal(deps: RetentionDeps, state: ReclaimState): Promise<WalTruncateOutcome> {
  try {
    const result = await deps.truncateWal();
    if (result.busy === 0) {
      state.walTruncatePending = false;
      return 'truncated';
    }
    recordRuntimeIssue(
      'opencode-retention:wal-truncate',
      new Error(
        `wal_checkpoint(TRUNCATE) busy=${result.busy} log=${result.log} checkpointed=${result.checkpointed}`
      )
    );
  } catch (error) {
    recordRuntimeIssue('opencode-retention:wal-truncate', error);
  }
  state.walTruncatePending = true;
  return 'not-truncated';
}

/** 回收後的截斷還沒成功：沒有任務在執行時重試，有任務時留到之後的輪次。 */
async function retryWalTruncate(
  deps: RetentionDeps,
  state: ReclaimState,
  at: number
): Promise<WalTruncateOutcome> {
  try {
    if (!isQuiet(deps, await deps.readSpaceStats(), at)) {
      return 'deferred';
    }
  } catch (error) {
    recordRuntimeIssue('opencode-retention:wal-truncate', error);
    return 'not-truncated';
  }
  return truncateWal(deps, state);
}

/**
 * 刪除後空出的頁面會被重複使用，檔案不再長大，但要變小得 VACUUM。實測 220 MB 回收不到 1 秒，
 * 期間讀取不受影響、寫入最多等 390 ms，opencode 的連線本身有 busy_timeout=5000；仍只在沒有任務時做，
 * 而且一天最多一次。平常的頁面會被重複使用，所以通常只有清完積壓後才會觸發。
 */
async function maybeReclaimSpace(
  deps: RetentionDeps,
  state: ReclaimState,
  now: () => number
): Promise<ReclaimResult> {
  const at = now();
  if (state.walTruncatePending) {
    return {
      reclaim: 'wal-truncate-pending',
      walTruncate: await retryWalTruncate(deps, state, at)
    };
  }
  if (state.lastReclaimAt !== null && at - state.lastReclaimAt < RECLAIM_MIN_INTERVAL_MS) {
    return { reclaim: 'recently-reclaimed' };
  }
  try {
    const stats = await deps.readSpaceStats();
    if (stats.pageCount <= 0 || stats.freelistCount / stats.pageCount < RECLAIM_FREELIST_RATIO) {
      return { reclaim: 'below-threshold' };
    }
    if (!isQuiet(deps, stats, at)) {
      return { reclaim: 'busy' };
    }
    await deps.vacuum();
    state.lastReclaimAt = at;
  } catch (error) {
    recordRuntimeIssue('opencode-retention:vacuum', error);
    return { reclaim: 'failed' };
  }
  return { reclaim: 'reclaimed', walTruncate: await truncateWal(deps, state) };
}

export interface RetentionRunResult {
  skipped?: 'disabled' | 'protected-ids-unavailable' | 'query-failed';
  reclaim?: ReclaimOutcome;
  walTruncate?: WalTruncateOutcome;
  candidates: number;
  deleted: number;
  failed: number;
  durationMs: number;
}

export async function runRetentionOnce(
  config: RetentionConfig,
  deps: RetentionDeps,
  limit: number = RETENTION_BATCH_LIMIT,
  reclaimState: ReclaimState = { lastReclaimAt: null }
): Promise<RetentionRunResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const result = (fields: Omit<RetentionRunResult, 'durationMs'>): RetentionRunResult => ({
    ...fields,
    durationMs: now() - startedAt
  });

  if (!config.enabled) {
    return result({ skipped: 'disabled', candidates: 0, deleted: 0, failed: 0 });
  }

  let protectedIds: Set<string>;
  try {
    protectedIds = deps.readProtectedIds();
  } catch (error) {
    recordRuntimeIssue('opencode-retention:protected-ids', error);
    return result({ skipped: 'protected-ids-unavailable', candidates: 0, deleted: 0, failed: 0 });
  }

  let toDelete: string[];
  try {
    // 綁定中的 session 若剛好是最舊的，會佔掉查詢的名額，所以多查它們的數量。
    const sessions = await deps.queryCandidates(limit + protectedIds.size);
    toDelete = selectSessionsToDelete({
      sessions,
      protectedIds,
      now: now(),
      retentionDays: config.retentionDays,
      limit
    });
  } catch (error) {
    recordRuntimeIssue('opencode-retention:query', error);
    return result({ skipped: 'query-failed', candidates: 0, deleted: 0, failed: 0 });
  }

  let deleted = 0;
  let firstError: unknown;
  for (const id of toDelete) {
    try {
      await deps.deleteSession(id);
      deleted += 1;
    } catch (error) {
      firstError ??= error;
    }
  }

  const failed = toDelete.length - deleted;
  if (failed > 0) {
    recordRuntimeIssue(
      'opencode-retention:delete',
      new Error(`${failed}/${toDelete.length} session 刪除失敗：${(firstError as Error)?.message}`)
    );
  }
  const reclaim = await maybeReclaimSpace(deps, reclaimState, now);
  const summary = result({ candidates: toDelete.length, deleted, failed, ...reclaim });
  log.info('run', { ...summary });
  return summary;
}

/** 兩個服務共用 opencode 的資料 volume，只能有一邊清理：有 runner 時由 runner 負責。 */
export function shouldMainRunRetention(runnerEndpoint: string | undefined): boolean {
  return !runnerEndpoint;
}

export interface RetentionHandle {
  stop: () => void;
  runOnce: () => Promise<RetentionRunResult>;
}

/** 啟動後不立刻跑，每個間隔執行一次；上一次還沒結束時跳過這一輪。 */
export function startOpencodeSessionRetention(
  config: RetentionConfig,
  deps: RetentionDeps,
  intervalMs: number = RETENTION_INTERVAL_MS
): RetentionHandle {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const reclaimState: ReclaimState = { lastReclaimAt: null };

  const runOnce = async (): Promise<RetentionRunResult> =>
    runRetentionOnce(config, deps, RETENTION_BATCH_LIMIT, reclaimState);

  if (config.enabled) {
    log.info('scheduled', { retentionDays: config.retentionDays, intervalMs });
    timer = setInterval(() => {
      if (running) return;
      running = true;
      // runRetentionOnce 自己處理所有失敗；這裡的 catch 只防它之外的意外，不讓 timer 被帶走。
      runOnce()
        .catch((error: unknown) => recordRuntimeIssue('opencode-retention:internal', error))
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref?.();
  } else {
    log.info('disabled', {});
  }

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce
  };
}

/** TeleNexus 執行 opencode 的目錄：服務的專案目錄與其下的 workspace。 */
export function resolveRetentionDirectories(projectDir: string = resolveProjectDir()): string[] {
  const root = path.resolve(projectDir);
  return [root, path.join(root, 'workspace')];
}

/** SQL 字串常值：單引號加倍。目錄來自服務自己的設定，不是外部輸入，仍照規則跳脫。 */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 實際的 opencode CLI 與綁定狀態檔；isIdle 由掛載的服務提供。 */
export function createOpencodeRetentionDeps(
  isIdle: () => boolean,
  directories: readonly string[] = resolveRetentionDirectories()
): RetentionDeps {
  return {
    isIdle,
    readSpaceStats: async () => {
      const { stdout } = await runProcess(
        'opencode',
        [
          'db',
          '--format',
          'json',
          'select (select max(time_updated) from session) as latest_session_update, * ' +
            'from pragma_page_count(), pragma_freelist_count()'
        ],
        { timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS }
      );
      return parseSpaceStats(stdout);
    },
    vacuum: async () => {
      await runProcess('opencode', ['db', 'VACUUM'], { timeoutMs: VACUUM_TIMEOUT_MS });
    },
    truncateWal: async () => {
      const { stdout } = await runProcess(
        'opencode',
        ['db', '--format', 'json', 'PRAGMA wal_checkpoint(TRUNCATE)'],
        { timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS }
      );
      return parseWalCheckpoint(stdout);
    },
    queryCandidates: async (limit) => {
      // 只看 TeleNexus 自己執行 opencode 的目錄：在主機上執行時，opencode.db 是使用者全域的，
      // 裡面有其他專案的 session（issue 0009 審查 M1）。時間為 NULL 的排除，免得佔住名額。
      const sql =
        'select id, time_updated, parent_id from session where parent_id is null ' +
        'and time_updated is not null ' +
        `and directory in (${directories.map(sqlString).join(', ')}) ` +
        `order by time_updated asc limit ${Math.max(1, Math.floor(limit))}`;
      const { stdout } = await runProcess('opencode', ['db', '--format', 'json', sql], {
        timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS
      });
      return parseCandidateRows(stdout);
    },
    deleteSession: async (id) => {
      try {
        await runProcess('opencode', ['session', 'delete', id], {
          timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS
        });
      } catch (error) {
        // 已經不存在就是刪除的目的已達成：例如另一個服務同時在清理，或探針已刪掉自己的 session。
        if (
          error instanceof ProcessError &&
          OPENCODE_SESSION_NOT_FOUND_PATTERN.test(error.stderr ?? '')
        ) {
          return;
        }
        throw error;
      }
    },
    readProtectedIds: () => readBoundSessionIds()
  };
}
