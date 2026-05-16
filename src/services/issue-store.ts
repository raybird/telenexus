/**
 * 將 runtime issue 事件同步寫入 SQLite，並提供查詢 API 給 context snapshots 使用。
 */
import type { MemoryManager } from '../core/memory.js';
import { addIssueHook } from '../utils/errors.js';

const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function startIssueStore(memory: MemoryManager): { stop: () => void } {
  const unsubscribe = addIssueHook(({ scope, message, timestamp }) => {
    try {
      memory.appendRuntimeIssue(scope, message, timestamp);
    } catch (err) {
      console.error('[issue-store] failed to persist runtime issue:', err);
    }
  });

  const purgeTimer = setInterval(() => {
    try {
      const removed = memory.purgeOldRuntimeIssues(Date.now() - RETENTION_MS);
      if (removed > 0) {
        console.log(`[issue-store] purged ${removed} runtime_issues rows older than 7 days`);
      }
    } catch (err) {
      console.error('[issue-store] purge failed:', err);
    }
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref?.();

  console.log('[IssueStore] enabled. retention=7d');

  return {
    stop() {
      unsubscribe();
      clearInterval(purgeTimer);
    }
  };
}
