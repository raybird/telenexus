/**
 * opencode session 的保留期清理（issue 0009）。
 *
 * opencode 把每次執行的對話與工具輸出存進 opencode.db 且從不清理；TeleNexus 自己另存對話紀錄，
 * 不會回頭讀舊的 opencode session，所以超過保留期的 session 可以刪除。
 * 一律經 opencode 的 CLI 操作，不直接寫它的資料表；刪除與回收的實測見
 * docs/issues/issue-0009/evidence/step1-delete-vacuum-probe.md。
 */
import { createLogger } from '../core/logger.js';
import { runProcess } from '../core/process-runner.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { parseBool, parsePositiveInt } from '../utils/env.js';
import { readBoundSessionIds } from './chat-session-store.js';

const log = createLogger('opencode-retention');

export const RETENTION_BATCH_LIMIT = 100;
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const OPENCODE_COMMAND_TIMEOUT_MS = 60 * 1000;
/** 可回收頁數達總頁數的這個比例才回收（issue 0009 TBD-2）。 */
export const RECLAIM_FREELIST_RATIO = 0.2;
const RECLAIM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
  /** 沒有 opencode 任務在執行。 */
  isIdle: () => boolean;
  now?: () => number;
}

export interface SpaceStats {
  pageCount: number;
  freelistCount: number;
}

export type ReclaimOutcome =
  | 'reclaimed'
  | 'below-threshold'
  | 'busy'
  | 'recently-reclaimed'
  | 'failed';

/** 跨輪次保存的回收狀態，由排程持有。 */
export interface ReclaimState {
  lastReclaimAt: number | null;
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
  return { pageCount, freelistCount };
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
): Promise<ReclaimOutcome> {
  const at = now();
  if (state.lastReclaimAt !== null && at - state.lastReclaimAt < RECLAIM_MIN_INTERVAL_MS) {
    return 'recently-reclaimed';
  }
  try {
    const stats = await deps.readSpaceStats();
    if (stats.pageCount <= 0 || stats.freelistCount / stats.pageCount < RECLAIM_FREELIST_RATIO) {
      return 'below-threshold';
    }
    if (!deps.isIdle()) return 'busy';
    await deps.vacuum();
    state.lastReclaimAt = at;
    return 'reclaimed';
  } catch (error) {
    recordRuntimeIssue('opencode-retention:vacuum', error);
    return 'failed';
  }
}

export interface RetentionRunResult {
  skipped?: 'disabled' | 'protected-ids-unavailable' | 'query-failed';
  reclaim?: ReclaimOutcome;
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
  const summary = result({ candidates: toDelete.length, deleted, failed, reclaim });
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

/** 實際的 opencode CLI 與綁定狀態檔；isIdle 由掛載的服務提供。 */
export function createOpencodeRetentionDeps(isIdle: () => boolean): RetentionDeps {
  return {
    isIdle,
    readSpaceStats: async () => {
      const { stdout } = await runProcess(
        'opencode',
        [
          'db',
          '--format',
          'json',
          'select * from pragma_page_count(), pragma_freelist_count(), pragma_page_size()'
        ],
        { timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS }
      );
      return parseSpaceStats(stdout);
    },
    vacuum: async () => {
      await runProcess('opencode', ['db', 'VACUUM'], { timeoutMs: VACUUM_TIMEOUT_MS });
    },
    queryCandidates: async (limit) => {
      const sql =
        'select id, time_updated, parent_id from session where parent_id is null ' +
        `order by time_updated asc limit ${Math.max(1, Math.floor(limit))}`;
      const { stdout } = await runProcess('opencode', ['db', '--format', 'json', sql], {
        timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS
      });
      return parseCandidateRows(stdout);
    },
    deleteSession: async (id) => {
      await runProcess('opencode', ['session', 'delete', id], {
        timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS
      });
    },
    readProtectedIds: () => readBoundSessionIds()
  };
}
