/**
 * 把每次聊天召回的結果寫進 moltbot.db，讓召回指標跨重啟累積、依版本比較（issue 0020）。
 * 仿照 issue-store：訂閱 hook 寫入，定期清掉超過保留期的資料。
 */
import type { MemoryManager } from '../core/memory.js';
import { addMemoriaRecallTraceHook, isDegradedRoute } from './memoria-recall-telemetry.js';

const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RECALL_METRICS_RETENTION_DAYS = 30;
const RETENTION_MS = RECALL_METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function startRecallMetricsStore(
  memory: MemoryManager,
  options: { appVersion: string }
): { stop: () => void } {
  const unsubscribe = addMemoriaRecallTraceHook((trace) => {
    try {
      memory.appendMemoriaRecallEvent({
        ts: trace.timestamp,
        appVersion: options.appVersion,
        scopeKind: trace.scopeKind,
        ok: trace.ok,
        routeMode: trace.routeMode,
        hitCount: trace.hitCount,
        droppedLowConfidence: trace.droppedLowConfidence,
        injected: trace.injected,
        degraded: isDegradedRoute(trace.routeMode),
        latencyMs: trace.latencyMs
      });
    } catch (err) {
      // 每則聊天訊息都會走到這裡；記 runtime issue 會洗版，只印 warn
      console.warn('[recall-metrics] failed to persist recall event:', err);
    }
  });

  const purge = (): void => {
    try {
      const removed = memory.purgeOldMemoriaRecallEvents(Date.now() - RETENTION_MS);
      if (removed > 0) {
        console.log(
          `[recall-metrics] purged ${removed} recall events older than ${RECALL_METRICS_RETENTION_DAYS} days`
        );
      }
    } catch (err) {
      console.warn('[recall-metrics] purge failed:', err);
    }
  };
  purge();
  const purgeTimer = setInterval(purge, PURGE_INTERVAL_MS);
  purgeTimer.unref?.();

  return {
    stop() {
      unsubscribe();
      clearInterval(purgeTimer);
    }
  };
}
