/**
 * 釘選狀態訊息的資料來源（issue 0021）。
 */
import type { MemoryManager } from '../core/memory.js';
import { createLogger } from '../core/logger.js';
import { addEventHook } from './event-bus.js';
import type { PinnedSnapshot } from './pinned-status-manager.js';

const log = createLogger('pinned-status');

const RECENT_ERRORS_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPDATE_EVENTS = new Set(['request_done', 'request_error', 'schedule_fire', 'runtime_issue']);

export type PinnedStatusSources = {
  model: () => string;
  activeSchedules: () => number;
  memorySize: () => number;
  recentErrors: () => number | null;
};

type PinnedStatusTarget = {
  initialize(snapshot: PinnedSnapshot): Promise<void>;
  update(snapshot: PinnedSnapshot): Promise<void>;
};

/**
 * 最近 24 小時 runtime_issues 的列數，和 error-summary.md「Past 24h by Scope (persisted)」
 * 是同一個查詢，兩處數字對得起來。讀不到時回傳 null，由釘選訊息顯示 unknown。
 */
export function countRecentErrors(
  memory: Pick<MemoryManager, 'countIssuesByScope'>,
  now: number = Date.now()
): number | null {
  try {
    return memory
      .countIssuesByScope(now - RECENT_ERRORS_WINDOW_MS)
      .reduce((sum, row) => sum + row.count, 0);
  } catch (err) {
    log.warn('recent_errors_unavailable', { err });
    return null;
  }
}

/**
 * 送出釘選訊息，並在事件發生時更新；`refresh()` 給定期計時器呼叫，讓過期的錯誤離開計數。
 */
export async function startPinnedStatus(
  manager: PinnedStatusTarget,
  sources: PinnedStatusSources
): Promise<{ refresh: () => void; stop: () => void }> {
  let lastRequestAt: number | undefined;
  let lastErrors = sources.recentErrors();
  const snapshot = (recentErrors: number | null): PinnedSnapshot => ({
    model: sources.model(),
    activeSchedules: sources.activeSchedules(),
    recentErrors,
    memorySize: sources.memorySize(),
    ...(lastRequestAt !== undefined ? { lastRequestAt } : {})
  });
  const send = (recentErrors: number | null) => {
    const next = snapshot(recentErrors);
    lastErrors = recentErrors;
    manager.update(next).catch((err: unknown) => log.warn('update_failed', { err }));
  };
  // 事件 microtask 與定期計時器裡 throw 會變成 uncaught exception，在這裡接住
  const guarded = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log.warn('update_failed', { err });
    }
  };

  await manager.initialize(snapshot(lastErrors));

  const stop = addEventHook((type) => {
    if (!UPDATE_EVENTS.has(type)) return;
    // recordRuntimeIssue 先發 runtime_issue 事件，再由 IssueStore 的 hook 寫進資料庫。
    // 等這一輪同步程式跑完再計算，計數才包含剛發生的這一筆。
    queueMicrotask(() =>
      guarded(() => {
        lastRequestAt = Date.now();
        send(sources.recentErrors());
      })
    );
  });

  return {
    // 只在數字改變時更新：Last request 的分鐘數每分鐘都在變，照送會讓閒置時每分鐘編輯一次訊息
    refresh() {
      guarded(() => {
        const recentErrors = sources.recentErrors();
        if (recentErrors !== lastErrors) send(recentErrors);
      });
    },
    stop
  };
}
