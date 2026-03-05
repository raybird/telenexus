/**
 * 統一錯誤處理與 runtime issue 追蹤
 */

export type RuntimeIssue = {
  timestamp: number;
  scope: string;
  message: string;
  count: number;
};

const RECENT_ISSUE_LIMIT = 20;
const ISSUE_DEDUPE_WINDOW_MS = 60_000;
const recentIssues: RuntimeIssue[] = [];

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function recordRuntimeIssue(scope: string, error: unknown): void {
  const timestamp = Date.now();
  const message = toErrorMessage(error);
  const dedupeKey = `${scope}\u0000${message}`;

  for (let i = recentIssues.length - 1; i >= 0; i -= 1) {
    const issue = recentIssues[i]!;
    if (timestamp - issue.timestamp > ISSUE_DEDUPE_WINDOW_MS) {
      break;
    }
    const issueKey = `${issue.scope}\u0000${issue.message}`;
    if (issueKey === dedupeKey) {
      issue.timestamp = timestamp;
      issue.count += 1;
      return;
    }
  }

  recentIssues.push({
    timestamp,
    scope,
    message,
    count: 1
  });
  if (recentIssues.length > RECENT_ISSUE_LIMIT) {
    recentIssues.splice(0, recentIssues.length - RECENT_ISSUE_LIMIT);
  }
}

export function getRecentIssues(): readonly RuntimeIssue[] {
  return recentIssues;
}
