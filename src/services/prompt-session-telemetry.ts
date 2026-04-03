import type { PromptMode } from '../core/prompt-build.js';

export type PromptSessionTrace = {
  requestId: string;
  timestamp: number;
  channel: string;
  userId: string;
  executionMode: 'local' | 'runner';
  promptMode: PromptMode | 'passthrough';
  promptSelectionReason: string;
  promptLength: number;
  memoryContextLength: number;
  memoryContextSectionCount: number;
  usedMemoryContext: boolean;
  forceNewSession: boolean;
  isPassthroughCommand: boolean;
  durationMs: number;
  responseLength?: number;
  ok: boolean;
};

const MAX_TRACES = 50;
const traces: PromptSessionTrace[] = [];

export function recordPromptSessionTrace(trace: PromptSessionTrace): void {
  traces.push(trace);
  if (traces.length > MAX_TRACES) {
    traces.splice(0, traces.length - MAX_TRACES);
  }
}

export function getRecentPromptSessionTraces(limit: number = 10): PromptSessionTrace[] {
  const safeLimit = Math.max(1, Math.min(50, limit));
  return traces.slice(-safeLimit);
}

export function clearPromptSessionTraces(): void {
  traces.splice(0, traces.length);
}

export function formatPromptSessionTraceMarkdown(limit: number = 10): string {
  const items = getRecentPromptSessionTraces(limit);
  const now = new Date();
  const modeCount = new Map<string, number>();
  let totalPromptLength = 0;
  let totalMemoryContextLength = 0;

  for (const item of items) {
    modeCount.set(item.promptMode, (modeCount.get(item.promptMode) || 0) + 1);
    totalPromptLength += item.promptLength;
    totalMemoryContextLength += item.memoryContextLength;
  }

  const modeLines = Array.from(modeCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([mode, count]) => `- ${mode}: ${count}`);
  const avgPromptLength = items.length > 0 ? Math.round(totalPromptLength / items.length) : 0;
  const avgMemoryLength =
    items.length > 0 ? Math.round(totalMemoryContextLength / items.length) : 0;
  const recentLines = items
    .slice()
    .reverse()
    .map((item) => {
      const status = item.ok ? 'ok' : 'error';
      return `- [${new Date(item.timestamp).toLocaleString('zh-TW')}] req=${item.requestId} channel=${item.channel} exec=${item.executionMode} mode=${item.promptMode} reason=${item.promptSelectionReason} prompt=${item.promptLength} memory=${item.memoryContextLength} sections=${item.memoryContextSectionCount} duration=${item.durationMs}ms status=${status}`;
    });

  return [
    '# Prompt Session Status',
    '',
    `- Updated: ${now.toLocaleString('zh-TW')}`,
    `- Sample Count: ${items.length}`,
    `- Avg Prompt Length: ${avgPromptLength}`,
    `- Avg Memory Context Length: ${avgMemoryLength}`,
    '',
    '## Prompt Mode Distribution',
    ...(modeLines.length > 0 ? modeLines : ['- (none)']),
    '',
    '## Recent Requests',
    ...(recentLines.length > 0 ? recentLines : ['- (none)'])
  ].join('\n');
}
