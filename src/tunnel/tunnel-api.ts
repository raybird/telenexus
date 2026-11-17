import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { TunnelManager } from './tunnel-manager.js';

/**
 * issue 0030：tunnel-manager 給 telenexus 用的內部 API（只在 Docker 內網）。
 *
 * - `POST /tunnel/start`：就緒回 200，失敗回 502（附原因，不附網址）
 * - `GET /tunnel/status`、`POST /tunnel/stop`
 *
 * 每個請求都要帶 `x-tunnel-key`。金鑰由 tunnel-manager 每次啟動時重新產生，寫在只有它與
 * telenexus 掛載的 volume；不需要使用者設定，沒有或不符一律 401（不因內網而放行）。
 */

export function ensureTunnelKey(file: string): string {
  const key = randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return key;
}

export type TunnelApiOptions = {
  host: string;
  port: number;
  key: string;
  manager: TunnelManager;
};

export type TunnelApiHandle = { port: number; close(): Promise<void> };

export async function startTunnelApi(options: TunnelApiOptions): Promise<TunnelApiHandle> {
  const server = http.createServer((req, res) => {
    req.resume();
    void route(req, options).then(
      ({ status, body }) => send(res, status, body),
      (error: unknown) =>
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    );
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

async function route(
  req: http.IncomingMessage,
  options: TunnelApiOptions
): Promise<{ status: number; body: object }> {
  if (!hasKey(req, options.key)) return { status: 401, body: { error: 'unauthorized' } };
  const pathname = new URL(req.url || '/', 'http://tunnel.invalid').pathname;
  const { manager } = options;
  if (pathname === '/tunnel/status' && req.method === 'GET') {
    return { status: 200, body: manager.status() };
  }
  if (pathname === '/tunnel/start' && req.method === 'POST') {
    const state = await manager.start();
    return { status: state.status === 'ready' ? 200 : 502, body: state };
  }
  if (pathname === '/tunnel/stop' && req.method === 'POST') {
    return { status: 200, body: await manager.stop() };
  }
  return { status: 404, body: { error: 'not-found' } };
}

function hasKey(req: http.IncomingMessage, key: string): boolean {
  const provided = req.headers['x-tunnel-key'];
  if (typeof provided !== 'string' || !key) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
