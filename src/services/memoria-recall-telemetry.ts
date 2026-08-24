/**
 * Memoria recall 遙測：把 /v1/recall 回應 meta 的路由與信心基準留成可觀測軌跡。
 *
 * 存在理由：Memoria 在語意索引不可用時會「靜默」退回字面召回（route_mode
 * vector_unavailable / vector_timeout）——回應長得跟正常一模一樣，只有 meta 說得出真相。
 * 不記下來，我們對召回品質就是全盲的。
 */

export type MemoriaRecallTrace = {
  timestamp: number;
  ok: boolean;
  /** meta.route_mode；請求失敗時為 'error'，欄位缺席時為 'unknown'。 */
  routeMode: string;
  fallbackUsed: boolean;
  /** meta.confidence：null 代表該路由「無法判斷」匹配品質，與 0（判斷過、很差）不同。 */
  confidence: number | null;
  /** meta.confidence_basis：lexical_coverage / unavailable / no_hits。 */
  confidenceBasis: string;
  hitCount: number;
  latencyMs: number;
};

/** 語意索引服務不了、實際端出字面結果的路由——這是唯一該當成警訊的降級。 */
const DEGRADED_ROUTE_MODES = new Set(['vector_unavailable', 'vector_timeout']);

export function isDegradedRoute(routeMode: string): boolean {
  return DEGRADED_ROUTE_MODES.has(routeMode);
}

const MAX_TRACES = 50;
const traces: MemoriaRecallTrace[] = [];

export function recordMemoriaRecallTrace(trace: MemoriaRecallTrace): void {
  traces.push(trace);
  if (traces.length > MAX_TRACES) {
    traces.splice(0, traces.length - MAX_TRACES);
  }
}

export function getRecentMemoriaRecallTraces(limit: number = 10): MemoriaRecallTrace[] {
  const safeLimit = Math.max(1, Math.min(MAX_TRACES, limit));
  return traces.slice(-safeLimit);
}

export function clearMemoriaRecallTraces(): void {
  traces.splice(0, traces.length);
}

function countBy(items: MemoriaRecallTrace[], pick: (t: MemoriaRecallTrace) => string): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = pick(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `- ${key}: ${count}`);
}

/** 產生要併進 memoria-status.md 的 recall 遙測區塊。 */
export function formatMemoriaRecallTelemetryMarkdown(limit: number = 10): string {
  const items = getRecentMemoriaRecallTraces(MAX_TRACES);
  if (items.length === 0) {
    return ['## Recall Telemetry', '', '- Sample Count: 0（尚未有 recall 請求）'].join('\n');
  }

  const okCount = items.filter((t) => t.ok).length;
  const degradedCount = items.filter((t) => isDegradedRoute(t.routeMode)).length;
  const latencyTotal = items.reduce((sum, t) => sum + t.latencyMs, 0);
  const hitTotal = items.reduce((sum, t) => sum + t.hitCount, 0);
  // 只有 lexical_coverage 的 confidence 可跨次比較（issue-9）；其餘納入平均只會製造假數字。
  const comparable = items.filter(
    (t) => t.confidenceBasis === 'lexical_coverage' && typeof t.confidence === 'number'
  );
  const avgConfidence =
    comparable.length > 0
      ? (comparable.reduce((sum, t) => sum + (t.confidence ?? 0), 0) / comparable.length).toFixed(3)
      : '(n/a)';

  const recentLines = items
    .slice(-Math.max(1, Math.min(MAX_TRACES, limit)))
    .reverse()
    .map((t) => {
      const conf = t.confidence === null ? 'null' : t.confidence.toFixed(3);
      const flag = isDegradedRoute(t.routeMode) ? ' DEGRADED' : '';
      return `- [${new Date(t.timestamp).toLocaleString('zh-TW')}] route=${t.routeMode} basis=${t.confidenceBasis} conf=${conf} fallback=${t.fallbackUsed} hits=${t.hitCount} latency=${t.latencyMs}ms${flag}`;
    });

  return [
    '## Recall Telemetry',
    '',
    `- Sample Count: ${items.length}`,
    `- Success / Failed: ${okCount} / ${items.length - okCount}`,
    `- Degraded (語意索引退回字面): ${degradedCount}`,
    `- Avg Latency: ${Math.round(latencyTotal / items.length)}ms`,
    `- Avg Hits: ${(hitTotal / items.length).toFixed(1)}`,
    `- Avg Confidence (僅 lexical_coverage，n=${comparable.length}): ${avgConfidence}`,
    '',
    '### Route Mode Distribution',
    ...countBy(items, (t) => t.routeMode),
    '',
    '### Confidence Basis Distribution',
    ...countBy(items, (t) => t.confidenceBasis),
    '',
    `### Recent Recalls (last ${recentLines.length})`,
    ...recentLines
  ].join('\n');
}
