import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyInitData, type PanelSessions } from './panel-auth.js';

/**
 * issue 0030：模型面板專用的 HTTP 伺服器（SCN-002）。
 *
 * Quick Tunnel 只接這個連接埠，所以這裡就是整個公開面：
 * - `POST /panel-api/login`：以 Telegram initData 換發憑證
 * - 其他 `/panel-api/*`：先驗 `Authorization: Bearer <憑證>`，未通過一律 401（不透露路徑是否存在）
 * - `GET /panel/health`：不需登入，只回服務名稱，供 tunnel-manager 確認連通
 * - 其餘路徑一律 404；既有 Web Console（3030）的頁面與 API 不在這裡
 *
 * 授權只看憑證，不看來源 IP、X-Forwarded-For、Host、WEB_AUTH_TOKEN 或 WEB_TRUST_PRIVATE_NETWORK；
 * 憑證只接受標頭，不接受網址參數（網址會留在 Tunnel 與瀏覽器紀錄裡）。
 */

export type PanelServerOptions = {
  host: string;
  port: number;
  botToken: string;
  allowedUserId: string;
  sessions: PanelSessions;
  now?: () => number;
  /** 每筆經過驗證的請求（登入成功、帶有效憑證）呼叫一次，供閒置計時（SCN-005）。 */
  onActivity?: () => void;
};

export type PanelServerHandle = { port: number; close(): Promise<void> };

const API_PREFIX = '/panel-api/';
export const HEALTH_PATH = '/panel/health';
const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

export async function startPanelServer(options: PanelServerOptions): Promise<PanelServerHandle> {
  const server = http.createServer((req, res) => {
    handle(req, res, options).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'internal-error';
      if (!res.headersSent) sendJson(res, status, { ok: false, error: code });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: PanelServerOptions
): Promise<void> {
  const pathname = new URL(req.url || '/', 'http://panel.invalid').pathname;

  // tunnel-manager 經公開網址打這裡確認 Tunnel 通了；不含任何狀態資訊。
  if (pathname === HEALTH_PATH && req.method === 'GET') {
    req.resume();
    sendJson(res, 200, { ok: true, service: 'telenexus-panel' });
    return;
  }

  if (!pathname.startsWith(API_PREFIX)) {
    req.resume();
    sendJson(res, 404, { ok: false, error: 'not-found' });
    return;
  }

  if (pathname === `${API_PREFIX}login`) {
    if (req.method !== 'POST') {
      req.resume();
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    const body = await readJson(req);
    const initData = typeof body.initData === 'string' ? body.initData : '';
    const result = verifyInitData(initData, {
      botToken: options.botToken,
      allowedUserId: options.allowedUserId,
      nowMs: (options.now ?? Date.now)()
    });
    if (!result.ok) {
      sendJson(res, 401, { ok: false, error: 'unauthorized', reason: result.reason });
      return;
    }
    options.onActivity?.();
    sendJson(res, 200, { ok: true, token: options.sessions.issue(result.userId) });
    return;
  }

  const session = options.sessions.verify(readBearer(req));
  if (!session) {
    req.resume();
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  options.onActivity?.();

  if (req.method === 'GET' && pathname === `${API_PREFIX}session`) {
    sendJson(res, 200, { ok: true, userId: session.userId });
    return;
  }

  req.resume();
  sendJson(res, 404, { ok: false, error: 'not-found' });
}

function readBearer(req: http.IncomingMessage): string {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body-too-large');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 落到下面的 400
  }
  throw new HttpError(400, 'invalid-json');
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: Record<string, unknown>
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}
