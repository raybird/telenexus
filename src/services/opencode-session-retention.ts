/**
 * opencode session 的保留期清理（issue 0009）。
 *
 * opencode 把每次執行的對話與工具輸出存進 opencode.db 且從不清理；TeleNexus 自己另存對話紀錄，
 * 不會回頭讀舊的 opencode session，所以超過保留期的 session 可以刪除。
 */

/** 挑選用的 session 摘要，來自 `opencode db` 查詢的 `id`、`time_updated`、`parent_id`。 */
export interface RetentionCandidate {
  id: string;
  /** 最後更新時間（毫秒）。缺漏或無法解析時為 null。 */
  updatedAt: number | null;
  parentId: string | null;
}

export interface SelectSessionsInput {
  sessions: readonly RetentionCandidate[];
  /** 綁定中的聊天 session，不論多舊都保留。 */
  protectedIds: ReadonlySet<string>;
  now: number;
  retentionDays: number;
  limit: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 以最後更新時間判斷過期，不看建立時間：長期沿用的聊天 session 建立得早但一直在更新。
 * 子 session 不單獨選，`opencode session delete` 刪父 session 時會一併刪掉它們。
 */
export function selectSessionsToDelete(input: SelectSessionsInput): string[] {
  const cutoff = input.now - input.retentionDays * DAY_MS;
  return input.sessions
    .filter(
      (session): session is RetentionCandidate & { updatedAt: number } =>
        session.parentId === null &&
        !input.protectedIds.has(session.id) &&
        Number.isFinite(session.updatedAt) &&
        (session.updatedAt as number) < cutoff
    )
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, input.limit)
    .map((session) => session.id);
}
