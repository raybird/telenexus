/**
 * 輕量事件匯流排：同步 emit → append-only NDJSON + in-process 訂閱。
 * 兩個 Docker 服務（telenexus / agent-runner）各自持有獨立 hooks，但共寫同一個 events.jsonl。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveContextDir } from '../utils/paths.js';

export type EventBusPayload = Record<string, unknown>;
type EventHook = (type: string, payload: EventBusPayload) => void;

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const hooks = new Set<EventHook>();
let currentDateStr = todayStr();

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveEventsPath(): string {
  return path.join(resolveContextDir(), 'events.jsonl');
}

function purgeOldFiles(dir: string): void {
  const cutoff = Date.now() - RETENTION_MS;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!/^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)) continue;
      const fullPath = path.join(dir, entry);
      try {
        if (fs.statSync(fullPath).mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
        }
      } catch {
        // best-effort
      }
    }
  } catch {
    // dir may not exist yet
  }
}

function checkAndRotate(): void {
  const today = todayStr();
  if (today === currentDateStr) return;

  const eventsPath = resolveEventsPath();
  const dir = path.dirname(eventsPath);
  const rotated = path.join(dir, `events-${currentDateStr}.jsonl`);

  try {
    if (fs.existsSync(eventsPath)) {
      fs.renameSync(eventsPath, rotated);
    }
  } catch {
    // best-effort; two processes racing to rotate is acceptable
  }

  currentDateStr = today;
  purgeOldFiles(dir);
}

export function emitEvent(type: string, payload: EventBusPayload = {}): void {
  checkAndRotate();

  const line = JSON.stringify({ ts: Date.now(), type, ...payload });
  const eventsPath = resolveEventsPath();

  try {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(eventsPath, line + '\n', 'utf8');
  } catch {
    // best-effort
  }

  for (const hook of hooks) {
    try {
      hook(type, payload);
    } catch {
      // hooks must not throw
    }
  }
}

/** 訂閱 in-process 事件（接收所有 type）。回傳 unsubscribe 函式。 */
export function addEventHook(handler: EventHook): () => void {
  hooks.add(handler);
  return () => hooks.delete(handler);
}
