import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { verifyInitData, type PanelSessions } from './panel-auth.js';
import {
  applyModel,
  isModelId,
  listModels as defaultListModels,
  readModelState,
  resetModel,
  type ModelListResult
} from '../core/model-config.js';

/**
 * issue 0030：模型面板專用的 HTTP 伺服器（SCN-002）。
 *
 * Quick Tunnel 只接這個連接埠，所以這裡就是整個公開面：
 * - `POST /panel-api/login`：以 Telegram initData 換發憑證
 * - 其他 `/panel-api/*`：先驗 `Authorization: Bearer <憑證>`，未通過一律 401（不透露路徑是否存在）
 * - `GET /panel/health`：不需登入，只回服務名稱，供 tunnel-manager 確認連通
 * - `GET /panel/`、`/panel/<檔名>`：手機頁與同源資源（只服務 panel-public/ 內白名單格式的檔名）
 * - 模型 API：`GET state`、`GET models`、`POST apply`、`POST reset`（共用 core/model-config.ts，SCN-003／004）
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
  /** 寫入設定期間呼叫，回傳的函式在寫完時呼叫（寫入中不算閒置，SCN-005）。 */
  beginWrite?: () => () => void;
  /** 測試注入；預設執行 `opencode models`。 */
  listModels?: () => Promise<ModelListResult>;
  /** 預設為本模組旁的 panel-public/（dist 由 copy-web-assets 複製）。 */
  staticDir?: string;
};

export type PanelServerHandle = { port: number; close(): Promise<void> };

const API_PREFIX = '/panel-api/';
export const HEALTH_PATH = '/panel/health';
const MAX_BODY_BYTES = 16 * 1024;
const PANEL_PREFIX = '/panel/';
const STATIC_FILE = /^[a-z0-9-]+\.(html|js|css)$/;
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('./panel-public/', import.meta.url));
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8'
};
/** telegram-web-app.js 只能從 telegram.org 載入；API 一律同源；Telegram Web 以 iframe 開啟 Mini App。 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' https://telegram.org",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  'frame-ancestors https://*.telegram.org'
].join('; ');

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

  if (pathname.startsWith(PANEL_PREFIX) && req.method === 'GET') {
    req.resume();
    serveStatic(res, pathname.slice(PANEL_PREFIX.length) || 'index.html', options);
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

  const route = ROUTES.get(pathname.slice(API_PREFIX.length));
  if (!route) {
    req.resume();
    sendJson(res, 404, { ok: false, error: 'not-found' });
    return;
  }
  if (req.method !== route.method) {
    req.resume();
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }
  const { status, body } = await route.handle({ req, options, userId: session.userId });
  sendJson(res, status, body);
}

type RouteResult = { status: number; body: Record<string, unknown> };
type Route = {
  method: 'GET' | 'POST';
  handle(ctx: {
    req: http.IncomingMessage;
    options: PanelServerOptions;
    userId: string;
  }): Promise<RouteResult>;
};

// 用 Map 而非物件字面值：`constructor`、`__proto__` 等原型上的名稱不能被當成路由
const ROUTES = new Map<string, Route>(
  Object.entries({
    session: {
      method: 'GET',
      handle: async ({ req, userId }) => {
        req.resume();
        return { status: 200, body: { ok: true, userId } };
      }
    },
    state: {
      method: 'GET',
      handle: async ({ req }) => {
        req.resume();
        return { status: 200, body: { ok: true, model: readModelState() } };
      }
    },
    models: {
      method: 'GET',
      handle: async ({ req, options }) => {
        req.resume();
        const listed = await (options.listModels ?? defaultListModels)();
        if (!listed.ok) {
          return { status: 502, body: { ok: false, error: 'list-failed', message: listed.error } };
        }
        const providers = [...new Set(listed.models.map((m) => m.provider))];
        return { status: 200, body: { ok: true, models: listed.models, providers } };
      }
    },
    apply: {
      method: 'POST',
      handle: async ({ req, options }) => {
        const body = await readJson(req);
        const id = typeof body.model === 'string' ? body.model : '';
        if (!isModelId(id)) return { status: 400, body: { ok: false, error: 'invalid-model' } };
        // 只能套用目前清單裡的模型；清單取不到就不寫（SCN-004）
        const listed = await (options.listModels ?? defaultListModels)();
        if (!listed.ok) {
          return { status: 502, body: { ok: false, error: 'list-failed', message: listed.error } };
        }
        const release = options.beginWrite?.() ?? (() => {});
        try {
          const result = applyModel(id, { available: listed.models.map((m) => m.id) });
          if (!result.ok) {
            return result.error === 'write-failed'
              ? { status: 500, body: { ok: false, error: result.error, message: result.message } }
              : { status: 400, body: { ok: false, error: result.error } };
          }
          return {
            status: 200,
            body: {
              ok: true,
              ...(result.previous ? { previous: result.previous } : {}),
              model: readModelState()
            }
          };
        } finally {
          release();
        }
      }
    },
    reset: {
      method: 'POST',
      handle: async ({ req, options }) => {
        req.resume();
        const release = options.beginWrite?.() ?? (() => {});
        try {
          const result = resetModel();
          if (!result.ok) {
            return {
              status: 500,
              body: { ok: false, error: result.error, message: result.message }
            };
          }
          return {
            status: 200,
            body: {
              ok: true,
              changed: result.changed,
              ...(result.previous ? { previous: result.previous } : {}),
              model: readModelState()
            }
          };
        } finally {
          release();
        }
      }
    }
  } satisfies Record<string, Route>)
);

function serveStatic(res: http.ServerResponse, name: string, options: PanelServerOptions): void {
  // 檔名只允許白名單格式，不解碼、不含路徑分隔，所以讀不到 panel-public/ 以外的檔案
  const match = STATIC_FILE.exec(name);
  let content: Buffer | undefined;
  if (match) {
    try {
      content = fs.readFileSync(path.join(options.staticDir ?? DEFAULT_STATIC_DIR, name));
    } catch {
      // 不存在當 404
    }
  }
  if (!match || !content) {
    sendJson(res, 404, { ok: false, error: 'not-found' });
    return;
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[match[1]!]!,
    'content-security-policy': PAGE_CSP,
    'cache-control': 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  });
  res.end(content);
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
