import type { MemoryIntent } from '../core/memory-intent.js';

export type MemoryIntentTrace = {
  requestId: string;
  timestamp: number;
  userId: string;
  channel: string;
  promptMode: string;
  intent: MemoryIntent;
};

const MAX_TRACES = 50;
const traces: MemoryIntentTrace[] = [];

export function recordMemoryIntentTrace(trace: MemoryIntentTrace): void {
  traces.push(trace);
  if (traces.length > MAX_TRACES) {
    traces.splice(0, traces.length - MAX_TRACES);
  }
}

export function getRecentMemoryIntentTraces(limit: number = 10): MemoryIntentTrace[] {
  const safeLimit = Math.max(1, Math.min(50, limit));
  return traces.slice(-safeLimit);
}

export function clearMemoryIntentTraces(): void {
  traces.splice(0, traces.length);
}

export function formatMemoryIntentTraceMarkdown(limit: number = 10): string {
  const items = getRecentMemoryIntentTraces(limit);
  const now = new Date();
  const levelCount = new Map<string, number>();

  for (const item of items) {
    levelCount.set(item.intent.level, (levelCount.get(item.intent.level) || 0) + 1);
  }

  const levelLines = Array.from(levelCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([level, count]) => `- ${level}: ${count}`);
  const recentLines = items
    .slice()
    .reverse()
    .map(
      (item) =>
        `- [${new Date(item.timestamp).toLocaleString('zh-TW')}] req=${item.requestId} channel=${item.channel} mode=${item.promptMode} level=${item.intent.level} confidence=${item.intent.confidence} reason=${item.intent.reason}`
    );

  return [
    '# Memory Intent Status',
    '',
    `- Updated: ${now.toLocaleString('zh-TW')}`,
    `- Sample Count: ${items.length}`,
    '',
    '## Intent Level Distribution',
    ...(levelLines.length > 0 ? levelLines : ['- (none)']),
    '',
    '## Recent Memory Intents',
    ...(recentLines.length > 0 ? recentLines : ['- (none)'])
  ].join('\n');
}
