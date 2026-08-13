/**
 * 統一錯誤處理與 runtime issue 追蹤
 */
import { emitEvent } from '../services/event-bus.js';

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

  // 反向掃描能提前 break,前提是 recentIssues 依 timestamp 遞增排列。命中 dedupe 時會就地把
  // timestamp 改寫成現在,若該筆留在原位陣列就不再有序:它後方可能有更舊的項目,下一次掃描會
  // 在那裡誤判「已超出視窗」而 break,掃不到其實仍在視窗內的同類項,於是重複發出 runtime_issue
  // 事件——而每一個這種事件都會再觸發一輪完整的 context snapshot。
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
      // 命中後把該筆移到尾端,維持「陣列依 timestamp 遞增」的不變式(見上方註解)。
      if (i !== recentIssues.length - 1) {
        recentIssues.splice(i, 1);
        recentIssues.push(issue);
      }
      return;
    }
  }

  const entry: RuntimeIssue = { timestamp, scope, message, count: 1 };
  if (requestId) {
    entry.requestId = requestId;
  }
  recentIssues.push(entry);
  emitEvent('runtime_issue', {
    scope,
    message,
    ...(requestId ? { requestId } : {})
  });
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
