/**
 * 每位使用者的聊天 session 綁定。
 *
 * opencode 的 `-c` 接續「最後被更新的 session」，排程、摘要與健康探針都會搶走它（issue 0012），
 * 所以聊天改以 `-s <id>` 接續自己記住的 session。只有 telenexus 寫入這個檔案；opencode session
 * 保留期清理（issue 0009）會唯讀讀取它。
 */
import fs from 'fs';
import path from 'path';
import { recordRuntimeIssue } from '../utils/errors.js';
import { resolveDataDir } from '../utils/paths.js';

export function resolveChatSessionStatePath(): string {
  return path.join(resolveDataDir(), 'chat-session-state.json');
}

/** 狀態檔不存在代表沒有綁定；讀不到或毀損時拋出，由呼叫端決定怎麼處理。 */
function loadBindings(statePath: string): Map<string, string> {
  const bindings = new Map<string, string>();
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return bindings;
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('chat session state is not an object');
  }
  for (const [userId, sessionId] of Object.entries(parsed)) {
    if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
      bindings.set(userId, sessionId);
    }
  }
  return bindings;
}

function readBindings(statePath: string): Map<string, string> {
  try {
    return loadBindings(statePath);
  } catch (error) {
    // 毀損時當作沒有綁定：下一則聊天開新 session，不讓整個服務起不來。
    recordRuntimeIssue('chat-session:state-read', error);
    return new Map();
  }
}

/**
 * 唯讀取得目前所有綁定中的 session id，供 opencode session 保留期清理保護它們（issue 0009）。
 * 與聊天端相反，毀損時要拋出：當成沒有綁定的話，清理會把聊天正在用的 session 刪掉。
 */
export function readBoundSessionIds(
  statePath: string = resolveChatSessionStatePath()
): Set<string> {
  return new Set(loadBindings(statePath).values());
}

export class ChatSessionStore {
  private readonly bindings: Map<string, string>;

  constructor(private readonly statePath: string = resolveChatSessionStatePath()) {
    this.bindings = readBindings(statePath);
  }

  get(userId: string): string | undefined {
    return this.bindings.get(userId);
  }

  set(userId: string, sessionId: string): void {
    // 接續同一個 session 是常態,值沒變就不重寫檔案。
    if (this.bindings.get(userId) === sessionId) return;
    this.bindings.set(userId, sessionId);
    this.persist();
  }

  clear(userId: string): void {
    if (this.bindings.delete(userId)) {
      this.persist();
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(Object.fromEntries(this.bindings), null, 2),
        'utf8'
      );
    } catch (error) {
      // 記憶體內的綁定仍有效；只是重啟後會遺失，下一則聊天改開新 session。
      recordRuntimeIssue('chat-session:state-write', error);
    }
  }
}
