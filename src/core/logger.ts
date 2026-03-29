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
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(`${key}=${formatValue(value)}`);
    }
  }

  const line = parts.join(' ');
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  if (level === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
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
