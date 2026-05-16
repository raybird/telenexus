/**
 * 錯誤模式告警器：訂閱 recordRuntimeIssue → 同 scope 在視窗內超過閾值就推送 Telegram。
 */
import type { Connector } from '../types/index.js';
import { addIssueHook, type IssueHook } from '../utils/errors.js';

type ScopeWindow = {
  timestamps: number[];
  lastAlertedAt: number;
  lastMessage: string;
};

export type ErrorAlerterOptions = {
  connector: Connector;
  adminUserId: string;
  threshold?: number;
  windowMs?: number;
  cooldownMs?: number;
};

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function readNumberEnv(key: string, fallback: number, min = 1): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

export function startErrorAlerter(options: ErrorAlerterOptions): { stop: () => void } {
  const threshold = options.threshold ?? readNumberEnv('ERROR_ALERT_THRESHOLD', DEFAULT_THRESHOLD);
  const windowMs = options.windowMs ?? readNumberEnv('ERROR_ALERT_WINDOW_MS', DEFAULT_WINDOW_MS, 1000);
  const cooldownMs =
    options.cooldownMs ?? readNumberEnv('ERROR_ALERT_COOLDOWN_MS', DEFAULT_COOLDOWN_MS, 1000);

  const windows = new Map<string, ScopeWindow>();

  const hook: IssueHook = ({ scope, message, timestamp }) => {
    const window = windows.get(scope) ?? { timestamps: [], lastAlertedAt: 0, lastMessage: '' };
    const cutoff = timestamp - windowMs;
    window.timestamps = window.timestamps.filter((ts) => ts >= cutoff);
    window.timestamps.push(timestamp);
    window.lastMessage = message;
    windows.set(scope, window);

    if (window.timestamps.length < threshold) return;
    if (timestamp - window.lastAlertedAt < cooldownMs) return;

    window.lastAlertedAt = timestamp;
    const count = window.timestamps.length;
    const truncated = message.length > 240 ? `${message.slice(0, 240)}...` : message;
    const minutes = Math.round(windowMs / 60000);
    const text =
      `🚨 系統錯誤異常頻繁\n` +
      `Scope: ${scope}\n` +
      `最近 ${minutes} 分內 ${count} 次\n` +
      `最後一次：${truncated}\n` +
      `請檢查 workspace/context/error-summary.md`;

    void options.connector.sendMessage(options.adminUserId, text).catch((err) => {
      console.error('[error-alerter] failed to send Telegram alert:', err);
    });
  };

  const unsubscribe = addIssueHook(hook);
  console.log(
    `[ErrorAlerter] enabled. threshold=${threshold} windowMs=${windowMs} cooldownMs=${cooldownMs}`
  );

  return {
    stop: unsubscribe
  };
}
