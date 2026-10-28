/**
 * 釘選狀態訊息的資料來源（issue 0021）。
 */
import type { MemoryManager } from '../core/memory.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('pinned-status');

const RECENT_ERRORS_WINDOW_MS = 24 * 60 * 60 * 1000;

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
