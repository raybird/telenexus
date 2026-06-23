/**
 * 共用的 Opencode JSON event 解譯邏輯。
 * stream 路徑每收到一行呼叫一次；non-stream 路徑全部行跑完再各自呼叫一次。
 * 兩條路徑共用同一份 dispatch table，避免 event schema 漂移。
 */

export type OpencodeEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    tool?: string;
    text?: string;
    tokens?: unknown;
    cost?: unknown;
    reason?: unknown;
    state?: {
      input?: unknown;
      title?: string;
    };
  };
};

export type InterpretedEvent = {
  /** session 識別碼（若有） */
  sessionId?: string;
  /** 本行 text 事件帶來的文字片段 */
  text?: string;
  /** 本行 reasoning 事件帶來的思考（thinking）文字片段 */
  reasoningText?: string;
  /** UI 狀態提示文字（主要供串流用） */
  statusText?: string;
  /** 是否要 emit start（僅串流用） */
  emitStart?: boolean;
  /** step_finish 帶來的 stats（tokens / cost / reason） */
  stats?: Record<string, unknown>;
};

function truncateStatusValue(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function getToolTarget(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const values = input as Record<string, unknown>;
  const candidate =
    values.filePath ??
    values.path ??
    values.pattern ??
    values.command ??
    values.query ??
    values.name;
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? truncateStatusValue(candidate)
    : null;
}

export function formatToolStatus(tool: string | undefined, input: unknown): string | null {
  const target = getToolTarget(input);
  const suffix = target ? `：${target}` : '';

  switch (tool) {
    case 'grep':
      return `🔍 搜尋專案${suffix}`;
    case 'glob':
      return `📁 掃描檔案${suffix}`;
    case 'read':
      return `📖 讀取${suffix}`;
    case 'bash':
      return `💻 執行指令${suffix}`;
    case 'skill':
      return `🧩 載入技能${suffix}`;
    case 'edit':
    case 'write':
      return `✏️ 編輯${suffix}`;
    case 'webfetch':
    case 'fetch':
      return `🌐 抓取網頁${suffix}`;
    case undefined:
      return null;
    default:
      return `⚙️ 使用工具 ${tool}${suffix}`;
  }
}

/**
 * 解譯一筆 OpencodeEvent。
 * 兩條路徑（stream/non-stream）共用此函式，確保行為一致。
 */
export function interpretEvent(event: OpencodeEvent): InterpretedEvent {
  const out: InterpretedEvent = {};

  if (typeof event.sessionID === 'string' && event.sessionID.trim().length > 0) {
    out.sessionId = event.sessionID;
  }

  if (event.type === 'step_start') {
    out.emitStart = true;
    out.statusText = '開始處理請求...';
  }

  if (event.type === 'tool_use') {
    const toolStatus = formatToolStatus(event.part?.tool, event.part?.state?.input);
    if (toolStatus) {
      out.statusText = toolStatus;
    }
  }

  if (event.type === 'text' && typeof event.part?.text === 'string') {
    out.text = event.part.text;
  }

  if (event.type === 'reasoning' && typeof event.part?.text === 'string') {
    out.reasoningText = event.part.text;
  }

  if (event.type === 'step_finish' && event.part) {
    if (event.part.reason === 'tool-calls') {
      out.statusText = '工具執行完成，等待模型整理回覆...';
    }
    const nextStats: Record<string, unknown> = {};
    if (event.part.tokens !== undefined) nextStats.tokens = event.part.tokens;
    if (event.part.cost !== undefined) nextStats.cost = event.part.cost;
    if (event.part.reason !== undefined) nextStats.reason = event.part.reason;
    if (Object.keys(nextStats).length > 0) {
      out.stats = nextStats;
    }
  }

  return out;
}

/**
 * 嘗試 parse 單行 JSON。非 `{` 開頭或 parse 失敗回 null。
 */
export function parseEventLine(line: string): OpencodeEvent | null {
  if (!line.startsWith('{')) {
    return null;
  }
  try {
    return JSON.parse(line) as OpencodeEvent;
  } catch {
    return null;
  }
}
