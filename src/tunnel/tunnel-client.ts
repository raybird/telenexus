import fs from 'node:fs';
import type { TunnelState } from './tunnel-manager.js';

/**
 * issue 0030：telenexus 呼叫 tunnel-manager 內部 API 的客戶端。
 * 金鑰每次呼叫時從共用 volume 讀（tunnel-manager 重啟會換新金鑰）。
 */

export type TunnelClientFailure =
  | 'unreachable'
  | 'unauthorized'
  | 'failed'
  | 'timeout'
  | 'bad-response';

export type TunnelClientResult =
  | { ok: true; state: TunnelState }
  | { ok: false; reason: TunnelClientFailure; message: string; state?: TunnelState };

export type TunnelClientOptions = {
  baseUrl: string;
  keyFile: string;
  /** 啟動要等 cloudflared 與外部健康檢查，比 tunnel-manager 的啟動逾時再寬一點。 */
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export class TunnelClient {
  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: TunnelClientOptions) {
    this.startTimeoutMs = options.startTimeoutMs ?? 90_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  start(): Promise<TunnelClientResult> {
    return this.call('POST', '/tunnel/start', this.startTimeoutMs);
  }

  status(): Promise<TunnelClientResult> {
    return this.call('GET', '/tunnel/status', this.requestTimeoutMs);
  }

  stop(): Promise<TunnelClientResult> {
    return this.call('POST', '/tunnel/stop', this.requestTimeoutMs);
  }

  private async call(
    method: string,
    pathname: string,
    timeoutMs: number
  ): Promise<TunnelClientResult> {
    let key: string;
    try {
      key = fs.readFileSync(this.options.keyFile, 'utf8').trim();
    } catch (error) {
      return {
        ok: false,
        reason: 'unauthorized',
        message: `讀不到 tunnel-manager 金鑰檔：${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (!key) return { ok: false, reason: 'unauthorized', message: 'tunnel-manager 金鑰檔是空的' };

    let res: Response;
    try {
      res = await fetch(new URL(pathname, this.options.baseUrl), {
        method,
        headers: { 'x-tunnel-key': key },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return {
          ok: false,
          reason: 'timeout',
          message: `tunnel-manager 在 ${timeoutMs}ms 內沒有回應`
        };
      }
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      return {
        ok: false,
        reason: 'unreachable',
        message:
          cause?.code || cause?.message || (error instanceof Error ? error.message : String(error))
      };
    }

    if (res.status === 401) {
      return { ok: false, reason: 'unauthorized', message: 'tunnel-manager 拒絕金鑰' };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: 'bad-response', message: `HTTP ${res.status}` };
    }
    if (!isTunnelState(body)) {
      return { ok: false, reason: 'bad-response', message: `HTTP ${res.status}` };
    }
    if (res.status === 502) {
      return { ok: false, reason: 'failed', message: body.error || 'Tunnel 啟動失敗', state: body };
    }
    if (!res.ok) return { ok: false, reason: 'bad-response', message: `HTTP ${res.status}` };
    return { ok: true, state: body };
  }
}

function isTunnelState(value: unknown): value is TunnelState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === 'string' && typeof v.generation === 'number';
}
