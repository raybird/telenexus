/**
 * 共用的 Opencode JSON event 解譯邏輯。
 * stream 路徑每收到一行呼叫一次；non-stream 路徑全部行跑完再各自呼叫一次。
 * 兩條路徑共用同一份 dispatch table，避免 event schema 漂移。
 */

import type { UpstreamError } from './rate-limit.js';

export type OpencodeEvent = {
  type?: string;
  sessionID?: string;
  /** `type: 'error'` 事件的內容;上游 API 錯誤時 `data` 帶 `statusCode`。 */
  error?: {
    name?: unknown;
    data?: {
      message?: unknown;
      statusCode?: unknown;
    };
  };
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
  /**
   * error 事件帶來的上游錯誤。它是回合的結果(這個回合失敗了),不是可渲染的內容,
   * 所以只回資訊、不產生 text 或 statusText。
   */
  upstreamError?: UpstreamError;
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
 * 只依事件的型別與欄位判定,不比對任何文字 —— 模型的回覆裡出現「426」或「error」
 * 是 text 事件,走不到這裡。
 */
function toUpstreamError(error: OpencodeEvent['error']): UpstreamError {
  const message = error?.data?.message;
  const statusCode = error?.data?.statusCode;
  const out: UpstreamError = {
    message: typeof message === 'string' && message.trim() ? message : '(opencode 沒有提供錯誤訊息)'
  };
  if (typeof statusCode === 'number' && Number.isInteger(statusCode)) {
    out.statusCode = statusCode;
  }
  if (typeof error?.name === 'string' && error.name) {
    out.name = error.name;
  }
  return out;
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

  if (event.type === 'error') {
    out.upstreamError = toUpstreamError(event.error);
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

/**
 * 掃出 stdout 裡的上游錯誤,連同它之前已經產出的文字。
 *
 * 容忍非 JSON 行與沒有文字的輸出:只有一個 error 事件的回合正是這種形狀。
 * 非串流回合與模型健康檢查的探針共用。
 */
export function findUpstreamError(
  stdout: string
): { upstreamError: UpstreamError; text: string; sessionId?: string } | null {
  let upstreamError: UpstreamError | undefined;
  let sessionId: string | undefined;
  let text = '';

  for (const line of stdout.split(/\r?\n/)) {
    const event = parseEventLine(line.trim());
    if (!event) {
      continue;
    }
    const interpreted = interpretEvent(event);
    if (interpreted.sessionId) sessionId = interpreted.sessionId;
    if (interpreted.text) text += interpreted.text;
    if (interpreted.upstreamError) upstreamError = interpreted.upstreamError;
  }

  if (!upstreamError) {
    return null;
  }
  return { upstreamError, text, ...(sessionId ? { sessionId } : {}) };
}
