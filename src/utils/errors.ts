/**
 * 統一錯誤處理與 runtime issue 追蹤
 */

export type RuntimeIssue = {
  timestamp: number;
  scope: string;
  message: string;
  count: number;
  requestId?: string;
};

const RECENT_ISSUE_LIMIT = 20;
const ISSUE_DEDUPE_WINDOW_MS = 60_000;
const recentIssues: RuntimeIssue[] = [];

export type IssueEvent = {
  scope: string;
  message: string;
  timestamp: number;
  requestId?: string;
};
export type IssueHook = (issue: IssueEvent) => void;
export type IssueContext = { requestId?: string };
const issueHooks = new Set<IssueHook>();

/** 註冊 issue 監聽器（alerter / persistence 各一個）。回傳 unsubscribe 函式。 */
export function addIssueHook(hook: IssueHook): () => void {
  issueHooks.add(hook);
  return () => {
    issueHooks.delete(hook);
  };
}

/** 舊 API：直接替換唯一 hook。傳 null 清空所有。保留以向下相容。 */
export function setIssueHook(hook: IssueHook | null): void {
  issueHooks.clear();
  if (hook) issueHooks.add(hook);
}

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

export function recordRuntimeIssue(
  scope: string,
  error: unknown,
  context: IssueContext = {}
): void {
  const timestamp = Date.now();
  const message = toErrorMessage(error);
  const requestId = context.requestId;
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
      if (requestId) {
        issue.requestId = requestId;
      }
      return;
    }
  }

  const entry: RuntimeIssue = { timestamp, scope, message, count: 1 };
  if (requestId) {
    entry.requestId = requestId;
  }
  recentIssues.push(entry);
  if (recentIssues.length > RECENT_ISSUE_LIMIT) {
    recentIssues.splice(0, recentIssues.length - RECENT_ISSUE_LIMIT);
  }
  for (const hook of issueHooks) {
    try {
      const payload: IssueEvent = { scope, message, timestamp };
      if (requestId) {
        payload.requestId = requestId;
      }
      hook(payload);
    } catch (hookError) {
      console.error('[errors] issue hook failed:', hookError);
    }
  }
}

export function getRecentIssues(): readonly RuntimeIssue[] {
  return recentIssues;
}
