import { writeSync } from 'node:fs';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.message;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(
  level: LogLevel,
  scope: string,
  event: string,
  fields?: Record<string, unknown>
): void {
  const parts = [`[${scope}]`, level.toUpperCase(), event];
  if (fields) {
    // requestId 優先排在 event 之後，方便跨服務跨檔案 trace
    const requestId = fields.requestId;
    if (typeof requestId === 'string' && requestId.length > 0) {
      parts.push(`req=${requestId}`);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'requestId') continue;
      if (value === undefined) continue;
      parts.push(`${key}=${formatValue(value)}`);
    }
  }

  const line = parts.join(' ') + '\n';
  // fs.writeSync 直接寫 fd，繞過 Node.js stream 緩衝
  // 避免 pipe 模式下 Docker 看不到 log 的問題
  const fd = level === 'warn' || level === 'error' ? 2 : 1;
  writeSync(fd, line);
}

export function createLogger(scope: string) {
  return {
    info(event: string, fields?: Record<string, unknown>) {
      emit('info', scope, event, fields);
    },
    warn(event: string, fields?: Record<string, unknown>) {
      emit('warn', scope, event, fields);
    },
    error(event: string, fields?: Record<string, unknown>) {
      emit('error', scope, event, fields);
    },
    debug(event: string, fields?: Record<string, unknown>) {
      emit('debug', scope, event, fields);
    }
  };
}
