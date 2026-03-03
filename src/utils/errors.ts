/**
 * 統一錯誤處理與 runtime issue 追蹤
 */

export type RuntimeIssue = {
  timestamp: number;
  scope: string;
  message: string;
};

const RECENT_ISSUE_LIMIT = 20;
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
  recentIssues.push({
    timestamp: Date.now(),
    scope,
    message: toErrorMessage(error)
  });
  if (recentIssues.length > RECENT_ISSUE_LIMIT) {
    recentIssues.splice(0, recentIssues.length - RECENT_ISSUE_LIMIT);
  }
}

export function getRecentIssues(): readonly RuntimeIssue[] {
  return recentIssues;
}
